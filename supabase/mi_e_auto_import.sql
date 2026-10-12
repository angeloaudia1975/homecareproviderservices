-- ============================================================================================
-- MI Phase E — quarantine dispositions, import approvals and the automatic-import log
-- (Angelo, 2026-10-12 18:40 CT). Runs AFTER MI-1a, MI-1b, the September cleanup (monthly_sales_quarantine) and Phase C.
-- Safe to run twice. NOT RUN — Angelo runs it on approval.
--
-- What it adds
--   mfr_quarantine_dispositions  the President's decision on the quarantined rows of ONE manufacturer + month. The only
--                                disposition is keep_quarantined: those rows can never be restored, edited or deleted
--                                again (enforced below on monthly_sales_quarantine). It may name ONE registered order
--                                export of the same manufacturer + month that may then be CONSIDERED for import on its
--                                own. Considering it is not importing it: the import still needs a separate approval.
--   mfr_import_approvals         the President's single-use financial approval of ONE exact import plan (plan_hash) of
--                                ONE registered order export. Stamped once when used (imported / refused / superseded).
--   mfr_auto_import_log          append-only record of every automatic-import decision (imported, held, needs approval,
--                                refused, rolled back, error).
--   hcps_mfr_quarantine_dispose / hcps_mfr_import_approve / hcps_mfr_import_use / hcps_mfr_auto_import_log —
--                                the ONLY way these rows are written.
--
-- What it never does: write monthly_sales, restore or convert a quarantined row, import or accept a report, change any
-- MI-1a / MI-1b / Phase B / Phase C object. The quarantine safeguard is not removed anywhere: a month WITHOUT a
-- disposition stays blocked exactly as today, and a disposition only ever makes its rows MORE locked.
--
-- RULE 19: RLS on, no policies; anon / authenticated / PUBLIC hold nothing; service_role SELECT only; the functions are
-- security definer, executable by service_role only. After running: scripts/mi_e_public_probe_browser.js (expect 401).
-- pg-safeupdate: every UPDATE here carries a WHERE clause; there is no DELETE.
-- ============================================================================================
begin;

do $$ begin
  if to_regclass('public.monthly_sales_quarantine') is null then raise exception 'mi_e: monthly_sales_quarantine missing'; end if;
  if to_regprocedure('public.hcps_mfr_report_link_batch(jsonb)') is null then raise exception 'mi_e: MI-1b must be installed first'; end if;
  if to_regprocedure('public.hcps_sales_report_apply(jsonb)') is null then raise exception 'mi_e: MI-1a must be installed first'; end if;
  if to_regclass('public.staff_users') is null then raise exception 'mi_e: staff_users missing'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
create table if not exists public.mfr_quarantine_dispositions (
  id                 bigserial primary key,
  manufacturer       text not null,
  period             date not null check (period = date_trunc('month', period)::date),
  disposition        text not null check (disposition = 'keep_quarantined'),
  quarantine_ids     bigint[] not null check (cardinality(quarantine_ids) > 0),
  quarantine_fp      text not null check (quarantine_fp ~ '^[0-9a-f]{32}$'),
  release_source_id  bigint references public.mfr_sources(id),
  reason             text not null check (length(btrim(reason)) >= 10),
  actor              text not null check (actor ~ '^staff:.+@.+'),
  created_at         timestamptz not null default now(),
  unique (manufacturer, period)
);
create table if not exists public.mfr_import_approvals (
  id            bigserial primary key,
  source_id     bigint not null references public.mfr_sources(id),
  plan_hash     text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  items         jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  totals        jsonb not null default '{}'::jsonb,
  reason        text not null check (length(btrim(reason)) >= 10),
  actor         text not null check (actor ~ '^staff:.+@.+'),
  created_at    timestamptz not null default now(),
  used_at       timestamptz,
  used_by       text,
  used_outcome  text check (used_outcome in ('imported','refused','superseded','rolled_back')),
  batch_id      uuid,
  check ((used_at is null) = (used_outcome is null) and (used_at is null) = (used_by is null))
);
create unique index if not exists mfr_import_approvals_open_uk on public.mfr_import_approvals(source_id) where used_at is null;
create table if not exists public.mfr_auto_import_log (
  id          bigserial primary key,
  source_id   bigint not null references public.mfr_sources(id),
  outcome     text not null check (outcome in ('imported','held','needs_approval','refused','rolled_back','error')),
  plan_hash   text,
  approval_id bigint references public.mfr_import_approvals(id),
  batch_id    uuid,
  detail      jsonb not null default '{}'::jsonb,
  actor       text not null check (actor ~ '^(system:auto-import|staff:.+@.+)$'),
  created_at  timestamptz not null default now()
);
create index if not exists mfr_auto_import_log_source_ix on public.mfr_auto_import_log(source_id, id desc);

-- RULE 19 — not private by default in this project.
do $$ declare t text; s text; begin
  foreach t in array array['mfr_quarantine_dispositions','mfr_import_approvals','mfr_auto_import_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to service_role', t);
    s := pg_get_serial_sequence('public.' || t, 'id');
    execute format('revoke all on sequence %s from public, anon, authenticated, service_role', s);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Guard: rows change only inside the hcps_mfr_* functions below (marker + the owner's rights). Dispositions and the
--    log are never updated; an approval changes only by being stamped used, once; nothing is deleted or truncated.
create or replace function public.hcps_mfr_mi_e_guard()
returns trigger language plpgsql as $$
declare v_owner text;
begin
  if tg_level = 'STATEMENT' then raise exception 'mfr_mi_e_guard: % of % is not allowed', tg_op, tg_table_name; end if;
  if tg_op = 'DELETE' then raise exception 'mfr_mi_e_guard: rows of % are never deleted', tg_table_name; end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'mfr_import_approvals' then
    raise exception 'mfr_mi_e_guard: % is append-only', tg_table_name; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if coalesce(current_setting('hcps.mi_e_op', true), '') <> 'on' or current_user <> v_owner then
    raise exception 'mfr_mi_e_guard: % of % happens only through the hcps_mfr_* functions', tg_op, tg_table_name;
  end if;
  if tg_op = 'UPDATE' then
    if old.used_at is not null or new.used_at is null
       or (new.id, new.source_id, new.plan_hash, new.items, new.totals, new.reason, new.actor, new.created_at)
          is distinct from (old.id, old.source_id, old.plan_hash, old.items, old.totals, old.reason, old.actor, old.created_at) then
      raise exception 'mfr_mi_e_guard: an approval is only ever stamped used, once';
    end if;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['mfr_quarantine_dispositions','mfr_import_approvals','mfr_auto_import_log'] loop
    execute format('drop trigger if exists mfr_mi_e_guard on public.%I', t);
    execute format('create trigger mfr_mi_e_guard before insert or update or delete on public.%I for each row execute function public.hcps_mfr_mi_e_guard()', t);
    execute format('drop trigger if exists mfr_mi_e_guard_truncate on public.%I', t);
    execute format('create trigger mfr_mi_e_guard_truncate before truncate on public.%I for each statement execute function public.hcps_mfr_mi_e_guard()', t);
  end loop;
end $$;

-- 3. Permanent quarantine: a row of a month the President has disposed "keep quarantined" can never be restored, changed
--    or deleted again — by any path, the owner included (the cleanup's rollback file is refused for that month).
--    Months WITHOUT a disposition are untouched by this trigger (exactly today's behaviour).
create or replace function public.hcps_mfr_quarantine_lock()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_level = 'STATEMENT' then
    if exists (select 1 from public.mfr_quarantine_dispositions) then
      raise exception 'mfr_quarantine_locked: % of monthly_sales_quarantine is refused while a disposition exists', tg_op; end if;
    return null;
  end if;
  if exists (select 1 from public.mfr_quarantine_dispositions d
             where d.manufacturer = old.manufacturer and d.period = date_trunc('month', old.period)::date and old.id = any (d.quarantine_ids)) then
    raise exception 'mfr_quarantine_locked: quarantined row % (% %) is kept quarantined permanently by disposition — it is never restored, changed or deleted',
      old.id, old.manufacturer, to_char(old.period, 'YYYY-MM');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists mfr_quarantine_lock on public.monthly_sales_quarantine;
create trigger mfr_quarantine_lock before update or delete on public.monthly_sales_quarantine for each row execute function public.hcps_mfr_quarantine_lock();
drop trigger if exists mfr_quarantine_lock_truncate on public.monthly_sales_quarantine;
create trigger mfr_quarantine_lock_truncate before truncate on public.monthly_sales_quarantine for each statement execute function public.hcps_mfr_quarantine_lock();

-- ---------------------------------------------------------------------------------------------
-- 4. Functions
-- The quarantined rows of one manufacturer + month, as one fingerprint: md5 of "id:row_fp;" in id order (open rows only).
create or replace function public.hcps_mfr_quarantine_fp(p_mfr text, p_period date)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select md5(coalesce(string_agg(q.id || ':' || q.row_fp, ';' order by q.id), ''))
    from public.monthly_sales_quarantine q
   where q.manufacturer = p_mfr and date_trunc('month', q.period)::date = p_period and q.restored_at is null
$$;

-- An active President, named exactly as the server signs it ("staff:<email>").
create or replace function public.hcps_mfr_mi_e_president(p_actor text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_actor ~ '^staff:.+@.+', false) and exists (
    select 1 from public.staff_users s where lower(s.email) = lower(substr(p_actor, 7)) and s.role = 'president' and coalesce(s.active, true))
$$;

-- p = { manufacturer, period:'YYYY-MM', quarantine_fp (what the person saw), release_source_id?, reason, actor }
create or replace function public.hcps_mfr_quarantine_dispose(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mfr text := nullif(btrim(p->>'manufacturer'), ''); v_per date; v_fp text; v_ids bigint[];
        v_src public.mfr_sources; v_rel bigint := nullif(p->>'release_source_id', '')::bigint;
        v_reason text := nullif(btrim(p->>'reason'), ''); v_actor text := nullif(btrim(p->>'actor'), ''); v_id bigint;
begin
  if not public.hcps_mfr_mi_e_president(v_actor) then raise exception 'mi_e_president_only: a quarantine disposition is the President''s decision'; end if;
  if v_mfr is null or coalesce(p->>'period', '') !~ '^\d{4}-\d{2}$' then raise exception 'mi_e_bad_request: manufacturer and period (YYYY-MM) required'; end if;
  if v_reason is null or length(v_reason) < 10 then raise exception 'mi_e_reason_required: give the reason (10+ characters)'; end if;
  v_per := (p->>'period' || '-01')::date;
  perform pg_advisory_xact_lock(hashtext('hcps_quarantine:' || v_mfr || ':' || v_per));
  select array_agg(q.id order by q.id) into v_ids from public.monthly_sales_quarantine q
   where q.manufacturer = v_mfr and date_trunc('month', q.period)::date = v_per and q.restored_at is null;
  if v_ids is null then raise exception 'mi_e_nothing_quarantined: no open quarantined rows for % %', v_mfr, p->>'period'; end if;
  v_fp := public.hcps_mfr_quarantine_fp(v_mfr, v_per);
  if v_fp <> coalesce(p->>'quarantine_fp', '') then
    raise exception 'mi_e_quarantine_changed: the quarantined rows are not the ones you reviewed (fingerprint %) — review again', v_fp; end if;
  if exists (select 1 from public.mfr_quarantine_dispositions where manufacturer = v_mfr and period = v_per) then
    raise exception 'mi_e_already_disposed: % % already has a disposition — it is permanent', v_mfr, p->>'period'; end if;
  if v_rel is not null then
    select * into v_src from public.mfr_sources where id = v_rel;
    if not found or v_src.kind <> 'sales_export' or v_src.manufacturer <> v_mfr then
      raise exception 'mi_e_bad_release: record % is not an order export of %', v_rel, v_mfr; end if;
    if v_src.status not in ('received','accepted') or v_src.import_batch_id is not null then
      raise exception 'mi_e_bad_release: record % is % % — only a registered, not-yet-imported export can be released for consideration',
        v_rel, v_src.status, case when v_src.import_batch_id is null then '' else '(already imported)' end; end if;
    if date_trunc('month', v_src.report_period_start)::date <> v_per or date_trunc('month', v_src.report_period_end)::date <> v_per then
      raise exception 'mi_e_bad_release: record % covers % to %, not %', v_rel, v_src.report_period_start, v_src.report_period_end, p->>'period'; end if;
  end if;
  perform set_config('hcps.mi_e_op', 'on', true);
  insert into public.mfr_quarantine_dispositions (manufacturer, period, disposition, quarantine_ids, quarantine_fp, release_source_id, reason, actor)
  values (v_mfr, v_per, 'keep_quarantined', v_ids, v_fp, v_rel, v_reason, v_actor) returning id into v_id;
  perform set_config('hcps.mi_e_op', 'off', true);
  return jsonb_build_object('ok', true, 'disposition_id', v_id, 'manufacturer', v_mfr, 'period', p->>'period',
    'kept_quarantined', cardinality(v_ids), 'quarantine_fp', v_fp, 'release_source_id', v_rel);
end $$;

-- p = { source_id, plan_hash, items:[codes], totals:{…}, reason, actor, replace? }
create or replace function public.hcps_mfr_import_approve(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sid bigint := nullif(p->>'source_id', '')::bigint; v_src public.mfr_sources; v_open bigint; v_id bigint;
        v_actor text := nullif(btrim(p->>'actor'), ''); v_reason text := nullif(btrim(p->>'reason'), '');
begin
  if not public.hcps_mfr_mi_e_president(v_actor) then raise exception 'mi_e_president_only: a financial import approval is the President''s decision'; end if;
  if v_reason is null or length(v_reason) < 10 then raise exception 'mi_e_reason_required: give the reason (10+ characters)'; end if;
  if coalesce(p->>'plan_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'mi_e_bad_request: plan_hash required'; end if;
  select * into v_src from public.mfr_sources where id = v_sid for update;
  if not found or v_src.kind <> 'sales_export' then raise exception 'mi_e_bad_request: record % is not an order export', v_sid; end if;
  if v_src.status not in ('received','accepted') or v_src.import_batch_id is not null then
    raise exception 'mi_e_not_importable: record % is % %', v_sid, v_src.status, case when v_src.import_batch_id is null then '' else '(already imported)' end; end if;
  perform set_config('hcps.mi_e_op', 'on', true);
  select id into v_open from public.mfr_import_approvals where source_id = v_sid and used_at is null;
  if v_open is not null then
    if coalesce((p->>'replace')::boolean, false) is not true then
      raise exception 'mi_e_approval_pending: approval % is still open for record % (send replace to supersede it)', v_open, v_sid; end if;
    update public.mfr_import_approvals set used_at = now(), used_by = v_actor, used_outcome = 'superseded' where id = v_open;
  end if;
  insert into public.mfr_import_approvals (source_id, plan_hash, items, totals, reason, actor)
  values (v_sid, p->>'plan_hash', coalesce(p->'items', '[]'::jsonb), coalesce(p->'totals', '{}'::jsonb), v_reason, v_actor) returning id into v_id;
  perform set_config('hcps.mi_e_op', 'off', true);
  return jsonb_build_object('ok', true, 'approval_id', v_id, 'source_id', v_sid, 'plan_hash', p->>'plan_hash', 'superseded', v_open);
end $$;

-- p = { approval_id, plan_hash, outcome:'imported'|'refused'|'rolled_back', batch_id?, actor } — stamps the approval used, once.
create or replace function public.hcps_mfr_import_use(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_a public.mfr_import_approvals; v_actor text := nullif(btrim(p->>'actor'), '');
begin
  if v_actor is null or v_actor !~ '^(system:auto-import|staff:.+@.+)$' then raise exception 'mi_e_actor_required'; end if;
  if coalesce(p->>'outcome', '') not in ('imported','refused','rolled_back') then raise exception 'mi_e_bad_request: outcome'; end if;
  select * into v_a from public.mfr_import_approvals where id = nullif(p->>'approval_id', '')::bigint for update;
  if not found then raise exception 'mi_e_no_approval'; end if;
  if v_a.used_at is not null then raise exception 'mi_e_approval_used: approval % was already used (%)', v_a.id, v_a.used_outcome; end if;
  if v_a.plan_hash <> coalesce(p->>'plan_hash', '') then raise exception 'mi_e_plan_changed: approval % was for another plan', v_a.id; end if;
  perform set_config('hcps.mi_e_op', 'on', true);
  update public.mfr_import_approvals set used_at = now(), used_by = v_actor, used_outcome = p->>'outcome',
         batch_id = nullif(p->>'batch_id', '')::uuid where id = v_a.id;
  perform set_config('hcps.mi_e_op', 'off', true);
  return jsonb_build_object('ok', true, 'approval_id', v_a.id, 'outcome', p->>'outcome');
end $$;

-- p = { source_id, outcome, plan_hash?, approval_id?, batch_id?, detail, actor }
create or replace function public.hcps_mfr_auto_import_log(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  perform set_config('hcps.mi_e_op', 'on', true);
  insert into public.mfr_auto_import_log (source_id, outcome, plan_hash, approval_id, batch_id, detail, actor)
  values (nullif(p->>'source_id', '')::bigint, p->>'outcome', nullif(p->>'plan_hash', ''), nullif(p->>'approval_id', '')::bigint,
          nullif(p->>'batch_id', '')::uuid, coalesce(p->'detail', '{}'::jsonb), p->>'actor') returning id into v_id;
  perform set_config('hcps.mi_e_op', 'off', true);
  return jsonb_build_object('ok', true, 'log_id', v_id);
end $$;

-- 5. Execute rights (RULE 19): the four write functions + the fingerprint to service_role only; helpers / guards to nobody.
do $$ declare f text; begin
  foreach f in array array['public.hcps_mfr_mi_e_guard()', 'public.hcps_mfr_quarantine_lock()', 'public.hcps_mfr_mi_e_president(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['public.hcps_mfr_quarantine_fp(text, date)', 'public.hcps_mfr_quarantine_dispose(jsonb)', 'public.hcps_mfr_import_approve(jsonb)',
                           'public.hcps_mfr_import_use(jsonb)', 'public.hcps_mfr_auto_import_log(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'three Phase E tables, RLS on, 0 policies' check_name,
         count(*) || ' tables, ' || count(*) filter (where c.relrowsecurity) || ' with RLS' value,
         count(*) = 3 and bool_and(c.relrowsecurity)
         and (select count(*) from pg_policy pp join pg_class pc on pc.oid = pp.polrelid
               where pc.relname in ('mfr_quarantine_dispositions','mfr_import_approvals','mfr_auto_import_log')) = 0 ok
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname in ('mfr_quarantine_dispositions','mfr_import_approvals','mfr_auto_import_log')
  union all select 2, 'grants to anon / authenticated / PUBLIC (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
     and table_name in ('mfr_quarantine_dispositions','mfr_import_approvals','mfr_auto_import_log')
  union all select 3, 'service_role: SELECT only', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and grantee = 'service_role' and privilege_type <> 'SELECT'
     and table_name in ('mfr_quarantine_dispositions','mfr_import_approvals','mfr_auto_import_log')
  union all select 4, 'functions executable by anon / authenticated (expect 0)', count(*)::text, count(*) = 0
    from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('hcps_mfr_quarantine_fp','hcps_mfr_quarantine_dispose','hcps_mfr_import_approve','hcps_mfr_import_use','hcps_mfr_auto_import_log',
                       'hcps_mfr_mi_e_guard','hcps_mfr_quarantine_lock','hcps_mfr_mi_e_president')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  union all select 5, 'service_role executes the 5 public functions only (expect 5 of 8)',
         count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) || ' of ' || count(*),
         count(*) = 8 and count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 5
         and not has_function_privilege('service_role', 'public.hcps_mfr_mi_e_guard()', 'execute')
         and not has_function_privilege('service_role', 'public.hcps_mfr_mi_e_president(text)', 'execute')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('hcps_mfr_quarantine_fp','hcps_mfr_quarantine_dispose','hcps_mfr_import_approve','hcps_mfr_import_use','hcps_mfr_auto_import_log',
                       'hcps_mfr_mi_e_guard','hcps_mfr_quarantine_lock','hcps_mfr_mi_e_president')
  union all select 6, 'guard triggers: 3 tables × (row + truncate) + quarantine lock (row + truncate) (expect 8)', count(*)::text, count(*) = 8
    from pg_trigger where tgname in ('mfr_mi_e_guard','mfr_mi_e_guard_truncate','mfr_quarantine_lock','mfr_quarantine_lock_truncate') and not tgisinternal
  union all select 7, 'nothing written by the install (dispositions / approvals / log)',
         (select count(*) from public.mfr_quarantine_dispositions) || ' / ' || (select count(*) from public.mfr_import_approvals) || ' / ' || (select count(*) from public.mfr_auto_import_log),
         (select count(*) from public.mfr_quarantine_dispositions) + (select count(*) from public.mfr_import_approvals) + (select count(*) from public.mfr_auto_import_log) = 0
  union all select 8, 'quarantine untouched: open rows and their fingerprint for Strongback 2026-09',
         (select count(*) from public.monthly_sales_quarantine where manufacturer = 'strongback-mobility' and period >= '2026-09-01' and period < '2026-10-01' and restored_at is null)
           || ' rows · ' || public.hcps_mfr_quarantine_fp('strongback-mobility', '2026-09-01'),
         (select count(*) from public.monthly_sales_quarantine where manufacturer = 'strongback-mobility' and period >= '2026-09-01' and period < '2026-10-01' and restored_at is null) = 7
  union all select 9, 'monthly_sales unchanged (rows · amount · commission)',
         (select count(*) || ' · ' || coalesce(sum(amount),0) || ' · ' || coalesce(sum(commission),0) from public.monthly_sales), true
) x order by n;
