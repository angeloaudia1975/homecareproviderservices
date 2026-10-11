-- =============================================================================================
-- HCPS Academy — Phase A2A migration M1: AUDITED OPERATIONS     supabase/academy_a2a_m1_audited_ops.sql
-- STATUS: proposed with A2A for review. Run ONLY after Angelo approves this exact file (same gate as A1:
-- preflight, review, approval, SQL editor Run button with the committed file pasted verbatim, sha256 checked).
-- Rollback: supabase/academy_a2a_m1_rollback.sql. Tests: supabase/academy_a2a_m1_acceptance_tests.sql
-- (and test/academy-a2a.pg.test.js locally).
--
-- WHY (Angelo, 10 Oct 2026 18:45): for security-sensitive operations "the database change and audit record must
-- succeed together or the operation must fail". A function called through the API runs as ONE transaction, so
-- each operation below makes its change AND writes its academy_events row together: if either fails, neither
-- is kept. Guard triggers then refuse the same changes made any other way (a plain API write, a code bug, a
-- hand-written statement), so the audited operation is the only road.
--
-- Operations (all: service_role only; RLS-bypassing server code calls them; never callable with the public key):
--   academy_op_set_training_manager   grant / revoke the Training Manager role
--   academy_op_review_external_cert   verify (with evidence) or reject (with a note) a Golden-issued credential
--   academy_op_issue_certificate      issue an HCPS certificate from a passed attempt (never from a TEST course)
--   academy_op_revoke_certificate     revoke an HCPS certificate (reason required)
--   academy_op_publish_version        publish a course version (checklist enforced; facts pinned)
--   academy_op_retire_version         retire a published course version (reason required)
--   academy_op_submit_attempt         submit + grade an exam attempt IN the database (answer keys never leave it)
--   academy_op_correct_attempt        an admin correction of an exam result (reason required)
--   academy_op_record_fact            add a product fact, or supersede the current one (approval-required
--                                     fields need an approver)
--   academy_op_withdraw_fact          withdraw a disputed or unsafe fact with NO replacement value: the current
--                                     row is closed and replaced by a "awaiting_manufacturer" row whose value is
--                                     JSON null, so lessons flag it and scored exams exclude it (decision D2)
--
-- Guarded tables (changes refused unless made by one of the operations above):
--   academy_memberships     role changes (and inserting a Training Manager)
--   academy_external_certs  any move into, out of or within verified / rejected, and the evidence fields
--   academy_certificates    every insert, update and delete
--   academy_course_versions publishing and retiring
--   academy_attempts        submitting, grading, changing results, deleting
--   product_facts           every insert and update (deletes were already refused in A1)
--
-- Changes NOTHING outside the Academy: no existing HCPS table, grant, policy, function or row. Adds 14 functions
-- (10 operations, 4 internal helpers) + 1 guard function and 6 guard triggers. Every UPDATE / DELETE carries a
-- WHERE clause (Supabase API sessions load pg-safeupdate). Runs as ONE transaction.
-- =============================================================================================
begin;

do $$
begin
  if to_regclass('public.academy_events') is null or to_regclass('public.product_facts') is null then
    raise exception 'Phase A1 is not installed. Stop and investigate.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')) then
    raise exception 'M1 audited operations already exist. Stop and investigate; do not re-run.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INTERNAL HELPERS
-- ---------------------------------------------------------------------------------------------
-- Marks this transaction as running an audited operation. A transaction-local setting: it ends with the
-- transaction, and the API cannot set it (PostgREST only sets request.* settings).
create function public.academy_op_begin(p_op text, p_actor text) returns void
language plpgsql set search_path = public as $$
begin
  if p_actor is null or length(trim(p_actor)) = 0 then
    raise exception 'academy: an operation needs the acting person' using errcode = '22023';
  end if;
  perform set_config('academy.op', p_op, true);
end $$;

create function public.academy_op_end() returns void
language plpgsql set search_path = public as $$
begin
  perform set_config('academy.op', '', true);
end $$;

-- The audit row. Part of the same transaction as the change: if it fails, the whole operation fails.
create function public.academy_op_audit(p_actor_type text, p_actor text, p_entity text, p_entity_id text,
                                        p_action text, p_before jsonb, p_after jsonb) returns void
language plpgsql set search_path = public as $$
begin
  insert into academy_events (actor_type, actor, entity, entity_id, action, before, after)
  values (p_actor_type, p_actor, p_entity, p_entity_id, p_action, p_before, p_after);
end $$;

-- ---------------------------------------------------------------------------------------------
-- GUARD: the audited operation is the only road for sensitive changes
-- ---------------------------------------------------------------------------------------------
create function public.academy_audited_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  v_op text := coalesce(current_setting('academy.op', true), '');
  v_bad boolean := false;
begin
  if v_op <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'academy_memberships' then
    v_bad := (tg_op = 'INSERT' and new.role = 'training_manager')
          or (tg_op = 'UPDATE' and new.role is distinct from old.role);
  elsif tg_table_name = 'academy_external_certs' then
    if tg_op = 'INSERT' then
      v_bad := new.status in ('verified','rejected') or new.verified_by is not null or new.verified_at is not null;
    elsif tg_op = 'UPDATE' then
      v_bad := old.status in ('verified','rejected') or new.status in ('verified','rejected')
            or row(new.verified_by, new.verified_at, new.evidence_type, new.evidence_ref)
               is distinct from row(old.verified_by, old.verified_at, old.evidence_type, old.evidence_ref);
    else
      v_bad := old.status in ('verified','rejected');
    end if;
  elsif tg_table_name = 'academy_certificates' then
    v_bad := true;
  elsif tg_table_name = 'academy_course_versions' then
    v_bad := (tg_op = 'INSERT' and new.status in ('published','retired'))
          or (tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('published','retired'));
  elsif tg_table_name = 'academy_attempts' then
    if tg_op = 'INSERT' then
      v_bad := new.answers is not null or new.submitted_at is not null or new.score is not null
            or new.passed is not null or new.graded_at is not null;
    elsif tg_op = 'UPDATE' then
      v_bad := row(new.answers, new.submitted_at, new.score, new.passed, new.graded_at, new.question_ids, new.enrollment_id)
               is distinct from row(old.answers, old.submitted_at, old.score, old.passed, old.graded_at, old.question_ids, old.enrollment_id);
    else
      v_bad := true;
    end if;
  elsif tg_table_name = 'product_facts' then
    v_bad := tg_op in ('INSERT','UPDATE');
  end if;
  if v_bad then
    raise exception 'academy: this change to % must go through its audited operation', tg_table_name
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger academy_audited_guard before insert or update on public.academy_memberships
  for each row execute function public.academy_audited_guard();
create trigger academy_audited_guard before insert or update or delete on public.academy_external_certs
  for each row execute function public.academy_audited_guard();
create trigger academy_audited_guard before insert or update or delete on public.academy_certificates
  for each row execute function public.academy_audited_guard();
create trigger academy_audited_guard before insert or update on public.academy_course_versions
  for each row execute function public.academy_audited_guard();
create trigger academy_audited_guard before insert or update or delete on public.academy_attempts
  for each row execute function public.academy_audited_guard();
create trigger academy_audited_guard before insert or update on public.product_facts
  for each row execute function public.academy_audited_guard();

-- ---------------------------------------------------------------------------------------------
-- 1. Training Manager role
-- ---------------------------------------------------------------------------------------------
create function public.academy_op_set_training_manager(p_actor text, p_membership_id uuid, p_make boolean, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old academy_memberships; v_new jsonb;
begin
  perform academy_op_begin('set_training_manager', p_actor);
  select * into v_old from academy_memberships where id = p_membership_id for update;
  if not found then raise exception 'academy: membership not found' using errcode = 'P0002'; end if;
  if v_old.status <> 'active' then raise exception 'academy: the membership is not active' using errcode = '22023'; end if;
  update academy_memberships set role = case when p_make then 'training_manager' else 'learner' end
   where id = p_membership_id returning to_jsonb(academy_memberships.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_memberships', p_membership_id::text,
    case when p_make then 'grant_training_manager' else 'revoke_training_manager' end,
    to_jsonb(v_old), v_new || jsonb_build_object('reason', p_reason));
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Golden-issued credential review
-- ---------------------------------------------------------------------------------------------
create function public.academy_op_review_external_cert(p_actor text, p_id uuid, p_decision text,
  p_evidence_type text, p_evidence_ref text, p_note text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old academy_external_certs; v_new jsonb;
begin
  perform academy_op_begin('review_external_cert', p_actor);
  if p_decision not in ('verified','rejected') then
    raise exception 'academy: the decision must be verified or rejected' using errcode = '22023';
  end if;
  if p_decision = 'rejected' and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'academy: a rejection needs a note' using errcode = '22023';
  end if;
  select * into v_old from academy_external_certs where id = p_id for update;
  if not found then raise exception 'academy: credential not found' using errcode = 'P0002'; end if;
  if p_decision = 'verified' then
    update academy_external_certs
       set status = 'verified', verified_by = p_actor, verified_at = now(),
           evidence_type = p_evidence_type, evidence_ref = p_evidence_ref, note = coalesce(p_note, note)
     where id = p_id returning to_jsonb(academy_external_certs.*) into v_new;   -- the A1 check refuses it without evidence
  else
    update academy_external_certs set status = 'rejected', note = p_note
     where id = p_id returning to_jsonb(academy_external_certs.*) into v_new;
  end if;
  perform academy_op_audit('staff', p_actor, 'academy_external_certs', p_id::text,
    'external_cert_' || p_decision, to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. HCPS certificates
-- ---------------------------------------------------------------------------------------------
create function public.academy_op_issue_certificate(p_actor_type text, p_actor text, p_attempt_id uuid, p_dealer_name text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_att academy_attempts; v_enr academy_enrollments; v_ver academy_course_versions; v_course academy_courses;
  v_learner academy_learners; v_months int; v_num text; v_bytes bytea; v_new jsonb; i int;
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  perform academy_op_begin('issue_certificate', p_actor);
  select * into v_att from academy_attempts where id = p_attempt_id for update;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  if v_att.passed is not true then raise exception 'academy: only a passed attempt earns a certificate' using errcode = '22023'; end if;
  select * into v_enr from academy_enrollments where id = v_att.enrollment_id;
  select * into v_ver from academy_course_versions where id = v_enr.version_id;
  select * into v_course from academy_courses where id = v_ver.course_id;
  select * into v_learner from academy_learners where id = v_enr.learner_id;
  if v_course.course_type <> 'hcps_certification' or v_course.issuer <> 'hcps' then
    raise exception 'academy: only an HCPS certification course issues HCPS certificates' using errcode = '22023';
  end if;
  if v_course.slug like 'test-%' then
    raise exception 'academy: a TEST course never issues a certificate' using errcode = '22023';
  end if;
  if v_learner.status <> 'active' then raise exception 'academy: the learner is not active' using errcode = '22023'; end if;
  v_months := coalesce(v_ver.validity_months,
    (select (value->>'hcps_cert_validity_months')::int from app_settings where key = 'academy'), 12);
  for attempt_no in 1..5 loop
    v_bytes := uuid_send(gen_random_uuid()); v_num := 'HCPS-';
    foreach i in array array[0,1,2,3,4,5,10,11] loop
      v_num := v_num || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
      if length(v_num) = 9 then v_num := v_num || '-'; end if;
    end loop;
    exit when not exists (select 1 from academy_certificates where cert_number = v_num);
  end loop;
  insert into academy_certificates (cert_number, learner_id, enrollment_id, version_id, attempt_id, learner_name,
                                    dealer_name, expires_at)
  values (v_num, v_learner.id, v_enr.id, v_ver.id, v_att.id, v_learner.full_name, p_dealer_name,
          now() + make_interval(months => v_months))
  returning to_jsonb(academy_certificates.*) into v_new;
  perform academy_op_audit(p_actor_type, p_actor, 'academy_certificates', v_new->>'id', 'issue_certificate', null, v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_op_revoke_certificate(p_actor text, p_certificate_id uuid, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old academy_certificates; v_new jsonb;
begin
  perform academy_op_begin('revoke_certificate', p_actor);
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'academy: a revocation needs a reason' using errcode = '22023';
  end if;
  select * into v_old from academy_certificates where id = p_certificate_id for update;
  if not found then raise exception 'academy: certificate not found' using errcode = 'P0002'; end if;
  if v_old.status = 'revoked' then raise exception 'academy: the certificate is already revoked' using errcode = '22023'; end if;
  update academy_certificates set status = 'revoked', revoked_at = now(), revoked_by = p_actor, revoked_reason = p_reason
   where id = p_certificate_id returning to_jsonb(academy_certificates.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_certificates', p_certificate_id::text, 'revoke_certificate',
    to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Publishing and retiring course versions
-- ---------------------------------------------------------------------------------------------
create function public.academy_op_publish_version(p_actor text, p_version_id uuid)
returns jsonb language plpgsql set search_path = public as $$
declare v_old academy_course_versions; v_new jsonb; v_exam int; v_unverified int;
begin
  perform academy_op_begin('publish_version', p_actor);
  select * into v_old from academy_course_versions where id = p_version_id for update;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  if v_old.status not in ('draft','in_review') then
    raise exception 'academy: only a draft or in-review version can be published' using errcode = '22023';
  end if;
  select count(*) into v_exam from academy_questions
   where version_id = p_version_id and use = 'exam' and status = 'active';
  if v_exam < v_old.exam_questions then
    raise exception 'academy: % active exam questions; at least % are needed to publish', v_exam, v_old.exam_questions
      using errcode = '22023';
  end if;
  -- Unverified specifications stay out of scored assessments: every fact an active exam question relies on must be
  -- a current, verified fact.
  select count(*) into v_unverified
    from academy_content_refs r
    join academy_questions q on q.id = r.question_id and q.use = 'exam' and q.status = 'active'
    left join product_facts f on f.manufacturer_slug = r.manufacturer_slug and f.model_code = upper(r.model_code)
                             and f.field = r.field and f.valid_to is null
   where r.version_id = p_version_id and r.field is not null and (f.id is null or f.status <> 'verified');
  if v_unverified > 0 then
    raise exception 'academy: % exam question fact link(s) are not verified; fix or retire those questions first', v_unverified
      using errcode = '22023';
  end if;
  update academy_content_refs r set pinned_fact_id = f.id
    from product_facts f
   where r.version_id = p_version_id and r.pinned_fact_id is null and r.field is not null
     and f.manufacturer_slug = r.manufacturer_slug and f.model_code = upper(r.model_code)
     and f.field = r.field and f.valid_to is null;
  update academy_course_versions set status = 'published', published_at = now(), published_by = p_actor
   where id = p_version_id returning to_jsonb(academy_course_versions.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', p_version_id::text, 'publish_version',
    to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_op_retire_version(p_actor text, p_version_id uuid, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old academy_course_versions; v_new jsonb;
begin
  perform academy_op_begin('retire_version', p_actor);
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'academy: retiring a version needs a reason' using errcode = '22023';
  end if;
  select * into v_old from academy_course_versions where id = p_version_id for update;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  if v_old.status <> 'published' then raise exception 'academy: only a published version can be retired' using errcode = '22023'; end if;
  update academy_course_versions set status = 'retired' where id = p_version_id
   returning to_jsonb(academy_course_versions.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', p_version_id::text, 'retire_version',
    to_jsonb(v_old), v_new || jsonb_build_object('reason', p_reason));
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Exam results: graded inside the database; corrections audited
-- ---------------------------------------------------------------------------------------------
-- One answer, as a sorted text array: "a" -> {a}; ["c","a"] -> {a,c}. Anything else -> null (never correct).
create function public.academy_op_norm_answer(p jsonb) returns text[]
language sql immutable set search_path = public as $$
  select case jsonb_typeof(p)
           when 'string' then array[p #>> '{}']
           when 'array'  then (select coalesce(array_agg(e order by e), '{}') from jsonb_array_elements_text(p) e)
           else null end
$$;

create function public.academy_op_submit_attempt(p_actor text, p_attempt_id uuid, p_answers jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_att academy_attempts; v_pass int; v_total int; v_correct int; v_score int; v_passed boolean;
  v_tags text[]; v_new jsonb;
begin
  perform academy_op_begin('submit_attempt', p_actor);
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'academy: answers must be an object of question id to answer' using errcode = '22023';
  end if;
  select * into v_att from academy_attempts where id = p_attempt_id for update;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  if v_att.submitted_at is not null then raise exception 'academy: this attempt was already submitted' using errcode = '22023'; end if;
  select v.pass_mark into v_pass
    from academy_enrollments e join academy_course_versions v on v.id = e.version_id where e.id = v_att.enrollment_id;
  v_total := cardinality(v_att.question_ids);
  select count(*) filter (where academy_op_norm_answer(p_answers -> q.id::text) = academy_op_norm_answer(q.answer_key)),
         array(select distinct t from academy_questions q2, unnest(q2.objective_tags) t
                where q2.id = any(v_att.question_ids)
                  and academy_op_norm_answer(p_answers -> q2.id::text) is distinct from academy_op_norm_answer(q2.answer_key)
                order by t)
    into v_correct, v_tags
    from academy_questions q where q.id = any(v_att.question_ids);
  v_score := floor(v_correct * 100.0 / v_total);
  v_passed := v_correct * 100 >= v_pass * v_total;     -- from the exact fraction, never a rounded score
  update academy_attempts
     set answers = p_answers, submitted_at = now(), score = v_score, passed = v_passed, graded_at = now()
   where id = p_attempt_id returning to_jsonb(academy_attempts.*) into v_new;
  perform academy_op_audit('learner', p_actor, 'academy_attempts', p_attempt_id::text, 'submit_attempt', null,
    jsonb_build_object('score', v_score, 'passed', v_passed, 'correct', v_correct, 'total', v_total));
  perform academy_op_end();
  -- Only what the learner may see: score, pass/fail, topics to study. Never the key, never which question.
  return jsonb_build_object('score', v_score, 'passed', v_passed, 'study_topics', to_jsonb(v_tags));
end $$;

create function public.academy_op_correct_attempt(p_actor text, p_attempt_id uuid, p_score int, p_passed boolean, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old academy_attempts; v_new jsonb;
begin
  perform academy_op_begin('correct_attempt', p_actor);
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'academy: correcting an exam result needs a reason' using errcode = '22023';
  end if;
  select * into v_old from academy_attempts where id = p_attempt_id for update;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  if v_old.graded_at is null then raise exception 'academy: only a graded attempt can be corrected' using errcode = '22023'; end if;
  update academy_attempts set score = p_score, passed = p_passed where id = p_attempt_id
   returning to_jsonb(academy_attempts.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_attempts', p_attempt_id::text, 'correct_attempt',
    jsonb_build_object('score', v_old.score, 'passed', v_old.passed),
    jsonb_build_object('score', p_score, 'passed', p_passed, 'reason', p_reason));
  perform academy_op_end();
  return jsonb_build_object('score', p_score, 'passed', p_passed);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Product facts
-- ---------------------------------------------------------------------------------------------
create function public.academy_op_record_fact(p_actor text, p_fact jsonb, p_supersedes uuid, p_approved_by text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old product_facts; v_id uuid := gen_random_uuid(); v_new jsonb;
begin
  perform academy_op_begin('record_fact', p_actor);
  if p_fact->>'field_class' = 'approval_required' and (p_approved_by is null or length(trim(p_approved_by)) = 0) then
    raise exception 'academy: this fact needs an approver' using errcode = '22023';
  end if;
  if p_supersedes is not null then
    select * into v_old from product_facts where id = p_supersedes for update;
    if not found then raise exception 'academy: the fact to supersede was not found' using errcode = 'P0002'; end if;
    if v_old.valid_to is not null then raise exception 'academy: that fact was already replaced' using errcode = '22023'; end if;
    if v_old.manufacturer_slug <> p_fact->>'manufacturer_slug' or v_old.model_code <> p_fact->>'model_code'
       or v_old.field <> p_fact->>'field' then
      raise exception 'academy: a fact can only be superseded by the same manufacturer, model and field' using errcode = '22023';
    end if;
    update product_facts set valid_to = now(), replaced_by = v_id where id = p_supersedes;
  end if;
  insert into product_facts (id, manufacturer_slug, model_code, field, value, unit, field_class, status, source_url,
                             source_label, verified_on, verified_by, note, content_page_key)
  values (v_id, p_fact->>'manufacturer_slug', p_fact->>'model_code', p_fact->>'field', p_fact->'value',
          p_fact->>'unit', p_fact->>'field_class', p_fact->>'status', p_fact->>'source_url', p_fact->>'source_label',
          (p_fact->>'verified_on')::date, p_fact->>'verified_by', p_fact->>'note', p_fact->>'content_page_key')
  returning to_jsonb(product_facts.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'product_facts', v_id::text,
    case when p_supersedes is null then 'record_fact' else 'supersede_fact' end,
    case when p_supersedes is null then null else to_jsonb(v_old) end,
    v_new || jsonb_build_object('approved_by', p_approved_by));
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_op_withdraw_fact(p_actor text, p_fact_id uuid, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare v_old product_facts; v_id uuid := gen_random_uuid(); v_new jsonb;
begin
  perform academy_op_begin('withdraw_fact', p_actor);
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'academy: withdrawing a fact needs a reason' using errcode = '22023';
  end if;
  select * into v_old from product_facts where id = p_fact_id for update;
  if not found then raise exception 'academy: fact not found' using errcode = 'P0002'; end if;
  if v_old.valid_to is not null then raise exception 'academy: that fact was already replaced' using errcode = '22023'; end if;
  update product_facts set valid_to = now(), replaced_by = v_id where id = p_fact_id;
  insert into product_facts (id, manufacturer_slug, model_code, field, value, unit, field_class, status, source_url,
                             source_label, verified_on, verified_by, note, content_page_key)
  values (v_id, v_old.manufacturer_slug, v_old.model_code, v_old.field, 'null'::jsonb, v_old.unit, v_old.field_class,
          'awaiting_manufacturer', v_old.source_url, v_old.source_label, current_date, p_actor,
          'Withdrawn: ' || p_reason, v_old.content_page_key)
  returning to_jsonb(product_facts.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'product_facts', v_id::text, 'withdraw_fact', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES: server role only (rule 19). Nothing here is callable with the public key.
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;
