import { db } from "./db.js";
import { HOURS_24, toMs, tokensFor } from "./time.js";
import { raiseFlag } from "./flags.js";
import { classify } from "./classify.js";
import { choosePrForSpan, orphanSweep, pairRepoBranch } from "./pairing.js";

// The mint engine (brief §5). A pure module: reads ONLY the event tables
// (git_access_events, push_events joined to webhook_deliveries), writes ONLY
// work_spans + capture_flags (+ the projects stub). Runs from the webhook handler
// right after a push is parsed AND from the remint script — same function, same result.

type PushRow = {
  delivery_id: string;
  repo_id: number;
  repo_full: string;
  branch: string;
  head_sha: string | null;
  sender_type: string | null;
  author_emails: string | null;
  pushed_at: string; // H1: the webhook received_at, set by parse.ts
};

const normRepo = (p: string | null): string =>
  (p ?? "").toLowerCase().replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");

async function getPush(deliveryId: string): Promise<PushRow | null> {
  return (
    ((await db.get(
      `SELECT * FROM push_events WHERE delivery_id = ?`,
      deliveryId,
    )) as PushRow | undefined) ?? null
  );
}

async function payloadOf(deliveryId: string): Promise<any | null> {
  const row = await db.get(
    `SELECT payload FROM webhook_deliveries WHERE delivery_id = ?`,
    deliveryId,
  );
  try {
    return row ? JSON.parse(row.payload) : null;
  } catch {
    return null;
  }
}

async function ensureProject(push: PushRow): Promise<void> {
  const defBranch =
    (await payloadOf(push.delivery_id))?.repository?.default_branch ?? "main";
  await db.run(
    `INSERT INTO projects (repo_id, repo_full, phase, default_branch)
     VALUES (?,?, 'build', ?) ON CONFLICT (repo_id) DO NOTHING`,
    push.repo_id,
    push.repo_full ?? null,
    defBranch,
  );
}

async function getProject(
  repoId: number,
): Promise<{ phase: string; default_branch: string }> {
  const p = await db.get(
    `SELECT phase, default_branch FROM projects WHERE repo_id = ?`,
    repoId,
  );
  return p ?? { phase: "build", default_branch: "main" };
}

// Access events for this repo within the 24h attribution window, mapped to members.
async function accessInWindow(
  push: PushRow,
  pushMs: number,
): Promise<Array<{ key_id: string; member: string | null; ms: number }>> {
  const keyMember = new Map<string, string>(
    (await db.all(`SELECT key_id, member FROM engineer_keys`)).map((r) => [
      r.key_id,
      r.member,
    ]),
  );
  const events = await db.all(
    `SELECT key_id, observed_at, repo_path FROM git_access_events`,
  );
  return events
    .filter((e) => normRepo(e.repo_path) === normRepo(push.repo_full))
    .map((e) => ({
      key_id: e.key_id,
      member: keyMember.get(e.key_id) ?? null,
      ms: toMs(e.observed_at),
    }))
    .filter(
      (e) => Number.isFinite(e.ms) && e.ms <= pushMs && pushMs - e.ms <= HOURS_24,
    );
}

// Resolve a set of candidate members to exactly one, or null (still ambiguous).
function disambiguate(members: string[], push: PushRow): string | null {
  if (members.length === 1) return members[0];
  if (members.length > 1) {
    const emails = new Set<string>(JSON.parse(push.author_emails ?? "[]"));
    const hits = members.filter((m) => emails.has(m));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// §5.1 — whose push is this? (caller has already established sender_type === 'Bot')
// The 24h TTL belongs to the CLOCK (priorBoundary), not to identity: the DoD requires
// a stale-beacon / no-beacon push to mint default_1 WITH no_clock_start, which needs a
// member. So when the 24h window is empty we fall back to older access events for the
// repo, then to "exactly one active engineer key" (the single-engineer draft case).
export async function attribute(
  push: PushRow,
  pushMs: number,
): Promise<string | null> {
  const window = await accessInWindow(push, pushMs);
  if (window.length) {
    const members = [
      ...new Set(window.map((e) => e.member).filter(Boolean)),
    ] as string[];
    return disambiguate(members, push);
  }
  const keyMember = new Map<string, string>(
    (await db.all(`SELECT key_id, member FROM engineer_keys`)).map((r) => [
      r.key_id,
      r.member,
    ]),
  );
  const past = (
    await db.all(`SELECT key_id, observed_at, repo_path FROM git_access_events`)
  )
    .filter((e) => normRepo(e.repo_path) === normRepo(push.repo_full))
    .filter((e) => {
      const ms = toMs(e.observed_at);
      return Number.isFinite(ms) && ms <= pushMs;
    });
  if (past.length) {
    const members = [
      ...new Set(past.map((e) => keyMember.get(e.key_id)).filter(Boolean)),
    ] as string[];
    const hit = disambiguate(members, push);
    if (hit) return hit;
  }
  const active = await db.all(
    `SELECT DISTINCT member FROM engineer_keys WHERE status = 'active'`,
  );
  if (active.length === 1) return active[0].member;
  return null; // none, or still ambiguous
}

// §5.3 — a push whose head is a merged PR's merge commit is a merge, not new work.
async function isMergePush(push: PushRow): Promise<boolean> {
  if (!push.head_sha) return false;
  const row = await db.get(
    `SELECT 1 AS x FROM pull_requests
     WHERE repo_id = ? AND merged = 1 AND merge_commit_sha = ?`,
    push.repo_id,
    push.head_sha,
  );
  return !!row;
}

// §5.2 — the previous mint boundary for (member, repo): the latest prior span_end if
// it is fresh (<= 24h), else the earliest access event AFTER that boundary within TTL.
async function priorBoundary(
  member: string,
  push: PushRow,
  pushMs: number,
): Promise<number | null> {
  const ends = (
    await db.all(
      `SELECT span_end FROM work_spans
       WHERE repo_id = ? AND member IS NOT DISTINCT FROM ? AND delivery_id != ?`,
      push.repo_id,
      member,
      push.delivery_id,
    )
  )
    .map((r) => toMs(r.span_end))
    .filter((m) => Number.isFinite(m) && m <= pushMs);
  const prevEnd = ends.length ? Math.max(...ends) : null;
  if (prevEnd !== null && pushMs - prevEnd <= HOURS_24) return prevEnd;

  const fresh = (await accessInWindow(push, pushMs))
    .filter((e) => e.member === member)
    .map((e) => e.ms)
    .filter((ms) => prevEnd === null || ms > prevEnd);
  return fresh.length ? Math.min(...fresh) : null;
}

// Replay-safe upsert. UNIQUE(delivery_id, member) treats NULL members as distinct on
// both backends, so delete-then-insert (null-safe compare) is the idempotent form.
async function upsertSpan(s: {
  delivery_id: string;
  member: string | null;
  repo_id: number;
  branch: string;
  span_start: string | null;
  span_end: string;
  tokens: number;
  rule: string;
  token_class: string;
  class_source: string;
  pull_request_id: number | null;
  flags: string[];
}): Promise<void> {
  await db.run(
    `DELETE FROM work_spans WHERE delivery_id = ? AND member IS NOT DISTINCT FROM ?`,
    s.delivery_id,
    s.member,
  );
  await db.run(
    `INSERT INTO work_spans
      (delivery_id, member, repo_id, branch, span_start, span_end, tokens, rule,
       token_class, class_source, pull_request_id, flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    s.delivery_id,
    s.member,
    s.repo_id,
    s.branch,
    s.span_start,
    s.span_end,
    s.tokens,
    s.rule,
    s.token_class,
    s.class_source,
    s.pull_request_id,
    JSON.stringify(s.flags),
  );
}

export async function mintForDelivery(deliveryId: string): Promise<void> {
  const push = await getPush(deliveryId);
  if (!push || push.repo_id == null) return;
  const pushMs = toMs(push.pushed_at);
  if (!Number.isFinite(pushMs)) return;

  await ensureProject(push);
  const project = await getProject(push.repo_id);
  const toDefault = push.branch === project.default_branch;

  // §5.3 merge carve-out — the work was already minted on the feature branch.
  // DELETE converges live with remint if this delivery was minted before the PR closed.
  if (toDefault && (await isMergePush(push))) {
    await db.run(`DELETE FROM work_spans WHERE delivery_id = ?`, deliveryId);
    return;
  }
  // §5.1 — a User push is a client-side engineer: recorded (push_events), never minted.
  if (push.sender_type !== "Bot") return;

  const member = await attribute(push, pushMs);
  const flags: string[] = [];
  let rule = toDefault ? "direct_push" : "span"; // S7: genuine push straight to main
  let spanStart: string | null = null;
  let tokens: number;

  if (member === null) {
    flags.push("unattributed_push");
    await raiseFlag("unattributed_push", push.repo_id, { delivery: deliveryId });
  }
  const prior =
    member === null ? null : await priorBoundary(member, push, pushMs);
  if (prior === null) {
    tokens = 1.0; // S1: no clock start (or the beacon expired past 24h)
    rule = "default_1";
    if (member !== null) {
      flags.push("no_clock_start");
      await raiseFlag("no_clock_start", push.repo_id, {
        delivery: deliveryId,
        member,
      });
    }
  } else {
    spanStart = new Date(prior).toISOString();
    tokens = tokensFor(prior, pushMs); // six-minute tenths, floor 0.1 (S2)
  }

  // §7 — classify eagerly; pairing re-classifies once the PR (and labels) are known.
  const pr = await choosePrForSpan(push.repo_id, push.branch, pushMs);
  const cls = classify({
    branch: push.branch,
    prLabels: pr ? JSON.parse(pr.labels ?? "[]") : null,
    projectPhase: project.phase,
  });
  if (cls.ambiguous) {
    flags.push("ambiguous_class");
    await raiseFlag("ambiguous_class", push.repo_id, {
      delivery: deliveryId,
      member,
    });
  }
  if (rule === "direct_push") {
    flags.push("direct_push");
    await raiseFlag("direct_push", push.repo_id, { delivery: deliveryId, member });
  }

  await upsertSpan({
    delivery_id: deliveryId,
    member,
    repo_id: push.repo_id,
    branch: push.branch,
    span_start: spanStart,
    span_end: push.pushed_at,
    tokens,
    rule,
    token_class: cls.token_class,
    class_source: cls.class_source,
    pull_request_id: pr?.github_pr_id ?? null,
    flags,
  });
}

// Live path: called by the webhook handler after a push is parsed.
// Pairing runs after every mint (brief §6) — a span can arrive before or after its PR.
export async function postPushCapture(deliveryId: string): Promise<void> {
  await mintForDelivery(deliveryId);
  const push = await getPush(deliveryId);
  if (push && push.repo_id != null) {
    await pairRepoBranch(push.repo_id, push.branch);
    await orphanSweep();
  }
}
