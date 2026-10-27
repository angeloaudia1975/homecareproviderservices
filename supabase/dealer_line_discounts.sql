-- ============================================================================
-- Dealer line discounts (owner policy, Angelo 2026-10-27; first line: Access4U)
-- Run ONCE in the Supabase SQL editor (Angelo). Additive: one new table, nothing else changes.
--
-- A row gives ONE dealer a purchase discount off a line's STANDARD dealer list (the catalog's
-- dealer_price): 10, 15, 20 or another approved % (two decimals at most). No row = the line's
-- default purchase price (base_price, which already is the default 15% on Access4U).
-- ONLY the dealer's purchase price moves. MSRP and MAP are never derived from this table.
-- A per-SKU contract price (dealer_contract_prices) is an absolute override, checked first,
-- and is never discounted again. The master account's row applies to its branches; a
-- branch's own row overrides it (resolved in _line_discounts.js, like contract prices).
--
-- RULE 19 (database objects are not private by default): RLS ON, NO policies, and every
-- privilege revoked from public / anon / authenticated. Only the service role (dealer-auth,
-- the order server and the Dealer Manager API) reads or writes it.
-- ============================================================================
create table if not exists dealer_line_discounts (
  dealer_id     uuid not null references dealers(id) on delete cascade,
  manufacturer  text not null,                        -- catalog manufacturer slug, e.g. 'access4u'
  discount_pct  numeric(5,2) not null check (discount_pct > 0 and discount_pct < 100),
  note          text,
  active        boolean not null default true,
  set_by        text,
  updated_at    timestamptz not null default now(),
  primary key (dealer_id, manufacturer)
);
create index if not exists dld_dealer_idx on dealer_line_discounts(dealer_id);

alter table dealer_line_discounts enable row level security;
revoke all on table dealer_line_discounts from public, anon, authenticated;
grant select, insert, update, delete on table dealer_line_discounts to service_role;

-- Install check (all true):
select
  to_regclass('public.dealer_line_discounts') is not null                                       as table_exists,
  (select relrowsecurity from pg_class where oid = 'public.dealer_line_discounts'::regclass)   as rls_on,
  (select count(*) from pg_policies where tablename = 'dealer_line_discounts') = 0              as no_policies,
  not has_table_privilege('anon', 'public.dealer_line_discounts', 'select')                     as anon_cannot_read,
  not has_table_privilege('authenticated', 'public.dealer_line_discounts', 'select')            as authenticated_cannot_read,
  (select count(*) from dealer_line_discounts) = 0                                              as empty;
