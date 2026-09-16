# edge8-tracker — GitHub work-tracking service

Tracks real engineering work from git activity. A GitHub App captures webhooks and a
credential helper on each engineer's machine mints short-lived access tokens; both streams
land in Postgres and are turned into **work spans** (six-minute tenths), paired to PRs and
classified — all recomputable from the raw event log.

> **👋 New engineer?** You do **not** clone this repo. Grab the CLI from the
> [**Releases**](https://github.com/talentedgeai/edge8-github-app-tracker/releases) page,
> install it, ask an admin for your key, run `tracker setup`. See **[Engineer setup](#engineer-setup)**.
>
> **Already set up?** Both halves need to be current —
> **[get on the current version](#for-engineers-get-on-the-current-version)**. Windows
> machines on edge8-telemetry 2.0.0 have been reporting healthy while delivering nothing.

## ⚠️ Needs attention

Open items as of 2026-09-14, roughly in priority order. Ticked off in the sections linked.

| | item | why it matters |
|---|---|---|
| 🔴 | **The old shared `ADMIN_TOKEN` value is in git history** — it was committed in three files (this one, `docs/onboarding/CLAUDE-SETUP.md`, `docs/onboarding/tracker-setup-guide.html`) | it mints engineer keys reaching every tracked repo in every covered org. The plaintext copies are gone, but deleting them does not unpublish it: **rotate or remove it in Vercel**. Per-admin keys have replaced it — see [Admin keys](#admin-keys). |
| 🟠 | **Every Windows engineer is invisible** until they update to edge8-telemetry **2.0.1** | 2.0.0 captured into a queue that could never drain and reported itself healthy. Their backlog returns on update. See [For engineers](#for-engineers-get-on-the-current-version). |
| 🟠 | **The old Supabase project (`human-token-tracker`) still holds all capture history** | 15,078 `push_events` and 984 `work_spans` did not come across. **Pause it, do not delete it.** |
| 🟡 | **The duplicate Vercel deployment should be deleted** — `edge8-github-app-tracker.vercel.app`, on a personal account | it held a stale `TRACKER_DB_URL` and silently took the webhooks for three days. While it exists the split can recur. |
| 🟢 | ~~A new `tracker` table needs a grant + RLS policy~~ — **now automatic** | an event trigger applies both at `CREATE TABLE`. See [Database credentials](#database-credentials). |
| 🟢 | `htt.engineer_keys` has 15 keys, all active — none has ever been revoked | worth an audit when someone leaves; revoking cuts git access and telemetry in one action. |

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

# 3. Set up (ask an admin for your key). Wires git AND offers to turn on effort telemetry.
tracker setup --key e8k_xxxxxxxx_yyyy --server https://edge8-github-app-tracker-kappa.vercel.app

# 4. Confirm you're being counted (run this any time you're unsure).
tracker status
```

Step 3 asks one yes/no question — whether to also report your Claude Code session effort —
and installs the `edge8-telemetry` plugin for you if you say yes. Answer it up front with
`--telemetry` or `--no-telemetry` (useful in a script, where an unanswerable prompt counts
as "no"). That question is the whole of what used to be a second, separate setup, and the
half that people kept missing.

After setup, every `git clone/pull/push` on a **tracked** repo authenticates automatically
with a fresh 60-minute token (auto-refreshed — git calls the helper on each operation; cache
hits send a `/beacon` heartbeat). Untracked/personal repos fall through to your normal
credential manager. Undo with `tracker uninstall` (other credential helpers are preserved).

`tracker status` prints five lines — helper wired (in the *effective* chain git walks) ·
which node will run it · last token mint · server reachable + key accepted · effort
telemetry — and exits 0 only when the machine is verifiably being counted for git. Every ✘
line includes its fix. The `effort` line is reported but does **not** decide the exit code:
declining telemetry is a legitimate answer, so it must not make `tracker status` fail.

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

## For engineers: get on the current version

Two separate things run on your machine, and **both** need to be current. They are
independent at run time — having one working tells you nothing about the other — but since
CLI 0.4.0 a single `tracker setup` installs and checks both.

| | what it does | fires on |
|---|---|---|
| **tracker CLI** | mints git tokens so `clone/pull/push` works on tracked repos | every git operation |
| **edge8-telemetry plugin** | reports Claude Code session effort | session start/end |

### 1. The telemetry plugin — **2.0.1 or later**

Since tracker CLI 0.4.0 this is one command, and it is the same one that wires git:

```bash
tracker setup --telemetry
```

On a machine that is already set up it needs no other flags — it reuses the stored
key/server, adds the marketplace, installs the plugin at its current version, and records
your consent. `--telemetry` answers the consent question up front so the command runs
unattended; plain `tracker setup` asks it instead.

Then **restart Claude Code** — a plugin update does not affect a session already running.
Confirm with `tracker status` (the `effort` line) or `claude plugin list | grep -A1
edge8-telemetry`, where the version prints on the line *below* the name.

<details>
<summary>The manual equivalent, if <code>tracker setup</code> is unavailable</summary>

```bash
claude plugin marketplace add talentedgeai/edge8-telemetry
claude plugin marketplace update edge8
claude plugin update edge8-telemetry@edge8
claude plugin install edge8-telemetry@edge8
```

Then write `granted` (exactly that word, no trailing text) to
`~/.claude/.il-telemetry/consent` — the plugin reads that file and nothing else. A red
`✘ ... not found` from the `update` line is expected on a machine that never had the
plugin; the `install` on the next line is the one that lands it.
</details>

> 🪟 **On Windows, 2.0.1 is mandatory, and the symptom of 2.0.0 is that there is no symptom.**
> The delivery module imported a Unix-only module, so it died at import — sessions were
> captured into a queue that could never drain, while `/edge8-telemetry` reported consent ✅,
> key ✅, repo ✅ and "N sessions awaiting delivery". Every statement was true; the next
> start/end would never deliver either. Nothing queued is lost — updating delivers the whole
> backlog on the first flush. macOS and Linux were unaffected.

### 2. The engineer key — needed by **both**

Since edge8-telemetry 2.0.0 the same `e8k_` key authenticates git token minting *and*
telemetry, so a machine without one captures sessions locally and delivers nothing.

```bash
tracker status        # exits 0 only if you are verifiably being counted
```

If it is not green, or you have never set up, follow
[Engineer setup](#engineer-setup). When an admin issues your key, point at the `-kappa`
host — the bare `edge8-github-app-tracker.vercel.app` was a second deployment on a personal
Vercel account and is retired:

```bash
tracker setup --key e8k_xxxxxxxx_yyyy --server https://edge8-github-app-tracker-kappa.vercel.app
```

### 3. Check it worked

Inside Claude Code, run `/edge8-telemetry`. You want consent granted, a delivery key, the
repo registered, and — the line that actually proves delivery — a non-zero "sessions stored"
from the tracker. An outbox count that never falls means capture is fine and delivery is not.

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
Header `x-admin-token: <your e8a_ admin key>`
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
| `TRACKER_DB_URL` | Supabase **transaction pooler** URI (port **6543**), as role **`tracker_app`** — *not* `postgres` (see [Database credentials](#database-credentials)) |
| `ADMIN_TOKEN` | **legacy bootstrap only.** `/api/admin/keys` is authenticated by per-admin keys in `tracker.admin_keys`; this env var still works so a fresh deployment can mint its first one. Delete it once every admin holds a key — see [Admin keys](#admin-keys) |

### Admin keys

`/api/admin/keys` is authenticated with a **per-admin key** (`e8a_<id>_<secret>`) that you
hold personally — not a shared value stored in this repo. Keys are hashed in
`tracker.admin_keys` exactly as engineer keys are: the secret is shown once at issue and
never stored, so a leak of that table yields nothing usable.

Mint the first one against the database, then manage the rest over HTTP:

```bash
npm run mint-admin-key -- --email you@edge8.ai         # bootstrap, once
```

```bash
export ADMIN_KEY=e8a_xxxxxxxx_...                      # bash
$env:ADMIN_KEY = "e8a_xxxxxxxx_..."                    # PowerShell
```

| action | call |
|---|---|
| list admins | `GET /api/admin/keys?target=admin` |
| add an admin | `POST /api/admin/keys?target=admin` `{"email":"them@edge8.ai"}` |
| revoke an admin | `DELETE /api/admin/keys?target=admin` `{"key_id":"e8a_xxxxxxxx"}` |

Every issue and revoke logs the acting `key_id` and member, so an engineer key can be traced
to whoever created it. Revoking the key you are authenticating with is refused.

> ⚠️ **The old shared `ADMIN_TOKEN` value must be treated as compromised.** Until 2026-09-14
> it was written in plaintext in this file and in `docs/onboarding/CLAUDE-SETUP.md`, so it is
> in every clone and in git history — deleting the lines does not unpublish it. Rotate or
> remove it.
>
> `ADMIN_TOKEN` still authenticates, on purpose: it is the bootstrap path for a fresh
> deployment whose `admin_keys` table is empty, since otherwise there would be no way to mint
> the first admin key without database access. **Delete it from the Vercel environment once
> every admin holds a key.** Each use logs a warning naming that, so a lingering one stays
> visible instead of quietly becoming permanent.

> **An engineer key now authenticates two things.** Since edge8-telemetry 2.0.0,
> the same `e8k_` key a machine uses to mint git tokens also authenticates that
> machine's Claude Code telemetry to `edge8.ai/api/telemetry/sessions/`. Two
> consequences worth knowing: an engineer whose sessions should be counted needs
> a key (no key = telemetry queues locally and never arrives), and revoking a key
> stops that person's git access **and** their telemetry in one action.

### Issue a key (for a new engineer)
```bash
curl -X POST https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys \
  -H "x-admin-token: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"email":"engineer@edge8.ai"}'
# → copy the "key" value from the response and send it to the engineer privately
```
List / revoke:
```bash
curl https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys -H "x-admin-token: $ADMIN_KEY"
curl -X DELETE https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys \
  -H "x-admin-token: $ADMIN_KEY" -H "content-type: application/json" -d '{"key_id":"e8k_xxxxxxxx"}'
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
Apply the migrations in order: `0001_tracker.sql` (schema `tracker` + 10 tables + RLS
deny-all; touches nothing in `public`), `0002_move_to_edge8_company_database.sql`
(`engineer_keys` becomes a view over `htt.engineer_keys`), `0003_tracker_app_role.sql` (the
`tracker_app` login the service uses). Use the transaction-pooler string (port 6543) as
`TRACKER_DB_URL`, as role `tracker_app`.

**The move onto the Edge8 Company Database (`wwchefrgkkxmhlkntufm`) is complete** — see
[Cutover complete](#cutover-complete-2026-09-14). It put the key store where edge8-web's
telemetry endpoint can read it, and retired the standalone `human-token-tracker` project
(which still holds the capture history: **pause, do not delete**). No code in this repo
changed for any of it.

### Done (2026-09-11)

1. **Schema.** `0002_move_to_edge8_company_database.sql` applied. The `tracker` schema
   exists on the Edge8 project with `engineer_keys` as an auto-updatable view over
   `htt.engineer_keys`; key issue, revoke and lookup were exercised through it.
2. **Live state copied and verified byte-identical** (md5 over every column matches the
   source on all three):

   | table | rows |
   |---|---|
   | `engineer_keys` (into `htt.engineer_keys`) | 14, all active |
   | `app_installations` | 10 |
   | `projects` | 42 |

   The token-mint lookup was then replayed against the new database for real repo paths:
   known repos resolve precisely, an unseen repo under a covered owner resolves through the
   owner fallback, and an uncovered owner resolves to nothing. That is the path
   `/api/app-token` walks, so git will behave identically after the cutover.

### History was deliberately not copied

By decision on 2026-09-11, the 264 MB of capture history stayed behind:
`webhook_deliveries` (232 MB), `pull_requests`, `push_events`, `git_access_events`,
`work_spans`, `capture_flags`. The tracker is an internal monitoring tool and the back
catalogue was not worth the migration. Consequences, so nobody is surprised later:

- **Capture starts fresh at the cutover.** `npm run reparse` and `npm run remint` can only
  rebuild from deliveries received after it. The 977 existing work spans do not come across.
- **`app_tokens` was skipped too** — it is a cache of 60-minute installation tokens and
  refills itself on the first mint.
- **`app_installations.raw` was copied as NULL.** Nothing reads it (only `repo_ids`,
  `account_login`, `account_type` and the two lifecycle timestamps are), and the next
  installation webhook rewrites it.
- **Therefore: pause the old Supabase project, do not delete it.** It is the only copy of
  the history, and pausing keeps it recoverable if that judgement is ever revisited.

### Cutover complete (2026-09-14)

Everything now runs on the Edge8 Company Database. In order, with what each step taught:

1. **`TRACKER_DB_URL` re-pointed** at the Edge8 transaction pooler (2026-09-11). Git token
   minting moved immediately — the first real proof was two live tokens minted against the
   new database within fifteen minutes.
2. **The webhook URL was still pointing somewhere else.** Token minting had moved but
   webhooks had not, so `push_events` and `work_spans` — the actual measurement — kept
   being written to the old project for three more days while everything looked healthy.
   The cause: a **second deployment of this repo on a different Vercel account**
   (`edge8-github-app-tracker.vercel.app`, personal), which the GitHub App's webhook URL
   pointed at and which still held the old `TRACKER_DB_URL`. Found by reading
   `webhook_deliveries.headers`, which records the `host` and `x-vercel-deployment-url` of
   every delivery. Fixed by pointing the App at the `-kappa` deployment.
3. **A duplicate GitHub App was retired.** Two Apps were created two hours apart on
   2026-07-08 — `4246569` (installed on a personal account, one webhook event in its whole
   life) and `4247933` (installed on `talentedgeai`, everything since). `4246569` is gone,
   and its orphaned installation row was deleted from both databases.
4. **The service got its own database role** — see [Database credentials](#database-credentials).

Engineers did nothing for the database move: keys, installations and repo config all
carried over, so nobody re-ran `tracker setup` and nobody needed a new key. Engineers
**do** need to act on the telemetry plugin — see
[For engineers: get on the current version](#for-engineers-get-on-the-current-version).

### Database credentials

The service connects as **`tracker_app`**, not `postgres`. Provisioned by
`supabase/migrations/0003_tracker_app_role.sql`; the password lives only in `TRACKER_DB_URL`
in Vercel and is written down nowhere in this repo.

Why it exists: on 2026-09-14 the `postgres` password was rotated and the tracker went down —
every request 500'd with `28P01 password authentication failed`, so **git token minting
stopped for the whole team** until the env var caught up. Connecting as `postgres` also gave
the tracker `rolbypassrls` across a database it shares with `company_os` and `htt`, when it
only ever touches one schema.

| role | scope |
|---|---|
| `tracker_app` | `select/insert/update/delete` on schema `tracker` only. No `rolbypassrls`, no `createrole`, no access to `htt` or `company_os` (the `engineer_keys` view reaches `htt` under its owner's rights, which is the one intended door). |

**Adding a table to `tracker`? Just write the `CREATE TABLE`.** A new table would otherwise
be invisible to the service until it had both a grant and an RLS policy for `tracker_app` —
and that failure is silent, because RLS filters rather than raising, so it reads as missing
data rather than a permissions bug. Instead of leaving that as a rule to remember, an event
trigger (`tracker_app_autogrant`, in `0003`) applies the grant, RLS and the policy at
creation time. Verified by creating a table and writing to it as `tracker_app` with no
manual setup. The manual equivalent is in `0003` if you ever need it.

Rotating the `postgres` password no longer affects this service. `SUPABASE_DB_URL` in
**edge8-web**'s repository secrets was given the same treatment — a read-only `types_ro`
role for the `check:types-fresh` CI job.

Why no code changes: `src/db-pg.ts` rewrites every bare table name to `tracker.<name>`, so
the schema name is the only thing it depends on. Plan:
`docs/plans/htt/2026-09-11-telemetry-direct-to-supabase.md` in edge8-web.

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
