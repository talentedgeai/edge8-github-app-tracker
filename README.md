# edge8-tracker — GitHub work-tracking service

Tracks real engineering work from git activity. A GitHub App captures webhooks and a
credential helper on each engineer's machine mints short-lived access tokens; both streams
land in Postgres and are turned into **work spans** (six-minute tenths), paired to PRs and
classified — all recomputable from the raw event log.

> **👋 New engineer?** You do **not** clone this repo. Grab the CLI from the
> [**Releases**](https://github.com/talentedgeai/edge8-github-app-tracker/releases) page,
> install it, ask an admin for your key, run `tracker setup`. See **[Engineer setup](#engineer-setup)**.

Production: **Vercel** (Node serverless, `api/*`) + **Supabase Postgres** (schema `tracker`).
Base URL: `https://edge8-github-app-tracker-kappa.vercel.app`

```
engineer machine ── git pull/push ──► credential helper (~/.edge8) ──► POST /api/app-token ┐
GitHub App (All repositories) ── webhooks ─────────────────────────► POST /api/webhooks/github ├─► Supabase (schema tracker)
                                                                     POST /api/beacon           ┘
```

---

## Install the GitHub App
Once per **repository owner** (org or personal account) — not per repo, and not per engineer.
Coverage is owner-wide, so one install covers every repo under that owner.

> **Already covered:** repos under **`talentedgeai`**. You only need this for a repo under a
> **different** owner. Engineers setting up their own machine want
> **[Engineer setup](#engineer-setup)** instead — this section is not for them.

### Steps (browser only — nothing to install or configure locally)
1. Sign in to GitHub, then open **<https://github.com/apps/edge8-github-app-tracker>**
   (the App is public, so the page is reachable by anyone).
2. Click **Install** (top right).
3. Pick the target **org or user account**. GitHub only lists accounts you belong to.
4. Choose **All repositories** — new repos are then tracked automatically with no further
   action. (*Only select repositories* works, but someone must edit the list every time a
   repo is created.)
5. Confirm.

### What happens next depends on who clicked
| You are | What you see |
|---|---|
| Org **owner/admin** | Installs immediately — done, nothing else to do |
| Org **member**, not an owner | The button reads **Request**. Nothing installs yet: GitHub files an installation request and emails the org owners. An owner approves it from that email or at *Org Settings → Third-party Access → GitHub Apps* (they can trim the repo list first) |
| **Personal** account | **No request flow** — only the account owner can install on their own account. Not your account? Ask them to run steps 1–5 |

> 💬 The GitHub notification email is easy to miss. After clicking **Request**, message the
> org owner directly instead of waiting.

### What the App asks for
Contents **R/W**, Pull requests **R/W**, Metadata **R**. Contents R/W is what lets the server
mint the short-lived tokens engineers' git clients use to clone and push.

### After it is accepted
Nothing to configure. The `installation` webhook fires, the server records the installation
automatically (`src/parse.ts`), and **existing engineer keys work on the newly covered repos
immediately** — nobody needs a new key or a re-run of `tracker setup`.

### Verify it worked
Have someone whose machine is already set up (`tracker status` green) `git clone` a repo under
that owner:
- **Clones without prompting for a password** → the App is installed and covering that repo.
- **git prompts for credentials** → that owner is not covered. `/api/app-token` is returning
  `404 no installation for repo` and the credential helper is deliberately staying silent, so
  git falls through to the machine's normal credential manager.

> **Order matters.** Key issuance does not depend on this step — an admin can create `e8k_`
> keys at any time — but **git access does**. Install the App on a new owner *before* handing
> out keys for its repos, or engineers hit that silent fall-through and assume their key is
> broken.

---

## Engineer setup
One-time per machine — no repo clone needed.

### Prerequisites (engineer machine)
Works on **Windows, macOS, and Linux**. Before running `tracker setup`, install:

| Requirement | Why | Check |
|---|---|---|
| **Node.js ≥ 18** (LTS 20+ recommended) | The CLI and credential helper run on Node (uses global `fetch`) | `node -v` — get it at <https://nodejs.org> |
| **npm** (bundled with Node) | Installs the CLI globally (`npm i -g`) | `npm -v` |
| **Git ≥ 2.34** | The tracker plugs into git's credential system; 2.34+ honors `password_expiry_utc` so stale tokens aren't reused | `git --version` |
| **An engineer key** (`e8k_…`) | The **only** credential you need — ask an admin. Your key mints the token that clones/pulls/pushes tracked repos | — |
| **The CLI tarball** (`.tgz`) | Get it from an admin, or the Releases page. `gh release download` needs a GitHub login **only if the repo is private** — otherwise just grab the file | `gh --version` *(if using gh)* |

> **You do _not_ need your personal GitHub account to have access to the tracked repos.** Your `e8k_` key
> mints a short-lived **installation token** (from the GitHub App) that already carries the repo access, and
> the credential helper uses it for clone/pull/push — a machine with no GitHub login can still clone a
> private tracked repo. A personal GitHub login only matters for your own untracked/personal repos.

A fallback credential manager for personal/untracked repos is optional and usually ships with git
(Windows: Git Credential Manager · macOS: `osxkeychain` · Linux: `cache`) — `tracker setup` wires the
right one for your OS automatically.

The three commands below are **identical on Windows (CMD/PowerShell), macOS, and Linux** —
`-O tracker.tgz` writes the download to a fixed name so there is no shell glob to expand
(`*.tgz` is not expanded by Windows CMD/PowerShell).

```bash
# 1. Download the latest CLI from Releases (needs GitHub access to the talentedgeai org).
gh release download --repo talentedgeai/edge8-github-app-tracker --pattern "*.tgz" -O tracker.tgz
#    (no gh? download the .tgz from the Releases page in a browser and rename it tracker.tgz)

# 2. Install globally.
npm i -g ./tracker.tgz

# 3. Set up (ask an admin for your key).
tracker setup --key e8k_xxxxxxxx_yyyy --server https://edge8-github-app-tracker-kappa.vercel.app

# 4. Confirm you're being counted (run this any time you're unsure).
tracker status
```

After setup, every `git clone/pull/push` on a **tracked** repo authenticates automatically
with a fresh 60-minute token (auto-refreshed — git calls the helper on each operation; cache
hits send a `/beacon` heartbeat). Untracked/personal repos fall through to your normal
credential manager. Undo with `tracker uninstall` (other credential helpers are preserved).

`tracker status` prints four lines — helper wired (in the *effective* chain git walks) ·
which node will run it · last token mint · server reachable + key accepted — and exits 0
only when the machine is verifiably being counted. Every ✘ line includes its fix.

Two things worth knowing:
- **`gh auth login` / `gh auth setup-git` silently remove the tracker** (gh rewrites git's
  credential-helper list). Re-run `tracker setup` afterwards — no flags needed, it reuses
  the stored key. Setup is idempotent and preserves gh as a fallback.
- **Upgrading to a new CLI version:** install the new tarball, then re-run `tracker setup`
  once — **no flags, no key**: it re-uses the key/server stored in `~/.edge8/config.json`
  and refreshes the helper files to the newly installed version (`npm i -g` alone replaces
  only the CLI, never the git plumbing). Coming from v0.2.x this also replaces the old
  node-pinned wiring with a shim that re-resolves node at run time, so `brew upgrade node`
  (or a Node reinstall) can no longer silently kill tracking.

---

## API reference
Base URL `https://edge8-github-app-tracker-kappa.vercel.app`. All bodies are JSON.

| Method | Path | Auth header | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | — | liveness + backend + table list |
| `POST` | `/api/webhooks/github` | `X-Hub-Signature-256` | GitHub App calls this — verify → store → mint |
| `POST` | `/api/app-token` | `x-edge8-key` | mint a 60-min installation token |
| `POST` | `/api/beacon` | `x-edge8-key` | activity heartbeat (always 204) |
| `POST` | `/api/admin/keys` | `x-admin-token` | **create** an engineer key |
| `GET` | `/api/admin/keys` | `x-admin-token` | **list** keys (no secrets) |
| `DELETE` | `/api/admin/keys` | `x-admin-token` | **revoke** a key |

### `GET /api/health`
```
→ 200 {"ok":true,"backend":"postgres","tables":["app_installations","app_tokens","capture_flags","engineer_keys","git_access_events","projects","pull_requests","push_events","webhook_deliveries","work_spans"]}
```

### `POST /api/app-token`
Header `x-edge8-key: e8k_<id>_<secret>`
```jsonc
// request
{ "host": "github.com", "path": "owner/repo.git", "verb": "pull" }

// 200 — token that clones/pulls the repo
{ "username": "x-access-token", "token": "ghs_XXXXXXXXXXXXXXXX...", "expires_at": "2026-07-08T12:00:00Z" }

// 401 {"error":"bad key"}        — key unknown/revoked/wrong secret
// 404 {"error":"no installation for repo"}  — App not installed on that repo (helper stays silent)
// 503 {"error":"mint failed","detail":"..."} — token mint failed (App misconfigured; helper falls through)
```

### `POST /api/beacon`
Header `x-edge8-key`
```jsonc
// request
{ "path": "owner/repo.git", "verb": "pull" }

// always → 204 No Content (empty body; never reveals whether the key is valid)
```

### `POST /api/admin/keys` — create a key
Header `x-admin-token: <ADMIN_TOKEN>`
```jsonc
// request
{ "email": "engineer@edge8.ai" }

// 201 — the full key is returned ONCE (store it now; only its hash is persisted)
{ "key_id": "e8k_328e9fef", "member": "engineer@edge8.ai",
  "key": "e8k_328e9fef_16a74766371d0e4677659c30aebf5cb5fbcf94d6ae4ac735",
  "note": "store this key now — it is shown once and not recoverable" }

// 401 {"error":"unauthorized"}   — bad/missing admin token
// 400 {"error":"email required"} — email missing or not an email
```

### `GET /api/admin/keys` — list keys
Header `x-admin-token`
```jsonc
// 200
{ "keys": [ { "key_id": "e8k_328e9fef", "member": "engineer@edge8.ai",
              "status": "active", "issued_at": "2026-07-08T09:01:28Z" } ] }
```

### `DELETE /api/admin/keys` — revoke a key
Header `x-admin-token`
```jsonc
// request
{ "key_id": "e8k_328e9fef" }

// 200
{ "key_id": "e8k_328e9fef", "status": "revoked" }
```

---

## Admin runbook

### Environment variables (Vercel → Project → Settings → Environment Variables)
| Var | Value |
|---|---|
| `APP_ID` | GitHub App ID (numeric) |
| `WEBHOOK_SECRET` | must equal the App's *Webhook secret* |
| `GITHUB_APP_PRIVATE_KEY` | full `.pem` content (multi-line) |
| `TRACKER_DB_URL` | Supabase **transaction pooler** URI (port **6543**) |
| `ADMIN_TOKEN` | secret guarding `/api/admin/keys` |

> ⚠️ **Security warning — live secret below.** `ADMIN_TOKEN` guards `/api/admin/keys`: anyone
> holding it can mint engineer keys that reach **every tracked repo in every covered org**.
> It is recorded here because admins need it to run this runbook, and this repo is private —
> but treat it accordingly:
>
> - **Never** share it outside the admin group, paste it into chat tools, or use it in client code.
> - If it leaks (or an admin leaves): **rotate immediately** — set a new value in Vercel env →
>   redeploy → update this line and the local `.env`.
> - **Remove this value from the file before the repo is ever made public or shared externally.**
>
> ```
> ADMIN_TOKEN = DhzMI2qGCa
> ```
>
> The commands below read it from a shell variable: `export ADMIN_TOKEN=...` (bash) /
> `$env:ADMIN_TOKEN = "..."` (PowerShell).

> **An engineer key now authenticates two things.** Since edge8-telemetry 2.0.0,
> the same `e8k_` key a machine uses to mint git tokens also authenticates that
> machine's Claude Code telemetry to `edge8.ai/api/telemetry/sessions/`. Two
> consequences worth knowing: an engineer whose sessions should be counted needs
> a key (no key = telemetry queues locally and never arrives), and revoking a key
> stops that person's git access **and** their telemetry in one action.

### Issue a key (for a new engineer)
```bash
curl -X POST https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys \
  -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"email":"engineer@edge8.ai"}'
# → copy the "key" value from the response and send it to the engineer privately
```
List / revoke:
```bash
curl https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys -H "x-admin-token: $ADMIN_TOKEN"
curl -X DELETE https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys \
  -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" -d '{"key_id":"e8k_xxxxxxxx"}'
```

### GitHub App
- **Webhook URL:** `https://edge8-github-app-tracker-kappa.vercel.app/api/webhooks/github`
- **Webhook secret:** equal to `WEBHOOK_SECRET`
- **Permissions:** Contents R/W, Pull requests R/W, Metadata R
- **Events:** push, pull_request, pull_request_review, create, delete, repository, member, label, release
- **Install:** on the org/user with **All repositories** — new repos are tracked
  automatically. Click-by-click steps, the non-owner **Request** flow, and how to verify
  coverage: **[Install the GitHub App](#install-the-github-app)**.

### Supabase
Apply `supabase/migrations/0001_tracker.sql` (creates schema `tracker` + 10 tables + RLS
deny-all; touches nothing in `public`). Use the transaction-pooler string (port 6543) as
`TRACKER_DB_URL`.

**Planned move: onto the Edge8 Company Database (`wwchefrgkkxmhlkntufm`).** The tracker
currently runs on its own Supabase project (`human-token-tracker`), which the Human Token
Tracker cutover plans to retire. `htt.engineer_keys` already exists on the Edge8 project in
this table's exact shape, so the move is data plus one env var, with no code change here:

1. Apply `0001_tracker.sql` to the Edge8 project, minus `engineer_keys`.
2. `pg_dump --schema=tracker --data-only` from the old project, restore into the new one,
   then `insert into htt.engineer_keys select key_id, key_hash, member, status, issued_at
   from tracker.engineer_keys on conflict (key_id) do nothing;` and replace
   `tracker.engineer_keys` with an updatable view over `htt.engineer_keys`.
3. Re-point `TRACKER_DB_URL` at the Edge8 project's pooler and redeploy.
4. Verify with `GET /api/health` (it lists the ten tables it can see) and one real
   `git clone` from a set-up machine, then `npm run reparse && npm run remint` to confirm
   spans rebuild identically from the copied raw log.

`src/db-pg.ts` qualifies every bare table name to `tracker.<name>`, so the schema name is
all it depends on. Do this in a quiet window: `TRACKER_DB_URL` is what every engineer's
`git pull` authenticates through. Plan: `docs/plans/htt/2026-09-11-telemetry-direct-to-supabase.md`
in edge8-web.

### Cut a new CLI release
```bash
# bump "version" in cli/package.json, commit, then tag that version (e.g. v0.2.2):
git tag vX.Y.Z && git push origin vX.Y.Z
```
The `release-cli` GitHub Action (`.github/workflows/release-cli.yml`) packs `cli/` and attaches
the tarball to the Release automatically. Engineers always fetch the **latest** release with the
version-agnostic command in [Engineer setup](#engineer-setup), so keep only the newest release.
(Local build: `cd cli && npm pack`.)

---

## Verified production flow
The full loop, exercised end-to-end on Vercel + Supabase via the real credential helper:

1. **Admin** creates a key → `POST /api/admin/keys` returns `e8k_…`.
2. **Engineer** installs the CLI from Releases → `tracker setup --key … --server …`.
3. **`git clone`** a private tracked repo → the helper auto-mints a token (no manual token).
4. **`git push`** (feature branch) → GitHub webhook → Vercel → Supabase: a `push_events` row
   and a `work_spans` row (six-minute tenths, classified `feature` from the `feat/` prefix).
5. **Open a PR** → the span pairs to the PR; `author_member` resolved from the `<!-- author: … -->` block.
6. **Second push** → span continues from the previous one (spans tile the day, no double-count).
7. **Merge the PR** → the merge-commit push mints **nothing** (carve-out — work already counted).
8. **Direct push to `main`** → a `direct_push` span.
9. **`npm run remint`** re-derives every span from the event tables → byte-identical to the live
   pipeline (idempotent). Nothing is ever hand-edited; everything recomputes from the raw log.

---

## How it works
Two capture streams → derived, recomputable output:
- **Webhooks** (`push`, `pull_request`, `installation`, …) — verified (HMAC of raw bytes),
  stored verbatim in `webhook_deliveries` *before* parsing (capture-first).
- **Access events** — every `/app-token` mint and `/beacon` heartbeat (the "clock-start" signal).

The mint engine (`src/mint.ts`) turns access events + pushes into `work_spans`; pairing
(`src/pairing.ts`) attaches spans to PRs; classification (`src/classify.ts`) labels each span
`build`/`maintenance`/`feature`/`internal`. `capture_flags` records honesty flags
(`unattributed_push`, `no_clock_start`, `orphaned_pr`, `direct_push`, `ambiguous_class`,
`missing_author_block`). Everything is idempotent and replayable (`npm run reparse`, `npm run remint`).

## Repo layout
```
api/                 Vercel serverless functions (health, webhooks/github, app-token, beacon, admin/keys)
src/handlers.ts      shared request handlers (local Express server + Vercel use the same code)
src/db.ts            backend selector → db-pg.ts (Supabase) | db-sqlite.ts (local)
src/{mint,pairing,classify,flags,time,parse,github}.ts   the engine
src/{reparse,remint,seed,inspect}.ts   maintenance scripts (npm run …)
scripts/issue-key.ts local key issuance (alternative to the admin API)
cli/                 @edge8/tracker — the engineer CLI + git credential helper
supabase/migrations/ Postgres schema (schema "tracker")
.github/workflows/   release-cli (auto-attaches the CLI tarball on v* tags)
```

## Local development (contributors)
```bash
npm install
npm test                     # 30 node:test cases (mint arithmetic, pairing, classify, parse)
npm start                    # local Express server; uses SQLite when TRACKER_DB_URL is unset
```
Backend is automatic: `TRACKER_DB_URL` set → Postgres (schema `tracker`); unset → local SQLite
at `data/capture.db`. Never commit `.env`, `keys/`, `data/`, or `secret.txt` (all gitignored).
