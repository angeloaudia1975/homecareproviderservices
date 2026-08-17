-- HCPS — per-rep email signature for the Dealer 360 AI email composer.
--
-- Each staff member (and the President) can set a standardized signature that is appended to the
-- AI-drafted email before it's sent from their Outlook. Plain text (line breaks preserved); the
-- send step renders it to HTML. If a rep hasn't set one, the composer falls back to a simple
-- name + company + email default.
--
-- Safe to run repeatedly.

alter table staff_users add column if not exists email_signature text;
