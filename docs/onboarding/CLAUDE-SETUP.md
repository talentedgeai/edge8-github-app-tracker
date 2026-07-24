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
  3. send both to engineer                 5. git clone/pull/push on tracked repos
                                              → auto-authenticated + activity logged
```

- Server: `https://edge8-github-app-tracker-kappa.vercel.app`
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

1. **`ADMIN_TOKEN`** — lives in Vercel → project `edge8-github-app-tracker` → Settings →
   Environment Variables. If they don't have it, stop; they must get it from the project owner.
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

`tracker setup` validates the key against the server itself. Expected output ends with
`tracker: setup complete ✔` plus the config/helper paths.

Error handling:
- `key rejected by the server (401)` → the key is wrong or revoked. Ask the user to re-paste
  it (it is long and easy to truncate). Two failures → stop, tell them to request a fresh key
  from their admin.
- `missing/invalid --key` → the key didn't match `e8k_<id>_<secret>` — likely truncated.
- Network/timeout errors → check connectivity to
  `https://edge8-github-app-tracker-kappa.vercel.app/api/health` (expects `{"ok":true,…}`) and retry
  once; serverless cold starts can be slow.

**B5. Verify end-to-end.** Only an **authenticated** git operation proves the loop, so use a
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
- how to undo it later: `tracker uninstall`

### Rollback

If the user asks to remove everything: `tracker uninstall` (removes the git wiring; the
config file stays at `~/.edge8/config.json` — mention it so they can delete it manually if
they want the key gone from the machine too).
