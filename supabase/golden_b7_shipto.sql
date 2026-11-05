-- supabase/golden_b7_shipto.sql — B7 (owner directive 2026-11-05): HCPS is the ship-to system of record for Golden
-- orders placed in Partner 360. Two new tables, nothing else changes. Run ONCE, by Angelo, in the HCPS Supabase SQL editor.
--
--   golden_ship_addresses  the Golden shipping addresses dealers save, per GOLDEN ACCOUNT NUMBER (every HCPS location
--                          carrying that number shares them). Never hard-deleted: removal sets removed_at / removed_by.
--   golden_ship_defaults   each sign-in's own default ship-to per account (one row per user + account number).
--
-- RULE 19: RLS ON with NO policies, and no privileges for PUBLIC / anon / authenticated — only the server
-- (service_role, used by netlify/functions/golden-addresses-api.js and golden-proxy.js) reads and writes them.
-- Additive and idempotent-safe: refuses to run twice (the tables must not exist yet). Rollback: golden_b7_shipto_rollback.sql.

do $$
begin
  if to_regclass('public.golden_ship_addresses') is not null or to_regclass('public.golden_ship_defaults') is not null then
    raise exception 'golden_b7_shipto.sql already installed — nothing written';
  end if;
end $$;

create table public.golden_ship_addresses (
  id              uuid primary key default gen_random_uuid(),
  account_no      text not null check (account_no ~ '^[A-Za-z0-9-]{1,20}$'),
  name            text not null check (char_length(name) between 2 and 80),
  address         text not null check (char_length(address) between 3 and 120),
  address2        text not null default '' check (char_length(address2) <= 80),
  city            text not null check (char_length(city) between 2 and 60),
  state           text not null check (state ~ '^[A-Z]{2}$'),
  zip             text not null check (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  phone           text not null default '' check (char_length(phone) <= 30),
  created_by      uuid,
  created_dealer  uuid,
  created_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  removed_by      uuid,
  removed_at      timestamptz
);
create index golden_ship_addresses_account on public.golden_ship_addresses (account_no) where removed_at is null;

create table public.golden_ship_defaults (
  user_uid    uuid not null,
  account_no  text not null check (account_no ~ '^[A-Za-z0-9-]{1,20}$'),
  ref         text not null check (char_length(ref) <= 96),
  updated_at  timestamptz not null default now(),
  primary key (user_uid, account_no)
);

alter table public.golden_ship_addresses enable row level security;
alter table public.golden_ship_defaults  enable row level security;
revoke all on public.golden_ship_addresses from public, anon, authenticated;
revoke all on public.golden_ship_defaults  from public, anon, authenticated;
grant select, insert, update on public.golden_ship_addresses to service_role;
grant select, insert, update on public.golden_ship_defaults  to service_role;

-- Install checks (the editor shows this last result): every value must be true.
select
  (select count(*) = 2 from pg_class where relname in ('golden_ship_addresses','golden_ship_defaults') and relrowsecurity) as rls_on,
  (select count(*) = 0 from pg_policies where tablename in ('golden_ship_addresses','golden_ship_defaults')) as no_policies,
  (select count(*) = 0 from information_schema.role_table_grants
     where table_name in ('golden_ship_addresses','golden_ship_defaults') and grantee in ('PUBLIC','anon','authenticated')) as no_public_grants,
  (select count(*) = 0 from public.golden_ship_addresses) and (select count(*) = 0 from public.golden_ship_defaults) as empty;
