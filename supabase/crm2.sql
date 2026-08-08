-- ============================================================================
-- HCPS CRM plumbing (Phase 2b) — a per-dealer activity log (emails/campaigns and
-- other events) plus Zoho-mirror tracking so notes/tasks push up one-way, idempotently.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- Activity timeline per dealer. Every email we send (welcome, and later campaigns)
-- lands here so the Dealer 360 shows the outreach history; also room for calls/system events.
create table if not exists dealer_activity (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     uuid references dealers(id) on delete set null,
  kind          text not null default 'email',   -- email | campaign | call | system
  subject       text,
  detail        text,
  contact_email text,
  actor         text,
  created_at    timestamptz not null default now()
);
create index if not exists dealer_activity_dealer_idx on dealer_activity(dealer_id, created_at desc);
alter table dealer_activity enable row level security;   -- service_role only

-- Mirror tracking: stamp when a note/task was pushed to Zoho so re-running only sends new ones.
alter table dealer_notes add column if not exists zoho_synced_at timestamptz;
alter table dealer_tasks add column if not exists zoho_synced_at timestamptz;
