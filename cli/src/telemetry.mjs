// telemetry.mjs — the second half of being counted, folded into `tracker setup`.
//
// WHY THIS EXISTS. Being tracked takes two independent pieces: this CLI (git
// access) and the edge8-telemetry Claude Code plugin (session effort). They
// share one `e8k_` key but nothing else, and one working tells you nothing
// about the other — `tracker status` can be entirely green while not a single
// session is counted.
//
// Onboarding treated them as two separate jobs, and people stopped after the
// first: git worked, so it looked done. Every engineer who stopped there was
// invisible and had no way to know. Doing it here means the common path is one
// command, and the failure mode needs someone to actively opt out rather than
// merely not finish reading.
//
// NOT FATAL, EVER. Git wiring is this command's job; telemetry is a bonus on
// top. A machine with no Claude Code, no network, or a plugin install that
// fails must still end up with working git access. Everything here reports and
// returns — it never throws into setup().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const STATE_DIR = path.join(os.homedir(), ".claude", ".il-telemetry");
export const CONSENT_PATH = path.join(STATE_DIR, "consent");

const MARKETPLACE = "talentedgeai/edge8-telemetry";
const PLUGIN = "edge8-telemetry@edge8";

/** "granted" | "denied" | "unset" — mirrors il_telemetry/consent.py exactly. */
export function consentState(consentPath = CONSENT_PATH) {
  try {
    const v = fs.readFileSync(consentPath, "utf8").trim();
    return v === "granted" || v === "denied" ? v : "unset";
  } catch {
    return "unset";
  }
}

/** Record the answer. The plugin reads this file and nothing else. */
export function setConsent(granted, consentPath = CONSENT_PATH) {
  fs.mkdirSync(path.dirname(consentPath), { recursive: true });
  fs.writeFileSync(consentPath, granted ? "granted" : "denied");
}

/** Is the Claude Code CLI on PATH? Absent is a normal state, not an error. */
export function claudeAvailable(run = defaultRun) {
  try {
    run("claude", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const defaultRun = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Install (or update) the plugin. Returns {ok, detail}.
 *
 * `marketplace add` fails on a machine that already added it, which is a
 * success for our purposes — so its failure is tolerated and only the install
 * decides the outcome.
 */
export function installPlugin(run = defaultRun) {
  try {
    run("claude", ["plugin", "marketplace", "add", MARKETPLACE]);
  } catch {
    /* already added, or offline — install below is the real test */
  }
  try {
    run("claude", ["plugin", "install", PLUGIN]);
    return { ok: true, detail: "" };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).trim().split("\n")[0];
    return { ok: false, detail: msg.slice(0, 200) };
  }
}

/**
 * Decide consent without ever silently granting it.
 *
 * The plugin is opt-in by design, so `tracker setup` must not answer for the
 * engineer. `--telemetry` / `--no-telemetry` answer explicitly; an interactive
 * terminal is asked; a non-interactive one (CI, a provisioning script) is left
 * alone, because a machine that cannot be asked has not consented.
 */
export function decideConsent({ flagYes, flagNo, isTTY, ask, existing }) {
  if (flagNo) return { granted: false, source: "flag" };
  if (flagYes) return { granted: true, source: "flag" };
  if (existing === "granted") return { granted: true, source: "existing" };
  if (existing === "denied") return { granted: false, source: "existing" };
  if (!isTTY) return { granted: false, source: "non-interactive" };
  return { granted: ask(), source: "prompt" };
}

/** Blocking y/N read on a real terminal. Anything but y/yes is no. */
export function promptYesNo(question) {
  process.stdout.write(`${question} [y/N] `);
  const buf = Buffer.alloc(1024);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false; // stdin closed mid-prompt: treat as no answer, i.e. no
  }
  return /^y(es)?$/i.test(buf.subarray(0, n).toString("utf8").trim());
}

/**
 * The whole telemetry step. Prints its own progress; returns a summary for the
 * caller to print alongside the git result. Never throws.
 */
export function setUpTelemetry({
  flagYes = false,
  flagNo = false,
  isTTY = Boolean(process.stdin.isTTY),
  ask = () =>
    promptYesNo(
      "\nAlso report your Claude Code session effort to the tracker?\n" +
        "  (token totals and active minutes for registered work repos only —\n" +
        "   never file contents, never your personal repos)",
    ),
  run = defaultRun,
  consentPath = CONSENT_PATH,
} = {}) {
  const existing = consentState(consentPath);
  const { granted, source } = decideConsent({ flagYes, flagNo, isTTY, ask, existing });

  if (!granted) {
    try {
      if (source !== "non-interactive") setConsent(false, consentPath);
    } catch {
      /* recording a "no" is best effort; the absence of "granted" is the gate */
    }
    return {
      enabled: false,
      note:
        source === "non-interactive"
          ? "not asked (non-interactive) — run `tracker setup --telemetry` to enable"
          : "declined — run `tracker setup --telemetry` to change your mind",
    };
  }

  if (!claudeAvailable(run))
    return { enabled: false, note: "Claude Code not found on PATH — install it, then re-run `tracker setup`" };

  const res = installPlugin(run);
  if (!res.ok)
    return { enabled: false, note: `plugin install failed — ${res.detail || "unknown error"}` };

  try {
    setConsent(true, consentPath);
  } catch (e) {
    return { enabled: false, note: `could not write ${consentPath}: ${e?.message ?? e}` };
  }
  return { enabled: true, note: "" };
}
