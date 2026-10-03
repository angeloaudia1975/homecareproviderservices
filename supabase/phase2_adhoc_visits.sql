-- Phase 2A · Unplanned visits ("Start visit" on Dealer 360, no route needed) — 2026-10-03
--
-- What this adds:
--   1. dealer_visit_reports.visit_key — the key the phone makes when Start is tapped and sends on every
--      later call for that visit (queued or not). A replay that arrives after the visit was approved
--      finds THAT visit by its key and never opens a second one.
--   2. One unplanned visit per key (unique index).
--   3. One OPEN unplanned visit per rep per dealer (partial unique index): a second Start resumes the
--      unfinished visit instead of doubling it (approved decision, 2026-10-03). Route visits are not
--      affected — they already have one row per route stop (uq_dvr_route_dealer).
--   4. The Phase 2 feature switches (app_settings "phase2_flags"), with ONLY adhoc_visit on.
--
-- SAFE TO RE-RUN. Adds one column, two indexes and one settings row. Changes no existing value and
-- removes nothing. If any rep already has two unfinished unplanned visits at the same dealer, the script
-- stops with an error and NOTHING is applied (no existing visit is changed or deleted to make room).

begin;

alter table public.dealer_visit_reports add column if not exists visit_key text;

create unique index if not exists uq_dvr_visit_key
  on public.dealer_visit_reports (visit_key);

do $$
declare n int;
begin
  select count(*) into n from (
    select 1 from public.dealer_visit_reports
     where route_id is null and completed_at is null and rep_email is not null
     group by dealer_id, lower(rep_email) having count(*) > 1) d;
  if n > 0 then
    raise exception 'Not applied: % rep/dealer pair(s) already have more than one unfinished unplanned visit. Nothing was changed. Run the check query at the bottom of this file and share the result.', n;
  end if;
end $$;

create unique index if not exists uq_dvr_open_adhoc
  on public.dealer_visit_reports (dealer_id, lower(rep_email))
  where route_id is null and completed_at is null;

-- The switches. A first run creates them (only adhoc_visit on); a re-run only turns adhoc_visit on
-- and leaves every other switch as it is.
insert into public.app_settings (key, value, updated_at)
values ('phase2_flags',
        '{"adhoc_visit":true,"morning_brief":false,"eod_recap":false,"timeline":false,"conversion":false,"device_check":false}'::jsonb,
        now())
on conflict (key) do update
  set value = public.app_settings.value || '{"adhoc_visit":true}'::jsonb, updated_at = now();

commit;

notify pgrst, 'reload schema';

-- Check:
select key, value from public.app_settings where key = 'phase2_flags';
select indexname from pg_indexes where tablename = 'dealer_visit_reports' and indexname in ('uq_dvr_visit_key','uq_dvr_open_adhoc') order by 1;

-- If the script stopped with "Not applied", this shows the visits in the way (read-only):
-- select dealer_id, lower(rep_email) as rep, count(*) as open_visits, array_agg(id) as visit_ids
--   from public.dealer_visit_reports
--  where route_id is null and completed_at is null and rep_email is not null
--  group by 1, 2 having count(*) > 1;

-- ROLLBACK
--   Step 1 (no deploy needed — Start visit disappears from Dealer 360 and the field app answers
--   "Unplanned visits aren't turned on yet."; visits already made stay readable on Dealer 360):
-- update public.app_settings set value = value || '{"adhoc_visit":false}'::jsonb, updated_at = now() where key = 'phase2_flags';
--   Step 2 (only if the code is rolled back too):
-- drop index if exists public.uq_dvr_open_adhoc;
-- drop index if exists public.uq_dvr_visit_key;
--   The visit_key column is left in place on purpose: it is unused without the code, and dropping it
--   would erase the keys of visits already made.
