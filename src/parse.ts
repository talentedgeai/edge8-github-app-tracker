import { db } from "./db.js";

// Idempotent parsers: raw delivery -> structured tables.
// Standard-SQL upserts (ON CONFLICT ...) run identically on SQLite and Postgres,
// so parsing is re-runnable against the raw log on either backend with no data loss.

// Server-side instants come from the delivery's received_at (not new Date()) so a
// reparse converges to byte-identical rows.
async function deliveryReceivedAt(id: string): Promise<string | null> {
  const row = await db.get(
    `SELECT received_at FROM webhook_deliveries WHERE delivery_id = ?`,
    id,
  );
  return row?.received_at ?? null;
}

export async function parseDelivery(
  id: string,
  evt: string,
  p: any,
): Promise<void> {
  switch (evt) {
    case "push": {
      // Malformed/partial payload: nothing to derive — the raw row is already safe.
      if (p?.repository?.id == null || p?.after == null) break;
      const commits: any[] = p.commits ?? [];
      const emails = [
        ...new Set(commits.map((c) => c?.author?.email).filter(Boolean)),
      ];
      // H1: the mint instant is when the push LANDED (webhook receipt) — the head
      // commit's timestamp is the *authoring* time and can predate the push by hours.
      const pushedAt =
        (await deliveryReceivedAt(id)) ??
        p.head_commit?.timestamp ??
        new Date().toISOString();
      await db.run(
        `INSERT INTO push_events
          (delivery_id, repo_id, repo_full, ref, branch, before_sha, head_sha, forced,
           sender_login, sender_type, commit_count, commits_truncated, author_emails,
           pushed_at, authored_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (delivery_id) DO UPDATE SET
           repo_id = excluded.repo_id, repo_full = excluded.repo_full,
           ref = excluded.ref, branch = excluded.branch,
           before_sha = excluded.before_sha, head_sha = excluded.head_sha,
           forced = excluded.forced, sender_login = excluded.sender_login,
           sender_type = excluded.sender_type, commit_count = excluded.commit_count,
           commits_truncated = excluded.commits_truncated,
           author_emails = excluded.author_emails,
           pushed_at = excluded.pushed_at, authored_at = excluded.authored_at`,
        id,
        p.repository.id,
        p.repository?.full_name ?? null,
        p.ref ?? null,
        (p.ref ?? "").replace("refs/heads/", ""),
        p.before ?? null,
        p.after,
        p.forced ? 1 : 0,
        p.sender?.login ?? null,
        p.sender?.type ?? null,
        commits.length,
        // GitHub sends at most 20 commits per push — flag when there were more.
        commits.length >= 20 ? 1 : 0,
        JSON.stringify(emails),
        pushedAt,
        p.head_commit?.timestamp ?? null,
      );
      break;
    }
    case "pull_request": {
      const pr = p.pull_request ?? {};
      if (pr.id == null || p?.repository?.id == null) break; // nothing to derive
      const m = /<!--\s*author:\s*(.+?)\s*-->/.exec(pr.body ?? "");
      // author_member / orphaned are DERIVED (pairing writes them) — the upsert
      // deliberately leaves them untouched so a later PR webhook can't clobber them.
      await db.run(
        `INSERT INTO pull_requests
          (github_pr_id, repo_id, number, title, branch, base_branch, state, merged,
           labels, author_block, user_login, opened_at, merged_at, closed_at, raw,
           merge_commit_sha)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (github_pr_id) DO UPDATE SET
           repo_id = excluded.repo_id, number = excluded.number,
           title = excluded.title, branch = excluded.branch,
           base_branch = excluded.base_branch, state = excluded.state,
           merged = excluded.merged, labels = excluded.labels,
           author_block = excluded.author_block, user_login = excluded.user_login,
           opened_at = excluded.opened_at, merged_at = excluded.merged_at,
           closed_at = excluded.closed_at, raw = excluded.raw,
           merge_commit_sha = excluded.merge_commit_sha`,
        pr.id,
        p.repository.id,
        pr.number ?? null,
        pr.title ?? null,
        pr.head?.ref ?? null,
        pr.base?.ref ?? null,
        pr.state ?? null,
        pr.merged ? 1 : 0,
        JSON.stringify((pr.labels ?? []).map((l: any) => l.name)),
        m?.[1] ?? null,
        pr.user?.login ?? null,
        pr.created_at ?? null,
        pr.merged_at ?? null,
        pr.closed_at ?? null,
        JSON.stringify(pr),
        pr.merge_commit_sha ?? null,
      );
      break;
    }
    case "installation":
    case "installation_repositories": {
      const inst = p.installation ?? {};
      if (inst.id == null) break; // nothing to derive
      const prev = await db.get(
        `SELECT * FROM app_installations WHERE installation_id = ?`,
        inst.id,
      );
      // H2: installation_repositories events carry only a DELTA — merge with the
      // existing set instead of clobbering it.
      let repoIds: number[] = prev ? JSON.parse(prev.repo_ids ?? "[]") : [];
      if (evt === "installation") {
        // suspend/unsuspend payloads often omit repositories — keep the known set then.
        if (p.repositories) repoIds = p.repositories.map((r: any) => r.id);
      } else {
        const added = (p.repositories_added ?? []).map((r: any) => r.id);
        const removed = new Set(
          (p.repositories_removed ?? []).map((r: any) => r.id),
        );
        repoIds = [...new Set([...repoIds, ...added])].filter(
          (x) => !removed.has(x),
        );
      }
      // H3: track suspend state; deleted stays the kill switch.
      const at = (await deliveryReceivedAt(id)) ?? new Date().toISOString();
      let suspendedAt: string | null = prev?.suspended_at ?? null;
      if (p.action === "suspend") suspendedAt = inst.suspended_at ?? at;
      if (p.action === "unsuspend") suspendedAt = null;
      let deletedAt: string | null = prev?.deleted_at ?? null;
      if (p.action === "deleted") deletedAt = at;
      if (p.action === "created") deletedAt = null;
      await db.run(
        `INSERT INTO app_installations
          (installation_id, account_login, account_type, repo_ids, created_at,
           suspended_at, deleted_at, raw)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (installation_id) DO UPDATE SET
           account_login = excluded.account_login,
           account_type = excluded.account_type, repo_ids = excluded.repo_ids,
           created_at = excluded.created_at, suspended_at = excluded.suspended_at,
           deleted_at = excluded.deleted_at, raw = excluded.raw`,
        inst.id,
        inst.account?.login ?? null,
        inst.account?.type ?? null,
        JSON.stringify(repoIds),
        inst.created_at ?? prev?.created_at ?? null,
        suspendedAt,
        deletedAt,
        JSON.stringify(p),
      );
      break;
    }
    // Any other event: raw is already stored; nothing to derive yet. That is fine.
  }
  await db.run(
    `UPDATE webhook_deliveries SET parsed_at = ? WHERE delivery_id = ?`,
    new Date().toISOString(),
    id,
  );
}
