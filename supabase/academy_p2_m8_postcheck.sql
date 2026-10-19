-- HCPS Academy Phase 2 / M8 — read-only postcheck (run after the migration). Every row must read ok = true.
-- Expected installed-code fingerprint: see docs/academy/P2_M8_PAYMENTS.md (LF form, and the Windows-paste CRLF form).
select 'code fingerprint' as check,
       md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) as value,
       count(*) = 15 as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and (p.proname like 'academy\_purchase\_%' or p.proname = 'academy_prices_rights_check')
union all
select 'private tables (RLS on, 0 policies, no public grants)', null,
       (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
          and c.relname in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events')) = 5
   and not exists (select 1 from pg_policies where tablename in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events'))
   and not exists (select 1 from information_schema.role_table_grants where grantee in ('anon','authenticated','PUBLIC')
          and table_name in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events'))
union all
select 'server role: select only on the new tables', null,
       not exists (select 1 from information_schema.role_table_grants where grantee = 'service_role' and privilege_type <> 'SELECT'
          and table_name in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events'))
union all
select 'operations: 7 for the server role, none public', null,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_purchase\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not has_function_privilege('authenticated', p.oid, 'execute')) = 7
union all
select 'guards on all five tables + memberships + rights check', null,
       (select count(*) from pg_trigger where not tgisinternal and tgname in ('academy_purchase_guard','academy_purchase_member_guard','academy_prices_rights_check')) = 7
union all
select 'sandbox only + nothing sold yet', null,
       exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass and pg_get_constraintdef(oid) like '%livemode = false%')
   and not exists (select 1 from academy_purchases) and not exists (select 1 from academy_prices where outside_sale_allowed)
union all
select 'payments switch still off', null,
       coalesce((select value->'academy_payments' from app_settings where key = 'phase2_flags'), 'false'::jsonb) is distinct from 'true'::jsonb;
