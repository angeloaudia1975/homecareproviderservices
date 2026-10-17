-- =============================================================================================
-- HCPS Academy — A2B / M5: learner accounts and access (DEVELOPMENT; NOT run in production)
--
-- What it gives the Academy (Learner Launch Implementation Plan, Stage 2; decision D14; the 10 Oct sign-in review):
--   * Two ways in, ONE learner record:
--       - a training-only employee signs in with a 6-digit email code: single use, 10-minute life, 5 tries,
--         rate-limited per email and per network address; only a SHA-256 of the code is stored;
--       - a Partner 360 dealer user follows a single-use, 60-second handoff code minted from their Partner 360 login;
--         the learner record is linked to that login, so the same person never gets a second identity.
--   * A server-side session row for every sign-in: deactivating a learner, ending a membership or signing out ends
--     the session on the very next request (the cookie alone is never enough).
--   * Training Manager invitations for their OWN dealership (the dealer and its direct branches, decision D3);
--     only HCPS grants the Training Manager role (decision F). HCPS staff are never learners (decision D6).
--   * Enrollment into a PUBLISHED course version, assigned by HCPS or the dealership's Training Manager, and saved
--     lesson progress (resume point, viewed / completed). Learners keep the version they started on (decision B).
--   * Every change is one audited operation: the change and its academy_events row together, or neither.
--
-- Design (same pattern as M1–M4): new SECURITY DEFINER functions with a pinned search path, executable by the server
-- role only; internal helpers callable by the owner only. The server role keeps SELECT on the learner-side tables but
-- LOSES insert / update / delete on them, so the operations below are the only way to change them. M1–M4 objects are
-- left byte-identical. Login codes, handoff codes and sessions hold only hashes and ids, never a code or a cookie.
--
-- Run order: after A1, M1, M2, M3, M3.1 and M4. Rollback: academy_a2b_m5_learner_access_rollback.sql (refused while
-- any learner, invite, code, session, enrollment or progress row exists).
-- RULE 19: the two new tables have RLS on, no policies, nothing for anon / authenticated, SELECT only for the server.
-- Every UPDATE / DELETE carries a WHERE clause (pg-safeupdate).
-- =============================================================================================
begin;

do $$ begin
  if to_regprocedure('public.academy_op_actor_staff(text)') is null
     or to_regprocedure('public.academy_content_op_create_course(text,uuid,jsonb)') is null
     or to_regprocedure('public.academy_publish_op_publish_version(text,uuid,text)') is null then
    raise exception 'M5 needs M1, M2 and M4 installed first';
  end if;
  if to_regclass('public.dealer_users') is null then
    raise exception 'M5 needs public.dealer_users (Partner 360 logins)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'is_test') then
    raise exception 'M5 needs dealers.is_test';
  end if;
  if to_regprocedure('public.academy_access_op_request_code(text,text,text)') is not null then
    raise exception 'M5 is already installed';
  end if;
  if exists (select 1 from academy_learners) or exists (select 1 from academy_memberships)
     or exists (select 1 from academy_invites) or exists (select 1 from academy_enrollments) then
    raise exception 'M5 expects no learner records yet (none exist before A2B)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- SCHEMA
-- ---------------------------------------------------------------------------------------------
-- A training-only learner has no Supabase login at all; a Partner 360 user is linked by auth_user_id (still unique).
alter table public.academy_learners alter column auth_user_id drop not null;
create unique index academy_learners_email_uk on public.academy_learners (email);
alter table public.academy_learners add constraint academy_learners_email_shape
  check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254);

-- One row per code REQUESTED (eligible or not, so the rate limits also count probes for unknown addresses).
create table public.academy_login_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email = lower(email) and length(email) <= 254),
  code_hash   text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  ip_hash     text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  eligible    boolean not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  tries       int not null default 0 check (tries between 0 and 5),
  used_at     timestamptz,
  burned_at   timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check (not (used_at is not null and burned_at is not null))
);
create index academy_login_codes_email on public.academy_login_codes (email, created_at desc);
create index academy_login_codes_ip on public.academy_login_codes (ip_hash, created_at desc);
comment on table public.academy_login_codes is
  'Academy email sign-in codes (D14). Only a SHA-256 of each 6-digit code is stored; 10-minute life, 5 tries.';

-- One row per sign-in. The cookie names a session; the session must still be open on every request.
create table public.academy_sessions (
  id            uuid primary key default gen_random_uuid(),
  learner_id    uuid not null references public.academy_learners(id) on delete restrict,
  via           text not null check (via in ('code','handoff')),
  ip_hash       text check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  ended_at      timestamptz,
  ended_reason  text,
  check (expires_at > created_at and expires_at <= created_at + interval '8 hours'),
  check ((ended_at is null) = (ended_reason is null))
);
create index academy_sessions_learner on public.academy_sessions (learner_id) where ended_at is null;
comment on table public.academy_sessions is
  'Academy learner sessions. Ending a membership, suspending a learner or signing out ends them at once.';

alter table public.academy_login_codes enable row level security;
alter table public.academy_sessions enable row level security;
revoke all on table public.academy_login_codes, public.academy_sessions from public, anon, authenticated;

-- The server role reads the learner-side tables but can no longer write them: the operations are the only road.
do $$
declare t text;
begin
  foreach t in array array['academy_learners','academy_memberships','academy_invites','academy_handoff_codes',
                           'academy_enrollments','academy_progress','academy_login_codes','academy_sessions']
  loop
    execute format('revoke all on table public.%I from service_role', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INTERNAL HELPERS (owner only)
-- ---------------------------------------------------------------------------------------------
create function public.academy_access_norm_email(p text) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text := lower(trim(coalesce(p, '')));
begin
  if v !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v) > 254 then
    raise exception 'academy: that is not an email address' using errcode = '22023';
  end if;
  return v;
end $$;

create function public.academy_access_is_staff(p_email text) returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from staff_users s where lower(s.email) = lower(p_email) and coalesce(s.active, true))
$$;

-- "Own dealership" (D3): the Training Manager's dealer and its direct branches.
create function public.academy_access_in_family(p_tm_dealer uuid, p_dealer uuid) returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select p_tm_dealer = p_dealer or exists (select 1 from dealers d where d.id = p_dealer and d.parent_id = p_tm_dealer)
$$;

-- Who is acting on a dealership's people. Returns 'staff' for an active HCPS administrator (staff:<email>), or
-- 'training_manager' for "learner:<id>" holding an active Training Manager membership whose family holds p_dealer.
create function public.academy_access_actor(p_actor text, p_dealer uuid) returns text
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_id uuid; v_l academy_learners;
begin
  if p_actor like 'staff:%' then perform academy_op_actor_staff(p_actor); return 'staff'; end if;
  if p_actor is null or p_actor !~ '^learner:[0-9a-f-]{36}$' then
    raise exception 'academy: the acting person must be named' using errcode = '42501';
  end if;
  v_id := substr(p_actor, 9)::uuid;
  select * into v_l from academy_learners where id = v_id;
  if not found or v_l.status <> 'active' or academy_access_is_staff(v_l.email) then
    raise exception 'academy: the acting learner is not active' using errcode = '42501';
  end if;
  if not exists (select 1 from academy_memberships m where m.learner_id = v_id and m.status = 'active'
                   and m.role = 'training_manager' and academy_access_in_family(m.dealer_id, p_dealer)) then
    raise exception 'academy: only this dealership''s Training Manager or HCPS may do that' using errcode = '42501';
  end if;
  return 'training_manager';
end $$;

create function public.academy_access_actor_type(p_actor text) returns text
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case when p_actor like 'staff:%' then 'staff' when p_actor like 'learner:%' then 'learner' else 'system' end
$$;

-- Ends every open session of a learner (inside the calling operation).
create function public.academy_access_end_sessions(p_learner uuid, p_reason text) returns int
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  update academy_sessions set ended_at = now(), ended_reason = p_reason
   where learner_id = p_learner and ended_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- A new session row (inside the calling operation). 8 hours, like the cookie.
create function public.academy_access_new_session(p_learner uuid, p_via text, p_ip_hash text) returns uuid
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v uuid;
begin
  insert into academy_sessions (learner_id, via, ip_hash, expires_at)
  values (p_learner, p_via, p_ip_hash, now() + interval '8 hours') returning id into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. EMAIL SIGN-IN CODES (D14)
-- ---------------------------------------------------------------------------------------------
-- Records a requested code and says whether to SEND it. The answer the visitor sees never depends on whether the
-- address is known (the API always says "if this address may use the Academy, a code is on its way").
-- Limits: 3 per address per 15 minutes and 10 per day; 10 per network address per 15 minutes.
create function public.academy_access_op_request_code(p_email text, p_code_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := academy_access_norm_email(p_email); v_eligible boolean; v_id uuid;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'academy: malformed request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));
  if (select count(*) from academy_login_codes where email = v_email and created_at > now() - interval '15 minutes') >= 3
     or (select count(*) from academy_login_codes where email = v_email and created_at > now() - interval '1 day') >= 10 then
    return jsonb_build_object('send', false, 'limited', 'email');
  end if;
  if (select count(*) from academy_login_codes where ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 10 then
    return jsonb_build_object('send', false, 'limited', 'network');
  end if;
  v_eligible := not academy_access_is_staff(v_email) and (
       exists (select 1 from academy_learners l join academy_memberships m on m.learner_id = l.id and m.status = 'active'
                where l.email = v_email and l.status = 'active')
    or exists (select 1 from academy_invites i where i.email = v_email and i.status = 'pending' and i.expires_at > now()
                  and not exists (select 1 from academy_learners l where l.email = v_email and l.status <> 'active')));
  perform academy_op_begin('request_code', 'system:sign-in');
  update academy_login_codes set burned_at = now()
   where email = v_email and used_at is null and burned_at is null;
  insert into academy_login_codes (email, code_hash, ip_hash, eligible, expires_at)
  values (v_email, p_code_hash, p_ip_hash, v_eligible, now() + interval '10 minutes') returning id into v_id;
  if v_eligible then
    perform academy_op_audit('system', 'system:sign-in', 'academy_login_codes', v_id::text, 'sign_in_code_sent',
      null, jsonb_build_object('email', v_email));
  end if;
  perform academy_op_end();
  return jsonb_build_object('send', v_eligible, 'code_id', v_id);
end $$;

-- Checks a code. A wrong code counts a try (the 5th wrong try burns it); the right code is used once, accepts the
-- address's pending invitations (creating the learner and memberships), and opens a session.
-- Returns {ok:true, learner_id, session_id} or {ok:false, reason} — never raises for a wrong code, so the try counts.
create function public.academy_access_op_verify_code(p_email text, p_code_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := academy_access_norm_email(p_email); v_c academy_login_codes; v_l academy_learners;
        v_i academy_invites; v_m uuid; v_sid uuid; v_accepted int := 0;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'academy: malformed request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));
  -- a network address that keeps guessing is stopped for 15 minutes
  if (select coalesce(sum(tries), 0) from academy_login_codes where ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 25 then
    return jsonb_build_object('ok', false, 'reason', 'limited');
  end if;
  select * into v_c from academy_login_codes
   where email = v_email and used_at is null and burned_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  perform academy_op_begin('verify_code', 'system:sign-in');
  if v_c.code_hash <> p_code_hash then
    update academy_login_codes set tries = tries + 1, burned_at = case when tries + 1 >= 5 then now() end
     where id = v_c.id;
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', case when v_c.tries + 1 >= 5 then 'expired' else 'wrong' end);
  end if;
  update academy_login_codes set used_at = now() where id = v_c.id;
  if not v_c.eligible or academy_access_is_staff(v_email) then
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select * into v_l from academy_learners where email = v_email for update;
  if found and v_l.status <> 'active' then
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  -- the code proves the address: accept its pending invitations
  for v_i in select * from academy_invites where email = v_email and status = 'pending' and expires_at > now()
             order by created_at for update loop
    if v_l.id is null then
      insert into academy_learners (full_name, email)
      values (coalesce(nullif(trim(v_i.full_name), ''), split_part(v_email, '@', 1)), v_email) returning * into v_l;
      perform academy_op_audit('system', 'system:sign-in', 'academy_learners', v_l.id::text, 'create_learner', null, to_jsonb(v_l));
    end if;
    if not exists (select 1 from academy_memberships where learner_id = v_l.id and dealer_id = v_i.dealer_id and status = 'active') then
      insert into academy_memberships (learner_id, dealer_id, role, access_type, created_by)
      values (v_l.id, v_i.dealer_id, v_i.role, 'training_only', coalesce(v_i.invited_by_staff, 'learner:' || v_i.invited_by_learner))
      returning id into v_m;
      perform academy_op_audit('system', 'system:sign-in', 'academy_memberships', v_m::text, 'accept_invite',
        null, jsonb_build_object('invite_id', v_i.id, 'dealer_id', v_i.dealer_id, 'role', v_i.role));
    end if;
    update academy_invites set status = 'accepted', accepted_learner_id = v_l.id, accepted_at = now() where id = v_i.id;
    v_accepted := v_accepted + 1;
  end loop;
  if v_l.id is null or not exists (select 1 from academy_memberships where learner_id = v_l.id and status = 'active') then
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  v_sid := academy_access_new_session(v_l.id, 'code', p_ip_hash);
  perform academy_op_audit('learner', 'learner:' || v_l.id, 'academy_sessions', v_sid::text, 'sign_in',
    null, jsonb_build_object('via', 'code', 'invites_accepted', v_accepted));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'learner_id', v_l.id, 'session_id', v_sid);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. PARTNER 360 HANDOFF
-- ---------------------------------------------------------------------------------------------
-- Minted for an APPROVED Partner 360 login (dealer_users). The server has already verified that login's token; the
-- code itself is never stored, only its hash. 60 seconds; a new code replaces any unused one; 10 per 10 minutes.
create function public.academy_access_op_handoff_mint(p_auth_user_id uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_du record; v_id uuid;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' then raise exception 'academy: malformed request' using errcode = '22023'; end if;
  select du.dealer_id, lower(du.email) as email into v_du from dealer_users du
   where du.uid = p_auth_user_id and du.status = 'approved' limit 1;
  if not found or v_du.dealer_id is null then
    raise exception 'academy: this Partner 360 login is not approved for a dealership' using errcode = '42501';
  end if;
  if academy_access_is_staff(v_du.email) then
    raise exception 'academy: HCPS staff are not learners' using errcode = '42501';
  end if;
  if exists (select 1 from academy_learners where (auth_user_id = p_auth_user_id or email = v_du.email) and status <> 'active') then
    raise exception 'academy: this Academy account is not active' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-handoff:' || p_auth_user_id::text));
  if (select count(*) from academy_handoff_codes where auth_user_id = p_auth_user_id and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'academy: too many Training links; wait a few minutes' using errcode = '22023';
  end if;
  perform academy_op_begin('handoff_mint', 'system:partner360');
  update academy_handoff_codes set used_at = now() where auth_user_id = p_auth_user_id and used_at is null;
  insert into academy_handoff_codes (code_hash, auth_user_id, expires_at)
  values (p_code_hash, p_auth_user_id, now() + interval '60 seconds') returning id into v_id;
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'expires_in', 60);
end $$;

-- Redeems a handoff code once: finds or creates THE learner for that login (linking an existing learner with the same
-- verified address when it has no login yet), makes sure their dealership membership is active, opens a session.
create function public.academy_access_op_handoff_redeem(p_code_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_h academy_handoff_codes; v_du record; v_l academy_learners; v_m uuid; v_sid uuid;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'academy: malformed request' using errcode = '22023';
  end if;
  select * into v_h from academy_handoff_codes where code_hash = p_code_hash for update;
  if not found or v_h.used_at is not null or v_h.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  perform academy_op_begin('handoff_redeem', 'system:partner360');
  update academy_handoff_codes set used_at = now() where id = v_h.id;
  select du.dealer_id, lower(du.email) as email into v_du from dealer_users du
   where du.uid = v_h.auth_user_id and du.status = 'approved' limit 1;
  if not found or v_du.dealer_id is null or academy_access_is_staff(v_du.email) then
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select * into v_l from academy_learners where auth_user_id = v_h.auth_user_id for update;
  if not found then
    select * into v_l from academy_learners where email = v_du.email for update;
    if found then
      if v_l.auth_user_id is not null then
        perform academy_op_end();
        return jsonb_build_object('ok', false, 'reason', 'not_allowed');   -- that address belongs to another login
      end if;
      update academy_learners set auth_user_id = v_h.auth_user_id, updated_at = now() where id = v_l.id returning * into v_l;
      perform academy_op_audit('system', 'system:partner360', 'academy_learners', v_l.id::text, 'link_partner360_login',
        null, jsonb_build_object('auth_user_id', v_h.auth_user_id));
    else
      insert into academy_learners (auth_user_id, full_name, email)
      values (v_h.auth_user_id, split_part(v_du.email, '@', 1), v_du.email) returning * into v_l;
      perform academy_op_audit('system', 'system:partner360', 'academy_learners', v_l.id::text, 'create_learner', null, to_jsonb(v_l));
    end if;
  end if;
  if v_l.status <> 'active' then
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if not exists (select 1 from academy_memberships where learner_id = v_l.id and dealer_id = v_du.dealer_id and status = 'active') then
    insert into academy_memberships (learner_id, dealer_id, role, access_type, created_by)
    values (v_l.id, v_du.dealer_id, 'learner', 'dealer_user', 'system:partner360') returning id into v_m;
    perform academy_op_audit('system', 'system:partner360', 'academy_memberships', v_m::text, 'create_membership',
      null, jsonb_build_object('dealer_id', v_du.dealer_id, 'access_type', 'dealer_user'));
  end if;
  v_sid := academy_access_new_session(v_l.id, 'handoff', p_ip_hash);
  perform academy_op_audit('learner', 'learner:' || v_l.id, 'academy_sessions', v_sid::text, 'sign_in', null,
    jsonb_build_object('via', 'handoff'));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'learner_id', v_l.id, 'session_id', v_sid);
end $$;

-- Signing out ends this session (only the session's own learner).
create function public.academy_access_op_end_session(p_actor text, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_s academy_sessions;
begin
  select * into v_s from academy_sessions where id = p_session_id for update;
  if not found or p_actor is distinct from 'learner:' || v_s.learner_id::text then
    raise exception 'academy: not your session' using errcode = '42501';
  end if;
  if v_s.ended_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  perform academy_op_begin('end_session', p_actor);
  update academy_sessions set ended_at = now(), ended_reason = 'signed_out' where id = p_session_id;
  perform academy_op_audit('learner', p_actor, 'academy_sessions', p_session_id::text, 'sign_out', null, null);
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. PEOPLE: invitations, deactivation, reactivation, suspension
-- ---------------------------------------------------------------------------------------------
-- A Training Manager invites for their own dealership; HCPS for any. Only HCPS invites a Training Manager.
create function public.academy_access_op_invite(p_actor text, p_dealer_id uuid, p_email text, p_full_name text, p_role text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_kind text; v_email text := academy_access_norm_email(p_email); v_i academy_invites;
begin
  v_kind := academy_access_actor(p_actor, p_dealer_id);
  if not exists (select 1 from dealers where id = p_dealer_id) then
    raise exception 'academy: dealership not found' using errcode = 'P0002';
  end if;
  if p_role not in ('learner','training_manager') then raise exception 'academy: unknown role' using errcode = '22023'; end if;
  if p_role = 'training_manager' and v_kind <> 'staff' then
    raise exception 'academy: only HCPS makes someone a Training Manager' using errcode = '42501';
  end if;
  if academy_access_is_staff(v_email) then raise exception 'academy: HCPS staff are not learners' using errcode = '22023'; end if;
  if length(coalesce(p_full_name, '')) > 200 then raise exception 'academy: the name is too long' using errcode = '22023'; end if;
  if exists (select 1 from academy_learners l join academy_memberships m on m.learner_id = l.id
              where l.email = v_email and m.dealer_id = p_dealer_id and m.status = 'active') then
    raise exception 'academy: that person already has access for this dealership' using errcode = '23505';
  end if;
  if exists (select 1 from academy_learners l where l.email = v_email and l.status <> 'active') then
    raise exception 'academy: that person''s Academy account is suspended; HCPS must reactivate it' using errcode = '22023';
  end if;
  perform academy_op_begin('invite', p_actor);
  -- a fresh invitation replaces an earlier pending one for the same person and dealership
  update academy_invites set status = 'revoked' where dealer_id = p_dealer_id and email = v_email and status = 'pending';
  insert into academy_invites (dealer_id, email, full_name, role, token_hash, expires_at, invited_by_learner, invited_by_staff)
  values (p_dealer_id, v_email, nullif(trim(coalesce(p_full_name, '')), ''), p_role,
          md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), now() + interval '14 days',
          case when v_kind = 'staff' then null else substr(p_actor, 9)::uuid end,
          case when v_kind = 'staff' then p_actor end)
  returning * into v_i;
  perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_invites', v_i.id::text, 'invite', null,
    to_jsonb(v_i) - 'token_hash');
  perform academy_op_end();
  return to_jsonb(v_i) - 'token_hash';
end $$;

create function public.academy_access_op_revoke_invite(p_actor text, p_invite_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_i academy_invites;
begin
  select * into v_i from academy_invites where id = p_invite_id for update;
  if not found then raise exception 'academy: invitation not found' using errcode = 'P0002'; end if;
  perform academy_access_actor(p_actor, v_i.dealer_id);
  if v_i.status <> 'pending' then raise exception 'academy: the invitation is no longer pending' using errcode = '22023'; end if;
  perform academy_op_begin('revoke_invite', p_actor);
  update academy_invites set status = 'revoked' where id = p_invite_id;
  perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_invites', p_invite_id::text, 'revoke_invite',
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'revoked', 'reason', p_reason));
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- Ends a membership. A Training Manager may end a LEARNER's membership in their own dealership (never a Training
-- Manager's, never their own); HCPS any. When it was the learner's last active membership, their sessions end now.
create function public.academy_access_op_deactivate(p_actor text, p_membership_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_m academy_memberships; v_kind text; v_ended int := 0;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'academy: a reason is required' using errcode = '22023'; end if;
  select * into v_m from academy_memberships where id = p_membership_id for update;
  if not found then raise exception 'academy: membership not found' using errcode = 'P0002'; end if;
  v_kind := academy_access_actor(p_actor, v_m.dealer_id);
  if v_kind <> 'staff' and (v_m.role = 'training_manager' or p_actor = 'learner:' || v_m.learner_id::text) then
    raise exception 'academy: only HCPS ends a Training Manager''s access' using errcode = '42501';
  end if;
  if v_m.status <> 'active' then raise exception 'academy: the membership is not active' using errcode = '22023'; end if;
  perform academy_op_begin('deactivate', p_actor);
  update academy_memberships set status = 'ended', ended_at = now(), ended_reason = p_reason where id = p_membership_id;
  if not exists (select 1 from academy_memberships where learner_id = v_m.learner_id and status = 'active') then
    v_ended := academy_access_end_sessions(v_m.learner_id, 'access_ended');
  end if;
  perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_memberships', p_membership_id::text, 'deactivate',
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'ended', 'reason', p_reason, 'sessions_ended', v_ended));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'sessions_ended', v_ended);
end $$;

-- Gives a known learner access again for a dealership (a new membership; history kept).
create function public.academy_access_op_reactivate(p_actor text, p_learner_id uuid, p_dealer_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_l academy_learners; v_m uuid; v_type text; v_moved int;
begin
  perform academy_access_actor(p_actor, p_dealer_id);
  select * into v_l from academy_learners where id = p_learner_id for update;
  if not found then raise exception 'academy: learner not found' using errcode = 'P0002'; end if;
  if v_l.status <> 'active' then raise exception 'academy: the learner is suspended; HCPS must reactivate the account' using errcode = '22023'; end if;
  if academy_access_is_staff(v_l.email) then raise exception 'academy: HCPS staff are not learners' using errcode = '22023'; end if;
  if p_actor like 'learner:%' and not exists (select 1 from academy_memberships where learner_id = p_learner_id
                                              and academy_access_in_family(
                                                (select m2.dealer_id from academy_memberships m2 where m2.learner_id = substr(p_actor, 9)::uuid
                                                  and m2.status = 'active' and m2.role = 'training_manager'
                                                  and academy_access_in_family(m2.dealer_id, p_dealer_id) limit 1), dealer_id)) then
    raise exception 'academy: that person was never part of your dealership; invite them instead' using errcode = '42501';
  end if;
  if exists (select 1 from academy_memberships where learner_id = p_learner_id and dealer_id = p_dealer_id and status = 'active') then
    raise exception 'academy: that person already has access for this dealership' using errcode = '23505';
  end if;
  v_type := case when v_l.auth_user_id is not null and exists (select 1 from dealer_users du where du.uid = v_l.auth_user_id
                   and du.dealer_id = p_dealer_id and du.status = 'approved') then 'dealer_user' else 'training_only' end;
  perform academy_op_begin('reactivate', p_actor);
  insert into academy_memberships (learner_id, dealer_id, role, access_type, created_by)
  values (p_learner_id, p_dealer_id, 'learner', v_type, p_actor) returning id into v_m;
  -- the courses (and saved progress) they had at this dealership come back with the access
  with moved as (
    update academy_enrollments e set membership_id = v_m
     where e.learner_id = p_learner_id and e.status <> 'withdrawn'
       and e.membership_id in (select m.id from academy_memberships m where m.learner_id = p_learner_id
                                 and m.dealer_id = p_dealer_id and m.status <> 'active')
    returning e.id)
  select count(*) into v_moved from moved;
  perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_memberships', v_m::text, 'reactivate', null,
    jsonb_build_object('learner_id', p_learner_id, 'dealer_id', p_dealer_id, 'access_type', v_type, 'enrollments_restored', v_moved));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'membership_id', v_m);
end $$;

-- HCPS only: suspend (ends every session now) or restore a learner account.
create function public.academy_access_op_set_learner_status(p_actor text, p_learner_id uuid, p_status text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_l academy_learners; v_ended int := 0;
begin
  perform academy_op_actor_staff(p_actor);
  if p_status not in ('active','suspended') then raise exception 'academy: unknown status' using errcode = '22023'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'academy: a reason is required' using errcode = '22023'; end if;
  select * into v_l from academy_learners where id = p_learner_id for update;
  if not found then raise exception 'academy: learner not found' using errcode = 'P0002'; end if;
  if v_l.status = p_status then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  if v_l.status = 'closed' then raise exception 'academy: a closed account stays closed' using errcode = '22023'; end if;
  perform academy_op_begin('set_learner_status', p_actor);
  update academy_learners set status = p_status, updated_at = now() where id = p_learner_id;
  if p_status = 'suspended' then v_ended := academy_access_end_sessions(p_learner_id, 'suspended'); end if;
  perform academy_op_audit('staff', p_actor, 'academy_learners', p_learner_id::text, 'set_learner_status',
    jsonb_build_object('status', v_l.status), jsonb_build_object('status', p_status, 'reason', p_reason, 'sessions_ended', v_ended));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'sessions_ended', v_ended);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. ENROLLMENT AND PROGRESS
-- ---------------------------------------------------------------------------------------------
-- Enroll a learner of the actor's dealership into a PUBLISHED version. A TEST course only for a TEST dealership's
-- people. A withdrawn enrollment on the same version comes back (with its saved progress).
create function public.academy_enroll_op_enroll(p_actor text, p_learner_id uuid, p_version_id uuid, p_due_on date)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_l academy_learners; v_v academy_course_versions; v_c academy_courses; v_m academy_memberships; v_e academy_enrollments;
        v_kind text; v_test boolean;
begin
  select * into v_l from academy_learners where id = p_learner_id;
  if not found or v_l.status <> 'active' then raise exception 'academy: the learner is not active' using errcode = '22023'; end if;
  if academy_access_is_staff(v_l.email) then raise exception 'academy: HCPS staff are not learners' using errcode = '22023'; end if;
  select * into v_v from academy_course_versions where id = p_version_id for share;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  if v_v.status <> 'published' then raise exception 'academy: learners are enrolled only in a published course version' using errcode = '22023'; end if;
  select * into v_c from academy_courses where id = v_v.course_id;
  if v_c.course_type = 'manufacturer_program' then raise exception 'academy: a manufacturer program is not enrolled here' using errcode = '22023'; end if;
  -- the membership the enrollment belongs to: one the actor may manage
  for v_m in select * from academy_memberships where learner_id = p_learner_id and status = 'active' order by started_at loop
    begin v_kind := academy_access_actor(p_actor, v_m.dealer_id); exit; exception when insufficient_privilege then v_kind := null; end;
  end loop;
  if v_kind is null then raise exception 'academy: only this dealership''s Training Manager or HCPS may do that' using errcode = '42501'; end if;
  select coalesce(d.is_test, false) into v_test from dealers d where d.id = v_m.dealer_id;
  if v_c.slug like 'test-%' and not v_test then
    raise exception 'academy: a TEST course is only for a TEST dealership''s people' using errcode = '22023';
  end if;
  if p_due_on is not null and p_due_on < current_date then raise exception 'academy: the due date is in the past' using errcode = '22023'; end if;
  perform academy_op_begin('enroll', p_actor);
  select * into v_e from academy_enrollments where learner_id = p_learner_id and version_id = p_version_id for update;
  if found then
    if v_e.status <> 'withdrawn' and exists (select 1 from academy_memberships m where m.id = v_e.membership_id and m.status = 'active') then
      perform academy_op_end();
      raise exception 'academy: already enrolled in this course version' using errcode = '23505';
    end if;
    if v_e.status <> 'withdrawn' then
      -- enrolled through access that has since ended (e.g. a move to another dealership): the same enrollment and its
      -- progress move to the access they have now; completion is kept
      update academy_enrollments set membership_id = v_m.id, assigned_by = p_actor where id = v_e.id returning * into v_e;
      perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_enrollments', v_e.id::text, 're_attach',
        null, to_jsonb(v_e));
      perform academy_op_end();
      return to_jsonb(v_e);
    end if;
    update academy_enrollments set status = case when exists (select 1 from academy_progress p where p.enrollment_id = v_e.id)
                                                 then 'in_progress' else 'not_started' end,
                                   membership_id = v_m.id, due_on = p_due_on, assigned_by = p_actor
     where id = v_e.id returning * into v_e;
    perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_enrollments', v_e.id::text, 're_enroll',
      jsonb_build_object('status', 'withdrawn'), to_jsonb(v_e));
  else
    insert into academy_enrollments (learner_id, version_id, membership_id, access_source, assigned_by, due_on)
    values (p_learner_id, p_version_id, v_m.id, case when v_kind = 'staff' then 'admin_grant' else 'assigned' end, p_actor, p_due_on)
    returning * into v_e;
    perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_enrollments', v_e.id::text, 'enroll', null, to_jsonb(v_e));
  end if;
  perform academy_op_end();
  return to_jsonb(v_e);
end $$;

create function public.academy_enroll_op_withdraw(p_actor text, p_enrollment_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments; v_m academy_memberships;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'academy: a reason is required' using errcode = '22023'; end if;
  select * into v_e from academy_enrollments where id = p_enrollment_id for update;
  if not found then raise exception 'academy: enrollment not found' using errcode = 'P0002'; end if;
  select * into v_m from academy_memberships where id = v_e.membership_id;
  if not found then
    perform academy_op_actor_staff(p_actor);
  else
    perform academy_access_actor(p_actor, v_m.dealer_id);
  end if;
  if v_e.status in ('withdrawn','completed') then raise exception 'academy: the enrollment is already %', v_e.status using errcode = '22023'; end if;
  perform academy_op_begin('withdraw', p_actor);
  update academy_enrollments set status = 'withdrawn' where id = p_enrollment_id;
  perform academy_op_audit(academy_access_actor_type(p_actor), p_actor, 'academy_enrollments', p_enrollment_id::text, 'withdraw',
    jsonb_build_object('status', v_e.status), jsonb_build_object('status', 'withdrawn', 'reason', p_reason));
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- The learner's own progress on a lesson of the enrolled version. 'completed' is never undone; the resume point is
-- the screen they are on. Starting the first lesson moves the enrollment to in_progress. The resume point is saved
-- quietly; a lesson's first view and its completion are recorded in the audit trail.
create function public.academy_progress_op_save(p_actor text, p_enrollment_id uuid, p_lesson_id uuid, p_status text, p_resume_block int)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments; v_v academy_course_versions; v_les academy_lessons; v_old academy_progress; v_new academy_progress;
        v_status text;
begin
  select * into v_e from academy_enrollments where id = p_enrollment_id for update;
  if not found then raise exception 'academy: enrollment not found' using errcode = 'P0002'; end if;
  perform academy_op_actor_learner(p_actor, v_e.learner_id);
  if not exists (select 1 from academy_memberships where id = v_e.membership_id and status = 'active') then
    raise exception 'academy: your access for this dealership has ended' using errcode = '42501';
  end if;
  if v_e.status = 'withdrawn' then raise exception 'academy: the enrollment was withdrawn' using errcode = '22023'; end if;
  select * into v_v from academy_course_versions where id = v_e.version_id;
  if v_v.status not in ('published','retired') then raise exception 'academy: the course version is not open' using errcode = '22023'; end if;
  select l.* into v_les from academy_lessons l join academy_modules m on m.id = l.module_id
   where l.id = p_lesson_id and m.version_id = v_e.version_id;
  if not found then raise exception 'academy: that lesson is not part of this course' using errcode = '22023'; end if;
  if p_status not in ('viewed','completed') then raise exception 'academy: unknown progress' using errcode = '22023'; end if;
  if p_resume_block is null or p_resume_block < 0 or p_resume_block > greatest(jsonb_array_length(coalesce(v_les.blocks, '[]'::jsonb)) - 1, 0) then
    raise exception 'academy: that screen is not part of the lesson' using errcode = '22023';
  end if;
  select * into v_old from academy_progress where enrollment_id = p_enrollment_id and lesson_id = p_lesson_id for update;
  v_status := case when v_old.status = 'completed' then 'completed' else p_status end;
  perform academy_op_begin('save_progress', p_actor);
  insert into academy_progress (enrollment_id, lesson_id, status, resume_block, updated_at)
  values (p_enrollment_id, p_lesson_id, v_status, p_resume_block, now())
  on conflict (enrollment_id, lesson_id) do update set status = excluded.status, resume_block = excluded.resume_block, updated_at = now()
  returning * into v_new;
  if v_e.status = 'not_started' then update academy_enrollments set status = 'in_progress' where id = p_enrollment_id; end if;
  if v_old.enrollment_id is null or (v_old.status = 'viewed' and v_status = 'completed') then
    perform academy_op_audit('learner', p_actor, 'academy_progress', p_enrollment_id::text || ':' || p_lesson_id::text,
      case when v_status = 'completed' and (v_old.status is distinct from 'completed') then 'complete_lesson' else 'start_lesson' end,
      case when v_old.enrollment_id is null then null else to_jsonb(v_old) end, to_jsonb(v_new));
  end if;
  perform academy_op_end();
  return to_jsonb(v_new);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'academy_access_%' or p.proname like 'academy_enroll_op_%'
                                            or p.proname like 'academy_progress_op_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like '%\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (each must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'M5 functions' as check, count(*) = 20 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and (p.proname like 'academy_access_%' or p.proname like 'academy_enroll_op_%' or p.proname like 'academy_progress_op_%')
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like '%\_op\_%' and (p.proname like 'academy_access_%' or p.proname like 'academy_enroll_%' or p.proname like 'academy_progress_%')
union all
select 'server calls the 13 operations and nothing else of M5',
       count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 13
   and count(*) filter (where p.proname not like '%\_op\_%' and has_function_privilege('service_role', p.oid, 'execute')) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and (p.proname like 'academy_access_%' or p.proname like 'academy_enroll_%' or p.proname like 'academy_progress_%')
union all
select 'anon and authenticated call nothing of M5', not bool_or(has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon','authenticated']) r
 where n.nspname = 'public' and (p.proname like 'academy_access_%' or p.proname like 'academy_enroll_%' or p.proname like 'academy_progress_%')
union all
select 'server reads but cannot write the learner-side tables',
       bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert')
                and not has_table_privilege('service_role', t, 'update') and not has_table_privilege('service_role', t, 'delete'))
  from unnest(array['public.academy_learners','public.academy_memberships','public.academy_invites','public.academy_handoff_codes',
                    'public.academy_enrollments','public.academy_progress','public.academy_login_codes','public.academy_sessions']) t
union all
select 'new tables: RLS on, no policies, nothing for anon / authenticated',
       (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.academy_login_codes'::regclass, 'public.academy_sessions'::regclass))
   and not exists (select 1 from pg_policy where polrelid in ('public.academy_login_codes'::regclass, 'public.academy_sessions'::regclass))
   and not has_table_privilege('anon', 'public.academy_login_codes', 'select') and not has_table_privilege('authenticated', 'public.academy_sessions', 'select')
union all
select 'learner login is optional; email unique', (select attnotnull = false from pg_attribute where attrelid = 'public.academy_learners'::regclass and attname = 'auth_user_id')
   and to_regclass('public.academy_learners_email_uk') is not null
union all
select 'no learner records written', not exists (select 1 from academy_learners) and not exists (select 1 from academy_sessions)
   and not exists (select 1 from academy_login_codes);

commit;
