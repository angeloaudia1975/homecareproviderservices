-- ============================================================================
-- Dealer Hub service center — training / consultation / support scheduling requests.
-- Every request from the Dealer Hub lands here as a durable, trackable record so it can become a
-- Dealer 360 touch point: Training Requested → Appointment Scheduled → Completed → Notes → Follow-up.
-- The admin scheduling console (phase 2) assigns a rep, creates the Outlook (Graph) event + Zoho task,
-- links the dealer_id, and moves status through scheduled → completed. Written by schedule-api.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
create table if not exists service_requests (
  id             uuid primary key default gen_random_uuid(),
  service        text not null,                 -- 'Remote Product Training', 'Showroom Consultation', …
  service_key    text,                          -- slug for grouping/reporting
  mode           text,                          -- 'remote' | 'in_person' | null
  preferred_date date,
  preferred_time text,
  alt_date       date,
  company        text,
  contact_name   text,
  email          text,
  phone          text,
  state          text,
  manufacturer   text,
  notes          text,
  dealer_id      uuid,                          -- matched to a dealer on assignment
  rep_name       text,                          -- assigned HCPS representative
  status         text default 'requested',      -- requested | scheduled | completed | cancelled
  calendar       jsonb,                         -- {mailbox, event_id} once the Outlook event exists
  zoho           jsonb,                         -- {lead_id, task_id} once synced
  completed_notes text,
  followup       text,
  source         text default 'dealer-hub',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists service_requests_status_idx on service_requests(status, created_at desc);
create index if not exists service_requests_dealer_idx on service_requests(dealer_id);
alter table service_requests enable row level security;   -- service_role only
