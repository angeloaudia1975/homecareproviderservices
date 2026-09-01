-- ─────────────────────────────────────────────────────────────────────────────
-- PER-LINE LISTING MODE
--
-- On a manufacturer whose Product Content Enrichment & Review is finished, the
-- enrichment record IS the catalogue: a SKU that no published page lists is not a
-- finished product, and is not offered to dealers. Ovation Medical is the first
-- line in that state — 52 published pages, 52 product cards.
--
-- It is PER MANUFACTURER and defaults to FALSE on purpose. Most lines have no
-- enrichment pages at all (Access4U 228 SKUs, PediFix 515, and four others), so a
-- global rule would empty them. Turn it on for a line only once its enrichment is
-- complete; turning it off restores every SKU immediately.
--
-- Nothing is deleted by this flag. Unlisted SKUs keep their pricing, images, links
-- and order history, stay editable in the Product Catalog, and reappear the moment
-- a published page lists them.
-- ─────────────────────────────────────────────────────────────────────────────

alter table manufacturer_meta
  add column if not exists enriched_only boolean not null default false;

comment on column manufacturer_meta.enriched_only is
  'When true, Partner 360 lists only SKUs carried by a published product_content page for this manufacturer. Unlisted SKUs remain in the catalog, priced and intact.';

-- Ovation Medical: enrichment complete, 52 published pages.
insert into manufacturer_meta (slug, enriched_only)
values ('ovation-medical', true)
on conflict (slug) do update set enriched_only = true;

-- Verify:
--   select slug, enriched_only from manufacturer_meta order by slug;
