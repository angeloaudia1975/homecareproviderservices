-- ============================================================================================
-- MI Inbox Automation — Phase C: Ship-To correction & branch assignment (CLAUDE.md §18, Angelo 2026-10-11 20:53 CT).
-- Runs AFTER MI-1b (mfr_sources report register). Safe to run twice. NOT RUN — Angelo runs it on approval.
--
-- What it adds
--   mfr_shipto_corrections  a person's decision for ONE order of ONE registered report file: the HCPS branch (or the
--                           corporate, explicitly) and any missing / wrong ship-to details. VERSIONED and append-only:
--                           a later decision is a new version, the earlier one stays. The manufacturer's file is never
--                           touched — this is an overlay beside the reported values (kept in `reported`).
--   mfr_shipto_mappings     verified mappings: manufacturer + account number + ship-to key (the manufacturer's ship-to id,
--                           or street + ZIP as the FILE reports them) → branch. Never "account → one branch". Retired,
--                           never deleted; one active mapping per key.
--   mfr_shipto_events       append-only audit of every correction, mapping and retirement.
--   hcps_mfr_shipto_correct / hcps_mfr_shipto_retire — the ONLY way these rows change.
--
-- What it never does: write monthly_sales or any financial row, re-attribute history, create or change dealers, reps,
-- aliases or account numbers, accept / import a report, or change MI-1b / MI-1a / Phase B objects.
--
-- RULE 19: every new table has RLS on and no policies; anon / authenticated / PUBLIC hold nothing; service_role may only
-- SELECT (writes go through the security-definer functions, executable by service_role only). After running: outside
-- public-key probe (scripts/mi_c_public_probe_browser.js) — expect 401 / 42501 everywhere.
-- pg-safeupdate: every UPDATE here carries a WHERE clause; there is no DELETE.
-- ============================================================================================
begin;

do $$ begin
  if to_regclass('public.mfr_sources') is null or to_regprocedure('public.hcps_mfr_report_register(jsonb)') is null then
    raise exception 'mi_c: MI-1b (mfr_sources report register) must be installed first'; end if;
  if to_regclass('public.dealers') is null then raise exception 'mi_c: dealers missing'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
create table if not exists public.mfr_shipto_corrections (
  id                bigserial primary key,
  source_id         bigint not null references public.mfr_sources(id),
  manufacturer      text not null,
  order_key         text not null check (length(order_key) between 3 and 200),
  version           integer not null check (version >= 1),
  supersedes_id     bigint references public.mfr_shipto_corrections(id),
  order_fingerprint text not null check (order_fingerprint ~ '^[0-9a-f]{32}$'),
  reported          jsonb not null check (jsonb_typeof(reported) = 'object'),   -- the file's own values, as read
  scope             text not null check (scope in ('branch','corporate')),
  dealer_id         uuid not null references public.dealers(id),
  ship_name         text check (ship_name is null or length(ship_name) <= 200),
  ship_address      text check (ship_address is null or length(ship_address) <= 300),
  ship_city         text check (ship_city is null or length(ship_city) <= 100),
  ship_state        text check (ship_state is null or length(ship_state) <= 40),
  ship_zip          text check (ship_zip is null or ship_zip ~ '^\d{5}(-\d{4})?$'),
  reason            text not null check (length(trim(reason)) >= 3),
  actor             text not null check (actor like 'staff:%@%'),
  created_at        timestamptz not null default now(),
  unique (source_id, order_key, version),
  check ((version = 1) = (supersedes_id is null))
);
create index if not exists mfr_shipto_corrections_src_idx on public.mfr_shipto_corrections (source_id, order_key, version desc);

create table if not exists public.mfr_shipto_mappings (
  id                   bigserial primary key,
  manufacturer         text not null,
  account_ref          text not null check (account_ref = lower(trim(account_ref)) and account_ref <> ''),   -- never blank: no account number = nothing remembered
  ship_key             text not null check (ship_key ~ '^(id:.+|addr:.+\|\d{5})$'),
  scope                text not null check (scope in ('branch','corporate')),
  dealer_id            uuid not null references public.dealers(id),
  origin_correction_id bigint not null references public.mfr_shipto_corrections(id),
  verified_by          text not null check (verified_by like 'staff:%@%'),
  verified_at          timestamptz not null default now(),
  retired_at           timestamptz,
  retired_by           text,
  retire_reason        text,
  check ((retired_at is null) = (retired_by is null) and (retired_at is null) = (retire_reason is null))
);
create unique index if not exists mfr_shipto_mappings_active_uk on public.mfr_shipto_mappings (manufacturer, account_ref, ship_key) where retired_at is null;

create table if not exists public.mfr_shipto_events (
  id             bigserial primary key,
  source_id      bigint references public.mfr_sources(id),
  correction_id  bigint references public.mfr_shipto_corrections(id),
  mapping_id     bigint references public.mfr_shipto_mappings(id),
  action         text not null check (action in ('correction_saved','mapping_verified','mapping_reused','mapping_replaced','mapping_retired')),
  actor          text not null check (length(trim(actor)) > 0),
  reason         text,
  detail         jsonb not null default '{}'::jsonb,
  at             timestamptz not null default now()
);
create index if not exists mfr_shipto_events_src_idx on public.mfr_shipto_events (source_id, at);

comment on table public.mfr_shipto_corrections is 'Phase C: versioned, append-only Ship-To corrections per order of a registered report file (overlay; the file is never changed).';
comment on table public.mfr_shipto_mappings is 'Phase C: verified manufacturer + account + ship-to key → branch mappings. Retired, never deleted.';
comment on table public.mfr_shipto_events is 'Phase C: append-only audit of Ship-To corrections and mappings.';

-- ---------------------------------------------------------------------------------------------
-- 2. RULE 19 — closed to ordinary users; service_role reads only.
do $$ declare t text; begin
  foreach t in array array['mfr_shipto_corrections','mfr_shipto_mappings','mfr_shipto_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
    execute format('revoke all on sequence public.%I from public, anon, authenticated, service_role', t || '_id_seq');
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Guard: rows change only inside the hcps_mfr_shipto_* functions (marker + the owner's rights). Corrections and
--    events are never updated; nothing is ever deleted or truncated; a mapping changes only by retirement.
create or replace function public.hcps_mfr_shipto_guard()
returns trigger language plpgsql as $$
declare v_owner text;
begin
  if tg_level = 'STATEMENT' then raise exception 'mfr_shipto_guard: % of % is not allowed', tg_op, tg_table_name; end if;
  if tg_op = 'DELETE' then raise exception 'mfr_shipto_guard: rows of % are never deleted', tg_table_name; end if;
  if tg_op = 'UPDATE' and tg_table_name in ('mfr_shipto_corrections','mfr_shipto_events') then
    raise exception 'mfr_shipto_guard: % is append-only — a later decision is a new version', tg_table_name; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if coalesce(current_setting('hcps.shipto_op', true), '') <> 'on' or current_user <> v_owner then
    raise exception 'mfr_shipto_guard: % of % happens only through the hcps_mfr_shipto_* functions', tg_op, tg_table_name;
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'mfr_shipto_mappings' then
    if old.retired_at is not null or new.retired_at is null
       or (new.id, new.manufacturer, new.account_ref, new.ship_key, new.scope, new.dealer_id, new.origin_correction_id, new.verified_by, new.verified_at)
          is distinct from (old.id, old.manufacturer, old.account_ref, old.ship_key, old.scope, old.dealer_id, old.origin_correction_id, old.verified_by, old.verified_at) then
      raise exception 'mfr_shipto_guard: a verified mapping is only ever retired, once';
    end if;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['mfr_shipto_corrections','mfr_shipto_mappings','mfr_shipto_events'] loop
    execute format('drop trigger if exists mfr_shipto_guard on public.%I', t);
    execute format('create trigger mfr_shipto_guard before insert or update or delete on public.%I for each row execute function public.hcps_mfr_shipto_guard()', t);
    execute format('drop trigger if exists mfr_shipto_guard_truncate on public.%I', t);
    execute format('create trigger mfr_shipto_guard_truncate before truncate on public.%I for each statement execute function public.hcps_mfr_shipto_guard()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. SAVE — a person's correction for one order (Save & Continue). Optionally remembers a verified mapping.
--    p: {source_id, order_key, order_fingerprint, reported:{…}, dealer_id, scope:'branch'|'corporate',
--        ship_name?, ship_address?, ship_city?, ship_state?, ship_zip?, reason, actor:'staff:<email>',
--        expected_version (the latest version the person saw, 0 = none), remember?:bool,
--        mapping_account_ref?, mapping_ship_key? (from the FILE's values), replace_mapping?:bool}
create or replace function public.hcps_mfr_shipto_correct(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_src public.mfr_sources; v_d record; v_cur public.mfr_shipto_corrections; v_id bigint; v_ver int;
  v_key text := trim(coalesce(p->>'order_key', '')); v_actor text := trim(coalesce(p->>'actor', ''));
  v_reason text := trim(coalesce(p->>'reason', '')); v_scope text := coalesce(nullif(p->>'scope', ''), 'branch');
  v_exp int := coalesce(nullif(p->>'expected_version', '')::int, -1);
  v_remember boolean := coalesce((p->>'remember')::boolean, false);
  v_acct text := lower(trim(coalesce(p->>'mapping_account_ref', ''))); v_sk text := trim(coalesce(p->>'mapping_ship_key', ''));
  v_map public.mfr_shipto_mappings; v_mid bigint; v_mres text := 'none'; v_had boolean;
  v_zip text := nullif(trim(coalesce(p->>'ship_zip', '')), '');
begin
  if v_actor !~ '^staff:[^@\s]+@[^@\s]+$' then raise exception 'shipto_actor_required: the acting person (staff:<email>) is required'; end if;
  if length(v_reason) < 3 then raise exception 'shipto_reason_required: a correction needs a reason'; end if;
  if v_scope not in ('branch','corporate') then raise exception 'shipto_bad_scope: branch or corporate'; end if;
  if v_exp < 0 then raise exception 'shipto_expected_version_required: send the version you saw (0 when none)'; end if;
  select * into v_src from public.mfr_sources where id = (p->>'source_id')::bigint;
  if not found or v_src.kind not in ('sales_export','commission_statement') then raise exception 'shipto_not_a_report: % is not a registered sales or commission report', p->>'source_id'; end if;
  if v_src.status not in ('received','accepted') then raise exception 'shipto_report_closed: report % is %', v_src.id, v_src.status; end if;
  select d.id, d.parent_id, coalesce((to_jsonb(d)->>'is_test')::boolean, false) as is_test into v_d from public.dealers d where d.id = (p->>'dealer_id')::uuid;
  if not found then raise exception 'shipto_unknown_dealer: choose an existing HCPS dealer or branch'; end if;
  if v_d.is_test then raise exception 'shipto_test_dealer: a manufacturer report is never assigned to a TEST dealer'; end if;
  if v_scope = 'corporate' and v_d.parent_id is not null then raise exception 'shipto_corporate_needs_hq: a corporate / drop-ship sale is booked to the corporate (HQ) record'; end if;
  if v_zip is not null and v_zip !~ '^\d{5}(-\d{4})?$' then raise exception 'shipto_bad_zip: ZIP must be 12345 or 12345-6789'; end if;

  perform pg_advisory_xact_lock(hashtext('mfr_shipto:' || v_src.id || ':' || v_key));
  select * into v_cur from public.mfr_shipto_corrections where source_id = v_src.id and order_key = v_key order by version desc limit 1;
  if coalesce(v_cur.version, 0) <> v_exp then
    raise exception 'shipto_stale: order % already has version % — reload before saving', v_key, coalesce(v_cur.version, 0); end if;
  v_ver := coalesce(v_cur.version, 0) + 1;

  perform set_config('hcps.shipto_op', 'on', true);
  insert into public.mfr_shipto_corrections (source_id, manufacturer, order_key, version, supersedes_id, order_fingerprint, reported, scope, dealer_id,
    ship_name, ship_address, ship_city, ship_state, ship_zip, reason, actor)
  values (v_src.id, v_src.manufacturer, v_key, v_ver, v_cur.id, p->>'order_fingerprint', coalesce(p->'reported', '{}'::jsonb), v_scope, v_d.id,
    nullif(trim(coalesce(p->>'ship_name', '')), ''), nullif(trim(coalesce(p->>'ship_address', '')), ''), nullif(trim(coalesce(p->>'ship_city', '')), ''),
    nullif(trim(coalesce(p->>'ship_state', '')), ''), v_zip, v_reason, v_actor)
  returning id into v_id;
  insert into public.mfr_shipto_events (source_id, correction_id, action, actor, reason, detail)
  values (v_src.id, v_id, 'correction_saved', v_actor, v_reason, jsonb_build_object('order_key', v_key, 'version', v_ver, 'scope', v_scope,
    'dealer_id', v_d.id, 'previous_dealer_id', v_cur.dealer_id, 'supersedes_id', v_cur.id));

  if v_remember then
    if v_sk !~ '^(id:.+|addr:.+\|\d{5})$' then
      raise exception 'shipto_no_ship_key: this order has no ship-to id or street + ZIP in the file — the choice applies to this order only'; end if;
    -- Remembering = automatic reuse for later orders, so the identity must be specific AND independently confirmed
    -- (Angelo, 2026-10-11 22:09): the order's own account number (from the FILE, never a different one), on record for
    -- this manufacturer at a dealer in the chosen dealer's family. Otherwise the correction stands for this order only.
    if v_acct = '' then
      raise exception 'shipto_no_account: this order has no account number — the choice applies to this order only'; end if;
    if v_acct <> lower(trim(coalesce(p->'reported'->>'account_ref', ''))) then
      raise exception 'shipto_account_mismatch: the mapping must use the account number the report gives for this order'; end if;
    if not exists (select 1 from public.dealer_manufacturers dm join public.dealers x on x.id = dm.dealer_id
                    where dm.manufacturer = v_src.manufacturer and lower(trim(coalesce(dm.account_ref, ''))) = v_acct
                      and coalesce(x.parent_id, x.id) = coalesce(v_d.parent_id, v_d.id)) then
      raise exception 'shipto_account_family: account % is not on record for this dealer''s family at % — the choice applies to this order only', v_acct, v_src.manufacturer; end if;
    select * into v_map from public.mfr_shipto_mappings
     where manufacturer = v_src.manufacturer and account_ref = v_acct and ship_key = v_sk and retired_at is null for update;
    v_had := found;
    if v_had and v_map.dealer_id = v_d.id and v_map.scope = v_scope then
      v_mid := v_map.id; v_mres := 'existing';
      insert into public.mfr_shipto_events (source_id, correction_id, mapping_id, action, actor, detail)
      values (v_src.id, v_id, v_mid, 'mapping_reused', v_actor, jsonb_build_object('ship_key', v_sk, 'account_ref', v_acct));
    else
      if v_had then
        if not coalesce((p->>'replace_mapping')::boolean, false) then
          raise exception 'shipto_mapping_conflict: ship-to % of account % is already verified for another branch — confirm to replace it', v_sk, v_acct; end if;
        update public.mfr_shipto_mappings set retired_at = now(), retired_by = v_actor, retire_reason = 'replaced by correction #' || v_id || ': ' || v_reason
         where id = v_map.id and retired_at is null;
        insert into public.mfr_shipto_events (source_id, correction_id, mapping_id, action, actor, reason, detail)
        values (v_src.id, v_id, v_map.id, 'mapping_replaced', v_actor, v_reason, jsonb_build_object('old_dealer_id', v_map.dealer_id, 'new_dealer_id', v_d.id));
      end if;
      insert into public.mfr_shipto_mappings (manufacturer, account_ref, ship_key, scope, dealer_id, origin_correction_id, verified_by)
      values (v_src.manufacturer, v_acct, v_sk, v_scope, v_d.id, v_id, v_actor) returning id into v_mid;
      v_mres := case when v_had then 'replaced' else 'created' end;
      insert into public.mfr_shipto_events (source_id, correction_id, mapping_id, action, actor, detail)
      values (v_src.id, v_id, v_mid, 'mapping_verified', v_actor, jsonb_build_object('ship_key', v_sk, 'account_ref', v_acct, 'scope', v_scope, 'dealer_id', v_d.id));
    end if;
  end if;
  perform set_config('hcps.shipto_op', 'off', true);
  return jsonb_build_object('ok', true, 'correction_id', v_id, 'version', v_ver, 'mapping_id', v_mid, 'mapping', v_mres);
end $$;

-- 5. RETIRE a verified mapping (it stops matching future orders; past corrections and history stay).
create or replace function public.hcps_mfr_shipto_retire(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor text := trim(coalesce(p->>'actor', '')); v_reason text := trim(coalesce(p->>'reason', '')); v_map public.mfr_shipto_mappings;
begin
  if v_actor !~ '^staff:[^@\s]+@[^@\s]+$' then raise exception 'shipto_actor_required: the acting person (staff:<email>) is required'; end if;
  if length(v_reason) < 3 then raise exception 'shipto_reason_required: retiring a mapping needs a reason'; end if;
  select * into v_map from public.mfr_shipto_mappings where id = (p->>'mapping_id')::bigint for update;
  if not found then raise exception 'shipto_unknown_mapping: %', p->>'mapping_id'; end if;
  if v_map.retired_at is not null then raise exception 'shipto_already_retired: mapping % was retired %', v_map.id, v_map.retired_at; end if;
  perform set_config('hcps.shipto_op', 'on', true);
  update public.mfr_shipto_mappings set retired_at = now(), retired_by = v_actor, retire_reason = v_reason where id = v_map.id and retired_at is null;
  insert into public.mfr_shipto_events (mapping_id, action, actor, reason, detail)
  values (v_map.id, 'mapping_retired', v_actor, v_reason, jsonb_build_object('ship_key', v_map.ship_key, 'account_ref', v_map.account_ref, 'dealer_id', v_map.dealer_id));
  perform set_config('hcps.shipto_op', 'off', true);
  return jsonb_build_object('ok', true, 'mapping_id', v_map.id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Execute rights: the two functions to service_role only; the guard to nobody but the owner (RULE 19).
revoke all on function public.hcps_mfr_shipto_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_mfr_shipto_correct(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_mfr_shipto_retire(jsonb) from public, anon, authenticated;
grant execute on function public.hcps_mfr_shipto_correct(jsonb) to service_role;
grant execute on function public.hcps_mfr_shipto_retire(jsonb) to service_role;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'three Ship-To tables, RLS on, 0 policies' check_name,
         count(*) || ' tables, ' || count(*) filter (where c.relrowsecurity) || ' with RLS, ' ||
         (select count(*) from pg_policy pp join pg_class pc on pc.oid = pp.polrelid where pc.relnamespace = 'public'::regnamespace and pc.relname like 'mfr_shipto_%') || ' policies' value,
         count(*) = 3 and bool_and(c.relrowsecurity)
         and (select count(*) from pg_policy pp join pg_class pc on pc.oid = pp.polrelid where pc.relnamespace = 'public'::regnamespace and pc.relname like 'mfr_shipto_%') = 0 ok
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('mfr_shipto_corrections','mfr_shipto_mappings','mfr_shipto_events')
  union all select 2, 'grants to anon / authenticated / PUBLIC on the Ship-To tables (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC') and table_name like 'mfr_shipto_%'
  union all select 3, 'service_role: SELECT only on the Ship-To tables', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and grantee = 'service_role' and privilege_type <> 'SELECT' and table_name like 'mfr_shipto_%'
  union all select 4, 'Ship-To functions executable by anon / authenticated (expect 0)',
         (count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) + count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')))::text,
         count(*) filter (where has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) = 0
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'hcps_mfr_shipto_%'
  union all select 5, 'service_role executes correct + retire only (expect 2 of 3)',
         count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) || ' of ' || count(*),
         count(*) = 3 and count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 2
         and not has_function_privilege('service_role', 'public.hcps_mfr_shipto_guard()', 'execute')
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'hcps_mfr_shipto_%'
  union all select 6, 'security definer + pinned search_path on correct / retire', count(*)::text, count(*) = 2
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('hcps_mfr_shipto_correct','hcps_mfr_shipto_retire')
     and p.prosecdef and array_to_string(p.proconfig, ';') like 'search_path=%'
  union all select 7, 'guard triggers (row + truncate) on the three tables (expect 6)', count(*)::text, count(*) = 6
    from pg_trigger where tgname in ('mfr_shipto_guard','mfr_shipto_guard_truncate') and not tgisinternal
  union all select 8, 'one active mapping per manufacturer + account + ship-to key (unique index present)',
         coalesce((select indexdef from pg_indexes where indexname = 'mfr_shipto_mappings_active_uk'), 'missing'),
         exists (select 1 from pg_indexes where indexname = 'mfr_shipto_mappings_active_uk' and indexdef like '%WHERE (retired_at IS NULL)%')
  union all select 9, 'nothing written by the install (corrections / mappings / events)',
         (select count(*) from public.mfr_shipto_corrections) || ' / ' || (select count(*) from public.mfr_shipto_mappings) || ' / ' || (select count(*) from public.mfr_shipto_events),
         (select count(*) from public.mfr_shipto_corrections) + (select count(*) from public.mfr_shipto_mappings) + (select count(*) from public.mfr_shipto_events) = 0
  union all select 10, 'remembered mappings: account number required (blank refused) + account confirmed from dealer_manufacturers (manufacturer, dealer_id, account_ref)',
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'dealer_manufacturers' and column_name in ('manufacturer','dealer_id','account_ref'))
           || ' of 3 columns; blank check ' || case when exists (select 1 from pg_constraint where conrelid = 'public.mfr_shipto_mappings'::regclass and pg_get_constraintdef(oid) like '%account_ref <> %') then 'present' else 'missing' end,
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'dealer_manufacturers' and column_name in ('manufacturer','dealer_id','account_ref')) = 3
         and exists (select 1 from pg_constraint where conrelid = 'public.mfr_shipto_mappings'::regclass and pg_get_constraintdef(oid) like '%account_ref <> %')
) x order by n;
