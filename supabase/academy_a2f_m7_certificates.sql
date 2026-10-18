-- =============================================================================================
-- HCPS Academy — A2F / M7: HCPS certificates — issue after a passed exam, verify, revoke (DEVELOPMENT; NOT run)
--
-- What it adds (prefix academy_cert_; M1's issue / revoke code stays byte-identical and is CALLED from here):
--   * academy_cert_op_claim(actor, attempt)   — the learner's own passed attempt earns the HCPS certificate for that
--     enrollment. The actor must be exactly "learner:<id>" of the attempt's learner (from the verified Academy session),
--     the enrollment not withdrawn and the access (membership) still active. The dealership name printed on the
--     certificate is read here from that membership's dealer, never sent by a caller. Idempotent: an enrollment that
--     already has a certificate returns it (no second one). Everything else (switch academy_certificates exactly true,
--     submitted + graded + passed attempt, valid question set, HCPS certification course, never a TEST course, active
--     non-staff learner, 12-month validity, unique HCPS-XXXX-XXXX number, audit row) is M1's academy_op_issue_certificate.
--   * academy_cert_op_revoke(actor, certificate, reason) — the active HCPS PRESIDENT only (role read from staff_users at
--     the moment of the change), a reason of 5–500 characters; then M1's academy_op_revoke_certificate (audited,
--     before/after). A revoked certificate stays on record and verifies as "revoked".
--   * academy_cert_op_verify(number) — what the public verification page may show: number, holder, dealership, course,
--     issue and expiry dates, status valid / expired / revoked, issuer HCPS. Never an email, a score, a revocation
--     reason or anything about Golden credentials. Reads only.
-- The server role loses EXECUTE on M1's academy_op_issue_certificate and academy_op_revoke_certificate, and INSERT /
-- UPDATE / DELETE / TRUNCATE on academy_certificates (it keeps SELECT), so these are the only ways to issue or revoke. RULE 19: no new table or view. Operations are SECURITY DEFINER with a pinned
-- search path, executable by service_role only; the helper by the owner only.
-- Run order: after M1–M6. Rollback: academy_a2f_m7_certificates_rollback.sql (refused while any certificate exists).
-- =============================================================================================
begin;

do $$ begin
  if to_regprocedure('public.academy_op_issue_certificate(text,uuid,text)') is null
     or to_regprocedure('public.academy_op_revoke_certificate(text,uuid,text)') is null
     or to_regprocedure('public.academy_exam_op_submit(text,uuid,jsonb)') is null then
    raise exception 'M7 needs M1 and M6 installed first';
  end if;
  if to_regprocedure('public.academy_cert_op_claim(text,uuid)') is not null then
    raise exception 'M7 is already installed';
  end if;
  if exists (select 1 from academy_certificates) then
    raise exception 'M7 expects no HCPS certificates yet (found some). Stop and investigate.';
  end if;
end $$;

-- The active HCPS President: "staff:<email>" (M1's shape + active-administrator check), then role = president, read
-- from staff_users now. Owner only.
create function public.academy_cert_president(p_actor text) returns void
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_email text;
begin
  v_email := academy_op_actor_staff(p_actor);
  if not exists (select 1 from staff_users s where lower(s.email) = v_email and coalesce(s.active, true)
                   and lower(coalesce(s.role, '')) = 'president') then
    raise exception 'academy: only the HCPS President may revoke an HCPS certificate' using errcode = '42501';
  end if;
end $$;

-- What a learner (and the printed certificate) sees of one certificate.
create function public.academy_cert_view(c academy_certificates) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('id', c.id, 'cert_number', c.cert_number, 'learner_name', c.learner_name,
    'dealer_name', c.dealer_name, 'enrollment_id', c.enrollment_id, 'version_id', c.version_id,
    'issued_at', c.issued_at, 'expires_at', c.expires_at,
    'status', case when c.status = 'revoked' then 'revoked' when c.expires_at is not null and c.expires_at <= now() then 'expired' else 'valid' end,
    'revoked_at', c.revoked_at,
    'course_title', (select co.title from academy_course_versions v join academy_courses co on co.id = v.course_id where v.id = c.version_id),
    'issuer', 'Home Care Provider Services (HCPS)')
$$;

create function public.academy_cert_op_claim(p_actor text, p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_a academy_attempts; v_e academy_enrollments; v_m academy_memberships; v_c academy_certificates;
        v_dealer text; v_new jsonb;
begin
  select * into v_a from academy_attempts where id = p_attempt_id;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  select * into v_e from academy_enrollments where id = v_a.enrollment_id;
  perform academy_op_actor_learner(p_actor, v_e.learner_id);
  perform pg_advisory_xact_lock(hashtext('academy-cert:' || v_e.id::text));
  select * into v_c from academy_certificates where enrollment_id = v_e.id;
  if found then return jsonb_build_object('ok', true, 'existing', true, 'certificate', academy_cert_view(v_c)); end if;
  if (select value->'academy_certificates' from app_settings where key = 'phase2_flags') is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'switched_off');
  end if;
  if v_a.submitted_at is null or v_a.passed is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_passed');
  end if;
  if v_e.status = 'withdrawn' then raise exception 'academy: the enrollment was withdrawn' using errcode = '22023'; end if;
  select * into v_m from academy_memberships where id = v_e.membership_id and status = 'active';
  if not found then raise exception 'academy: your access for this course has ended' using errcode = '42501'; end if;
  select d.business_name into v_dealer from dealers d where d.id = v_m.dealer_id;
  v_new := academy_op_issue_certificate('system:grader', v_a.id, v_dealer);
  select * into v_c from academy_certificates where id = (v_new->>'id')::uuid;
  return jsonb_build_object('ok', true, 'existing', false, 'certificate', academy_cert_view(v_c));
end $$;

create function public.academy_cert_op_revoke(p_actor text, p_certificate_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_c academy_certificates;
begin
  perform academy_cert_president(p_actor);
  if p_reason is null or length(trim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  perform academy_op_revoke_certificate(p_actor, p_certificate_id, trim(p_reason));
  select * into v_c from academy_certificates where id = p_certificate_id;
  return jsonb_build_object('ok', true, 'certificate', academy_cert_view(v_c));
end $$;

create function public.academy_cert_op_verify(p_number text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_n text := upper(btrim(coalesce(p_number, ''))); v_c academy_certificates; v jsonb;
begin
  if v_n !~ '^HCPS-[A-Z0-9]{4}-[A-Z0-9]{4}$' then return jsonb_build_object('found', false, 'reason', 'format'); end if;
  select * into v_c from academy_certificates where cert_number = v_n;
  if not found then return jsonb_build_object('found', false, 'reason', 'not_found'); end if;
  v := academy_cert_view(v_c);
  return jsonb_build_object('found', true, 'cert_number', v->>'cert_number', 'learner_name', v->>'learner_name',
    'dealer_name', v->>'dealer_name', 'course_title', v->>'course_title', 'issued_at', v->'issued_at',
    'expires_at', v->'expires_at', 'status', v->>'status', 'revoked_at', v->'revoked_at', 'issuer', v->>'issuer');
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_cert\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_cert\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
-- the only ways to issue or revoke an HCPS certificate are the operations above
revoke execute on function public.academy_op_issue_certificate(text, uuid, text) from service_role;
revoke execute on function public.academy_op_revoke_certificate(text, uuid, text) from service_role;
revoke insert, update, delete, truncate on table public.academy_certificates from service_role;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (each must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'M7 functions' as check, count(*) = 5 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'academy\_cert\_%'
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_cert\_op\_%'
union all
select 'server calls the 3 operations and nothing else of M7',
       count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 3
   and count(*) filter (where p.proname not like 'academy\_cert\_op\_%' and has_function_privilege('service_role', p.oid, 'execute')) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_cert\_%'
union all
select 'anon and authenticated call nothing of M7', not bool_or(has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon','authenticated']) r
 where n.nspname = 'public' and p.proname like 'academy\_cert\_%'
union all
select 'server can no longer issue or revoke through M1 directly',
       not has_function_privilege('service_role', 'public.academy_op_issue_certificate(text,uuid,text)', 'execute')
   and not has_function_privilege('service_role', 'public.academy_op_revoke_certificate(text,uuid,text)', 'execute')
union all
select 'server reads but cannot write certificates', has_table_privilege('service_role', 'public.academy_certificates', 'select')
   and not has_table_privilege('service_role', 'public.academy_certificates', 'insert')
   and not has_table_privilege('service_role', 'public.academy_certificates', 'update')
   and not has_table_privilege('service_role', 'public.academy_certificates', 'delete')
union all
select 'no certificates written', not exists (select 1 from academy_certificates);

commit;
