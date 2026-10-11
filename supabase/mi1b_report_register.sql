-- ============================================================================================
-- MI-1b — MANUFACTURER REPORT HISTORY on the Manufacturer Center register `mfr_sources`.
-- Authorized for DEVELOPMENT by Angelo 2026-10-10 22:46 CT. NOT RUN IN PRODUCTION.
-- Run only after Angelo approves it: Supabase SQL editor, the committed file pasted verbatim,
-- its sha256 checked first. Safe to re-run. Rollback: supabase/mi1b_report_register_rollback.sql.
--
-- What it does (one transaction; ADDITIVE for the existing catalog sources):
--   1. Three REPORT kinds join the existing catalog kinds on mfr_sources:
--        sales_export · commission_statement · dealer_report
--      The catalog kinds (price_list, terms, catalog, images, cross_reference, status_list, other) and the
--      six production rows keep exactly their meaning, values and constraints. The unique
--      (manufacturer, file_sha256) index is kept as it is: one file is registered once, under one kind.
--   2. Report columns: report period, the manufacturer's prepared date (stated / not stated — never
--      invented), file size and type, supersession reason, PUBLICATION status (dealer reports only:
--      unpublished / published / withdrawn — separate from received/accepted), and an optional link to
--      the import batch a sales export / commission statement produced (never to a historical batch).
--   3. mfr_source_events — the append-only audit trail of every register / accept / reject / supersede
--      / publish / withdraw / batch-link, with who, when and why.
--   4. A guard trigger: report rows are written ONLY by the hcps_mfr_report_* functions; their file facts
--      (hash, storage path, dates, period, kind, manufacturer) never change; a report row is never deleted.
--      Catalog rows are not affected by the guard.
--   5. Functions (service_role only): register (idempotent), decide (accept / reject, supersession in the
--      same transaction), publication (publish needs MI-1c intelligence, which does not exist yet — so in
--      MI-1b nothing can be published), link_batch.
--
-- RULE 19 — stated per object:
--   * mfr_sources: unchanged (RLS on, no policies, closed to public/anon/authenticated, service_role only).
--   * mfr_source_events (+ its sequence): RLS ON, NO policies, revoke all from public/anon/authenticated,
--     service_role select/insert only — its default UPDATE/DELETE/TRUNCATE grants are revoked too
--     (append-only; the trigger also refuses update/delete/truncate for everyone, the owner included).
--   * Functions: execute revoked from public/anon/authenticated, granted to service_role.
--   * Storage: report files go to the EXISTING private bucket mfr-sources (no new bucket, no new policy).
--   After running: outside public-key probe on mfr_source_events and each function (expect 401 / 42501).
-- pg-safeupdate: every UPDATE / DELETE below carries a WHERE clause.
-- ============================================================================================
begin;

-- 0. Preconditions + fingerprint of the existing (catalog) rows over their ORIGINAL columns only.
do $$ begin
  if to_regclass('public.mfr_sources') is null then raise exception 'mi1b: mfr_sources missing — run the Manufacturer Center Phase 1 foundation first'; end if;
  if to_regclass('public.mfr_report_batches') is null then raise exception 'mi1b: mfr_report_batches missing — MI-1a Part 1 must be installed'; end if;
end $$;
create temp table _mi1b_before on commit drop as
select count(*) n, md5(coalesce(string_agg(concat_ws('|', id, manufacturer, kind, title, file_name, file_sha256, storage_path, received_date, legacy,
         manufacturer_effective_date, effective_date_status, supersedes_id, status, accepted_by, accepted_at, note, created_at, created_by), ';' order by id), '')) fp
from public.mfr_sources;

-- 1. Kinds: the catalog kinds, unchanged, plus the three report kinds.
alter table public.mfr_sources drop constraint if exists mfr_sources_kind_check;
alter table public.mfr_sources add constraint mfr_sources_kind_check check (kind in
  ('price_list','terms','catalog','images','cross_reference','status_list','other',
   'sales_export','commission_statement','dealer_report'));

create or replace function public.hcps_mfr_is_report_kind(p_kind text)
returns boolean language sql immutable as $$ select p_kind in ('sales_export','commission_statement','dealer_report') $$;

-- 2. Report columns (all NULL on every catalog row).
alter table public.mfr_sources
  add column if not exists report_period_start  date,
  add column if not exists report_period_end    date,
  add column if not exists prepared_date        date,
  add column if not exists prepared_date_status text,
  add column if not exists file_size            bigint,
  add column if not exists content_type         text,
  add column if not exists supersede_reason     text,
  add column if not exists publication_status   text,
  add column if not exists published_at         timestamptz,
  add column if not exists published_by         text,
  add column if not exists import_batch_id      uuid references public.mfr_report_batches(id),
  add column if not exists decided_reason       text;
comment on column public.mfr_sources.prepared_date is 'The date the MANUFACTURER says it prepared the report (e.g. "prepared 8 October 2026"). Stated or not stated — never invented, never the received date.';
comment on column public.mfr_sources.publication_status is 'Dealer reports only: unpublished / published / withdrawn. Independent of received/accepted — registering or accepting a report never publishes it.';
comment on column public.mfr_sources.import_batch_id is 'The MI-1a import batch this sales export / commission statement produced. Set only for a batch created after the file was registered; never back-filled to historical imports.';

do $$ begin
  -- Catalog rows carry none of the report fields (keeps the six existing rows and every future catalog row as they are).
  if not exists (select 1 from pg_constraint where conname='mfr_sources_catalog_shape') then
    alter table public.mfr_sources add constraint mfr_sources_catalog_shape check (hcps_mfr_is_report_kind(kind) or (
      report_period_start is null and report_period_end is null and prepared_date is null and prepared_date_status is null
      and file_size is null and content_type is null and supersede_reason is null and publication_status is null
      and published_at is null and published_by is null and import_batch_id is null and decided_reason is null));
  end if;
  -- A report row is a real stored file with a real received date, a period, and no catalog effective date.
  if not exists (select 1 from pg_constraint where conname='mfr_sources_report_shape') then
    alter table public.mfr_sources add constraint mfr_sources_report_shape check (not hcps_mfr_is_report_kind(kind) or (
      file_sha256 is not null and file_name is not null and received_date is not null and not legacy
      and storage_path is not null and starts_with(storage_path, 'reports/' || manufacturer || '/' || kind || '/' || file_sha256 || '.')
      and storage_path ~ '^reports/[a-z0-9-]+/[a-z_]+/[0-9a-f]{64}\.(pdf|xlsx|xls|csv)$'
      and file_size > 0 and content_type is not null
      and report_period_start is not null and report_period_end is not null and report_period_start <= report_period_end
      and effective_date_status = 'not_applicable' and manufacturer_effective_date is null
      and prepared_date_status in ('stated','not_stated')
      and (prepared_date_status = 'stated') = (prepared_date is not null)
      and (prepared_date is null or prepared_date <= received_date)
      and status in ('received','accepted','rejected','superseded')
      and (supersedes_id is null) = (supersede_reason is null)
      and (status <> 'rejected' or decided_reason is not null)));
  end if;
  -- Publication: dealer reports only; "published" needs an accepted report and a who/when.
  if not exists (select 1 from pg_constraint where conname='mfr_sources_publication') then
    alter table public.mfr_sources add constraint mfr_sources_publication check (
      (kind = 'dealer_report') = (publication_status is not null)
      and (publication_status is null or publication_status in ('unpublished','published','withdrawn'))
      and (publication_status is distinct from 'published' or (status = 'accepted' and published_at is not null and published_by is not null)));
  end if;
  -- Batch link: financial report kinds only, on an accepted file.
  if not exists (select 1 from pg_constraint where conname='mfr_sources_batch_link') then
    alter table public.mfr_sources add constraint mfr_sources_batch_link check (import_batch_id is null or
      (kind in ('sales_export','commission_statement') and status in ('accepted','superseded')));
  end if;
end $$;
-- One ACCEPTED report per manufacturer + kind + period (a correction supersedes; it never sits beside).
create unique index if not exists mfr_sources_report_period_uk on public.mfr_sources (manufacturer, kind, report_period_start, report_period_end)
  where kind in ('sales_export','commission_statement','dealer_report') and status = 'accepted';
-- One open correction per superseded report.
create unique index if not exists mfr_sources_open_correction_uk on public.mfr_sources (supersedes_id)
  where kind in ('sales_export','commission_statement','dealer_report') and status = 'received' and supersedes_id is not null;
-- One file per import batch.
create unique index if not exists mfr_sources_batch_uk on public.mfr_sources (import_batch_id) where import_batch_id is not null;
create index if not exists mfr_sources_report_idx on public.mfr_sources (manufacturer, kind, report_period_start desc)
  where kind in ('sales_export','commission_statement','dealer_report');

-- 3. Audit trail (append-only).
create table if not exists public.mfr_source_events (
  id         bigserial primary key,
  source_id  bigint not null references public.mfr_sources(id),
  action     text not null check (action in ('registered','accepted','rejected','superseded','published','withdrawn','batch_linked')),
  actor      text not null check (length(trim(actor)) > 0),
  reason     text,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index if not exists mfr_source_events_src_idx on public.mfr_source_events (source_id, at);
comment on table public.mfr_source_events is 'MI-1b audit trail for manufacturer report files: every register / accept / reject / supersede / publish / withdraw / batch link — who, when, why. Append-only.';
alter table public.mfr_source_events enable row level security;
revoke all on public.mfr_source_events from public, anon, authenticated;
revoke all on sequence public.mfr_source_events_id_seq from public, anon, authenticated;
revoke update, delete, truncate, references, trigger on public.mfr_source_events from service_role;   -- Supabase default grants give it ALL
grant select, insert on public.mfr_source_events to service_role;
grant usage, select on sequence public.mfr_source_events_id_seq to service_role;

create or replace function public.hcps_mfr_source_events_append_only()
returns trigger language plpgsql as $$
begin raise exception 'mfr_source_events is append-only: % refused', tg_op; end $$;
drop trigger if exists mfr_source_events_append_only on public.mfr_source_events;
create trigger mfr_source_events_append_only before update or delete on public.mfr_source_events
  for each row execute function public.hcps_mfr_source_events_append_only();
drop trigger if exists mfr_source_events_no_truncate on public.mfr_source_events;
create trigger mfr_source_events_no_truncate before truncate on public.mfr_source_events
  for each statement execute function public.hcps_mfr_source_events_append_only();

-- 4. Guard: report rows change only through the MI-1b functions, and their file facts never change.
create or replace function public.hcps_mfr_report_guard()
returns trigger language plpgsql as $$
declare v_old boolean := false; v_new boolean := false;
begin
  if tg_op in ('UPDATE','DELETE') then v_old := hcps_mfr_is_report_kind(old.kind); end if;
  if tg_op in ('UPDATE','INSERT') then v_new := hcps_mfr_is_report_kind(new.kind); end if;
  if not (v_old or v_new) then return coalesce(new, old); end if;          -- catalog rows: untouched by MI-1b
  if tg_op = 'DELETE' then raise exception 'mfr_report_guard: a manufacturer report record is never deleted (id %)', old.id; end if;
  if coalesce(current_setting('hcps.mfr_report_op', true), '') <> 'on' then
    raise exception 'mfr_report_guard: % of a manufacturer report record happens only through the hcps_mfr_report_* functions', tg_op;
  end if;
  if tg_op = 'UPDATE' and (new.manufacturer, new.kind, new.title, new.file_name, new.file_sha256, new.storage_path, new.file_size, new.content_type,
        new.received_date, new.legacy, new.prepared_date, new.prepared_date_status, new.report_period_start, new.report_period_end,
        new.manufacturer_effective_date, new.effective_date_status, new.supersedes_id, new.supersede_reason, new.note, new.created_at, new.created_by)
     is distinct from (old.manufacturer, old.kind, old.title, old.file_name, old.file_sha256, old.storage_path, old.file_size, old.content_type,
        old.received_date, old.legacy, old.prepared_date, old.prepared_date_status, old.report_period_start, old.report_period_end,
        old.manufacturer_effective_date, old.effective_date_status, old.supersedes_id, old.supersede_reason, old.note, old.created_at, old.created_by) then
    raise exception 'mfr_report_guard: the file facts of report % (file, hash, dates, period, kind, supersession) never change — register a correction instead', old.id;
  end if;
  return new;
end $$;
drop trigger if exists mfr_report_guard on public.mfr_sources;
create trigger mfr_report_guard before insert or update or delete on public.mfr_sources
  for each row execute function public.hcps_mfr_report_guard();

-- 5. Functions.
-- 5a. REGISTER — idempotent: the same file (manufacturer + sha256) returns the existing record and writes nothing.
create or replace function public.hcps_mfr_report_register(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_mfr text := nullif(trim(p->>'manufacturer'), ''); v_kind text := p->>'kind'; v_sha text := lower(p->>'file_sha256');
  v_actor text := nullif(trim(p->>'actor'), ''); v_ex public.mfr_sources; v_sup public.mfr_sources; v_dup bigint; v_id bigint;
  v_start date := (p->>'report_period_start')::date; v_end date := (p->>'report_period_end')::date;
  v_prep date := nullif(p->>'prepared_date','')::date; v_recv date := (p->>'received_date')::date;
  v_supid bigint := nullif(p->>'supersedes_id','')::bigint; v_supr text := nullif(trim(p->>'supersede_reason'), '');
begin
  if v_actor is null then raise exception 'mi1b_actor_required'; end if;
  if v_mfr is null or not hcps_mfr_is_report_kind(v_kind) then raise exception 'mi1b_bad_kind: manufacturer and a report kind (sales_export, commission_statement, dealer_report) are required'; end if;
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then raise exception 'mi1b_bad_hash'; end if;
  select * into v_ex from public.mfr_sources where manufacturer = v_mfr and file_sha256 = v_sha;
  if found then
    if v_ex.kind <> v_kind then
      raise exception 'mi1b_hash_registered_as_other_kind: this file is already registered for % as % (record %)', v_mfr, v_ex.kind, v_ex.id;
    end if;
    return jsonb_build_object('ok', true, 'existing', true, 'id', v_ex.id, 'status', v_ex.status);
  end if;
  if v_recv is null then raise exception 'mi1b_received_date_required'; end if;
  if v_start is null or v_end is null or v_start > v_end then raise exception 'mi1b_bad_period'; end if;
  if v_supid is not null then
    select * into v_sup from public.mfr_sources where id = v_supid for update;
    if not found or v_sup.manufacturer <> v_mfr or v_sup.kind <> v_kind then
      raise exception 'mi1b_bad_supersedes: record % is not a % report of %', v_supid, v_kind, v_mfr; end if;
    if v_sup.status <> 'accepted' then raise exception 'mi1b_bad_supersedes: only an accepted report is corrected (record % is %)', v_supid, v_sup.status; end if;
    if v_supr is null then raise exception 'mi1b_supersede_reason_required'; end if;
  else
    if v_supr is not null then raise exception 'mi1b_bad_supersedes: a reason was given without the record it corrects'; end if;
    select id into v_dup from public.mfr_sources
     where manufacturer = v_mfr and kind = v_kind and report_period_start = v_start and report_period_end = v_end
       and status in ('received','accepted') limit 1;
    if v_dup is not null then
      raise exception 'mi1b_period_already_registered: record % already covers this period — register this file as a correction of it, or reject that one first', v_dup;
    end if;
  end if;
  perform set_config('hcps.mfr_report_op', 'on', true);
  begin
    insert into public.mfr_sources (manufacturer, kind, title, file_name, file_sha256, storage_path, file_size, content_type,
      received_date, legacy, prepared_date, prepared_date_status, report_period_start, report_period_end,
      effective_date_status, supersedes_id, supersede_reason, status, publication_status, note, created_by)
    values (v_mfr, v_kind, coalesce(nullif(trim(p->>'title'), ''), p->>'file_name'), p->>'file_name', v_sha, p->>'storage_path',
      (p->>'file_size')::bigint, p->>'content_type', v_recv, false, v_prep, case when v_prep is null then 'not_stated' else 'stated' end,
      v_start, v_end, 'not_applicable', v_supid, v_supr, 'received',
      case when v_kind = 'dealer_report' then 'unpublished' end, nullif(trim(p->>'note'), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    -- the same file registered at the same moment by another request: return that one, write nothing more
    perform set_config('hcps.mfr_report_op', 'off', true);
    select * into v_ex from public.mfr_sources where manufacturer = v_mfr and file_sha256 = v_sha;
    if found and v_ex.kind = v_kind then return jsonb_build_object('ok', true, 'existing', true, 'id', v_ex.id, 'status', v_ex.status); end if;
    raise;
  end;
  insert into public.mfr_source_events (source_id, action, actor, reason, detail)
  values (v_id, 'registered', v_actor, v_supr, jsonb_build_object('kind', v_kind, 'file_name', p->>'file_name', 'file_sha256', v_sha,
    'file_size', (p->>'file_size')::bigint, 'received_date', v_recv, 'prepared_date', v_prep,
    'report_period', jsonb_build_array(v_start, v_end), 'supersedes_id', v_supid));
  perform set_config('hcps.mfr_report_op', 'off', true);
  return jsonb_build_object('ok', true, 'existing', false, 'id', v_id, 'status', 'received');
end $$;

-- 5b. DECIDE — accept or reject a received report. Accepting a correction supersedes the report it corrects
--     (and withdraws that report's publication) in the same transaction.
create or replace function public.hcps_mfr_report_decide(p jsonb)
returns jsonb language plpgsql as $$
declare v_id bigint := (p->>'id')::bigint; v_dec text := p->>'decision'; v_actor text := nullif(trim(p->>'actor'), '');
        v_reason text := nullif(trim(p->>'reason'), ''); v_r public.mfr_sources; v_old public.mfr_sources; v_dup bigint;
begin
  if v_actor is null then raise exception 'mi1b_actor_required'; end if;
  if v_dec not in ('accepted','rejected') then raise exception 'mi1b_bad_decision: accepted or rejected'; end if;
  select * into v_r from public.mfr_sources where id = v_id for update;
  if not found or not hcps_mfr_is_report_kind(v_r.kind) then raise exception 'mi1b_not_a_report: %', v_id; end if;
  if v_r.status <> 'received' then raise exception 'mi1b_already_decided: record % is %', v_id, v_r.status; end if;
  if v_dec = 'rejected' and v_reason is null then raise exception 'mi1b_reason_required: a rejection needs a reason'; end if;
  perform set_config('hcps.mfr_report_op', 'on', true);
  if v_dec = 'accepted' then
    if v_r.supersedes_id is not null then
      select * into v_old from public.mfr_sources where id = v_r.supersedes_id for update;
      if v_old.status <> 'accepted' then raise exception 'mi1b_bad_supersedes: record % is % — nothing to supersede', v_old.id, v_old.status; end if;
      update public.mfr_sources set status = 'superseded',
             publication_status = case when publication_status = 'published' then 'withdrawn' else publication_status end
       where id = v_old.id;
      insert into public.mfr_source_events (source_id, action, actor, reason, detail)
      values (v_old.id, 'superseded', v_actor, v_r.supersede_reason, jsonb_build_object('by', v_r.id));
      if v_old.publication_status = 'published' then
        insert into public.mfr_source_events (source_id, action, actor, reason, detail)
        values (v_old.id, 'withdrawn', v_actor, 'superseded by record ' || v_r.id, jsonb_build_object('by', v_r.id));
      end if;
    else
      select id into v_dup from public.mfr_sources where manufacturer = v_r.manufacturer and kind = v_r.kind and status = 'accepted'
         and report_period_start = v_r.report_period_start and report_period_end = v_r.report_period_end and id <> v_r.id limit 1;
      if v_dup is not null then raise exception 'mi1b_period_already_accepted: record % is the accepted report for this period', v_dup; end if;
    end if;
    update public.mfr_sources set status = 'accepted', accepted_by = v_actor, accepted_at = now(), decided_reason = v_reason where id = v_id;
  else
    update public.mfr_sources set status = 'rejected', decided_reason = v_reason where id = v_id;
  end if;
  insert into public.mfr_source_events (source_id, action, actor, reason, detail)
  values (v_id, v_dec, v_actor, v_reason, jsonb_build_object('supersedes_id', v_r.supersedes_id));
  perform set_config('hcps.mfr_report_op', 'off', true);
  return jsonb_build_object('ok', true, 'id', v_id, 'status', v_dec, 'superseded_id', case when v_dec = 'accepted' then v_r.supersedes_id end);
end $$;

-- 5c. PUBLICATION — dealer reports only. Publishing needs staged MI-1c intelligence for this report
--     (public.mfr_dealer_snapshots rows with source_id = the report). MI-1c is not installed, so in MI-1b
--     every publish is refused: registering or accepting a PDF can never make it visible.
create or replace function public.hcps_mfr_report_publication(p jsonb)
returns jsonb language plpgsql as $$
declare v_id bigint := (p->>'id')::bigint; v_act text := p->>'action'; v_actor text := nullif(trim(p->>'actor'), '');
        v_reason text := nullif(trim(p->>'reason'), ''); v_r public.mfr_sources; v_n bigint;
begin
  if v_actor is null then raise exception 'mi1b_actor_required'; end if;
  select * into v_r from public.mfr_sources where id = v_id for update;
  if not found or v_r.kind <> 'dealer_report' then raise exception 'mi1b_not_a_dealer_report: only a dealer-intelligence report is published'; end if;
  if v_act = 'publish' then
    if v_r.status <> 'accepted' then raise exception 'mi1b_not_accepted: record % is % — only an accepted report is published', v_id, v_r.status; end if;
    if v_r.publication_status = 'published' then return jsonb_build_object('ok', true, 'id', v_id, 'publication_status', 'published', 'unchanged', true); end if;
    if to_regclass('public.mfr_dealer_snapshots') is null then
      raise exception 'mi1b_publish_unavailable: no dealer intelligence is staged for record % (MI-1c is not installed)', v_id; end if;
    execute 'select count(*) from public.mfr_dealer_snapshots where source_id = $1' into v_n using v_id;
    if v_n = 0 then raise exception 'mi1b_publish_unavailable: no dealer intelligence is staged for record %', v_id; end if;
    perform set_config('hcps.mfr_report_op', 'on', true);
    update public.mfr_sources set publication_status = 'published', published_at = now(), published_by = v_actor where id = v_id;
    insert into public.mfr_source_events (source_id, action, actor, reason, detail) values (v_id, 'published', v_actor, v_reason, jsonb_build_object('snapshots', v_n));
  elsif v_act = 'withdraw' then
    if v_reason is null then raise exception 'mi1b_reason_required: withdrawing a published report needs a reason'; end if;
    if v_r.publication_status <> 'published' then raise exception 'mi1b_not_published: record % is %', v_id, v_r.publication_status; end if;
    perform set_config('hcps.mfr_report_op', 'on', true);
    update public.mfr_sources set publication_status = 'withdrawn' where id = v_id;
    insert into public.mfr_source_events (source_id, action, actor, reason) values (v_id, 'withdrawn', v_actor, v_reason);
  else raise exception 'mi1b_bad_action: publish or withdraw'; end if;
  perform set_config('hcps.mfr_report_op', 'off', true);
  return jsonb_build_object('ok', true, 'id', v_id, 'publication_status', case when v_act = 'publish' then 'published' else 'withdrawn' end);
end $$;

-- 5d. LINK BATCH — an accepted sales export / commission statement → the MI-1a batch it produced.
--     Refused for a batch created BEFORE the file was registered (no links to historical imports), a
--     different manufacturer, the wrong lane, a rolled-back batch, or a batch whose file name differs.
create or replace function public.hcps_mfr_report_link_batch(p jsonb)
returns jsonb language plpgsql as $$
declare v_id bigint := (p->>'id')::bigint; v_bid uuid := (p->>'batch_id')::uuid; v_actor text := nullif(trim(p->>'actor'), '');
        v_r public.mfr_sources; v_b public.mfr_report_batches;
begin
  if v_actor is null then raise exception 'mi1b_actor_required'; end if;
  select * into v_r from public.mfr_sources where id = v_id for update;
  if not found or v_r.kind not in ('sales_export','commission_statement') then raise exception 'mi1b_bad_link: only a sales export or commission statement links to an import batch'; end if;
  if v_r.status <> 'accepted' then raise exception 'mi1b_bad_link: record % is %', v_id, v_r.status; end if;
  if v_r.import_batch_id is not null then
    if v_r.import_batch_id = v_bid then return jsonb_build_object('ok', true, 'id', v_id, 'batch_id', v_bid, 'unchanged', true); end if;
    raise exception 'mi1b_bad_link: record % is already linked to batch %', v_id, v_r.import_batch_id;
  end if;
  select * into v_b from public.mfr_report_batches where id = v_bid;
  if not found then raise exception 'mi1b_bad_link: no batch %', v_bid; end if;
  if v_b.manufacturer <> v_r.manufacturer then raise exception 'mi1b_bad_link: batch % is for %', v_bid, v_b.manufacturer; end if;
  if v_b.lane <> (case v_r.kind when 'sales_export' then 'sales_report' else 'commission' end) then
    raise exception 'mi1b_bad_link: batch % is a % batch', v_bid, v_b.lane; end if;
  if v_b.status <> 'imported' then raise exception 'mi1b_bad_link: batch % is %', v_bid, v_b.status; end if;
  if v_b.created_at < v_r.created_at then
    raise exception 'mi1b_bad_link: batch % predates the registration of record % — historical imports are never linked', v_bid, v_id; end if;
  if v_b.source_file is not null and v_b.source_file <> v_r.file_name then
    raise exception 'mi1b_bad_link: batch % was imported from "%", not "%"', v_bid, v_b.source_file, v_r.file_name; end if;
  perform set_config('hcps.mfr_report_op', 'on', true);
  update public.mfr_sources set import_batch_id = v_bid where id = v_id;
  insert into public.mfr_source_events (source_id, action, actor, detail) values (v_id, 'batch_linked', v_actor, jsonb_build_object('batch_id', v_bid));
  perform set_config('hcps.mfr_report_op', 'off', true);
  return jsonb_build_object('ok', true, 'id', v_id, 'batch_id', v_bid);
end $$;

-- 6. Execute rights: service_role only (RULE 19).
do $$ declare f text; begin
  foreach f in array array['public.hcps_mfr_is_report_kind(text)', 'public.hcps_mfr_source_events_append_only()', 'public.hcps_mfr_report_guard()',
    'public.hcps_mfr_report_register(jsonb)', 'public.hcps_mfr_report_decide(jsonb)', 'public.hcps_mfr_report_publication(jsonb)',
    'public.hcps_mfr_report_link_batch(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 7. Proof: the existing (catalog) rows are exactly as they were, and none carries report fields.
do $$ declare b record; a record; begin
  select * into b from _mi1b_before;
  select count(*) n, md5(coalesce(string_agg(concat_ws('|', id, manufacturer, kind, title, file_name, file_sha256, storage_path, received_date, legacy,
           manufacturer_effective_date, effective_date_status, supersedes_id, status, accepted_by, accepted_at, note, created_at, created_by), ';' order by id), '')) fp
    into a from public.mfr_sources;
  if a.n <> b.n or a.fp <> b.fp then raise exception 'mi1b: existing source records changed (% / % -> % / %)', b.n, b.fp, a.n, a.fp; end if;
end $$;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'existing source records (catalog kinds) keep their kinds; no report fields on them' check_name,
         count(*)::text value, count(*) filter (where report_period_start is not null or publication_status is not null) = 0 ok
    from public.mfr_sources where not public.hcps_mfr_is_report_kind(kind)
  union all select 2, 'unique (manufacturer, file_sha256) index unchanged',
         (select indexdef from pg_indexes where indexname = 'mfr_sources_file_uk'),
         (select indexdef from pg_indexes where indexname = 'mfr_sources_file_uk') = 'CREATE UNIQUE INDEX mfr_sources_file_uk ON public.mfr_sources USING btree (manufacturer, file_sha256) WHERE (file_sha256 IS NOT NULL)'
  union all select 3, 'mfr_source_events: RLS on, 0 policies', (select relrowsecurity::text from pg_class where oid = 'public.mfr_source_events'::regclass),
         (select relrowsecurity from pg_class where oid = 'public.mfr_source_events'::regclass) and not exists (select 1 from pg_policy where polrelid = 'public.mfr_source_events'::regclass)
  union all select 4, 'grants to anon / authenticated / PUBLIC on mfr_source_events (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'mfr_source_events' and grantee in ('anon','authenticated','PUBLIC')
  union all select 45, 'service_role cannot update / delete / truncate mfr_source_events',
         (has_table_privilege('service_role','public.mfr_source_events','update') or has_table_privilege('service_role','public.mfr_source_events','delete')
          or has_table_privilege('service_role','public.mfr_source_events','truncate'))::text,
         not (has_table_privilege('service_role','public.mfr_source_events','update') or has_table_privilege('service_role','public.mfr_source_events','delete')
          or has_table_privilege('service_role','public.mfr_source_events','truncate'))
  union all select 5, 'MI-1b functions executable by anon / authenticated (expect 0)', count(*)::text, count(*) = 0
    from pg_proc p cross join unnest(array['anon','authenticated']) r
   where p.pronamespace = 'public'::regnamespace and p.proname like 'hcps_mfr_%' and has_function_privilege(r, p.oid, 'execute')
  union all select 6, 'guard trigger installed on mfr_sources', count(*)::text, count(*) = 1
    from pg_trigger where tgrelid = 'public.mfr_sources'::regclass and tgname = 'mfr_report_guard'
  union all select 7, 'report records (expect 0 right after install)', count(*)::text, count(*) = 0
    from public.mfr_sources where public.hcps_mfr_is_report_kind(kind)
) x order by n;
