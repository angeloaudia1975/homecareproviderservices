-- Unit 2A live-test cleanup (2026-10-03). Removes ONLY what the Unit 2A live acceptance test created on the
-- TEST sandbox dealer ("TEST — Golden Sandbox", 3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b):
--   visit a27ae684-ee03-49e7-aa42-a6bf437fb4a3  (visit_key vk_live2a_a1 — 1 follow-up task, visit note)
--   visit 2de346bf-980e-4608-bd01-ad946e1a884e  (visit_key vk_live2a_c3 — visit note, no follow-ups)
-- No deals and no contacts were created. Production dealers are never touched: the guards stop the whole
-- script if a listed visit is not on the sandbox dealer or does not carry its test key.

begin;

do $$
begin
  if not exists (select 1 from dealers where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and is_test is true) then
    raise exception 'The sandbox dealer is not marked TEST — nothing removed.';
  end if;
  if exists (select 1 from dealer_visit_reports
              where id in ('a27ae684-ee03-49e7-aa42-a6bf437fb4a3','2de346bf-980e-4608-bd01-ad946e1a884e')
                and (dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' or visit_key not like 'vk_live2a_%')) then
    raise exception 'A listed visit is not a 2A test visit on the sandbox dealer — nothing removed.';
  end if;
end $$;

create temp table t2a_visits on commit drop as
  select id, visit_note_id from dealer_visit_reports
   where id in ('a27ae684-ee03-49e7-aa42-a6bf437fb4a3','2de346bf-980e-4608-bd01-ad946e1a884e');

delete from dealer_visit_participants where visit_report_id in (select id from t2a_visits);
delete from dealer_visits             where visit_report_id in (select id from t2a_visits);
delete from dealer_tasks              where origin_type = 'visit_report' and origin_id in ('a27ae684-ee03-49e7-aa42-a6bf437fb4a3','2de346bf-980e-4608-bd01-ad946e1a884e');
delete from opportunities             where origin_type = 'visit_report' and origin_id in ('a27ae684-ee03-49e7-aa42-a6bf437fb4a3','2de346bf-980e-4608-bd01-ad946e1a884e');
delete from dealer_activity           where ref_type = 'visit_report' and ref_id in ('a27ae684-ee03-49e7-aa42-a6bf437fb4a3','2de346bf-980e-4608-bd01-ad946e1a884e');
delete from intent_events             where meta->>'visit_report_id' in ('a27ae684-ee03-49e7-aa42-a6bf437fb4a3','2de346bf-980e-4608-bd01-ad946e1a884e');
delete from dealer_visit_reports      where id in (select id from t2a_visits);
delete from dealer_notes              where id in (select visit_note_id from t2a_visits where visit_note_id is not null);

commit;

-- Check (both should be 0):
select count(*) as test_visits_left from dealer_visit_reports where visit_key like 'vk_live2a_%';
select count(*) as test_tasks_left from dealer_tasks
 where dealer_id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and title = 'Send Golden PR519 brochure to dealer';

-- OPTIONAL — only if you want it gone (not created by this test). The Phase 0 route
-- "Phase 0 test route (sandbox) — safe to delete" (owned by you, one stop: the TEST sandbox) is why the
-- sandbox counts as "a dealer on a route you drive" inside My Sales Workspace. Removing it changes nothing else.
-- delete from rep_routes where name = 'Phase 0 test route (sandbox) — safe to delete'
--    and stops @> '[{"dealer_id":"3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b"}]'::jsonb and jsonb_array_length(stops) = 1;
