-- ============================================================================
-- C3-07 STAGE 4 — SAVED CUSTOMER QUOTES (owner directive 2026-11-05: "Saved customer quotes")
-- Additive only: one new table. Nothing here reads or changes a price, order, dealer or existing table.
--
-- A dealer's customer quote, saved so it can be reopened, edited, printed and emailed again. Owned by the dealer COMPANY
-- (dealer_id = the head office) and the location that made it (location_id); who may see or change one follows D2
-- (head office: its company's locations · branch: its own) — decided by dealer-quotes-api, the only writer.
-- lines = the quote's products with ONE customer price basis each (msrp · retail · once) — never a dealer cost.
-- The customer's contact details are the dealer's own customer data: the dealer can delete a quote at any time.
-- RULE 19: RLS on, no policies, no rights for anon / authenticated / public; service_role only.
-- Rollback: drop table if exists public.dealer_saved_quotes;
-- ============================================================================
create table if not exists public.dealer_saved_quotes (
  id              uuid          primary key default gen_random_uuid(),
  dealer_id       uuid          not null references public.dealers(id),
  location_id     uuid          not null references public.dealers(id),
  quote_no        text          not null check (quote_no ~ '^Q[0-9]{6}-[0-9A-Z]{4}$'),
  title           text          check (title is null or char_length(title) <= 120),
  customer_name   text          check (customer_name is null or char_length(customer_name) <= 120),
  customer_email  text          check (customer_email is null or char_length(customer_email) <= 200),
  customer_phone  text          check (customer_phone is null or char_length(customer_phone) <= 40),
  valid_for       text          check (valid_for is null or char_length(valid_for) <= 40),
  notes           text          check (notes is null or char_length(notes) <= 2000),
  lines           jsonb         not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 60),
  status          text          not null default 'draft' check (status in ('draft','sent')),
  sent_count      int           not null default 0 check (sent_count >= 0),
  sent_at         timestamptz,
  created_by      text          not null,
  created_at      timestamptz   not null default now(),
  updated_by      text          not null,
  updated_at      timestamptz   not null default now()
);
create unique index if not exists dealer_saved_quotes_no_uk on public.dealer_saved_quotes (dealer_id, quote_no);
create index if not exists dealer_saved_quotes_loc_idx on public.dealer_saved_quotes (dealer_id, location_id, updated_at desc);

alter table public.dealer_saved_quotes enable row level security;
revoke all on public.dealer_saved_quotes from public, anon, authenticated;
grant select, insert, update, delete on public.dealer_saved_quotes to service_role;

-- Check (one row): table present, RLS on, no policies, no public rights, nothing written.
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name='dealer_saved_quotes')          as table_1,
  (select relrowsecurity from pg_class where oid='public.dealer_saved_quotes'::regclass)                                        as rls_on,
  (select count(*) from pg_policies where schemaname='public' and tablename='dealer_saved_quotes')                               as policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='dealer_saved_quotes'
     and grantee in ('anon','authenticated','PUBLIC'))                                                                           as public_grants_0,
  (select count(*) from public.dealer_saved_quotes)                                                                              as rows_0;
