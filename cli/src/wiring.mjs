// Pure wiring logic for the edge8-tracker CLI: parsing `git config` output,
// reconciling the credential-helper chain, judging the EFFECTIVE chain git will
// actually walk, and rendering the node-resolving shim. No IO in this module —
// everything here is unit-tested in cli/test/wiring.test.js.
//
// Vocabulary (see gitcredentials(7)):
//  - git accumulates helper values from BOTH `credential.helper` (wildcard) and
//    `credential.<url>.helper` keys, in config read order (system -> global -> local);
//  - an EMPTY value resets the accumulated list ("so you may override a helper
//    set by a lower-priority config file");
//  - helpers are tried in order; the first one that answers wins.

export const GITHUB_HELPER_KEY = "credential.https://github.com.helper";
export const GITHUB_USEHTTPPATH_KEY = "credential.https://github.com.usehttppath";

// Our entries are recognizable by the files they reference. Matches both the
// v0.3+ shim (helper.sh) and legacy v0.2.x node-pinned wiring (helper.mjs),
// with either slash direction.
export const isOurs = (value) => /\.edge8[\\/]helper\.(mjs|sh)/.test(value ?? "");
export const isLegacy = (value) => /\.edge8[\\/]helper\.mjs/.test(value ?? "");

// Split raw `git config --get-all` output into entry values. Not .trim():
// an empty entry ("" reset guard) is a legitimate empty line we must keep.
export function linesOf(raw) {
  if (raw === "") return [];
  const lines = raw.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline, not an entry
  return lines;
}

// Split raw `git config -z --get-all` output (NUL-terminated values). Unlike
// linesOf, this is safe for values that legally CONTAIN newlines (inline shell
// helpers spanning lines) — the CLI must never fragment such an entry.
export function nulsOf(raw) {
  if (raw === "") return [];
  const parts = raw.split("\0");
  if (parts[parts.length - 1] === "") parts.pop(); // trailing NUL, not an entry
  return parts;
}

// Parse `git config -z --show-scope --show-origin --get-regexp <pat>` output.
// -z framing (verified empirically): scope NUL origin NUL key LF value NUL ...
// A key with no "=" at all (boolean true) has no LF -> value === null.
export function parseZRecords(raw) {
  const tokens = raw.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const records = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [scope, origin, kv] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    const nl = kv.indexOf("\n");
    records.push({
      scope,
      origin,
      key: nl === -1 ? kv : kv.slice(0, nl),
      value: nl === -1 ? null : kv.slice(nl + 1),
    });
  }
  return records;
}

// Does a `credential.*` key participate in the github.com context?
// Returns { sub: "helper"|"usehttppath", applies: "wildcard"|"github"|"other" } or null.
export function classifyKey(key) {
  const m = /^credential\.(?:(.*)\.)?(helper|usehttppath)$/.exec(key ?? "");
  if (!m) return null;
  const [, url, sub] = m;
  if (url === undefined) return { sub, applies: "wildcard" };
  return { sub, applies: urlMatchesGithub(url) ? "github" : "other" };
}

// Light urlmatch: strip scheme and userinfo, compare host. We deliberately do
// NOT reimplement git's full urlmatch specificity rules — for the keys that
// appear in real credential configs (wildcard + https://github.com) this is
// exact, and unknown shapes are surfaced (not silently dropped) via `skipped`.
export function urlMatchesGithub(url) {
  let u = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const at = u.indexOf("@");
  if (at !== -1) u = u.slice(at + 1);
  const host = u.split(/[/:]/)[0].toLowerCase();
  return host === "github.com";
}

// Walk config records in read order and compute what git will actually do for
// a github.com credential lookup: the ordered helper chain (after ""-resets)
// and the effective useHttpPath value.
export function computeEffective(records) {
  let chain = [];
  const skipped = [];
  let httpPathSpecific; // credential.https://github.com.usehttppath — wins over wildcard
  let httpPathWildcard; // credential.usehttppath
  for (const r of records) {
    const c = classifyKey(r.key);
    if (!c || c.applies === "other") continue;
    if (c.sub === "helper") {
      if (r.value === null) { skipped.push(r); continue; } // boolean-true helper: nonsense, surface it
      if (r.value === "") chain = [];
      else chain.push({ value: r.value, scope: r.scope, origin: r.origin });
    } else {
      const v = r.value === null ? true : /^(true|yes|on|1)$/i.test(r.value);
      if (c.applies === "github") httpPathSpecific = v;
      else httpPathWildcard = v;
    }
  }
  return { chain, useHttpPath: httpPathSpecific ?? httpPathWildcard ?? false, skipped };
}

// Where do we stand in an effective chain? blockers = helpers git asks BEFORE ours.
export function analyzeChain(chain) {
  const oursIdx = chain.findIndex((e) => isOurs(e.value));
  return {
    oursIdx,
    ours: oursIdx === -1 ? null : chain[oursIdx],
    blockers: oursIdx === -1 ? [] : chain.slice(0, oursIdx),
  };
}

// Reconcile: what the global github.com helper list should become.
// Preserves every non-ours entry in original order (gh, custom helpers, ...),
// keeps exactly one leading "" reset guard (blocks system-scope managers from
// answering tracked repos with a stored PAT), puts our entry right after it,
// and always ends with the platform fallback so personal repos keep working
// even if the other helpers disappear later (matches v0.2.x behavior).
export function buildTarget(existing, ourEntry, platformFallback) {
  const others = [];
  for (const e of existing ?? []) {
    if (e === "" || isOurs(e)) continue;
    if (!others.includes(e)) others.push(e);
  }
  if (!others.includes(platformFallback)) others.push(platformFallback);
  return ["", ourEntry, ...others];
}

// Uninstall counterpart: drop our entries; if other helpers remain, keep a ""
// guard ahead of them (both gh and we install one — removing it would let a
// system-scope manager jump the queue, changing behavior underfoot); if nothing
// remains, restore the bare platform fallback (stock machine state).
export function buildUninstallTarget(existing, platformFallback) {
  const others = [];
  for (const e of existing ?? []) {
    if (e === "" || isOurs(e)) continue;
    if (!others.includes(e)) others.push(e);
  }
  return others.length ? ["", ...others] : [platformFallback];
}

// The POSIX-sh shim installed at ~/.edge8/helper.sh. Resolves node at RUN time:
//  1. RECORDED — the exact node that ran `tracker setup` (known-good version;
//     survives GUI git clients whose PATH lacks node);
//  2. PATH — survives `brew upgrade node` deleting the recorded Cellar path
//     (/opt/homebrew/bin/node is a stable symlink);
//  3. well-known install locations, newest nvm version by NUMERIC sort
//     (a plain glob would sort v9 after v22).
// `--selftest` prints the resolved node and exits — `tracker status` runs it
// through git's own sh so the answer reflects the interpreter git really uses.
// No node anywhere -> exit 0 silently: NEVER break git (falls through to the
// next helper in the chain). LF endings are mandatory (macOS/Linux sh rejects CRLF).
export function buildShim(nodePath, helperPath) {
  // Escape for a double-quoted sh context: " $ ` are live inside "..." and an
  // odd-but-legal home path (`C:\Users\SVC$`, a $-containing mount) would
  // otherwise expand to the wrong string or break the shim's syntax.
  const shq = (p) => String(p).replace(/\\/g, "/").replace(/(["$`])/g, "\\$1");
  const rec = shq(nodePath);
  const helper = shq(helperPath);
  return [
    "#!/bin/sh",
    "# edge8-tracker shim — written by `tracker setup`; git invokes this for",
    "# github.com credentials. Resolves node at run time so a node upgrade or a",
    "# PATH-less GUI client cannot silently kill tracking.",
    `RECORDED="${rec}"`,
    `HELPER="${helper}"`,
    'NODE=""',
    'if [ -x "$RECORDED" ]; then',
    '  NODE="$RECORDED"',
    "elif command -v node >/dev/null 2>&1; then",
    '  NODE="$(command -v node)"',
    "else",
    '  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node"; do',
    '    if [ -x "$c" ]; then NODE="$c"; break; fi',
    "  done",
    '  if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then',
    '    v="$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sed s/^v// | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"',
    '    if [ -n "$v" ] && [ -x "$HOME/.nvm/versions/node/v$v/bin/node" ]; then NODE="$HOME/.nvm/versions/node/v$v/bin/node"; fi',
    "  fi",
    "fi",
    'if [ "$1" = "--selftest" ]; then',
    '  if [ -n "$NODE" ]; then',
    '    echo "node=$NODE"',
    '    "$NODE" --version',
    "    exit 0",
    "  fi",
    '  echo "node=NONE"',
    "  exit 1",
    "fi",
    '[ -z "$NODE" ] && exit 0',
    'exec "$NODE" "$HELPER" "$@"',
    "",
  ].join("\n");
}
