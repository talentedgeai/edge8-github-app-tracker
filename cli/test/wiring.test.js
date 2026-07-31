// Unit tests for the pure wiring logic (cli/src/wiring.mjs).
// Table-driven around the real-world chain shapes the 2026-07 freeze memo is
// about: gh-clobbered lists, legacy node-pinned wiring, duplicates, XDG noise.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeChain,
  buildShim,
  buildTarget,
  buildUninstallTarget,
  classifyKey,
  computeEffective,
  isLegacy,
  isOurs,
  linesOf,
  nulsOf,
  parseZRecords,
  urlMatchesGithub,
} from "../src/wiring.mjs";

const SHIM = '!"C:/Users/q/.edge8/helper.sh"';
const LEGACY = '!"C:/Program Files/nodejs/node.exe" "C:/Users/q/.edge8/helper.mjs"';
const GH = "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential";

test("isOurs / isLegacy recognize both wiring generations and slash directions", () => {
  assert.equal(isOurs(SHIM), true);
  assert.equal(isOurs(LEGACY), true);
  assert.equal(isOurs('!"/Users/q/.edge8/helper.sh"'), true);
  assert.equal(isOurs("C:\\Users\\q\\.edge8\\helper.mjs"), true);
  assert.equal(isOurs(GH), false);
  assert.equal(isOurs("manager"), false);
  assert.equal(isOurs(""), false);
  assert.equal(isLegacy(LEGACY), true);
  assert.equal(isLegacy(SHIM), false);
});

test("linesOf keeps empty entries and drops only the trailing newline", () => {
  assert.deepEqual(linesOf(""), []);
  assert.deepEqual(linesOf("\n"), [""]); // a single "" reset entry
  assert.deepEqual(linesOf(`\n${SHIM}\nmanager\n`), ["", SHIM, "manager"]);
  assert.deepEqual(linesOf(`\r\n${SHIM}\r\n`), ["", SHIM]); // CRLF tolerant
});

test("nulsOf preserves values that CONTAIN newlines (inline shell helpers)", () => {
  const multiline = "!f() { echo username=x\necho password=y; }; f";
  assert.deepEqual(nulsOf(""), []);
  assert.deepEqual(nulsOf("\0"), [""]); // a single "" reset entry
  assert.deepEqual(nulsOf(`\0${multiline}\0manager\0`), ["", multiline, "manager"]);
});

test("parseZRecords: scope NUL origin NUL key LF value NUL framing", () => {
  const raw =
    "global\0file:C:/u/.gitconfig\0credential.https://github.com.helper\n\0" +
    `global\0file:C:/u/.gitconfig\0credential.https://github.com.helper\n${SHIM}\0` +
    "system\0file:C:/git/etc/gitconfig\0credential.helper\nmanager\0" +
    "global\0file:C:/u/.gitconfig\0credential.helper\0"; // boolean-true (no LF)
  const rs = parseZRecords(raw);
  assert.equal(rs.length, 4);
  assert.deepEqual(rs[0], { scope: "global", origin: "file:C:/u/.gitconfig", key: "credential.https://github.com.helper", value: "" });
  assert.equal(rs[1].value, SHIM);
  assert.equal(rs[2].scope, "system");
  assert.equal(rs[2].value, "manager");
  assert.equal(rs[3].value, null);
});

test("classifyKey / urlMatchesGithub route keys to the right context", () => {
  assert.deepEqual(classifyKey("credential.helper"), { sub: "helper", applies: "wildcard" });
  assert.deepEqual(classifyKey("credential.https://github.com.helper"), { sub: "helper", applies: "github" });
  assert.deepEqual(classifyKey("credential.https://github.com.usehttppath"), { sub: "usehttppath", applies: "github" });
  assert.deepEqual(classifyKey("credential.https://dev.azure.com.usehttppath"), { sub: "usehttppath", applies: "other" });
  assert.deepEqual(classifyKey("credential.github.com.helper"), { sub: "helper", applies: "github" }); // scheme-less
  assert.equal(classifyKey("credential.https://github.com.username"), null);
  assert.equal(classifyKey("user.name"), null);
  assert.equal(urlMatchesGithub("https://x@github.com/org/repo"), true);
  assert.equal(urlMatchesGithub("https://github.com:443"), true);
  assert.equal(urlMatchesGithub("https://gist.github.com"), false);
});

test("computeEffective: \"\" resets kill earlier scopes; ours lands first", () => {
  const rs = [
    { scope: "system", origin: "f:sys", key: "credential.helper", value: "manager" },
    { scope: "global", origin: "f:g", key: "credential.https://github.com.helper", value: "" },
    { scope: "global", origin: "f:g", key: "credential.https://github.com.helper", value: SHIM },
    { scope: "global", origin: "f:g", key: "credential.https://github.com.helper", value: "manager" },
    { scope: "global", origin: "f:g", key: "credential.https://github.com.usehttppath", value: "true" },
  ];
  const eff = computeEffective(rs);
  assert.deepEqual(eff.chain.map((e) => e.value), [SHIM, "manager"]);
  assert.equal(eff.useHttpPath, true);
  const a = analyzeChain(eff.chain);
  assert.equal(a.oursIdx, 0);
  assert.deepEqual(a.blockers, []);
});

test("computeEffective: lost \"\" guard exposes the system manager as a blocker", () => {
  const rs = [
    { scope: "system", origin: "f:sys", key: "credential.helper", value: "manager" },
    { scope: "global", origin: "f:g", key: "credential.https://github.com.helper", value: SHIM },
  ];
  const a = analyzeChain(computeEffective(rs).chain);
  assert.equal(a.oursIdx, 1);
  assert.equal(a.blockers[0].value, "manager");
  assert.equal(a.blockers[0].scope, "system");
});

test("computeEffective: gh-clobbered global (\"\" + gh) -> ours absent", () => {
  const rs = [
    { scope: "global", origin: "f:g", key: "credential.https://github.com.helper", value: "" },
    { scope: "global", origin: "f:g", key: "credential.https://github.com.helper", value: GH },
  ];
  const a = analyzeChain(computeEffective(rs).chain);
  assert.equal(a.oursIdx, -1);
});

test("computeEffective: URL-specific useHttpPath beats a later wildcard; other hosts ignored", () => {
  const rs = [
    { scope: "global", origin: "f", key: "credential.https://github.com.usehttppath", value: "true" },
    { scope: "global", origin: "f", key: "credential.usehttppath", value: "false" },
    { scope: "system", origin: "f", key: "credential.https://dev.azure.com.usehttppath", value: "true" },
    { scope: "global", origin: "f", key: "credential.https://dev.azure.com.helper", value: "azure-thing" },
  ];
  const eff = computeEffective(rs);
  assert.equal(eff.useHttpPath, true);
  assert.deepEqual(eff.chain, []); // azure helper never enters the github chain
});

test("computeEffective surfaces boolean-true helper junk instead of dropping it silently", () => {
  const rs = [{ scope: "global", origin: "f", key: "credential.helper", value: null }];
  const eff = computeEffective(rs);
  assert.equal(eff.skipped.length, 1);
});

const FB = "manager";
test("buildTarget: table of real-world pre-states", () => {
  for (const [name, existing, want] of [
    ["fresh machine", [], ["", SHIM, FB]],
    ["null snapshot (key absent)", null, ["", SHIM, FB]],
    ["v0.2.x legacy wiring", ["", LEGACY, FB], ["", SHIM, FB]],
    ["gh-clobbered (the memo author's machine)", ["", GH], ["", SHIM, GH, FB]],
    ["gh first, never tracked", [GH, FB], ["", SHIM, GH, FB]],
    ["duplicates collapse", [GH, GH, FB, FB], ["", SHIM, GH, FB]],
    ["custom helper preserved in order", ["", "cache --timeout=300", GH], ["", SHIM, "cache --timeout=300", GH, FB]],
  ]) {
    assert.deepEqual(buildTarget(existing, SHIM, FB), want, name);
  }
});

test("buildTarget is idempotent: running setup twice changes nothing", () => {
  const once = buildTarget(["", GH, FB], SHIM, FB);
  assert.deepEqual(buildTarget(once, SHIM, FB), once);
});

test("buildUninstallTarget: drops ours, never strands a bare \"\" guard", () => {
  for (const [name, existing, want] of [
    ["ours + gh + fallback", ["", SHIM, GH, FB], ["", GH, FB]],
    ["ours + fallback only", ["", SHIM, FB], ["", FB]],
    ["ours alone", ["", SHIM], [FB]],
    ["legacy alone", ["", LEGACY], [FB]],
    ["never installed", [FB], ["", FB]],
    ["empty", [], [FB]],
  ]) {
    assert.deepEqual(buildUninstallTarget(existing, FB), want, name);
  }
});

test("buildShim: LF only, forward slashes, selftest + silent-fallthrough contract", () => {
  const s = buildShim("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\q\\.edge8\\helper.mjs");
  assert.ok(!s.includes("\r"), "must not contain CR (macOS/Linux sh rejects CRLF)");
  assert.ok(s.startsWith("#!/bin/sh\n"));
  assert.ok(s.includes('RECORDED="C:/Program Files/nodejs/node.exe"'));
  assert.ok(s.includes('HELPER="C:/Users/q/.edge8/helper.mjs"'));
  assert.ok(s.includes("--selftest"));
  assert.ok(s.includes("command -v node"));
  assert.ok(s.includes('[ -z "$NODE" ] && exit 0'), "no node -> exit 0 silently, never break git");
  assert.ok(s.includes('exec "$NODE" "$HELPER" "$@"'));
  assert.ok(s.includes("sort -t. -k1,1n"), "nvm pick must be numeric sort, not asciibetical");
});

test("buildShim escapes sh metacharacters in embedded paths", () => {
  const s = buildShim("C:\\Users\\SVC$\\node.exe", '/mnt/we"ird`/helper.mjs');
  assert.ok(s.includes('RECORDED="C:/Users/SVC\\$/node.exe"'), "unescaped $ would expand inside sh double quotes");
  assert.ok(s.includes('HELPER="/mnt/we\\"ird\\`/helper.mjs"'), "unescaped quote/backtick would break the shim source");
});
