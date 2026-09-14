process.env.DB_PATH = "data/test-admin-keys.db";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const H = await import("./helpers");
const { handleAdminKeys } = await import("../src/handlers");

const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const ADMIN = "e8a_aaaa1111_" + "f".repeat(48);
const OTHER = "e8a_bbbb2222_" + "e".repeat(48);

async function seedAdmin(full: string, member: string, status = "active") {
  const keyId = full.split("_").slice(0, 2).join("_");
  await H.db.run(
    `INSERT INTO admin_keys (key_id, key_hash, member, status) VALUES (?,?,?,?)`,
    keyId,
    hashOf(full),
    member,
    status,
  );
  return keyId;
}

beforeEach(async () => {
  await H.db.run(`DELETE FROM admin_keys`);
  await H.db.run(`DELETE FROM engineer_keys`);
  delete process.env.ADMIN_TOKEN;
});

// ── the gate ────────────────────────────────────────────────────────────────

test("no credential at all is refused", async () => {
  const r = await handleAdminKeys("", "GET", {});
  assert.equal(r.status, 401);
});

test("an unknown key is refused", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const r = await handleAdminKeys("e8a_zzzz9999_" + "a".repeat(48), "GET", {});
  assert.equal(r.status, 401);
});

test("the right key id with the wrong secret is refused", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const r = await handleAdminKeys("e8a_aaaa1111_" + "0".repeat(48), "GET", {});
  assert.equal(r.status, 401);
});

test("a valid admin key is accepted", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const r = await handleAdminKeys(ADMIN, "GET", {});
  assert.equal(r.status, 200);
});

// This is the whole point of the change: one admin can be cut off alone.
test("revoking one admin does not affect another", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai", "revoked");
  await seedAdmin(OTHER, "other@edge8.ai");
  assert.equal((await handleAdminKeys(ADMIN, "GET", {})).status, 401);
  assert.equal((await handleAdminKeys(OTHER, "GET", {})).status, 200);
});

test("a revoked key is not rescued by the shared token still being set", async () => {
  process.env.ADMIN_TOKEN = "shared-secret";
  await seedAdmin(ADMIN, "admin@edge8.ai", "revoked");
  // Presenting the revoked key must fail even though a legacy path exists —
  // otherwise revocation would be silently undone by the bootstrap fallback.
  assert.equal((await handleAdminKeys(ADMIN, "GET", {})).status, 401);
});

// ── the bootstrap path ──────────────────────────────────────────────────────

test("the shared ADMIN_TOKEN still works, so a fresh deploy is not locked out", async () => {
  process.env.ADMIN_TOKEN = "shared-secret";
  assert.equal((await handleAdminKeys("shared-secret", "GET", {})).status, 200);
  assert.equal((await handleAdminKeys("wrong", "GET", {})).status, 401);
});

test("with no keys and no ADMIN_TOKEN the endpoint fails closed", async () => {
  assert.equal((await handleAdminKeys("anything", "GET", {})).status, 401);
});

// ── issuing ─────────────────────────────────────────────────────────────────

test("issuing an engineer key stays the default and keeps the e8k_ prefix", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const r: any = await handleAdminKeys(ADMIN, "POST", { email: "dev@edge8.ai" });
  assert.equal(r.status, 201);
  assert.ok(r.json.key_id.startsWith("e8k_"), r.json.key_id);
  assert.ok(r.json.key.startsWith(r.json.key_id + "_"));
  const row: any = await H.db.get(`SELECT * FROM engineer_keys WHERE key_id = ?`, r.json.key_id);
  assert.equal(row.member, "dev@edge8.ai");
  // The secret is never stored — only its hash, and it must match what we returned.
  assert.equal(row.key_hash, hashOf(r.json.key));
  assert.ok(!JSON.stringify(row).includes(r.json.key.split("_")[2]));
});

test("target=admin issues an admin key with the e8a_ prefix", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const r: any = await handleAdminKeys(ADMIN, "POST", { target: "admin", email: "new@edge8.ai" });
  assert.equal(r.status, 201);
  assert.ok(r.json.key_id.startsWith("e8a_"), r.json.key_id);
  // And it works immediately.
  assert.equal((await handleAdminKeys(r.json.key, "GET", {})).status, 200);
});

test("a malformed email is refused before anything is written", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const r = await handleAdminKeys(ADMIN, "POST", { email: "not-an-email" });
  assert.equal(r.status, 400);
  assert.equal((await H.db.all(`SELECT * FROM engineer_keys`)).length, 0);
});

// ── revoking ────────────────────────────────────────────────────────────────

test("revoking an engineer key marks it revoked rather than deleting it", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  const made: any = await handleAdminKeys(ADMIN, "POST", { email: "dev@edge8.ai" });
  const r = await handleAdminKeys(ADMIN, "DELETE", { key_id: made.json.key_id });
  assert.equal(r.status, 200);
  const row: any = await H.db.get(`SELECT * FROM engineer_keys WHERE key_id = ?`, made.json.key_id);
  assert.equal(row.status, "revoked"); // still there — the audit trail survives
});

test("you cannot revoke the admin key you are authenticating with", async () => {
  const keyId = await seedAdmin(ADMIN, "admin@edge8.ai");
  const r: any = await handleAdminKeys(ADMIN, "DELETE", { target: "admin", key_id: keyId });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /refusing to revoke/);
  assert.equal((await handleAdminKeys(ADMIN, "GET", {})).status, 200); // still works
});

// ── attribution ─────────────────────────────────────────────────────────────

test("using a key stamps last_used_at, so stale admins are visible", async () => {
  const keyId = await seedAdmin(ADMIN, "admin@edge8.ai");
  const before: any = await H.db.get(`SELECT * FROM admin_keys WHERE key_id = ?`, keyId);
  assert.equal(before.last_used_at, null);
  await handleAdminKeys(ADMIN, "GET", {});
  const after: any = await H.db.get(`SELECT * FROM admin_keys WHERE key_id = ?`, keyId);
  assert.ok(after.last_used_at, "expected last_used_at to be stamped");
});

test("method not allowed is still 405", async () => {
  await seedAdmin(ADMIN, "admin@edge8.ai");
  assert.equal((await handleAdminKeys(ADMIN, "PUT", {})).status, 405);
});
