-- ============================================================================
-- Phase 6, one manufacturer at a time — the master record becomes authoritative.
--
-- Until now the storefront read the three legacy layers and used product_skus
-- only to COMPARE, because a single global constant in index.html decided who
-- won and flipping it would have moved all twelve lines at once. Authority is a
-- per-line fact, so it lives here as data: turn it on for Bemis, see nine SKUs
-- behave, and leave the other eleven exactly as they are.
--
-- THREE COLUMNS, and the second two are the safety property.
--
--   record_authoritative  the line's prices come from product_skus.
--   record_resync_at      when catalog-api last mirrored the layers into it.
--   record_resync_error   why the last mirror FAILED, or null if it worked.
--
-- The feed refuses authority whenever record_resync_error is set. That is what
-- makes this safe to leave switched on: if the mirror ever breaks, the line
-- drops back to the layers by itself rather than serving a price that stopped
-- being updated. A stale record is worse than an old architecture, because
-- nothing about the storefront looks wrong while it happens.
--
-- Purely additive. Safe & idempotent. Run once in the Supabase SQL editor.
-- ============================================================================

alter table manufacturer_meta
  add column if not exists record_authoritative boolean not null default false;

alter table manufacturer_meta
  add column if not exists record_resync_at timestamptz;

alter table manufacturer_meta
  add column if not exists record_resync_error text;

-- Every line stays on the layers until it is switched on deliberately, one at a
-- time. Nothing below turns anything on — that is done from the admin, so the
-- flip and the verification happen together.
comment on column manufacturer_meta.record_authoritative is
  'Phase 6: the storefront takes this line''s prices from product_skus instead of the legacy layers. Turned on per manufacturer, after its SKUs have been verified.';
comment on column manufacturer_meta.record_resync_error is
  'Last failure from the layers->product_skus mirror. While this is non-null the feed refuses authority and the line falls back to the layers.';

-- ---------------------------------------------------------------------------
-- Verify — expect three new columns, and every line still on the layers
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
     where table_name='manufacturer_meta'
       and column_name in ('record_authoritative','record_resync_at','record_resync_error'))
                                                              as columns_added,   -- expect 3
  (select count(*) from manufacturer_meta
     where record_authoritative)                              as lines_on_record, -- expect 0
  (select count(*) from manufacturer_meta)                    as lines_total;
