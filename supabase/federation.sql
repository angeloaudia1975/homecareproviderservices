-- ============================================================================
-- HCPS ⇄ Golden Federation — inbound event layer (receiver side)
-- Implements FEDERATED_ARCHITECTURE.md v1.1.0 §5 (API/Event standards), §8 (sync).
-- HCPS consumes signed, standardized events from the HCPS-owned Golden instance
-- (Tenant 0) and lands them in the existing intelligence tables (intent_events,
-- dealer_activity). These four tables are the plumbing that makes that safe:
--   * federation_events    — idempotency inbox + audit of every received event
--   * partner_dealer_map    — resolved cross-system identity cache (§3.10)
--   * federation_unmatched  — events we couldn't map to a dealer (admin assigns)
--   * federation_orders     — order/purchase SIGNALS (never touches monthly_sales)
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- 1. Idempotency inbox + audit. Every accepted event is recorded here BEFORE it
-- fans out to intent_events/dealer_activity; the unique event_id makes
-- at-least-once delivery safe (a re-delivered event is ignored). Raw envelope is
-- kept for audit/replay.
create table if not exists federation_events (
  event_id     text primary key,                 -- envelope event_id (idempotency key)
  event        text not null,                     -- e.g. 'order.created'
  source_system text not null default 'golden',
  tenant_id    text not null default 'hcps',
  dealer_id    uuid references dealers(id) on delete set null,   -- resolved HCPS dealer (null if unmatched)
  external_dealer_id text,                         -- the source's own dealer id/slug
  customer_no  text,                               -- account number carried for matching
  manufacturer text,                               -- slug (e.g. golden-technologies)
  occurred_at  timestamptz,                        -- event time (authoritative, per §8.7)
  received_at  timestamptz not null default now(),
  status       text not null default 'processed',  -- processed | unmatched | error
  raw          jsonb not null default '{}'::jsonb
);
create index if not exists federation_events_dealer_idx on federation_events(dealer_id, occurred_at desc);
create index if not exists federation_events_status_idx on federation_events(status, received_at desc);
alter table federation_events enable row level security;   -- service_role only

-- 2. Cross-system identity cache (§3.10). Once we resolve a source dealer to an
-- HCPS dealer_id (by hcps_dealer_id, account number, or name/zip alias), we cache
-- it so future events are pre-linked and the receiver stays fast.
create table if not exists partner_dealer_map (
  id            uuid primary key default gen_random_uuid(),
  source_system text not null default 'golden',
  tenant_id     text not null default 'hcps',
  external_dealer_id text,                         -- Golden dealer slug/id
  customer_no   text,                              -- Golden account number
  dealer_id     uuid not null references dealers(id) on delete cascade,
  confidence    text not null default 'exact',     -- exact | account | alias | manual
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- One mapping per (source, tenant, external id) and per (source, tenant, account #).
create unique index if not exists partner_dealer_map_ext_uq
  on partner_dealer_map(source_system, tenant_id, external_dealer_id)
  where external_dealer_id is not null;
create unique index if not exists partner_dealer_map_acct_uq
  on partner_dealer_map(source_system, tenant_id, customer_no)
  where customer_no is not null;
alter table partner_dealer_map enable row level security;   -- service_role only

-- 3. Events we received but could not map to an HCPS dealer. Kept whole so an
-- admin can assign them later (same pattern as the Email Sync unmatched queue),
-- after which partner_dealer_map back-fills and future events resolve.
create table if not exists federation_unmatched (
  id            uuid primary key default gen_random_uuid(),
  source_system text not null default 'golden',
  tenant_id     text not null default 'hcps',
  external_dealer_id text,
  customer_no   text,
  dealer_name   text,                              -- best-effort name from the event, for the picker
  event         text,
  occurred_at   timestamptz,
  raw           jsonb not null default '{}'::jsonb,
  resolved_dealer_id uuid references dealers(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists federation_unmatched_open_idx
  on federation_unmatched(created_at desc) where resolved_dealer_id is null;
alter table federation_unmatched enable row level security;   -- service_role only

-- 4. Order / purchase SIGNAL mirror. These power the Dealer Handout "recent
-- activity", engagement, and cross-sell — but they are NOT authoritative sales.
-- monthly_sales stays the single source of truth for revenue/commissions (§7);
-- these rows are behavioral order signals from the portal, deduped by event_id.
create table if not exists federation_orders (
  event_id     text primary key,                  -- ties to federation_events; dedupe
  dealer_id    uuid references dealers(id) on delete set null,
  manufacturer text,                               -- slug
  external_order_id text,                          -- Golden order id / PO
  order_total  numeric,
  line_count   int,
  lines        jsonb not null default '[]'::jsonb, -- [{product_id,name,qty,value}]
  status       text,                               -- created | completed
  occurred_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists federation_orders_dealer_idx on federation_orders(dealer_id, occurred_at desc);
alter table federation_orders enable row level security;   -- service_role only

-- Note: intent_events and dealer_activity already exist (intent.sql / crm2.sql).
-- The receiver writes Golden signals into those with source='golden', so the
-- engagement engine, Dealer 360 timeline, Who-to-Call, Command Center 360, and
-- the handout pick them up with no further schema change.
