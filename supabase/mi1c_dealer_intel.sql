-- ============================================================================================
-- MI-1c — MANUFACTURER DEALER INTELLIGENCE (first source: Strongback's monthly dealer report PDF).
-- Authorized for DEVELOPMENT by Angelo 2026-10-11 09:31 CT. NOT RUN IN PRODUCTION.
-- Run only after Angelo approves it: Supabase SQL editor, the committed file pasted verbatim, its sha256 checked
-- first. Safe to re-run. Rollback: supabase/mi1c_dealer_intel_rollback.sql. Needs MI-1b (mfr_sources report kinds).
--
-- What it adds (one transaction; nothing existing is changed — not mfr_sources, not dealers, not monthly_sales):
--   mfr_intel_reports      — one row per imported report FILE (an accepted dealer_report in mfr_sources): the report's
--                            own headline figures, sections, footnote, footer and every validation check, as printed.
--   mfr_dealer_snapshots   — one row per dealer the report prints: Strongback's tier, trend, amounts, last order,
--                            ErgoSteel and chair-on-the-floor wording, AS PRINTED, plus the HCPS match proposal.
--   mfr_dealer_observations— dated lines from the dealer pages (contact people, product lines, "what they told us",
--                            "our last contacts") and report-level offers, each attributed to the manufacturer.
--   mfr_intel_events       — append-only audit: every import and every match decision, who / when / why.
--   hcps_mfr_intel_import(p jsonb) — the ONLY way rows are written (one transaction, idempotent).
--   hcps_mfr_intel_match(p jsonb)  — the ONLY way a match changes (a person's decision, with a reason).
--
-- Separation (RULE, MI-1c authorization 2026-10-11):
--   * Manufacturer-reported amounts, trends, tiers, contacts and notes live ONLY here. Nothing here writes or is
--     summed into monthly_sales, commissions, dealers, dealer_contacts, dealer_aliases, dealer_manufacturers,
--     dealer_tasks, opportunities, campaigns or Zoho. A match links a snapshot to an HCPS dealer; it never changes
--     that dealer, its rep (dealers.rep_email), its family or its aliases.
--   * Strongback's words are kept as printed ("One-Hit Wonder", "not known", "sample sent"); a "sample sent" is never
--     a chair on display.
--   * SOURCE-POSITION identity: a snapshot is keyed by its printed table row and position; an observation by its kind
--     and printed position (page + baseline, + column for contacts). Re-importing the same file adds nothing; two
--     identical notes printed in two places stay two notes.
--
-- RULE 19 — stated per object: all four tables RLS ON, NO policies, revoke all from public / anon / authenticated;
--   service_role gets SELECT only (the API reads; it cannot insert, update or delete a row directly).
--   The two functions are SECURITY DEFINER with a pinned search_path, executable by service_role only; the guard
--   triggers accept a write only when it runs with the TABLE OWNER's rights inside one of them, so neither the API
--   nor any other role can write these tables by hand. After running: outside public-key probe on the four tables
--   and the two functions (expect 401 / 42501).
-- pg-safeupdate: every UPDATE / DELETE below carries a WHERE clause.
-- ============================================================================================
begin;

do $$ begin
  if to_regclass('public.mfr_sources') is null or to_regclass('public.mfr_source_events') is null then
    raise exception 'mi1c: MI-1b (mfr_sources report register) must be installed first'; end if;
  if to_regclass('public.dealers') is null then raise exception 'mi1c: dealers missing'; end if;
end $$;

-- 1. Report header (one per imported report file).
create table if not exists public.mfr_intel_reports (
  id                  bigserial primary key,
  source_id           bigint not null unique references public.mfr_sources(id),
  manufacturer        text not null,
  file_sha256         text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version      text not null,
  report_period_start date not null,
  report_period_end   date not null,
  prepared_date       date,                       -- as the manufacturer printed it; NULL when not printed, never invented
  owner_printed       text,                       -- the person the report is addressed to, as printed (not an HCPS owner)
  dealer_count        int  not null check (dealer_count >= 0),
  header              jsonb not null,             -- title, headline figures, sections, footnote, footer, PDF metadata
  checks              jsonb not null,             -- every validation check of the parse (errors refuse the import)
  match_summary       jsonb not null,             -- counts by match status at import
  content_hash        text not null,              -- sha256 of the import payload: same file + same parse = same hash
  imported_by         text not null check (length(trim(imported_by)) > 0),
  imported_at         timestamptz not null default now(),
  check (report_period_start <= report_period_end)
);
comment on table public.mfr_intel_reports is 'MI-1c: one row per imported manufacturer dealer-intelligence report (an accepted dealer_report in mfr_sources). Manufacturer-reported data, as printed; never part of HCPS sales or commission records.';

-- 2. Dealer snapshots (one per dealer the report prints).
create table if not exists public.mfr_dealer_snapshots (
  id                  bigserial primary key,
  report_id           bigint not null references public.mfr_intel_reports(id),
  source_id           bigint not null references public.mfr_sources(id),
  manufacturer        text not null,
  report_period_start date not null,
  report_period_end   date not null,
  row_no              int  not null check (row_no > 0),
  position_key        text not null,              -- where the table row is printed, e.g. table:p1:y322.5
  detail_position_key text,                       -- where the dealer's own page starts (NULL: table only)
  printed_name        text not null check (length(trim(printed_name)) > 0),
  printed_city        text,
  printed_state_text  text,
  printed_state       text,
  group_heading       text,                       -- e.g. "Slowing down"; NULL for table-only dealers
  tier                text not null check (tier ~ '^T[1-4]$'),
  trend               text not null,
  l12m_text           text not null, l12m_amount   numeric,
  prior12_text        text,          prior12_amount numeric,
  month_text          text not null, month_amount  numeric,
  last_order_text     text not null, last_order_date date,
  ergosteel_text      text not null,              -- the table's wording, e.g. "buying (2)" / "not yet"
  ergosteel           jsonb,                      -- the dealer page's ErgoSteel line, read (chairs, orders, first, last, note)
  floor_text          text not null,              -- the table's wording: "not known" / "sample sent"
  display_status      text not null check (display_status in ('not_known','sample_sent')),  -- never "on display"
  floor               jsonb,                      -- the dealer page's chair-on-the-floor line, read
  raw                 jsonb not null,             -- the parsed table row and dealer page header, as read
  match_status        text not null check (match_status in ('matched','review','unmatched','held')),
  dealer_id           uuid references public.dealers(id),
  match_method        text not null,
  match_evidence      jsonb not null,             -- candidates, reasons, unattributed HCPS sales — kept with every decision
  match_reason        text,
  matched_by          text,
  matched_at          timestamptz,
  match_version       int not null default 0,
  created_at          timestamptz not null default now(),
  constraint mfr_dealer_snapshots_match check ((match_status = 'matched') = (dealer_id is not null)),
  constraint mfr_dealer_snapshots_row_uk unique (source_id, row_no),
  constraint mfr_dealer_snapshots_pos_uk unique (source_id, position_key),
  constraint mfr_dealer_snapshots_name_uk unique (source_id, printed_name, printed_city)
);
create index if not exists mfr_dealer_snapshots_dealer_idx on public.mfr_dealer_snapshots (dealer_id) where dealer_id is not null;
create index if not exists mfr_dealer_snapshots_queue_idx on public.mfr_dealer_snapshots (source_id, match_status);
comment on table public.mfr_dealer_snapshots is 'MI-1c: one row per dealer a manufacturer report prints — the manufacturer''s figures and wording as printed, and the HCPS match. A match never changes the HCPS dealer, its rep or its aliases.';

-- 3. Observations (dated lines, attributed to the manufacturer).
create table if not exists public.mfr_dealer_observations (
  id            bigserial primary key,
  source_id     bigint not null references public.mfr_sources(id),
  snapshot_id   bigint references public.mfr_dealer_snapshots(id),   -- NULL = a report-level line (an offer)
  kind          text not null check (kind in ('contact_person','product_line','told_us','contact_log','offer')),
  position_key  text not null,                  -- printed position, e.g. p4:y476.3 (contacts add :x<column>)
  observed_on   date,                           -- the date printed with the line, when there is one
  text          text not null check (length(trim(text)) > 0),   -- exactly as printed
  structured    jsonb not null default '{}'::jsonb,              -- contact name/title/phones/emails/role; SKU + class
  review_state  text check (review_state is null or review_state = 'proposed'),  -- contact people: proposed only (approval is a later unit)
  created_at    timestamptz not null default now(),
  constraint mfr_dealer_observations_uk unique (source_id, kind, position_key),
  constraint mfr_dealer_observations_offer check ((kind = 'offer') = (snapshot_id is null)),
  constraint mfr_dealer_observations_review check (review_state is null or kind = 'contact_person')
);
create index if not exists mfr_dealer_observations_snap_idx on public.mfr_dealer_observations (snapshot_id, kind);
comment on table public.mfr_dealer_observations is 'MI-1c: dated lines from manufacturer dealer pages (contacts, product lines, notes, contact history) and report-level offers. Manufacturer statements, never HCPS activity; contact people stay proposals here.';

-- 4. Audit trail (append-only).
create table if not exists public.mfr_intel_events (
  id          bigserial primary key,
  source_id   bigint not null references public.mfr_sources(id),
  snapshot_id bigint references public.mfr_dealer_snapshots(id),
  action      text not null check (action in ('imported','match_decided')),
  actor       text not null check (length(trim(actor)) > 0),
  reason      text,
  detail      jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index if not exists mfr_intel_events_src_idx on public.mfr_intel_events (source_id, at);

-- 5. Guard: the four tables change only inside the two functions, running with the owner's rights.
create or replace function public.hcps_mfr_intel_guard()
returns trigger language plpgsql as $$
declare v_op text := coalesce(current_setting('hcps.mfr_intel_op', true), ''); v_owner text;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if tg_op = 'TRUNCATE' then raise exception 'mi1c_guard: % is never truncated', tg_table_name; end if;
  if tg_op = 'DELETE' then raise exception 'mi1c_guard: rows of % are never deleted', tg_table_name; end if;
  if current_user <> v_owner then
    raise exception 'mi1c_guard: % of % happens only through hcps_mfr_intel_import / hcps_mfr_intel_match', tg_op, tg_table_name; end if;
  if tg_op = 'INSERT' then
    if tg_table_name = 'mfr_intel_events' and v_op in ('import','match') then return new; end if;
    if v_op = 'import' then return new; end if;
    raise exception 'mi1c_guard: rows of % are written only by hcps_mfr_intel_import', tg_table_name;
  end if;
  -- UPDATE: only a snapshot's match, only inside hcps_mfr_intel_match, and nothing else on the row.
  if tg_table_name <> 'mfr_dealer_snapshots' or v_op <> 'match' then
    raise exception 'mi1c_guard: rows of % never change once written', tg_table_name; end if;
  if (to_jsonb(new) - array['match_status','dealer_id','match_method','match_evidence','match_reason','matched_by','matched_at','match_version'])
     is distinct from (to_jsonb(old) - array['match_status','dealer_id','match_method','match_evidence','match_reason','matched_by','matched_at','match_version']) then
    raise exception 'mi1c_guard: only the match of a dealer snapshot may change — the manufacturer''s figures stay as printed'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.hcps_mfr_intel_guard()', t || '_guard', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.hcps_mfr_intel_guard()', t || '_no_truncate', t);
  end loop;
end $$;

-- 6. IMPORT — one transaction: report header, every dealer snapshot, every observation, one audit event.
--    p = { source_id, file_sha256, actor, parser_version, period_start, period_end, prepared_date, owner_printed,
--          header, checks, errors[], dealers:[{row_no, position_key, …, match:{status, dealer_id, method, evidence}}],
--          observations:[{row_no|null, kind, position_key, observed_on, text, structured, review_state}] }
--    Idempotent: the same payload for the same source returns the existing import and writes nothing.
create or replace function public.hcps_mfr_intel_import(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_src public.mfr_sources; v_actor text := nullif(trim(p->>'actor'), ''); v_hash text; v_rep public.mfr_intel_reports;
  v_report_id bigint; d jsonb; o jsonb; v_snap bigint; v_m jsonb; v_status text; v_dealer uuid; v_n int := 0; v_o int := 0;
  v_rows jsonb := coalesce(p->'dealers', '[]'::jsonb); v_count int;
begin
  if v_actor is null then raise exception 'mi1c_actor_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mi1c:import:' || coalesce(p->>'source_id', ''), 0));
  select * into v_src from public.mfr_sources where id = (p->>'source_id')::bigint for update;
  if not found then raise exception 'mi1c_no_source: % is not a registered report', p->>'source_id'; end if;
  if v_src.kind <> 'dealer_report' then raise exception 'mi1c_not_a_dealer_report: source % is a %', v_src.id, v_src.kind; end if;
  if v_src.status <> 'accepted' then raise exception 'mi1c_not_accepted: source % is % — only an accepted report is imported', v_src.id, v_src.status; end if;
  if v_src.file_sha256 is distinct from lower(p->>'file_sha256') then
    raise exception 'mi1c_wrong_file: the parsed file is not the file registered as source %', v_src.id; end if;
  if (p->>'period_start')::date is distinct from v_src.report_period_start or (p->>'period_end')::date is distinct from v_src.report_period_end then
    raise exception 'mi1c_period_mismatch: the report says % to %, the register says % to %', p->>'period_start', p->>'period_end', v_src.report_period_start, v_src.report_period_end; end if;
  if jsonb_array_length(coalesce(p->'errors', '[]'::jsonb)) > 0 then
    raise exception 'mi1c_parse_errors: the parse has % error(s) — nothing is imported', jsonb_array_length(p->'errors'); end if;
  v_count := jsonb_array_length(v_rows);
  if v_count = 0 or v_count is distinct from (p->'header'->>'dealer_count')::int then
    raise exception 'mi1c_dealer_count: % dealer rows, the report says %', v_count, p->'header'->>'dealer_count'; end if;
  v_hash := encode(sha256(convert_to((p - 'actor')::text, 'UTF8')), 'hex');
  select * into v_rep from public.mfr_intel_reports where source_id = v_src.id;
  if found then
    if v_rep.content_hash = v_hash then
      return jsonb_build_object('ok', true, 'existing', true, 'report_id', v_rep.id, 'source_id', v_src.id); end if;
    raise exception 'mi1c_already_imported: source % was imported with a different parse (report %) — a corrected report is registered as a new source', v_src.id, v_rep.id;
  end if;

  perform set_config('hcps.mfr_intel_op', 'import', true);
  insert into public.mfr_intel_reports (source_id, manufacturer, file_sha256, parser_version, report_period_start, report_period_end,
    prepared_date, owner_printed, dealer_count, header, checks, match_summary, content_hash, imported_by)
  values (v_src.id, v_src.manufacturer, v_src.file_sha256, p->>'parser_version', v_src.report_period_start, v_src.report_period_end,
    nullif(p->>'prepared_date','')::date, nullif(p->>'owner_printed',''), v_count, coalesce(p->'header','{}'::jsonb),
    coalesce(p->'checks','[]'::jsonb), coalesce(p->'match_summary','{}'::jsonb), v_hash, v_actor)
  returning id into v_report_id;

  for d in select * from jsonb_array_elements(v_rows) loop
    v_m := d->'match'; v_status := v_m->>'status'; v_dealer := nullif(v_m->>'dealer_id','')::uuid;
    if v_status = 'matched' then
      if not exists (select 1 from public.dealers x where x.id = v_dealer and coalesce((to_jsonb(x)->>'is_test')::boolean, false) = false) then
        raise exception 'mi1c_bad_match: row % — dealer % is not an HCPS dealer that may be matched', d->>'row_no', v_dealer; end if;
    elsif v_dealer is not null then raise exception 'mi1c_bad_match: row % is % but names a dealer', d->>'row_no', v_status; end if;
    insert into public.mfr_dealer_snapshots (report_id, source_id, manufacturer, report_period_start, report_period_end, row_no,
      position_key, detail_position_key, printed_name, printed_city, printed_state_text, printed_state, group_heading, tier, trend,
      l12m_text, l12m_amount, prior12_text, prior12_amount, month_text, month_amount, last_order_text, last_order_date,
      ergosteel_text, ergosteel, floor_text, display_status, floor, raw, match_status, dealer_id, match_method, match_evidence,
      match_reason, matched_by, matched_at)
    values (v_report_id, v_src.id, v_src.manufacturer, v_src.report_period_start, v_src.report_period_end, (d->>'row_no')::int,
      d->>'position_key', nullif(d->>'detail_position_key',''), d->>'printed_name', nullif(d->>'printed_city',''),
      nullif(d->>'printed_state_text',''), nullif(d->>'printed_state',''), nullif(d->>'group_heading',''), d->>'tier', d->>'trend',
      d->>'l12m_text', nullif(d->>'l12m_amount','')::numeric, nullif(d->>'prior12_text',''), nullif(d->>'prior12_amount','')::numeric,
      d->>'month_text', nullif(d->>'month_amount','')::numeric, d->>'last_order_text', nullif(d->>'last_order_date','')::date,
      d->>'ergosteel_text', d->'ergosteel', d->>'floor_text',
      case d->>'floor_text' when 'not known' then 'not_known' when 'sample sent' then 'sample_sent' end,
      d->'floor', coalesce(d->'raw','{}'::jsonb), v_status, v_dealer, coalesce(v_m->>'method','none'), coalesce(v_m->'evidence','{}'::jsonb),
      case when v_status = 'matched' then 'automatic: ' || coalesce(v_m->>'method','') end,
      case when v_status = 'matched' then 'system:mi1c-matcher' end, case when v_status = 'matched' then now() end)
    returning id into v_snap;
    v_n := v_n + 1;
    for o in select * from jsonb_array_elements(coalesce(p->'observations','[]'::jsonb)) loop
      continue when (o->>'row_no') is distinct from (d->>'row_no');
      insert into public.mfr_dealer_observations (source_id, snapshot_id, kind, position_key, observed_on, text, structured, review_state)
      values (v_src.id, v_snap, o->>'kind', o->>'position_key', nullif(o->>'observed_on','')::date, o->>'text',
        coalesce(o->'structured','{}'::jsonb), nullif(o->>'review_state',''));
      v_o := v_o + 1;
    end loop;
  end loop;
  for o in select * from jsonb_array_elements(coalesce(p->'observations','[]'::jsonb)) loop
    continue when o->>'row_no' is not null;
    insert into public.mfr_dealer_observations (source_id, snapshot_id, kind, position_key, observed_on, text, structured, review_state)
    values (v_src.id, null, o->>'kind', o->>'position_key', nullif(o->>'observed_on','')::date, o->>'text', coalesce(o->'structured','{}'::jsonb), null);
    v_o := v_o + 1;
  end loop;
  if v_o <> jsonb_array_length(coalesce(p->'observations','[]'::jsonb)) then
    raise exception 'mi1c_orphan_observation: % observation(s) name a row the report does not have', jsonb_array_length(p->'observations') - v_o; end if;
  insert into public.mfr_intel_events (source_id, action, actor, detail)
  values (v_src.id, 'imported', v_actor, jsonb_build_object('report_id', v_report_id, 'dealers', v_n, 'observations', v_o,
    'match_summary', coalesce(p->'match_summary','{}'::jsonb), 'parser_version', p->>'parser_version', 'content_hash', v_hash));
  perform set_config('hcps.mfr_intel_op', '', true);
  return jsonb_build_object('ok', true, 'existing', false, 'report_id', v_report_id, 'source_id', v_src.id, 'dealers', v_n, 'observations', v_o);
end $$;

-- 7. MATCH DECISION — a person sets or corrects one snapshot's match.
--    p = { snapshot_id, decision: matched | review | unmatched | held, dealer_id (matched only), reason, actor,
--          expected_version }   expected_version guards against two people deciding the same row at once.
create or replace function public.hcps_mfr_intel_match(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_s public.mfr_dealer_snapshots; v_src public.mfr_sources; v_actor text := nullif(trim(p->>'actor'), '');
        v_reason text := nullif(trim(p->>'reason'), ''); v_dec text := p->>'decision'; v_dealer uuid := nullif(p->>'dealer_id','')::uuid;
begin
  if v_actor is null then raise exception 'mi1c_actor_required'; end if;
  if v_dec not in ('matched','review','unmatched','held') then raise exception 'mi1c_bad_decision: matched, review, unmatched or held'; end if;
  if v_reason is null then raise exception 'mi1c_reason_required: every match decision needs a reason'; end if;
  if (v_dec = 'matched') <> (v_dealer is not null) then raise exception 'mi1c_bad_decision: a dealer is named exactly when the decision is "matched"'; end if;
  select * into v_s from public.mfr_dealer_snapshots where id = (p->>'snapshot_id')::bigint for update;
  if not found then raise exception 'mi1c_no_snapshot: %', p->>'snapshot_id'; end if;
  select * into v_src from public.mfr_sources where id = v_s.source_id;
  if v_src.status <> 'accepted' then raise exception 'mi1c_source_closed: report % is % — its matches no longer change', v_src.id, v_src.status; end if;
  if v_s.match_status = v_dec and v_s.dealer_id is not distinct from v_dealer then
    return jsonb_build_object('ok', true, 'unchanged', true, 'snapshot_id', v_s.id, 'match_version', v_s.match_version); end if;
  if (p->>'expected_version') is null or (p->>'expected_version')::int <> v_s.match_version then
    raise exception 'mi1c_stale: snapshot % changed since it was shown (version % now) — reload and decide again', v_s.id, v_s.match_version; end if;
  if v_dec = 'matched' and not exists (select 1 from public.dealers x where x.id = v_dealer and coalesce((to_jsonb(x)->>'is_test')::boolean, false) = false) then
    raise exception 'mi1c_bad_match: dealer % is not an HCPS dealer that may be matched', v_dealer; end if;
  perform set_config('hcps.mfr_intel_op', 'match', true);
  update public.mfr_dealer_snapshots set match_status = v_dec, dealer_id = v_dealer, match_method = 'manual',
    match_reason = v_reason, matched_by = v_actor, matched_at = now(), match_version = v_s.match_version + 1
   where id = v_s.id;
  insert into public.mfr_intel_events (source_id, snapshot_id, action, actor, reason, detail)
  values (v_s.source_id, v_s.id, 'match_decided', v_actor, v_reason, jsonb_build_object(
    'from', jsonb_build_object('status', v_s.match_status, 'dealer_id', v_s.dealer_id, 'method', v_s.match_method, 'version', v_s.match_version),
    'to', jsonb_build_object('status', v_dec, 'dealer_id', v_dealer, 'version', v_s.match_version + 1),
    'printed_name', v_s.printed_name, 'printed_city', v_s.printed_city, 'evidence', v_s.match_evidence));
  perform set_config('hcps.mfr_intel_op', '', true);
  return jsonb_build_object('ok', true, 'unchanged', false, 'snapshot_id', v_s.id, 'match_status', v_dec, 'dealer_id', v_dealer, 'match_version', v_s.match_version + 1);
end $$;

-- 8. RULE 19 privileges.
do $$ declare t text; begin
  foreach t in array array['mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
    execute format('revoke all on sequence public.%I from public, anon, authenticated, service_role', t || '_id_seq');
  end loop;
end $$;
do $$ declare f text; begin
  foreach f in array array['public.hcps_mfr_intel_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f); end loop;
  foreach f in array array['public.hcps_mfr_intel_import(jsonb)', 'public.hcps_mfr_intel_match(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f); end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'four MI-1c tables exist, RLS on, 0 policies' check_name,
         count(*)::text value,
         count(*) = 4 and bool_and(c.relrowsecurity) and not exists (select 1 from pg_policy p where p.polrelid = any(array['public.mfr_intel_reports'::regclass,'public.mfr_dealer_snapshots'::regclass,'public.mfr_dealer_observations'::regclass,'public.mfr_intel_events'::regclass])) ok
    from pg_class c where c.oid in ('public.mfr_intel_reports'::regclass,'public.mfr_dealer_snapshots'::regclass,'public.mfr_dealer_observations'::regclass,'public.mfr_intel_events'::regclass)
  union all select 2, 'grants to anon / authenticated / PUBLIC on the four tables (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events') and grantee in ('anon','authenticated','PUBLIC')
  union all select 3, 'service_role privileges on the four tables = SELECT only', string_agg(distinct privilege_type, ','),
         coalesce(bool_and(privilege_type = 'SELECT'), false) and count(*) = 4
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events') and grantee = 'service_role'
  union all select 4, 'MI-1c functions executable by anon / authenticated (expect 0)', count(*)::text, count(*) = 0
    from pg_proc p cross join unnest(array['anon','authenticated']) r
   where p.pronamespace = 'public'::regnamespace and p.proname like 'hcps_mfr_intel_%' and has_function_privilege(r, p.oid, 'execute')
  union all select 5, 'import + match are SECURITY DEFINER with a pinned search_path, executable by service_role', count(*)::text,
         count(*) = 2 and bool_and(p.prosecdef) and bool_and(p.proconfig::text like '%search_path=public%') and bool_and(has_function_privilege('service_role', p.oid, 'execute'))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('hcps_mfr_intel_import','hcps_mfr_intel_match')
  union all select 6, 'guard triggers installed (row + truncate on each table)', count(*)::text, count(*) = 8
    from pg_trigger where not tgisinternal
     and tgrelid in ('public.mfr_intel_reports'::regclass,'public.mfr_dealer_snapshots'::regclass,'public.mfr_dealer_observations'::regclass,'public.mfr_intel_events'::regclass)
  union all select 7, 'no MI-1c data yet (expect 0 reports, snapshots, observations, events)',
         ((select count(*) from public.mfr_intel_reports) + (select count(*) from public.mfr_dealer_snapshots)
          + (select count(*) from public.mfr_dealer_observations) + (select count(*) from public.mfr_intel_events))::text,
         ((select count(*) from public.mfr_intel_reports) + (select count(*) from public.mfr_dealer_snapshots)
          + (select count(*) from public.mfr_dealer_observations) + (select count(*) from public.mfr_intel_events)) = 0
) x order by n;
