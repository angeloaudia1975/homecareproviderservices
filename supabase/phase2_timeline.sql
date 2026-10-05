-- Phase 2D · Dealer 360 Relationship Timeline — 2026-10-05
--
-- The timeline is built at read time from tables that already exist (visit reports, calls, notes, emails,
-- tasks, deals, orders, appointments, portal activity), so nothing is created here. This only turns the
-- timeline switch on; every other switch is left as it is. SAFE TO RE-RUN. Nothing is pushed to Zoho.

insert into public.app_settings (key, value, updated_at)
values ('phase2_flags',
        '{"adhoc_visit":true,"morning_brief":true,"eod_recap":true,"timeline":true,"conversion":false,"device_check":false}'::jsonb,
        now())
on conflict (key) do update
  set value = public.app_settings.value || '{"timeline":true}'::jsonb, updated_at = now();

-- Check:
select key, value from public.app_settings where key = 'phase2_flags';

-- ROLLBACK (no deploy needed — Dealer 360 goes back to the old 50-row activity list):
-- update public.app_settings set value = value || '{"timeline":false}'::jsonb, updated_at = now() where key = 'phase2_flags';
