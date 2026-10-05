-- Phase 2C · AI End-of-Day Recap — 2026-10-05
--
-- The recap is stored in the same table as the Morning Brief (rep_daily_briefs, created by
-- supabase/phase2_rep_daily_briefs.sql) as kind 'eod' — that table already allows it, so nothing new is
-- created here. This only turns the eod_recap switch on; every other switch is left as it is.
-- SAFE TO RE-RUN. Nothing in rep_daily_briefs is ever pushed to Zoho.

insert into public.app_settings (key, value, updated_at)
values ('phase2_flags',
        '{"adhoc_visit":true,"morning_brief":true,"eod_recap":true,"timeline":false,"conversion":false,"device_check":false}'::jsonb,
        now())
on conflict (key) do update
  set value = public.app_settings.value || '{"eod_recap":true}'::jsonb, updated_at = now();

-- Check: the switch, and that the table accepts the recap kind.
select key, value from public.app_settings where key = 'phase2_flags';
select pg_get_constraintdef(c.oid) as kinds_allowed
  from pg_constraint c join pg_class t on t.oid = c.conrelid
 where t.relname = 'rep_daily_briefs' and pg_get_constraintdef(c.oid) like '%kind%';

-- ROLLBACK (no deploy needed — the Recap card disappears; recaps already written stay stored, unread):
-- update public.app_settings set value = value || '{"eod_recap":false}'::jsonb, updated_at = now() where key = 'phase2_flags';
