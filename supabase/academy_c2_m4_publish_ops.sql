-- =============================================================================================
-- HCPS Academy — C2 / M4: course publication controls (DEVELOPMENT; NOT run in production)
--
-- Rules (Angelo, 11 Oct 2026 + the recommended decisions A–E of the C2 design, approved for development 16 Oct 2026):
--   * Only the President publishes or retires — checked HERE, in the database, not only in the API.        (E: new ops)
--   * A version is published only after it has been submitted for review (in_review), so publishing is
--     always a second look.                                                                                (A)
--   * Publishing a replacement retires the previous published version and publishes the new one in ONE
--     transaction; learners part-way through the old version keep it (enrollments are not touched).       (B)
--   * Retiring never touches certificates; a certificate stays valid until its own expiry.                 (C)
--   * The course record's status follows its versions and is written only by these operations:
--       published  while it has a published version (or, for a manufacturer program, after publish_course)
--       retired    only by retire_course (a President decision with a reason)
--       draft      otherwise.
--   * Every change writes its audit row in the same transaction (the M1 operations write theirs for the
--     version changes; M4 writes one for the course record).
--
-- Design: new functions only. M1 (academy_op_*), M2 (academy_content_op_*), M3 (academy_author_op_*) and M3.1 are
-- left byte-identical — M4 CALLS M1's publish / retire inside its own transaction, so M1's checks (exam size,
-- verified fact links, fact pinning) and M3's publish check trigger still run. The server role loses EXECUTE on M1's
-- publish / retire, so the only way to publish is through the President check below.
--
-- Run order: after M1, M2, M3, M3.1. Rollback: academy_c2_m4_publish_ops_rollback.sql.
-- RULE 19: no new table or view. Every function is SECURITY DEFINER with a pinned search path; the operations are
-- executable by service_role only, the helper by nobody but the owner.
-- =============================================================================================
begin;

do $$ begin
  if to_regprocedure('public.academy_op_publish_version(text,uuid)') is null
     or to_regprocedure('public.academy_content_actor_president(text)') is null
     or to_regprocedure('public.academy_author_publish_check()') is null then
    raise exception 'M4 needs M1, M2 and M3 installed first';
  end if;
  if to_regprocedure('public.academy_publish_op_publish_version(text,uuid,text)') is not null then
    raise exception 'M4 is already installed';
  end if;
end $$;

-- The course record's status, written under the operation marker with its own audit row. Owner only.
create function public.academy_publish_set_course(p_actor text, p_course_id uuid, p_status text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_courses; v_new jsonb;
begin
  select * into v_old from academy_courses where id = p_course_id for update;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_old.status = p_status then return to_jsonb(v_old); end if;
  perform academy_op_begin('set_course_status', p_actor);
  update academy_courses set status = p_status where id = p_course_id
   returning to_jsonb(academy_courses.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_courses', p_course_id::text, 'set_course_status',
    jsonb_build_object('status', v_old.status), jsonb_build_object('status', p_status, 'reason', p_reason));
  perform academy_op_end();
  return v_new;
end $$;

-- PUBLISH a version (President only; the version must be in review). Retires the course's current published version
-- first, in the same transaction, then publishes through M1 and marks the course published.
create function public.academy_publish_op_publish_version(p_actor text, p_version_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_course_versions; v_course academy_courses; v_prev academy_course_versions; v_retired jsonb; v_pub jsonb; v_c jsonb;
begin
  perform academy_content_actor_president(p_actor);
  select * into v from academy_course_versions where id = p_version_id;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  -- lock the course first, then its versions, always in that order (two publishes of one course queue up)
  select * into v_course from academy_courses where id = v.course_id for update;
  if v_course.course_type = 'manufacturer_program' then
    raise exception 'academy: a manufacturer program is published with publish_course, not by version' using errcode = '22023';
  end if;
  if v_course.status = 'retired' then
    raise exception 'academy: this course is retired; it cannot publish a version' using errcode = '22023';
  end if;
  select * into v from academy_course_versions where id = p_version_id for update;
  if v.status <> 'in_review' then
    raise exception 'academy: only a version in review can be published (submit it for review first)' using errcode = '22023';
  end if;
  select * into v_prev from academy_course_versions where course_id = v.course_id and status = 'published' for update;
  if found then
    v_retired := academy_op_retire_version(p_actor, v_prev.id,
      coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Replaced by version ' || v.version));
  end if;
  v_pub := academy_op_publish_version(p_actor, p_version_id);
  v_c := academy_publish_set_course(p_actor, v.course_id, 'published', 'version ' || v.version || ' published');
  return jsonb_build_object('version', v_pub, 'retired', v_retired, 'course', v_c);
end $$;

-- RETIRE the published version of a course without a replacement (President only, reason required). The course goes
-- back to draft (it may publish again later); certificates and enrollments are untouched.
create function public.academy_publish_op_retire_version(p_actor text, p_version_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_course_versions; v_course academy_courses; v_ret jsonb; v_c jsonb;
begin
  perform academy_content_actor_president(p_actor);
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'academy: retiring a version needs a reason' using errcode = '22023';
  end if;
  select * into v from academy_course_versions where id = p_version_id;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  select * into v_course from academy_courses where id = v.course_id for update;
  v_ret := academy_op_retire_version(p_actor, p_version_id, p_reason);
  if v_course.status = 'published' then
    v_c := academy_publish_set_course(p_actor, v.course_id, 'draft', p_reason);
  else
    v_c := to_jsonb(v_course);
  end if;
  return jsonb_build_object('version', v_ret, 'course', v_c);
end $$;

-- RETIRE a whole course (President only, reason required): its published version is retired and the course is
-- marked retired. Nothing is deleted; certificates stay valid until their own expiry.
create function public.academy_publish_op_retire_course(p_actor text, p_course_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_course academy_courses; v_prev academy_course_versions; v_ret jsonb; v_c jsonb;
begin
  perform academy_content_actor_president(p_actor);
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'academy: retiring a course needs a reason' using errcode = '22023';
  end if;
  select * into v_course from academy_courses where id = p_course_id for update;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_course.status = 'retired' then raise exception 'academy: the course is already retired' using errcode = '22023'; end if;
  select * into v_prev from academy_course_versions where course_id = p_course_id and status = 'published' for update;
  if found then v_ret := academy_op_retire_version(p_actor, v_prev.id, p_reason); end if;
  v_c := academy_publish_set_course(p_actor, p_course_id, 'retired', p_reason);
  return jsonb_build_object('course', v_c, 'retired_version', v_ret);
end $$;

-- PUBLISH a manufacturer-hosted program (no HCPS lessons or exam): President only; the manufacturer must be on the
-- HCPS list and the link an https address.
create function public.academy_publish_op_publish_course(p_actor text, p_course_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_course academy_courses;
begin
  perform academy_content_actor_president(p_actor);
  select * into v_course from academy_courses where id = p_course_id for update;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_course.course_type <> 'manufacturer_program' then
    raise exception 'academy: an HCPS course is published by publishing a version' using errcode = '22023';
  end if;
  if v_course.status = 'published' then raise exception 'academy: the program is already published' using errcode = '22023'; end if;
  if v_course.manufacturer_slug is null or not exists (select 1 from manufacturers where slug = v_course.manufacturer_slug) then
    raise exception 'academy: the program needs a manufacturer on the HCPS list' using errcode = '22023';
  end if;
  if v_course.external_url is null or v_course.external_url !~ '^https://[^/[:space:]]+\.[^/[:space:]]+' then
    raise exception 'academy: the program needs an https link' using errcode = '22023';
  end if;
  return jsonb_build_object('course', academy_publish_set_course(p_actor, p_course_id, 'published', 'manufacturer program published'));
end $$;

-- Read-only consistency check for the Command Center's records check: courses whose status disagrees with their
-- versions (HCPS courses: published <=> a published version exists; retired courses have no published version).
create function public.academy_publish_consistency()
returns table (course_id uuid, course_status text, published_versions bigint, problem text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.id, c.status, count(v.id) filter (where v.status = 'published'),
         case when c.course_type <> 'manufacturer_program' and c.status = 'published' and count(v.id) filter (where v.status = 'published') = 0
                then 'marked published but has no published version'
              when c.course_type <> 'manufacturer_program' and c.status <> 'published' and count(v.id) filter (where v.status = 'published') > 0
                then 'has a published version but is marked ' || c.status
         end
    from academy_courses c left join academy_course_versions v on v.course_id = c.id
   group by c.id, c.status, c.course_type
  having (c.course_type <> 'manufacturer_program' and c.status = 'published' and count(v.id) filter (where v.status = 'published') = 0)
      or (c.course_type <> 'manufacturer_program' and c.status <> 'published' and count(v.id) filter (where v.status = 'published') > 0)
$$;

-- Privileges: operations for the server role only; the helper for nobody. M1's publish / retire leave the server role,
-- so the President check above cannot be skipped.
revoke all on function public.academy_publish_set_course(text,uuid,text,text) from public, anon, authenticated, service_role;
revoke all on function public.academy_publish_op_publish_version(text,uuid,text) from public, anon, authenticated;
revoke all on function public.academy_publish_op_retire_version(text,uuid,text) from public, anon, authenticated;
revoke all on function public.academy_publish_op_retire_course(text,uuid,text) from public, anon, authenticated;
revoke all on function public.academy_publish_op_publish_course(text,uuid) from public, anon, authenticated;
revoke all on function public.academy_publish_consistency() from public, anon, authenticated;
grant execute on function public.academy_publish_op_publish_version(text,uuid,text) to service_role;
grant execute on function public.academy_publish_op_retire_version(text,uuid,text) to service_role;
grant execute on function public.academy_publish_op_retire_course(text,uuid,text) to service_role;
grant execute on function public.academy_publish_op_publish_course(text,uuid) to service_role;
grant execute on function public.academy_publish_consistency() to service_role;
revoke execute on function public.academy_op_publish_version(text,uuid) from service_role;
revoke execute on function public.academy_op_retire_version(text,uuid,text) from service_role;

-- Install checks (each must read ok = true)
select 'M4 functions' as check, count(*) = 6 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('academy_publish_set_course','academy_publish_op_publish_version',
   'academy_publish_op_retire_version','academy_publish_op_retire_course','academy_publish_op_publish_course','academy_publish_consistency')
union all
select 'all security definer, pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy_publish_%'
union all
select 'nobody but the server calls the operations', not bool_or(has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon','authenticated']) r
 where n.nspname = 'public' and p.proname like 'academy_publish_%'
union all
select 'server cannot call M1 publish / retire directly',
       not has_function_privilege('service_role', 'public.academy_op_publish_version(text,uuid)', 'execute')
   and not has_function_privilege('service_role', 'public.academy_op_retire_version(text,uuid,text)', 'execute')
union all
select 'courses consistent with their versions', not exists (select 1 from academy_publish_consistency());

commit;
