-- ============================================================================
-- HCPS Phase 2F-5 — Deal conflict protection + Zoho stage preservation (MIGRATION)
-- Project: hcps-ordering (ycqmztthwldytkzyvmiv). Run ONCE in the Supabase SQL editor BEFORE the 2F-5 code is
-- deployed. Re-running is safe. Nothing existing is changed or removed: one nullable column on opportunities,
-- one nullable column on zoho_sync_queue, two new tables. Rollback: phase2f5_deal_sync_rollback.sql.
--
--  1. opportunities.zoho_stage — Zoho's EXACT stage (e.g. "Value Proposition"), kept beside HCPS's own stage
--     (which stays one of identified / contacted / quoted / won / lost via the existing mapping). Null until the
--     deal is next synchronized. Adding it does not fire the stage-history trigger (that watches stage/status).
--  2. zoho_deal_baseline — the last-synchronized value of each two-way field (stage + exact Zoho stage, amount,
--     close date) per linked deal; a Zoho Deal id appears in it at most once (unique). A field changed on one side is measured against THIS, never against
--     updated_at. A key missing from `base` = no agreed value yet (the field is reviewed, not guessed).
--  3. zoho_deal_conflicts — a conflict (both sides changed), an unmapped Zoho stage, or a field with no agreed
--     value: one OPEN row per deal + field until both sides agree again; then resolved in place (kept).
--  4. zoho_sync_queue.outcome — what processing an inbound Deal event did (applied / no change / conflict …).
-- ============================================================================
begin;

alter table public.opportunities add column if not exists zoho_stage text;

create table if not exists public.zoho_deal_baseline (
  opportunity_id uuid primary key references public.opportunities(id) on delete cascade,
  zoho_id        text not null,
  base           jsonb not null default '{}'::jsonb,
  owned_hash     text,
  drift          text,
  synced_at      timestamptz,
  updated_at     timestamptz not null default now()
);
-- One Zoho Deal id belongs to at most ONE HCPS opportunity (amendment 2026-10-10). (The non-unique index of the
-- first draft is dropped if it was ever created.)
drop index if exists public.zoho_deal_baseline_zoho_idx;
create unique index if not exists zoho_deal_baseline_zoho_uniq on public.zoho_deal_baseline (zoho_id);
alter table public.zoho_deal_baseline enable row level security;

create table if not exists public.zoho_deal_conflicts (
  id             bigint generated always as identity primary key,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  zoho_id        text,
  field          text not null check (field in ('stage','amount','close_date')),
  kind           text not null check (kind in ('both_changed','unmapped_stage','no_baseline')),
  base_value     text,
  hcps_value     text,
  zoho_value     text,
  status         text not null default 'open' check (status in ('open','resolved')),
  detected_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolution     text
);
create unique index if not exists zoho_deal_conflicts_one_open on public.zoho_deal_conflicts (opportunity_id, field) where status = 'open';
create index if not exists zoho_deal_conflicts_status_idx on public.zoho_deal_conflicts (status, detected_at);
alter table public.zoho_deal_conflicts enable row level security;

alter table public.zoho_sync_queue add column if not exists outcome text;

commit;
notify pgrst, 'reload schema';
