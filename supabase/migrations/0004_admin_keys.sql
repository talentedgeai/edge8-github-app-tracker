-- Per-admin keys replace the single shared ADMIN_TOKEN.
--
-- WHY. `/api/admin/keys` mints engineer keys, and an engineer key mints GitHub
-- installation tokens — so this endpoint reaches Contents read/write on every
-- repo the App covers, in every covered org. It was guarded by one static string
-- in `process.env.ADMIN_TOKEN`, which meant:
--
--   * no attribution — an engineer key appears and nothing records who issued it;
--   * no individual revocation — cutting off one admin rotates for everyone;
--   * the value sat in plaintext in two committed files (README.md and
--     docs/onboarding/CLAUDE-SETUP.md), so it was in every clone and in git
--     history.
--
-- This is the same shape as `engineer_keys` — sha256 of the presented secret,
-- the secret shown once at issue and never stored — deliberately, because that
-- pattern is already proven in this codebase.
--
-- WHY NOT REUSE `engineer_keys`. Two reasons, both about blast radius:
--   1. Engineer keys live in plaintext in ~/.edge8/config.json on every laptop
--      and are presented on every git operation. Admin capability must not ride
--      on a credential class that widely distributed.
--   2. `tracker.engineer_keys` is a VIEW over `htt.engineer_keys`, which
--      edge8-web owns (see 0002). Adding a role column there would be a
--      coordinated cross-repo schema change; this table is local to this repo.
--
-- The grant and RLS policy for `tracker_app` are applied automatically by the
-- event trigger from 0003 — a plain CREATE TABLE is all this needs.

create table if not exists tracker.admin_keys (
  key_id       text primary key,
  key_hash     text not null,
  member       text not null,
  status       text not null default 'active' check (status in ('active', 'revoked')),
  issued_at    text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  last_used_at text
);

comment on table tracker.admin_keys is
  'One admin credential for /api/admin/keys. sha256 of an e8a_ secret shown once at issue; the secret itself is never stored, so a leak of this table yields no usable key. Replaced the shared ADMIN_TOKEN env var on 2026-09-14.';
comment on column tracker.admin_keys.key_id is
  'Public half (e8a_<8 hex>), presented as e8a_<id>_<secret> and split back out on lookup. Logged on every admin action, which is how issuance gets attributed.';
comment on column tracker.admin_keys.member is
  'Company email the key was issued to. Revoking one row cuts off exactly one admin.';
comment on column tracker.admin_keys.last_used_at is
  'Stamped on each successful admin call. A key with a NULL or long-stale value is a candidate for revocation.';

-- Ordered listings in the admin UI, and the staleness sweep above.
create index if not exists admin_keys_issued_at_idx on tracker.admin_keys (issued_at);
