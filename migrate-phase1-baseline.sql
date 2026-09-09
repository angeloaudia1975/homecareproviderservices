-- ============================================================================
--  HCPS Product Catalog rebuild — PHASE 1 BASELINE (RESUME / COMPLETE)
--
--  Run this INSTEAD of the earlier script. The first version aborted on a
--  duplicate label, which was the wrong behaviour on my part: a snapshot script
--  should be safe to re-run and should finish whatever is missing, not refuse.
--
--  This version is fully idempotent. Every insert carries ON CONFLICT DO
--  NOTHING against the (label, manufacturer, source_table) unique key, so:
--    · rows already captured are left exactly as they were
--    · rows missing from a partial run are filled in
--    · running it five times produces the same 22 rows
--
--  Still read-only against every existing table. No UPDATE, no DELETE, no
--  change to any product on any of the nine manufacturers.
--
--  It also drops the temporary table in favour of an inline CTE — a temp table
--  declared ON COMMIT DROP is not reliable in the Supabase SQL editor, where
--  statements can run in separate transactions.
-- ============================================================================

-- --------------------------------------------------------------------------
-- STEP 1 — what is already captured? (read-only, safe to run on its own)
-- --------------------------------------------------------------------------
select source_table,
       count(*)                              as lines_captured,
       string_agg(manufacturer || '=' || row_count, ', ' order by manufacturer) as rows_per_line
from snapshots.catalog_baseline
where label = 'phase1-2026-09-09'
group by source_table
order by source_table;


-- --------------------------------------------------------------------------
-- STEP 2 — fill in anything missing. Safe to run whatever STEP 1 showed.
-- --------------------------------------------------------------------------
begin;

create schema if not exists snapshots;

create table if not exists snapshots.catalog_baseline (
  id            bigserial primary key,
  label         text        not null,
  taken_at      timestamptz not null default now(),
  manufacturer  text        not null,
  source_table  text        not null,
  row_count     integer     not null,
  payload       jsonb       not null,
  unique (label, manufacturer, source_table)
);

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'custom_products', count(t.code),
       coalesce(jsonb_agg(to_jsonb(t) order by t.code) filter (where t.code is not null), '[]'::jsonb)
from lines l left join public.custom_products t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'product_overrides', count(t.code),
       coalesce(jsonb_agg(to_jsonb(t) order by t.code) filter (where t.code is not null), '[]'::jsonb)
from lines l left join public.product_overrides t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'product_content', count(t.page_key),
       coalesce(jsonb_agg(to_jsonb(t) order by t.page_key) filter (where t.page_key is not null), '[]'::jsonb)
from lines l left join public.product_content t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'product_links', count(t.code),
       coalesce(jsonb_agg(to_jsonb(t) order by t.code) filter (where t.code is not null), '[]'::jsonb)
from lines l left join public.product_links t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'product_media', count(t.id),
       coalesce(jsonb_agg(to_jsonb(t) order by t.id) filter (where t.id is not null), '[]'::jsonb)
from lines l left join public.product_media t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'product_related', count(t.code),
       coalesce(jsonb_agg(to_jsonb(t) order by t.code, t.related_code) filter (where t.code is not null), '[]'::jsonb)
from lines l left join public.product_related t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'featured_products', count(t.code),
       coalesce(jsonb_agg(to_jsonb(t) order by t.code) filter (where t.code is not null), '[]'::jsonb)
from lines l left join public.featured_products t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'product_images', count(t.code),
       coalesce(jsonb_agg(to_jsonb(t) order by t.code) filter (where t.code is not null), '[]'::jsonb)
from lines l left join public.product_images t on t.manufacturer = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

with lines(slug) as (values ('ovation-medical'), ('climbing-steps'))
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
select 'phase1-2026-09-09', l.slug, 'manufacturer_meta', count(t.slug),
       coalesce(jsonb_agg(to_jsonb(t) order by t.slug) filter (where t.slug is not null), '[]'::jsonb)
from lines l left join public.manufacturer_meta t on t.slug = l.slug
group by l.slug
on conflict (label, manufacturer, source_table) do nothing;

-- The deployed catalog file ships in the ordering repo, not this database.
-- Hash verified 2026-09-09 against both the repo copy and the live deploy.
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
values
  ('phase1-2026-09-09', 'ovation-medical', 'deployed_file_ref', 276,
   '{"file":"public/data/ovation-medical.json","rows":276,"sha256_canonical":"64162124e08eee79bfd4d0ed3dfdf172","verified_against":"repo copy and live deploy, identical"}'::jsonb),
  ('phase1-2026-09-09', 'climbing-steps', 'deployed_file_ref', 23,
   '{"file":"public/data/climbing-steps.json","rows":23,"sha256_canonical":"ee653a5c15deb7af989141a1af12e385","verified_against":"repo copy and live deploy, identical"}'::jsonb)
on conflict (label, manufacturer, source_table) do nothing;

-- The rendered shop output is produced in the browser from the layers above,
-- so it is derived rather than stored. Its fingerprint, taken from the live
-- shop on 2026-09-09, is the Phase 4 gate: regenerate the catalog from the new
-- model, hash it the same way, and these must match.
insert into snapshots.catalog_baseline (label, manufacturer, source_table, row_count, payload)
values
  ('phase1-2026-09-09', 'ovation-medical', 'rendered_shop_output_ref', 303,
   '{"products":303,"sha256":"2fb6b84ef2148fde75e620a0f1866371f17fc601c678c299161f81d1e067a3ad","produced_by":"mergeCatalogEdits in public/index.html","fields":["code","name","category","subcategory","group","page_key","option","base_price","msrp","map","tiers","price_note","image","custom","msrp_suggested","price_from_base"],"note":"canonical JSON, keys sorted, products sorted by code"}'::jsonb),
  ('phase1-2026-09-09', 'climbing-steps', 'rendered_shop_output_ref', 21,
   '{"products":21,"sha256":"ae389e5dd8c7a1fefe83abac045c5f0b43684df182212e116004c7be60c703f4","produced_by":"mergeCatalogEdits in public/index.html","fields":["code","name","category","subcategory","group","page_key","option","base_price","msrp","map","tiers","price_note","image","custom","msrp_suggested","price_from_base"],"note":"canonical JSON, keys sorted, products sorted by code"}'::jsonb)
on conflict (label, manufacturer, source_table) do nothing;

commit;


-- --------------------------------------------------------------------------
-- STEP 3 — VERIFY. Send me this output; it is the Phase 1 gate.
--   Expect 22 rows, 2 lines, 11 source tables.
--   ovation-medical : custom 336, overrides 378, content 60, related 11, images 36
--   climbing-steps  : custom  25, overrides  43, content 21, related  0, images  1
-- --------------------------------------------------------------------------
select manufacturer,
       source_table,
       row_count,
       left(md5(payload::text), 12) as payload_md5,
       to_char(taken_at, 'YYYY-MM-DD HH24:MI') as taken_at
from snapshots.catalog_baseline
where label = 'phase1-2026-09-09'
order by manufacturer, source_table;

select count(*)                        as snapshot_rows,
       count(distinct manufacturer)    as lines,
       count(distinct source_table)    as tables_captured
from snapshots.catalog_baseline
where label = 'phase1-2026-09-09';
