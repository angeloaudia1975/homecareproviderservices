-- HCPS Academy — Phase 2 / M9 PREFLIGHT and POSTCHECK (READ-ONLY; changes nothing). Run before M9 and again after it.
-- Before M9: m8_installed true, m9_installed false, m8_fingerprint = the value in docs/academy/P2_M8_PAYMENTS.md
--            (or, if the file was pasted from Windows, its CRLF form), m8_functions 15, server_version recorded.
-- After M9:  m9_installed true, m9_functions 10, m9_server_ops 4, m9_public 0, m8_price_op_server false,
--            m8_fingerprint changes ONLY because academy_purchase_dealer_eligible was replaced (expected values in
--            docs/academy/P2_M9_REFUNDS.md); purchases / prices / organizations counts unchanged by M9.
select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'm8_installed', to_regclass('public.academy_purchases') is not null,
  'm9_installed', to_regclass('public.academy_refund_requests') is not null,
  'm8_functions', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_purchase\_%' or p.proname = 'academy_prices_rights_check')),
  'm8_fingerprint', (select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_purchase\_%' or p.proname = 'academy_prices_rights_check')),
  'm8_without_eligibility_fingerprint', (select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_purchase\_%' or p.proname = 'academy_prices_rights_check')
                        and p.proname <> 'academy_purchase_dealer_eligible'),
  'm9_functions', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_%'),
  'm9_fingerprint', (select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_%'),
  'm9_server_ops', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_op\_%'
                      and has_function_privilege('service_role', p.oid, 'execute')),
  'm9_public', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace = 'public'::regnamespace
                      and p.proname like 'academy\_sale\_%' and has_function_privilege(r, p.oid, 'execute')),
  'm8_price_op_server', case when to_regprocedure('public.academy_purchase_op_set_price(text,uuid,jsonb)') is null then null
                      else has_function_privilege('service_role', 'public.academy_purchase_op_set_price(text,uuid,jsonb)', 'execute') end,
  'rows', jsonb_build_object(
     'purchases', case when to_regclass('public.academy_purchases') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_purchases', false, true, '')))[1]::text::int end,
     'prices', case when to_regclass('public.academy_prices') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_prices', false, true, '')))[1]::text::int end,
     'on_sale', case when to_regclass('public.academy_prices') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_prices where outside_sale_allowed', false, true, '')))[1]::text::int end,
     'organizations', case when to_regclass('public.academy_organizations') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_organizations', false, true, '')))[1]::text::int end,
     'refund_requests', case when to_regclass('public.academy_refund_requests') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_refund_requests', false, true, '')))[1]::text::int end),
  'payments_switch', (select value->'academy_payments' from app_settings where key = 'phase2_flags')
) as m9_check;
