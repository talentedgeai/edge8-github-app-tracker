import "./env.js";
import { db } from "./db.js";
import { parseDelivery } from "./parse.js";

// Re-run the parser over the whole raw log. Proves the capture-first invariant:
// the parsed tables are recomputable from webhook_deliveries at any time.
const rows = await db.all(
  `SELECT delivery_id, event, payload FROM webhook_deliveries ORDER BY received_at`,
);

let ok = 0;
let failed = 0;
for (const r of rows) {
  try {
    await parseDelivery(r.delivery_id, r.event, JSON.parse(r.payload));
    ok++;
  } catch (err) {
    failed++;
    console.error("reparse failed for", r.delivery_id, err);
  }
}
console.log(`[reparse] ${ok} ok, ${failed} failed, over ${rows.length} deliveries`);
process.exit(failed ? 1 : 0);
