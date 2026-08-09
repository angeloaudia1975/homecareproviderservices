-- ============================================================================
-- HCPS Campaign Studio (email spec Phase 3) — stored campaigns.
-- The portal generates a campaign (audience + content + sequence) from a brief,
-- you review/edit it, then it's pushed to Zoho Campaigns as a DRAFT for sending.
-- Behavioral env stamp is included so pre-launch test campaigns stay separate.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
create table if not exists marketing_campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  goal          text,                       -- launch | promo | manufacturer_intro | reactivation | acquisition | cross_sell
  manufacturer  text,                       -- slug (optional; the line the campaign is about)
  segment       text,                       -- segment key the audience was resolved from
  brief         jsonb default '{}'::jsonb,  -- the input brief (goal, offer, tone, products…)
  generated     jsonb default '{}'::jsonb,  -- { subjects[], preheader, body_html, ctas[], sequence[], schedule }
  audience      jsonb default '{}'::jsonb,  -- { count, sample[], dealer_ids[] } snapshot at generation
  status        text default 'draft',       -- draft | review | pushed | scheduled | sent | archived
  zoho_list_key     text,
  zoho_campaign_key text,
  results       jsonb default '{}'::jsonb,  -- opens/clicks/etc. pulled back from Zoho
  env           text default 'development',
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table marketing_campaigns enable row level security;   -- service_role only
create index if not exists marketing_campaigns_status_idx on marketing_campaigns(status, updated_at desc);
create index if not exists marketing_campaigns_env_idx    on marketing_campaigns(env);
