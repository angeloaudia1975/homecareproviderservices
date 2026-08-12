-- ============================================================================
-- Dealer 360 — parity fields for Zoho CRM Plus field parity.
-- Adds the dealer classification columns that must exist in BOTH systems so a
-- field important to sales/marketing/segmentation is never Zoho-only.
-- Additive, idempotent. DDL only (run separately from any data load).
-- Existing columns reused: dealers.status, dealers.golden_status,
-- dealers.ovation_access, and dealer_manufacturers(account_ref, active).
-- ============================================================================

-- Dealer classification (organization / segmentation)
alter table dealers add column if not exists dealer_organization    text;  -- parent-group name (Adapthealth, ARH, …); mirrors parent_id family
alter table dealers add column if not exists business_type          text;  -- e.g. "HME/DME Retail", "Pharmacy"
alter table dealers add column if not exists business_model         text;  -- Retail | Insurance | Pharmacy | Hospital | Home Mods | Ecommerce | All

-- Flagship display program
alter table dealers add column if not exists golden_flagship_level   text;  -- "Level 2: 5-11 Chairs" (Golden / lift-chair)
alter table dealers add column if not exists mobility_flagship_level text;  -- "Level 3: 9+ Mobility Products"

-- Ovation targeting (3-state, drives campaign suppression)
alter table dealers add column if not exists ovation_status          text;  -- Active | Approved Prospect | Restricted

-- Helpful indexes for segmentation
create index if not exists dealers_org_idx            on dealers (dealer_organization);
create index if not exists dealers_golden_flag_idx    on dealers (golden_flagship_level);
create index if not exists dealers_mobility_flag_idx  on dealers (mobility_flagship_level);
create index if not exists dealers_ovation_status_idx on dealers (ovation_status);
create index if not exists dealers_status_idx         on dealers (status);

-- NOTE: manufacturer account numbers + active flags already live in
-- dealer_manufacturers(account_ref, active) at the organization level — no new
-- column needed; the Zoho "{Mfr} Account" checkbox + "{Mfr} Acct #" map to those.
