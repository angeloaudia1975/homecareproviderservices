-- ============================================================================
-- Pipeline & Forecasting — a lightweight opportunity/deal layer the reps manage, which
-- (weighted by stage probability) feeds the forward revenue forecast alongside the
-- cadence-based reorder projection. Run once in Supabase. Safe to re-run.
-- ============================================================================
create table if not exists opportunities (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     uuid,
  title         text,
  line          text,                 -- manufacturer line this deal is about (optional)
  stage         text default 'identified',  -- identified | contacted | quoted | won | lost
  value         numeric default 0,    -- estimated annual value
  probability   numeric,              -- 0..1; defaults from stage if null
  expected_close date,
  owner_rep     text,
  source        text default 'manual',-- manual | crosssell
  notes         text,
  status        text default 'open',  -- open | won | lost
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table opportunities enable row level security;   -- service_role only
create index if not exists opportunities_dealer_idx on opportunities(dealer_id);
create index if not exists opportunities_stage_idx  on opportunities(stage);
create index if not exists opportunities_owner_idx  on opportunities(owner_rep);
