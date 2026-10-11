-- LOCAL TEST FIXTURE ONLY — the parts of the Supabase project the Academy SQL touches. Never run in production.
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
alter role service_role bypassrls;
-- As on Supabase's API: sessions load pg-safeupdate (an UPDATE / DELETE without WHERE is refused).
do $$ begin execute format('alter database %I set session_preload_libraries = %L', current_database(), 'safeupdate'); end $$;
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz default now());
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint,
  allowed_mime_types text[], type text not null default 'STANDARD', lifecycle_configuration jsonb);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
grant usage on schema public, auth, storage to anon, authenticated, service_role;
-- Like Supabase: new objects in public are granted to everyone by default.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table public.dealers (id uuid primary key default gen_random_uuid(), business_name text, parent_id uuid references public.dealers(id),
  rep_name text, rep_email text);
create table public.manufacturers (slug text primary key, name text);
create table public.app_settings (key text primary key, value jsonb not null default '{}', updated_at timestamptz not null default now());
create table public.order_items (id int); alter table public.order_items enable row level security;
create policy dealer_items_sel on public.order_items for select using (true);
insert into public.manufacturers values ('golden-technologies','Golden Technologies');
insert into public.dealers (id, business_name) values ('00000000-0000-0000-0000-0000000000a1','HQ Medical');
insert into public.dealers (id, business_name, parent_id) values ('00000000-0000-0000-0000-0000000000a2','HQ Medical North','00000000-0000-0000-0000-0000000000a1');
insert into public.dealers (id, business_name) values ('00000000-0000-0000-0000-0000000000b1','Other Dealer');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000aaaa','learner@test.example'),
                                          ('00000000-0000-0000-0000-00000000bbbb','manager@test.example');
