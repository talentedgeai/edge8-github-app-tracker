# edge8-tracker — GitHub work-tracking service

Tracks real engineering work from git activity. A GitHub App captures webhooks and a
credential helper on each engineer's machine mints short-lived access tokens; both streams
land in Postgres and are turned into **work spans** (six-minute tenths), paired to PRs and
classified — all recomputable from the raw event log.

> **👋 New engineer?** You do **not** clone this repo. Grab the CLI from the
> [**Releases**](https://github.com/talentedgeai/edge8-github-app-tracker/releases) page,
> install it, ask an admin for your key, run `tracker setup`. See **[Engineer setup](#engineer-setup)**.

Production: **Vercel** (Node serverless, `api/*`) + **Supabase Postgres** (schema `tracker`).
Base URL: `https://edge8-github-app-tracker.vercel.app`

```
engineer machine ── git pull/push ──► credential helper (~/.edge8) ──► POST /api/app-token ┐
GitHub App (All repositories) ── webhooks ─────────────────────────► POST /api/webhooks/github ├─► Supabase (schema tracker)
                                                                     POST /api/beacon           ┘
```

---

## Engineer setup
One-time per machine — no repo clone needed.

```bash
# 1. Download the latest CLI from Releases (needs GitHub access to the talentedgeai org)
gh release download --repo talentedgeai/edge8-github-app-tracker --pattern "*.tgz"
#    (or download the .tgz from the Releases page in a browser)

# 2. Install globally
npm i -g edge8-tracker-*.tgz

# 3. Set up (ask an admin for your key)
tracker setup --key e8k_xxxxxxxx_yyyy --server https://edge8-github-app-tracker.vercel.app
```

After setup, every `git clone/pull/push` on a **tracked** repo authenticates automatically
with a fresh 60-minute token (auto-refreshed — git calls the helper on each operation; cache
hits send a `/beacon` heartbeat). Untracked/personal repos fall through to your normal
credential manager. Undo with `tracker uninstall`.

---

## API reference
Base URL `https://edge8-github-app-tracker.vercel.app`. All bodies are JSON.

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

> ⚠️ **Security:** `ADMIN_TOKEN` is a live secret — anyone who has it can mint keys. The value
> below is a **shared test token for the current instance**; rotate it (and keep the real one
> only in Vercel env, not in git) before treating this as production.
>
> ```
> ADMIN_TOKEN = DhzMI2qGCa
> ```

### Issue a key (for a new engineer)
```bash
curl -X POST https://edge8-github-app-tracker.vercel.app/api/admin/keys \
  -H "x-admin-token: DhzMI2qGCa" -H "content-type: application/json" \
  -d '{"email":"engineer@edge8.ai"}'
# → copy the "key" value from the response and send it to the engineer privately
```
List / revoke:
```bash
curl https://edge8-github-app-tracker.vercel.app/api/admin/keys -H "x-admin-token: DhzMI2qGCa"
curl -X DELETE https://edge8-github-app-tracker.vercel.app/api/admin/keys \
  -H "x-admin-token: DhzMI2qGCa" -H "content-type: application/json" -d '{"key_id":"e8k_xxxxxxxx"}'
```

### GitHub App
- **Webhook URL:** `https://edge8-github-app-tracker.vercel.app/api/webhooks/github`
- **Webhook secret:** equal to `WEBHOOK_SECRET`
- **Permissions:** Contents R/W, Pull requests R/W, Metadata R
- **Events:** push, pull_request, pull_request_review, create, delete, repository, member, label, release
- **Install:** on the org/user with **All repositories** — new repos are tracked automatically.

### Supabase
Apply `supabase/migrations/0001_tracker.sql` (creates schema `tracker` + 10 tables + RLS
deny-all; touches nothing in `public`). Use the transaction-pooler string (port 6543) as
`TRACKER_DB_URL`.

### Cut a new CLI release
```bash
# bump "version" in cli/package.json, commit, then:
git tag v0.2.0 && git push origin v0.2.0
```
The `release-cli` GitHub Action (`.github/workflows/release-cli.yml`) packs `cli/` and attaches
the tarball to the Release automatically. Engineers then `gh release download v0.2.0`.
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
