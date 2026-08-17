-- HCPS — Rep commission splits.
--
-- One config row in app_settings holds every rep's commission split. The value is a JSON
-- object keyed by the rep's LOWERCASED name, each entry carrying the rep's display name and
-- the rep's percentage share of the commission their territory generates. The company /
-- President share is simply the remainder (100 - rep_pct).
--
--   { "greg campbell": { "name": "Greg Campbell", "rep_pct": 80 },
--     "lori hunt":     { "name": "Lori Hunt",     "rep_pct": 70 } }
--
-- Both the rep-facing "My Commissions" page and the President "Commission Report" read this
-- one row (via analytics + reps-api), so there is a single source of truth. It is editable in
-- the Commission Report page's "Split settings" panel, or re-run this file to reset it.
--
-- Safe to run repeatedly: it upserts the single row by key.

insert into app_settings (key, value, updated_at)
values (
  'commission_splits',
  jsonb_build_object(
    'greg campbell', jsonb_build_object('name', 'Greg Campbell', 'rep_pct', 80),
    'lori hunt',     jsonb_build_object('name', 'Lori Hunt',     'rep_pct', 70)
  ),
  now()
)
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
