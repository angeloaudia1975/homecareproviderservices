-- ============================================================================
-- C3-07 STAGE 4 (core) — saved dealer retail prices + abuse limits on emailed brochures / quotes (owner 2026-11-05)
-- Additive only. Nothing here reads or changes a wholesale price, MAP, tier, freight rule or order.
--
--  1. dealer_retail_prices — the dealer's OWN selling price for a product: a company default (location_id null) and, if
--     the dealer wants, a different price per location (D2). Used on the dealer's quotes and brochures (one of three
--     customer pricing choices: verified MSRP · saved dealer retail · one-time quote price). Shown publicly only under the
--     D3 rules (Stage 7). Written only by the server (dealer-retail-api), for the caller's own locations.
--  2. dealer_retail_price_history — every change (old → new, who, when), append-only.
--  3. dealer_document_sends — one row per brochure / quote email a dealer sends, so the server can refuse more than the
--     limits (per dealer per hour / day, per recipient per day). Stores the recipient's DOMAIN and a SHA-256 of the
--     address, never the address itself.
-- RULE 19: RLS on, no policies, no rights for anon / authenticated / public; service_role only.
-- Rollback: drop table if exists public.dealer_retail_price_history, public.dealer_retail_prices, public.dealer_document_sends;
-- ============================================================================
create table if not exists public.dealer_retail_prices (
  id            bigint generated always as identity primary key,
  dealer_id     uuid          not null references public.dealers(id),
  location_id   uuid          references public.dealers(id),
  manufacturer  text          not null check (char_length(manufacturer) between 2 and 60),
  code          text          not null check (char_length(code) between 1 and 60),
  price         numeric(12,2) not null check (price > 0 and price <= 1000000),
  updated_by    text          not null,
  updated_at    timestamptz   not null default now()
);
create unique index if not exists dealer_retail_prices_uk
  on public.dealer_retail_prices (dealer_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), manufacturer, code);
create index if not exists dealer_retail_prices_dealer_idx on public.dealer_retail_prices (dealer_id, manufacturer);

create table if not exists public.dealer_retail_price_history (
  id            bigint generated always as identity primary key,
  dealer_id     uuid          not null,
  location_id   uuid,
  manufacturer  text          not null,
  code          text          not null,
  old_price     numeric(12,2),
  new_price     numeric(12,2),
  changed_by    text          not null,
  changed_at    timestamptz   not null default now()
);
create index if not exists dealer_retail_price_history_idx on public.dealer_retail_price_history (dealer_id, manufacturer, code, changed_at desc);

create table if not exists public.dealer_document_sends (
  id            bigint generated always as identity primary key,
  dealer_id     uuid          not null,
  kind          text          not null check (kind in ('brochure','quote')),
  to_domain     text,
  to_hash       text          not null,
  status        text          not null default 'sent' check (status in ('sent','failed')),
  created_at    timestamptz   not null default now()
);
create index if not exists dealer_document_sends_idx on public.dealer_document_sends (dealer_id, created_at desc);

alter table public.dealer_retail_prices enable row level security;
alter table public.dealer_retail_price_history enable row level security;
alter table public.dealer_document_sends enable row level security;
revoke all on public.dealer_retail_prices, public.dealer_retail_price_history, public.dealer_document_sends from public, anon, authenticated;
revoke all on sequence public.dealer_retail_prices_id_seq, public.dealer_retail_price_history_id_seq, public.dealer_document_sends_id_seq from public, anon, authenticated;
grant select, insert, update, delete on public.dealer_retail_prices to service_role;
grant select, insert on public.dealer_retail_price_history to service_role;
grant select, insert, update on public.dealer_document_sends to service_role;

-- Check (one row): three tables, RLS on, no policies, no public rights, nothing written.
select
  (select count(*) from information_schema.tables where table_schema='public'
     and table_name in ('dealer_retail_prices','dealer_retail_price_history','dealer_document_sends'))               as tables_3,
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.dealer_retail_prices'::regclass,
     'public.dealer_retail_price_history'::regclass,'public.dealer_document_sends'::regclass))                         as rls_on_all,
  (select count(*) from pg_policies where schemaname='public'
     and tablename in ('dealer_retail_prices','dealer_retail_price_history','dealer_document_sends'))                  as policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema='public'
     and table_name in ('dealer_retail_prices','dealer_retail_price_history','dealer_document_sends')
     and grantee in ('anon','authenticated','PUBLIC'))                                                                  as public_grants_0,
  (has_sequence_privilege('anon','public.dealer_retail_prices_id_seq','usage')
     or has_sequence_privilege('anon','public.dealer_document_sends_id_seq','usage')
     or has_sequence_privilege('authenticated','public.dealer_retail_price_history_id_seq','usage'))                  as public_seq_access_false,
  (select count(*) from public.dealer_retail_prices) + (select count(*) from public.dealer_document_sends)           as rows_0;
