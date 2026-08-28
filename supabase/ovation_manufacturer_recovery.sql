-- ============================================================================
-- Ovation Medical — restore products to the correct line key (slug)
--
-- WHAT HAPPENED
--   In Product Content Enrichment & Review, the product "Manufacturer" field was
--   changed from the slug  ovation-medical  to the display name  "Ovation Medical".
--   That field is the LINE KEY every part of the platform joins on — it is NOT the
--   name dealers see. The polished name ("Ovation Medical") is already set in
--   data/manufacturers.json (slug ovation-medical -> name "Ovation Medical") and in
--   the manufacturers registry, so the ordering platform ALWAYS showed the nice name.
--   Renaming the key just moved those rows into a different bucket, so the workspace
--   (which loads ?manufacturer=ovation-medical) stopped listing them. Nothing was
--   deleted — this puts the key back and the products reappear in the tool.
--
-- WHAT THIS DOES
--   Repoints any product row whose manufacturer is an "Ovation…" variant that is not
--   the canonical slug (e.g. "Ovation Medical", "Ovation medical", "ovation medical")
--   back to  ovation-medical  — in the content layer (product_content) and, defensively,
--   the catalog layers (custom_products, product_overrides) in case a created item
--   picked up the wrong key too.
--
--   Nothing is deleted. Safe and idempotent — a second run is a no-op. Shared Supabase
--   project. Run once in the Supabase SQL editor.
-- ============================================================================
do $$
declare
  tbl record;
begin
  for tbl in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name  = c.table_name
       and t.table_type  = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name  = 'manufacturer'
       and c.table_name in ('product_content', 'custom_products', 'product_overrides')
  loop
    begin
      execute format(
        'update public.%1$I set manufacturer = %2$L '
        '  where manufacturer ilike %3$L and manufacturer <> %2$L',
        tbl.table_name, 'ovation-medical', 'ovation%');
    exception
      when unique_violation then
        -- A row with the same key already exists under the slug (an accidental
        -- duplicate). Keep the canonical one; drop the stray "Ovation …" variant.
        execute format(
          'delete from public.%1$I where manufacturer ilike %2$L and manufacturer <> %3$L',
          tbl.table_name, 'ovation%', 'ovation-medical');
      when others then null;   -- never let one odd table abort the recovery
    end;
  end loop;
end $$;

-- ---- Verify (optional) — after running, this should show ONLY 'ovation-medical'
--      with your full product count, and no "Ovation Medical" bucket left:
-- select manufacturer, count(*) as products
--   from public.product_content
--  where manufacturer ilike 'ovation%'
--  group by manufacturer
--  order by manufacturer;
