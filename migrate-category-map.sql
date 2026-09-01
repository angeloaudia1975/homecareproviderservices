-- ─────────────────────────────────────────────────────────────────────────────
-- SUBCATEGORY → CATEGORY, HELD ONCE PER MANUFACTURER
--
-- Category was stored per product. Building Ovation's six-category structure wrote
-- 308 fixed category overrides — one copy of the same fact per SKU. That froze a
-- snapshot: changing a product's subcategory in Product Content Enrichment & Review
-- no longer moved it, because its category was a separate stored value that did not
-- follow. This is the disconnect behind "I changed the subcategory and the shop
-- ignored it".
--
-- Held as a map, category is DERIVED at read time. One subcategory edit moves the
-- product, and there is nothing else to keep in step. A category typed directly on a
-- product still wins — the map supplies the answer, it does not overrule a decision.
--
-- Run migrate-category-order.sql first (it creates manufacturer_meta.category_order).
-- ─────────────────────────────────────────────────────────────────────────────

alter table manufacturer_meta
  add column if not exists category_map jsonb;

comment on column manufacturer_meta.category_map is
  'Map of subcategory -> dealer-facing category for this manufacturer. Partner 360 derives a product''s category from its subcategory through this map, so a product is filed by editing its subcategory in one place. An explicit per-product category override still takes precedence.';

-- Ovation Medical: the structure already approved, expressed as a rule instead of 308 rows.
insert into manufacturer_meta (slug, category_map)
values ('ovation-medical', '{
  "Walking Boots":"Foot & Ankle",
  "Ankle Stirrups":"Foot & Ankle",
  "Ankle Braces & Stabilizers":"Foot & Ankle",
  "Night Splints":"Foot & Ankle",
  "Foot & Ankle Accessories":"Foot & Ankle",
  "Post-Op Shoes":"Foot & Ankle",
  "Knee Braces & Supports":"Knee",
  "OA Knee Braces":"Knee",
  "Post-Op Knee Braces":"Knee",
  "Back & Lumbar Braces":"Back & Spine",
  "Thumb Spicas":"Wrist & Hand",
  "Wrist Braces":"Wrist & Hand",
  "Arm Slings":"Shoulder & Elbow",
  "Clavicle Supports":"Shoulder & Elbow",
  "Shoulder Supports":"Shoulder & Elbow",
  "Casting & Splinting":"Medical / Clinical Supplies",
  "Gauze & Dressings":"Medical / Clinical Supplies",
  "Compression & Elastic Wraps":"Medical / Clinical Supplies",
  "Medical Tape":"Medical / Clinical Supplies"
}'::jsonb)
on conflict (slug) do update set category_map = excluded.category_map;

-- Verify:
--   select slug, jsonb_object_keys(category_map) from manufacturer_meta where slug='ovation-medical';
