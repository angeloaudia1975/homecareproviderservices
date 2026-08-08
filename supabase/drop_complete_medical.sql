-- ============================================================================
-- Remove "Complete Medical Supplies" (slug complete-medical-supplies) from the
-- automation engine — HCPS no longer represents this line. This:
--   1. adds it to automation_config.exclude_manufacturers so the engine never
--      creates another reorder task/email for it (merges + de-dupes, idempotent),
--   2. dismisses any OPEN tasks that reference it (reversible — status only),
--   3. cancels any QUEUED emails that reference it.
-- Historical sales rows are left untouched. Safe to re-run.
-- Run AFTER pushing the updated _engine.js (which reads the exclusion list).
-- ============================================================================

-- 1) Exclude the line from all future automation (merge into any existing list).
update app_settings
set value = jsonb_set(
      value,
      '{exclude_manufacturers}',
      to_jsonb(array(
        select distinct x from unnest(
          coalesce(array(select jsonb_array_elements_text(value->'exclude_manufacturers')), array[]::text[])
          || array['complete-medical-supplies']
        ) as x
      )),
      true),
    updated_at = now()
where key = 'automation_config';

-- 2) Dismiss existing open tasks about this line (auto reorder tasks + any manual ones).
update dealer_tasks
set status = 'dismissed', done_at = now()
where status = 'open'
  and (reason ilike 'overdue:%complete%medical%'
    or title  ilike '%complete medical%'
    or detail ilike '%complete medical%');

-- 3) Cancel any queued emails about this line (only the reorder template is line-specific).
update email_queue
set status = 'canceled'
where status = 'queued'
  and (reason ilike 'overdue:%complete%medical%'
    or detail ilike '%complete medical%');
