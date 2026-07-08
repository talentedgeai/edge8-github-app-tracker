#!/usr/bin/env node
// edge8-tracker git credential helper.
// Installed once at ~/.edge8/helper.mjs by `tracker setup`; git invokes it whenever
// a github.com operation needs credentials. Design rules:
//   - NEVER break git: any error/unknown repo -> print nothing, exit 0, git falls
//     through to the engineer's next credential helper (manager/osxkeychain/...).
//   - Tokens live 60 min; we cache per-repo in ~/.edge8/cache.json and re-mint on
//     expiry — auto-refresh needs no daemon because git calls us on every operation.
//   - Cache hits still send a /beacon heartbeat: that is the capture signal that
//     work is happening even when no new token is minted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".edge8");
const CONFIG = path.join(DIR, "config.json");
const CACHE = path.join(DIR, "cache.json");
const REFRESH_MARGIN_MS = 2 * 60_000;
// Cold-start tolerant: a serverless /app-token can take >4s on a cold function. Too tight
// a timeout aborts the mint, the helper prints nothing, and git silently falls through to
// the platform manager (which has no credential for a tracked repo) — so keep this ample.
const HTTP_TIMEOUT_MS = 10_000;

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseInput(text) {
  const kv = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

async function post(url, headers, body, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function main() {
  const action = process.argv[2];
  if (action !== "get") return; // store/erase: no-op

  const input = parseInput(readStdin());
  if ((input.host ?? "") !== "github.com") return;
  const repoPath = (input.path ?? "").replace(/\.git$/, "") + ".git";
  if (repoPath === ".git") return; // no path (useHttpPath off?) -> stay silent

  const cfg = readJson(CONFIG);
  if (!cfg?.server || !cfg?.key) return;
  const base = cfg.server.replace(/\/+$/, "") + (cfg.apiPrefix ?? "");

  // 1) local cache with life left -> answer instantly + heartbeat
  const cache = readJson(CACHE) ?? {};
  const hit = cache[repoPath];
  if (hit && Date.parse(hit.expires_at) - Date.now() > REFRESH_MARGIN_MS) {
    // password_expiry_utc tells git (2.34+) and GCM the token expires — so a stale
    // cached credential is never reused (git re-invokes us instead).
    const exp = Math.floor(Date.parse(hit.expires_at) / 1000);
    process.stdout.write(
      `username=x-access-token\npassword=${hit.token}\npassword_expiry_utc=${exp}\n`,
    );
    try {
      await post(
        `${base}/beacon`,
        { "x-edge8-key": cfg.key },
        { host: "github.com", path: repoPath, verb: "unknown" },
        1500,
      );
    } catch {
      /* heartbeat is best-effort */
    }
    return;
  }

  // 2) mint (or re-mint after expiry) — the clock-start capture happens server-side
  try {
    const res = await post(
      `${base}/app-token`,
      { "x-edge8-key": cfg.key },
      { host: "github.com", path: repoPath, verb: "unknown" },
    );
    if (!res.ok) return; // 404 untracked repo / 401 / 5xx -> silent fall-through
    const j = await res.json();
    if (!j?.token) return;
    cache[repoPath] = { token: j.token, expires_at: j.expires_at };
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch {
      /* cache write is best-effort */
    }
    const exp = Math.floor(Date.parse(j.expires_at) / 1000);
    process.stdout.write(
      `username=${j.username}\npassword=${j.token}\npassword_expiry_utc=${exp}\n`,
    );
  } catch {
    /* server unreachable -> silent fall-through */
  }
}

await main();
