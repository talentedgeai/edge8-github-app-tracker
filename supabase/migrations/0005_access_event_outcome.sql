-- Record what actually happened when the credential helper asked for a token.
--
-- WHY. `git_access_events` was the only evidence that a machine was wired up,
-- and it lied by omission. `handleAppToken` logged the event BEFORE looking up
-- the installation, so a row landed whether or not a token was ever issued. A
-- repo whose owner has never installed the App produced a steady stream of
-- access events that looked exactly like working ones — while the helper, which
-- treats 404 as "not our repo", printed nothing and let git fall through to the
-- engineer's personal credentials.
--
-- That is not hypothetical. On 2026-09-17 the table held 20 events for
-- `Bstore-Pty/bstore-company-os`, an owner with no installation: 20 failures
-- indistinguishable from 20 successes. Meanwhile `app_tokens` held exactly one
-- row, so only ONE owner had ever actually been served. Nothing in the data
-- said so, and `tracker status` stayed green throughout.
--
-- `outcome` closes that gap: one row per request, carrying its result.
--
--   pending         the row landed, GitHub has not answered yet
--   minted          a real 60-minute installation token was returned
--   no_installation the App is not installed on that repo's owner (404)
--   mint_failed     GitHub refused or was unreachable (503)
--   cache_hit       beacon: the helper reused a cached token, no mint needed
--
-- The event is still written BEFORE the mint, because it carries the billing
-- clock-start and that must not depend on a slow GitHub call; `pending` is then
-- settled in place. A row left at `pending` means the request died mid-mint —
-- honest, and still usable for billing.
--
-- NULL means "logged before this column existed" — it is not an outcome, and
-- queries that count coverage must exclude it rather than assume success.

alter table tracker.git_access_events
  add column if not exists outcome text;

comment on column tracker.git_access_events.outcome is
  'Result of the request: minted | no_installation | mint_failed | cache_hit. NULL = recorded before 0005, outcome unknown — never read it as success.';

-- Coverage questions ("which repos is the tracker actually serving?") scan by
-- outcome across the whole table; without this they degrade to a seq scan as
-- the event stream grows.
create index if not exists git_access_events_outcome_idx
  on tracker.git_access_events (outcome);
