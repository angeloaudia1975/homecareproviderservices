-- HCPS email→revenue attribution.
-- One row per (order line × the email touch that plausibly drove it). Written by
-- orders-api when an online order is placed and a recent email touch exists:
--   * a campaign click (intent_events email_click, source=campaign) within 7 days, or
--   * an automated marketing email (email_sends) to the dealer within 14 days.
-- Powers the Command Center's "revenue attributed to email" (overall and by manufacturer).
create table if not exists email_attribution (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid,
  order_id    uuid,
  manufacturer text,
  amount      numeric default 0,
  kind        text,        -- 'campaign' | 'automation'
  ref         text,        -- campaign_id (campaign) or template name (automation)
  touch_at    timestamptz, -- when the click/send happened
  env         text default 'live',
  created_at  timestamptz default now()
);
create index if not exists email_attribution_env_created_idx on email_attribution (env, created_at desc);
create index if not exists email_attribution_mfr_idx on email_attribution (manufacturer);
create unique index if not exists email_attribution_order_mfr_uq on email_attribution (order_id, manufacturer);

alter table email_attribution enable row level security;
-- service-role only (functions use the service key); no anon/authenticated policies.
