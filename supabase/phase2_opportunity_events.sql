-- Phase 2E · Opportunity stage history (audit layer) — 2026-10-05
--
-- What this adds — and nothing else:
--   1. opportunity_events: one row per stage or status change of an EXISTING opportunity (the same
--      `opportunities` table and the same five stages; no second deal system).
--        kind       baseline  this deal's stage when history started (NOT a move — its past is unknown)
--                   created   the deal was created (its first stage)
--                   change    the stage and/or status changed
--        from_/to_stage, from_/to_status, value (at the time), changed_at — written by the database
--        itself, so they are authoritative whichever code path made the change.
--        source / changed_by — ONLY when reliably known, otherwise 'unknown' (never guessed):
--          pipeline  the Pipeline page (it says so on the request: x-hcps-source / x-hcps-actor)
--          visit     a deal created from a visit (the row itself carries the visit origin)
--          baseline  the starting entries below (changed_by 'system')
--          unknown   anything else — e.g. a stage pulled in from Zoho (the pull sends no context)
--   2. Two triggers on opportunities: BEFORE UPDATE OF stage stamps stage_changed_at when the writer
--      didn't (the Zoho pull doesn't); AFTER INSERT OR UPDATE OF stage, status writes the event. A
--      failure while writing history never blocks the deal write itself.
--   3. One baseline entry per existing deal (skipped for any deal that already has history), so
--      time in stage and win rate are measured only from here on — no earlier history is invented.
--   4. Turns on the `conversion` switch (Pipeline → Conversion tab + each deal's Stage history). Every
--      other Phase 2 switch is left exactly as it is. Rollback at the bottom.
--
-- Zoho: unchanged. Its push reads named columns of opportunities only (never this table, never
-- stage_changed_at), and the stage mapping is untouched. SAFE TO RE-RUN: no duplicate baselines.

begin;

alter table public.opportunities add column if not exists stage_changed_at timestamptz;

create table if not exists public.opportunity_events (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null,
  dealer_id      uuid,
  kind           text not null check (kind in ('baseline','created','change')),
  from_stage     text,
  to_stage       text,
  from_status    text,
  to_status      text,
  value          numeric,
  changed_by     text not null default 'unknown',
  source         text not null default 'unknown' check (source in ('pipeline','visit','baseline','system','unknown')),
  changed_at     timestamptz not null default now()
);
create index if not exists opportunity_events_opp_idx  on public.opportunity_events (opportunity_id, changed_at);
create index if not exists opportunity_events_time_idx on public.opportunity_events (changed_at);
-- At most one starting point per deal: one baseline, one "created".
create unique index if not exists opportunity_events_one_baseline on public.opportunity_events (opportunity_id) where kind = 'baseline';
create unique index if not exists opportunity_events_one_created  on public.opportunity_events (opportunity_id) where kind = 'created';
alter table public.opportunity_events enable row level security;   -- server-only, like every table here

-- The writer's context, when it gave one (PostgREST passes request headers to the database).
create or replace function public.hcps_opp_ctx(name text) returns text
language plpgsql stable as $$
declare h json; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
    v := h ->> name;
  exception when others then v := null;
  end;
  if v is null then v := nullif(current_setting('request.header.' || name, true), ''); end if;
  return nullif(left(btrim(coalesce(v, '')), 200), '');
end $$;

create or replace function public.hcps_opportunity_stage_stamp() returns trigger
language plpgsql as $$
begin
  if new.stage is distinct from old.stage and new.stage_changed_at is not distinct from old.stage_changed_at then
    new.stage_changed_at := now();
  end if;
  return new;
end $$;

create or replace function public.hcps_opportunity_event() returns trigger
language plpgsql as $$
declare src text; actor text; k text;
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage and new.status is not distinct from old.status then
    return null;
  end if;
  begin
    src := lower(public.hcps_opp_ctx('x-hcps-source'));
    actor := lower(public.hcps_opp_ctx('x-hcps-actor'));
    if src is distinct from 'pipeline' then src := null; actor := null; end if;   -- only the Pipeline sends context
    if tg_op = 'INSERT' then
      k := 'created';
      -- A deal created from a visit says so in its own row (origin, or the legacy visit source).
      if src is null and (new.origin_type = 'visit_report' or new.source = 'visit') then
        src := 'visit'; actor := lower(nullif(btrim(coalesce(new.updated_by, new.created_by, '')), ''));
      end if;
      insert into public.opportunity_events (opportunity_id, dealer_id, kind, from_stage, to_stage, from_status, to_status, value, changed_by, source, changed_at)
      values (new.id, new.dealer_id, k, null, new.stage, null, new.status, new.value, coalesce(actor, 'unknown'), coalesce(src, 'unknown'), coalesce(new.created_at, now()))
      on conflict (opportunity_id) where kind = 'created' do nothing;
    else
      insert into public.opportunity_events (opportunity_id, dealer_id, kind, from_stage, to_stage, from_status, to_status, value, changed_by, source, changed_at)
      values (new.id, new.dealer_id, 'change', old.stage, new.stage, old.status, new.status, new.value, coalesce(actor, 'unknown'), coalesce(src, 'unknown'), now());
    end if;
  exception when others then
    raise warning 'opportunity history not recorded for %: %', new.id, sqlerrm;   -- never block the deal write
  end;
  return null;
end $$;

drop trigger if exists hcps_opportunity_stage_stamp on public.opportunities;
create trigger hcps_opportunity_stage_stamp before update of stage on public.opportunities
  for each row execute function public.hcps_opportunity_stage_stamp();

drop trigger if exists hcps_opportunity_event on public.opportunities;
create trigger hcps_opportunity_event after insert or update of stage, status on public.opportunities
  for each row execute function public.hcps_opportunity_event();

-- Baseline: where each existing deal stands now. A deal that already has any history is skipped.
insert into public.opportunity_events (opportunity_id, dealer_id, kind, from_stage, to_stage, from_status, to_status, value, changed_by, source, changed_at)
select o.id, o.dealer_id, 'baseline', null, o.stage, null, o.status, o.value, 'system', 'baseline', now()
  from public.opportunities o
 where not exists (select 1 from public.opportunity_events e where e.opportunity_id = o.id);

-- Turn on the Conversion tab and deal history (phase2_flags.conversion). Every other switch is left as it is.
insert into public.app_settings (key, value, updated_at)
values ('phase2_flags',
        '{"adhoc_visit":true,"morning_brief":true,"eod_recap":true,"timeline":true,"conversion":true,"device_check":false}'::jsonb,
        now())
on conflict (key) do update
  set value = public.app_settings.value || '{"conversion":true}'::jsonb, updated_at = now();

commit;

notify pgrst, 'reload schema';

-- Check: one baseline per existing deal, nothing else yet.
select kind, count(*) as entries, count(distinct opportunity_id) as deals from public.opportunity_events group by kind order by kind;
select count(*) as deals_total from public.opportunities;

-- ROLLBACK
--   Step 1 (no deploy needed — the Conversion tab and deal history disappear; Pipeline is as before):
-- update public.app_settings set value = value || '{"conversion":false}'::jsonb, updated_at = now() where key = 'phase2_flags';
--   Step 2 (stop recording; the history rows are kept unless you ask to drop them):
-- drop trigger if exists hcps_opportunity_event on public.opportunities;
-- drop trigger if exists hcps_opportunity_stage_stamp on public.opportunities;
