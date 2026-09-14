-- Move the tracker onto the Edge8 Company Database: the schema half.
--
-- Applied to the Edge8 Company Database (Supabase project wwchefrgkkxmhlkntufm)
-- on 2026-09-11 via the Supabase connector. NOT applied to the tracker's own
-- project (znnnxubopsbvpvtvrtne), which still runs production.
--
-- Why the move: telemetry from edge8-telemetry 2.0.0 authenticates with the
-- same `e8k_` key this service issues, and that key store has to be readable by
-- edge8-web. One database instead of two also retires the standalone project the
-- Human Token Tracker cutover plans to delete.
-- Plan: edge8-web docs/plans/htt/2026-09-11-telemetry-direct-to-supabase.md §3.2.
--
-- This is 0001_tracker.sql re-applied on the new host with ONE deviation:
-- engineer_keys is a VIEW over htt.engineer_keys rather than a table, so the
-- keys live in one place and both readers see the same rows. Everything else is
-- column-for-column identical, because src/db-pg.ts rewrites bare table names to
-- `tracker.<name>` and cares about nothing else.
--
-- This migration moves no data; it only creates the shapes. The data move
-- happened separately on the same day and is recorded in README.md: the three
-- live-state tables (engineer_keys, app_installations, projects) were copied and
-- verified byte-identical, and the 264 MB of capture history was deliberately
-- left on the old project. Until TRACKER_DB_URL is re-pointed, this schema is
-- inert and the live tracker is unaffected.

create schema if not exists tracker;

comment on schema tracker is
  'edge8-github-app-tracker''s schema, staged 2026-09-11 for the move off project znnnxubopsbvpvtvrtne. Live state is COPIED and verified byte-identical: engineer_keys (14, via the view into htt), app_installations (10), projects (42). History was deliberately NOT copied by decision on 2026-09-11 (webhook_deliveries, push_events, pull_requests, git_access_events, work_spans, capture_flags: 264 MB); it remains on the old project, which should be paused rather than deleted. Capture starts fresh here. Still not live: TRACKER_DB_URL must be re-pointed before this schema receives anything.';

create table if not exists tracker.webhook_deliveries (
  delivery_id text primary key,
  event       text not null,
  action      text,
  payload     text not null,
  headers     text not null,
  received_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  parsed_at   text
);
comment on table tracker.webhook_deliveries is
  'Empty by decision: pre-migration history stayed on the old project. Capture starts from the cutover, so remint/reparse can only rebuild what arrives after it.';

create table if not exists tracker.git_access_events (
  id          bigint generated always as identity primary key,
  key_id      text not null,
  repo_path   text,
  verb        text not null default 'unknown',
  kind        text not null,
  observed_at text not null,
  received_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  raw         text
);

create table if not exists tracker.app_installations (
  installation_id bigint primary key,
  account_login   text not null,
  account_type    text,
  repo_ids        text,
  created_at      text,
  suspended_at    text,
  deleted_at      text,
  raw             text
);

create table if not exists tracker.push_events (
  delivery_id       text primary key references tracker.webhook_deliveries(delivery_id),
  repo_id           bigint not null,
  repo_full         text not null,
  ref               text not null,
  branch            text not null,
  before_sha        text,
  head_sha          text not null,
  forced            integer not null default 0,
  sender_login      text,
  sender_type       text,
  commit_count      integer not null,
  commits_truncated integer not null default 0,
  author_emails     text not null,
  pushed_at         text not null,
  authored_at       text
);

create table if not exists tracker.pull_requests (
  github_pr_id     bigint primary key,
  repo_id          bigint not null,
  number           integer not null,
  title            text,
  branch           text not null,
  base_branch      text,
  state            text not null,
  merged           integer not null default 0,
  labels           text not null default '[]',
  author_block     text,
  user_login       text,
  opened_at        text,
  merged_at        text,
  closed_at        text,
  raw              text,
  merge_commit_sha text,
  author_member    text,
  orphaned         integer not null default 0
);

create table if not exists tracker.work_spans (
  id              bigint generated always as identity primary key,
  delivery_id     text not null references tracker.webhook_deliveries(delivery_id),
  member          text,
  repo_id         bigint not null,
  branch          text not null,
  span_start      text,
  span_end        text not null,
  tokens          double precision not null,
  rule            text not null,
  token_class     text not null,
  class_source    text not null,
  pull_request_id bigint,
  flags           text not null default '[]',
  computed_at     text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  unique (delivery_id, member)
);

create table if not exists tracker.capture_flags (
  id          bigint generated always as identity primary key,
  kind        text not null,
  repo_id     bigint,
  ref         text not null default '{}',
  raised_at   text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  resolved_at text,
  unique (kind, ref)
);

create table if not exists tracker.projects (
  repo_id        bigint primary key,
  repo_full      text,
  phase          text not null default 'build',
  default_branch text not null default 'main',
  delivered_at   text
);

create table if not exists tracker.app_tokens (
  installation_id bigint primary key,
  token           text not null,
  expires_at      text not null,
  updated_at      text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

-- The deviation from 0001_tracker.sql. A simple view over one table is
-- auto-updatable, so handleAdminKeys' INSERT, the revoke UPDATE and
-- findActiveKey's SELECT all work against it unchanged (verified on the live
-- database before this file was written).
create or replace view tracker.engineer_keys as
  select key_id, key_hash, member, status, issued_at from htt.engineer_keys;

comment on view tracker.engineer_keys is
  'Compatibility view over htt.engineer_keys. The tracker issues and revokes keys through this name; edge8-web''s telemetry endpoint authenticates against the same rows in htt. One key store, two readers.';

-- handleAdminKeys inserts without issued_at, and a view does not carry the base
-- table's defaults. Declare them on the view so a key created through it is
-- stamped exactly as the base table would stamp it.
alter view tracker.engineer_keys
  alter column issued_at set default to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
alter view tracker.engineer_keys alter column status set default 'active';

-- RLS deny-all, as on the original host. The API connects as the table owner
-- (owner bypasses RLS); PostgREST/anon/authenticated get nothing, because no
-- policies exist and this schema is not in the exposed list.
--
-- SUPERSEDED IN PART BY 0003_tracker_app_role.sql (2026-09-14): the API no
-- longer connects as the owner. It connects as `tracker_app`, which does NOT
-- bypass RLS, so each table below also carries a permissive policy for that
-- role. Consequence for anyone adding a table to this schema later: it needs a
-- grant AND a policy for `tracker_app` or the service reads ZERO ROWS from it —
-- silently, because RLS filters rather than raising. 0003 has the exact
-- statements to paste alongside your CREATE TABLE.
alter table tracker.webhook_deliveries enable row level security;
alter table tracker.git_access_events  enable row level security;
alter table tracker.app_installations  enable row level security;
alter table tracker.push_events        enable row level security;
alter table tracker.pull_requests      enable row level security;
alter table tracker.work_spans         enable row level security;
alter table tracker.capture_flags      enable row level security;
alter table tracker.projects           enable row level security;
alter table tracker.app_tokens         enable row level security;
