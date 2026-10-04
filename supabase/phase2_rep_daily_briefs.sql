-- Phase 2B · AI Morning Brief — 2026-10-03
--
-- What this adds:
--   1. rep_daily_briefs — one stored brief per person, day and kind ('morning' now; 'eod' is Unit 2C).
--      Written by rep-command-api only (service role; RLS on, no policies, like every table here).
--      status       generating | ready | failed — the row is also the lock that stops a second tab or a
--                   double tap from paying for a second brief
--      content      the brief (headline, focus items, watch-outs, first-stop tip, the ranked signals)
--      inputs       the facts it was written from ("why did it say that")
--      signals_key  a digest of those facts; when today's facts no longer match, the card says
--                   "Things changed since this brief"
--      attempted_at the last generation attempt — one attempt per person per 10 minutes
--   2. Turns the morning_brief switch on (phase2_flags). Every other switch is left as it is.
--
-- SAFE TO RE-RUN. Creates one table and one index, sets one switch. Changes no existing value and
-- removes nothing. Nothing in this table is ever pushed to Zoho.

begin;

create table if not exists public.rep_daily_briefs (
  id            uuid primary key default gen_random_uuid(),
  rep_email     text not null,
  brief_date    date not null,
  kind          text not null check (kind in ('morning','eod')),
  status        text not null default 'ready' check (status in ('generating','ready','failed')),
  content       jsonb not null default '{}'::jsonb,
  inputs        jsonb,
  signals_key   text,
  model         text,
  generated_by  text,
  generated_at  timestamptz,
  attempted_at  timestamptz not null default now(),
  error         text,
  unique (rep_email, brief_date, kind)
);
create index if not exists rep_daily_briefs_date_idx on public.rep_daily_briefs (brief_date);
alter table public.rep_daily_briefs enable row level security;   -- server-only, like every table here

insert into public.app_settings (key, value, updated_at)
values ('phase2_flags',
        '{"adhoc_visit":true,"morning_brief":true,"eod_recap":false,"timeline":false,"conversion":false,"device_check":false}'::jsonb,
        now())
on conflict (key) do update
  set value = public.app_settings.value || '{"morning_brief":true}'::jsonb, updated_at = now();

commit;

notify pgrst, 'reload schema';

-- Check:
select key, value from public.app_settings where key = 'phase2_flags';
select count(*) as briefs_stored from public.rep_daily_briefs;

-- ROLLBACK
--   Step 1 (no deploy needed — the Morning Brief card disappears and the brief action answers
--   "isn't turned on yet"; the Command Center is exactly Phase 1 again):
-- update public.app_settings set value = value || '{"morning_brief":false}'::jsonb, updated_at = now() where key = 'phase2_flags';
--   Step 2 (only if the code is rolled back too, and only if you no longer want the stored briefs —
--   they are AI text about your own day, nothing else reads them):
-- drop table if exists public.rep_daily_briefs;
