-- HCPS Connect 360 — Phase 1: Dealer 360 Visit Intelligence + Sales Rep Command Center.
--
-- Builds on the EXISTING records only — no parallel systems:
--   dealer_visit_reports   the visit itself (Start → End → approved summary → follow-up status)
--   dealer_visit_participants (NEW) who attended, each linked to a normal dealer_contacts row
--   dealer_tasks / opportunities   approved follow-ups and deals, linked back to the visit
--   dealer_activity / dealer_visits  the timeline row and visit-log row, linked to the visit
--
-- Every link is (origin_type, origin_id, origin_key): origin_type = 'visit_report', origin_id = the
-- report id, origin_key = the id of the approved suggestion. The unique indexes below make an
-- approval replay (double tap, offline outbox, lost response) a no-op instead of a duplicate.
--
-- SAFE TO RE-RUN. Adds columns, one table and indexes; changes no existing value; removes nothing.
-- The app works before this runs (the new features show "run the Phase 1 migration" until it has).

-- 1) Visit lifecycle on the existing visit record ------------------------------------------------
alter table public.dealer_visit_reports add column if not exists ended_at              timestamptz;
alter table public.dealer_visit_reports add column if not exists duration_min          integer;
alter table public.dealer_visit_reports add column if not exists ai_suggestion         jsonb;
alter table public.dealer_visit_reports add column if not exists ai_suggested_at       timestamptz;
alter table public.dealer_visit_reports add column if not exists summary               jsonb;
alter table public.dealer_visit_reports add column if not exists approved_at           timestamptz;
alter table public.dealer_visit_reports add column if not exists approved_by           text;
alter table public.dealer_visit_reports add column if not exists followup_status       text;
alter table public.dealer_visit_reports add column if not exists followup_due          date;
alter table public.dealer_visit_reports add column if not exists followup_completed_at timestamptz;
alter table public.dealer_visit_reports add column if not exists followup_manual       boolean not null default false;
alter table public.dealer_visit_reports add column if not exists followup_email        jsonb;
alter table public.dealer_visit_reports add column if not exists origin                text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dealer_visit_reports_followup_status_chk') then
    alter table public.dealer_visit_reports add constraint dealer_visit_reports_followup_status_chk
      check (followup_status is null or followup_status in ('none','pending','complete'));
  end if;
end $$;

create index if not exists dealer_visit_reports_rep_checkin_idx on public.dealer_visit_reports (lower(rep_email), checkin_at desc);
create index if not exists dealer_visit_reports_followup_idx    on public.dealer_visit_reports (followup_status) where followup_status = 'pending';
create index if not exists dealer_visit_reports_dealer_idx      on public.dealer_visit_reports (dealer_id, checkin_at desc);

-- 2) Meeting participants — linked to the existing dealer_contacts (no second contact store) -----
create table if not exists public.dealer_visit_participants (
  id               uuid primary key default gen_random_uuid(),
  visit_report_id  uuid not null references public.dealer_visit_reports(id) on delete cascade,
  dealer_id        uuid not null,
  contact_id       uuid references public.dealer_contacts(id) on delete set null,
  name_key         text not null,               -- lower(trim(name)) — one row per person per visit
  name_snapshot    text not null,               -- kept even if the contact is later deleted
  title_snapshot   text,
  email_snapshot   text,
  attended         boolean not null default true,
  source           text not null default 'rep', -- ai | rep
  created_by       text,
  created_at       timestamptz not null default now(),
  constraint dealer_visit_participants_once unique (visit_report_id, name_key)
);
create index if not exists dealer_visit_participants_contact_idx on public.dealer_visit_participants (contact_id);
create index if not exists dealer_visit_participants_dealer_idx  on public.dealer_visit_participants (dealer_id, created_at desc);
alter table public.dealer_visit_participants enable row level security;   -- server-only, like every table here

-- 3) Tasks: where a task came from (one shared helper writes these) ------------------------------
alter table public.dealer_tasks add column if not exists origin_type  text;
alter table public.dealer_tasks add column if not exists origin_id    text;
alter table public.dealer_tasks add column if not exists origin_key   text;
alter table public.dealer_tasks add column if not exists ai_generated boolean not null default false;
alter table public.dealer_tasks add column if not exists updated_at   timestamptz;
create unique index if not exists dealer_tasks_origin_once on public.dealer_tasks (origin_type, origin_id, origin_key);
create index if not exists dealer_tasks_origin_idx on public.dealer_tasks (origin_type, origin_id);
create index if not exists dealer_tasks_due_open_idx on public.dealer_tasks (due_date) where status = 'open';

-- 4) Opportunities: where a deal came from + the detail a meeting gives ---------------------------
--    Zoho sync reads named columns only, so none of these reach Zoho (Phase 1 keeps Zoho as is).
alter table public.opportunities add column if not exists origin_type      text;
alter table public.opportunities add column if not exists origin_id        text;
alter table public.opportunities add column if not exists origin_key       text;
alter table public.opportunities add column if not exists manufacturer     text;   -- slug, beside the free-text line
alter table public.opportunities add column if not exists product          text;   -- product / model, e.g. PR519
alter table public.opportunities add column if not exists quantity         numeric;
alter table public.opportunities add column if not exists contact_id       uuid;
alter table public.opportunities add column if not exists next_step        text;
alter table public.opportunities add column if not exists next_step_date   date;
alter table public.opportunities add column if not exists stage_changed_at timestamptz;
alter table public.opportunities add column if not exists updated_by       text;
create unique index if not exists opportunities_origin_once on public.opportunities (origin_type, origin_id, origin_key);
create index if not exists opportunities_origin_idx on public.opportunities (origin_type, origin_id);
create index if not exists opportunities_owner_open_idx on public.opportunities (lower(owner_email)) where status = 'open';

-- 5) Timeline and visit-log rows point at their visit (one of each per visit) ---------------------
alter table public.dealer_activity add column if not exists ref_type    text;
alter table public.dealer_activity add column if not exists ref_id      text;
alter table public.dealer_activity add column if not exists actor_email text;
create index if not exists dealer_activity_ref_idx on public.dealer_activity (ref_type, ref_id);
alter table public.dealer_visits add column if not exists visit_report_id uuid;
create unique index if not exists dealer_visits_report_once on public.dealer_visits (visit_report_id);

-- Check (read-only): what this added.
select 'visit lifecycle columns' as what, count(*)::text as result from information_schema.columns
  where table_schema='public' and table_name='dealer_visit_reports'
    and column_name in ('ended_at','duration_min','ai_suggestion','ai_suggested_at','summary','approved_at','approved_by',
                        'followup_status','followup_due','followup_completed_at','followup_manual','followup_email','origin')
union all
select 'participants table', case when to_regclass('public.dealer_visit_participants') is null then 'missing' else 'ready' end
union all
select 'task origin columns', count(*)::text from information_schema.columns
  where table_schema='public' and table_name='dealer_tasks' and column_name in ('origin_type','origin_id','origin_key','ai_generated','updated_at')
union all
select 'opportunity columns', count(*)::text from information_schema.columns
  where table_schema='public' and table_name='opportunities'
    and column_name in ('origin_type','origin_id','origin_key','manufacturer','product','quantity','contact_id','next_step','next_step_date','stage_changed_at','updated_by')
union all
select 'activity + visit-log links', count(*)::text from information_schema.columns
  where table_schema='public' and ((table_name='dealer_activity' and column_name in ('ref_type','ref_id','actor_email'))
                                or (table_name='dealer_visits' and column_name='visit_report_id'));
