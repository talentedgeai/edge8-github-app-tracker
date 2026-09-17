import crypto from "node:crypto";
import { db } from "./db.js";
import { parseDelivery } from "./parse.js";
import { postPushCapture } from "./mint.js";
import { onPullRequestWebhook } from "./pairing.js";
import { installationForRepoPath, mintInstallationToken } from "./github.js";

// Framework-agnostic request handlers — the local Express server (src/server.ts)
// and the Vercel functions (api/*) both delegate here, so behaviour is identical.

export interface HandlerResult {
  status: number;
  json?: unknown;
  text?: string;
}

// Compare two secrets in constant time with NO length leak: hash both to a fixed
// 32 bytes first. (timingSafeEqual requires equal-length inputs, so a raw length
// guard would reveal the secret's length via an early return.)
function secretEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- Webhook: verify signature -> store raw -> parse/mint/pair -> ack fast ---
export async function handleWebhook(input: {
  id: string;
  evt: string;
  sig: string;
  raw: Buffer;
  headers: Record<string, unknown>;
}): Promise<HandlerResult> {
  const { id, evt, sig, raw, headers } = input;

  // 1. VERIFY — HMAC-SHA256 of the RAW bytes, constant-time compare.
  // Fail CLOSED if the secret is missing: never HMAC with an empty key, or anyone
  // could forge a valid signature when the env var is unset/misconfigured.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("WEBHOOK_SECRET not configured — rejecting webhook");
    return { status: 401, text: "bad signature" };
  }
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  if (!secretEqual(sig, expected)) return { status: 401, text: "bad signature" };

  // 2. STORE RAW FIRST — before anything can throw. ON CONFLICT = redelivery-safe.
  const bodyText = raw.toString("utf8");
  let payload: any = {};
  try {
    payload = JSON.parse(bodyText);
  } catch {
    /* keep {} — the raw row is still stored verbatim below */
  }
  await db.run(
    `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, headers)
     VALUES (?,?,?,?,?) ON CONFLICT (delivery_id) DO NOTHING`,
    id,
    evt,
    payload.action ?? null,
    bodyText,
    JSON.stringify(headers),
  );

  // 3. PARSE (+ mint/pair) in a try/catch — a bug here must never lose the raw row
  // or fail the request. Everything derived is recomputable (reparse + remint).
  try {
    await parseDelivery(id, evt, payload);
    if (evt === "push") await postPushCapture(id);
    else if (evt === "pull_request") await onPullRequestWebhook(payload);
  } catch (err) {
    console.error("parse/mint failed (raw is safe):", id, err);
  }

  // 4. ACK FAST.
  return { status: 200, text: "ok" };
}

// --- Key auth: key_id = first two "_"-segments; compare sha256(full secret) ---
async function findActiveKey(presented: string): Promise<any | null> {
  const keyId = presented.split("_").slice(0, 2).join("_"); // "e8k_<id>"
  const rec = await db.get(
    `SELECT * FROM engineer_keys WHERE key_id = ? AND status = 'active'`,
    keyId,
  );
  if (!rec) return null;
  const hash = crypto.createHash("sha256").update(presented).digest("hex");
  return secretEqual(hash, rec.key_hash ?? "") ? rec : null;
}

/**
 * What the request actually achieved. Recorded so the event stream can be read
 * as coverage: an access event on its own only proves the helper ASKED, and for
 * an owner with no installation it will keep asking forever. See migration 0005.
 *
 * `pending` is the state between the row landing and GitHub answering. It
 * survives a crash or a function timeout mid-mint, and says the honest thing —
 * we asked, we never learned the result — instead of implying either one.
 */
export type AccessOutcome =
  | "pending"
  | "minted"
  | "no_installation"
  | "mint_failed"
  | "cache_hit";

/** Insert the access event and return its id, so the outcome can be settled later. */
async function logAccessEvent(
  keyId: string,
  body: any,
  kind: "token" | "beacon",
  outcome: AccessOutcome,
): Promise<number | null> {
  // The token event is the clock-start: stamp it with SERVER time and never trust a
  // client-supplied observed_at (which could backdate the span and inflate billing).
  // Only the beacon (a cache-hit heartbeat) may carry the client's observed_at.
  const observedAt =
    kind === "beacon"
      ? (body?.observed_at ?? new Date().toISOString())
      : new Date().toISOString();
  const row = await db.get(
    `INSERT INTO git_access_events (key_id, repo_path, verb, kind, observed_at, outcome, raw)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    keyId,
    body?.path ?? null,
    body?.verb ?? "unknown",
    kind,
    observedAt,
    outcome,
    JSON.stringify(body ?? {}),
  );
  return row?.id ?? null;
}

/**
 * Settle a `pending` event once the mint has resolved.
 *
 * Best-effort on purpose: the row already carries the clock-start, which is what
 * billing needs. Failing to label it must never cost the engineer their token.
 */
async function recordOutcome(
  id: number | null,
  outcome: AccessOutcome,
): Promise<void> {
  if (id === null) return;
  try {
    await db.run(`UPDATE git_access_events SET outcome = ? WHERE id = ?`, outcome, id);
  } catch {
    /* the event itself is safe; it just stays 'pending' */
  }
}

// --- POST /app-token — mint a real 60-minute installation token ---
export async function handleAppToken(
  presented: string,
  body: any,
): Promise<HandlerResult> {
  const rec = await findActiveKey(presented);
  if (!rec) return { status: 401, json: { error: "bad key" } };

  // LOG THE ACCESS EVENT FIRST — this is the clock-start capture, before we mint.
  // It lands as `pending` and is settled below: the billing signal is never at the
  // mercy of a slow or hanging GitHub call, and the outcome is added once known.
  const eventId = await logAccessEvent(rec.key_id, body, "token", "pending");

  let inst: any;
  try {
    inst = await installationForRepoPath(body?.path ?? "");
  } catch (err) {
    await recordOutcome(eventId, "mint_failed");
    throw err;
  }
  if (!inst) {
    // 404 tells the credential helper "not a tracked repo" -> it stays silent and
    // git falls through to the engineer's next credential helper. Invisible to the
    // engineer by design, which is why the outcome has to be visible to us.
    await recordOutcome(eventId, "no_installation");
    return { status: 404, json: { error: "no installation for repo" } };
  }
  try {
    const { token, expiresAt } = await mintInstallationToken(
      Number(inst.installation_id),
    );
    await recordOutcome(eventId, "minted");
    return {
      status: 200,
      json: { username: "x-access-token", token, expires_at: expiresAt },
    };
  } catch (err: any) {
    await recordOutcome(eventId, "mint_failed");
    return {
      status: 503,
      json: { error: "mint failed", detail: String(err?.message ?? err) },
    };
  }
}

// --- POST /beacon — cache-hit heartbeat. Always 204; never leak key validity ---
export async function handleBeacon(
  presented: string,
  body: any,
): Promise<HandlerResult> {
  const rec = await findActiveKey(presented);
  // A beacon only happens on a cache hit, which means a token was minted earlier
  // and is still being used — so the work is real even though nothing was minted now.
  if (rec) await logAccessEvent(rec.key_id, body, "beacon", "cache_hit");
  return { status: 204 };
}

// --- GET /health ---
export async function handleHealth(): Promise<HandlerResult> {
  return { status: 200, json: { ok: true, backend: db.kind, tables: await db.tables() } };
}

// --- Admin: manage engineer keys over HTTP (so keys can be issued after deploy,
// with no DB access). ---
//
// Gated by a per-admin key in `admin_keys`, hashed the same way engineer keys
// are. The previous gate was a single shared ADMIN_TOKEN env var, which could
// not say who issued a key and could not cut off one admin without rotating for
// everyone. See supabase/migrations/0004_admin_keys.sql.
export interface AdminActor {
  key_id: string;
  member: string;
  /** True when the caller used the legacy shared env token rather than a key. */
  legacy: boolean;
}

/**
 * Resolve the caller to an admin, or null.
 *
 * ADMIN_TOKEN still works, deliberately: it is the bootstrap path. A fresh
 * deployment has an empty admin_keys table, and without a fallback there would
 * be no way to mint the first admin key without direct database access. It is
 * meant to be removed from the environment once real keys are issued — every
 * use logs a warning naming that, so a lingering one is visible rather than
 * quietly permanent.
 */
async function adminActor(presented: string): Promise<AdminActor | null> {
  if (!presented) return null;

  // A real admin key first, so the legacy path cannot shadow a revoked one.
  const keyId = presented.split("_").slice(0, 2).join("_"); // "e8a_<id>"
  const rec = await db.get(
    `SELECT key_id, member, key_hash FROM admin_keys WHERE key_id = ? AND status = 'active'`,
    keyId,
  );
  if (rec) {
    const hash = crypto.createHash("sha256").update(presented).digest("hex");
    if (!secretEqual(hash, rec.key_hash ?? "")) return null;
    await db.run(
      `UPDATE admin_keys SET last_used_at = ? WHERE key_id = ?`,
      new Date().toISOString(),
      rec.key_id,
    );
    return { key_id: rec.key_id, member: rec.member, legacy: false };
  }

  const shared = process.env.ADMIN_TOKEN;
  if (!shared) return null; // fail closed — nothing configured, deny all
  if (!secretEqual(presented, shared)) return null;
  console.warn(
    "[admin] authenticated with the shared ADMIN_TOKEN. Mint per-admin keys " +
      "(npm run mint-admin-key) and remove ADMIN_TOKEN from the environment.",
  );
  return { key_id: "shared", member: "ADMIN_TOKEN", legacy: true };
}

// method GET -> list (no secrets) | POST {email} -> create (returns key once)
// | DELETE {key_id} -> revoke.
export async function handleAdminKeys(
  adminToken: string,
  method: string,
  params: any,
): Promise<HandlerResult> {
  const actor = await adminActor(adminToken);
  if (!actor) return { status: 401, json: { error: "unauthorized" } };

  // `?target=admin` manages admin keys themselves; the default stays engineer
  // keys so every existing runbook command keeps working unchanged.
  const table = String(params?.target ?? "") === "admin" ? "admin_keys" : "engineer_keys";
  const prefix = table === "admin_keys" ? "e8a" : "e8k";

  if (method === "GET") {
    const keys = await db.all(
      `SELECT key_id, member, status, issued_at FROM ${table} ORDER BY issued_at`,
    );
    return { status: 200, json: { keys } };
  }
  if (method === "POST") {
    const email = String(params?.email ?? "").trim();
    if (!email.includes("@")) return { status: 400, json: { error: "email required" } };
    const keyId = `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
    const full = `${keyId}_${crypto.randomBytes(24).toString("hex")}`;
    const hash = crypto.createHash("sha256").update(full).digest("hex");
    await db.run(
      `INSERT INTO ${table} (key_id, key_hash, member, status) VALUES (?,?,?,'active')`,
      keyId,
      hash,
      email,
    );
    // The attribution the shared token could never give: who issued what.
    console.log(
      `[admin] ${actor.member} (${actor.key_id}) issued ${table} ${keyId} for ${email}`,
    );
    return {
      status: 201,
      json: { key_id: keyId, member: email, key: full, note: "store this key now — it is shown once and not recoverable" },
    };
  }
  if (method === "DELETE") {
    const keyId = String(params?.key_id ?? "").trim();
    if (!keyId) return { status: 400, json: { error: "key_id required" } };
    // Revoking your own admin key would lock you out mid-session with no signal.
    if (table === "admin_keys" && keyId === actor.key_id) {
      return { status: 400, json: { error: "refusing to revoke the key you are authenticating with" } };
    }
    await db.run(`UPDATE ${table} SET status = 'revoked' WHERE key_id = ?`, keyId);
    console.log(`[admin] ${actor.member} (${actor.key_id}) revoked ${table} ${keyId}`);
    return { status: 200, json: { key_id: keyId, status: "revoked" } };
  }
  return { status: 405, json: { error: "method not allowed" } };
}
