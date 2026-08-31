-- HCPS Connect 360 — rep-owned cross-sell opportunities.
--
-- The existing `cross_sell` table is COMPUTED: _engine.js rebuilds it nightly from
-- market-basket co-occurrence and deletes every row older than the run stamp. Anything
-- a rep typed into it would be gone by morning, and it only ever knew about
-- manufacturers — no product, family, type, priority or reason.
--
-- So rep-owned opportunities live here instead. The engine keeps its job and its table;
-- this is the account strategy a person decided on, and nothing automated ever
-- overwrites it. Dealer 360 shows both: the rep's plan first, the engine's suggestions
-- underneath as "suggested — add to plan".
--
-- Safe to run more than once.

create table if not exists public.dealer_cross_sell (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     text not null,
  manufacturer  text,                 -- manufacturers.slug
  mfr_name      text,                 -- display name, denormalised for listing
  -- What is being promoted. A rep may name a specific SKU, a family, a category, or
  -- nothing more specific than the line itself — all four are real sales situations.
  product_code  text,
  product_name  text,
  family        text,
  category      text,
  opp_type      text not null default 'cross_sell',
  priority      text not null default 'medium',
  status        text not null default 'open',
  notes         text,
  -- Where it came from: 'rep' (typed by a person) or 'system' (an engine suggestion a
  -- rep promoted into the plan). Kept so the CRM can show what the rep added themselves.
  source        text not null default 'rep',
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);

comment on table public.dealer_cross_sell is
  'Rep-owned cross-sell / opportunity plan per dealer. Never written or pruned by the nightly engine — that owns the separate computed cross_sell table.';

create index if not exists dealer_cross_sell_dealer on public.dealer_cross_sell (dealer_id);
create index if not exists dealer_cross_sell_open   on public.dealer_cross_sell (dealer_id, status);
create index if not exists dealer_cross_sell_mfr    on public.dealer_cross_sell (manufacturer);

alter table public.dealer_cross_sell enable row level security;
-- No policies: reached only through netlify/functions with the service role, which
-- applies the same rep-book scope as the rest of Dealer 360.
