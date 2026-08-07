-- ============================================================================
-- HCPS sales-rep tools — visited log + editable app settings.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- A row each time a rep marks a dealer as visited (feeds "last visit" + "due for
-- a visit" on the map, and the territory scorecard).
create table if not exists dealer_visits (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid references dealers(id) on delete cascade,
  rep_name    text,
  owner_email text,
  visited_at  timestamptz not null default now(),
  notes       text
);
create index if not exists dealer_visits_dealer_idx on dealer_visits(dealer_id);
create index if not exists dealer_visits_when_idx on dealer_visits(visited_at);
alter table dealer_visits enable row level security;   -- service_role only

-- Simple key/value settings the admin can edit without a code push
-- (e.g. the dealer handout's "what's new" bullets and ordering URL).
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;    -- service_role only

-- Seed the handout defaults (only if not already present).
insert into app_settings (key, value)
values ('handout', jsonb_build_object(
  'ordering_url','https://hcpsonlineordering.netlify.app',
  'updates', jsonb_build_array(
    'New online ordering platform — browse your lines, see your pricing, and place orders 24/7.',
    'New manufacturer lines added to our catalog — ask your rep what''s now available in your territory.',
    'Freight programs & volume pricing on select lines — we''ll help you reach free-freight thresholds.'
  )))
on conflict (key) do nothing;
