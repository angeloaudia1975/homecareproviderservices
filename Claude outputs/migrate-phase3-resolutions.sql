-- ============================================================================
--  HCPS Product Catalog rebuild — PHASE 3: CONFLICT RESOLUTIONS
--  Run once, in the Supabase SQL editor. Idempotent.
--
--  The reconciler found 13 disagreements between the three layers and refused
--  to decide any of them. This records the decision for each, with the evidence
--  and a name, so the migration is auditable rather than assumed.
--
--  THE FINDING: all 13 resolve the same way, and none of them changes what a
--  dealer sees. In every case the two database layers agree with the
--  manufacturer's current price list, and the disagreeing layer is stale:
--
--    · Ovation (11) — the DEPLOYED CATALOG FILE holds pre-2026 prices, mostly
--      .99 endings where the 2026 list says .95. Verified line by line against
--      "2026 ovation medical pricelist 992026.xlsx": 11 of 11 database values
--      match the list exactly.
--
--    · Climbing Steps (2) — the ADDED ROW holds a pre-2026 MSRP for the two
--      Voltstair hand trucks. The file and the override both match the 2026
--      list.
--
--  The shop already serves the correct value in all 13 cases, because the
--  layer that wins at render time happens to be the current one. Resolving
--  these changes nothing dealer-facing; it removes the ambiguity underneath.
--
--  This writes ONLY to snapshots.reconcile_conflicts. No product, price or
--  catalog row is touched.
-- ============================================================================

begin;

insert into snapshots.reconcile_conflicts
  (run_label, manufacturer, code, field, layer_values, severity, resolution, resolved_at, resolved_by)
values
  ('phase3-2026-09-09', 'ovation-medical', '51500', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.99}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.99}], "added": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}], "override": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '51508', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.99}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.99}], "added": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}], "override": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '51600', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.99}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.99}], "added": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}], "override": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '51608', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.99}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.99}], "added": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}], "override": [{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61001', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 69.99}, {"min_qty": 6, "price": 59.99}, {"min_qty": 11, "price": 49.99}, {"min_qty": 21, "price": 44.95}], "added": [{"min_qty": 2, "price": 69.95}, {"min_qty": 6, "price": 59.95}, {"min_qty": 11, "price": 49.95}, {"min_qty": 21, "price": 44.95}], "override": [{"min_qty": 2, "price": 69.95}, {"min_qty": 6, "price": 59.95}, {"min_qty": 11, "price": 49.95}, {"min_qty": 21, "price": 44.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61002', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 89.99}, {"min_qty": 6, "price": 79.99}, {"min_qty": 11, "price": 69.99}, {"min_qty": 21, "price": 59.99}], "added": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 79.95}, {"min_qty": 11, "price": 69.95}, {"min_qty": 21, "price": 59.95}], "override": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 79.95}, {"min_qty": 11, "price": 69.95}, {"min_qty": 21, "price": 59.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61003', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 79.99}, {"min_qty": 6, "price": 69.99}, {"min_qty": 11, "price": 59.99}, {"min_qty": 21, "price": 54.95}], "added": [{"min_qty": 2, "price": 79.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 11, "price": 59.95}, {"min_qty": 21, "price": 54.95}], "override": [{"min_qty": 2, "price": 79.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 11, "price": 59.95}, {"min_qty": 21, "price": 54.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61004', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 89.99}, {"min_qty": 6, "price": 79.99}, {"min_qty": 11, "price": 69.99}, {"min_qty": 21, "price": 59.99}], "added": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 79.95}, {"min_qty": 11, "price": 69.95}, {"min_qty": 21, "price": 59.95}], "override": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 79.95}, {"min_qty": 11, "price": 69.95}, {"min_qty": 21, "price": 59.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61008', 'tiers',
   '{"catalog": [{"min_qty": 1, "price": 109.95}, {"min_qty": 2, "price": 99.95}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 79.95}, {"min_qty": 21, "price": 69.95}], "added": [{"min_qty": 2, "price": 109.95}, {"min_qty": 6, "price": 99.5}, {"min_qty": 11, "price": 89.95}, {"min_qty": 21, "price": 79.95}], "override": [{"min_qty": 2, "price": 109.95}, {"min_qty": 6, "price": 99.5}, {"min_qty": 11, "price": 89.95}, {"min_qty": 21, "price": 79.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61008-2', 'tiers',
   '{"catalog": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 21, "price": 49.95}], "added": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 11, "price": 59.95}, {"min_qty": 21, "price": 49.95}], "override": [{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 11, "price": 59.95}, {"min_qty": 21, "price": 49.95}]}'::jsonb,
   'blocking',
   'Deployed catalog file is stale (pre-2026). Both database layers match the 2026 price list exactly. Resolution: take the database value. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'ovation-medical', '61008', 'base_price',
   '{"catalog": 109.95, "added": 119.95, "override": 119.95}'::jsonb,
   'blocking',
   'Deployed catalog file is stale at $109.95. The 2026 price list says $119.95, which both database layers already hold. Resolution: $119.95. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'climbing-steps', 'TROL', 'msrp',
   '{"catalog": 3995.0, "added": 2199.99, "override": 3995.0}'::jsonb,
   'blocking',
   'Added row holds a pre-2026 MSRP of $2,199.99. The catalog file and the override both match the 2026 price list at $3,995.00. Resolution: $3,995.00. No change to what dealers see.',
   now(), 'president'),
  ('phase3-2026-09-09', 'climbing-steps', 'VLST', 'msrp',
   '{"catalog": 2995.0, "added": 2499.99, "override": 2995.0}'::jsonb,
   'blocking',
   'Added row holds a pre-2026 MSRP of $2,499.99. The catalog file and the override both match the 2026 price list at $2,995.00. Resolution: $2,995.00. No change to what dealers see.',
   now(), 'president')
on conflict (run_label, manufacturer, code, field) do nothing;

commit;

-- ============================================================================
--  VERIFY — expect 13 rows, all resolved, 0 unresolved.
-- ============================================================================
select manufacturer,
       count(*)                                        as conflicts,
       count(*) filter (where resolution is not null)  as resolved,
       count(*) filter (where resolution is null)      as unresolved
from snapshots.reconcile_conflicts
where run_label = 'phase3-2026-09-09'
group by manufacturer
order by manufacturer;
