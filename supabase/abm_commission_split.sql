-- ============================================================================
-- Commission split — Angelo Audia = 90% of commission earned.
--
-- The ABM manufacturer commission rate is 5% (entered in the Sales Report Import
-- and stored on each monthly_sales line). This file governs the SEPARATE question
-- of how that earned commission is split between the rep and the company:
--   Angelo receives 90% of the commission; the company keeps the remaining 10%.
--   (5% manufacturer rate  ->  Angelo's effective take-home = 4.5% of sales.)
--
-- commission_splits is ONE JSON row in app_settings keyed by the rep's LOWERCASED
-- name. The `||` merge below adds/updates ONLY the 'angelo audia' entry and leaves
-- every other rep's split (Greg Campbell, Lori Hunt, ...) untouched.
--
-- NOTE: this split is PER REP, not per manufacturer — 90% applies to all sales
-- attributed to Angelo Audia across every line he reps. That matches this territory
-- (he is the rep on all ABM Indiana accounts). If Angelo ever reps other lines at a
-- different share, revisit this in the Commission Report -> "Split settings" panel.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
insert into app_settings (key, value, updated_at)
values (
  'commission_splits',
  jsonb_build_object('angelo audia', jsonb_build_object('name', 'Angelo Audia', 'rep_pct', 90)),
  now()
)
on conflict (key) do update
  set value = coalesce(app_settings.value, '{}'::jsonb)
              || jsonb_build_object('angelo audia', jsonb_build_object('name', 'Angelo Audia', 'rep_pct', 90)),
      updated_at = now();

-- ---- Verify (optional): should show angelo audia at 90 alongside any other reps ----
-- select jsonb_pretty(value) from app_settings where key = 'commission_splits';
