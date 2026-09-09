-- ============================================================================
--  HCPS Product Catalog rebuild — PHASE 3b: PREPARE FOR APPLY
--  Run once, in the Supabase SQL editor. Idempotent.
--
--  TWO CORRECTIONS TO MY OWN DESIGN. Both surfaced on trying to use the
--  conflicts table for what it exists for, which is the honest way to find
--  them but should have been thought through first.
--
--  1. THE RESOLUTION WAS RECORDED AS PROSE, NOT AS A VALUE.
--     Phase 3 wrote "take the database value" into a text column. A person can
--     read that; the apply step cannot act on it. A decision that a machine
--     cannot execute is a decision that will get re-made by hand, differently,
--     later. Adding resolved_value, and filling it in for all 13.
--
--  2. THE TABLE WAS IN A SCHEMA THE APPLY STEP CANNOT REACH.
--     I put reconcile_conflicts in `snapshots` to keep it away from the anon
--     key. But PostgREST only serves schemas Supabase is configured to expose,
--     and `snapshots` is not one — so the Netlify function that has to read
--     these resolutions cannot see them either. Moving it to `public`, where
--     RLS with no policies gives exactly the same protection: the service role
--     reads it, nobody else does. The 13 rows move with it.
--
--  Still writes nothing to any product, price or catalog row.
-- ============================================================================

begin;

-- 1. Move it somewhere the service role can actually read. Data comes along.
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'snapshots' and table_name = 'reconcile_conflicts') then
    alter table snapshots.reconcile_conflicts set schema public;
  end if;
end $$;

alter table public.reconcile_conflicts enable row level security;

-- 2. The decision, in a form the apply step can execute.
alter table public.reconcile_conflicts
  add column if not exists resolved_value jsonb;

comment on column public.reconcile_conflicts.resolved_value is
  'The value the apply step must use for this field. Prose in `resolution` explains why; this is what actually gets written.';

-- 3. Fill it in for the 13 already decided. Each is the value both database
--    layers agree on, verified against the manufacturer''s 2026 price list.
update public.reconcile_conflicts set resolved_value = v.val
from (values
  ('ovation-medical','51500','tiers','[{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]'::jsonb),
  ('ovation-medical','51508','tiers','[{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]'::jsonb),
  ('ovation-medical','51600','tiers','[{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]'::jsonb),
  ('ovation-medical','51608','tiers','[{"min_qty": 2, "price": 99.5}, {"min_qty": 6, "price": 89.95}, {"min_qty": 11, "price": 74.5}, {"min_qty": 21, "price": 69.95}]'::jsonb),
  ('ovation-medical','61001','tiers','[{"min_qty": 2, "price": 69.95}, {"min_qty": 6, "price": 59.95}, {"min_qty": 11, "price": 49.95}, {"min_qty": 21, "price": 44.95}]'::jsonb),
  ('ovation-medical','61002','tiers','[{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 79.95}, {"min_qty": 11, "price": 69.95}, {"min_qty": 21, "price": 59.95}]'::jsonb),
  ('ovation-medical','61003','tiers','[{"min_qty": 2, "price": 79.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 11, "price": 59.95}, {"min_qty": 21, "price": 54.95}]'::jsonb),
  ('ovation-medical','61004','tiers','[{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 79.95}, {"min_qty": 11, "price": 69.95}, {"min_qty": 21, "price": 59.95}]'::jsonb),
  ('ovation-medical','61008','tiers','[{"min_qty": 2, "price": 109.95}, {"min_qty": 6, "price": 99.5}, {"min_qty": 11, "price": 89.95}, {"min_qty": 21, "price": 79.95}]'::jsonb),
  ('ovation-medical','61008-2','tiers','[{"min_qty": 2, "price": 89.95}, {"min_qty": 6, "price": 69.95}, {"min_qty": 11, "price": 59.95}, {"min_qty": 21, "price": 49.95}]'::jsonb),
  ('ovation-medical','61008','base_price','119.95'::jsonb),
  ('climbing-steps','TROL','msrp','3995'::jsonb),
  ('climbing-steps','VLST','msrp','2995'::jsonb)
") as v(mfr, code, field, val)
where reconcile_conflicts.run_label   = 'phase3-2026-09-09'
  and reconcile_conflicts.manufacturer = v.mfr
  and reconcile_conflicts.code         = v.code
  and reconcile_conflicts.field        = v.field;

commit;

-- ============================================================================
--  VERIFY — expect 13 rows, every one with both a reason and a value.
-- ============================================================================
select manufacturer,
       count(*)                                            as conflicts,
       count(*) filter (where resolution is not null)      as has_reason,
       count(*) filter (where resolved_value is not null)  as has_value
from public.reconcile_conflicts
where run_label = 'phase3-2026-09-09'
group by manufacturer
order by manufacturer;
