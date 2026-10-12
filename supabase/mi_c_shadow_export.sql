-- Phase C shadow validation — READ-ONLY export (nothing is written). Produces ONE JSON value with exactly what the strict
-- Ship-To rules need to re-check history offline: dealers (no contacts, no reps), account numbers and aliases for the two
-- pilot manufacturers, saved ZIP assignments, and the Strongback + Bemis rows already booked in monthly_sales (order,
-- customer, account, ship-to city / state / ZIP, booked dealer, amount, month, lane). Run in the SQL editor; download the
-- result (Export → CSV) and attach it. Then: node scripts/shipto_shadow_local.js <file> [record-8 csv].
select jsonb_build_object(
  'exported_at', now(),
  'dealers', (select jsonb_agg(jsonb_build_object('id', d.id, 'business_name', d.business_name, 'parent_id', d.parent_id, 'city', d.city, 'state', d.state,
                'zip', d.zip, 'address', to_jsonb(d)->>'address', 'is_test', coalesce((to_jsonb(d)->>'is_test')::boolean, false)) order by d.id) from public.dealers d),
  'accounts', (select jsonb_agg(jsonb_build_object('manufacturer', m.manufacturer, 'dealer_id', m.dealer_id, 'account_ref', m.account_ref) order by m.manufacturer, m.dealer_id)
                from public.dealer_manufacturers m where m.manufacturer in ('strongback-mobility','bemis') and coalesce(m.account_ref, '') <> ''),
  'aliases', (select jsonb_agg(jsonb_build_object('alias_norm', a.alias_norm, 'dealer_id', a.dealer_id) order by a.alias_norm) from public.dealer_aliases a),
  'zipmaps', (select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) from public.app_settings s where s.key in ('zipmap:strongback-mobility','zipmap:bemis')),
  'history', (select jsonb_agg(jsonb_build_object('manufacturer', t.manufacturer, 'invoice_no', t.invoice_no, 'customer_name', t.customer_name, 'customer_ref', t.customer_ref,
                'ship_city', t.ship_city, 'ship_state', t.ship_state, 'ship_zip', t.ship_zip, 'dealer_id', t.dealer_id, 'amount', t.amount, 'period', t.period,
                'source', coalesce(t.source, '(none)')) order by t.manufacturer, t.period, t.invoice_no)
                from public.monthly_sales t where t.manufacturer in ('strongback-mobility','bemis'))
)::text as shadow_export;
