-- ============================================================================
-- C3-07 STAGE 7 — DEALER-BRANDED PUBLIC STOREFRONTS (owner directive 2026-11-06; decisions D2, D3, D4)
-- Additive only: four new tables + three functions. Nothing existing is read or changed.
--
-- dealer_storefronts        one public storefront per dealer LOCATION, reached by a shareable link (/store/<slug>).
--                           Off until the dealer turns it on; HCPS can block one (hcps_blocked — the dealer can't clear it).
--                           Shows only public content: name, logo, contact details the dealer chose, catalog products of
--                           its authorized lines, verified MSRP or "Call for Price" (D3). Never wholesale or account data.
-- storefront_inquiries      "Request Information" messages from the public (D4: kept 24 months — delete_after — with a
--                           privacy notice; the dealer can mark handled or delete). No IP address or tracking id stored.
-- storefront_daily_counts   ANONYMOUS daily counts per storefront + product (views, inquiries) for Stage 8 demand
--                           intelligence (D4: no cookies, no visitor profiles, nothing about the visitor).
-- storefront_rate           abuse limits per visitor: a short-lived keyed hash of the network address (never the address),
--                           per hour bucket; purged after 2 days. Nothing else about a visitor.
-- storefront_count(...)     adds product VIEWS to the daily counts under limits (server only).
-- storefront_inquiry_add(…) stores one "Request Information" under every limit, atomically (advisory locks), and says
--                           whether it may be emailed (at most 10 emails a storefront an hour; the rest wait in My Storefront).
-- storefront_purge()        deletes inquiries past delete_after and rate rows older than 2 days.
-- RULE 19: RLS on, no policies, nothing for anon / authenticated / public; service_role only. Functions: service_role only.
-- Rollback (only while empty): drop function storefront_purge(); drop function storefront_inquiry_add(uuid, jsonb, text);
--   drop function storefront_count(uuid, jsonb, text); drop table storefront_rate; drop table storefront_daily_counts;
--   drop table storefront_inquiries; drop table dealer_storefronts;
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
  mail_slot      boolean      not null default false,                               -- this request was allowed an email
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

create table if not exists public.storefront_rate (
  bucket         timestamptz  not null,                                            -- the hour
  client         text         not null check (client ~ '^([0-9a-f]{32}|none)$'),  -- keyed hash of the network address (never the address)
  dealer_id      uuid         not null references public.dealers(id),
  views          int          not null default 0,
  inquiries      int          not null default 0,
  primary key (bucket, client, dealer_id)
);
create index if not exists storefront_rate_client_idx on public.storefront_rate (client, bucket);

-- product VIEWS (≤40 a call) for a live storefront, today (Chicago). Limits: 400 product views per visitor per storefront
-- in 24 hours, 20,000 per storefront a day — beyond them nothing is counted (the page still works).
create or replace function public.storefront_count(p_dealer uuid, p_items jsonb, p_client text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; it jsonb; d date := (now() at time zone 'America/Chicago')::date; mine int; total int; room int;
begin
  if p_dealer is null or coalesce(p_client,'') !~ '^([0-9a-f]{32}|none)$' or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 40 then return 0; end if;
  if not exists (select 1 from public.dealer_storefronts where dealer_id = p_dealer and enabled and not hcps_blocked) then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('sfview:' || p_dealer::text));
  select coalesce(sum(views),0) into mine from public.storefront_rate where client = p_client and dealer_id = p_dealer and bucket > now() - interval '24 hours';
  select coalesce(sum(views),0) into total from public.storefront_daily_counts where day = d and dealer_id = p_dealer;
  room := least(400 - mine, 20000 - total);
  for it in select * from jsonb_array_elements(p_items) loop
    exit when n >= room;
    if coalesce(it->>'manufacturer','') !~ '^[a-z0-9-]{2,60}$' or char_length(coalesce(it->>'code','')) not between 1 and 80 then continue; end if;
    insert into public.storefront_daily_counts as c (day, dealer_id, manufacturer, code, category, views)
    values (d, p_dealer, it->>'manufacturer', it->>'code', left(it->>'category', 120), 1)
    on conflict (day, dealer_id, manufacturer, code) do update set views = c.views + 1, category = coalesce(excluded.category, c.category);
    n := n + 1;
  end loop;
  if n > 0 then
    insert into public.storefront_rate as r (bucket, client, dealer_id, views) values (date_trunc('hour', now()), p_client, p_dealer, n)
    on conflict (bucket, client, dealer_id) do update set views = r.views + excluded.views;
  end if;
  return n;
end $$;

-- ONE "Request Information", all limits checked and the row written in one transaction (no race): the storefront must be live;
-- per visitor 3 an hour / 8 a day (all storefronts); per email or phone 3 a day; per storefront 200 stored a day. Returns
-- {ok, id, send, to} — send = may be emailed now (10 a storefront an hour), to = the storefront's own request address —
-- or {refused: 'unavailable'|'client'|'contact'|'storefront'}.
create or replace function public.storefront_inquiry_add(p_storefront uuid, p_row jsonb, p_client text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sf record; v_id uuid; v_send boolean; v_email text := nullif(p_row->>'email',''); v_phone text := nullif(p_row->>'phone','');
begin
  if p_storefront is null or coalesce(p_client,'') !~ '^([0-9a-f]{32}|none)$' then return jsonb_build_object('refused','unavailable'); end if;
  perform pg_advisory_xact_lock(hashtext('sfinq:' || p_storefront::text));
  perform pg_advisory_xact_lock(hashtext('sfcli:' || p_client));
  select id, dealer_id, email, enabled, hcps_blocked into sf from public.dealer_storefronts where id = p_storefront;
  if not found or not sf.enabled or sf.hcps_blocked then return jsonb_build_object('refused','unavailable'); end if;
  if exists (select 1 from public.dealers d where d.id = sf.dealer_id and d.active is false) then return jsonb_build_object('refused','unavailable'); end if;
  perform pg_advisory_xact_lock(hashtext('sfview:' || sf.dealer_id::text));   -- same lock as storefront_count: one order of row locks, no deadlock
  if (select coalesce(sum(inquiries),0) from public.storefront_rate where client = p_client and bucket > now() - interval '1 hour') >= 3
     or (select coalesce(sum(inquiries),0) from public.storefront_rate where client = p_client and bucket > now() - interval '24 hours') >= 8 then
    return jsonb_build_object('refused','client'); end if;
  if (v_email is not null and (select count(*) from public.storefront_inquiries where email = v_email and created_at > now() - interval '24 hours') >= 3)
     or (v_phone is not null and (select count(*) from public.storefront_inquiries where regexp_replace(phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g') and created_at > now() - interval '24 hours') >= 3) then
    return jsonb_build_object('refused','contact'); end if;
  if (select count(*) from public.storefront_inquiries where storefront_id = p_storefront and created_at > now() - interval '24 hours') >= 200 then
    return jsonb_build_object('refused','storefront'); end if;
  v_send := sf.email is not null and (select count(*) from public.storefront_inquiries where storefront_id = p_storefront and mail_slot and created_at > now() - interval '1 hour') < 10;
  insert into public.storefront_inquiries (storefront_id, dealer_id, name, email, phone, message, manufacturer, product_code, product_name, mail_slot)
  values (p_storefront, sf.dealer_id, p_row->>'name', v_email, v_phone, nullif(p_row->>'message',''), nullif(p_row->>'manufacturer',''),
          nullif(p_row->>'product_code',''), nullif(p_row->>'product_name',''), v_send)
  returning id into v_id;
  insert into public.storefront_rate as r (bucket, client, dealer_id, inquiries) values (date_trunc('hour', now()), p_client, sf.dealer_id, 1)
  on conflict (bucket, client, dealer_id) do update set inquiries = r.inquiries + 1;
  if nullif(p_row->>'manufacturer','') is not null and nullif(p_row->>'product_code','') is not null then
    insert into public.storefront_daily_counts as c (day, dealer_id, manufacturer, code, category, inquiries)
    values ((now() at time zone 'America/Chicago')::date, sf.dealer_id, p_row->>'manufacturer', p_row->>'product_code', left(p_row->>'category',120), 1)
    on conflict (day, dealer_id, manufacturer, code) do update set inquiries = c.inquiries + 1, category = coalesce(excluded.category, c.category);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'send', v_send, 'to', case when v_send then sf.email end);
end $$;

-- D4: inquiry contacts are kept 24 months, then deleted (run daily by the storefront-retention scheduled function)
create or replace function public.storefront_purge()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; begin delete from public.storefront_inquiries where delete_after < current_date; get diagnostics n = row_count;
  delete from public.storefront_rate where bucket < now() - interval '2 days'; return n; end $$;

alter table public.dealer_storefronts enable row level security;
alter table public.storefront_inquiries enable row level security;
alter table public.storefront_daily_counts enable row level security;
alter table public.storefront_rate enable row level security;
revoke all on public.dealer_storefronts, public.storefront_inquiries, public.storefront_daily_counts, public.storefront_rate from public, anon, authenticated;
revoke all on public.dealer_storefronts, public.storefront_inquiries, public.storefront_daily_counts, public.storefront_rate from service_role;
grant select, insert, update on public.dealer_storefronts to service_role;
grant select, update, delete on public.storefront_inquiries to service_role;   -- new rows only through storefront_inquiry_add
grant select on public.storefront_daily_counts to service_role;
revoke all on function public.storefront_count(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.storefront_inquiry_add(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.storefront_purge() from public, anon, authenticated;
grant execute on function public.storefront_count(uuid, jsonb, text) to service_role;
grant execute on function public.storefront_inquiry_add(uuid, jsonb, text) to service_role;
grant execute on function public.storefront_purge() to service_role;

-- Check (one row): 4 tables, RLS on all, no policies, no public table or function rights, nothing written.
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name in ('dealer_storefronts','storefront_inquiries','storefront_daily_counts','storefront_rate')) as tables_4,
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.dealer_storefronts'::regclass,'public.storefront_inquiries'::regclass,'public.storefront_daily_counts'::regclass,'public.storefront_rate'::regclass)) as rls_on,
  (select count(*) from pg_policies where schemaname='public' and tablename in ('dealer_storefronts','storefront_inquiries','storefront_daily_counts','storefront_rate')) as policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('dealer_storefronts','storefront_inquiries','storefront_daily_counts','storefront_rate') and grantee in ('anon','authenticated','PUBLIC')) as public_grants_0,
  (select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name in ('storefront_count','storefront_inquiry_add','storefront_purge') and grantee in ('anon','authenticated','PUBLIC')) as public_exec_0,
  (select count(*) from public.dealer_storefronts) + (select count(*) from public.storefront_inquiries) + (select count(*) from public.storefront_daily_counts) + (select count(*) from public.storefront_rate) as rows_0;
