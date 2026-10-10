-- test/mc-guard.pg.test.js, step 1: a minimal Supabase look-alike (roles, storage schema with RLS, the project's
-- default grants to anon/authenticated) and the legacy tables the Manufacturer Center SQL touches. NOT shipped.
-- Supabase's default: new objects in public are granted to anon/authenticated/service_role.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create schema snapshots;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
alter table storage.objects enable row level security;
insert into storage.buckets(id,name,public) values ('product-images','product-images',true);
create policy "public read product-images" on storage.objects for select using (bucket_id='product-images');
grant usage on schema storage to anon, authenticated, service_role; grant select on storage.objects, storage.buckets to anon, authenticated; grant all on storage.objects, storage.buckets to service_role;
create table public.manufacturer_meta (slug text primary key, logo_url text, enriched_only boolean, category_order jsonb, category_map jsonb,
  record_authoritative boolean default false, record_resync_at timestamptz, record_resync_error text, active boolean, updated_at timestamptz);
create table public.custom_products (manufacturer text, code text, name text, category text, base_price numeric, msrp numeric, map numeric, msrp_auto boolean default false,
  image text, description text, active boolean default true, tiers jsonb, price_note text, updated_at timestamptz, primary key(manufacturer,code));
create table public.product_overrides (manufacturer text, code text, patch jsonb, updated_at timestamptz, primary key(manufacturer,code));
create table public.dealer_contract_prices (dealer_id text, manufacturer text, code text, price numeric, active boolean);
create table public.dealer_carts (dealer_id text, cart jsonb, updated_at timestamptz);
