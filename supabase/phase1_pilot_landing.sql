-- Command Center landing pilot + My Sales Workspace live test (2026-10-03)
--
-- 1) THE PILOT. Greg Campbell (rep) and Lori Hunt (relations) land on the Command Center when they
--    sign in. Nobody else moves: an unlisted rep stays on Portal Home, a Relations user moves ONLY when
--    her own email is listed, and the President (management) always lands on /admin/ whatever this says.
insert into app_settings (key, value, updated_at)
values ('rep_landing',
        '{"mode":"pilot","url":"/admin/command-center-rep.html","emails":["greg@homecareproviderservices.us","lori@homecareproviderservices.us"]}'::jsonb,
        now())
on conflict (key) do update set value = excluded.value, updated_at = now();

-- 2) FOR THE LIVE ACCEPTANCE TEST ONLY. Puts the TEST sandbox dealer ("TEST — Golden Sandbox") in
--    Angelo's book, so My Sales Workspace can be tested end to end (visit, summary, tasks, deal) without
--    touching a production dealer. Only rep_email changes, only on the is_test dealer; Greg still cannot
--    reach it (it is not his book). Undo with step 3 after the test.
update dealers
   set rep_email = 'angelo@homecareproviderservices.us'
 where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and is_test is true;

-- Check: the setting, and the sandbox owner.
select key, value from app_settings where key = 'rep_landing';
select id, business_name, rep_name, rep_email, is_test from dealers where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b';

-- 3) UNDO step 2 (run after the live test):
-- update dealers set rep_email = null where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and is_test is true;
--
-- To switch the pilot off again:
-- update app_settings set value = '{"mode":"off"}'::jsonb, updated_at = now() where key = 'rep_landing';
