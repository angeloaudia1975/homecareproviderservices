-- ============================================================================================
-- MI Phase F — contractual commission evidence (Angelo, 2026-10-12 22:00 CT; CLAUDE.md §18).
-- Runs AFTER MI-1b and Phase E. Safe to run twice. NOT RUN — Angelo runs it on approval.
--
-- What it adds: ONE append-only table of the President's evidence and decisions about commission obligations. It is not a
-- ledger: it holds no earned or reported-due amount (those are read from the sales on file and the registered statements,
-- every time). It records only what cannot be read from a file:
--   kind 'payment'  money Strongback actually paid, WITH evidence (remittance, deposit, cheque …) — on ONE statement
--                   (source_id) or ONE order (order_number). A statement saying "commission due" is never a payment.
--   kind 'review'   the decision on a statement line that matches no sale: matched_to:<order> (a typo / renumbered order),
--                   not_ours, duplicate, or investigate. A decision never creates a sale.
-- A correction is a NEW row that supersedes an older one (supersedes_id); nothing is updated or deleted.
--
-- hcps_mfr_commission_event(p) is the ONLY way in; President only (hcps_mfr_mi_e_president, Phase E).
-- RULE 19: RLS on, no policies; anon / authenticated / PUBLIC nothing; service_role SELECT only; the function is security
-- definer, executable by service_role only. After running: scripts/mi_f_public_probe_browser.js (expect 401).
-- pg-safeupdate: no UPDATE or DELETE anywhere.
-- ============================================================================================
begin;

do $$ begin
  if to_regprocedure('public.hcps_mfr_mi_e_president(text)') is null then raise exception 'mi_f: Phase E (mi_e_auto_import.sql) must be installed first'; end if;
  if to_regclass('public.mfr_sources') is null then raise exception 'mi_f: MI-1b must be installed first'; end if;
end $$;

create table if not exists public.mfr_commission_events (
  id             bigserial primary key,
  manufacturer   text not null,
  kind           text not null check (kind in ('payment','review')),
  source_id      bigint references public.mfr_sources(id),
  order_number   text check (order_number is null or btrim(order_number) <> ''),
  amount         numeric(12,2),
  paid_on        date,
  evidence       text,
  decision       text,
  reason         text not null check (length(btrim(reason)) >= 10),
  supersedes_id  bigint references public.mfr_commission_events(id),
  actor          text not null check (actor ~ '^staff:.+@.+$'),
  created_at     timestamptz not null default now(),
  constraint mfr_commission_events_payment_ck check (kind <> 'payment' or (
    amount is not null and amount <> 0 and paid_on is not null and length(btrim(coalesce(evidence, ''))) >= 5
    and ((source_id is null) <> (order_number is null)) and decision is null)),
  constraint mfr_commission_events_review_ck check (kind <> 'review' or (
    source_id is not null and order_number is not null and amount is null and paid_on is null
    and decision is not null and (decision in ('not_ours','duplicate','investigate') or decision ~ '^matched_to:\S+$')))
);
create index if not exists mfr_commission_events_mfr_ix on public.mfr_commission_events(manufacturer, id);
create unique index if not exists mfr_commission_events_superseded_once_uk on public.mfr_commission_events(supersedes_id) where supersedes_id is not null;

do $$ declare s text; begin
  alter table public.mfr_commission_events enable row level security;
  revoke all on table public.mfr_commission_events from public, anon, authenticated, service_role;
  grant select on table public.mfr_commission_events to service_role;
  s := pg_get_serial_sequence('public.mfr_commission_events', 'id');
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role', s);
end $$;

-- Guard: rows are only ever inserted, only through the function below (marker + the owner's rights).
create or replace function public.hcps_mfr_commission_event_guard()
returns trigger language plpgsql as $$
declare v_owner text;
begin
  if tg_level = 'STATEMENT' or tg_op <> 'INSERT' then raise exception 'mfr_commission_event_guard: % of mfr_commission_events is not allowed — it is append-only', tg_op; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if coalesce(current_setting('hcps.mi_f_op', true), '') <> 'on' or current_user <> v_owner then
    raise exception 'mfr_commission_event_guard: rows are written only by hcps_mfr_commission_event'; end if;
  return new;
end $$;
drop trigger if exists mfr_commission_event_guard on public.mfr_commission_events;
create trigger mfr_commission_event_guard before insert or update or delete on public.mfr_commission_events for each row execute function public.hcps_mfr_commission_event_guard();
drop trigger if exists mfr_commission_event_guard_truncate on public.mfr_commission_events;
create trigger mfr_commission_event_guard_truncate before truncate on public.mfr_commission_events for each statement execute function public.hcps_mfr_commission_event_guard();

-- p = { manufacturer, kind, source_id?, order_number?, amount?, paid_on?, evidence?, decision?, reason, supersedes_id?, actor }
create or replace function public.hcps_mfr_commission_event(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mfr text := nullif(btrim(p->>'manufacturer'), ''); v_kind text := p->>'kind'; v_actor text := nullif(btrim(p->>'actor'), '');
        v_src bigint := nullif(p->>'source_id', '')::bigint; v_sup bigint := nullif(p->>'supersedes_id', '')::bigint;
        s public.mfr_sources; o public.mfr_commission_events; v_id bigint;
begin
  if not public.hcps_mfr_mi_e_president(v_actor) then raise exception 'mi_f_president_only: commission payments and review decisions are the President''s'; end if;
  if v_mfr is null or v_kind not in ('payment','review') then raise exception 'mi_f_bad_request: manufacturer and kind (payment | review) required'; end if;
  if v_src is not null then
    select * into s from public.mfr_sources where id = v_src;
    if not found or s.kind <> 'commission_statement' or s.manufacturer <> v_mfr then
      raise exception 'mi_f_bad_source: record % is not a commission statement of %', v_src, v_mfr; end if;
    if s.status not in ('received','accepted') then raise exception 'mi_f_bad_source: record % is %', v_src, s.status; end if;
  end if;
  if v_sup is not null then
    select * into o from public.mfr_commission_events where id = v_sup;
    if not found or o.manufacturer <> v_mfr or o.kind <> v_kind then raise exception 'mi_f_bad_supersede: event % is not a % of %', v_sup, v_kind, v_mfr; end if;
    if exists (select 1 from public.mfr_commission_events where supersedes_id = v_sup) then raise exception 'mi_f_bad_supersede: event % was already corrected', v_sup; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('hcps_commission_event:' || v_mfr));
  perform set_config('hcps.mi_f_op', 'on', true);
  insert into public.mfr_commission_events (manufacturer, kind, source_id, order_number, amount, paid_on, evidence, decision, reason, supersedes_id, actor)
  values (v_mfr, v_kind, v_src, nullif(btrim(p->>'order_number'), ''), nullif(p->>'amount', '')::numeric, nullif(p->>'paid_on', '')::date,
          nullif(btrim(p->>'evidence'), ''), nullif(btrim(p->>'decision'), ''), btrim(coalesce(p->>'reason', '')), v_sup, v_actor)
  returning id into v_id;
  perform set_config('hcps.mi_f_op', 'off', true);
  return jsonb_build_object('ok', true, 'event_id', v_id, 'kind', v_kind);
end $$;

revoke all on function public.hcps_mfr_commission_event_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_mfr_commission_event(jsonb) from public, anon, authenticated;
grant execute on function public.hcps_mfr_commission_event(jsonb) to service_role;

commit;

-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'table present, RLS on, 0 policies' check_name,
         count(*) || ' table, RLS ' || bool_and(c.relrowsecurity) value,
         count(*) = 1 and bool_and(c.relrowsecurity) and (select count(*) from pg_policy pp where pp.polrelid = 'public.mfr_commission_events'::regclass) = 0 ok
    from pg_class c where c.oid = 'public.mfr_commission_events'::regclass
  union all select 2, 'grants to anon / authenticated / PUBLIC (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'mfr_commission_events' and grantee in ('anon','authenticated','PUBLIC')
  union all select 3, 'service_role: SELECT only', string_agg(privilege_type, ','), coalesce(string_agg(privilege_type, ','), '') = 'SELECT'
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'mfr_commission_events' and grantee = 'service_role'
  union all select 4, 'function: service_role only, security definer; guard callable by nobody',
         has_function_privilege('service_role', 'public.hcps_mfr_commission_event(jsonb)', 'execute') || ' / ' ||
         has_function_privilege('anon', 'public.hcps_mfr_commission_event(jsonb)', 'execute') || ' / ' ||
         has_function_privilege('service_role', 'public.hcps_mfr_commission_event_guard()', 'execute'),
         has_function_privilege('service_role', 'public.hcps_mfr_commission_event(jsonb)', 'execute')
         and not has_function_privilege('anon', 'public.hcps_mfr_commission_event(jsonb)', 'execute')
         and not has_function_privilege('authenticated', 'public.hcps_mfr_commission_event(jsonb)', 'execute')
         and not has_function_privilege('service_role', 'public.hcps_mfr_commission_event_guard()', 'execute')
         and (select prosecdef from pg_proc where oid = 'public.hcps_mfr_commission_event(jsonb)'::regprocedure)
  union all select 5, 'guard triggers (row + truncate)', count(*)::text, count(*) = 2
    from pg_trigger where tgrelid = 'public.mfr_commission_events'::regclass and not tgisinternal
  union all select 6, 'nothing written by the install', (select count(*) from public.mfr_commission_events)::text, (select count(*) from public.mfr_commission_events) = 0
  union all select 7, 'monthly_sales unchanged (rows · amount · commission)',
         (select count(*) || ' · ' || coalesce(sum(amount),0) || ' · ' || coalesce(sum(commission),0) from public.monthly_sales), true
) x order by n;
