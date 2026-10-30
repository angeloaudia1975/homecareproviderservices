-- ============================================================================
-- Scheduled Routes — route integrity (Angelo, 2026-10-30; PR #68).
-- Run ONCE in the Supabase SQL editor (Run button), the whole file. Safe to re-run.
--
-- Adds to rep_routes, nothing else:
--   archived_at / archived_by  — a route that holds visit records is ARCHIVED, never deleted
--   depart_time ('HH:MM')      — the explicit departure time arrival estimates start from
--   depart_tz                  — the departure time zone of a one-way route
--                                (America/Chicago | America/New_York)
-- Additive columns only: no row is changed (every new column starts NULL), no grant, policy or
-- function changes. rep_routes keeps RLS on with no policies (service_role only, RULE 19 — the
-- new columns inherit the table's existing privileges; nothing new is exposed).
-- Until this runs, routes-api answers 503 "schema_update_needed" for archiving and for saving a
-- one-way route; everything else works as before.
-- ============================================================================
begin;
alter table public.rep_routes add column if not exists archived_at timestamptz;
alter table public.rep_routes add column if not exists archived_by text;
alter table public.rep_routes add column if not exists depart_time text;
alter table public.rep_routes add column if not exists depart_tz   text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rep_routes_depart_time_chk') then
    alter table public.rep_routes add constraint rep_routes_depart_time_chk
      check (depart_time is null or depart_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rep_routes_depart_tz_chk') then
    alter table public.rep_routes add constraint rep_routes_depart_tz_chk
      check (depart_tz is null or depart_tz in ('America/Chicago','America/New_York'));
  end if;
end $$;
create index if not exists rep_routes_active_idx on public.rep_routes (scheduled_date) where archived_at is null;
commit;

-- Check (the last statement's result is what the editor shows): columns_added and checks_added must
-- be true. rls_on and policy_count are reported for comparison with before the run — this file changes
-- neither (no grant, policy or RLS statement). Safe to re-run: every step is "if not exists".
select
  (select count(*) = 4 from information_schema.columns
     where table_schema = 'public' and table_name = 'rep_routes'
       and column_name in ('archived_at','archived_by','depart_time','depart_tz'))           as columns_added,
  (select count(*) = 2 from pg_constraint
     where conname in ('rep_routes_depart_time_chk','rep_routes_depart_tz_chk'))           as checks_added,
  (select relrowsecurity from pg_class where oid = 'public.rep_routes'::regclass)          as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'rep_routes') as policy_count;
