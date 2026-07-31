#!/usr/bin/env node
// edge8-tracker CLI. Three commands:
//   tracker setup [--key <e8k_...>] [--server <url>]   one-time per machine (re-run any time:
//                                                      idempotent; no flags needed once configured)
//   tracker status                                     is this machine being counted? (exit 0 = yes)
//   tracker uninstall                                  remove the git wiring, keep the config
//
// setup wires a git credential helper for github.com so every pull/push on a
// tracked repo authenticates through the tracker (fresh 60-min tokens, auto-
// refreshed) and untracked/personal repos fall through untouched. Unlike
// v0.2.x it RECONCILES the helper chain (other helpers — gh, managers — are
// preserved, not clobbered) and verifies the wiring took by reading BOTH the
// written file and the EFFECTIVE config back, failing loudly instead of
// printing a false "complete".
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_HELPER_KEY,
  GITHUB_USEHTTPPATH_KEY,
  analyzeChain,
  buildShim,
  buildTarget,
  buildUninstallTarget,
  computeEffective,
  isLegacy,
  isOurs,
  nulsOf,
  parseZRecords,
} from "../src/wiring.mjs";

const DIR = path.join(os.homedir(), ".edge8");
const CONFIG = path.join(DIR, "config.json");
const CACHE = path.join(DIR, "cache.json");
const HELPER_DEST = path.join(DIR, "helper.mjs");
const SHIM_DEST = path.join(DIR, "helper.sh");
const HELPER_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "helper.mjs",
);
// What we write into gitconfig: `!` = run through git's shell (git's own sh.exe
// on Windows — same mechanism gh uses), quoted absolute shim path.
const SHIM_ENTRY = `!"${SHIM_DEST.replace(/\\/g, "/")}"`;

// git config values must never pass through a shell — always execFileSync + array.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitRaw = (...args) => execFileSync("git", args, { encoding: "utf8" }); // no trim: "" entries matter
const gitTry = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Exit discipline: NEVER process.exit() after a fetch — on Windows, tearing
// the loop down while undici still holds keep-alive handles trips a libuv
// assertion (src/win/async.c) and the process dies 0xC0000409 instead of
// exiting cleanly. Set exitCode and unwind instead; node exits naturally.
class ExitError extends Error {}
function fail(msg) {
  console.error(`tracker: ${msg}`);
  process.exitCode = 1;
  throw new ExitError(msg);
}

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

function platformFallbackHelper() {
  if (process.platform === "win32") return "manager";
  if (process.platform === "darwin") return "osxkeychain";
  return "cache";
}

// ---------- config reads ----------

// Global helper list for github.com. null = key absent (git exits 1).
// -z framing: helper values may legally contain newlines (inline shell
// helpers) — a line-based read would fragment them and setup would then
// silently corrupt the user's own helper on rewrite.
function readGlobalHelpers() {
  try {
    return nulsOf(gitRaw("config", "-z", "--global", "--get-all", GITHUB_HELPER_KEY));
  } catch {
    return null;
  }
}

// EVERY credential.* record git will read, in read order, with scope+origin.
// Run from a guaranteed non-repo cwd so no repo-local config leaks in — this is
// the chain git actually walks (includes/includeIf resolved, system scope seen),
// which `--global` reads cannot show.
function readEffectiveRecords() {
  try {
    // GIT_DIR/GIT_WORK_TREE would pin git to some repo regardless of cwd, and
    // local/worktree-scope records describe ONE repo, not this machine — both
    // would distort the machine-wide chain we are judging.
    const { GIT_DIR, GIT_WORK_TREE, ...cleanEnv } = process.env;
    return parseZRecords(
      execFileSync(
        "git",
        ["config", "-z", "--show-scope", "--show-origin", "--get-regexp", "^credential\\."],
        { encoding: "utf8", cwd: os.tmpdir(), env: cleanEnv },
      ),
    ).filter((r) => r.scope !== "local" && r.scope !== "worktree");
  } catch {
    return []; // no credential config at all
  }
}

// Anything we echo from gitconfig may contain someone's inline-PAT helper, and
// status output is exactly what people paste into support channels — mask
// token-shaped substrings, keep the command shape.
const redact = (s) =>
  String(s)
    .replace(/\b(ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|e8k_)[A-Za-z0-9_-]{4,}/g, "$1…")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{4,}/g, "xox…");
const describe = (e) => `${JSON.stringify(redact(e.value))}  [${e.scope} ${e.origin}]`;

// ---------- server probe ----------

// Find where the API lives ("/api" on Vercel, "" on the local dev server) and
// validate the key: /app-token answers our 404 {error:"no installation..."} for
// an unknown-but-authenticated path, 401 for a bad key. Returns state instead of
// exiting so both setup and status can reuse it.
// NOTE: a valid-key probe logs one access event server-side under the reserved
// path _setup/_probe.git — activity analytics must exclude that path.
const PROBE_PATH = "_setup/_probe.git";
async function probeServer(server, key) {
  for (const prefix of ["/api", ""]) {
    try {
      const res = await fetch(`${server}${prefix}/app-token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-edge8-key": key },
        body: JSON.stringify({ host: "github.com", path: PROBE_PATH, verb: "unknown" }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 401) return { state: "rejected" };
      if (res.status === 404 || res.status === 200) {
        // make sure the 404 is OURS, not the platform's "no such route"
        const body = await res.json().catch(() => null);
        if (body && (body.error || body.token)) return { state: "ok", apiPrefix: prefix };
      }
      if (res.status === 503) return { state: "ok", apiPrefix: prefix }; // ours: app not configured yet
    } catch {
      /* try the next prefix */
    }
  }
  return { state: "unreachable" };
}

// ---------- setup ----------

async function setup() {
  // Flags override; stored config fills the gaps so `tracker setup` alone
  // repairs a machine without anyone digging up their key again.
  const stored = fs.existsSync(CONFIG) ? readJson(CONFIG) : undefined;
  if (fs.existsSync(CONFIG) && stored === null)
    console.error(`tracker: warning — ${CONFIG} is unreadable; pass --key/--server to rewrite it`);
  const key = arg("--key") ?? stored?.key;
  const server = (arg("--server") ?? stored?.server ?? "").replace(/\/+$/, "");
  if (!key || !/^e8k_[A-Za-z0-9]+_.+/.test(key))
    fail(
      stored === undefined
        ? "missing/invalid --key (expected e8k_<id>_<secret>)"
        : "no usable key found — re-run with --key <e8k_...> --server <url>",
    );
  if (!/^https?:\/\//.test(server)) fail("missing/invalid --server (http(s) URL)");

  const probe = await probeServer(server, key);
  if (probe.state === "rejected") fail("key rejected by the server (401) — check the key");
  let apiPrefix = probe.apiPrefix;
  if (probe.state === "unreachable") {
    // Repair mode: if this machine was already configured for this server, fix
    // the local wiring now and let the helper start working when the server is
    // back. A FRESH setup can't validate anything, so it still fails hard.
    if (stored && stored.server === server && stored.apiPrefix !== undefined) {
      apiPrefix = stored.apiPrefix;
      console.error(`tracker: warning — ${server} unreachable; rewiring git anyway (stored API prefix "${apiPrefix}")`);
    } else {
      fail(`could not reach a tracker API at ${server} — check the URL`);
    }
  }

  // The shim path lands inside sh double quotes in gitconfig — a home path
  // carrying live sh metacharacters cannot be wired safely across git's
  // quoting layers, so refuse loudly instead of writing a broken entry.
  if (/["$`]/.test(SHIM_DEST))
    fail(`home path contains sh metacharacters (\" $ \`) — cannot wire git safely: ${SHIM_DEST}`);

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ server, apiPrefix, key }, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG, 0o600); // writeFileSync mode applies only at CREATION — enforce on rewrite too
  } catch {
    /* Windows: no-op */
  }
  fs.copyFileSync(HELPER_SRC, HELPER_DEST);
  // The shim resolves node at RUN time (recorded path -> PATH -> well-known
  // locations) so `brew upgrade node` can't silently kill tracking the way a
  // pinned Cellar path could. LF + exec bit: git runs it through POSIX sh.
  fs.writeFileSync(SHIM_DEST, buildShim(process.execPath, HELPER_DEST), { mode: 0o755 });
  try {
    fs.chmodSync(SHIM_DEST, 0o755);
  } catch {
    /* Windows: no-op */
  }

  // --- reconcile the helper chain (NOT clobber-and-rebuild) ---
  // Target: "" reset guard -> our shim -> every other existing helper in
  // original order -> platform fallback. The "" guard stops a system-scope
  // credential manager answering tracked repos with a stored PAT before us;
  // preserving the others means running setup after `gh auth setup-git` demotes
  // gh to a fallback instead of deleting it (gh deletes US when run second —
  // that case is detectable only, via `tracker status`).
  const snapshot = readGlobalHelpers();
  const target = buildTarget(snapshot ?? [], SHIM_ENTRY, platformFallbackHelper());
  try {
    if (snapshot !== null) gitTry("config", "--global", "--unset-all", GITHUB_HELPER_KEY);
    for (const v of target) git("config", "--global", "--add", GITHUB_HELPER_KEY, v);
    git("config", "--global", GITHUB_USEHTTPPATH_KEY, "true");
  } catch (e) {
    // Mid-rewrite failure (e.g. .gitconfig.lock held by an IDE) must never
    // leave the chain worse than we found it: restore the snapshot — and then
    // VERIFY the restore before claiming it, because whatever broke the
    // rewrite may still be breaking the rollback.
    gitTry("config", "--global", "--unset-all", GITHUB_HELPER_KEY);
    for (const v of snapshot ?? []) gitTry("config", "--global", "--add", GITHUB_HELPER_KEY, v);
    const now = readGlobalHelpers();
    const restored = JSON.stringify(now) === JSON.stringify(snapshot);
    const show = (list, empty) => (list ?? [empty]).map((v) => `  ${JSON.stringify(redact(v))}`).join("\n");
    const hint = /lock/i.test(String(e?.message)) ? " (another program holds .gitconfig.lock — close IDEs/git GUIs and retry)" : "";
    fail(
      `could not rewrite git config${hint}: ${e?.message ?? e}\n` +
        (restored
          ? `  original helper list was restored:\n${show(snapshot, "<none>")}`
          : `  ROLLBACK ALSO FAILED — restore ${GITHUB_HELPER_KEY} by hand.\n  current list:\n${show(now, "<none>")}\n  original list was:\n${show(snapshot, "<none>")}`),
    );
  }

  // --- verification layer 1: did the WRITE take? (global scope) ---
  // Global reads merge ~/.gitconfig AND the XDG config file, and unset-all only
  // touches one of them — so assert on the segment after the LAST "" reset
  // (anything before it is inert by gitcredentials reset semantics) instead of
  // demanding the whole merged list match.
  const written = readGlobalHelpers() ?? [];
  const lastReset = written.lastIndexOf("");
  const active = written.slice(lastReset + 1);
  const expected = target.slice(1); // target minus the leading ""
  // PREFIX match, not equality: an [include] placed after the [credential]
  // section can append entries we cannot remove — they are harmless later
  // fallbacks (layer 2 owns ordering judgments), so note them, don't fail.
  if (lastReset === -1 || JSON.stringify(active.slice(0, expected.length)) !== JSON.stringify(expected)) {
    fail(
      `setup verification FAILED — the write did not take. Global ${GITHUB_HELPER_KEY} is now:\n` +
        written.map((v) => `  ${JSON.stringify(redact(v))}`).join("\n") +
        `\nexpected (after a "" reset):\n` +
        expected.map((v) => `  ${JSON.stringify(redact(v))}`).join("\n"),
    );
  }
  if (active.length > expected.length)
    console.error(
      `tracker: note — ${active.length - expected.length} extra helper entr${active.length - expected.length === 1 ? "y" : "ies"} follow ours (likely a config include); they act as additional fallbacks`,
    );
  if (lastReset > 0)
    console.error(
      `tracker: note — ${lastReset} pre-existing entr${lastReset === 1 ? "y" : "ies"} sit before the reset guard (likely the XDG config file); they are inert for github.com`,
    );

  // --- verification layer 2: is the EFFECTIVE chain right? ---
  // This is what git actually walks (system scope, includes, both global files).
  // A dotfiles include or system entry that outranks us would print "complete"
  // under a global-only check while the machine goes uncounted — the exact
  // silent failure this tool exists to kill.
  const eff = computeEffective(readEffectiveRecords());
  const { oursIdx, blockers } = analyzeChain(eff.chain);
  if (oursIdx === -1)
    fail(
      "setup verification FAILED — our helper is not in the effective chain git uses.\n" +
        "effective chain:\n" +
        (eff.chain.length ? eff.chain.map((e) => `  ${describe(e)}`).join("\n") : "  <empty>"),
    );
  if (oursIdx > 0)
    fail(
      "setup verification FAILED — another helper answers BEFORE the tracker; tracked repos would not be counted:\n" +
        blockers.map((e) => `  ${describe(e)}`).join("\n"),
    );
  if (!eff.useHttpPath)
    fail(`setup verification FAILED — ${GITHUB_USEHTTPPATH_KEY} is not effective (the helper would see no repo path and stay mute)`);

  console.log("tracker: setup complete ✔ (verified: write took + effective chain is correct)");
  console.log(`  server : ${server}${apiPrefix}`);
  console.log(`  config : ${CONFIG}`);
  console.log(`  helper : ${SHIM_DEST} -> ${HELPER_DEST}`);
  console.log("\nEvery git pull/push on tracked github.com repos now authenticates");
  console.log("through the tracker (60-min tokens, auto-refreshed). Personal repos");
  console.log("fall through to your existing credential manager.");
  console.log("\nCheck any time with: tracker status");
  console.log("If you ever run `gh auth login` / `gh auth setup-git`, re-run `tracker setup` after it.");
}

// ---------- status ----------

// Locate the sh interpreter git itself uses for `!` helpers, so the shim
// selftest answers for the environment that matters (NOT this process's PATH).
function findGitSh() {
  if (process.platform !== "win32") return "sh";
  try {
    const execPath = git("--exec-path"); // .../mingw64/libexec/git-core
    const root = path.resolve(execPath, "..", "..", "..");
    for (const c of [path.join(root, "bin", "sh.exe"), path.join(root, "usr", "bin", "sh.exe")])
      if (fs.existsSync(c)) return c;
  } catch {
    /* fall through */
  }
  return null;
}

const ago = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
};
const stamp = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

async function status() {
  try {
    git("--version");
  } catch {
    fail("git not found on PATH — install git first");
  }

  const out = [];
  const line = (label, mark, text, detail) => {
    out.push(`${label.padEnd(7)}${mark} ${text}`);
    if (detail) for (const d of [].concat(detail)) out.push(`       ${d}`);
  };
  let ok = { wired: false, node: false, server: false, key: false };

  // -- helper: is the tracker the FIRST answerer in the chain git actually walks? --
  const eff = computeEffective(readEffectiveRecords());
  const { oursIdx, ours, blockers } = analyzeChain(eff.chain);
  const legacy = ours ? isLegacy(ours.value) && !/helper\.sh/.test(ours.value) : false;
  // Judge the paths git will ACTUALLY exec (from the wired entry), not this
  // user's local files — a stale/foreign entry (dotfiles sync, copied
  // .gitconfig) must not pass just because ~/.edge8 happens to be populated.
  const m = ours ? /^!"([^"]+)"(?: "([^"]+)")?/.exec(ours.value) : null;
  const wiredPath = m?.[1]; // shim path (new wiring) or node path (legacy)
  const wiredHelper = legacy ? m?.[2] : wiredPath; // the file git hands to sh
  const norm = (p) => {
    const f = String(p ?? "").replace(/\\/g, "/");
    return process.platform === "win32" ? f.toLowerCase() : f;
  };
  if (oursIdx === -1) {
    line("helper", "✘", "NOT wired — this machine is NOT being counted", [
      ...(eff.chain.length
        ? ["effective chain:", ...eff.chain.map((e) => `  ${describe(e)}`)]
        : ["effective chain is empty"]),
      "fix: tracker setup   (no flags needed if this machine was set up before)",
    ]);
  } else if (oursIdx > 0) {
    line("helper", "✘", "wired but SHADOWED — another helper answers first, tracked repos are NOT counted", [
      "answering before the tracker:",
      ...blockers.map((e) => `  ${describe(e)}`),
      "fix: tracker setup",
    ]);
  } else if (!legacy && norm(wiredPath) !== norm(SHIM_DEST)) {
    line("helper", "✘", "wired to a STALE shim path — git will exec a file that is not this machine's shim", [
      redact(ours.value),
      `this machine's shim: ${SHIM_DEST}`,
      "fix: tracker setup",
    ]);
  } else if (!wiredHelper || !fs.existsSync(wiredHelper)) {
    line("helper", "✘", `wired in git config but ${wiredHelper ?? "the helper script"} is missing`, ["fix: tracker setup"]);
  } else if (!eff.useHttpPath) {
    line("helper", "✘", "wired but useHttpPath is OFF — the helper sees no repo path and mutes itself for EVERY repo", [
      "fix: tracker setup",
    ]);
  } else {
    ok.wired = true;
    line(
      "helper",
      "✔",
      legacy
        ? "wired (legacy node-pinned wiring — re-run `tracker setup` to upgrade to the node-upgrade-proof shim)"
        : `wired (first of ${eff.chain.length} helper${eff.chain.length === 1 ? "" : "s"} in the effective chain)`,
      ours ? [ours.value] : undefined,
    );
  }
  for (const s of eff.skipped) out.push(`       note: unrecognized helper form ignored: ${describe(s)}`);

  // -- node: what will actually execute when git calls the helper? --
  if (!ok.wired) {
    line("node", "–", "skipped (helper not wired)");
  } else if (legacy) {
    if (wiredPath && fs.existsSync(wiredPath)) {
      ok.node = true;
      line("node", "✔", `pinned node exists — ${wiredPath}`);
    } else {
      line("node", "✘", `pinned node path is GONE (${wiredPath ?? "?"}) — helper silently dead on every git op`, [
        "fix: tracker setup   (installs the run-time-resolving shim)",
      ]);
    }
  } else {
    const sh = findGitSh();
    if (sh) {
      try {
        const res = execFileSync(sh, [SHIM_DEST, "--selftest"], { encoding: "utf8" }).trim();
        ok.node = true;
        line("node", "✔", res.replace(/\n/g, " "));
      } catch (e) {
        line("node", "✘", "shim cannot resolve any node — helper silently dead on every git op", [
          String(e?.stdout ?? "").trim() || "install node (>=18) or re-run tracker setup",
        ]);
      }
    } else {
      // No sh found (unusual): approximate with the recorded path from the shim.
      const rec = /RECORDED="([^"]*)"/.exec(fs.readFileSync(SHIM_DEST, "utf8"))?.[1];
      ok.node = rec ? fs.existsSync(rec) : false;
      line("node", ok.node ? "✔" : "✘", `${ok.node ? "recorded node exists" : "recorded node missing"} — ${rec} (approximate: git's sh not found)`);
    }
  }

  // -- mint: informational ONLY (a vacation is not a broken machine) --
  const st = fs.existsSync(CACHE) ? fs.statSync(CACHE) : null;
  if (!st) {
    line("mint", "–", "no token minted on this machine yet (cache.json absent — normal right after setup)");
  } else {
    const cache = readJson(CACHE);
    const newest = cache
      ? Object.values(cache)
          .map((e) => Date.parse(e?.expires_at))
          .filter(Number.isFinite)
          .sort((a, b) => b - a)[0]
      : undefined;
    line(
      "mint",
      "✔",
      `last token ${ago(Date.now() - st.mtimeMs)} ago (${stamp(new Date(st.mtimeMs))})` +
        (newest ? `, expire${newest > Date.now() ? "s" : "d"} ${stamp(new Date(newest))}` : cache ? "" : " — cache.json unreadable"),
    );
  }

  // -- server + key --
  const cfg = readJson(CONFIG);
  if (!fs.existsSync(CONFIG)) {
    line("server", "–", "skipped — no config (this machine was never set up: run tracker setup --key ... --server ...)");
  } else if (!cfg?.server || !cfg?.key) {
    line("server", "✘", `${CONFIG} is unreadable/incomplete — re-run tracker setup --key ... --server ...`);
  } else {
    const server = cfg.server.replace(/\/+$/, "");
    let health;
    try {
      health = await fetch(`${server}${cfg.apiPrefix ?? ""}/health`, { signal: AbortSignal.timeout(6000) });
    } catch {
      health = null;
    }
    if (!health) {
      line("server", "✘", `unreachable — ${server}`, [
        "check your network, retry in a minute (serverless cold start), then re-run tracker status",
      ]);
    } else if (!health.ok) {
      line("server", "✘", `reachable but unhealthy (HTTP ${health.status}) — ${server}`, [
        "deployment or database problem on the server side — tell your admin",
      ]);
    } else {
      const probe = await probeServer(server, cfg.key);
      if (probe.state === "rejected") {
        ok.server = true;
        line("server", "✘", `reachable, but the key was REJECTED (revoked?) — ask an admin for a new key`, [server + (cfg.apiPrefix ?? "")]);
      } else if (probe.state === "ok") {
        ok.server = ok.key = true;
        line("server", "✔", `reachable, key accepted (${server}${probe.apiPrefix})`);
      } else {
        line("server", "✘", `health endpoint up but the token API did not answer — ${server}`, [
          "retry once; if it persists tell your admin",
        ]);
      }
    }
  }

  console.log(out.join("\n"));
  const pass = ok.wired && ok.node && ok.server && ok.key;
  console.log(pass ? "\ntracker: all checks passed — this machine is being counted ✔" : "\ntracker: NOT healthy — see ✘ above");
  process.exitCode = pass ? 0 : 1; // no process.exit() after fetch — see ExitError note
}

// ---------- uninstall ----------

function uninstall() {
  const snapshot = readGlobalHelpers();
  // Symmetric reconcile: drop only OUR entries; other helpers (gh, managers)
  // keep their order — with a "" guard retained ahead of them (both gh and we
  // install one; dropping it would let a system-scope manager jump the queue).
  // Nothing left -> restore the bare platform fallback.
  const target = buildUninstallTarget(snapshot ?? [], platformFallbackHelper());
  try {
    if (snapshot !== null) gitTry("config", "--global", "--unset-all", GITHUB_HELPER_KEY);
    for (const v of target) git("config", "--global", "--add", GITHUB_HELPER_KEY, v);
    gitTry("config", "--global", "--unset", GITHUB_USEHTTPPATH_KEY);
  } catch (e) {
    gitTry("config", "--global", "--unset-all", GITHUB_HELPER_KEY);
    for (const v of snapshot ?? []) gitTry("config", "--global", "--add", GITHUB_HELPER_KEY, v);
    const now = readGlobalHelpers();
    const restored = JSON.stringify(now) === JSON.stringify(snapshot);
    fail(
      `could not rewrite git config: ${e?.message ?? e}` +
        (restored
          ? " — original helper list restored"
          : `\n  ROLLBACK ALSO FAILED — restore ${GITHUB_HELPER_KEY} by hand; current list:\n  ${(now ?? ["<none>"]).map((v) => JSON.stringify(redact(v))).join("\n  ")}`),
    );
  }
  const written = readGlobalHelpers() ?? [];
  if (written.some((v) => isOurs(v)))
    fail(`uninstall verification FAILED — a tracker entry survived:\n${written.map((v) => `  ${JSON.stringify(v)}`).join("\n")}`);
  fs.rmSync(CACHE, { force: true });
  fs.rmSync(SHIM_DEST, { force: true });
  fs.rmSync(HELPER_DEST, { force: true });
  console.log("tracker: git wiring removed ✔ (other credential helpers preserved)");
  console.log(`  kept   : ${CONFIG} (your key — delete manually if leaving the team)`);
  console.log(`  removed: helper.sh, helper.mjs, cache.json`);
}

// ---------- dispatch ----------

const cmd = process.argv[2];
try {
  if (cmd === "setup") await setup();
  else if (cmd === "status") await status();
  else if (cmd === "uninstall") uninstall();
  else usage();
} catch (e) {
  if (!(e instanceof ExitError)) throw e; // fail() already printed + set exitCode
}

function usage() {
  console.log(`edge8-tracker CLI

usage:
  tracker setup [--key <e8k_...>] [--server <https://your-app.vercel.app>]
  tracker status
  tracker uninstall

setup is one-time per machine: it stores your key at ~/.edge8/config.json,
installs the git credential helper (node-resolving shim), and wires git for
github.com — preserving any other credential helpers you already use.
Re-running setup is safe and needs no flags once configured.

status answers, in four lines: is the helper wired (in the chain git actually
walks), which node will run it, when a token was last minted, and whether the
server is reachable and your key accepted. Exit 0 = this machine is counted.
Run it after \`gh auth login\`/\`gh auth setup-git\` — those rewrite git's
credential config and silently remove the tracker (fix: re-run tracker setup).`);
  process.exitCode = cmd ? 1 : 0;
}
