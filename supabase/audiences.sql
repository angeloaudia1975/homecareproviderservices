-- ============================================================================
-- HCPS Target Audience Builder — the master audience layer.
-- Audiences live in HCPS (never in the external email platform), so if you ever
-- change providers, every list, segment, and history stays here.
--   * audiences         — a named list; static (hand-picked) or dynamic (rules)
--   * audience_members  — the hand-picked company/contact rows for static lists
-- Dynamic audiences store rules and are resolved on demand from live dealer data.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
create table if not exists audiences (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  type          text default 'static',        -- static | dynamic
  rules         jsonb default '{}'::jsonb,     -- dynamic: {state, rep, manufacturer, relationship}
  company_count int default 0,                 -- cached at save
  contact_count int default 0,
  notes         text,
  env           text default 'development',
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table audiences enable row level security;   -- service_role only
create index if not exists audiences_updated_idx on audiences(updated_at desc);

create table if not exists audience_members (
  audience_id   uuid references audiences(id) on delete cascade,
  dealer_id     uuid,
  company       text,
  contact_name  text,
  contact_email text,
  primary key (audience_id, contact_email)
);
alter table audience_members enable row level security;   -- service_role only
create index if not exists audience_members_aud_idx on audience_members(audience_id);
