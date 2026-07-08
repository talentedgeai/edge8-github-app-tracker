import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { clean, type Dbx } from "./dbx.js";

// Local backend: node:sqlite (Node >= 22.5; stable on 26). Used for dev + tests.

const SCHEMA = `
-- THE RAW LOG. Every delivery, verbatim, never updated. Everything else is derived from this.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  action      TEXT,
  payload     TEXT NOT NULL,
  headers     TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  parsed_at   TEXT
);

-- Access events: every app-token call and every beacon. The second capture stream.
CREATE TABLE IF NOT EXISTS git_access_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      TEXT NOT NULL,
  repo_path   TEXT,
  verb        TEXT NOT NULL DEFAULT 'unknown',
  kind        TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw         TEXT
);

CREATE TABLE IF NOT EXISTS app_installations (
  installation_id INTEGER PRIMARY KEY,
  account_login   TEXT NOT NULL,
  account_type    TEXT,
  repo_ids        TEXT,
  created_at      TEXT,
  suspended_at    TEXT,
  deleted_at      TEXT,
  raw             TEXT
);

CREATE TABLE IF NOT EXISTS push_events (
  delivery_id       TEXT PRIMARY KEY REFERENCES webhook_deliveries(delivery_id),
  repo_id           INTEGER NOT NULL,
  repo_full         TEXT NOT NULL,
  ref               TEXT NOT NULL,
  branch            TEXT NOT NULL,
  before_sha        TEXT,
  head_sha          TEXT NOT NULL,
  forced            INTEGER NOT NULL DEFAULT 0,
  sender_login      TEXT,
  sender_type       TEXT,
  commit_count      INTEGER NOT NULL,
  commits_truncated INTEGER NOT NULL DEFAULT 0,
  author_emails     TEXT NOT NULL,
  pushed_at         TEXT NOT NULL,
  authored_at       TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
  github_pr_id INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT,
  branch       TEXT NOT NULL,
  base_branch  TEXT,
  state        TEXT NOT NULL,
  merged       INTEGER NOT NULL DEFAULT 0,
  labels       TEXT NOT NULL DEFAULT '[]',
  author_block TEXT,
  user_login   TEXT,
  opened_at    TEXT,
  merged_at    TEXT,
  closed_at    TEXT,
  raw          TEXT,
  merge_commit_sha TEXT,
  author_member    TEXT,
  orphaned         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS engineer_keys (
  key_id    TEXT PRIMARY KEY,
  key_hash  TEXT NOT NULL,
  member    TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Phase 2: derived tables, written ONLY by the mint engine =====

CREATE TABLE IF NOT EXISTS work_spans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id    TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
  member         TEXT,
  repo_id        INTEGER NOT NULL,
  branch         TEXT NOT NULL,
  span_start     TEXT,
  span_end       TEXT NOT NULL,
  tokens         REAL NOT NULL,
  rule           TEXT NOT NULL,
  token_class    TEXT NOT NULL,
  class_source   TEXT NOT NULL,
  pull_request_id INTEGER,
  flags          TEXT NOT NULL DEFAULT '[]',
  computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (delivery_id, member)
);

CREATE TABLE IF NOT EXISTS capture_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  repo_id     INTEGER,
  ref         TEXT NOT NULL DEFAULT '{}',
  raised_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE (kind, ref)
);

CREATE TABLE IF NOT EXISTS projects (
  repo_id        INTEGER PRIMARY KEY,
  repo_full      TEXT,
  phase          TEXT NOT NULL DEFAULT 'build',
  default_branch TEXT NOT NULL DEFAULT 'main',
  delivered_at   TEXT
);

-- Phase 3: installation-token cache (mirrors tracker.app_tokens on Postgres).
CREATE TABLE IF NOT EXISTS app_tokens (
  installation_id INTEGER PRIMARY KEY,
  token           TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function createSqlite(dbPath: string): Dbx {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);

  // Column extensions from older draft DBs (guarded ALTERs).
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r: any) => r.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumnIfMissing("pull_requests", "author_member", "author_member TEXT");
  addColumnIfMissing("pull_requests", "orphaned", "orphaned INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("pull_requests", "merge_commit_sha", "merge_commit_sha TEXT");
  addColumnIfMissing("push_events", "authored_at", "authored_at TEXT");

  console.log(`[db] sqlite ${dbPath}`);
  return {
    kind: "sqlite",
    async run(sql, ...params) {
      db.prepare(sql).run(...(params.map(clean) as any[]));
    },
    async get(sql, ...params) {
      return db.prepare(sql).get(...(params.map(clean) as any[])) as any;
    },
    async all(sql, ...params) {
      return db.prepare(sql).all(...(params.map(clean) as any[])) as any[];
    },
    async exec(sql) {
      db.exec(sql);
    },
    async tables() {
      return (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as any[]
      ).map((r) => r.name);
    },
  };
}
