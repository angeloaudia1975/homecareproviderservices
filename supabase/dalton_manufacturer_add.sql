-- ============================================================================
-- Dalton Medical — register the manufacturer slug 'dalton'.
--
-- The website already carries Dalton (src/_data/manufacturers.json, id 'dalton')
-- and the ordering platform now lists it, but neither puts a row in the Supabase
-- `manufacturers` table. Until this runs:
--   · Dalton is missing from the Sales Report Import and Import Commissions
--     dropdowns, which are populated from this table
--     (dealers-api.js -> sbGet("manufacturers?select=slug,name,active")), and
--   · committing any Dalton sales fails the foreign key:
--       monthly_sales_manufacturer_fkey — Key (manufacturer)=(dalton) is not
--       present in table "manufacturers".
--
-- Slug 'dalton' matches the website manufacturer id and the ordering platform
-- slug, so the site, the shop, the catalog record and the sales system all agree
-- on one spelling — which is the thing that has cost the most time when it has
-- not been true (see ohio-medical vs gce).
--
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run. If a row
-- already exists (e.g. left inactive), it is re-activated and its name refreshed.
-- ============================================================================

insert into manufacturers (slug, name, active)
values ('dalton', 'Dalton Medical', true)
on conflict (slug) do update
  set name   = excluded.name,
      active = true;

-- ---- Verify (optional): should return exactly one active row ----
-- select slug, name, active from manufacturers where slug = 'dalton';
