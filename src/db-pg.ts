import postgres from "postgres";
import { clean, type Dbx } from "./dbx.js";

// Production backend: Supabase Postgres via the transaction pooler (port 6543).
// All tracker tables live in the dedicated schema "tracker" — the shared database
// has unrelated tables in public, so every table name is explicitly qualified here
// (NOT via search_path: if search_path were silently dropped by a pooler, queries
// could hit same-named public tables — e.g. a pre-existing public.projects).

const TABLES = [
  "webhook_deliveries",
  "git_access_events",
  "app_installations",
  "push_events",
  "pull_requests",
  "engineer_keys",
  "work_spans",
  "capture_flags",
  "projects",
  "app_tokens",
];
const TABLE_RE = new RegExp(`\\b(?<!\\.)(${TABLES.join("|")})\\b`, "g");
const qualify = (sql: string): string => sql.replace(TABLE_RE, "tracker.$1");

// '?' placeholders -> $1..$n (none of our SQL contains a literal '?')
const toPg = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

export function createPg(url: string): Dbx {
  // Supabase (cloud) requires TLS; a local Docker Postgres does not (and would
  // reject it). Decide from the host so the same code works in both places.
  const isLocal = /@(?:localhost|127\.0\.0\.1|\[?::1\]?)[:/]/.test(url);
  const sql = postgres(url, {
    prepare: false, // required in transaction-pooling mode (Supavisor)
    ssl: isLocal ? undefined : "require",
    max: 3, // serverless: keep the per-instance pool tiny
    types: {
      // GitHub ids fit in 2^53 — read int8 as a JS number, not a string
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
  console.log("[db] postgres (schema tracker)");
  const prep = (q: string) => toPg(qualify(q));
  return {
    kind: "postgres",
    async run(q, ...params) {
      await sql.unsafe(prep(q), params.map(clean) as any[]);
    },
    async get(q, ...params) {
      const rows = await sql.unsafe(prep(q), params.map(clean) as any[]);
      return rows[0] as any;
    },
    async all(q, ...params) {
      return (await sql.unsafe(prep(q), params.map(clean) as any[])) as any[];
    },
    async exec(q) {
      await sql.unsafe(qualify(q));
    },
    async tables() {
      const rows = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'tracker' ORDER BY table_name`;
      return rows.map((r: any) => r.table_name);
    },
  };
}
