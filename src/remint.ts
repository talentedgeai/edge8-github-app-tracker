import "./env.js";
import { pathToFileURL } from "node:url";
import { db } from "./db.js";
import { mintForDelivery } from "./mint.js";
import { orphanSweep, pairRepoBranch } from "./pairing.js";
import { toMs } from "./time.js";

// The mint-engine twin of reparse.ts (brief §8): clear work_spans + capture_flags and
// re-run attribution -> mint -> pairing -> classification over ALL history in event
// order. Every write keys on a natural id, so a second run is a no-op diff.
export async function remintAll(): Promise<{
  pushes: number;
  spans: number;
  flags: number;
}> {
  await db.run(`DELETE FROM work_spans`);
  await db.run(`DELETE FROM capture_flags`);
  await db.run(`UPDATE pull_requests SET author_member = NULL, orphaned = 0`);

  const pushes = await db.all(
    `SELECT delivery_id, repo_id, branch, pushed_at FROM push_events`,
  );
  pushes.sort((a, b) => toMs(a.pushed_at) - toMs(b.pushed_at));

  for (const p of pushes) await mintForDelivery(p.delivery_id);

  const branches = new Map<string, { repo_id: number; branch: string }>();
  for (const p of pushes) {
    if (p.repo_id != null) branches.set(`${p.repo_id}/${p.branch}`, p);
  }
  for (const b of branches.values()) await pairRepoBranch(b.repo_id, b.branch);
  await orphanSweep();

  const spans = (await db.get(`SELECT COUNT(*) AS c FROM work_spans`)).c;
  const flags = (await db.get(`SELECT COUNT(*) AS c FROM capture_flags`)).c;
  return { pushes: pushes.length, spans: Number(spans), flags: Number(flags) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await remintAll();
  console.log(
    `[remint] ${r.pushes} pushes -> ${r.spans} work_spans, ${r.flags} capture_flags`,
  );
  process.exit(0);
}
