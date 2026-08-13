-- ============================================================================
-- HCPS Dealer Services partners — CardChamp and future non-manufacturer lines.
-- Two tables, both keyed by `service` (e.g. 'cardchamp') so the same reporting
-- works for the next partner without new schema.
--
--   partner_activity  — per-dealer interest signals (button clicks / referrals we
--                       generate on the site + ordering portal). Written by
--                       events-api the moment a signed-in dealer clicks.
--   partner_referrals — the conversion / commission ledger. Rows come from manual
--                       admin entry now, and from a CardChamp report import later;
--                       both land here so nothing entered by hand is ever lost.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create table if not exists partner_activity (
  id          uuid primary key default gen_random_uuid(),
  service     text not null default 'cardchamp',
  dealer_id   uuid references dealers(id) on delete set null,
  event_type  text not null,                 -- e.g. service_cardchamp_click
  source      text,                          -- ordering | website | dealer-hub
  surface     text,                          -- free-text surface label from the client
  env         text,                          -- prod | test (mirrors intent_events)
  meta        jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index if not exists partner_activity_svc_idx    on partner_activity(service, occurred_at desc);
create index if not exists partner_activity_dealer_idx on partner_activity(service, dealer_id);

create table if not exists partner_referrals (
  id           uuid primary key default gen_random_uuid(),
  service      text not null default 'cardchamp',
  dealer_id    uuid references dealers(id) on delete set null,
  dealer_name  text,                          -- denormalized (display + unmatched imports)
  status       text not null default 'referred',  -- referred|applied|approved|active|declined|churned|void
  monthly_volume numeric,                     -- the dealer's card processing volume (optional)
  revenue      numeric,                       -- partner revenue for the period (optional)
  commission   numeric,                       -- commission credited to HCPS
  period       text,                          -- YYYY-MM reporting period (optional)
  applied_at   date,
  activated_at date,
  source       text not null default 'manual',   -- manual | import
  external_ref text,                          -- CardChamp report row id, for import de-dup
  note         text,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists partner_referrals_svc_idx    on partner_referrals(service, status);
create index if not exists partner_referrals_dealer_idx on partner_referrals(service, dealer_id);
-- One row per (service, external_ref) so a re-imported report updates instead of duplicating.
create unique index if not exists partner_referrals_extref_uniq
  on partner_referrals(service, external_ref) where external_ref is not null;

alter table partner_activity  enable row level security;   -- service_role only (no public policies)
alter table partner_referrals enable row level security;   -- service_role only
