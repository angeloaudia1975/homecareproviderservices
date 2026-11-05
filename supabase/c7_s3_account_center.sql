-- ============================================================================
-- C3-07 STAGE 3 — DEALER ACCOUNT MANAGEMENT CENTER (owner directive 2026-11-05; decisions D2 2026-11-05 15:20 CT)
-- Additive only. Nothing here grants ordering access, changes a price or changes an existing value.
--
--  1. dealer_manufacturers.verified_at / verified_by / verify_note — "HCPS verified this manufacturer account number".
--     Set ONLY by HCPS staff (dealers-api). Verification is separate from ordering permission: the `active` flag that
--     drives ordering is untouched by it.
--  2. dealer_account_claims — a dealer telling HCPS "we already have an account with <line>, number X". Written only by
--     dealer-tools-api (service role); HCPS staff verify or reject it. One open claim per dealer + line.
--  3. dealer_user_scope — which locations a Partner 360 login may see (D2). No row = the default rule: a head-office login
--     sees its company's locations, a branch login only its own. Written only by HCPS staff.
--  4. dealers.default_ship_key — the ship-to address the dealer picked as the checkout default (one of its own addresses).
--  5. storage bucket dealer-logos — a dealer's OWN logo (JPEG/PNG, 1 MB max). Public read on purpose: the logo is printed
--     on the dealer's quotes, brochures and public storefront. Written only by the server (service role); the public key
--     cannot list, upload or change anything in it (no storage policies are added).
-- RULE 19: new tables RLS on, no policies, no rights for anon / authenticated / public.
-- Rollback: drop table if exists public.dealer_account_claims, public.dealer_user_scope;
--   alter table public.dealer_manufacturers drop column if exists verified_at, drop column if exists verified_by,
--     drop column if exists verify_note;
--   alter table public.dealers drop column if exists default_ship_key;
--   (bucket: empty it in the Storage screen, then delete it there)
-- ============================================================================
alter table public.dealer_manufacturers add column if not exists verified_at timestamptz;
alter table public.dealer_manufacturers add column if not exists verified_by text;
alter table public.dealer_manufacturers add column if not exists verify_note text;

create table if not exists public.dealer_account_claims (
  id              bigint generated always as identity primary key,
  dealer_id       uuid        not null references public.dealers(id),
  manufacturer    text        not null,
  account_ref     text        not null check (char_length(account_ref) between 1 and 40),
  note            text        check (note is null or char_length(note) <= 300),
  status          text        not null default 'pending' check (status in ('pending','verified','rejected')),
  submitted_email text,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      text,
  decision_note   text
);
create index if not exists dealer_account_claims_dealer_idx on public.dealer_account_claims (dealer_id, manufacturer, created_at desc);
create unique index if not exists dealer_account_claims_open_uk on public.dealer_account_claims (dealer_id, manufacturer) where status = 'pending';
alter table public.dealer_account_claims enable row level security;
revoke all on public.dealer_account_claims from public, anon, authenticated;
revoke all on sequence public.dealer_account_claims_id_seq from public, anon, authenticated;
grant select, insert, update on public.dealer_account_claims to service_role;

create table if not exists public.dealer_user_scope (
  uid        uuid        primary key,
  scope      text        not null check (scope in ('own','company','list')),
  locations  uuid[],
  set_by     text        not null,
  set_at     timestamptz not null default now(),
  check (scope <> 'list' or (locations is not null and cardinality(locations) between 1 and 200))
);
alter table public.dealer_user_scope enable row level security;
revoke all on public.dealer_user_scope from public, anon, authenticated;
grant select, insert, update, delete on public.dealer_user_scope to service_role;

alter table public.dealers add column if not exists default_ship_key text check (default_ship_key is null or char_length(default_ship_key) <= 40);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dealer-logos', 'dealer-logos', true, 1048576, array['image/jpeg','image/png'])
on conflict (id) do nothing;

-- Check (one row): every piece present, RLS on, no policies, no public rights, nothing written.
select
  (select count(*) from information_schema.columns where table_schema='public' and table_name='dealer_manufacturers'
     and column_name in ('verified_at','verified_by','verify_note'))                                                as dm_columns_3,
  (select count(*) from information_schema.columns where table_schema='public' and table_name='dealers'
     and column_name='default_ship_key')                                                                            as dealers_column_1,
  (select relrowsecurity from pg_class where oid='public.dealer_account_claims'::regclass)
    and (select relrowsecurity from pg_class where oid='public.dealer_user_scope'::regclass)                       as rls_on_both,
  (select count(*) from pg_policies where schemaname='public' and tablename in ('dealer_account_claims','dealer_user_scope')) as policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema='public'
     and table_name in ('dealer_account_claims','dealer_user_scope') and grantee in ('anon','authenticated','PUBLIC'))   as public_grants_0,
  (has_sequence_privilege('anon','public.dealer_account_claims_id_seq','usage,select,update')
     or has_sequence_privilege('authenticated','public.dealer_account_claims_id_seq','usage,select,update'))      as public_seq_access_false,
  (select count(*) from pg_indexes where schemaname='public' and indexname='dealer_account_claims_open_uk')         as open_index_1,
  (select public::text || ',' || file_size_limit::text || ',' || array_to_string(allowed_mime_types, '/')
     from storage.buckets where id='dealer-logos')                                                                  as logo_bucket,
  (select count(*) from public.dealer_manufacturers where verified_at is not null)                                  as verified_rows_0,
  (select count(*) from public.dealer_account_claims) + (select count(*) from public.dealer_user_scope)              as new_rows_0;
