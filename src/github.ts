import { createAppAuth } from "@octokit/auth-app";
import fs from "node:fs";
import { db } from "./db.js";

// GitHub App auth. The private key comes from the GITHUB_APP_PRIVATE_KEY env var
// (Vercel — the full PEM content, \n-escaped allowed) or PRIVATE_KEY_PATH (local file).
function privateKey(): string {
  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  const p = process.env.PRIVATE_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  throw new Error(
    "GitHub App not configured — set GITHUB_APP_PRIVATE_KEY (PEM content) or PRIVATE_KEY_PATH",
  );
}

// Map "owner/name(.git)" -> the installation that covers that repo.
// Precise path: the repo is already known (projects row from a past webhook) and its
// numeric id appears in an installation's repo_ids. Fallback: match by owner account
// (covers the first-ever clone, before any webhook has landed for the repo).
export async function installationForRepoPath(
  repoPath: string,
): Promise<any | null> {
  const norm = (repoPath ?? "").toLowerCase().replace(/\.git$/, "");
  const owner = norm.split("/")[0];
  if (!owner) return null;

  const proj = await db.get(
    `SELECT repo_id FROM projects WHERE lower(repo_full) = ?`,
    norm,
  );
  if (proj) {
    const insts = await db.all(
      `SELECT * FROM app_installations WHERE deleted_at IS NULL`,
    );
    const hit = insts.find((i) => {
      try {
        return JSON.parse(i.repo_ids ?? "[]").includes(Number(proj.repo_id));
      } catch {
        return false;
      }
    });
    if (hit) return hit;
  }
  return (
    (await db.get(
      `SELECT * FROM app_installations
       WHERE lower(account_login) = ? AND deleted_at IS NULL
       ORDER BY installation_id LIMIT 1`,
      owner,
    )) ?? null
  );
}

// Sign an RS256 JWT with the App key and exchange it for a 60-minute installation
// token. Serverless is stateless, so tokens are cached in the app_tokens table and
// reused until < 5 minutes of life remain.
export async function mintInstallationToken(
  installationId: number,
): Promise<{ token: string; expiresAt: string }> {
  const cached = await db.get(
    `SELECT token, expires_at FROM app_tokens WHERE installation_id = ?`,
    installationId,
  );
  if (cached && Date.parse(cached.expires_at) - Date.now() > 5 * 60_000) {
    return { token: cached.token, expiresAt: cached.expires_at };
  }
  const auth = createAppAuth({
    appId: process.env.APP_ID!,
    privateKey: privateKey(),
  });
  const res = await auth({ type: "installation", installationId });
  await db.run(
    `INSERT INTO app_tokens (installation_id, token, expires_at)
     VALUES (?,?,?)
     ON CONFLICT (installation_id) DO UPDATE SET
       token = excluded.token, expires_at = excluded.expires_at`,
    installationId,
    res.token,
    res.expiresAt,
  );
  return { token: res.token, expiresAt: res.expiresAt };
}
