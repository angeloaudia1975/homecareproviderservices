-- ============================================================================
-- Zoho two-way sync — stores the Zoho Deal id on each opportunity so pushes update the
-- same deal (not duplicate) and pulls can match a Zoho stage change back to our pipeline.
-- Last-sync timestamps live in app_settings key 'zoho_sync'. Run once. Safe to re-run.
-- ============================================================================
alter table opportunities add column if not exists zoho_id text;
create index if not exists opportunities_zoho_idx on opportunities(zoho_id);
