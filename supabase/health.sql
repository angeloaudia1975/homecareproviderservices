-- ============================================================================
-- Dealer Health — extends the dealer_engagement cache (created in engine.sql) with the
-- richer health fields the nightly model now writes: trend, churn urgency, recent/total
-- sales, line count, and the rep. Run once in Supabase after engine.sql. Safe to re-run.
-- After running, open Tasks -> "Run engine now" (or wait for the nightly tick) to populate.
-- ============================================================================
alter table dealer_engagement add column if not exists trend        text;      -- up | flat | down
alter table dealer_engagement add column if not exists churn_score  numeric;   -- 0..100 urgency to intervene
alter table dealer_engagement add column if not exists recent_sales numeric;   -- last 3 months
alter table dealer_engagement add column if not exists total_sales  numeric;   -- all-time (active lines)
alter table dealer_engagement add column if not exists lines        int;       -- distinct manufacturer lines
alter table dealer_engagement add column if not exists rep_name     text;      -- effective rep (for scoping)

create index if not exists dealer_engagement_status_idx on dealer_engagement(status);
create index if not exists dealer_engagement_rep_idx    on dealer_engagement(rep_name);
