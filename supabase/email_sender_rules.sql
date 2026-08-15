-- ============================================================================
-- Email Sender Rules — lets an admin hide noise from the Unmatched Senders queue.
-- Each row is one rule that hides a sender from the active unmatched list:
--   kind='email'   value=<full address>   → hide that exact sender
--   kind='domain'  value=<domain>         → hide everything from that domain (e.g. a vendor)
--   kind='pattern' value=<substring>      → hide any local-part/domain containing it (e.g. "newsletter")
-- action distinguishes 'ignore' (do-not-show-again) from 'not_important' (soft-hide); both hide the
-- sender from the active queue and both are fully reversible — deleting the row restores the sender.
-- Common automated prefixes (noreply@, notifications@, mailer-daemon…) are hidden automatically in
-- code without a row here, so the queue stays focused on real dealer activity out of the box.
-- Values are stored lowercased; the plain (kind,value) unique index makes upserts idempotent.
-- Run once. Safe to re-run.
-- ============================================================================
create table if not exists email_sender_rules (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('email','domain','pattern')),
  value       text not null,
  action      text not null default 'ignore' check (action in ('ignore','not_important')),
  reason      text,
  created_by  text,
  created_at  timestamptz default now()
);
create unique index if not exists email_sender_rules_uniq on email_sender_rules (kind, value);
create index if not exists email_sender_rules_kind_idx on email_sender_rules (kind);

alter table email_sender_rules enable row level security;
drop policy if exists email_sender_rules_service on email_sender_rules;
create policy email_sender_rules_service on email_sender_rules for all to service_role using (true) with check (true);
