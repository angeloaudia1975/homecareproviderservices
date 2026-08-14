-- ============================================================================
-- Zoho two-way sync — stores the Zoho Deal id on each opportunity so pushes update the
-- same deal (not duplicate) and pulls can match a Zoho stage change back to our pipeline.
-- Last-sync timestamps live in app_settings key 'zoho_sync'. Run once. Safe to re-run.
-- ============================================================================
alter table opportunities add column if not exists zoho_id text;
create index if not exists opportunities_zoho_idx on opportunities(zoho_id);

-- ============================================================================
-- Automatic two-way sync backbone (added Aug 2026).
--   zoho_sync_queue — durable work items (outbound changes to push, inbound webhook events
--                     to apply). A drainer processes pending rows and retries failures.
--   zoho_sync_log   — append-only history powering the health dashboard's Synced / Failed /
--                     Conflict counts and the audit trail.
-- Field ownership is enforced in the functions, not here.
-- ============================================================================
create table if not exists zoho_sync_queue (
  id           bigint generated always as identity primary key,
  direction    text not null check (direction in ('out','in')),   -- out = portal→Zoho, in = Zoho→portal
  entity       text not null,                                       -- dealer | contact | manufacturer | note | task | opportunity | activity
  entity_id    text,
  dealer_id    text,
  op           text default 'upsert' check (op in ('upsert','delete')),
  payload      jsonb,
  status       text default 'pending' check (status in ('pending','processing','synced','failed','skipped','conflict')),
  attempts     int default 0,
  last_error   text,
  zoho_id      text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  processed_at timestamptz
);
create index if not exists zoho_queue_status_idx on zoho_sync_queue (status, direction);
create index if not exists zoho_queue_entity_idx on zoho_sync_queue (entity, entity_id);
create index if not exists zoho_queue_dealer_idx on zoho_sync_queue (dealer_id);
create unique index if not exists zoho_queue_open_uniq on zoho_sync_queue (direction, entity, entity_id)
  where status in ('pending','processing');

create table if not exists zoho_sync_log (
  id         bigint generated always as identity primary key,
  direction  text,
  entity     text,
  entity_id  text,
  dealer_id  text,
  action     text,
  result     text,                        -- ok | fail | conflict
  detail     text,
  zoho_id    text,
  created_at timestamptz default now()
);
create index if not exists zoho_log_created_idx on zoho_sync_log (created_at);
create index if not exists zoho_log_result_idx  on zoho_sync_log (result);
create index if not exists zoho_log_dealer_idx  on zoho_sync_log (dealer_id);

alter table zoho_sync_queue enable row level security;
alter table zoho_sync_log   enable row level security;
do $$
declare t text;
begin
  foreach t in array array['zoho_sync_queue','zoho_sync_log']
  loop
    execute format('drop policy if exists %I_service on %I;', t, t);
    execute format('create policy %I_service on %I for all to service_role using (true) with check (true);', t, t);
  end loop;
end $$;
