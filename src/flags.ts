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
