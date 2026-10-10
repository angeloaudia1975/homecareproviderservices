-- ============================================================================
-- HCPS Phase 2F-5 — Deal conflict protection (ROLLBACK)
-- ORDER: FIRST redeploy the 2F-4 code (Netlify: publish the deploy of commit 58bfbe0), THEN run this.
-- It removes only what 2F-5 added: the two tables (with every baseline and conflict record in them) and the two
-- added columns (opportunities.zoho_stage, zoho_sync_queue.outcome). No deal, stage, amount or close date is
-- changed. Inbound Deal events that 2F-5 processed keep their status ('synced' / 'conflict'); the 2F-4 code
-- never reprocesses them.
-- ============================================================================
begin;
drop table if exists public.zoho_deal_conflicts;
drop table if exists public.zoho_deal_baseline;
alter table public.opportunities drop column if exists zoho_stage;
alter table public.zoho_sync_queue drop column if exists outcome;
commit;
notify pgrst, 'reload schema';
