-- ============================================================================
-- ONE CHECKOUT = ONE ORDER (C3-06, 2026-11-05) — duplicate-order protection for Partner 360.
-- Adds orders.submission_key: the key the storefront sends with a checkout and keeps while the dealer retries the same
-- cart (a timeout after the order was saved, a second tab). orders-api records each manufacturer order at most once
-- per key; a repeat is answered with the order already recorded and no second confirmation is sent.
--
-- Additive only: one nullable column + one partial unique index. Existing orders keep submission_key NULL and are
-- untouched. No policy or grant change: orders keeps its RLS and privileges exactly as they are (RULE 19 — the new
-- column inherits the table's protection; nothing new is exposed).
-- The code works before and after this runs (without the column the key is ignored, as today).
-- Rollback: drop index if exists orders_submission_key_uk; alter table public.orders drop column if exists submission_key;
-- ============================================================================
alter table public.orders add column if not exists submission_key text;

create unique index if not exists orders_submission_key_uk
  on public.orders (dealer_id, manufacturer, submission_key)
  where submission_key is not null;

-- Check: the column, the index, and that no existing order was given a key.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'submission_key')      as column_added,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'orders_submission_key_uk') as index_added,
  (select count(*) from public.orders where submission_key is not null)                              as orders_with_key,
  (select relrowsecurity from pg_class where oid = 'public.orders'::regclass)                          as orders_rls_still_on;
