// Unit tests for the telemetry step folded into `tracker setup`
// (cli/src/telemetry.mjs).
//
// Two properties matter more than the happy path:
//   1. consent is never granted on the engineer's behalf, and
//   2. nothing here can break the git setup it runs after.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consentState,
  decideConsent,
  installPlugin,
  setConsent,
  setUpTelemetry,
} from "../src/telemetry.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tel-"));
const consentIn = (dir) => path.join(dir, "consent");

// A run() double: records calls, throws for any command in `failing`.
function fakeRun(failing = []) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    for (const f of failing) {
      if ([cmd, ...args].join(" ").includes(f)) {
        const e = new Error(`fake failure: ${f}`);
        e.stderr = `boom: ${f}\nsecond line`;
        throw e;
      }
    }
    return "";
  };
  run.calls = calls;
  return run;
}

// ── consent is the engineer's to give ───────────────────────────────────────

test("a non-interactive run is never opted in for you", () => {
  const d = decideConsent({ flagYes: false, flagNo: false, isTTY: false, ask: () => true, existing: "unset" });
  assert.deepEqual([d.granted, d.source], [false, "non-interactive"]);
});

test("an interactive run is asked, and the answer is honoured both ways", () => {
  assert.equal(decideConsent({ isTTY: true, ask: () => true, existing: "unset" }).granted, true);
  assert.equal(decideConsent({ isTTY: true, ask: () => false, existing: "unset" }).granted, false);
});

test("flags answer without prompting, and --no-telemetry beats --telemetry", () => {
  let asked = false;
  const ask = () => ((asked = true), true);
  assert.equal(decideConsent({ flagYes: true, isTTY: true, ask, existing: "unset" }).granted, true);
  assert.equal(decideConsent({ flagNo: true, isTTY: true, ask, existing: "unset" }).granted, false);
  // Both set: refusing wins, because the safe reading of a contradiction is "no".
  assert.equal(decideConsent({ flagYes: true, flagNo: true, isTTY: true, ask, existing: "unset" }).granted, false);
  assert.equal(asked, false, "flags must not trigger the prompt");
});

test("an existing answer is reused, so re-running setup does not re-ask", () => {
  let asked = false;
  const ask = () => ((asked = true), true);
  assert.equal(decideConsent({ isTTY: true, ask, existing: "granted" }).source, "existing");
  assert.equal(decideConsent({ isTTY: true, ask, existing: "denied" }).granted, false);
  assert.equal(asked, false);
});

test("--telemetry overrides a previous decline", () => {
  assert.equal(decideConsent({ flagYes: true, isTTY: true, ask: () => false, existing: "denied" }).granted, true);
});

// ── the consent file is the plugin's only gate ──────────────────────────────

test("consentState mirrors il_telemetry/consent.py exactly", () => {
  const dir = tmp();
  assert.equal(consentState(consentIn(dir)), "unset"); // absent
  fs.writeFileSync(consentIn(dir), "granted\n");
  assert.equal(consentState(consentIn(dir)), "granted"); // trailing newline tolerated
  fs.writeFileSync(consentIn(dir), "denied");
  assert.equal(consentState(consentIn(dir)), "denied");
  fs.writeFileSync(consentIn(dir), "yes please");
  assert.equal(consentState(consentIn(dir)), "unset"); // anything else is NOT consent
});

test("setConsent writes the exact token the plugin looks for", () => {
  const dir = tmp();
  setConsent(true, consentIn(dir));
  assert.equal(fs.readFileSync(consentIn(dir), "utf8"), "granted");
  setConsent(false, consentIn(dir));
  assert.equal(fs.readFileSync(consentIn(dir), "utf8"), "denied");
});

// ── installing the plugin ───────────────────────────────────────────────────

test("a marketplace already added is not a failure — only the install decides", () => {
  const run = fakeRun(["marketplace add"]);
  assert.equal(installPlugin(run).ok, true);
  assert.ok(run.calls.some((c) => c.includes("plugin install edge8-telemetry@edge8")));
});

test("a failed install reports the server's first line, not a stack", () => {
  const res = installPlugin(fakeRun(["plugin install"]));
  assert.equal(res.ok, false);
  assert.match(res.detail, /boom/);
  assert.ok(!res.detail.includes("\n"), "detail must be one line");
});

// ── end to end, and never fatal ─────────────────────────────────────────────

test("granting installs the plugin and records consent", () => {
  const dir = tmp();
  const run = fakeRun();
  const out = setUpTelemetry({ flagYes: true, run, consentPath: consentIn(dir) });
  assert.equal(out.enabled, true);
  assert.equal(consentState(consentIn(dir)), "granted");
});

test("declining records the refusal and says how to change your mind", () => {
  const dir = tmp();
  const out = setUpTelemetry({ flagNo: true, run: fakeRun(), consentPath: consentIn(dir) });
  assert.equal(out.enabled, false);
  assert.equal(consentState(consentIn(dir)), "denied");
  assert.match(out.note, /--telemetry/);
});

test("no Claude Code on PATH is reported, not thrown", () => {
  const dir = tmp();
  const out = setUpTelemetry({ flagYes: true, run: fakeRun(["claude --version"]), consentPath: consentIn(dir) });
  assert.equal(out.enabled, false);
  assert.match(out.note, /Claude Code not found/);
  // Consent is NOT granted when the plugin could not be installed — otherwise
  // status would claim telemetry is on while nothing captures.
  assert.equal(consentState(consentIn(dir)), "unset");
});

test("a failed plugin install leaves consent unset rather than claiming success", () => {
  const dir = tmp();
  const out = setUpTelemetry({ flagYes: true, run: fakeRun(["plugin install"]), consentPath: consentIn(dir) });
  assert.equal(out.enabled, false);
  assert.match(out.note, /plugin install failed/);
  assert.equal(consentState(consentIn(dir)), "unset");
});

test("a non-interactive run leaves no consent file at all", () => {
  const dir = tmp();
  const out = setUpTelemetry({ isTTY: false, run: fakeRun(), consentPath: consentIn(dir) });
  assert.equal(out.enabled, false);
  assert.equal(consentState(consentIn(dir)), "unset");
  assert.match(out.note, /non-interactive/);
});

test("nothing in the telemetry step can throw into setup()", () => {
  const dir = tmp();
  const explode = () => {
    throw new Error("catastrophe");
  };
  // Every dependency fails at once: still returns a summary.
  const out = setUpTelemetry({
    flagYes: true,
    run: explode,
    consentPath: path.join(dir, "no", "such", "dir", "consent"),
  });
  assert.equal(out.enabled, false);
  assert.ok(out.note.length > 0);
});
