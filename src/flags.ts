import { db } from "./db.js";

// Canonical JSON (sorted keys) so UNIQUE(kind, ref) really means
// "the same condition never raises twice".
function stableStringify(o: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) sorted[k] = o[k];
  return JSON.stringify(sorted);
}

export async function raiseFlag(
  kind: string,
  repoId: number | null,
  ref: Record<string, unknown>,
): Promise<void> {
  await db.run(
    `INSERT INTO capture_flags (kind, repo_id, ref) VALUES (?,?,?)
     ON CONFLICT (kind, ref) DO NOTHING`,
    kind,
    repoId,
    stableStringify(ref),
  );
}

// Clear the mint-time flags raised for one delivery (unattributed_push, no_clock_start,
// ambiguous_class, direct_push — all keyed with the delivery id in their ref). Called
// when a delivery is re-minted or reconciled away (merge carve-out) so live capture_flags
// converge with remint, which rebuilds every flag from scratch (§8/§10). PR-keyed flags
// (orphaned_pr, missing_author_block) carry no "delivery" and are left untouched.
export async function clearFlagsForDelivery(deliveryId: string): Promise<void> {
  await db.run(
    `DELETE FROM capture_flags WHERE ref LIKE ?`,
    `%"delivery":${JSON.stringify(deliveryId)}%`,
  );
}
