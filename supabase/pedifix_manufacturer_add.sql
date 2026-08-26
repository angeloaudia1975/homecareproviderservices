-- ============================================================================
-- PediFix — register the manufacturer row so commission imports can be committed.
--
-- The Import Commissions picker already lists PediFix (it reads manufacturers.json),
-- but writing monthly_sales rows needs a matching row in the manufacturers table or
-- the foreign key rejects them:
--   monthly_sales_manufacturer_fkey — Key (manufacturer)=(pedifix) is not present.
--
-- Slug 'pedifix' matches the website manufacturer id. Idempotent — safe to re-run.
-- Run once in the Supabase SQL editor BEFORE committing the PediFix import.
-- ============================================================================
insert into manufacturers (slug, name, active)
values ('pedifix', 'PediFix', true)
on conflict (slug) do update set name = excluded.name, active = true;

-- Verify (optional): select slug, name, active from manufacturers where slug='pedifix';
