-- HCPS product media gallery.
-- Many rows per (manufacturer, code): additional images, embedded videos (YouTube/
-- Vimeo/Drive URLs), brochures (PDF), and web links. The single primary photo still
-- lives on the product/override; this is the richer gallery shown on the product page.
-- Managed by catalog-api (service role); read publicly by the ordering portal (anon).
create table if not exists product_media (
  id           uuid primary key default gen_random_uuid(),
  manufacturer text not null,
  code         text not null,
  kind         text not null,        -- 'image' | 'video' | 'brochure' | 'link'
  url          text not null,
  title        text,                 -- caption / button label
  sort         int  default 0,
  created_at   timestamptz default now()
);
create index if not exists product_media_mfr_code_idx on product_media (manufacturer, code, sort);

alter table product_media enable row level security;
-- Public read (the dealer ordering portal fetches these with the anon key, exactly like
-- product_links / product_overrides). Writes are service-role only (no write policy).
drop policy if exists product_media_read on product_media;
create policy product_media_read on product_media for select using (true);
