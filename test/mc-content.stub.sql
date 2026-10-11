-- test/mc-content-freeze.pg.test.js: the content tables as the project has them (columns the guard and
-- the storefront read), with the storefront's real read rule on product_content, plus a few rows: a live
-- page on each Gold Standard line that has pages, a draft on an unfrozen line, media, links, related.
-- NOT shipped. Runs after test/mc-guard.stub.sql + migrate-phase2-product-skus.sql + test/mc-guard.data.sql.
create table public.product_content (
  id uuid primary key default gen_random_uuid(), manufacturer text not null, page_key text not null,
  name text, tagline text, description text, features jsonb not null default '[]'::jsonb, specs jsonb not null default '[]'::jsonb,
  warranty text, image text, images_gallery jsonb, category text, subcategory text, skus jsonb not null default '[]'::jsonb,
  options jsonb not null default '{}'::jsonb, source_url text, field_provenance jsonb, reviewed_by text,
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','rejected','published','active','discontinued','hidden')),
  disabled boolean not null default false, published_at timestamptz, updated_at timestamptz not null default now(),
  unique (manufacturer, page_key));
alter table public.product_content enable row level security;
create policy "product_content read public" on public.product_content for select to anon, authenticated
  using (status in ('published','active','discontinued') and coalesce(disabled, false) = false);
create table public.product_content_sources (id uuid primary key default gen_random_uuid(), manufacturer text not null, page_key text not null,
  source text not null, name text, description text, images jsonb not null default '[]'::jsonb, captured_at timestamptz not null default now(),
  unique (manufacturer, page_key, source));
create table public.product_content_history (id bigserial primary key, manufacturer text, page_key text, action text, actor text, summary text,
  before jsonb, after jsonb, undone boolean default false, at timestamptz default now());
create table public.product_media (id uuid primary key default gen_random_uuid(), manufacturer text not null, code text not null, kind text not null,
  url text not null, title text, sort int default 0, created_at timestamptz default now());
create table public.product_links (manufacturer text not null, code text not null, label text, url text, primary key (manufacturer, code));
create table public.product_related (id uuid primary key default gen_random_uuid(), manufacturer text not null, code text not null,
  related_manufacturer text not null, related_code text not null, kind text not null default 'accessory', sort int default 0,
  unique (manufacturer, code, related_manufacturer, related_code));
grant select on public.product_content, public.product_media, public.product_links, public.product_related to anon, authenticated;

insert into public.product_content (manufacturer, page_key, name, description, category, status, skus) values
  ('climbing-steps', 'fcom', 'Freedom Commode', 'Live page', 'Bath Safety', 'published', '[{"sku":"FCOM-02"},{"sku":"FCOM-03"}]'),
  ('ovation-medical', 'gen2', 'Gen 2 Walker', 'Live page', 'Orthopedic Bracing & Supports', 'published', '[{"sku":"61000-210"}]'),
  ('strongback-mobility', 'sb', 'Strongback Chair', 'Live page', 'Mobility', 'active', '[{"sku":"1003AB"}]'),
  ('ovation-medical', 'old', 'Retired page', 'Hidden page', 'Orthopedic Bracing & Supports', 'hidden', '[]'),
  ('pedifix', 'p1', 'PediFix draft', 'Draft on an unfrozen line', 'Foot Care', 'pending_review', '[{"sku":"P1"}]');
insert into public.product_media (manufacturer, code, kind, url) values ('ovation-medical', '61000-210', 'image', 'https://x/a.jpg'), ('pedifix', 'P1', 'image', 'https://x/p.jpg');
insert into public.product_links (manufacturer, code, label, url) values ('climbing-steps', 'FCOM-02', 'Manual', 'https://x/m.pdf');
insert into public.product_related (manufacturer, code, related_manufacturer, related_code) values ('strongback-mobility', '1003AB', 'strongback-mobility', 'A1005');
update public.manufacturer_meta set category_map = '{"Toilet Seats":"Bath Safety"}'::jsonb, logo_url = 'https://x/logo.jpg', active = true, enriched_only = false;
