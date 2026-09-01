-- ─────────────────────────────────────────────────────────────────────────────
-- CATEGORY DISPLAY ORDER, PER MANUFACTURER
--
-- The shop was ordering categories two different ways: the filter dropdown used
-- whatever order the catalog file happened to list products in, and the page used
-- alphabetical. Neither was a decision, so Back & Spine led the page while the
-- dropdown started at Foot & Ankle.
--
-- This stores ONE deliberate order per line. Both the dropdown and the scroll order
-- read it, so they can never disagree again. Any category not named in the list is
-- appended alphabetically, which means a new category always appears — it just
-- appears last until someone places it.
-- ─────────────────────────────────────────────────────────────────────────────

alter table manufacturer_meta
  add column if not exists category_order jsonb;

comment on column manufacturer_meta.category_order is
  'Ordered array of category names for Partner 360. Drives both the category filter and the order sections scroll. Categories not listed here sort alphabetically after those that are.';

-- Ovation Medical: body-area order, clinical supplies last.
insert into manufacturer_meta (slug, category_order)
values ('ovation-medical', '["Foot & Ankle","Knee","Back & Spine","Shoulder & Elbow","Wrist & Hand","Medical / Clinical Supplies"]'::jsonb)
on conflict (slug) do update set category_order = excluded.category_order;

-- Verify:
--   select slug, category_order from manufacturer_meta where category_order is not null;
