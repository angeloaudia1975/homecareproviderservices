-- ============================================================================
-- MI-1a · Part 1 of 2 — schema, write guard and atomic import functions (rev 2).
-- ADDITIVE ONLY: changes no existing row. Run once in the Supabase SQL editor; safe to re-run.
--   · report batches, superseded-row history, paid-month locks, identity columns
--   · identity ENROLMENT: a manufacturer/lane uses the new identity only once enrolled
--   · a database write guard: enrolled rows can be written only by the MI-1a functions
--   · hcps_sales_report_apply      — one file, all orders, one transaction
--   · hcps_commission_file_apply   — one file, ALL its months, one transaction
--   · hcps_import_batch_rollback   — undo one batch exactly
-- ============================================================================
begin;

-- 1. One row per imported file.
create table if not exists public.mfr_report_batches (
  id               uuid primary key default gen_random_uuid(),
  manufacturer     text not null references public.manufacturers(slug),
  lane             text not null check (lane in ('sales_report','commission')),
  source_file      text,
  content_sha      text not null,
  period_start     date,
  period_end       date,
  row_count        integer not null,
  total_amount     numeric(14,2) not null,
  total_commission numeric(14,2) not null,
  status           text not null default 'imported' check (status in ('imported','rolled_back')),
  actor            text,
  approvals        jsonb not null default '{}'::jsonb,
  summary          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists mfr_report_batches_mfr on public.mfr_report_batches(manufacturer, lane, created_at desc);

-- 2. Every row an import replaces or retires is kept here, whole.
create table if not exists public.monthly_sales_superseded (
  id                  bigint generated always as identity primary key,
  sales_row_id        text not null,
  manufacturer        text not null,
  period              date,
  order_key           text,
  reason              text not null check (reason in ('corrected','retired_missing','statement_replaced','rolled_back','duplicate_removed')),
  superseded_by_batch uuid references public.mfr_report_batches(id),
  superseded_at       timestamptz not null default now(),
  actor               text,
  row_data            jsonb not null
);
create index if not exists monthly_sales_superseded_batch on public.monthly_sales_superseded(superseded_by_batch);
create index if not exists monthly_sales_superseded_mfr   on public.monthly_sales_superseded(manufacturer, period);

-- 3. Months Angelo marks as paid.
create table if not exists public.commission_period_locks (
  manufacturer text not null references public.manufacturers(slug),
  period       date not null,
  locked_by    text not null,
  locked_at    timestamptz not null default now(),
  note         text,
  primary key (manufacturer, period)
);

-- 4. Enrolment: which manufacturer + lane is controlled by MI-1a. Empty after Part 1.
--    sales_report: added per manufacturer only after its identity audit passes (Strongback first).
--    commission:   added when the new commission path is switched on ('*' = every manufacturer).
create table if not exists public.mi1a_enrollment (
  manufacturer text not null,                 -- a slug, or '*' (commission lane only)
  lane         text not null check (lane in ('sales_report','commission')),
  enrolled_by  text not null,
  enrolled_at  timestamptz not null default now(),
  audit_note   text,
  primary key (manufacturer, lane),
  check (manufacturer <> '*' or lane = 'commission')
);

-- 5. Identity columns on monthly_sales (nullable).
alter table public.monthly_sales add column if not exists batch_id  uuid references public.mfr_report_batches(id);
alter table public.monthly_sales add column if not exists order_key text;
alter table public.monthly_sales add column if not exists line_key  text;
alter table public.monthly_sales add column if not exists line_hash text;
create index if not exists monthly_sales_order_key on public.monthly_sales(manufacturer, order_key) where order_key is not null;
create index if not exists monthly_sales_batch     on public.monthly_sales(batch_id) where batch_id is not null;

-- 6. Shared identity definition.
create or replace function public.hcps_ms_order_part(p_invoice text, p_order_date date, p_period date, p_customer text)
returns text language sql immutable as $$
  select case
    when nullif(upper(regexp_replace(btrim(coalesce(p_invoice,'')), '\s+', '', 'g')),'') is not null
      then 'O:' || upper(regexp_replace(btrim(p_invoice), '\s+', '', 'g'))
    else 'NOORDER:' || coalesce(p_order_date::text, p_period::text, '?') || ':'
         || left(upper(regexp_replace(coalesce(p_customer,''), '[^A-Za-z0-9]', '', 'g')), 40)
  end $$;

create or replace function public.hcps_ms_sku_part(p_code text, p_name text)
returns text language sql immutable as $$
  select left(upper(regexp_replace(btrim(coalesce(nullif(btrim(p_code),''), p_name, '')), '\s+', ' ', 'g')), 80) $$;

-- Money facts only. Non-financial differences are reported separately, never hashed.
create or replace function public.hcps_ms_line_hash(p_qty numeric, p_amount numeric, p_rate numeric, p_order_date date)
returns text language sql immutable as $$
  select md5(concat_ws('|', coalesce(trim_scale(p_qty)::text,''), coalesce(round(p_amount,2)::text,''),
                       coalesce(trim_scale(p_rate)::text,''), coalesce(p_order_date::text,''))) $$;

-- Order-independent fingerprint of one commission line (used for duplicate/overlap detection).
create or replace function public.hcps_ms_stmt_line(p_customer text, p_invoice text, p_code text, p_qty numeric, p_amount numeric, p_commission numeric)
returns text language sql immutable as $$
  select concat_ws('|', upper(regexp_replace(coalesce(p_customer,''), '[^A-Za-z0-9]', '', 'g')),
                   upper(btrim(coalesce(p_invoice,''))), upper(btrim(coalesce(p_code,''))),
                   coalesce(trim_scale(p_qty)::text,''), coalesce(round(p_amount,2)::text,''), coalesce(round(p_commission,2)::text,'')) $$;

create or replace function public.hcps_ms_is_commission_lane(p_source text, p_external_ref text)
returns boolean language sql immutable as $$ select p_source = 'commission' or (p_source is null and p_external_ref is null) $$;

-- 7. WRITE GUARD. On an enrolled manufacturer/lane, inserts, deletes and changes to money or key
--    columns are refused unless they come from the MI-1a functions (which set hcps.ms_writer for
--    their own transaction only). Dealer/rep re-attribution (dealer_id, rep_name, rep_id, channel)
--    stays allowed. PostgREST callers cannot set hcps.ms_writer, so old import endpoints are
--    blocked for enrolled rows — including during a rollback, until R1 removes the enrolment.
--    The row is protected when EITHER its OLD or its NEW classification (manufacturer + lane) is
--    enrolled: an enrolled row cannot escape by changing its manufacturer, source or external_ref,
--    and a row cannot be moved INTO an enrolled manufacturer/lane outside the MI-1a functions.
create or replace function public.hcps_ms_guarded(p_manufacturer text, p_source text, p_external_ref text)
returns boolean language sql stable security definer set search_path = public as $$
  -- security definer: the enrolment is always read in full, whoever triggers the write (RLS can't hide it).
  select exists (select 1 from public.mi1a_enrollment e
                  where e.lane = case when p_source = 'sales_report' then 'sales_report'
                                      when public.hcps_ms_is_commission_lane(p_source, p_external_ref) then 'commission' end
                    and (e.manufacturer = p_manufacturer or e.manufacturer = '*')) $$;

create or replace function public.hcps_ms_write_guard()
returns trigger language plpgsql as $$
declare v_old boolean := false; v_new boolean := false;
begin
  if current_setting('hcps.ms_writer', true) = 'mi1a' then return coalesce(new, old); end if;
  if tg_op in ('UPDATE','DELETE') then v_old := hcps_ms_guarded(old.manufacturer, old.source, old.external_ref); end if;
  if tg_op in ('UPDATE','INSERT') then v_new := hcps_ms_guarded(new.manufacturer, new.source, new.external_ref); end if;
  if not (v_old or v_new) then return coalesce(new, old); end if;
  if tg_op in ('INSERT','DELETE') then
    raise exception 'mi1a_write_guard: % on % rows for % happens only through the MI-1a import functions',
      tg_op, coalesce(new.source, old.source, 'commission'), coalesce(new.manufacturer, old.manufacturer);
  end if;
  if (new.manufacturer, new.period, new.amount, new.qty, new.commission, new.commission_rate, new.source,
      new.external_ref, new.order_key, new.line_key, new.line_hash, new.batch_id, new.invoice_no,
      new.product_code, new.order_date, new.source_file)
     is distinct from
     (old.manufacturer, old.period, old.amount, old.qty, old.commission, old.commission_rate, old.source,
      old.external_ref, old.order_key, old.line_key, old.line_hash, old.batch_id, old.invoice_no,
      old.product_code, old.order_date, old.source_file) then
    raise exception 'mi1a_write_guard: money/key/classification columns on enrolled rows (% → %) change only through the MI-1a import functions',
      old.manufacturer, new.manufacturer;
  end if;
  return new;
end $$;
drop trigger if exists hcps_ms_write_guard on public.monthly_sales;
create trigger hcps_ms_write_guard before insert or update or delete on public.monthly_sales
  for each row execute function public.hcps_ms_write_guard();

-- 8. SALES-REPORT import (one file, one transaction). Unit of replacement = the order.
create or replace function public.hcps_sales_report_apply(p jsonb)
returns jsonb language plpgsql as $fn$
declare
  v_mfr     text := p->>'manufacturer';
  v_apply   boolean := coalesce((p->>'apply')::boolean, false);
  v_actor   text := p->>'actor';
  v_retire  text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p->'retire_orders','[]'::jsonb))), '{}');
  v_ok_paid boolean := coalesce((p->>'approve_paid')::boolean, false);
  v_reason  text := nullif(btrim(coalesce(p->>'approve_reason','')),'');
  v_batch uuid; v_sha text; v_res jsonb; v_locked jsonb; v_coll jsonb; v_nonfin jsonb; v_xlane int;
  v_xok boolean := coalesce((p->>'confirm_cross_lane')::boolean, false);
  v_ins_n integer; v_ins_amt numeric; v_exp_n integer; v_exp_amt numeric;
begin
  perform set_config('hcps.ms_writer', 'mi1a', true);
  if v_mfr is null or not exists (select 1 from manufacturers where slug = v_mfr) then
    raise exception 'mi1a_bad_manufacturer: %', v_mfr; end if;
  -- Identity is per-manufacturer: only enrolled (audited) manufacturers use it.
  if not exists (select 1 from mi1a_enrollment where manufacturer = v_mfr and lane = 'sales_report') then
    raise exception 'mi1a_identity_not_approved: % has not passed the identity audit', v_mfr; end if;
  if jsonb_typeof(p->'rows') <> 'array' then raise exception 'mi1a_rows_required'; end if;
  perform pg_advisory_xact_lock(hashtext('hcps_ms_import:' || v_mfr));

  if to_regclass('pg_temp._in')  is not null then drop table _in;  end if;
  if to_regclass('pg_temp._old') is not null then drop table _old; end if;
  if to_regclass('pg_temp._cls') is not null then drop table _cls; end if;
  create temp table _in on commit drop as
  select r.*, null::text as k_order, null::text as k_sku, null::int as k_n, row_number() over () as k_pos
  from jsonb_populate_recordset(null::public.monthly_sales, p->'rows') r;
  if exists (select 1 from _in where manufacturer is distinct from v_mfr) then
    raise exception 'mi1a_row_manufacturer_mismatch'; end if;
  update _in set k_order = hcps_ms_order_part(invoice_no, order_date, period, customer_name),
                 k_sku   = hcps_ms_sku_part(product_code, product_name);
  update _in i set k_n = s.n from (
    select k_pos, row_number() over (partition by k_order, k_sku
             order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, k_pos) n
    from _in) s where s.k_pos = i.k_pos;
  update _in set order_key = v_mfr || '|' || k_order,
                 line_key  = k_order || '|' || k_sku || '|' || k_n,
                 external_ref = v_mfr || '|v2|' || k_order || '|' || k_sku || '|' || k_n,
                 line_hash = hcps_ms_line_hash(qty, amount, commission_rate, order_date),
                 source = 'sales_report';
  v_sha := md5(coalesce((select string_agg(line_key || '=' || line_hash, ',' order by line_key) from _in), ''));

  if exists (select 1 from monthly_sales where manufacturer = v_mfr and source = 'sales_report' and order_key is null) then
    raise exception 'mi1a_unkeyed_rows: % has rows without the MI-1a key', v_mfr; end if;
  create temp table _old on commit drop as
  select m.* from monthly_sales m
  where m.manufacturer = v_mfr and m.source = 'sales_report'
    and (m.order_key in (select distinct order_key from _in)
         or m.order_key = any (select v_mfr || '|' || x from unnest(v_retire) x));

  -- SEMANTIC COLLISIONS: one order number that is really two different orders.
  --   · inside the file: lines of one order with different customer refs, or order dates > 31 days apart
  --   · against HCPS: the stored order has a different customer ref, or order date > 31 days away
  select coalesce(jsonb_agg(c order by c->>'order_key'), '[]'::jsonb) into v_coll from (
    select jsonb_build_object('order_key', order_key, 'where', 'within_file',
             'customer_refs', jsonb_agg(distinct customer_ref) filter (where customer_ref is not null),
             'first_date', min(order_date), 'last_date', max(order_date)) c
    from _in group by order_key
    having count(distinct customer_ref) filter (where customer_ref is not null) > 1 or (max(order_date) - min(order_date)) > 31
    union all
    select jsonb_build_object('order_key', i.order_key, 'where', 'vs_hcps',
             'file_customer_ref', i.ref, 'hcps_customer_ref', o.ref, 'file_date', i.d, 'hcps_date', o.d)
    from (select order_key, min(customer_ref) ref, min(order_date) d from _in group by 1) i
    join (select order_key, min(customer_ref) ref, min(order_date) d from _old group by 1) o using (order_key)
    where (i.ref is not null and o.ref is not null and upper(btrim(i.ref)) <> upper(btrim(o.ref)))
       or abs(i.d - o.d) > 31
  ) z;

  create temp table _cls on commit drop as
  with i as (select order_key, string_agg(line_key||'='||line_hash, ',' order by line_key) sig, count(*) n, sum(amount) amt from _in group by 1),
       o as (select order_key, string_agg(line_key||'='||line_hash, ',' order by line_key) sig, count(*) n, sum(amount) amt from _old group by 1)
  select coalesce(i.order_key,o.order_key) order_key,
         case when o.order_key is null then 'new'
              when i.order_key is null then 'retire'
              when i.sig = o.sig then 'unchanged' else 'changed' end as kind,
         o.n old_lines, o.amt old_amount, i.n new_lines, i.amt new_amount
  from i full join o on o.order_key = i.order_key;

  -- NON-FINANCIAL DIFFERENCES between the file and what HCPS holds (same line key). Reported, never
  -- applied silently: stored dealer/rep attribution is kept; the differences go to preview + batch.
  select coalesce(jsonb_agg(d order by d->>'line_key', d->>'field'), '[]'::jsonb) into v_nonfin from (
    select jsonb_build_object('order_key', o.order_key, 'line_key', o.line_key, 'field', f.field,
                              'hcps', f.hcps_v, 'file', f.file_v,
                              'kept', case when f.field = 'dealer_id' then 'hcps' else 'file_on_correction_only' end) d
    from _old o join _in i on i.line_key = o.line_key
    cross join lateral (values
      ('dealer_id',     o.dealer_id::text, i.dealer_id::text),
      ('customer_name', o.customer_name,   i.customer_name),
      ('customer_ref',  o.customer_ref,    i.customer_ref),
      ('ship_city',     o.ship_city,       i.ship_city),
      ('ship_state',    o.ship_state,      i.ship_state),
      ('ship_zip',      o.ship_zip,        i.ship_zip),
      ('product_name',  o.product_name,    i.product_name)) f(field, hcps_v, file_v)
    where f.file_v is not null and upper(btrim(f.file_v)) is distinct from upper(btrim(f.hcps_v))
  ) z;

  select coalesce(jsonb_agg(distinct to_char(per,'YYYY-MM')), '[]'::jsonb) into v_locked from (
      select x.period per from (
        select o.period from _old o join _cls c using (order_key) where c.kind in ('changed','retire')
        union all
        select i.period from _in i join _cls c using (order_key) where c.kind in ('new','changed')) x
      where exists (select 1 from commission_period_locks l where l.manufacturer = v_mfr and l.period = x.period)
         or exists (select 1 from monthly_sales s where s.manufacturer = v_mfr and s.period = x.period
                    and hcps_ms_is_commission_lane(s.source, s.external_ref))
  ) z;

  -- CROSS-LANE: new/changed lines that match a commission-statement line for the same manufacturer,
  -- month, qty and amount — the same sale may already be counted through the commission lane.
  select coalesce(sum(least(a.n, b.n)),0) into v_xlane
  from (select i.period, round(i.amount,2) amt, trim_scale(i.qty) q, count(*) n from _in i join _cls c using (order_key)
        where c.kind in ('new','changed') and coalesce(i.amount,0) <> 0 group by 1,2,3) a
  join (select period, round(amount,2) amt, trim_scale(qty) q, count(*) n from monthly_sales
        where manufacturer = v_mfr and hcps_ms_is_commission_lane(source, external_ref) group by 1,2,3) b
    on b.period = a.period and b.amt = a.amt and b.q is not distinct from a.q;

  v_res := jsonb_build_object(
    'manufacturer', v_mfr, 'content_sha', v_sha, 'cross_lane_matches', v_xlane,
    'rows', (select count(*) from _in), 'total_amount', (select coalesce(sum(amount),0) from _in),
    'orders', jsonb_build_object(
       'new',       (select count(*) from _cls where kind='new'),
       'unchanged', (select count(*) from _cls where kind='unchanged'),
       'changed',   (select count(*) from _cls where kind='changed'),
       'retire',    (select count(*) from _cls where kind='retire')),
    'changed_detail', (select coalesce(jsonb_agg(to_jsonb(c) order by order_key),'[]') from _cls c where kind in ('changed','retire')),
    'missing_from_file', (select coalesce(jsonb_agg(distinct m.order_key),'[]') from monthly_sales m
        where m.manufacturer = v_mfr and m.source = 'sales_report'
          and m.order_date between (select min(order_date) from _in) and (select max(order_date) from _in)
          and m.order_key not in (select order_key from _in)
          and not (m.order_key = any (select v_mfr || '|' || x from unnest(v_retire) x))),
    'semantic_collisions', v_coll,
    'nonfinancial_differences', v_nonfin,
    'locked_months_touched', v_locked,
    'needs_paid_approval', jsonb_array_length(v_locked) > 0);

  if not v_apply then return v_res || jsonb_build_object('applied', false); end if;

  if jsonb_array_length(v_coll) > 0 then
    raise exception 'mi1a_semantic_collision: % order(s) — resolve before importing', jsonb_array_length(v_coll); end if;
  if jsonb_array_length(v_locked) > 0 and not (v_ok_paid and v_reason is not null) then
    raise exception 'mi1a_paid_period_change: % (approve_paid + approve_reason required)', v_locked; end if;
  if v_xlane > 0 and not (v_xok and v_reason is not null) then
    raise exception 'mi1a_cross_lane_duplicate: % line(s) match commission-statement lines (confirm_cross_lane + approve_reason required)', v_xlane; end if;
  if not exists (select 1 from _cls where kind in ('new','changed','retire')) then
    return v_res || jsonb_build_object('applied', true, 'noop', true); end if;

  insert into mfr_report_batches(manufacturer, lane, source_file, content_sha, period_start, period_end,
                                 row_count, total_amount, total_commission, actor, approvals, summary)
  select v_mfr, 'sales_report', p->>'source_file', v_sha, min(period), max(period), count(*),
         coalesce(sum(amount),0), coalesce(sum(commission),0), v_actor,
         case when v_ok_paid then jsonb_build_object('paid', v_locked, 'reason', v_reason, 'by', v_actor) else '{}'::jsonb end,
         v_res
  from _in returning id into v_batch;

  -- Confirmed attribution survives a correction.
  update _in i set dealer_id = k.dealer_id, rep_name = coalesce(k.rep_name, i.rep_name)
  from (select order_key, (array_agg(dealer_id))[1] dealer_id, (array_agg(rep_name))[1] rep_name
        from _old group by order_key having count(distinct dealer_id) = 1 and bool_and(dealer_id is not null)) k
  join _cls c on c.order_key = k.order_key and c.kind = 'changed'
  where i.order_key = k.order_key;

  insert into monthly_sales_superseded(sales_row_id, manufacturer, period, order_key, reason, superseded_by_batch, actor, row_data)
  select o.id::text, o.manufacturer, o.period, o.order_key,
         case c.kind when 'retire' then 'retired_missing' else 'corrected' end, v_batch, v_actor, to_jsonb(o)
  from _old o join _cls c using (order_key) where c.kind in ('changed','retire');
  delete from monthly_sales m using _cls c
  where m.manufacturer = v_mfr and m.source = 'sales_report' and m.order_key = c.order_key and c.kind in ('changed','retire');
  insert into monthly_sales(dealer_id, manufacturer, period, order_date, invoice_no, product_code, product_name, qty, amount,
                            commission, commission_rate, customer_name, customer_ref, ship_city, ship_state, ship_zip,
                            line_type, source, external_ref, source_file, imported_at, rep_name,
                            batch_id, order_key, line_key, line_hash)
  select i.dealer_id, i.manufacturer, i.period, i.order_date, i.invoice_no, i.product_code, i.product_name, i.qty, i.amount,
         i.commission, i.commission_rate, i.customer_name, i.customer_ref, i.ship_city, i.ship_state, i.ship_zip,
         i.line_type, 'sales_report', i.external_ref, p->>'source_file', now(), i.rep_name,
         v_batch, i.order_key, i.line_key, i.line_hash
  from _in i join _cls c using (order_key) where c.kind in ('new','changed');
  get diagnostics v_ins_n = row_count;

  select count(*), coalesce(sum(amount),0) into v_exp_n, v_exp_amt from _in i join _cls c using (order_key) where c.kind in ('new','changed');
  select coalesce(sum(amount),0) into v_ins_amt from monthly_sales where batch_id = v_batch;
  if v_ins_n <> v_exp_n or v_ins_amt <> v_exp_amt then
    raise exception 'mi1a_assert_insert: rows %/% amount %/%', v_ins_n, v_exp_n, v_ins_amt, v_exp_amt; end if;
  if exists (select 1 from monthly_sales m join _cls c on c.order_key = m.order_key
             where m.manufacturer = v_mfr and m.source='sales_report' and c.kind = 'retire') then
    raise exception 'mi1a_assert_retire'; end if;

  return v_res || jsonb_build_object('applied', true, 'batch_id', v_batch, 'inserted', v_ins_n,
                                     'superseded', (select count(*) from monthly_sales_superseded where superseded_by_batch = v_batch));
end $fn$;

-- 9. COMMISSION import: one file with ANY number of months, one transaction.
--    p = { manufacturer, source_file, apply, actor, approve_paid, approve_reason,
--          months: [ { period:'YYYY-MM-01', rows:[...], control_total? } ],
--          decisions: { 'YYYY-MM': { action:'replace'|'append'|'reject', replace_files:[...], reason, confirm_overlap } } }
--    Every month that already holds commission-lane rows — from ANY file, imported before or after MI-1a —
--    needs an explicit decision. A file name is never evidence of a new statement.
create or replace function public.hcps_commission_file_apply(p jsonb)
returns jsonb language plpgsql as $fn$
declare
  v_mfr   text := p->>'manufacturer';
  v_file  text := nullif(btrim(coalesce(p->>'source_file','')),'');
  v_apply boolean := coalesce((p->>'apply')::boolean, false);
  v_actor text := p->>'actor';
  v_ok_paid boolean := coalesce((p->>'approve_paid')::boolean, false);
  v_reason  text := nullif(btrim(coalesce(p->>'approve_reason','')),'');
  v_months jsonb := '[]'::jsonb; v_m jsonb; v_per date; v_key text; v_dec jsonb; v_act text;
  v_sha text; v_n int; v_amt numeric; v_com numeric; v_ctrl numeric;
  v_files jsonb; v_ident jsonb; v_overlap int; v_old_n int; v_locked boolean; v_rfiles text[]; v_xlane int;
  v_month jsonb; v_errors jsonb := '[]'::jsonb; v_batch uuid; v_res jsonb;
  v_tot_n int := 0; v_tot_amt numeric := 0; v_tot_com numeric := 0;
begin
  perform set_config('hcps.ms_writer', 'mi1a', true);
  if v_mfr is null or not exists (select 1 from manufacturers where slug = v_mfr) then raise exception 'mi1a_bad_manufacturer: %', v_mfr; end if;
  if jsonb_typeof(p->'months') <> 'array' or jsonb_array_length(p->'months') = 0 then raise exception 'mi1a_months_required'; end if;
  perform pg_advisory_xact_lock(hashtext('hcps_ms_import:' || v_mfr));
  if to_regclass('pg_temp._cin') is not null then drop table _cin; end if;
  create temp table _cin on commit drop as
  select (m->>'period')::date as k_period, r.*
  from jsonb_array_elements(p->'months') m, jsonb_populate_recordset(null::public.monthly_sales, m->'rows') r;
  if exists (select 1 from _cin where manufacturer is distinct from v_mfr or period is distinct from k_period
             or k_period <> date_trunc('month', k_period)::date) then
    raise exception 'mi1a_row_scope_mismatch: every row must carry its month and the manufacturer'; end if;
  if (select count(*) from (select (m->>'period') from jsonb_array_elements(p->'months') m group by 1 having count(*) > 1) d) > 0 then
    raise exception 'mi1a_duplicate_month_in_file'; end if;

  -- PASS 1 — review every month (no writes).
  for v_m in select * from jsonb_array_elements(p->'months') order by (value->>'period') loop
    v_per := (v_m->>'period')::date; v_key := to_char(v_per,'YYYY-MM');
    v_dec := p->'decisions'->v_key; v_act := coalesce(v_dec->>'action', '');
    v_ctrl := nullif(v_m->>'control_total','')::numeric;
    select md5(coalesce(string_agg(f, ',' order by f),'')), count(*), coalesce(sum(amount),0), coalesce(sum(commission),0)
      into v_sha, v_n, v_amt, v_com
    from (select amount, commission, hcps_ms_stmt_line(customer_name, invoice_no, product_code, qty, amount, commission) f
          from _cin where k_period = v_per) x;
    -- What HCPS already holds for this month, by file (pre-MI-1a rows included: no batch needed).
    select coalesce(jsonb_agg(jsonb_build_object('file', fl, 'rows', n, 'amount', amt, 'commission', com,
                     'loaded', case when nb then 'before MI-1a' else 'MI-1a batch' end, 'identical', sha = v_sha) order by fl), '[]'::jsonb),
           coalesce(jsonb_agg(fl) filter (where sha = v_sha), '[]'::jsonb)
      into v_files, v_ident
    from (select coalesce(source_file,'(no file name)') fl, count(*) n, sum(amount) amt, sum(commission) com, bool_and(batch_id is null) nb,
                 md5(string_agg(hcps_ms_stmt_line(customer_name, invoice_no, product_code, qty, amount, commission), ',' order by
                                hcps_ms_stmt_line(customer_name, invoice_no, product_code, qty, amount, commission))) sha
          from monthly_sales where manufacturer = v_mfr and period = v_per and hcps_ms_is_commission_lane(source, external_ref)
          group by 1) g;
    select count(*) into v_old_n from monthly_sales where manufacturer = v_mfr and period = v_per and hcps_ms_is_commission_lane(source, external_ref);
    -- Lines in this file that already exist in the month (multiset overlap, any file).
    select coalesce(sum(least(a.n, b.n)),0) into v_overlap
    from (select hcps_ms_stmt_line(customer_name, invoice_no, product_code, qty, amount, commission) f, count(*) n from _cin where k_period = v_per group by 1) a
    join (select hcps_ms_stmt_line(customer_name, invoice_no, product_code, qty, amount, commission) f, count(*) n from monthly_sales
          where manufacturer = v_mfr and period = v_per and hcps_ms_is_commission_lane(source, external_ref) group by 1) b using (f);
    select coalesce(sum(least(a.n, b.n)),0) into v_xlane
    from (select round(amount,2) amt, trim_scale(qty) q, count(*) n from _cin where k_period = v_per and coalesce(amount,0) <> 0 group by 1,2) a
    join (select round(amount,2) amt, trim_scale(qty) q, count(*) n from monthly_sales
          where manufacturer = v_mfr and period = v_per and source = 'sales_report' group by 1,2) b
      on b.amt = a.amt and b.q is not distinct from a.q;
    v_locked := v_old_n > 0 or exists (select 1 from commission_period_locks l where l.manufacturer = v_mfr and l.period = v_per);
    v_month := jsonb_build_object('month', v_key, 'rows', v_n, 'amount', v_amt, 'commission', v_com, 'content_sha', v_sha,
      'existing_files', v_files, 'identical_to', v_ident, 'overlapping_lines', v_overlap, 'cross_lane_matches', v_xlane,
      'needs_decision', v_old_n > 0, 'decision', nullif(v_act,''), 'needs_paid_approval', v_locked);

    -- Validate the decision for this month.
    if v_ctrl is not null and round(v_com,2) <> round(v_ctrl,2) then
      v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'control_total_mismatch', 'rows', v_com, 'statement', v_ctrl);
    end if;
    if v_old_n > 0 and v_act = '' then
      v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'decision_required');
    elsif v_act not in ('', 'replace', 'append', 'reject') then
      v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'bad_decision');
    elsif v_act = 'append' then
      if jsonb_array_length(v_ident) > 0 then
        v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'append_identical_statement', 'identical_to', v_ident);
      elsif nullif(btrim(coalesce(v_dec->>'reason','')),'') is null then
        v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'append_needs_reason');
      elsif v_overlap > 0 and not coalesce((v_dec->>'confirm_overlap')::boolean, false) then
        v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'append_overlaps_existing_lines', 'overlapping_lines', v_overlap);
      end if;
    elsif v_act = 'replace' then
      v_rfiles := array(select jsonb_array_elements_text(coalesce(v_dec->'replace_files','[]'::jsonb)));
      if cardinality(v_rfiles) = 0 then
        v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'replace_needs_files');
      elsif exists (select 1 from unnest(v_rfiles) f where not exists (select 1 from jsonb_array_elements(v_files) e where e->>'file' = f)) then
        v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'replace_file_not_found');
      end if;
    elsif v_act = 'reject' and v_old_n = 0 then
      null;   -- rejecting a new month is allowed: nothing is written for it
    end if;
    if v_act <> 'reject' and v_xlane > 0 and not coalesce((v_dec->>'confirm_cross_lane')::boolean, false) then
      v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'cross_lane_duplicate', 'matching_sales_report_lines', v_xlane);
    end if;
    if v_act in ('', 'replace', 'append') and v_locked and v_act <> 'reject' and not (v_ok_paid and v_reason is not null) then
      v_errors := v_errors || jsonb_build_object('month', v_key, 'error', 'paid_period_change');
    end if;
    v_months := v_months || v_month;
    if v_act <> 'reject' then v_tot_n := v_tot_n + v_n; v_tot_amt := v_tot_amt + v_amt; v_tot_com := v_tot_com + v_com; end if;
  end loop;

  v_res := jsonb_build_object('manufacturer', v_mfr, 'source_file', v_file, 'months', v_months, 'problems', v_errors,
                              'will_write', jsonb_build_object('rows', v_tot_n, 'amount', v_tot_amt, 'commission', v_tot_com));
  if not v_apply then return v_res || jsonb_build_object('applied', false); end if;
  if jsonb_array_length(v_errors) > 0 then
    raise exception 'mi1a_commission_file_refused: %', v_errors; end if;
  if v_tot_n = 0 then return v_res || jsonb_build_object('applied', true, 'noop', true); end if;

  -- PASS 2 — write every month, still inside the same transaction.
  insert into mfr_report_batches(manufacturer, lane, source_file, content_sha, period_start, period_end, row_count,
                                 total_amount, total_commission, actor, approvals, summary)
  select v_mfr, 'commission', v_file, md5(string_agg(e->>'content_sha', ',' order by e->>'month')),
         min((e->>'month' || '-01')::date), max((e->>'month' || '-01')::date), v_tot_n, v_tot_amt, v_tot_com, v_actor,
         jsonb_build_object('paid', case when v_ok_paid then jsonb_build_object('reason', v_reason, 'by', v_actor) end,
                            'decisions', coalesce(p->'decisions','{}'::jsonb)), v_res
  from jsonb_array_elements(v_months) e
  returning id into v_batch;

  for v_m in select * from jsonb_array_elements(p->'months') order by (value->>'period') loop
    v_per := (v_m->>'period')::date; v_key := to_char(v_per,'YYYY-MM');
    v_dec := p->'decisions'->v_key; v_act := coalesce(v_dec->>'action', '');
    continue when v_act = 'reject';
    if v_act = 'replace' then
      v_rfiles := array(select jsonb_array_elements_text(v_dec->'replace_files'));
      insert into monthly_sales_superseded(sales_row_id, manufacturer, period, order_key, reason, superseded_by_batch, actor, row_data)
      select m.id::text, m.manufacturer, m.period, null, 'statement_replaced', v_batch, v_actor, to_jsonb(m)
      from monthly_sales m where m.manufacturer = v_mfr and m.period = v_per and hcps_ms_is_commission_lane(m.source, m.external_ref)
        and coalesce(m.source_file,'(no file name)') = any (v_rfiles);
      delete from monthly_sales m where m.manufacturer = v_mfr and m.period = v_per and hcps_ms_is_commission_lane(m.source, m.external_ref)
        and coalesce(m.source_file,'(no file name)') = any (v_rfiles);
    end if;
    insert into monthly_sales(dealer_id, manufacturer, period, amount, qty, product_code, product_name, commission, customer_name,
         customer_ref, rep_name, rep_id, hcps_account, cost, ship_city, ship_state, ship_zip, ship_name, ship_address, order_date, channel,
         item_no, line_type, credit_reason, invoice_no, commission_rate, billed_amount, memo, source, source_file, imported_at, batch_id)
    select dealer_id, manufacturer, period, amount, qty, product_code, product_name, commission, customer_name,
         customer_ref, rep_name, rep_id, hcps_account, cost, ship_city, ship_state, ship_zip, ship_name, ship_address, order_date, channel,
         item_no, line_type, credit_reason, invoice_no, commission_rate, billed_amount, memo, 'commission', v_file, now(), v_batch
    from _cin where k_period = v_per;
  end loop;

  if (select count(*) from monthly_sales where batch_id = v_batch) <> v_tot_n
     or (select coalesce(sum(commission),0) from monthly_sales where batch_id = v_batch) <> v_tot_com then
    raise exception 'mi1a_assert_commission_file'; end if;
  return v_res || jsonb_build_object('applied', true, 'batch_id', v_batch);
end $fn$;

-- The month-only function from rev 1 is retired: a file is always applied whole.
drop function if exists public.hcps_commission_month_apply(jsonb);

-- 10. Undo one batch exactly (newest first).
create or replace function public.hcps_import_batch_rollback(p jsonb)
returns jsonb language plpgsql as $fn$
declare v_batch uuid := (p->>'batch_id')::uuid; v_actor text := p->>'actor'; v_mfr text; v_del int; v_res int;
begin
  perform set_config('hcps.ms_writer', 'mi1a', true);
  select manufacturer into v_mfr from mfr_report_batches where id = v_batch and status = 'imported' for update;
  if v_mfr is null then raise exception 'mi1a_batch_not_found_or_already_rolled_back'; end if;
  perform pg_advisory_xact_lock(hashtext('hcps_ms_import:' || v_mfr));
  if exists (select 1 from monthly_sales_superseded s
             where s.row_data->>'batch_id' = v_batch::text and s.reason <> 'rolled_back'
               and s.superseded_by_batch in (select id from mfr_report_batches where status = 'imported')) then
    raise exception 'mi1a_rollback_newer_batch_first'; end if;
  insert into monthly_sales_superseded(sales_row_id, manufacturer, period, order_key, reason, superseded_by_batch, actor, row_data)
  select m.id::text, m.manufacturer, m.period, m.order_key, 'rolled_back', v_batch, v_actor, to_jsonb(m) from monthly_sales m where m.batch_id = v_batch;
  delete from monthly_sales where batch_id = v_batch; get diagnostics v_del = row_count;
  insert into monthly_sales overriding system value
  select r.* from monthly_sales_superseded s, jsonb_populate_record(null::public.monthly_sales, s.row_data) r
  where s.superseded_by_batch = v_batch and s.reason in ('corrected','retired_missing','statement_replaced');
  get diagnostics v_res = row_count;
  update mfr_report_batches set status = 'rolled_back', summary = summary || jsonb_build_object('rolled_back_by', v_actor, 'rolled_back_at', now()) where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'removed', v_del, 'restored', v_res);
end $fn$;

revoke all on function public.hcps_sales_report_apply(jsonb)     from public, anon, authenticated;
revoke all on function public.hcps_commission_file_apply(jsonb)  from public, anon, authenticated;
revoke all on function public.hcps_import_batch_rollback(jsonb)  from public, anon, authenticated;
grant execute on function public.hcps_sales_report_apply(jsonb)    to service_role;
grant execute on function public.hcps_commission_file_apply(jsonb) to service_role;
grant execute on function public.hcps_import_batch_rollback(jsonb) to service_role;
alter table public.mfr_report_batches       enable row level security;
alter table public.monthly_sales_superseded enable row level security;
alter table public.commission_period_locks  enable row level security;
alter table public.mi1a_enrollment          enable row level security;

commit;
