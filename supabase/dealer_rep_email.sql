-- HCPS Connect 360 — Phase 0C: one authoritative dealer owner.
--
-- Today a dealer's rep is a free-text NAME stored twice — dealers.rep_name and the legacy
-- dealer_directory (keyed by dealer name) — and different parts of the app read different
-- copies. dealers.rep_email becomes the single owner field, keyed to the same email the rep
-- signs in with (staff_users.email). rep_name stays for display.
--
-- STEP 1 is safe to run any time: it adds an empty column and an index, nothing else.
-- STEP 2 fills it in. It is deliberately commented out: run it only after the ownership
-- report (Phase 0 log, section 0C) has been approved.

-- ─── STEP 1 ─────────────────────────────────────────────────────────────────────────────────
alter table public.dealers add column if not exists rep_email text;
create index if not exists dealers_rep_email_idx on public.dealers (lower(rep_email));

-- ─── STEP 2 — AFTER APPROVAL ONLY ───────────────────────────────────────────────────────────
-- 1) Copy the directory's rep onto dealers that have none on the dealer row (12 live), so both
--    sources agree. 2) Fill rep_email from staff_users by rep name. "House (unassigned)" and
--    dealers with no rep resolve to no staff user and stay empty. An owner already set is never
--    overwritten. Tested on a scratch database against all five cases.
--
-- begin;
-- update public.dealers d set rep_name = btrim(dd.rep_name)
-- from public.dealer_directory dd
-- where dd.dealer_name = d.business_name
--   and nullif(btrim(d.rep_name),'') is null and nullif(btrim(dd.rep_name),'') is not null;
-- update public.dealers d set rep_email = lower(s.email)
-- from public.staff_users s
-- where d.rep_email is null
--   and nullif(btrim(d.rep_name),'') is not null
--   and lower(btrim(s.rep_name)) = lower(btrim(d.rep_name));
-- commit;
