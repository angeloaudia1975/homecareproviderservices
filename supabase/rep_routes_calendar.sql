-- Store the Microsoft Graph (Outlook) event IDs for a synced route so re-syncs PATCH the SAME events
-- (reschedules/reorders stay in sync) and removed stops get their events deleted, instead of creating
-- duplicates. Shape: { mailbox, master_id, events: { <dealer_id>: <event_id> }, updated_at }.
-- Written server-side by routes-api route_calendar_sync. Applied 2026-08.
alter table rep_routes add column if not exists calendar jsonb;
