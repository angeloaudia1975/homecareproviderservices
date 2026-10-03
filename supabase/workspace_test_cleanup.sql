-- My Sales Workspace live-test cleanup (2026-10-03). Removes ONLY what the live acceptance test created
-- on the TEST sandbox dealer ("TEST — Golden Sandbox", 3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b):
--   route  95accf55-a037-48bf-8242-ca0a16b3bc52  "TEST — Workspace live check"
--   visit  969ad1ae-8f8c-4330-8ede-f0d230c9e319  (attendee Dana Price, 2 follow-up tasks, 1 deal, visit note)
--   task   337d0e68-6f8b-4637-8bef-f7db394b26c6  "TEST — workspace manual task" (completed)
--   deal   ea444fd1-922c-48a2-ad11-54fd5b170699  "TEST — workspace manual deal"
-- Production dealers are never touched: the guards stop the whole script if anything listed is not on
-- the sandbox dealer.

begin;

do $$
begin
  if not exists (select 1 from dealers where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and is_test is true) then
    raise exception 'The sandbox dealer is not marked TEST — nothing removed.';
  end if;
  if exists (select 1 from dealer_visit_reports where id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319' and dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b') then
    raise exception 'The listed visit is not on the sandbox dealer — nothing removed.';
  end if;
  if exists (select 1 from rep_routes where id = '95accf55-a037-48bf-8242-ca0a16b3bc52' and name <> 'TEST — Workspace live check') then
    raise exception 'The listed route is not the workspace test route — nothing removed.';
  end if;
  if exists (select 1 from dealer_tasks where id = '337d0e68-6f8b-4637-8bef-f7db394b26c6' and (dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' or title <> 'TEST — workspace manual task')) then
    raise exception 'The listed task is not the sandbox test task — nothing removed.';
  end if;
  if exists (select 1 from opportunities where id = 'ea444fd1-922c-48a2-ad11-54fd5b170699' and (dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' or title <> 'TEST — workspace manual deal')) then
    raise exception 'The listed deal is not the sandbox test deal — nothing removed.';
  end if;
end $$;

create temp table ws_notes on commit drop as
  select visit_note_id as id from dealer_visit_reports
   where id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319' and visit_note_id is not null;

delete from dealer_visit_participants where visit_report_id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from dealer_visits             where visit_report_id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from dealer_tasks              where origin_type = 'visit_report' and origin_id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from opportunities             where origin_type = 'visit_report' and origin_id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from dealer_activity           where ref_type = 'visit_report' and ref_id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from intent_events             where meta->>'visit_report_id' = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from dealer_visit_reports      where id = '969ad1ae-8f8c-4330-8ede-f0d230c9e319';
delete from dealer_notes              where id in (select id from ws_notes);
delete from rep_routes                where id = '95accf55-a037-48bf-8242-ca0a16b3bc52';
delete from dealer_tasks              where id = '337d0e68-6f8b-4637-8bef-f7db394b26c6';
delete from opportunities             where id = 'ea444fd1-922c-48a2-ad11-54fd5b170699';

-- Put the sandbox back to House (undo the test-only ownership change).
update dealers set rep_email = null
 where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and is_test is true;

commit;
