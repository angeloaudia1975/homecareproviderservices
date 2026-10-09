-- ============================================================================
-- HCPS Phase 2F-4 — inbound event identity (ROLLBACK)
-- ORDER: FIRST redeploy the 2F-3 code (Netlify: publish the deploy of commit ac29cb8) so nothing calls
-- hcps_zoho_capture_event, THEN run this. Nothing is deleted: every queue row stays.
-- Afterwards the queue is exactly as before 2F-4 — including its known fault: the 2F-3 webhook's queue write
-- (ON CONFLICT direction,entity,entity_id) is refused (42P10) and recorded as a failure row; receipts still log.
-- ============================================================================
begin;

drop function if exists public.hcps_zoho_capture_event(jsonb);

alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_echo_check;
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_class_reason_check;
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_classification_check;
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_in_event_key_check;
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_status_check;

-- 'ignored' (an HCPS echo) isn't a status before 2F-4: those rows become 'skipped', the reason kept in
-- last_error (and class_reason). Their classification is cleared so the migration can be applied again later.
update public.zoho_sync_queue
   set status = 'skipped',
       classification = null,
       last_error = coalesce(last_error || ' | ', '') || 'HCPS echo (2F-4): ' || coalesce(class_reason, ''),
       updated_at = now()
 where status = 'ignored';

-- The old partial index allows ONE open row per (direction, entity, entity_id); 2F-4 can hold several (one per
-- genuine edit). Keep the newest open row per record; the older ones become 'skipped' with the reason.
update public.zoho_sync_queue q
   set status = 'skipped',
       last_error = coalesce(q.last_error || ' | ', '') || 'rollback 2F-4: superseded by a newer open event for the same record',
       updated_at = now()
 where q.status in ('pending','processing')
   and exists (select 1 from public.zoho_sync_queue n
                where n.direction = q.direction and n.entity = q.entity and n.entity_id = q.entity_id
                  and n.status in ('pending','processing') and n.id > q.id);

alter table public.zoho_sync_queue add constraint zoho_sync_queue_status_check
  check (status in ('pending','processing','synced','failed','skipped','conflict'));
create unique index if not exists zoho_queue_open_uniq on public.zoho_sync_queue (direction, entity, entity_id)
  where status in ('pending','processing');
drop index if exists public.zoho_queue_event_key_uniq;

commit;
notify pgrst, 'reload schema';

-- OPTIONAL, separately, only if the 2F-4 audit trail is no longer wanted (the 2F-3 code ignores these columns):
-- alter table public.zoho_sync_queue
--   drop column if exists event_key, drop column if exists module, drop column if exists modified_time,
--   drop column if exists modified_by, drop column if exists classification, drop column if exists class_reason,
--   drop column if exists classified_at, drop column if exists deliveries, drop column if exists last_delivery_at;
