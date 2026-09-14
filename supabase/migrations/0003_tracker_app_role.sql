-- The tracker gets its own database role instead of connecting as `postgres`.
--
-- Applied to the Edge8 Company Database (Supabase project wwchefrgkkxmhlkntufm)
-- on 2026-09-14. The password is NOT recorded here or anywhere in this repo; it
-- lives only in `TRACKER_DB_URL` in Vercel.
--
-- WHY. On 2026-09-14 the `postgres` password was rotated and the tracker went
-- down: every request returned 500 with `28P01 password authentication failed`,
-- webhooks and `/api/app-token` alike, so git token minting stopped for the whole
-- team until the env var caught up. The tracker had been connecting as
-- `postgres` — the one account a human rotates, and an account with
-- `rolbypassrls` over every schema in a database it shares with company_os and
-- htt. Both halves of that were wrong: a shared credential makes routine rotation
-- an outage, and the blast radius was the entire database when the tracker only
-- ever touches one schema.
--
-- After this migration nothing the tracker does depends on the `postgres`
-- password, so rotating it is a non-event.
--
-- ── THE RULE FOR FUTURE MIGRATIONS ──────────────────────────────────────────
-- A new table in `tracker` is INVISIBLE to the running service until it has
-- BOTH a grant and an RLS policy for `tracker_app`. The grants below are not
-- `ALTER DEFAULT PRIVILEGES`, and RLS is enabled with no catch-all policy, so a
-- table added later gets neither automatically.
--
-- The failure is quiet and easy to misread: with RLS on and no matching policy,
-- SELECT returns ZERO ROWS rather than raising — so it looks like missing data,
-- not a permissions bug. Whenever you add a table to `tracker`, add this
-- alongside the CREATE TABLE:
--
--   grant select, insert, update, delete on tracker.<new_table> to tracker_app;
--   create policy tracker_app_all on tracker.<new_table>
--     as permissive for all to tracker_app using (true) with check (true);
--
-- ────────────────────────────────────────────────────────────────────────────
--
-- Idempotent and safe to re-run, except that it never touches the password: the
-- role is created only if absent.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tracker_app') then
    -- Created without a password here on purpose. The real password was set out
    -- of band when the role was provisioned; a fresh environment sets its own.
    create role tracker_app login;
  end if;
end $$;

comment on role tracker_app is
  'edge8-github-app-tracker''s application login. Replaced the shared `postgres` account on 2026-09-14 after a password rotation took the service down. Scoped to schema tracker only; no rolbypassrls, no createrole, no write access to htt or company_os.';

grant usage on schema tracker to tracker_app;
grant select, insert, update, delete on all tables in schema tracker to tracker_app;
-- git_access_events, work_spans and capture_flags use `generated always as
-- identity`, so INSERT needs the sequence too.
grant usage, select on all sequences in schema tracker to tracker_app;

-- `tracker.engineer_keys` is a view over `htt.engineer_keys` (see 0002). It is a
-- plain view owned by postgres rather than a security_invoker one, so it reaches
-- the base table under the owner's rights: tracker_app needs privileges on the
-- view and nothing at all in schema htt. That is deliberate — it keeps the key
-- store readable through exactly one named door.

-- Every tracker table has RLS enabled with no policies (0001/0002). `postgres`
-- did not notice because an owner bypasses RLS unless FORCE is set; tracker_app
-- would have read zero rows from every table. One permissive policy per table
-- fixes that without weakening anything for other roles: a policy names the role
-- it applies to, and no other role is granted anything here.
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tracker' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('drop policy if exists tracker_app_all on tracker.%I', t.relname);
    execute format(
      'create policy tracker_app_all on tracker.%I '
      'as permissive for all to tracker_app using (true) with check (true)',
      t.relname);
  end loop;
end $$;
