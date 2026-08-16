-- ============================================================================
-- Manufacturer Relationship Engine (MRE) — FEDERATED_ARCHITECTURE.md §3.5 / §6.3
-- One canonical status per (dealer × manufacturer): active | prospect | dormant |
-- restricted. Computed nightly by _intent.computeRelationships(), layered on the
-- existing dealer_line_status (sales-derived active/dormant/prospect) + the
-- dealer_manufacturers account grid + config-driven restriction lists.
--
-- 'restricted' = explicit do-not-target; it OVERRIDES every other status and is
-- suppressed from that manufacturer's campaigns everywhere, always.
--
-- Purely additive: a new computed cache table (like dealer_line_status /
-- dealer_engagement) + one additive config key. Nothing existing is modified.
-- Safe & idempotent. Run once in the Supabase SQL editor.
-- ============================================================================

create table if not exists dealer_relationships (
  dealer_id     uuid not null,
  manufacturer  text not null,                      -- slug
  status        text not null default 'none',       -- active | prospect | dormant | restricted
  has_account   boolean default false,              -- account_ref on file for this line
  months_since  int,                                -- months since last order (null if never)
  last_order_period text,                           -- 'YYYY-MM'
  status_since  date,
  reason        text,                                -- why restricted (config | ...)
  computed_at   timestamptz not null default now(),
  primary key (dealer_id, manufacturer)
);
alter table dealer_relationships enable row level security;   -- service_role only (no policies)
create index if not exists dealer_relationships_status_idx on dealer_relationships(status);
create index if not exists dealer_relationships_mfr_idx    on dealer_relationships(manufacturer, status);

-- Additive config: the explicit do-not-target list. Each entry is either
--   { "dealer_id": "<uuid>", "manufacturer": "<slug>" }   (one relationship)
-- and marks that (dealer × manufacturer) 'restricted'. The existing engine lists
-- exclude_dealers (whole dealer, every line) and exclude_manufacturers (whole line)
-- ALSO feed restriction — this key adds per-relationship precision (e.g. an
-- Ovation "Access Denied" on one dealer). `|| value` keeps any already-tuned value.
update app_settings
  set value = jsonb_build_object('restricted_relationships', '[]'::jsonb) || value
  where key = 'automation_config';
