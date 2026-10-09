-- ============================================================================
-- HCPS Phase 2F-4 — inbound Zoho event identity + capture (MIGRATION)
-- Project: hcps-ordering (ycqmztthwldytkzyvmiv). Run ONCE in the Supabase SQL editor BEFORE the 2F-4 code is
-- deployed (the new webhook calls hcps_zoho_capture_event; without it every event answers 503 and is logged
-- as a failure). Re-running is safe. Rollback: phase2f4_inbound_identity_rollback.sql.
--
-- Audited before writing (2026-10-08): zoho_sync_queue has 0 rows, no triggers, RLS on (service_role only).
-- Indexes: pkey, zoho_queue_status_idx, zoho_queue_entity_idx, zoho_queue_dealer_idx and the PARTIAL unique
-- index zoho_queue_open_uniq (direction, entity, entity_id) WHERE status in ('pending','processing').
-- Checks: direction in (out,in); op in (upsert,delete); status in (pending,processing,synced,failed,skipped,conflict).
--
-- What changes:
--  1. New columns: event_key, module, modified_time, modified_by, classification, class_reason, classified_at,
--     deliveries, last_delivery_at. Existing columns are untouched.
--  2. ONE queue row per inbound event: full unique index on event_key + a check that every inbound row has one.
--  3. DESTRUCTIVE: zoho_queue_open_uniq is dropped. It allows only one OPEN row per record, so a second genuine
--     Zoho edit of the same record (while the first is still pending) would be refused — and it can't be the
--     ON CONFLICT target (it is partial; that is the live 42P10 failure). The table is empty, so no data is lost.
--  4. Status check gains 'ignored' (an HCPS echo); classification is null | external | echo | unresolved;
--     'ignored' only ever goes with classification 'echo', and a classification always carries its reason.
--  5. hcps_zoho_capture_event(p jsonb): inserts the event, or — when the same event_key arrives again (a Zoho
--     retry, even two at once) — only counts the repeat. Returns {id, inserted, status, deliveries}.
--     Callable by service_role only.
-- ============================================================================
begin;

alter table public.zoho_sync_queue
  add column if not exists event_key        text,
  add column if not exists module           text,
  add column if not exists modified_time    text,
  add column if not exists modified_by      text,
  add column if not exists classification   text,
  add column if not exists class_reason     text,
  add column if not exists classified_at    timestamptz,
  add column if not exists deliveries       integer not null default 1,
  add column if not exists last_delivery_at timestamptz;

create unique index if not exists zoho_queue_event_key_uniq on public.zoho_sync_queue (event_key);
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_in_event_key_check;
alter table public.zoho_sync_queue add constraint zoho_sync_queue_in_event_key_check
  check (direction <> 'in' or event_key is not null);

drop index if exists public.zoho_queue_open_uniq;

alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_status_check;
alter table public.zoho_sync_queue add constraint zoho_sync_queue_status_check
  check (status in ('pending','processing','synced','failed','skipped','conflict','ignored'));
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_classification_check;
alter table public.zoho_sync_queue add constraint zoho_sync_queue_classification_check
  check (classification is null or classification in ('external','echo','unresolved'));
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_echo_check;
alter table public.zoho_sync_queue add constraint zoho_sync_queue_echo_check
  check (coalesce(status = 'ignored', false) = coalesce(classification = 'echo', false));
alter table public.zoho_sync_queue drop constraint if exists zoho_sync_queue_class_reason_check;
alter table public.zoho_sync_queue add constraint zoho_sync_queue_class_reason_check
  check (classification is null or (class_reason is not null and classified_at is not null));

create or replace function public.hcps_zoho_capture_event(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare r record;
begin
  if coalesce(p->>'event_key', '') = '' then
    raise exception 'hcps_zoho_capture_event: event_key is required' using errcode = '22023';
  end if;
  insert into public.zoho_sync_queue
    (direction, entity, entity_id, dealer_id, op, payload, status, last_error, zoho_id,
     event_key, module, modified_time, modified_by, deliveries, last_delivery_at, updated_at)
  values
    ('in', p->>'entity', p->>'entity_id', p->>'dealer_id', 'upsert', p->'payload', coalesce(p->>'status', 'pending'),
     p->>'last_error', p->>'zoho_id', p->>'event_key', p->>'module', p->>'modified_time', p->>'modified_by', 1, now(), now())
  on conflict (event_key) do update
    set deliveries = public.zoho_sync_queue.deliveries + 1, last_delivery_at = now()
  returning id, (xmax = 0) as inserted, status, deliveries into r;
  return jsonb_build_object('id', r.id, 'inserted', r.inserted, 'status', r.status, 'deliveries', r.deliveries);
end
$$;
revoke all on function public.hcps_zoho_capture_event(jsonb) from public, anon, authenticated;
grant execute on function public.hcps_zoho_capture_event(jsonb) to service_role;

commit;
notify pgrst, 'reload schema';
