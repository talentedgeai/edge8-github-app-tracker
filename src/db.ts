import type { Dbx } from "./dbx.js";

// Backend selection: TRACKER_DB_URL set -> Supabase Postgres (schema "tracker");
// otherwise local SQLite at DB_PATH. Dynamic imports keep the unused driver out of
// the bundle (node:sqlite is not available on every runtime).
async function create(): Promise<Dbx> {
  const url = process.env.TRACKER_DB_URL;
  if (url) return (await import("./db-pg.js")).createPg(url);
  const { createSqlite } = await import("./db-sqlite.js");
  return createSqlite(process.env.DB_PATH ?? "data/capture.db");
}

export const db: Dbx = await create();
