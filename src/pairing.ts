import { db } from "./db.js";
import { toMs } from "./time.js";
import { raiseFlag } from "./flags.js";
import { classify } from "./classify.js";

// Pairing (brief §6): attach spans to the PR they belong to.
// PRs on a branch are ordered by CLOSE instant (an open PR sorts LAST) so a reused
// branch never lets the still-open PR swallow an earlier PR's spans.
//
// Deviation from the brief's literal window (documented in phase-2-plan.md): our real
// fixture shows branch pushes land BEFORE the PR opens (push 08:01:27, PR opened
// 08:03:13), so requiring opened_at <= span_end would orphan normal work. Rule here:
// a span belongs to the first close-ordered PR that closed at-or-after span_end
// (or is still open). Reused-branch behaviour is identical to the brief's.

const closeInstant = (pr: any): number => {
  const t = pr.closed_at ?? pr.merged_at;
  return t ? toMs(t) : Infinity; // open PR -> +infinity -> sorts last
};

export async function choosePrForSpan(
  repoId: number,
  branch: string,
  spanEndMs: number,
): Promise<any | null> {
  const prs = await db.all(
    `SELECT * FROM pull_requests WHERE repo_id = ? AND branch = ?`,
    repoId,
    branch,
  );
  const sorted = prs.sort(
    (a, b) =>
      closeInstant(a) - closeInstant(b) ||
      toMs(a.opened_at ?? "") - toMs(b.opened_at ?? ""),
  );
  return (
    sorted.find(
      (pr) => closeInstant(pr) === Infinity || spanEndMs <= closeInstant(pr),
    ) ?? null
  );
}

async function projectPhaseOf(repoId: number): Promise<string> {
  const p = await db.get(`SELECT phase FROM projects WHERE repo_id = ?`, repoId);
  return p?.phase ?? "build";
}

// Re-derive token_class/class_source for one span (its PR may have arrived after mint).
export async function reclassifySpan(spanId: number): Promise<void> {
  const s = await db.get(`SELECT * FROM work_spans WHERE id = ?`, spanId);
  if (!s) return;
  const pr = s.pull_request_id
    ? await db.get(
        `SELECT * FROM pull_requests WHERE github_pr_id = ?`,
        s.pull_request_id,
      )
    : null;
  const cls = classify({
    branch: s.branch,
    prLabels: pr ? JSON.parse(pr.labels ?? "[]") : null,
    projectPhase: await projectPhaseOf(s.repo_id),
  });
  const flags: string[] = JSON.parse(s.flags ?? "[]").filter(
    (f: string) => f !== "ambiguous_class",
  );
  if (cls.ambiguous) {
    flags.push("ambiguous_class");
    await raiseFlag("ambiguous_class", s.repo_id, {
      delivery: s.delivery_id,
      member: s.member,
    });
  }
  await db.run(
    `UPDATE work_spans SET token_class = ?, class_source = ?, flags = ? WHERE id = ?`,
    cls.token_class,
    cls.class_source,
    JSON.stringify(flags),
    spanId,
  );
}

export async function pairRepoBranch(
  repoId: number,
  branch: string,
): Promise<void> {
  // Attach unpaired spans on this branch.
  const unpaired = await db.all(
    `SELECT id, span_end FROM work_spans
     WHERE repo_id = ? AND branch = ? AND pull_request_id IS NULL`,
    repoId,
    branch,
  );
  for (const s of unpaired) {
    const pr = await choosePrForSpan(repoId, branch, toMs(s.span_end));
    if (pr) {
      await db.run(
        `UPDATE work_spans SET pull_request_id = ? WHERE id = ?`,
        pr.github_pr_id,
        s.id,
      );
    }
  }
  // Refresh classification for every span on the branch (labels may have changed).
  const all = await db.all(
    `SELECT id FROM work_spans WHERE repo_id = ? AND branch = ?`,
    repoId,
    branch,
  );
  for (const s of all) await reclassifySpan(s.id);
}

const isBotLogin = (login: string | null): boolean =>
  !login || /\[bot\]$/i.test(login);

// author_block is "handle email ..." free text; resolve to an engineer_keys.member
// when one of its tokens matches, otherwise keep the raw block.
export async function resolveAuthorMember(pr: any): Promise<string | null> {
  if (!pr.author_block) return null;
  const tokens = String(pr.author_block).trim().split(/\s+/);
  const members = (
    await db.all(`SELECT DISTINCT member FROM engineer_keys`)
  ).map((r) => r.member as string);
  return members.find((m) => tokens.includes(m)) ?? pr.author_block;
}

// Orphan sweep (brief §6): a merged PR by a real (non-bot) author with zero paired
// spans is delivered work with no capture — flag loudly. Open PRs are not judged yet.
export async function orphanSweep(): Promise<void> {
  const prs = await db.all(`SELECT * FROM pull_requests`);
  for (const pr of prs) {
    const author = await resolveAuthorMember(pr);
    if (!pr.author_block && !isBotLogin(pr.user_login)) {
      await raiseFlag("missing_author_block", pr.repo_id, { pr: pr.github_pr_id });
    }
    const n = (
      await db.get(
        `SELECT COUNT(*) AS c FROM work_spans WHERE pull_request_id = ?`,
        pr.github_pr_id,
      )
    ).c;
    const orphaned =
      pr.merged === 1 && Number(n) === 0 && !isBotLogin(pr.user_login) ? 1 : 0;
    if (orphaned)
      await raiseFlag("orphaned_pr", pr.repo_id, { pr: pr.github_pr_id });
    await db.run(
      `UPDATE pull_requests SET author_member = ?, orphaned = ? WHERE github_pr_id = ?`,
      author,
      orphaned,
      pr.github_pr_id,
    );
  }
}

// Called on every pull_request webhook (brief §6). Also reconciles the merge
// carve-out (§5.3): the merge push usually arrives BEFORE this closed event (our
// fixture: push 08:04:10, closed 08:04:11) and may have minted as direct_push —
// delete any span minted for the merge commit so live converges with remint.
export async function onPullRequestWebhook(p: any): Promise<void> {
  const pr = p?.pull_request;
  const repoId = p?.repository?.id;
  if (!pr || repoId == null) return;
  if (p.action === "closed" && pr.merged && pr.merge_commit_sha) {
    const pushes = await db.all(
      `SELECT delivery_id FROM push_events WHERE repo_id = ? AND head_sha = ?`,
      repoId,
      pr.merge_commit_sha,
    );
    for (const row of pushes) {
      await db.run(
        `DELETE FROM work_spans WHERE delivery_id = ?`,
        row.delivery_id,
      );
    }
  }
  await pairRepoBranch(repoId, pr.head?.ref ?? "");
  await orphanSweep();
}
