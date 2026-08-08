-- ============================================================================
-- HCPS CRM layer (Phase 2) — operational sales data lives here in Supabase (the
-- system of record). Notes, tasks, and follow-up reminders per dealer. The
-- intelligent follow-up engine writes auto-tasks into dealer_tasks (source='auto').
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- Free-text notes on a dealer (rep notes, call summaries, account context).
create table if not exists dealer_notes (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid references dealers(id) on delete cascade,
  author_email text,
  author_name  text,
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists dealer_notes_dealer_idx on dealer_notes(dealer_id, created_at desc);

-- Tasks / follow-up reminders. source='manual' (a rep added it) or 'auto' (the
-- follow-up engine created it from a signal); reason records which signal.
create table if not exists dealer_tasks (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid references dealers(id) on delete cascade,
  title        text not null,
  detail       text,
  due_date     date,
  status       text not null default 'open',   -- open | done | dismissed
  priority     text default 'normal',          -- low | normal | high
  source       text default 'manual',          -- manual | auto
  reason       text,                            -- signal key for auto tasks (e.g. 'overdue:golden')
  assigned_rep text,
  created_by   text,
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);
create index if not exists dealer_tasks_dealer_idx on dealer_tasks(dealer_id);
create index if not exists dealer_tasks_status_idx on dealer_tasks(status, due_date);
-- One open auto-task per (dealer, reason) so the engine can re-run without duplicating.
create unique index if not exists dealer_tasks_auto_uniq on dealer_tasks(dealer_id, reason)
  where source='auto' and status='open';

alter table dealer_notes enable row level security;   -- service_role only
alter table dealer_tasks enable row level security;    -- service_role only
