-- ============================================================================
-- golden_dealer_links.sql — HCPS mirror of Golden ⇄ HCPS dealer link PROPOSALS (Golden ⇄ Partner 360, Stage 1, H-M1)
-- Blueprint docs/FEDERATED_ARCHITECTURE.md v1.3.0 §3.10 · Contract docs/contracts/golden-commerce-v1.md
--
-- Golden owns the link (its dealer_integration_map). This table is HCPS's own record of what HCPS PROPOSED and of
-- the state Golden last reported. It never authorizes anything: golden-proxy always asks Golden live.
-- Written only by netlify/functions/golden-links-api.js (service role).
--
-- RULE 19: RLS on, NO policies, explicit REVOKE from public/anon/authenticated → service role only.
-- Additive; no existing object changes. Re-runnable. No DML.
-- ROLLBACK: drop table if exists golden_dealer_links;   (nothing else depends on it)
-- ============================================================================
create table if not exists golden_dealer_links (
  id               uuid primary key default gen_random_uuid(),
  hcps_dealer_id   uuid not null references dealers(id),
  golden_dealer_id text not null check (golden_dealer_id ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  customer_no      text,
  golden_link_id   uuid,
  status           text not null default 'proposed' check (status in ('proposed','verified','revoked')),
  golden_state     text check (golden_state in ('verified','not_verified','inactive')),
  capabilities     jsonb,
  evidence_method  text check (evidence_method in ('account_number','federation_event','manual')),
  note             text,
  proposed_by      text not null,
  proposed_at      timestamptz not null default now(),
  checked_at       timestamptz,
  unique (hcps_dealer_id, golden_dealer_id)
);
create index if not exists golden_dealer_links_dealer_idx on golden_dealer_links (hcps_dealer_id);

alter table golden_dealer_links enable row level security;
revoke all on golden_dealer_links from public, anon, authenticated;

-- Read-only check (expected: one row, ok / ok / ok)
select (to_regclass('public.golden_dealer_links') is not null)                                        as table_exists,
       (select relrowsecurity from pg_class where relname = 'golden_dealer_links')                     as rls_on,
       not exists (select 1 from information_schema.role_table_grants
                   where table_name = 'golden_dealer_links' and grantee in ('anon','authenticated','PUBLIC')) as no_public_grants;
