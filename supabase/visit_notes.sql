-- HCPS — Scheduled Routes visit notes into Dealer 360.
--
-- A completed visit report already produced tasks, opportunities, intent signals and a row in
-- dealer_visits. It never produced a dealer_notes row, and Dealer 360's Notes card reads
-- dealer_notes — so a rep who dictated a full visit report saw nothing on the account.
--
-- This one column is what makes creating that note safe to repeat: routes-api writes the note
-- only when visit_note_id is empty, then stores the id here. Re-saving a completed report, or
-- running the backfill twice, cannot duplicate a note.
--
-- Safe to run more than once.

alter table dealer_visit_reports add column if not exists visit_note_id uuid;

create index if not exists dealer_visit_reports_note_idx
  on dealer_visit_reports (dealer_id) where visit_note_id is null;
