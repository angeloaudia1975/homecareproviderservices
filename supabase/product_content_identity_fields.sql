-- HCPS Partner 360 — product identity provenance fields
-- Keeps each manufacturer's OWN structure separate from HCPS merchandising, so Partner 360 is never
-- forced to copy a manufacturer's internal taxonomy. Ovation tells us what a product IS; HCPS decides
-- where a dealer shops for it.
--
--   source_category  — the manufacturer's own category path, e.g. "Lower Extremity > Foot & Ankle"
--   source_url       — the manufacturer's canonical (B2B) product page for this product
--   aliases          — alternate / retail names to match in search (e.g. "Short Air" → the canonical
--                      "Gen 2® Walking Boot – Short Pneumatic"), stored as a JSON array of strings
--
-- Safe to run more than once. Shared Supabase project.

alter table public.product_content add column if not exists source_category text;
alter table public.product_content add column if not exists source_url      text;
alter table public.product_content add column if not exists aliases         jsonb default '[]'::jsonb;
