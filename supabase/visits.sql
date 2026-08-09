-- ============================================================================
-- HCPS Field Sales — Phase 4: structured visit notes on dealer_visits.
-- Adds a details JSON blob (products discussed, pricing, samples, opportunities,
-- follow-ups, next visit, etc.), an env stamp, and a follow-up-sent marker.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
alter table dealer_visits add column if not exists details          jsonb default '{}'::jsonb;
alter table dealer_visits add column if not exists env              text default 'development';
alter table dealer_visits add column if not exists followup_sent_at timestamptz;
