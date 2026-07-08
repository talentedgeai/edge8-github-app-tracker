import "../src/env.js";
import { db } from "../src/db.js";

// Prove the configured backend accepts writes into schema tracker.
// Reads TRACKER_DB_URL from .env (never printed). Insert -> read -> delete a throwaway
// row so nothing is left behind. Run: npm run verify-db
const url = process.env.TRACKER_DB_URL ?? "";
if (!url) {
  console.error("TRACKER_DB_URL is not set — add it to .env first.");
  process.exit(1);
}
const host = url.match(/@([^/:]+)/)?.[1] ?? "?"; // host only, no credentials
console.log(`backend: ${db.kind} | host: ${host}`);
if (db.kind !== "postgres") {
  console.error("Not pointing at Postgres — check TRACKER_DB_URL.");
  process.exit(1);
}

const tables = await db.tables();
console.log(`tracker tables (${tables.length}): ${tables.join(", ")}`);
if (tables.length < 10) {
  console.error("Expected 10 tracker tables — did the migration run on this DB?");
  process.exit(1);
}

const id = `verify-${Date.now()}`;
await db.run(
  `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, headers)
   VALUES (?,?,?,?,?) ON CONFLICT (delivery_id) DO NOTHING`,
  id,
  "verify_ping",
  null,
  "{}",
  "{}",
);
const back = await db.get(
  `SELECT delivery_id, received_at FROM webhook_deliveries WHERE delivery_id = ?`,
  id,
);
console.log("insert + read:", back ? `OK (received_at=${back.received_at})` : "FAILED");
await db.run(`DELETE FROM webhook_deliveries WHERE delivery_id = ?`, id);
const gone = await db.get(
  `SELECT 1 AS x FROM webhook_deliveries WHERE delivery_id = ?`,
  id,
);
console.log("cleanup:", gone ? "RESIDUE LEFT!" : "removed");

const pass = back && !gone;
console.log(
  pass
    ? "\nVERIFY: PASS — cloud DB accepts inserts into schema tracker ✓"
    : "\nVERIFY: FAIL",
);
process.exit(pass ? 0 : 1);
