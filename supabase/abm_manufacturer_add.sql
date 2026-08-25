-- ============================================================================
-- ABM Respiratory Care — register the manufacturer slug 'abm-respiratory-care'.
--
-- Symptom: "ABM Medical is not listed in Sales Report Import."
--   The Sales Report Import manufacturer dropdown is populated from the
--   Supabase `manufacturers` table (dealers-api.js →
--   sbGet("manufacturers?select=slug,name,active"), filtered to active rows).
--   ABM was never inserted there, so it never appears in the dropdown — and a
--   sales commit would also fail the monthly_sales -> manufacturers foreign key:
--     monthly_sales_manufacturer_fkey — Key (manufacturer)=(abm-respiratory-care)
--     is not present in table "manufacturers".
--
-- Slug matches the website manufacturer id in src/_data/manufacturers.json
-- ('abm-respiratory-care'), so the sales system and the public site stay aligned.
--
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run. If a row
-- already exists (e.g. left inactive), it is re-activated and its name refreshed.
-- After running, reload Sales Report Import — "ABM Respiratory Care" will appear
-- in the manufacturer dropdown.
-- ============================================================================

insert into manufacturers (slug, name, active)
values ('abm-respiratory-care', 'ABM Respiratory Care', true)
on conflict (slug) do update
  set name   = excluded.name,
      active = true;

-- ---- Verify (optional): should return exactly one active row ----
-- select slug, name, active from manufacturers where slug = 'abm-respiratory-care';
