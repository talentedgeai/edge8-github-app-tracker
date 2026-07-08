process.env.DB_PATH = "data/test-mint.db";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("./helpers");
const { mintForDelivery, postPushCapture } = await import("../src/mint");
const { onPullRequestWebhook } = await import("../src/pairing");
const { remintAll } = await import("../src/remint");

beforeEach(async () => {
  await H.wipe();
  await H.seedKey(); // member "dev@local", key e8k_test0001
});

// §9 S2 — three pushes after one beacon TILE the day; sum = first-beacon -> last-push.
test("S2 tiling: beacon 09:00 + pushes 11:24/14:24/17:00 -> 2.4 + 3.0 + 2.6 = 8.0", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d1", H.T("11:24"));
  await H.push("d2", H.T("14:24"));
  await H.push("d3", H.T("17:00"));
  for (const d of ["d1", "d2", "d3"]) await mintForDelivery(d);

  const s = await H.spans();
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.tokens), [2.4, 3.0, 2.6]);
  assert.deepEqual(s.map((x) => x.rule), ["span", "span", "span"]);
  assert.equal(s.reduce((a, x) => a + x.tokens, 0), 8.0);
  assert.equal(s[0].member, "dev@local");
  assert.equal(s[0].span_start, "2026-07-07T09:00:00.000Z"); // first span starts at the beacon
});

// §9 S1 — a Bot push with no clock start mints the default 1.0 and flags it.
test("S1 no clock: Bot push only -> 1.0, default_1, no_clock_start", async () => {
  await H.push("d1", H.T("11:24"));
  await mintForDelivery("d1");

  const [s] = await H.spans();
  assert.equal(s.tokens, 1.0);
  assert.equal(s.rule, "default_1");
  assert.equal(s.span_start, null);
  assert.ok((await H.flagKinds()).includes("no_clock_start"));
  assert.ok(JSON.parse(s.flags).includes("no_clock_start"));
});

// §9 S7 — a genuine Bot push straight to main mints as direct_push.
test("S7 direct push: beacon 09:00, Bot push to main 10:12 -> 1.2, direct_push", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d1", H.T("10:12"), { branch: "main" });
  await mintForDelivery("d1");

  const [s] = await H.spans();
  assert.equal(s.tokens, 1.2);
  assert.equal(s.rule, "direct_push");
  assert.ok((await H.flagKinds()).includes("direct_push"));
});

// §9 merge — the two-delivery fixture: the merge push must NOT mint (any sender).
test("merge carve-out: push to main with head_sha = merge_commit_sha mints nothing", async () => {
  await H.prRow({
    id: 100, branch: "feature-x", state: "closed", merged: 1,
    opened_at: H.T("08:00"), merged_at: H.T("09:30"), closed_at: H.T("09:30"),
    merge_commit_sha: "MSHA",
  });
  await H.beacon(H.T("09:00"));
  await H.push("d-merge-user", H.T("09:31"), { branch: "main", head_sha: "MSHA", sender_type: "User" });
  await H.push("d-merge-bot", H.T("09:32"), { branch: "main", head_sha: "MSHA", sender_type: "Bot" });
  await mintForDelivery("d-merge-user");
  await mintForDelivery("d-merge-bot");
  assert.equal((await H.spans()).length, 0);
});

// §9 TTL — a beacon older than 24h has expired; the push falls back to default_1.
test("TTL expiry: beacon then Bot push 25h later -> 1.0, default_1", async () => {
  await H.beacon(H.T("09:00", "06")); // 2026-07-06 09:00
  await H.push("d1", H.T("10:00", "07")); // 25h later
  await mintForDelivery("d1");

  const [s] = await H.spans();
  assert.equal(s.tokens, 1.0);
  assert.equal(s.rule, "default_1");
  assert.ok((await H.flagKinds()).includes("no_clock_start"));
});

// §9 floor — anything under six minutes still mints 0.1.
test("floor: beacon 09:00, push 09:02 -> 0.1", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d1", H.T("09:02"));
  await mintForDelivery("d1");
  assert.equal((await H.spans())[0].tokens, 0.1);
});

// §9 force-push — spans continue from the prior push; redelivery never double-mints.
test("force-push: second (forced) push spans from the first; redelivery is a no-op", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d1", H.T("10:00"));
  await H.push("d2", H.T("10:30"), { forced: 1 });
  await mintForDelivery("d1");
  await mintForDelivery("d2");

  let s = await H.spans();
  assert.equal(s.length, 2);
  assert.equal(s[0].tokens, 1.0); // 09:00 -> 10:00
  assert.equal(s[1].tokens, 0.5); // 10:00 -> 10:30

  await mintForDelivery("d1"); // GitHub redelivery of the first push
  s = await H.spans();
  assert.equal(s.length, 2); // no duplicate
  const d1 = s.find((x) => x.delivery_id === "d1");
  assert.equal(d1.tokens, 1.0); // converged to the same arithmetic
});

// §9 client push — a User push that is not a merge is recorded but never minted.
test("client push: User push, not a merge -> no span (push_events row remains)", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d1", H.T("10:00"), { sender_type: "User" });
  await mintForDelivery("d1");
  assert.equal((await H.spans()).length, 0);
  const n = (await H.db.get(`SELECT COUNT(*) AS c FROM push_events`)).c;
  assert.equal(Number(n), 1); // recorded
});

// §9 idempotency — remint over the whole history converges to identical rows.
test("idempotency: remintAll twice -> identical rows; matches the live pipeline", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d1", H.T("11:24"));
  await H.push("d2", H.T("14:24"));
  await H.prRow({
    id: 100, branch: "feature-x", state: "closed", merged: 1,
    opened_at: H.T("11:30"), merged_at: H.T("15:00"), closed_at: H.T("15:00"),
    merge_commit_sha: "MSHA", author_block: "dev dev@local",
  });
  await H.push("d3", H.T("15:00"), { branch: "main", head_sha: "MSHA", sender_type: "User" });
  await postPushCapture("d1");
  await postPushCapture("d2");
  await postPushCapture("d3");
  const live = await H.snapshot();

  await remintAll();
  const first = await H.snapshot();
  await remintAll();
  const second = await H.snapshot();

  assert.equal(first, second); // remint is idempotent
  assert.equal(live, first); // live pipeline converges with replay
});

// Live-order reconciliation — the merge push arrives BEFORE the pull_request closed
// event (real fixture: push 08:04:10, closed 08:04:11). The wrongly minted span is
// deleted when the closed event lands.
test("merge reconciliation: Bot merge-push minted before PR closed gets unminted", async () => {
  await H.beacon(H.T("09:00"));
  await H.push("d-merge", H.T("09:30"), { branch: "main", head_sha: "MSHA" });
  await postPushCapture("d-merge");
  assert.equal((await H.spans()).length, 1); // minted as direct_push (PR not known yet)

  await H.prRow({
    id: 100, branch: "feature-x", state: "closed", merged: 1,
    opened_at: H.T("08:00"), merged_at: H.T("09:30"), closed_at: H.T("09:30"),
    merge_commit_sha: "MSHA",
  });
  await onPullRequestWebhook({
    action: "closed",
    repository: { id: 1 },
    pull_request: { id: 100, merged: true, merge_commit_sha: "MSHA", head: { ref: "feature-x" } },
  });
  assert.equal((await H.spans()).length, 0); // converged with what remint would produce

  // ...and the mint-time flag (direct_push) must be cleared too, else live diverges from
  // remint, which rebuilds capture_flags from scratch. Snapshot must match a fresh remint.
  assert.ok(
    !(await H.flagKinds()).includes("direct_push"),
    "stray direct_push flag left behind after reconcile",
  );
  const live = await H.snapshot();
  await remintAll();
  assert.equal(await H.snapshot(), live); // live == remint: spans AND capture_flags
});

// §5.1 attribution — several keys in the window disambiguate via author_emails;
// still ambiguous -> unattributed (member null, default_1, flagged).
test("attribution: two keys resolve via author_emails; ambiguous -> unattributed", async () => {
  await H.seedKey("dev2@local", "e8k_test0002");
  await H.beacon(H.T("09:00"), { key: "e8k_test0001" });
  await H.beacon(H.T("09:10"), { key: "e8k_test0002" });

  await H.push("d1", H.T("10:00"), { author_emails: ["dev2@local"] });
  await mintForDelivery("d1");
  assert.equal((await H.spans())[0].member, "dev2@local");

  await H.push("d2", H.T("10:30"), { author_emails: ["nobody@nowhere"] });
  await mintForDelivery("d2");
  const d2 = (await H.spans()).find((s) => s.delivery_id === "d2");
  assert.equal(d2.member, null);
  assert.equal(d2.rule, "default_1");
  assert.ok((await H.flagKinds()).includes("unattributed_push"));
});
