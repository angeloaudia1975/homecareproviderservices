-- HCPS Academy — Phase 2 / F2: manufacturer technical-service programs as a structured learning path (issue #32).
-- Golden's two official technical certifications (Lift Chair, Mobility) are taught by a Golden video and examined by
-- Golden's own quiz (Google Forms; perfect score required; unlimited retakes; Golden emails its certificate). In the HCPS
-- Academy a learner now gets a program page: overview + the embedded official video + "Take Golden's official quiz", and
-- self-reported steps HCPS records: watched -> quiz submitted -> Golden certificate uploaded -> HCPS verifies (existing
-- M1 academy_op_review_external_cert). HCPS never copies, hosts or grades Golden's quiz and never issues its certificate.
-- A self-report is never proof: only HCPS's review of Golden's certificate (or another Golden confirmation) makes it
-- "verified" (decision 37, A1 table check). Angelo runs this file himself after review. Runbook: docs/academy/P2_F2_PROGRAMS.md.
--
-- Adds (incremental on A1, M1, M5, M8; nothing existing is changed or dropped):
--   academy_program_details   per manufacturer program: video (YouTube no-cookie embed only), quiz link, manufacturer page,
--                             overview and quiz note. Written only by academy_ext_op_set_program (HCPS administrators), audited.
--   academy_ext_op_set_program(p_actor, p_course_id, p_details)       administrators
--   academy_ext_op_step(p_actor, p_course_id, p_step)                 the learner: 'watched' | 'quiz_submitted'
--   academy_ext_op_certificate(p_actor, p_course_id, p_storage_path, p_kind)
--                             the learner uploads Golden's emailed certificate (needs phase2_flags.academy_external_uploads)
-- Security (RULE 19): RLS on, no policies, nothing for public / anon / authenticated, SELECT only for the server; writes
-- only inside an audited operation (owner rights + marker); operations to the server role only.
begin;

do $$ begin
  if to_regclass('public.academy_external_certs') is null or to_regprocedure('public.academy_op_actor_learner(text,uuid)') is null
     or to_regprocedure('public.academy_purchase_guard()') is null then
    raise exception 'F2 needs A1, M1 and M8 installed first';
  end if;
  if to_regclass('public.academy_program_details') is not null then raise exception 'F2 is already installed'; end if;
end $$;

create table public.academy_program_details (
  course_id              uuid primary key references public.academy_courses(id) on delete restrict,
  video_url              text check (video_url is null or video_url ~ '^https://www\.youtube-nocookie\.com/embed/[A-Za-z0-9_-]{6,20}$'),
  video_title            text check (video_title is null or length(video_title) between 2 and 200),
  quiz_url               text check (quiz_url is null or (quiz_url ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/[^[:space:]<>"]*)?$' and length(quiz_url) <= 500)),
  manufacturer_page_url  text check (manufacturer_page_url is null or (manufacturer_page_url ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/[^[:space:]<>"]*)?$' and length(manufacturer_page_url) <= 500)),
  overview               text check (overview is null or length(overview) <= 1500),
  quiz_note              text check (quiz_note is null or length(quiz_note) <= 600),
  updated_by             text not null,
  updated_at             timestamptz not null default now()
);
comment on table public.academy_program_details is
  'Manufacturer technical program page (video + manufacturer quiz link). The manufacturer teaches, examines and issues; HCPS only links and tracks.';
alter table public.academy_program_details enable row level security;
revoke all on table public.academy_program_details from public, anon, authenticated, service_role;
grant select on table public.academy_program_details to service_role;
create trigger academy_purchase_guard before insert or update or delete on public.academy_program_details
  for each row execute function public.academy_purchase_guard();

-- ---------------------------------------------------------------------------------------------
-- administrators: the program page
-- ---------------------------------------------------------------------------------------------
create function public.academy_ext_op_set_program(p_actor text, p_course_id uuid, p_details jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_c academy_courses; v_old academy_program_details; v_new academy_program_details; k text;
begin
  perform academy_op_actor_staff(p_actor);                          -- an active HCPS administrator (President, admin, owner)
  if p_details is null or jsonb_typeof(p_details) <> 'object' then raise exception 'academy: nothing to save' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_details) loop
    if k not in ('video_url','video_title','quiz_url','manufacturer_page_url','overview','quiz_note') then
      raise exception 'academy: % cannot be set here', k using errcode = '22023';
    end if;
  end loop;
  select * into v_c from academy_courses where id = p_course_id for update;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_c.course_type <> 'manufacturer_program' then raise exception 'academy: only a manufacturer program has a program page' using errcode = '22023'; end if;
  perform academy_op_begin('ext_set_program', p_actor);
  select * into v_old from academy_program_details where course_id = p_course_id for update;
  insert into academy_program_details (course_id, video_url, video_title, quiz_url, manufacturer_page_url, overview, quiz_note, updated_by)
  values (p_course_id, nullif(btrim(p_details->>'video_url'), ''), nullif(btrim(p_details->>'video_title'), ''), nullif(btrim(p_details->>'quiz_url'), ''),
          nullif(btrim(p_details->>'manufacturer_page_url'), ''), nullif(btrim(p_details->>'overview'), ''), nullif(btrim(p_details->>'quiz_note'), ''), p_actor)
  on conflict (course_id) do update set
    video_url = case when p_details ? 'video_url' then excluded.video_url else academy_program_details.video_url end,
    video_title = case when p_details ? 'video_title' then excluded.video_title else academy_program_details.video_title end,
    quiz_url = case when p_details ? 'quiz_url' then excluded.quiz_url else academy_program_details.quiz_url end,
    manufacturer_page_url = case when p_details ? 'manufacturer_page_url' then excluded.manufacturer_page_url else academy_program_details.manufacturer_page_url end,
    overview = case when p_details ? 'overview' then excluded.overview else academy_program_details.overview end,
    quiz_note = case when p_details ? 'quiz_note' then excluded.quiz_note else academy_program_details.quiz_note end,
    updated_by = excluded.updated_by, updated_at = now()
  returning * into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_program_details', p_course_id::text, 'set_program', to_jsonb(v_old), to_jsonb(v_new));
  perform academy_op_end();
  return to_jsonb(v_new);
end $$;

-- the learner's current credential row for a program (the newest that was not rejected), locked
create function public.academy_ext_current(p_learner uuid, p_course uuid) returns academy_external_certs
language sql set search_path = pg_catalog, public, pg_temp as $$
  select * from academy_external_certs where learner_id = p_learner and course_id = p_course and status <> 'rejected'
   order by created_at desc limit 1 for update
$$;

create function public.academy_ext_program(p_course_id uuid) returns academy_courses
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_c academy_courses;
begin
  select * into v_c from academy_courses where id = p_course_id;
  if not found then raise exception 'academy: program not found' using errcode = 'P0002'; end if;
  if v_c.course_type <> 'manufacturer_program' or v_c.status <> 'published' or v_c.slug like 'test-%' then
    raise exception 'academy: this program is not open' using errcode = '22023';
  end if;
  return v_c;
end $$;

-- ---------------------------------------------------------------------------------------------
-- the learner: self-reported steps (recorded as what the learner said, never as a result)
-- ---------------------------------------------------------------------------------------------
create function public.academy_ext_op_step(p_actor text, p_course_id uuid, p_step text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_lid uuid; v_c academy_courses; v_r academy_external_certs; v_new academy_external_certs; v_old jsonb;
begin
  if p_actor is null or p_actor !~ '^learner:[0-9a-f-]{36}$' then raise exception 'academy: sign in first' using errcode = '42501'; end if;
  v_lid := substr(p_actor, 9)::uuid;
  perform academy_op_actor_learner(p_actor, v_lid);                 -- active, not HCPS staff
  if p_step is null or p_step not in ('watched','quiz_submitted') then raise exception 'academy: unknown step' using errcode = '22023'; end if;
  v_c := academy_ext_program(p_course_id);
  perform pg_advisory_xact_lock(hashtext('academy-ext:' || v_lid::text || ':' || p_course_id::text));
  v_r := academy_ext_current(v_lid, p_course_id);
  if v_r.id is not null and v_r.status = 'verified' then
    return jsonb_build_object('ok', true, 'unchanged', true, 'status', v_r.status);           -- already a verified credential
  end if;
  if p_step = 'quiz_submitted' and (v_r.id is null or v_r.training_completed_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'watch_first');
  end if;
  v_old := to_jsonb(v_r);
  perform academy_op_begin('ext_step', p_actor);
  if v_r.id is null then
    insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, training_completed_at)
    values (v_lid, p_course_id, v_c.manufacturer_slug, 'training_completed', now()) returning * into v_new;
  elsif p_step = 'watched' then
    update academy_external_certs set training_completed_at = coalesce(training_completed_at, now()),
           status = case when status in ('training_started','exam_opened') then 'training_completed' else status end
     where id = v_r.id returning * into v_new;
  else
    update academy_external_certs set exam_reported_at = now(),
           status = case when status in ('training_started','training_completed','exam_opened','exam_reported') then 'exam_reported' else status end
     where id = v_r.id returning * into v_new;
  end if;
  perform academy_op_audit('learner', p_actor, 'academy_external_certs', v_new.id::text, 'ext_' || p_step, v_old, to_jsonb(v_new));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'status', v_new.status, 'id', v_new.id);
end $$;

-- the learner uploads the certificate Golden emailed them (private file, HCPS staff review only)
create function public.academy_ext_op_certificate(p_actor text, p_course_id uuid, p_storage_path text, p_kind text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_lid uuid; v_c academy_courses; v_r academy_external_certs; v_new academy_external_certs; v_mid uuid;
begin
  if p_actor is null or p_actor !~ '^learner:[0-9a-f-]{36}$' then raise exception 'academy: sign in first' using errcode = '42501'; end if;
  v_lid := substr(p_actor, 9)::uuid;
  perform academy_op_actor_learner(p_actor, v_lid);
  if (select value->'academy_external_uploads' from app_settings where key = 'phase2_flags') is distinct from 'true'::jsonb then
    raise exception 'academy: certificate uploads are switched off' using errcode = '55000';
  end if;
  if p_kind is null or p_kind not in ('pdf','image') then raise exception 'academy: a PDF or a picture is required' using errcode = '22023'; end if;
  if p_storage_path is null or p_storage_path !~ ('^media/learner-evidence/' || v_lid::text || '-[0-9a-f]{16,64}\.(pdf|jpg|png|webp)$') then
    raise exception 'academy: that file path is not allowed' using errcode = '22023';
  end if;
  v_c := academy_ext_program(p_course_id);
  perform pg_advisory_xact_lock(hashtext('academy-ext:' || v_lid::text || ':' || p_course_id::text));
  v_r := academy_ext_current(v_lid, p_course_id);
  if v_r.id is null or v_r.exam_reported_at is null then return jsonb_build_object('ok', false, 'reason', 'quiz_first'); end if;
  if v_r.status = 'verified' then return jsonb_build_object('ok', true, 'unchanged', true, 'status', v_r.status); end if;
  perform academy_op_begin('ext_certificate', p_actor);
  insert into academy_media (kind, storage_path, rights, manufacturer_slug, permission_ref, alt_text)
  values (p_kind, p_storage_path, 'manufacturer_permitted', v_c.manufacturer_slug,
          'Learner-submitted manufacturer certificate (evidence for HCPS review only; never shown in a lesson)',
          'Certificate submitted by the learner for HCPS review') returning id into v_mid;
  update academy_external_certs set status = 'certificate_uploaded', upload_media_id = v_mid, certificate_uploaded_at = now()
   where id = v_r.id returning * into v_new;
  perform academy_op_audit('learner', p_actor, 'academy_external_certs', v_new.id::text, 'ext_certificate', to_jsonb(v_r), to_jsonb(v_new));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'status', v_new.status, 'id', v_new.id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_ext\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (every row must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'program details private (RLS on, no policies, server reads only)' as check,
       (select c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
               and has_table_privilege('service_role', c.oid, 'select') and not has_table_privilege('service_role', c.oid, 'insert')
               and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
          from pg_class c where c.oid = 'public.academy_program_details'::regclass) as ok
union all
select 'operations: 3 for the server role, none public; helpers callable by nobody',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute')) = 3
   and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_%'
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
   and not has_function_privilege('service_role', 'public.academy_ext_current(uuid,uuid)', 'execute')
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_op\_%'
union all
select 'guard on program details', exists (select 1 from pg_trigger where not tgisinternal and tgname = 'academy_purchase_guard'
          and tgrelid = 'public.academy_program_details'::regclass)
union all
select 'nothing written yet', not exists (select 1 from academy_program_details);

commit;
