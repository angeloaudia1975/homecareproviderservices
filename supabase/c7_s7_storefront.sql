-- ============================================================================
-- C3-07 STAGE 7 — DEALER-BRANDED PUBLIC STOREFRONTS (owner directive 2026-11-06; decisions D2, D3, D4)
-- Additive only: three new tables + two functions. Nothing existing is read or changed.
--
-- dealer_storefronts        one public storefront per dealer LOCATION, reached by a shareable link (/store/<slug>).
--                           Off until the dealer turns it on; HCPS can block one (hcps_blocked — the dealer can't clear it).
--                           Shows only public content: name, logo, contact details the dealer chose, catalog products of
--                           its authorized lines, verified MSRP or "Call for Price" (D3). Never wholesale or account data.
-- storefront_inquiries      "Request Information" messages from the public (D4: kept 24 months — delete_after — with a
--                           privacy notice; the dealer can mark handled or delete). No IP address or tracking id stored.
-- storefront_daily_counts   ANONYMOUS daily counts per storefront + product (views, inquiries) for Stage 8 demand
--                           intelligence (D4: no cookies, no visitor profiles, nothing about the visitor).
-- storefront_count(...)     adds to the daily counts (server only).  storefront_purge()  deletes inquiries past delete_after.
-- RULE 19: RLS on, no policies, nothing for anon / authenticated / public; service_role only. Functions: service_role only.
-- Rollback (only while empty): drop function storefront_purge(); drop function storefront_count(uuid, jsonb, text);
--   drop table storefront_daily_counts; drop table storefront_inquiries; drop table dealer_storefronts;
-- ============================================================================
create table if not exists public.dealer_storefronts (
  id             uuid         primary key default gen_random_uuid(),
  dealer_id      uuid         not null unique references public.dealers(id),       -- the location the storefront presents
  company_id     uuid         not null references public.dealers(id),              -- its head office (who may manage it)
  slug           text         not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  enabled        boolean      not null default false,
  hcps_blocked   boolean      not null default false,
  headline       text         check (headline is null or char_length(headline) <= 120),
  about          text         check (about is null or char_length(about) <= 1500),
  phone          text         check (phone is null or char_length(phone) <= 40),
  email          text         check (email is null or char_length(email) <= 200),
  hours          text         check (hours is null or char_length(hours) <= 300),
  show_address   boolean      not null default true,
  lines          text[],                                                            -- null = every authorized line
  hidden_categories text[]    not null default '{}',
  price_mode     text         not null default 'msrp' check (price_mode in ('msrp','call')),
  version        int          not null default 1,
  created_by     text         not null,
  created_at     timestamptz  not null default now(),
  updated_by     text         not null,
  updated_at     timestamptz  not null default now()
);
create index if not exists dealer_storefronts_company_idx on public.dealer_storefronts (company_id);

create table if not exists public.storefront_inquiries (
  id             uuid         primary key default gen_random_uuid(),
  storefront_id  uuid         not null references public.dealer_storefronts(id),
  dealer_id      uuid         not null references public.dealers(id),
  created_at     timestamptz  not null default now(),
  name           text         not null check (char_length(name) between 1 and 120),
  email          text         check (email is null or char_length(email) <= 200),
  phone          text         check (phone is null or char_length(phone) <= 40),
  message        text         check (message is null or char_length(message) <= 2000),
  manufacturer   text         check (manufacturer is null or manufacturer ~ '^[a-z0-9-]{2,60}$'),
  product_code   text         check (product_code is null or char_length(product_code) <= 80),
  product_name   text         check (product_name is null or char_length(product_name) <= 200),
  status         text         not null default 'new' check (status in ('new','handled')),
  handled_at     timestamptz,
  notified       boolean      not null default false,
  delete_after   date         not null default (current_date + interval '24 months')::date,
  check (email is not null or phone is not null)
);
create index if not exists storefront_inquiries_dealer_idx on public.storefront_inquiries (dealer_id, created_at desc);
create index if not exists storefront_inquiries_sf_idx on public.storefront_inquiries (storefront_id, created_at desc);
create index if not exists storefront_inquiries_purge_idx on public.storefront_inquiries (delete_after);

create table if not exists public.storefront_daily_counts (
  day            date         not null,
  dealer_id      uuid         not null references public.dealers(id),
  manufacturer   text         not null check (manufacturer ~ '^[a-z0-9-]{2,60}$'),
  code           text         not null check (char_length(code) between 1 and 80),
  category       text         check (category is null or char_length(category) <= 120),
  views          int          not null default 0 check (views >= 0),
  inquiries      int          not null default 0 check (inquiries >= 0),
  primary key (day, dealer_id, manufacturer, code)
);
create index if not exists storefront_daily_counts_mfr_idx on public.storefront_daily_counts (manufacturer, day);

-- adds one view (kind 'view') or one inquiry (kind 'inquiry') to each listed product, today (Chicago); at most 40 a call
create or replace function public.storefront_count(p_dealer uuid, p_items jsonb, p_kind text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; it jsonb; d date := (now() at time zone 'America/Chicago')::date;
begin
  if p_dealer is null or p_kind not in ('view','inquiry') or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 40 then return 0; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce(it->>'manufacturer','') !~ '^[a-z0-9-]{2,60}$' or char_length(coalesce(it->>'code','')) not between 1 and 80 then continue; end if;
    insert into public.storefront_daily_counts as c (day, dealer_id, manufacturer, code, category, views, inquiries)
    values (d, p_dealer, it->>'manufacturer', it->>'code', left(it->>'category', 120), case when p_kind = 'view' then 1 else 0 end, case when p_kind = 'inquiry' then 1 else 0 end)
    on conflict (day, dealer_id, manufacturer, code) do update
      set views = c.views + excluded.views, inquiries = c.inquiries + excluded.inquiries, category = coalesce(excluded.category, c.category);
    n := n + 1;
  end loop;
  return n;
end $$;

-- D4: inquiry contacts are kept 24 months, then deleted (run daily by the storefront-retention scheduled function)
create or replace function public.storefront_purge()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; begin delete from public.storefront_inquiries where delete_after < current_date; get diagnostics n = row_count; return n; end $$;

alter table public.dealer_storefronts enable row level security;
alter table public.storefront_inquiries enable row level security;
alter table public.storefront_daily_counts enable row level security;
revoke all on public.dealer_storefronts, public.storefront_inquiries, public.storefront_daily_counts from public, anon, authenticated;
grant select, insert, update on public.dealer_storefronts to service_role;
grant select, insert, update, delete on public.storefront_inquiries to service_role;
grant select on public.storefront_daily_counts to service_role;
revoke all on function public.storefront_count(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.storefront_purge() from public, anon, authenticated;
grant execute on function public.storefront_count(uuid, jsonb, text) to service_role;
grant execute on function public.storefront_purge() to service_role;

-- Check (one row): 3 tables, RLS on all, no policies, no public table or function rights, nothing written.
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name in ('dealer_storefronts','storefront_inquiries','storefront_daily_counts')) as tables_3,
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.dealer_storefronts'::regclass,'public.storefront_inquiries'::regclass,'public.storefront_daily_counts'::regclass)) as rls_on,
  (select count(*) from pg_policies where schemaname='public' and tablename in ('dealer_storefronts','storefront_inquiries','storefront_daily_counts')) as policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('dealer_storefronts','storefront_inquiries','storefront_daily_counts') and grantee in ('anon','authenticated','PUBLIC')) as public_grants_0,
  (select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name in ('storefront_count','storefront_purge') and grantee in ('anon','authenticated','PUBLIC')) as public_exec_0,
  (select count(*) from public.dealer_storefronts) + (select count(*) from public.storefront_inquiries) + (select count(*) from public.storefront_daily_counts) as rows_0;
