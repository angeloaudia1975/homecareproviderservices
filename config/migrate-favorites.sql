-- HCPS Connect 360 — per-user dashboard favorites.
--
-- Each person pins the tools they actually use. Stored on their own staff record
-- rather than a new table: it is a short list belonging to exactly one user, read on
-- every page load with the profile they already fetch, and it disappears with the
-- account when that account is removed.
--
-- Shape: ["/admin/dealer.html", "/admin/call-list.html", ...] — hrefs from the HUBS
-- navigation, in the order the user arranged them.
--
-- Safe to run more than once.

alter table if exists public.staff_users add column if not exists favorites jsonb;

comment on column public.staff_users.favorites is
  'This user''s pinned Connect 360 tools, as an ordered array of /admin/*.html hrefs. Personal — never shared or defaulted from another user.';
