process.env.DB_PATH = "data/test-access-events.db";

// Every /app-token and /beacon call records WHAT IT ACHIEVED, not just that it
// happened. Before migration 0005 the event was written before the installation
// lookup, so a repo whose owner had never installed the App produced access
// events indistinguishable from working ones — 20 of them for one such repo,
// while the helper silently fell through to the engineer's own credentials.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const H = await import("./helpers");
const { handleAppToken, handleBeacon } = await import("../src/handlers");

const KEY = "e8k_test0001_" + "a".repeat(48);
const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const events = () =>
  H.db.all(`SELECT * FROM git_access_events ORDER BY id`);

beforeEach(async () => {
  await H.wipe();
  await H.db.run(
    `INSERT INTO engineer_keys (key_id, key_hash, member) VALUES (?,?,?)
     ON CONFLICT (key_id) DO NOTHING`,
    "e8k_test0001",
    hashOf(KEY),
    "dev@local",
  );
});

test("an uninstalled owner is recorded as a failure, not as activity", async () => {
  const res = await handleAppToken(KEY, {
    host: "github.com",
    path: "not-installed/repo.git",
  });
  assert.equal(res.status, 404);

  const [e] = await events();
  assert.equal(e.outcome, "no_installation");
  assert.equal(e.kind, "token");
  assert.equal(e.repo_path, "not-installed/repo.git");
});

test("exactly one row per request — the outcome is settled in place", async () => {
  await handleAppToken(KEY, { host: "github.com", path: "not-installed/repo.git" });
  assert.equal((await events()).length, 1);
});

// The clock-start must survive a mint that never returns, so the row is written
// before GitHub is called and only then settled. Proven by making the lookup
// throw: the event is still there, and the request still fails loudly.
test("a request that dies mid-mint still leaves its clock-start behind", async () => {
  // Real fault injection: the installation lookup always ends in a read of
  // app_installations, so taking that table away makes it throw exactly the way
  // an unreachable database would.
  await H.db.exec(`ALTER TABLE app_installations RENAME TO app_installations_gone`);
  try {
    await assert.rejects(
      handleAppToken(KEY, { host: "github.com", path: "acme/app.git" }),
    );
  } finally {
    await H.db.exec(`ALTER TABLE app_installations_gone RENAME TO app_installations`);
  }

  // The row's mere existence is the proof: settling is an UPDATE, so if the
  // insert had come after the lookup there would be nothing here at all.
  const [e] = await events();
  assert.equal(e.repo_path, "acme/app.git"); // the billing signal survived
  assert.equal(e.outcome, "mint_failed"); // and got labelled on the way out
  // `pending` is what remains only when the process dies before even this —
  // which is the point of writing the row first.
});

test("a beacon is a cache hit: work is real, nothing was minted", async () => {
  const res = await handleBeacon(KEY, {
    host: "github.com",
    path: "acme/app.git",
    observed_at: H.T("09:00"),
  });
  assert.equal(res.status, 204);

  const [e] = await events();
  assert.equal(e.outcome, "cache_hit");
  assert.equal(e.kind, "beacon");
  assert.equal(e.observed_at, H.T("09:00")); // beacons may carry client time
});

test("a token event is stamped with SERVER time, never the client's", async () => {
  const before = Date.now();
  await handleAppToken(KEY, {
    host: "github.com",
    path: "not-installed/repo.git",
    observed_at: "2001-01-01T00:00:00Z", // a backdated span would inflate billing
  });
  const [e] = await events();
  assert.ok(Date.parse(e.observed_at) >= before);
});

test("a bad key records nothing at all", async () => {
  const res = await handleAppToken("e8k_test0001_" + "b".repeat(48), {
    host: "github.com",
    path: "acme/app.git",
  });
  assert.equal(res.status, 401);
  assert.equal((await events()).length, 0);
});

test("coverage is answerable from the table: successes are distinguishable", async () => {
  await handleAppToken(KEY, { host: "github.com", path: "not-installed/a.git" });
  await handleAppToken(KEY, { host: "github.com", path: "not-installed/b.git" });
  await handleBeacon(KEY, { host: "github.com", path: "acme/app.git" });

  // The question that could not be asked before: which repos are we SERVING?
  const served = await H.db.all(
    `SELECT DISTINCT repo_path FROM git_access_events
     WHERE outcome IN ('minted','cache_hit')`,
  );
  assert.deepEqual(served.map((r: any) => r.repo_path), ["acme/app.git"]);
});
