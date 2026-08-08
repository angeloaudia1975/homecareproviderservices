-- ============================================================================
-- Rep Performance & Goals — annual sales targets per rep, set by the president in the
-- Rep Performance page and used to compute attainment (actual ÷ target). Run once in
-- Supabase. Safe to re-run.
-- ============================================================================
create table if not exists rep_targets (
  rep_name   text not null,
  year       int  not null,
  target     numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (rep_name, year)
);
alter table rep_targets enable row level security;   -- service_role only
