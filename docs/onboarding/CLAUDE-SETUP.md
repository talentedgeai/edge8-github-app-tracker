# Edge8 Tracker — instructions for Claude Code (Admin & Engineer flows)

You are Claude Code. This file covers **both roles** in the Edge8 tracker onboarding flow.
Assume the person in front of you may **not be a developer** — explain what you're doing in one
plain sentence per step, never paste raw logs at them, and do every technical step yourself.

## The flow at a glance

```
  ADMIN (once per engineer)                ENGINEER (once per machine)
  ─────────────────────────                ───────────────────────────
  0. repo under a NEW owner? get the
     App installed on that org/user
     (non-owners: Request → owner accepts)
  1. create engineer key        ────────►  receives e8k_… key + tracker.tgz
     (POST /api/admin/keys)     privately
  2. download tracker.tgz                  3. npm i -g tracker.tgz
     from GitHub Releases                  4. tracker setup --key e8k_… --server …
  3. send both to engineer                 5. tracker status   → 4 green lines = counted
                                           6. git clone/pull/push on tracked repos
                                              → auto-authenticated + activity logged
                                           ── and the OTHER half ──────────────
                                           7. claude plugin install edge8-telemetry
                                              (2.0.1+), restart Claude Code
                                           8. /edge8-telemetry → "sessions stored" > 0
```

**Two halves, and they are independent.** Steps 3–6 are the **tracker CLI** (git). Steps 7–8
are the **edge8-telemetry plugin** (Claude Code effort). One working tells you nothing about
the other — `tracker status` can be entirely green while no session is ever counted. A setup
that stops at step 6 is half done, and fails silently.

- Server: `https://edge8-github-app-tracker-kappa.vercel.app`
- **One key covers both.** Since edge8-telemetry 2.0.0 the same `e8k_` key authenticates git
  token minting *and* telemetry — so there is no second credential, and revoking a key stops
  both in one action.
- The tracker plugs into git's credential system. After setup, every `git clone/pull/push` on
  an Edge8-tracked GitHub repo authenticates with a short-lived installation token minted by
  the server. Personal/untracked repos are untouched (they fall through to the machine's
  normal credential manager).
- Engineer config lands at `~/.edge8/config.json`; the helper script at `~/.edge8/`.

## First: determine the user's role

Infer it from what they say, and confirm in one sentence:

- They have (or need to use) an `e8k_…` key on **this machine** → **Role B: Engineer**.
- They want to **create/list/revoke a key for someone else** and hold the `ADMIN_TOKEN` →
  **Role A: Admin**.
- Unclear → ask: *"Are you setting up this machine to work on Edge8 repos (engineer), or
  issuing a key for someone else (admin)?"*

## Security rules — non-negotiable, both roles

- `ADMIN_TOKEN` and engineer keys (`e8k_<id>_<secret>`) are live credentials. **Never** write
  them to any file yourself, never commit them, never put them in shell history workarounds,
  scripts, or scratch files.
- Exception (the whole point of the admin flow): a **freshly created key must be shown once**
  to the admin in chat so they can copy and send it. Everywhere else, refer to keys as
  `e8k_…` + last 4 characters.
- Passing the key as the `--key` argument to `tracker setup` is the only permitted persistent
  use — `tracker setup` stores it in `~/.edge8/config.json` itself. Never read that file's
  contents into the conversation.
- Do not use `sudo` unless `npm i -g` fails with `EACCES` (macOS/Linux), and say so when you do.

---

## Role A — Admin: issue a key for an engineer

### Inputs you need from the admin

1. **The admin's own key** — an `e8a_<id>_<secret>` value they hold personally. **Ask them
   for it; never look it up, and never write it into any file.** It goes in the
   `x-admin-token` header of the calls below and nowhere else.

   ⚠️ **Live secret.** It mints keys that reach every tracked repo in every covered org.
   Never commit it, never send it to engineers, never paste it into a chat tool.

   If the admin does not have one, they mint it once against the database:

   ```bash
   npm run mint-admin-key -- --email them@edge8.ai
   ```

   Thereafter admins mint each other's keys over HTTP with `?target=admin` (see
   [Managing keys](#managing-keys-when-asked)).

   > **Historical note.** Until 2026-09-14 this was one shared `ADMIN_TOKEN` whose value was
   > written in this file and in the README. That value must be treated as compromised — it
   > is in every clone and in git history. Per-admin keys replaced it so that issuance is
   > attributable and one admin can be revoked without rotating for everyone. `ADMIN_TOKEN`
   > still works as a bootstrap fallback and should be deleted from the Vercel environment
   > once every admin holds a key.
2. **The engineer's work email** (becomes the key's `member` identity for attribution).

### Steps

**A0. Repo under a new owner? Ensure the App is installed there first.** The tracker only
covers repos whose **owner** (org or user) has the GitHub App installed — `talentedgeai` is
already covered. For any other owner, this happens once per owner, on GitHub (not on this
machine), so your job is to walk the admin through it:

1. Someone with an account in the target org — or the account owner, for a personal repo —
   opens `https://github.com/apps/edge8-github-app-tracker` → **Install** → picks the target
   org/user → **All repositories** (recommended) or selects specific repos.
2. If that person **is** an org owner/admin, the install completes immediately.
3. If they are **not** an owner, the button reads **Request** instead: GitHub creates an
   installation request and **emails the org owners**; an owner approves via the email link or
   at *Org Settings → Third-party Access → GitHub Apps* (they can adjust the repo list before
   accepting). Nothing works until an owner accepts — tell the requester to ping the owner
   directly, the email is easy to miss.
4. Personal accounts have **no request flow** — only the account owner can install.

Once installed there is nothing to configure server-side (the `installation` webhook registers
it automatically) and **existing engineer keys work on the newly covered repos immediately** —
key issuance (A1) does not depend on this step, but git access does.

**A1. Create the key.** Call the admin API (pick the tool that exists on this machine —
`curl` on macOS/Linux, `Invoke-RestMethod` or `curl.exe` on Windows; note plain `curl` in
PowerShell is an alias for `Invoke-WebRequest`, so use `curl.exe` there):

```
POST https://edge8-github-app-tracker-kappa.vercel.app/api/admin/keys
Headers: x-admin-token: <ADMIN_TOKEN>, content-type: application/json
Body:    {"email":"<engineer email>"}
```

Expected `201` response:

```jsonc
{ "key_id": "e8k_328e9fef", "member": "engineer@edge8.ai",
  "key": "e8k_328e9fef_16a747…",   // full key — returned ONCE, only its hash is stored
  "note": "store this key now — it is shown once and not recoverable" }
```

Show the admin the full `key` value in chat **once**, and tell them: send it to the engineer
through a **private channel** (DM / password-manager share, not a group chat). If they lose
it, it cannot be recovered — revoke and re-create.

Errors: `401 {"error":"unauthorized"}` → wrong/missing admin token, re-check it.
`400 {"error":"email required"}` → body malformed or email invalid.

**A2. Get the CLI tarball for the engineer.** Download the latest release asset:

```
gh release download --repo talentedgeai/edge8-github-app-tracker --pattern "*.tgz" -O tracker.tgz
```

(`gh` missing or not logged in? Tell the admin to grab the `.tgz` from
`https://github.com/talentedgeai/edge8-github-app-tracker/releases` in a browser instead.)

**A3. Tell the admin what to send the engineer**, privately:
- the key from A1
- `tracker.tgz` from A2
- the setup guide (`tracker-setup-guide.html`) and/or this file
- the name of the private repo the engineer will work on (used for their final verification)

### Managing keys (when asked)

- **List** (no secrets returned): `GET /api/admin/keys` with the `x-admin-token` header.
- **Revoke** (engineer offboarding — effective as soon as their last 60-min token expires):
  `DELETE /api/admin/keys` with body `{"key_id":"e8k_xxxxxxxx"}`. The `key_id` is the first
  two segments of the key, visible in the list response.

**Admin keys** are managed through the same endpoint with `?target=admin`, so an admin can
onboard and offboard another admin without database access:

- List: `GET /api/admin/keys?target=admin`
- Issue: `POST /api/admin/keys?target=admin` with body `{"email":"them@edge8.ai"}`
- Revoke: `DELETE /api/admin/keys?target=admin` with body `{"key_id":"e8a_xxxxxxxx"}`

Revoking your own key is refused — it would lock you out mid-session with no signal.
Every issue and revoke is logged with the acting `key_id` and member, which is the
attribution the shared token could never provide.

---

## Role B — Engineer: install and activate on this machine

### Inputs you need from the user

Ask for whatever is missing before you start (ask once, in one message):

1. **Engineer key** — starts with `e8k_`. If they don't have one, stop and tell them to ask
   their Edge8 admin (the admin follows Role A above); you cannot proceed without it.
2. **The CLI tarball `tracker.tgz`** — usually already in the current folder or in
   `~/Downloads`. Search those two places first (`tracker.tgz`, or any `edge8-tracker-*.tgz`)
   before asking. If the user has GitHub access to the `talentedgeai` org and `gh` is
   installed, you may instead download it yourself (same command as step A2).
3. *(Optional)* the name of a tracked private repo to use for final verification.

### Steps

Work through these in order. All commands are identical on Windows (PowerShell/CMD), macOS,
and Linux unless noted. **No shell globs** in any command (Windows does not expand `*.tgz`).

**B1. Preflight.** Check each; report a one-line summary to the user:

| Check | Command | Requirement |
|---|---|---|
| Node.js | `node -v` | ≥ 18 (the helper uses global `fetch`) |
| npm | `npm -v` | any (bundled with Node) |
| Git | `git --version` | ≥ 2.34 (honors `password_expiry_utc`) |

If Node or Git is missing/too old, install it before continuing:
- **Windows:** `winget install OpenJS.NodeJS.LTS` / `winget install Git.Git` (fall back to
  directing the user to nodejs.org / git-scm.com if winget is unavailable). A fresh terminal
  session is required after install — re-check versions before moving on.
- **macOS:** `brew install node git` if Homebrew exists; otherwise nodejs.org installer and
  `xcode-select --install` for git.
- **Linux:** the distro package manager (`apt`, `dnf`, …); prefer NodeSource or `nvm` if the
  distro Node is < 18.

**B2. Locate the tarball.** Find `tracker.tgz` (or `edge8-tracker-*.tgz`) in the current
directory or `~/Downloads`. Use the **exact resolved file path** in the next step — never a glob.

**B3. Install globally.**

```
npm i -g <full-path-to-tracker.tgz>
```

Expected: `added 1 package` (npm warnings are fine). On `EACCES` (macOS/Linux) retry with
`sudo`. Then confirm the command exists: `tracker` with no args prints usage. If the shell
can't find `tracker`, locate npm's global bin (`npm prefix -g`) and either use the full path
or tell the user to reopen the terminal.

**B4. Activate.**

```
tracker setup --key <ENGINEER_KEY> --server https://edge8-github-app-tracker-kappa.vercel.app
```

`tracker setup` validates the key against the server, wires git, and then **verifies its own
work** (reads the config back and checks the effective credential chain). Expected output
starts with `tracker: setup complete ✔ (verified: …)` plus the config/helper paths. It
preserves any credential helpers already on the machine (`gh`, OS credential managers) —
they become fallbacks for personal repos.

Re-running setup is always safe and, once a machine is configured, needs **no flags**:
plain `tracker setup` reuses the stored key/server from `~/.edge8/config.json`.

Error handling — **first move for ANY problem in B4/B5 is `tracker status`** (four lines:
helper wired / node / last mint / server+key; exit 0 = machine is counted; every ✘ line
includes its own fix):
- `key rejected by the server (401)` → the key is wrong or revoked. Ask the user to re-paste
  it (it is long and easy to truncate). Two failures → stop, tell them to request a fresh key
  from their admin.
- `missing/invalid --key` → the key didn't match `e8k_<id>_<secret>` — likely truncated.
- `setup verification FAILED` + a printed helper list → this is setup working as designed
  (it refuses to claim success when the write didn't take — e.g. another tool holds
  `.gitconfig.lock`, or an unusual git config include interferes). Close IDEs/git GUIs,
  re-run `tracker setup`; if it persists, send the printed list to the admin.
- Network/timeout errors → run `tracker status` (its server line distinguishes
  unreachable / unhealthy / key-rejected) and retry once; serverless cold starts can be slow.
  A machine that was set up before can still repair its git wiring while the server is down —
  setup prints a warning and proceeds.

**B5. Verify.** First the one-command check:

```
tracker status
```

Expected: four ✔/– lines and `all checks passed — this machine is being counted ✔` (exit 0).
Any ✘ line names the problem and the fix (usually: re-run `tracker setup`).

Then, if possible, prove the loop end-to-end with an **authenticated** git operation on a
**private tracked repo** (public-repo clones never invoke a credential helper). If the user
gave you a repo name:

```
git ls-remote https://github.com/talentedgeai/<REPO>.git HEAD
```

Success = it prints a commit hash **without prompting for credentials**. (`ls-remote` is used
instead of `clone` so nothing is written to disk.) If no repo name is available, skip this and
tell the user their first real `git clone/pull` will confirm it.

If git prompts for a username/password: setup didn't take or the repo isn't covered by the
Edge8 GitHub App installation — re-run B4, and if it persists tell the user to report the
repo name to their admin. A common cause: the repo's **owner** has no App installation yet
(e.g. a repo outside the org) — that's fixed by Role A, step A0, not by anything on this
machine.

**B6. Report done.** Give the user a short plain-language summary:
- ✔ what was installed and activated
- ✔ what happens now (tracked repos authenticate automatically; personal repos unaffected)
- ⚠️ the one gotcha: `gh auth login` / `gh auth setup-git` **silently remove the tracker**
  from git's config (gh rewrites the credential helper list). If they ever run those,
  re-run `tracker setup` right after. When in doubt, any time: `tracker status`.
- how to undo it later: `tracker uninstall`

### Step E — the effort telemetry plugin (do NOT stop before this)

The steps above set up the **tracker CLI**, which covers git. Claude Code **effort** is
reported by a separate piece — the **edge8-telemetry plugin**. They are independent, and one
working tells you nothing about the other: `tracker status` can be fully green while not a
single session is being counted. An engineer who stops at step D is half set up.

Have the user paste the whole block (every line is safe to re-run):

```bash
claude plugin marketplace add talentedgeai/edge8-telemetry
claude plugin marketplace update edge8
claude plugin update edge8-telemetry@edge8
claude plugin install edge8-telemetry@edge8
```

Then **restart Claude Code** — an update does not apply to an already-running session.
Confirm with `claude plugin list | grep -A1 edge8-telemetry`; the version prints on the line
*below* the name and must be **2.0.1 or later**. A red `✘ ... not found` from the `update`
line is expected on a machine that never had the plugin — the `install` after it is the one
that lands it.

> 🪟 **On Windows 2.0.1 is mandatory, and the symptom of 2.0.0 is that there is no symptom.**
> It captured sessions into a queue that could never drain while reporting the machine
> healthy. Nothing queued is lost — updating delivers the backlog on the first flush.

The engineer's `e8k_` key does double duty: the same key that mints git tokens authenticates
telemetry. There is no second credential to issue.

**Verify, and read the right line.** Have them run `/edge8-telemetry` inside Claude Code. You
want consent granted, a delivery key, the repo registered, and — the only line that actually
proves delivery — a non-zero **"sessions stored"**. An outbox count that never falls means
capture works and delivery does not; "N sessions awaiting delivery" is not success. If it
does not drop to 0 after a completed session, escalate rather than assuming it will resolve.

### Rollback

If the user asks to remove everything: `tracker uninstall` — it removes only the tracker's
entries (other credential helpers like `gh` are preserved) and deletes the helper scripts
and token cache; the config file stays at `~/.edge8/config.json` — mention it so they can
delete it manually if they want the key gone from the machine too.

To stop telemetry as well, they run `/edge8-telemetry` and withdraw consent, or
`claude plugin uninstall edge8-telemetry@edge8`.
