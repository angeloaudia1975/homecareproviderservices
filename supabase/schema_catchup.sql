-- HCPS Connect 360 — Phase 0E schema catch-up.
--
-- WHY THIS FILE EXISTS. Production has tables and columns that the code relies on but that no
-- file in this repo creates: they were added in the Supabase dashboard or by SQL that was never
-- committed. This file records them, exactly as production had them on 2026-10-02 (read from
-- information_schema / pg_constraint / pg_indexes, read-only), so a fresh database built from
-- the repo matches the live one and Phase 1 migrations can be written against a known schema.
--
-- SAFE TO RUN ON PRODUCTION. Every statement is IF NOT EXISTS: it creates nothing that already
-- exists, changes no type, drops nothing and touches no rows. On today's production it is a
-- no-op ("Success. No rows returned").
--
-- Not included on purpose: partner_referrals (used by partner-api, but it does not exist in
-- production either), and dealers.rep_email (added by Phase 0C, supabase/dealer_rep_email.sql).

-- ─── Tables the repo never created ───────────────────────────────────────────────────────────
create table if not exists public.reps (
  id uuid not null default gen_random_uuid(), name text not null, email text,
  active boolean default true, created_at timestamptz default now(),
  primary key (id));

create table if not exists public.dealer_manufacturers (
  dealer_id uuid not null, manufacturer text not null, active boolean default true,
  created_at timestamptz default now(), account_ref text,
  primary key (dealer_id, manufacturer),
  foreign key (dealer_id) references public.dealers(id) on delete cascade,
  foreign key (manufacturer) references public.manufacturers(slug) on delete cascade);

create table if not exists public.manufacturer_meta (
  slug text not null, logo_url text, updated_at timestamptz not null default now(),
  active boolean not null default true, enriched_only boolean not null default false,
  category_order jsonb, category_map jsonb, record_authoritative boolean not null default false,
  record_resync_at timestamptz, record_resync_error text,
  primary key (slug));

create table if not exists public.dealer_users (
  uid uuid not null, email text not null, dealer_id uuid, status text not null default 'pending',
  created_at timestamptz default now(), approved_at timestamptz, approved_by text,
  req_company text, req_contact text, req_phone text, req_address text, req_city text,
  req_state text, req_zip text,
  primary key (uid), unique (email),
  foreign key (dealer_id) references public.dealers(id) on delete set null);

create table if not exists public.dealer_sessions (
  id uuid not null default gen_random_uuid(), uid uuid, dealer_id uuid, email text,
  login_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  user_agent text,
  primary key (id),
  foreign key (dealer_id) references public.dealers(id) on delete set null);

create table if not exists public.dealer_carts (
  uid uuid not null, dealer_id uuid, email text, cart jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (uid),
  foreign key (dealer_id) references public.dealers(id) on delete set null);

create table if not exists public.dealer_aliases (
  alias_norm text not null, raw_name text, dealer_id uuid not null, created_at timestamptz default now(),
  primary key (alias_norm),
  foreign key (dealer_id) references public.dealers(id) on delete cascade);

create table if not exists public.dealer_nomerge (
  a uuid not null, b uuid not null, created_at timestamptz default now(),
  primary key (a, b));

create table if not exists public.dealer_change_requests (
  id uuid not null default gen_random_uuid(), dealer_id uuid, uid uuid, email text,
  changes jsonb not null, status text not null default 'pending',
  created_at timestamptz not null default now(), decided_at timestamptz, decided_by text,
  primary key (id),
  foreign key (dealer_id) references public.dealers(id) on delete set null);

-- Note: dealer_id is TEXT here in production (not uuid like every other dealer table).
create table if not exists public.dealer_cross_sell (
  id uuid not null default gen_random_uuid(), dealer_id text not null, manufacturer text,
  mfr_name text, product_code text, product_name text, family text, category text,
  opp_type text not null default 'cross_sell', priority text not null default 'medium',
  status text not null default 'open', notes text, source text not null default 'rep',
  created_by text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by text,
  primary key (id));

-- Production keeps row-level security on for every public table with no policies, so only the
-- server (service role) can read them. Match that.
alter table public.reps                   enable row level security;
alter table public.dealer_manufacturers   enable row level security;
alter table public.manufacturer_meta      enable row level security;
alter table public.dealer_users           enable row level security;
alter table public.dealer_sessions        enable row level security;
alter table public.dealer_carts           enable row level security;
alter table public.dealer_aliases         enable row level security;
alter table public.dealer_nomerge         enable row level security;
alter table public.dealer_change_requests enable row level security;
alter table public.dealer_cross_sell      enable row level security;

-- ─── Columns the code uses on tables the repo did create ─────────────────────────────────────
-- dealers (base table: homecareproviderservicesordering/supabase/schema.sql)
alter table public.dealers add column if not exists status text;
alter table public.dealers add column if not exists notes text;
alter table public.dealers add column if not exists updated_at timestamptz default now();
alter table public.dealers add column if not exists parent_id uuid;
alter table public.dealers add column if not exists source_name text;
alter table public.dealers add column if not exists website text;
alter table public.dealers add column if not exists business_type text;
alter table public.dealers add column if not exists business_model text;
alter table public.dealers add column if not exists golden_flagship text;
alter table public.dealers add column if not exists mobility_flagship text;
alter table public.dealers add column if not exists ovation_access boolean default false;
alter table public.dealers add column if not exists ovation_medical text;
alter table public.dealers add column if not exists call_date text;
alter table public.dealers add column if not exists golden_status text;
alter table public.dealers add column if not exists golden_url text;
alter table public.dealers add column if not exists is_test boolean default false;
alter table public.dealers add column if not exists dealer_organization text;
alter table public.dealers add column if not exists golden_flagship_level text;
alter table public.dealers add column if not exists mobility_flagship_level text;
alter table public.dealers add column if not exists ovation_status text;
alter table public.dealers add column if not exists email_verified boolean;
alter table public.dealers add column if not exists email_verified_at timestamptz;
alter table public.dealers add column if not exists rep_name text;
-- Production differs from schema.sql here: hcps_account is NOT unique and NOT required live
-- (dealers are created without one). Recorded, not changed.

-- monthly_sales
alter table public.monthly_sales add column if not exists rep_id uuid;
alter table public.monthly_sales add column if not exists cost numeric;
alter table public.monthly_sales add column if not exists commission numeric;
alter table public.monthly_sales add column if not exists customer_name text;
alter table public.monthly_sales add column if not exists customer_ref text;
alter table public.monthly_sales add column if not exists rep_name text;
alter table public.monthly_sales add column if not exists ship_city text;
alter table public.monthly_sales add column if not exists ship_state text;
alter table public.monthly_sales add column if not exists order_date date;
alter table public.monthly_sales add column if not exists channel text;
alter table public.monthly_sales add column if not exists item_no text;
alter table public.monthly_sales add column if not exists line_type text;
alter table public.monthly_sales add column if not exists credit_reason text;
alter table public.monthly_sales add column if not exists invoice_no text;
alter table public.monthly_sales add column if not exists ship_zip text;
alter table public.monthly_sales add column if not exists commission_rate numeric;
alter table public.monthly_sales add column if not exists billed_amount numeric;
alter table public.monthly_sales add column if not exists memo text;
alter table public.monthly_sales add column if not exists source text;
alter table public.monthly_sales add column if not exists external_ref text;
alter table public.monthly_sales add column if not exists ship_name text;
alter table public.monthly_sales add column if not exists ship_address text;

-- rep_routes (route assignment — used by routes-api, never migrated)
alter table public.rep_routes add column if not exists calendar jsonb;
alter table public.rep_routes add column if not exists assigned_to_email text;
alter table public.rep_routes add column if not exists assigned_to_rep text;
alter table public.rep_routes add column if not exists assigned_at timestamptz;
alter table public.rep_routes add column if not exists assigned_by text;

-- dealer_contacts
alter table public.dealer_contacts add column if not exists cell text;

-- staff_users (base table: homecareproviderservicesordering/supabase/staff.sql)
alter table public.staff_users add column if not exists email_signature text;
alter table public.staff_users add column if not exists home_base jsonb;
alter table public.staff_users add column if not exists favorites jsonb;

-- ─── Indexes production has ──────────────────────────────────────────────────────────────────
create index if not exists dealer_aliases_dealer_idx on public.dealer_aliases (dealer_id);
create index if not exists dealer_carts_dealer_idx on public.dealer_carts (dealer_id);
create index if not exists dcr_status_idx on public.dealer_change_requests (status, created_at desc);
create unique index if not exists dealer_contacts_dealer_email_uniq on public.dealer_contacts (dealer_id, email);
create index if not exists dealer_contacts_email_idx on public.dealer_contacts (lower(btrim(email)));
create index if not exists dealer_cross_sell_dealer on public.dealer_cross_sell (dealer_id);
create index if not exists dealer_cross_sell_mfr on public.dealer_cross_sell (manufacturer);
create index if not exists dealer_cross_sell_open on public.dealer_cross_sell (dealer_id, status);
create index if not exists dealer_mfr_dealer_idx on public.dealer_manufacturers (dealer_id);
create index if not exists dealer_sessions_dealer_idx on public.dealer_sessions (dealer_id, last_seen_at desc);
create index if not exists dealer_sessions_seen_idx on public.dealer_sessions (last_seen_at desc);
create index if not exists dealer_users_dealer_idx on public.dealer_users (dealer_id);
create index if not exists dealer_users_status_idx on public.dealer_users (status);
create unique index if not exists dealers_bizname_key on public.dealers (business_name);
create index if not exists dealers_email_verified_idx on public.dealers (email_verified);
create index if not exists dealers_golden_flag_idx on public.dealers (golden_flagship_level);
create index if not exists dealers_hcps_account_idx on public.dealers (hcps_account);
create index if not exists dealers_mobility_flag_idx on public.dealers (mobility_flagship_level);
create index if not exists dealers_org_idx on public.dealers (dealer_organization);
create index if not exists dealers_ovation_status_idx on public.dealers (ovation_status);
create index if not exists dealers_parent_id_idx on public.dealers (parent_id);
create index if not exists dealers_source_name_idx on public.dealers (source_name);
create index if not exists dealers_status_idx on public.dealers (status);
create index if not exists monthly_sales_acct_idx on public.monthly_sales (hcps_account);
create index if not exists monthly_sales_channel_idx on public.monthly_sales (manufacturer, channel);
create unique index if not exists monthly_sales_extref_uniq on public.monthly_sales (manufacturer, external_ref);
create index if not exists monthly_sales_invno_idx on public.monthly_sales (manufacturer, invoice_no);
create index if not exists monthly_sales_linetype_idx on public.monthly_sales (manufacturer, line_type);
create index if not exists monthly_sales_orderdate_idx on public.monthly_sales (order_date);
create index if not exists monthly_sales_period_idx on public.monthly_sales (manufacturer, period);
create index if not exists monthly_sales_zip_idx on public.monthly_sales (manufacturer, ship_zip);
create index if not exists rep_routes_assigned_to on public.rep_routes (lower(assigned_to_email));
create index if not exists rep_routes_owner on public.rep_routes (lower(owner_email));
create index if not exists rep_routes_owner_idx on public.rep_routes (owner_email);
create index if not exists rep_routes_rep_idx on public.rep_routes (rep_name);
create index if not exists rep_routes_sched on public.rep_routes (scheduled_date desc);
