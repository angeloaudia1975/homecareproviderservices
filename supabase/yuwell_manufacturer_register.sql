-- ============================================================================
-- Yuwell — register the manufacturer slug 'yuwell'  (DRAFT — NOT RUN; needs Angelo's explicit approval)
--
-- Owner decision 2026-11-04: Yuwell replaces Ohio Medical / GCE as HCPS's 12th manufacturing partner.
-- One spelling everywhere: 'yuwell' — website id, ordering slug, catalog record, sales and commission
-- system (the ohio-medical / gce split is the mistake this avoids).
--
-- What this does:
--   · manufacturers row (slug, name, active)  — Sales Report Import, Commission Report Import and the
--     monthly_sales foreign key need it (see dalton_manufacturer_add.sql).
--   · manufacturer_meta row with active = false — Manufacturer Center / catalog tooling can register sources
--     and staging for the line, while nothing in the storefront treats it as live.
--
-- What it does NOT do (each is its own later, approved step):
--   · no dealer_manufacturers rows (no dealer is entitled to Yuwell),
--   · no catalog file, no commercial record, no prices, no freight terms,
--   · no storefront listing (public/data/manufacturers.json is unchanged), so Yuwell is not orderable:
--     the order server prices only listed lines, and catalog-layers answers 403 to every dealer without a row.
--
-- Run once in the Supabase SQL editor of the ORDERING project. Idempotent; never re-activates a row a person
-- switched off later (manufacturer_meta: on conflict do nothing).
-- ============================================================================

insert into manufacturers (slug, name, active)
values ('yuwell', 'Yuwell', true)
on conflict (slug) do update set name = excluded.name;

insert into manufacturer_meta (slug, active, enriched_only, record_authoritative)
values ('yuwell', false, false, false)
on conflict (slug) do nothing;

-- ---- Verify: one manufacturers row, one manufacturer_meta row (active false), zero entitlements ----
select
  (select count(*) from manufacturers      where slug = 'yuwell')                       as manufacturers_rows,
  (select active from manufacturer_meta     where slug = 'yuwell')                       as meta_active,
  (select count(*) from dealer_manufacturers where manufacturer = 'yuwell')              as entitlement_rows;
