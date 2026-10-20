-- HCPS Academy — Phase 2 / F1: FREE LAUNCH access (per-course access policy, free self-enrollment, outside-learner
-- registration, corrected free-network eligibility). Issue #29 (owner decision 20 Oct 2026: launch free, paid later).
-- Incremental on top of M8 (academy_p2_m8_payments.sql, installed 20 Oct 2026). Independent of the parked M9 draft
-- (PR #27): F1 now owns academy_purchase_dealer_eligible, so M9 must drop its own copy of that function before it is
-- ever installed. Angelo runs this file himself after review (CLAUDE.md §7). Runbook: docs/academy/P2_F1_FREE_LAUNCH.md.
--
-- What it adds (no money moves; Stripe stays sandbox-only; nothing here touches prices, purchases or refunds):
--   1. PER-COURSE ACCESS POLICY (academy_course_access: off | free | paid), independent of the price. No row = M8's
--      behaviour (paid only if academy_prices says so). A FREE course can never be bought: a trigger refuses any new
--      checkout row for it on every path. Changed only by the President, with a reason, audited.
--   2. OUTSIDE-LEARNER REGISTRATION (academy_free_op_register): a person outside the HCPS network gets an Academy
--      learner record, an outside organization (M8's academy_organizations — never a CRM dealer) and a learner-only
--      membership. Registration grants NO course: the address is proven by the Academy's own email sign-in code (M5)
--      and only a signed-in learner can enroll. Rate-limited; staff, suspended learners and Partner 360 users are refused.
--   3. FREE SELF-ENROLLMENT (academy_free_op_enroll): a signed-in active learner enrolls in a FREE published course
--      (access_source 'free', distinct from network 'assigned', 'admin_grant' and 'purchase'). Idempotent: a repeat or
--      double click returns the same enrollment. Through the learner's active dealership membership when that
--      dealership is an eligible network dealer, otherwise through their outside organization. TEST courses only for
--      TEST dealerships. Later switching a course to paid never removes a free learner's enrollment, progress or
--      certificate (nothing here or in M8 deletes them).
--   4. ELIGIBILITY FIX (replaces M8's academy_purchase_dealer_eligible): M8 required dealers.status = 'active', but the
--      CRM lifecycle is dealers.active (status is blank for almost every dealer), so M8 treated nearly every real
--      dealer as NOT in the network. Free-network status now = the dealer AND its head office are active
--      (active <> false), not prospect / closed / inactive by status, account class blank or 'dealer'; a branch never
--      inherits it from an active head office; TEST is free only for a dealership that is itself TEST.
-- Security (RULE 19): new tables RLS on, no policies, nothing for public / anon / authenticated, SELECT only for the
-- server; writes only inside an audited operation (M8's academy_purchase_guard). New functions: prefix academy_free_.
begin;

do $$ begin
  if to_regclass('public.academy_purchases') is null or to_regprocedure('public.academy_purchase_dealer_eligible(uuid)') is null then
    raise exception 'F1 needs M8 (academy_p2_m8_payments.sql) installed first';
  end if;
  if to_regclass('public.academy_course_access') is not null then raise exception 'F1 is already installed'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'active') then
    raise exception 'F1 needs dealers.active (the CRM lifecycle flag)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. ELIGIBILITY (replaces the M8 helper; everything that calls it — checkout "included" — keeps working)
-- ---------------------------------------------------------------------------------------------
create or replace function public.academy_purchase_dealer_eligible(p_dealer uuid) returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  with d as (select * from dealers where id = p_dealer),
       head as (select h.* from dealers h, d where h.id = coalesce(d.parent_id, d.id))
  select case
    when not exists (select 1 from d) then false
    when exists (select 1 from academy_dealer_eligibility e where e.dealer_id = p_dealer) then
      (select e.eligible from academy_dealer_eligibility e where e.dealer_id = p_dealer)
    when exists (select 1 from academy_dealer_eligibility e, head where e.dealer_id = head.id) then
      (select e.eligible from academy_dealer_eligibility e, head where e.dealer_id = head.id)
    when (select coalesce(d.is_test, false) from d) then true                     -- a TEST dealership itself (sandbox / pilot)
    when (select coalesce(head.is_test, false) from head) then false              -- never inherited from a TEST head office
    else coalesce((select bool_and(x.active is distinct from false
                                   and lower(btrim(coalesce(x.status, ''))) not in ('prospect','closed','inactive','dormant')
                                   and lower(btrim(coalesce(x.account_class, ''))) in ('', 'dealer'))
                     from (select * from d union all select * from head) x), false)
  end
$$;
revoke all on function public.academy_purchase_dealer_eligible(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- SCHEMA
-- ---------------------------------------------------------------------------------------------
create table public.academy_course_access (
  course_id  uuid primary key references public.academy_courses(id) on delete restrict,
  mode       text not null check (mode in ('off','free','paid')),
  note       text check (note is null or length(note) <= 300),            -- shown publicly next to a free course
  reason     text not null check (length(btrim(reason)) between 5 and 500),
  set_by     text not null,
  set_at     timestamptz not null default now()
);
comment on table public.academy_course_access is
  'Per-course access policy (off / free / paid), independent of the price. Written only by academy_free_op_set_access.';

create table public.academy_free_registrations (
  id               uuid primary key default gen_random_uuid(),
  email            text not null check (email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254),
  full_name        text not null check (length(btrim(full_name)) between 2 and 120),
  company          text not null check (length(btrim(company)) between 2 and 160),
  course_id        uuid references public.academy_courses(id) on delete restrict,
  outcome          text not null check (outcome in ('created','existing')),
  learner_id       uuid references public.academy_learners(id) on delete restrict,
  organization_id  uuid references public.academy_organizations(id) on delete restrict,
  ip_hash          text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now()
);
create index academy_free_registrations_email on public.academy_free_registrations (email, created_at desc);
create index academy_free_registrations_ip on public.academy_free_registrations (ip_hash, created_at desc);

do $$ declare t text; begin
  foreach t in array array['academy_course_access','academy_free_registrations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to service_role', t);
    execute format('create trigger academy_purchase_guard before insert or update or delete on public.%I for each row execute function public.academy_purchase_guard()', t);
  end loop;
end $$;

-- free launch grants are recorded as their own kind
alter table public.academy_enrollments drop constraint academy_enrollments_access_source_check;
alter table public.academy_enrollments add constraint academy_enrollments_access_source_check
  check (access_source in ('assigned','self','admin_grant','purchase','free'));

-- M8's membership guard allowed an outside organization's membership only from a verified purchase; F1 adds the free
-- registration as the one other road (replaces the M8 trigger function; same trigger).
create or replace function public.academy_purchase_member_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.organization_id is not null and (tg_op = 'INSERT' or new.organization_id is distinct from old.organization_id)
     and coalesce(current_setting('academy.op', true), '') not in ('purchase_grant', 'free_register') then
    raise exception 'academy: an outside organization''s access comes only from a verified purchase or a free registration' using errcode = '42501';
  end if;
  return new;
end $$;

-- A FREE (or switched-off) course is never bought: refused on every path that would open a checkout.
create function public.academy_free_no_checkout() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from academy_course_access a where a.course_id = new.course_id and a.mode <> 'paid') then
    raise exception 'academy: this course is not sold' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger academy_free_no_checkout before insert on public.academy_purchases
  for each row execute function public.academy_free_no_checkout();

-- ---------------------------------------------------------------------------------------------
-- 1. ACCESS POLICY (President)
-- ---------------------------------------------------------------------------------------------
create function public.academy_free_op_set_access(p_actor text, p_course_id uuid, p_mode text, p_note text, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_c academy_courses; v_old academy_course_access; v_new academy_course_access;
begin
  perform academy_content_actor_president(p_actor);
  if p_mode not in ('off','free','paid') then raise exception 'academy: choose off, free or paid' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023'; end if;
  if p_note is not null and length(p_note) > 300 then raise exception 'academy: the note is too long' using errcode = '22023'; end if;
  select * into v_c from academy_courses where id = p_course_id;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_c.course_type = 'manufacturer_program' and p_mode <> 'off' then raise exception 'academy: a manufacturer program is not enrolled here' using errcode = '22023'; end if;
  perform academy_op_begin('free_set_access', p_actor);
  select * into v_old from academy_course_access where course_id = p_course_id for update;
  insert into academy_course_access (course_id, mode, note, reason, set_by) values (p_course_id, p_mode, nullif(btrim(coalesce(p_note, '')), ''), btrim(p_reason), p_actor)
  on conflict (course_id) do update set mode = excluded.mode, note = excluded.note, reason = excluded.reason, set_by = excluded.set_by, set_at = now()
  returning * into v_new;
  -- a checkout opened before the course became free is closed (the buyer is not charged; the course is free)
  if p_mode <> 'paid' then
    update academy_purchases set status = 'superseded', updated_at = now() where course_id = p_course_id and status = 'open';
  end if;
  perform academy_op_audit('staff', p_actor, 'academy_course_access', p_course_id::text, 'set_access', to_jsonb(v_old), to_jsonb(v_new));
  perform academy_op_end();
  return to_jsonb(v_new);
end $$;

-- What the public sees: published FREE courses (never a TEST course or a manufacturer program).
create function public.academy_free_op_catalog() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('slug', c.slug, 'title', c.title, 'note', a.note) order by c.title), '[]'::jsonb)
    from academy_courses c join academy_course_access a on a.course_id = c.id and a.mode = 'free'
   where c.status = 'published' and c.slug not like 'test-%' and c.course_type <> 'manufacturer_program'
     and exists (select 1 from academy_course_versions v where v.course_id = c.id and v.status = 'published')
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. OUTSIDE-LEARNER REGISTRATION (public, before sign-in) — never grants a course
-- ---------------------------------------------------------------------------------------------
create function public.academy_free_op_register(p_email text, p_full_name text, p_company text, p_course_slug text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_c academy_courses; v_l academy_learners; v_o academy_organizations;
        v_m academy_memberships; v_outcome text := 'existing';
begin
  if p_ip_hash !~ '^[0-9a-f]{64}$' or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 254
     or length(btrim(coalesce(p_full_name, ''))) not between 2 and 120 or length(btrim(coalesce(p_company, ''))) not between 2 and 160 then
    raise exception 'academy: please check your name, company and email' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-free-ip:' || p_ip_hash));
  perform pg_advisory_xact_lock(hashtext('academy-free:' || v_email));
  if (select count(*) from academy_free_registrations where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10
     or (select count(*) from academy_free_registrations where email = v_email and created_at > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'limited');
  end if;
  select * into v_c from academy_courses where slug = p_course_slug;
  if v_c.id is null or not exists (select 1 from academy_course_access a where a.course_id = v_c.id and a.mode = 'free')
     or v_c.status <> 'published' or v_c.slug like 'test-%' or v_c.course_type = 'manufacturer_program' then
    return jsonb_build_object('ok', false, 'reason', 'not_free');
  end if;
  if academy_access_is_staff(v_email) then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;
  select * into v_l from academy_learners where email = v_email for update;
  if v_l.id is not null and v_l.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_l.id is null and exists (select 1 from dealer_users du where lower(du.email) = v_email and du.status = 'approved' and du.dealer_id is not null) then
    return jsonb_build_object('ok', false, 'reason', 'partner360');   -- one identity: they open Training from Partner 360
  end if;
  perform academy_op_begin('free_register', 'system:free');
  -- a learner who can already enroll free (an eligible network dealership, or an outside company) needs nothing new
  if v_l.id is null or not exists (select 1 from academy_memberships m where m.learner_id = v_l.id and m.status = 'active'
                                     and (m.organization_id is not null or academy_purchase_dealer_eligible(m.dealer_id))) then
    if v_l.id is null then
      insert into academy_learners (full_name, email) values (btrim(p_full_name), v_email) returning * into v_l;
      perform academy_op_audit('system', 'system:free', 'academy_learners', v_l.id::text, 'create_learner', null, to_jsonb(v_l));
    end if;
    select * into v_o from academy_organizations where contact_email = v_email and lower(name) = lower(btrim(p_company)) and status = 'active'
     order by created_at limit 1;
    if v_o.id is null then
      insert into academy_organizations (name, contact_email, created_by) values (btrim(p_company), v_email, 'system:free') returning * into v_o;
      perform academy_op_audit('system', 'system:free', 'academy_organizations', v_o.id::text, 'create_organization', null, to_jsonb(v_o));
    end if;
    insert into academy_memberships (learner_id, organization_id, role, access_type, created_by)
    values (v_l.id, v_o.id, 'learner', 'training_only', 'system:free') returning * into v_m;
    perform academy_op_audit('system', 'system:free', 'academy_memberships', v_m.id::text, 'free_access', null, to_jsonb(v_m));
    v_outcome := 'created';
  end if;
  insert into academy_free_registrations (email, full_name, company, course_id, outcome, learner_id, organization_id, ip_hash)
  values (v_email, btrim(p_full_name), btrim(p_company), v_c.id, v_outcome, v_l.id, v_o.id, p_ip_hash);
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'outcome', v_outcome);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. FREE SELF-ENROLLMENT (a signed-in learner)
-- ---------------------------------------------------------------------------------------------
create function public.academy_free_op_enroll(p_actor text, p_course_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_lid uuid; v_c academy_courses; v_v academy_course_versions; v_m academy_memberships; v_e academy_enrollments; v_test boolean;
begin
  if p_actor is null or p_actor !~ '^learner:[0-9a-f-]{36}$' then raise exception 'academy: sign in first' using errcode = '42501'; end if;
  v_lid := substr(p_actor, 9)::uuid;
  perform academy_op_actor_learner(p_actor, v_lid);                                  -- active, not HCPS staff
  select * into v_c from academy_courses where id = p_course_id;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from academy_course_access a where a.course_id = v_c.id and a.mode = 'free') or v_c.course_type = 'manufacturer_program' then
    raise exception 'academy: this course is not open for free enrollment' using errcode = '22023';
  end if;
  select * into v_v from academy_course_versions where course_id = v_c.id and status = 'published' for share;
  if v_v.id is null then raise exception 'academy: this course has no published version' using errcode = '22023'; end if;
  -- the membership the enrollment belongs to: an eligible network dealership first, else the outside organization
  select m.* into v_m from academy_memberships m
   where m.learner_id = v_lid and m.status = 'active' and m.dealer_id is not null and academy_purchase_dealer_eligible(m.dealer_id)
   order by m.started_at limit 1;
  if v_m.id is null then
    select m.* into v_m from academy_memberships m where m.learner_id = v_lid and m.status = 'active' and m.organization_id is not null
     order by m.started_at limit 1;
  end if;
  if v_m.id is null then
    raise exception 'academy: free enrollment needs an active Academy account at an HCPS network dealership or a registered outside company' using errcode = '42501';
  end if;
  select coalesce(d.is_test, false) into v_test from dealers d where d.id = v_m.dealer_id;
  if v_c.slug like 'test-%' and not coalesce(v_test, false) then
    raise exception 'academy: a TEST course is only for a TEST dealership''s people' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-free-enroll:' || v_lid::text || ':' || v_v.id::text));
  select * into v_e from academy_enrollments where learner_id = v_lid and version_id = v_v.id for update;
  if v_e.id is not null and v_e.status <> 'withdrawn' and exists (select 1 from academy_memberships m where m.id = v_e.membership_id and m.status = 'active') then
    return jsonb_build_object('ok', true, 'existing', true, 'enrollment_id', v_e.id, 'status', v_e.status);   -- repeat / double click
  end if;
  perform academy_op_begin('free_enroll', p_actor);
  if v_e.id is null then
    insert into academy_enrollments (learner_id, version_id, membership_id, access_source, assigned_by)
    values (v_lid, v_v.id, v_m.id, 'free', p_actor) returning * into v_e;
    perform academy_op_audit('learner', p_actor, 'academy_enrollments', v_e.id::text, 'free_enroll', null, to_jsonb(v_e));
  else
    update academy_enrollments set status = case when v_e.status = 'completed' then 'completed'
                                                 when exists (select 1 from academy_progress p where p.enrollment_id = v_e.id) then 'in_progress' else 'not_started' end,
           membership_id = v_m.id, access_source = 'free', assigned_by = p_actor
     where id = v_e.id returning * into v_e;
    perform academy_op_audit('learner', p_actor, 'academy_enrollments', v_e.id::text, 'free_re_enroll', null, to_jsonb(v_e));
  end if;
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'existing', false, 'enrollment_id', v_e.id, 'status', v_e.status);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES: operations to the server role only; the trigger function to nobody
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_free\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
revoke all on function public.academy_purchase_member_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (every row must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'F1 tables private (RLS on, no policies, server reads only)' as check,
       (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('academy_course_access','academy_free_registrations')
          and c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
          and has_table_privilege('service_role', c.oid, 'select') and not has_table_privilege('service_role', c.oid, 'insert')
          and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')) = 2 as ok
union all
select 'F1 operations: 4 for the server role, none public; the trigger function callable by nobody',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute')) = 4
   and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_%'
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
   and not has_function_privilege('service_role', 'public.academy_free_no_checkout()', 'execute')
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_op\_%'
union all
select 'guards + no-checkout trigger in place', (select count(*) from pg_trigger t where not t.tgisinternal and t.tgname = 'academy_purchase_guard'
          and t.tgrelid in ('public.academy_course_access'::regclass, 'public.academy_free_registrations'::regclass)) = 2
   and exists (select 1 from pg_trigger where not tgisinternal and tgname = 'academy_free_no_checkout')
union all
select 'free grants recorded as their own kind', exists (select 1 from pg_constraint where conname = 'academy_enrollments_access_source_check'
          and pg_get_constraintdef(oid) like '%free%')
union all
select 'no course switched yet', not exists (select 1 from academy_course_access) and not exists (select 1 from academy_free_registrations);

commit;
