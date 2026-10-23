-- Launch readiness snapshot (2026-10-23, master assignment homecareproviderservicesordering#1, workstream A).
-- READ-ONLY: one SELECT, no writes, no functions called. Run in the Supabase SQL editor; copy the single JSON
-- value it returns into a file and pass it to:  node scripts/catalog-readiness.js --shop <ordering repo> --snapshot <file>
-- Deliberately carries NO wholesale prices: base_price is reduced to 1 (priced) or null (unpriced), so the file
-- is safe to keep in a working folder. Golden is excluded (separate portal).
select json_build_object(
  'taken_at', now(),
  'skus', coalesce((select json_agg(json_build_object(
      'manufacturer', manufacturer, 'code', code, 'status', status,
      'base_price', case when base_price > 0 then 1 end,
      'uom', uom, 'case_qty', case_qty,
      'has_map', map is not null, 'has_msrp', msrp is not null, 'msrp_auto', msrp_auto,
      'source_file', source_file, 'effective_date', effective_date) order by manufacturer, code)
    from public.product_skus where manufacturer <> 'golden'), '[]'::json),
  'pages', coalesce((select json_agg(json_build_object(
      'manufacturer', manufacturer, 'page_key', page_key, 'status', status, 'disabled', disabled,
      'skus', skus, 'published_at', published_at) order by manufacturer, page_key)
    from public.product_content where manufacturer <> 'golden'), '[]'::json),
  'meta', coalesce((select json_agg(json_build_object(
      'slug', slug, 'record_authoritative', record_authoritative, 'record_resync_error', record_resync_error,
      'frozen', frozen, 'deferrals', deferrals, 'freight_traced', (freight_terms ? 'trace')))
    from public.manufacturer_meta), '[]'::json),
  'runs', coalesce((select json_agg(json_build_object(
      'id', id, 'manufacturer', manufacturer, 'phase', phase, 'result', result,
      'fingerprint', fingerprint, 'run_at', run_at) order by run_at desc)
    from public.mfr_verification_runs), '[]'::json),
  'decisions', coalesce((select json_agg(json_build_object(
      'id', id, 'manufacturer', manufacturer, 'kind', kind, 'used_at', used_at) order by id)
    from public.mfr_decisions), '[]'::json)
) as readiness_snapshot;
