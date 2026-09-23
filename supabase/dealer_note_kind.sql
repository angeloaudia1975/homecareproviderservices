-- Dealer 360 → Notes: an optional type on each note.
--
-- A rep opening a dealer before a call wants to know at a glance whether the last
-- note was a phone call, a visit, a pricing conversation or a problem. This adds the
-- one column that carries that; Dealer 360 colour-codes the list from it.
--
-- Safe to run more than once, and safe to not run at all: crm-api posts notes without
-- the column if it isn't there, and every note written before today keeps reading as
-- a plain "Note". Nothing existing is rewritten.
--
--   Kinds Dealer 360 writes: note | call | visit | email | quote | issue

alter table dealer_notes add column if not exists kind text default 'note';
