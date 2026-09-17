// Test helpers. IMPORTANT: the test file must set process.env.DB_PATH BEFORE
// dynamically importing this module — we wipe the file, then import src/db (which
// opens the backend at that path and creates the schema).
import fs from "node:fs";

const dbPath = process.env.DB_PATH ?? "data/test.db";
if (!process.env.TRACKER_DB_URL) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

export const { db } = await import("../src/db");

const TABLES = [
  "work_spans",
  "capture_flags",
  "git_access_events",
  "push_events",
  "pull_requests",
  "app_installations",
  "webhook_deliveries",
  "engineer_keys",
  "projects",
  "app_tokens",
];

export async function wipe(): Promise<void> {
  for (const t of TABLES) await db.run(`DELETE FROM ${t}`);
}

// "2026-07-07T09:00:00Z"-style builder: T("09:00") / T("09:02", "06")
export const T = (hhmm: string, day = "07"): string =>
  `2026-07-${day}T${hhmm}:00Z`;

export async function seedKey(
  member = "dev@local",
  keyId = "e8k_test0001",
): Promise<void> {
  await db.run(
    `INSERT INTO engineer_keys (key_id, key_hash, member) VALUES (?,?,?)
     ON CONFLICT (key_id) DO NOTHING`,
    keyId,
    "test-hash",
    member,
  );
}

export async function beacon(
  observedAt: string,
  o: { repo?: string; key?: string; kind?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO git_access_events (key_id, repo_path, verb, kind, observed_at)
     VALUES (?,?,?,?,?)`,
    o.key ?? "e8k_test0001",
    o.repo ?? "acme/app.git",
    "pull",
    o.kind ?? "beacon",
    observedAt,
  );
}

export async function delivery(
  id: string,
  event: string,
  receivedAt: string,
  payload: any = { repository: { default_branch: "main" } },
): Promise<void> {
  await db.run(
    `INSERT INTO webhook_deliveries
      (delivery_id, event, action, payload, headers, received_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT (delivery_id) DO NOTHING`,
    id,
    event,
    payload.action ?? null,
    JSON.stringify(payload),
    "{}",
    receivedAt,
  );
}

export async function push(
  id: string,
  pushedAt: string,
  o: Partial<{
    repo_id: number;
    repo_full: string;
    branch: string;
    head_sha: string;
    sender_login: string;
    sender_type: string;
    forced: number;
    author_emails: string[];
  }> = {},
): Promise<void> {
  await delivery(id, "push", pushedAt);
  await db.run(
    `INSERT INTO push_events
      (delivery_id, repo_id, repo_full, ref, branch, before_sha, head_sha, forced,
       sender_login, sender_type, commit_count, commits_truncated, author_emails,
       pushed_at, authored_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (delivery_id) DO UPDATE SET pushed_at = excluded.pushed_at`,
    id,
    o.repo_id ?? 1,
    o.repo_full ?? "acme/app",
    `refs/heads/${o.branch ?? "feature-x"}`,
    o.branch ?? "feature-x",
    "before",
    o.head_sha ?? `sha-${id}`,
    o.forced ?? 0,
    // Default to the tracker's own bot: the only sender that mints (§5.1).
    o.sender_login ?? "edge8-github-app-tracker[bot]",
    o.sender_type ?? "Bot",
    1,
    0,
    JSON.stringify(o.author_emails ?? []),
    pushedAt,
    null,
  );
}

export async function prRow(
  o: Partial<{
    id: number;
    repo_id: number;
    number: number;
    branch: string;
    state: string;
    merged: number;
    labels: string[];
    author_block: string | null;
    user_login: string;
    opened_at: string;
    merged_at: string | null;
    closed_at: string | null;
    merge_commit_sha: string | null;
  }> = {},
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
      (github_pr_id, repo_id, number, title, branch, base_branch, state, merged,
       labels, author_block, user_login, opened_at, merged_at, closed_at, raw,
       merge_commit_sha, author_member, orphaned)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (github_pr_id) DO UPDATE SET
       state = excluded.state, merged = excluded.merged,
       merged_at = excluded.merged_at, closed_at = excluded.closed_at,
       merge_commit_sha = excluded.merge_commit_sha`,
    o.id ?? 100,
    o.repo_id ?? 1,
    o.number ?? 1,
    "test pr",
    o.branch ?? "feature-x",
    "main",
    o.state ?? "open",
    o.merged ?? 0,
    JSON.stringify(o.labels ?? []),
    o.author_block ?? null,
    o.user_login ?? "human-dev",
    o.opened_at ?? null,
    o.merged_at ?? null,
    o.closed_at ?? null,
    "{}",
    o.merge_commit_sha ?? null,
    null,
    0,
  );
}

export async function spans(): Promise<any[]> {
  return db.all(`SELECT * FROM work_spans ORDER BY id`);
}

export async function flagKinds(): Promise<string[]> {
  return (await db.all(`SELECT kind FROM capture_flags ORDER BY id`)).map(
    (r) => r.kind,
  );
}

// Idempotency snapshots exclude computed_at / raised_at (write-time metadata).
export async function snapshot(): Promise<string> {
  const s = await db.all(
    `SELECT delivery_id, member, repo_id, branch, span_start, span_end, tokens,
            rule, token_class, class_source, pull_request_id, flags
     FROM work_spans ORDER BY delivery_id, member`,
  );
  const f = await db.all(
    `SELECT kind, repo_id, ref FROM capture_flags ORDER BY kind, ref`,
  );
  const p = await db.all(
    `SELECT github_pr_id, author_member, orphaned FROM pull_requests ORDER BY github_pr_id`,
  );
  return JSON.stringify({ s, f, p });
}
