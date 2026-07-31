// Sandboxed end-to-end tests: run the REAL CLI (bin/tracker.js) against a REAL
// git and a mock tracker server, with all writes redirected into a temp dir:
//   GIT_CONFIG_GLOBAL  -> sandbox gitconfig      (git >= 2.32)
//   HOME / USERPROFILE -> sandbox home            (os.homedir() honors these)
//   GIT_CONFIG_NOSYSTEM=1                         (deterministic across machines)
// Nothing here touches the developer's actual ~/.gitconfig or ~/.edge8.
//
// The mock server lives in THIS process, so every command that talks to it must
// be spawned ASYNC — a spawnSync would freeze the event loop and deadlock the
// child against a server that can no longer respond.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_HELPER_KEY, GITHUB_USEHTTPPATH_KEY, buildShim, isOurs, nulsOf } from "../src/wiring.mjs";

const TRACKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "tracker.js");
const KEY = "e8k_testid_testsecret0000000000";
// Shaped like gh's real entry but the binary does NOT exist: git silently skips
// a helper it cannot exec. NEVER seed the real `gh` (or `manager`) here — a
// silent shim would fall through to them and they answer with REAL credentials.
const GH = "!'e8-no-such-gh-binary' auth git-credential";
const FALLBACK = process.platform === "win32" ? "manager" : process.platform === "darwin" ? "osxkeychain" : "cache";

let sandbox, home, gitcfg, env, server, port;

// Async spawn helper (argv array, no shell) — keeps the event loop (and
// therefore the mock server) alive.
function spawnCapture(cmd, args, { input, extraEnv } = {}) {
  return new Promise((resolve) => {
    // cwd = sandbox home (guaranteed non-repo): repo-LOCAL git config cannot
    // be masked by env vars, and inheriting the real checkout's cwd would let
    // a local credential.helper join the chain and reach real stores.
    const p = spawn(cmd, args, { env: { ...env, ...extraEnv }, cwd: home });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
    const t = setTimeout(() => p.kill(), 30_000);
    p.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}
const run = (args, extraEnv) => spawnCapture(process.execPath, [TRACKER, ...args], { extraEnv });

// Sync git is fine for config reads/writes — they never touch the server.
const gitEnv = (...args) => execFileSync("git", args, { encoding: "utf8", env, cwd: home, timeout: 15_000 });
const helpers = () => {
  try {
    return nulsOf(gitEnv("config", "-z", "--global", "--get-all", GITHUB_HELPER_KEY));
  } catch {
    return null;
  }
};
const setHelpers = (list) => {
  try {
    gitEnv("config", "--global", "--unset-all", GITHUB_HELPER_KEY);
  } catch {
    /* key absent */
  }
  for (const v of list) gitEnv("config", "--global", "--add", GITHUB_HELPER_KEY, v);
};
const fwd = (p) => p.replace(/\\/g, "/");
const shimPath = () => path.join(home, ".edge8", "helper.sh");
const shimEntry = () => `!"${fwd(shimPath())}"`;

// The sh interpreter git uses for `!` helpers (same lookup as tracker status).
function findSh() {
  if (process.platform !== "win32") return "sh";
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const root = path.resolve(execPath, "..", "..", "..");
  for (const c of [path.join(root, "bin", "sh.exe"), path.join(root, "usr", "bin", "sh.exe")])
    if (fs.existsSync(c)) return c;
  throw new Error("git's sh.exe not found");
}

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "e8trk-it-"));
  home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true });
  gitcfg = path.join(sandbox, "gitconfig");
  // Strip every path to a REAL credential source. GIT_TERMINAL_PROMPT=0 does
  // NOT block askpass: VS Code's inherited GIT_ASKPASS answers github.com
  // prompts with the developer's live gho_ token (a real token leaked into
  // test output this way once). Empty GIT_ASKPASS/SSH_ASKPASS + no VSCODE_GIT_*
  // makes an exhausted helper chain fail fast instead.
  const {
    GIT_ASKPASS: _a,
    SSH_ASKPASS: _b,
    VSCODE_GIT_ASKPASS_NODE: _c,
    VSCODE_GIT_ASKPASS_MAIN: _d,
    VSCODE_GIT_ASKPASS_EXTRA_ARGS: _e,
    VSCODE_GIT_IPC_HANDLE: _f,
    GIT_DIR: _g,
    GIT_WORK_TREE: _h,
    ...baseEnv
  } = process.env;
  env = {
    ...baseEnv,
    GIT_CONFIG_GLOBAL: gitcfg,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    USERPROFILE: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_CEILING_DIRECTORIES: sandbox,
  };
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/health") return json(200, { ok: true, backend: "mock" });
      if (req.method === "POST" && req.url === "/app-token") {
        if (req.headers["x-edge8-key"] !== KEY) return json(401, { error: "bad key" });
        const p = JSON.parse(body || "{}").path;
        if (p === "team/repo.git")
          return json(200, {
            username: "x-access-token",
            token: "tok_TEST",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          });
        return json(404, { error: "no installation for repo" });
      }
      if (req.method === "POST" && req.url === "/beacon") {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope"); // e.g. the /api-prefix probe: non-JSON 404 like a bare host
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

after(() => {
  server?.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows: a detached beacon child may briefly hold a handle */
  }
});

const SERVER_URL = () => `http://127.0.0.1:${port}`;

test('fresh setup: wires ["", shim, fallback], writes all artifacts, exit 0', async () => {
  const r = await run(["setup", "--key", KEY, "--server", SERVER_URL()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /setup complete/);
  assert.match(r.stdout, /verified/);
  assert.deepEqual(helpers(), ["", shimEntry(), FALLBACK]);
  assert.equal(gitEnv("config", "--global", GITHUB_USEHTTPPATH_KEY).trim(), "true");
  for (const f of ["config.json", "helper.mjs", "helper.sh"])
    assert.ok(fs.existsSync(path.join(home, ".edge8", f)), `${f} missing`);
  assert.ok(!fs.readFileSync(shimPath(), "utf8").includes("\r"), "shim must be LF-only");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".edge8", "config.json"), "utf8"));
  assert.equal(cfg.key, KEY);
  assert.equal(cfg.apiPrefix, ""); // mock serves at root, not /api
});

test("re-run with NO flags: reuses stored key/server, idempotent list", async () => {
  const beforeList = helpers();
  const r = await run(["setup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(helpers(), beforeList);
});

test("setup preserves a pre-existing gh helper instead of clobbering it", async () => {
  setHelpers(["", GH]);
  const r = await run(["setup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(helpers(), ["", shimEntry(), GH, FALLBACK]);
});

test("setup with a wrong key fails 401 and touches nothing", async () => {
  const beforeList = helpers();
  const r = await run(["setup", "--key", "e8k_wrong_key0000", "--server", SERVER_URL()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /key rejected by the server \(401\)/);
  assert.deepEqual(helpers(), beforeList);
});

test("mid-rewrite failure (.gitconfig.lock held) rolls back, says so truthfully, exit 1", async () => {
  setHelpers(["", GH]);
  fs.writeFileSync(gitcfg + ".lock", ""); // what an IDE holding the lock looks like
  try {
    const r = await run(["setup"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not rewrite git config/);
    assert.match(r.stderr, /holds \.gitconfig\.lock|could not lock/i);
    assert.match(r.stderr, /helper list was restored/);
    assert.deepEqual(helpers(), ["", GH], "pre-state must survive untouched");
  } finally {
    fs.rmSync(gitcfg + ".lock", { force: true });
  }
  assert.equal((await run(["setup"])).status, 0, "machine recovers once the lock is gone");
});

test("status: healthy machine -> 4 lines, all green, exit 0", async () => {
  const r = await run(["status"]);
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /helper\s+✔ wired/);
  assert.match(r.stdout, /node\s+✔/);
  assert.match(r.stdout, /mint\s+– no token minted/); // informational, does not fail
  assert.match(r.stdout, /server\s+✔ reachable, key accepted/);
  assert.match(r.stdout, /all checks passed/);
});

test("status detects a gh clobber (the memo author's exact failure) -> exit 1", async () => {
  setHelpers(["", GH]);
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT wired/);
  assert.match(r.stdout, /NOT being counted/);
  // repair with no flags — exactly what the rollout message tells people to do
  assert.equal((await run(["setup"])).status, 0);
  assert.equal((await run(["status"])).status, 0);
});

test("status detects a shadowing helper placed before ours -> exit 1", async () => {
  setHelpers(["", GH, shimEntry()]); // guard present, but gh answers first
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /SHADOWED/);
  assert.equal((await run(["setup"])).status, 0); // repair
});

test("status detects missing useHttpPath (helper mute for every repo) -> exit 1", async () => {
  gitEnv("config", "--global", "--unset", GITHUB_USEHTTPPATH_KEY);
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /useHttpPath is OFF/);
  assert.equal((await run(["setup"])).status, 0); // repair
});

test("status reports a revoked/bad key distinctly -> exit 1", async () => {
  const cfgPath = path.join(home, ".edge8", "config.json");
  const good = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(good);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, key: "e8k_bad_key000" }));
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REJECTED/);
  fs.writeFileSync(cfgPath, good);
});

test("status recognizes legacy v0.2.x wiring as counted, with upgrade advice", async () => {
  const legacyEntry = `!"${fwd(process.execPath)}" "${fwd(path.join(home, ".edge8", "helper.mjs"))}"`;
  setHelpers(["", legacyEntry, FALLBACK]);
  const r = await run(["status"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /legacy node-pinned wiring/);
  assert.match(r.stdout, /node\s+✔ pinned node exists/);
});

test("status flags a dead pinned node on legacy wiring -> exit 1", async () => {
  const legacyEntry = `!"${fwd(path.join(home, "no-such-node.exe"))}" "${fwd(path.join(home, ".edge8", "helper.mjs"))}"`;
  setHelpers(["", legacyEntry, FALLBACK]);
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /pinned node path is GONE/);
});

test("status flags wiring that points at a foreign/stale shim path -> exit 1", async () => {
  // ~/.edge8/helper.sh EXISTS locally, but the wired entry points elsewhere —
  // status must judge the path git will exec, not this machine's files.
  setHelpers(["", '!"C:/Users/someone-else/.edge8/helper.sh"', FALLBACK]);
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STALE shim path/);
  assert.equal((await run(["setup"])).status, 0); // repair
});

test("status with corrupt config.json degrades gracefully -> exit 1", async () => {
  const cfgPath = path.join(home, ".edge8", "config.json");
  const good = fs.readFileSync(cfgPath, "utf8");
  fs.writeFileSync(cfgPath, "{not json");
  const r = await run(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unreadable\/incomplete/);
  fs.writeFileSync(cfgPath, good);
});

test("end-to-end: git credential fill -> shim -> helper -> mock server mints", async () => {
  assert.equal((await run(["setup"])).status, 0); // known-good wiring regardless of prior tests
  // Drop the platform fallback for this call: if the shim ever goes silent
  // here, the fill must fail fast — not reach the REAL credential manager.
  setHelpers(["", shimEntry()]);
  const r = await spawnCapture("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\npath=team/repo.git\n\n",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /username=x-access-token/);
  assert.match(r.stdout, /password=tok_TEST/);
  const cache = JSON.parse(fs.readFileSync(path.join(home, ".edge8", "cache.json"), "utf8"));
  assert.ok(cache["team/repo.git"]?.token === "tok_TEST");
  // restore full wiring, and status now shows the mint
  assert.equal((await run(["setup"])).status, 0);
  const s = await run(["status"]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /mint\s+✔ last token/);
});

test("untracked repo: the shim/helper stay silent (git would fall through)", async () => {
  // Call the shim exactly the way git does (through sh, "get" on argv, request
  // on stdin). Server answers 404 {error} -> helper must print NOTHING and
  // exit 0 — that silence is what lets git move on to the next helper.
  const r = await spawnCapture(findSh(), [shimPath(), "get"], {
    input: "protocol=https\nhost=github.com\npath=someone/private-thing.git\n\n",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("server down: no-flag re-setup still repairs wiring (with a loud warning)", async () => {
  await new Promise((r) => server.close(r));
  const r = await run(["setup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /unreachable; rewiring git anyway/);
  // ...but a FRESH machine cannot validate anything and must fail hard
  const home2 = path.join(sandbox, "home2");
  fs.mkdirSync(home2, { recursive: true });
  const r2 = await run(["setup", "--key", KEY, "--server", SERVER_URL()], {
    HOME: home2,
    USERPROFILE: home2,
    GIT_CONFIG_GLOBAL: path.join(sandbox, "gitconfig2"),
  });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /could not reach/);
  // ...and repair mode must NOT kick in for a DIFFERENT unreachable server —
  // stored apiPrefix belongs to the stored URL, never to a new one.
  const r3 = await run(["setup", "--server", "http://127.0.0.1:9"]);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /could not reach/);
});

test('uninstall: removes only our entries, keeps gh, never strands a bare ""', async () => {
  setHelpers(["", shimEntry(), GH, FALLBACK]);
  const r = await run(["uninstall"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(helpers(), ["", GH, FALLBACK]);
  assert.ok(!helpers().some((v) => isOurs(v)));
  for (const f of ["helper.sh", "helper.mjs", "cache.json"])
    assert.ok(!fs.existsSync(path.join(home, ".edge8", f)), `${f} should be gone`);
  assert.ok(fs.existsSync(path.join(home, ".edge8", "config.json")), "config.json is kept");
});

test("uninstall on a never-installed machine leaves the bare platform fallback", async () => {
  const home3 = path.join(sandbox, "home3");
  fs.mkdirSync(home3, { recursive: true });
  const cfg3 = path.join(sandbox, "gitconfig3");
  const r = await run(["uninstall"], { HOME: home3, USERPROFILE: home3, GIT_CONFIG_GLOBAL: cfg3 });
  assert.equal(r.status, 0, r.stderr);
  const raw = execFileSync("git", ["config", "-z", "--global", "--get-all", GITHUB_HELPER_KEY], {
    encoding: "utf8",
    env: { ...env, GIT_CONFIG_GLOBAL: cfg3 },
    cwd: home,
  });
  assert.deepEqual(nulsOf(raw), [FALLBACK]);
});

test("shim nvm pick uses numeric version sort (v9 < v10 < v22)", async () => {
  // The exact pipeline embedded in the shim template, executed by git's own sh.
  const r = await spawnCapture(findSh(), [
    "-c",
    'printf "v9.9.9\\nv22.1.0\\nv10.0.1\\n" | sed s/^v// | sort -t. -k1,1n -k2,2n -k3,3n | tail -1',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "22.1.0");
});

test("shim with no resolvable node stays SILENT and exits 0 (never breaks git)", async (t) => {
  if (process.platform !== "win32") {
    t.skip("well-known POSIX paths (/usr/bin/node) may exist — deterministic only on Windows");
    return;
  }
  const scratch = path.join(sandbox, "no-node-shim.sh");
  fs.writeFileSync(scratch, buildShim(path.join(sandbox, "no-node.exe"), path.join(home, ".edge8", "helper.mjs")));
  const r = await spawnCapture(findSh(), [scratch, "get"], {
    input: "protocol=https\nhost=github.com\npath=x/y.git\n\n",
    extraEnv: { PATH: "" }, // no node on PATH, RECORDED dead, no nvm/volta in sandbox HOME
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
