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
  reminders      jsonb default '{}'::jsonb,     -- {"24h":ts,"2h":ts} — set by schedule-reminders
  -- Self-scheduling (dealer picks a live 30-min slot): the real appointment instant + owner calendar.
  meeting_type   text,                          -- 'online' | 'field'
  owner_email    text,                          -- the calendar owner (assigned rep) the slot is booked on
  start_at       timestamptz,                   -- absolute appointment start (UTC) — drives reminders + conflicts
  end_at         timestamptz,
  timezone       text,                          -- IANA tz the slot was shown in (dealer-local for field visits)
  location_type  text,                          -- 'online' | 'onsite'
  source         text default 'dealer-hub',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Add the new columns on existing installs (safe to re-run).
alter table service_requests add column if not exists reminders     jsonb default '{}'::jsonb;
alter table service_requests add column if not exists meeting_type  text;
alter table service_requests add column if not exists owner_email   text;
alter table service_requests add column if not exists start_at      timestamptz;
alter table service_requests add column if not exists end_at        timestamptz;
alter table service_requests add column if not exists timezone      text;
alter table service_requests add column if not exists location_type text;
create index if not exists service_requests_status_idx on service_requests(status, created_at desc);
create index if not exists service_requests_dealer_idx on service_requests(dealer_id);
create index if not exists service_requests_start_idx  on service_requests(owner_email, start_at) where status = 'scheduled';
-- Prevent double-booking: one scheduled appointment per owner calendar per start instant.
create unique index if not exists service_requests_no_dblbook
  on service_requests(owner_email, start_at) where status = 'scheduled' and start_at is not null;
alter table service_requests enable row level security;   -- service_role only
