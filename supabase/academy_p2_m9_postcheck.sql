-- HCPS Academy — Phase 2 / M9 postcheck (READ-ONLY). Run after M9; every row must read ok = true, and row 1's
-- fingerprint must equal the value recorded in docs/academy/P2_M8_PAYMENTS.md (Unix or Windows-paste form).
select 'code fingerprint (4 functions)' as check,
       md5(string_agg(p.proname || ':' || p.prosrc, '|' order by p.proname)) as value,
       count(*) = 4 as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('academy_purchase_op_open','academy_purchase_op_attach','academy_purchase_op_stripe_event','academy_purchase_live_mode')
union all
select 'live payments allowed by the table; tax + event columns present', null,
       not exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass and pg_get_constraintdef(oid) like '%livemode = false%')
   and exists (select 1 from information_schema.columns where table_name = 'academy_purchases' and column_name = 'amount_tax_cents')
   and (select count(*) from information_schema.columns where table_name = 'academy_stripe_events' and column_name in ('livemode','payment_intent','detail')) = 3
union all
select 'live switch still off', null,
       not coalesce((select (value->'academy_payments_live') = 'true'::jsonb from app_settings where key = 'phase2_flags'), false)
union all
select 'ops for service_role only; helper for nobody', null,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_purchase\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not has_function_privilege('authenticated', p.oid, 'execute')) = 7
   and not has_function_privilege('service_role', 'public.academy_purchase_live_mode()', 'execute')
   and not has_function_privilege('anon', 'public.academy_purchase_live_mode()', 'execute')
union all
select 'tables private (RLS on; anon/authenticated nothing; service_role read only)', null,
       (select count(*) from pg_class c where c.relname in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events')
          and c.relrowsecurity and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
          and not has_table_privilege('service_role', c.oid, 'insert') and not has_table_privilege('service_role', c.oid, 'update')) = 5
union all
select 'no live purchase yet', null, not exists (select 1 from academy_purchases where livemode);
