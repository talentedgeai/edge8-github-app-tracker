#!/usr/bin/env node
// edge8-tracker CLI. One command matters: `tracker setup --key <e8k_...> --server <url>`
// It is a ONE-TIME, per-machine install: after it, every git pull/push on every
// tracked github.com repo authenticates through the tracker (fresh 60-min tokens,
// auto-refreshed), and untracked/personal repos fall through untouched.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(os.homedir(), ".edge8");
const CONFIG = path.join(DIR, "config.json");
const HELPER_DEST = path.join(DIR, "helper.mjs");
const HELPER_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "helper.mjs",
);

// git config values must never pass through a shell — always execFileSync + array.
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg) {
  console.error(`tracker: ${msg}`);
  process.exit(1);
}

async function probeServer(server, key) {
  // Find where the API lives ("/api" on Vercel, "" on the local dev server) and
  // validate the key: our app-token answers 404 {error:"no installation..."} for an
  // unknown-but-authenticated path, 401 for a bad key.
  for (const prefix of ["/api", ""]) {
    try {
      const res = await fetch(`${server}${prefix}/app-token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-edge8-key": key },
        body: JSON.stringify({ host: "github.com", path: "_setup/_probe.git", verb: "unknown" }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 401) fail("key rejected by the server (401) — check the key");
      if (res.status === 404 || res.status === 200) {
        // make sure the 404 is OURS, not the platform's "no such route"
        const body = await res.json().catch(() => null);
        if (body && (body.error || body.token)) return prefix;
      }
      if (res.status === 503) return prefix; // ours: app not configured yet
    } catch {
      /* try the next prefix */
    }
  }
  fail(`could not reach a tracker API at ${server} — check the URL`);
}

function platformFallbackHelper() {
  if (process.platform === "win32") return "manager";
  if (process.platform === "darwin") return "osxkeychain";
  return "cache";
}

async function setup() {
  const key = arg("--key");
  const server = (arg("--server") ?? "").replace(/\/+$/, "");
  if (!key || !/^e8k_[A-Za-z0-9]+_.+/.test(key))
    fail("missing/invalid --key (expected e8k_<id>_<secret>)");
  if (!/^https?:\/\//.test(server)) fail("missing/invalid --server (http(s) URL)");

  const apiPrefix = await probeServer(server, key);

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({ server, apiPrefix, key }, null, 2),
    { mode: 0o600 },
  );
  fs.copyFileSync(HELPER_SRC, HELPER_DEST);

  // Git wiring (global, host-scoped => every github.com repo, present and future):
  //  - useHttpPath: the helper must see owner/repo to route + log correctly
  //  - the empty "" entry RESETS the helper list for github.com, so a system-level
  //    credential manager can't answer with a stored PAT before our helper runs
  //  - our helper goes first; the platform manager is re-added as the fallback for
  //    personal/untracked repos (our helper prints nothing for those)
  // Pin the ABSOLUTE node path, not a bare `node`: git runs helpers through its own shell
  // whose PATH may differ from this one (Windows/GUI git clients), and a missing/old node
  // would make the helper fail silently. process.execPath is the node running this setup.
  const nodePath = process.execPath.replace(/\\/g, "/");
  const helperCmd = `!"${nodePath}" "${HELPER_DEST.replace(/\\/g, "/")}"`;
  git("config", "--global", "credential.https://github.com.useHttpPath", "true");
  try {
    git("config", "--global", "--unset-all", "credential.https://github.com.helper");
  } catch {
    /* nothing to unset */
  }
  git("config", "--global", "--add", "credential.https://github.com.helper", "");
  git("config", "--global", "--add", "credential.https://github.com.helper", helperCmd);
  git("config", "--global", "--add", "credential.https://github.com.helper", platformFallbackHelper());

  console.log("tracker: setup complete ✔");
  console.log(`  server : ${server}${apiPrefix}`);
  console.log(`  config : ${CONFIG}`);
  console.log(`  helper : ${HELPER_DEST}`);
  console.log("\nEvery git pull/push on tracked github.com repos now authenticates");
  console.log("through the tracker (60-min tokens, auto-refreshed). Personal repos");
  console.log("fall through to your existing credential manager.");
}

function uninstall() {
  try {
    git("config", "--global", "--unset-all", "credential.https://github.com.helper");
  } catch {}
  try {
    git("config", "--global", "--unset", "credential.https://github.com.useHttpPath");
  } catch {}
  git("config", "--global", "--add", "credential.https://github.com.helper", platformFallbackHelper());
  fs.rmSync(path.join(DIR, "cache.json"), { force: true });
  console.log("tracker: git wiring removed (config kept at ~/.edge8/config.json)");
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "uninstall") uninstall();
else {
  console.log(`edge8-tracker CLI

usage:
  tracker setup --key <e8k_...> --server <https://your-app.vercel.app>
  tracker uninstall

setup is one-time per machine: it stores your key at ~/.edge8/config.json,
installs the git credential helper, and wires git for github.com (all repos).`);
  process.exit(cmd ? 1 : 0);
}
