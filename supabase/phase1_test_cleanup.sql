-- Phase 1 live-validation cleanup — removes ONLY the Phase 1 test artifacts on the TEST sandbox
-- dealer (TEST — Golden Sandbox, 3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b), plus the one stray visit
-- created against a dealer id that does not exist. Production dealers are never touched: the
-- guards below stop the whole script if any listed row is on a real dealer.
--
-- Run it AFTER the Greg/Lori checklist (that checklist uses task 4fa5c265…, opportunity
-- cd84e191… and visit cd7801be…, which this script removes).
-- The five Phase 0 visits on the sandbox (cfb6f81c, 1034544f, 71946204, 20d9aec7, e269079e) and
-- the "Phase 0 test route (sandbox)" are NOT Phase 1 artifacts and are left alone.
--
-- STEP 1 (read-only, optional): what STEP 2 will remove. Run this alone first to see the counts.
with v(id) as (values
  ('cd7801be-cf5d-4682-9db4-0a977ba461c1'::uuid),('f367c40b-bc7c-46e1-b72a-00368438b385'),('83c70734-4679-426f-90f4-118936d697cc'),
  ('5323ffcf-ecaf-4231-b981-d540f68303aa'),('f463ac6c-9481-478e-921c-8d113bc365c4'),('9d1dac08-a4b9-4ccc-9dd3-a33836b2dc79'),
  ('343c0db6-614a-421d-a573-46a853284673'),('5302d029-7cef-47e2-a6e0-f96993982362'),('4b4ee5be-9980-4f1b-bb85-c2057e591ecb'),
  ('2df5920d-0f91-4c47-a143-395dde3bb282'))
select 'visits' as what, count(*) from dealer_visit_reports where id in (select id from v)
union all select 'attendees', count(*) from dealer_visit_participants where visit_report_id in (select id from v)
union all select 'visit log rows', count(*) from dealer_visits where visit_report_id in (select id from v)
union all select 'tasks', count(*) from dealer_tasks where origin_type = 'visit_report' and origin_id in (select id::text from v)
union all select 'opportunities', count(*) from opportunities where origin_type = 'visit_report' and origin_id in (select id::text from v)
union all select 'timeline rows', count(*) from dealer_activity where ref_type = 'visit_report' and ref_id in (select id::text from v)
union all select 'interest signals', count(*) from intent_events where meta->>'visit_report_id' in (select id::text from v)
union all select 'visit notes', count(*) from dealer_notes where id in (select visit_note_id from dealer_visit_reports where id in (select id from v))
union all select 'routes', count(*) from rep_routes where id in ('d9f557cb-09b4-41a3-ac54-98c69e696608','e5db8b32-231e-4b63-9467-20ff965f94e0','bd585a3a-34cd-4cfa-aeb9-b2f9557e0efe','de85c72d-4f5e-48e6-b25f-d9ace55d2971')
union all select 'contact (Dana Price)', count(*) from dealer_contacts where id = 'b8850abf-fc10-4866-bd7a-8e924661bd84';

-- STEP 2: the cleanup. One transaction: either everything below is removed, or nothing is.
begin;

create temp table p1_visits (id uuid primary key, label text) on commit drop;
insert into p1_visits values
  ('cd7801be-cf5d-4682-9db4-0a977ba461c1', 'route R1 — online visit (Dana Price, unsent email draft)'),
  ('f367c40b-bc7c-46e1-b72a-00368438b385', 'route R2 — offline visit'),
  ('83c70734-4679-426f-90f4-118936d697cc', 'route R3 — AI retry + one attendee'),
  ('5323ffcf-ecaf-4231-b981-d540f68303aa', 'route R4 — offline + several attendees'),
  ('f463ac6c-9481-478e-921c-8d113bc365c4', 'off-route test visit'),
  ('9d1dac08-a4b9-4ccc-9dd3-a33836b2dc79', 'off-route test visit'),
  ('343c0db6-614a-421d-a573-46a853284673', 'off-route test visit'),
  ('5302d029-7cef-47e2-a6e0-f96993982362', 'off-route AI corpus host'),
  ('4b4ee5be-9980-4f1b-bb85-c2057e591ecb', 'off-route previous-day email-date visit'),
  ('2df5920d-0f91-4c47-a143-395dde3bb282', 'stray visit on a dealer id that does not exist');

create temp table p1_routes (id uuid primary key) on commit drop;
insert into p1_routes values
  ('d9f557cb-09b4-41a3-ac54-98c69e696608'),   -- TEST — Phase 1 live check (online visit)
  ('e5db8b32-231e-4b63-9467-20ff965f94e0'),   -- TEST — Phase 1 live check (offline visit)
  ('bd585a3a-34cd-4cfa-aeb9-b2f9557e0efe'),   -- TEST — Phase 1 live check (AI retry + one attendee)
  ('de85c72d-4f5e-48e6-b25f-d9ace55d2971');   -- TEST — Phase 1 live check (offline + several attendees)

-- Guards: stop if anything listed is not what it should be.
do $$
begin
  if not exists (select 1 from dealers where id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' and is_test is true) then
    raise exception 'The sandbox dealer is not marked TEST — nothing removed.';
  end if;
  if exists (select 1 from dealer_visit_reports r join p1_visits v on v.id = r.id
             where r.dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b'
               and exists (select 1 from dealers d where d.id = r.dealer_id)) then
    raise exception 'A listed visit belongs to a real dealer — nothing removed.';
  end if;
  if exists (select 1 from rep_routes r join p1_routes p on p.id = r.id where r.name not like 'TEST — Phase 1 live check%') then
    raise exception 'A listed route is not a "TEST — Phase 1 live check" route — nothing removed.';
  end if;
  if exists (select 1 from dealer_contacts where id = 'b8850abf-fc10-4866-bd7a-8e924661bd84'
             and (dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b' or name <> 'Dana Price')) then
    raise exception 'The Dana Price contact is not the sandbox test contact — nothing removed.';
  end if;
end $$;

-- The Dealer 360 notes these visits wrote (kept aside before the visits go).
create temp table p1_notes on commit drop as
  select visit_note_id as id from dealer_visit_reports where id in (select id from p1_visits) and visit_note_id is not null;

delete from dealer_visit_participants where visit_report_id in (select id from p1_visits);
delete from dealer_visits             where visit_report_id in (select id from p1_visits);
delete from dealer_tasks              where origin_type = 'visit_report' and origin_id in (select id::text from p1_visits);
delete from opportunities             where origin_type = 'visit_report' and origin_id in (select id::text from p1_visits);
delete from dealer_activity           where ref_type = 'visit_report' and ref_id in (select id::text from p1_visits);
delete from intent_events             where meta->>'visit_report_id' in (select id::text from p1_visits);
delete from dealer_visit_reports      where id in (select id from p1_visits);
delete from dealer_notes              where id in (select id from p1_notes);
delete from rep_routes                where id in (select id from p1_routes);
delete from dealer_contacts           where id = 'b8850abf-fc10-4866-bd7a-8e924661bd84';

commit;
