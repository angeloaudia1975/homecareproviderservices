-- ============================================================================
-- Account-number anchor for the audience chain.
-- Dealer Activity → Account Number → Dealer Account → Correct Contacts → Emails.
-- We stamp the dealer's HCPS account number onto each saved audience member so the
-- audience is self-describing by account (not only by dealer_id), which makes the
-- Campaign Studio review UI and any later re-matching account-anchored.
-- Also backfills the cached counts that buildStaticAudience now populates.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
alter table audience_members add column if not exists account_no text;
create index if not exists audience_members_acct_idx on audience_members(account_no);
