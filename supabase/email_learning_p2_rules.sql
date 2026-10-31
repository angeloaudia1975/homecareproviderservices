-- ============================================================================================
-- HCPS Smart Email Learning — Phase 2: learned writing rules, owner approval, versions (CLAUDE.md §16).
-- Safe to run twice. NOT RUN — Angelo runs it on approval, in the Supabase SQL editor. Needs Phase 1 installed.
--
-- Three tables (RULE 19 locked: RLS on, no policies, anon / authenticated / PUBLIC nothing, service_role SELECT only):
--   email_learning_rules        one row per learned edit pattern: suggested → approved / rejected → retired.
--                               Holds MASKED, non-identifying evidence only (no email text, no address, no number).
--   email_learning_profiles     every change to the set of approved rules is a numbered VERSION holding the whole
--                               approved set (owner decision: versions with rollback / reset). Insert only.
--   email_learning_rule_events  every status / wording change of a rule, who and why. Insert only.
-- Writes only through four security-definer functions (service_role only):
--   hcps_email_rule_note(p)          the analyser records a suggestion (3+ sends across 2+ dealers, checked here) or
--                                    refreshes the evidence of a known rule — never its status or wording
--   hcps_email_rule_decide(p)        the owner approves / rejects / retires / rewords a rule
--   hcps_email_profile_rollback(p)   the owner returns the approved set to an earlier version (0 = reset: none)
-- Decisions need the ACTIVE President named in staff_users and the version the owner was looking at (a stale
-- screen is refused: version_conflict). Nothing here changes an email, a generator, a prompt or a send: approved
-- rules are applied to drafts only in Phase 3, behind its own switch.
-- A guard trigger (marker + the owner's rights) refuses every other insert, update, delete or truncate.
-- pg-safeupdate: every UPDATE carries a WHERE clause; no DELETE.
-- After running: scripts/email_learning_p2_public_probe_browser.js (expect every check BLOCKED / 401).
-- ============================================================================================
begin;

do $$ begin
  if to_regclass('public.email_drafts') is null then raise exception 'email_learning_p2: install Phase 1 (email_learning_p1_capture.sql) first'; end if;
  if to_regclass('public.staff_users') is null then raise exception 'email_learning_p2: staff_users is missing'; end if;
end $$;

create table if not exists public.email_learning_rules (
  id                     uuid primary key default gen_random_uuid(),
  rule_key               text not null unique check (rule_key ~ '^[0-9a-f]{32}$'),
  pattern_key            text not null check (pattern_key ~ '^[0-9a-f]{32}$'),   -- the same edit whatever the email type
  email_type             text not null check (email_type in ('all','previsit_headsup','visit_followup','follow_up','dormant_account',
                           'product_intro','reorder_reminder','cross_sell','portal_activation','campaign')),
  kind                   text not null check (kind in ('remove_phrase','replace_phrase','add_phrase','greeting','shorter','longer','subject')),
  pattern                jsonb not null check (jsonb_typeof(pattern) = 'object' and length(pattern::text) <= 1000),
  instruction            text not null check (length(btrim(instruction)) between 3 and 300),
  suggested_instruction  text not null check (length(btrim(suggested_instruction)) between 3 and 300),
  examples               jsonb not null default '[]'::jsonb check (jsonb_typeof(examples) = 'array' and jsonb_array_length(examples) <= 3
                           and length(examples::text) <= 1500),
  sends                  integer not null check (sends >= 0),
  dealers                integer not null check (dealers >= 0 and dealers <= sends),
  first_seen             timestamptz,
  last_seen              timestamptz,
  status                 text not null default 'suggested' check (status in ('suggested','approved','rejected','retired')),
  decided_at             timestamptz,
  decided_by             text,
  decision_reason        text check (decision_reason is null or length(decision_reason) <= 500),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- non-identifying evidence: no digit and no "@" anywhere in the stored pattern or examples; the wording holds no "@" and
  -- no digit other than a percentage ("about 30%") — never a phone number, amount, date or address
  constraint email_learning_rules_masked_ck check (pattern::text !~ '[0-9@]' and examples::text !~ '[0-9@]'
                                                   and suggested_instruction !~ '@' and instruction !~ '@'
                                                   and regexp_replace(suggested_instruction, '[0-9]{1,3}%', '', 'g') !~ '[0-9]'
                                                   and regexp_replace(instruction, '[0-9]{1,3}%', '', 'g') !~ '[0-9]')
);
create index if not exists email_learning_rules_status_ix on public.email_learning_rules(status, updated_at desc);
-- One rule per edit, whatever the email type: two analysis runs at once can never suggest the same edit twice.
create unique index if not exists email_learning_rules_pattern_uk on public.email_learning_rules(pattern_key);

create table if not exists public.email_learning_profiles (
  version       integer primary key check (version > 0),
  created_at    timestamptz not null default now(),
  created_by    text not null,
  action        text not null check (action in ('approve','retire','edit','rollback','reset')),
  reason        text not null check (length(btrim(reason)) between 3 and 500),
  rule_id       uuid,
  from_version  integer check (from_version is null or from_version >= 0),
  rules         jsonb not null check (jsonb_typeof(rules) = 'array')
);

create table if not exists public.email_learning_rule_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  rule_id     uuid not null references public.email_learning_rules(id),
  action      text not null check (action in ('suggested','approved','rejected','retired','edited','restored')),
  by_email    text not null,
  reason      text check (reason is null or length(reason) <= 500),
  before      jsonb,
  after       jsonb,
  version     integer
);
create index if not exists email_learning_rule_events_rule_ix on public.email_learning_rule_events(rule_id, at desc);

alter table public.email_learning_rules enable row level security;
alter table public.email_learning_profiles enable row level security;
alter table public.email_learning_rule_events enable row level security;
revoke all on table public.email_learning_rules, public.email_learning_profiles, public.email_learning_rule_events from public, anon, authenticated, service_role;
revoke all on sequence public.email_learning_rule_events_id_seq from public, anon, authenticated, service_role;
grant select on table public.email_learning_rules, public.email_learning_profiles, public.email_learning_rule_events to service_role;

-- Guard: marker hcps.email_rule_op ('note' | 'decide') AND the owner's rights.
--   rules:    INSERT only by 'note' (as status suggested); UPDATE by 'note' changes only the evidence columns;
--             UPDATE by 'decide' changes only status / wording / decision columns. Never DELETE / TRUNCATE.
--   profiles: INSERT only, by 'decide'; events: INSERT only, by 'note' or 'decide'. Never UPDATE / DELETE / TRUNCATE.
create or replace function public.hcps_email_rule_guard()
returns trigger language plpgsql as $$
declare v_owner text; v_op text := coalesce(current_setting('hcps.email_rule_op', true), '');
        v_evidence text[] := array['sends','dealers','examples','first_seen','last_seen','suggested_instruction','updated_at'];
        v_decision text[] := array['status','instruction','decided_at','decided_by','decision_reason','updated_at'];
begin
  if tg_level = 'STATEMENT' or tg_op = 'DELETE' then raise exception 'email_rule_guard: % of % is not allowed', tg_op, tg_table_name; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if current_user <> v_owner then raise exception 'email_rule_guard: % is written only by its functions', tg_table_name; end if;
  if tg_table_name = 'email_learning_profiles' then
    if tg_op <> 'INSERT' or v_op <> 'decide' then raise exception 'email_rule_guard: versions are insert-only, by a decision'; end if;
    return new;
  elsif tg_table_name = 'email_learning_rule_events' then
    if tg_op <> 'INSERT' or v_op not in ('note','decide') then raise exception 'email_rule_guard: rule events are insert-only'; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if v_op <> 'note' or new.status <> 'suggested' or new.decided_at is not null then raise exception 'email_rule_guard: a rule starts as a suggestion'; end if;
    return new;
  end if;
  if new.id <> old.id or new.rule_key <> old.rule_key or new.created_at <> old.created_at then raise exception 'email_rule_guard: a rule keeps its identity'; end if;
  if v_op = 'note' then
    if (to_jsonb(new) - v_evidence) <> (to_jsonb(old) - v_evidence) then raise exception 'email_rule_guard: the analyser changes only the evidence'; end if;
    return new;
  elsif v_op = 'decide' then
    if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then raise exception 'email_rule_guard: a decision changes only status and wording'; end if;
    return new;
  end if;
  raise exception 'email_rule_guard: rules are changed only by the analyser or the owner''s decision';
end $$;
drop trigger if exists email_rule_guard on public.email_learning_rules;
create trigger email_rule_guard before insert or update or delete on public.email_learning_rules for each row execute function public.hcps_email_rule_guard();
drop trigger if exists email_rule_guard_truncate on public.email_learning_rules;
create trigger email_rule_guard_truncate before truncate on public.email_learning_rules for each statement execute function public.hcps_email_rule_guard();
drop trigger if exists email_profile_guard on public.email_learning_profiles;
create trigger email_profile_guard before insert or update or delete on public.email_learning_profiles for each row execute function public.hcps_email_rule_guard();
drop trigger if exists email_profile_guard_truncate on public.email_learning_profiles;
create trigger email_profile_guard_truncate before truncate on public.email_learning_profiles for each statement execute function public.hcps_email_rule_guard();
drop trigger if exists email_rule_event_guard on public.email_learning_rule_events;
create trigger email_rule_event_guard before insert or update or delete on public.email_learning_rule_events for each row execute function public.hcps_email_rule_guard();
drop trigger if exists email_rule_event_guard_truncate on public.email_learning_rule_events;
create trigger email_rule_event_guard_truncate before truncate on public.email_learning_rule_events for each statement execute function public.hcps_email_rule_guard();

-- The active President, or null.
create or replace function public.hcps_email_rule_president(p_email text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select lower(btrim(p_email)) from public.staff_users
   where lower(email) = lower(btrim(coalesce(p_email, ''))) and lower(coalesce(role, '')) = 'president' and active is not false
   limit 1
$$;

-- The approved set as a version snapshot (stable order).
create or replace function public.hcps_email_rule_snapshot()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'email_type', email_type, 'kind', kind, 'instruction', instruction) order by email_type, kind, id), '[]'::jsonb)
    from public.email_learning_rules where status = 'approved'
$$;

-- p = { rule_key, pattern_key, email_type, kind, pattern, instruction, examples, draft_ids, first_seen, last_seen }
-- The evidence is COUNTED HERE from email_drafts (draft_ids = the drafts the analyser found the edit in): only sent, edited
-- drafts written by the active President count; the caller's own counts are not trusted. A new rule is never created for an
-- edit already known under another email type (pattern_key): a rejected, approved or retired edit is never suggested again in
-- another scope, and the same edit is never suggested twice (advisory lock + unique index on pattern_key).
create or replace function public.hcps_email_rule_note(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.email_learning_rules; v_sends int; v_dealers int; v_instr text := btrim(coalesce(p->>'instruction', ''));
        v_ex jsonb := coalesce(p->'examples', '[]'::jsonb); v_changed boolean; v_ids uuid[];
begin
  if jsonb_typeof(v_ex) <> 'array' then raise exception 'email_rule_bad_request: examples is a list'; end if;
  if coalesce(p->>'pattern_key', '') !~ '^[0-9a-f]{32}$' or jsonb_typeof(p->'draft_ids') is distinct from 'array'
     or jsonb_array_length(p->'draft_ids') > 10000 then
    return jsonb_build_object('ok', false, 'status', 'bad_request');
  end if;
  begin select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p->'draft_ids') x;
  exception when others then return jsonb_build_object('ok', false, 'status', 'bad_request'); end;
  select count(distinct d.id), count(distinct d.dealer_id) into v_sends, v_dealers
    from public.email_drafts d
   where d.id = any(coalesce(v_ids, '{}'::uuid[])) and d.sent_at is not null and d.edited is true
     and d.author_email in (select lower(btrim(s.email)) from public.staff_users s
                             where lower(coalesce(s.role, '')) = 'president' and s.active is not false);
  perform pg_advisory_xact_lock(hashtext('hcps_email_rule_note:' || (p->>'pattern_key')));
  select * into r from public.email_learning_rules where rule_key = p->>'rule_key' for update;
  if r.id is null then   -- (not FOUND: a later PERFORM would reset it)
    if v_sends < 3 or v_dealers < 2 then return jsonb_build_object('ok', false, 'status', 'below_threshold'); end if;
    if exists (select 1 from public.email_learning_rules where pattern_key = p->>'pattern_key') then
      return jsonb_build_object('ok', false, 'status', 'sibling_exists');
    end if;
    perform set_config('hcps.email_rule_op', 'note', true);
    insert into public.email_learning_rules (rule_key, pattern_key, email_type, kind, pattern, instruction, suggested_instruction, examples, sends, dealers, first_seen, last_seen)
    values (p->>'rule_key', p->>'pattern_key', p->>'email_type', p->>'kind', p->'pattern', v_instr, v_instr, v_ex, v_sends, v_dealers,
            nullif(p->>'first_seen', '')::timestamptz, nullif(p->>'last_seen', '')::timestamptz)
    returning * into r;
    insert into public.email_learning_rule_events (rule_id, action, by_email, after)
    values (r.id, 'suggested', 'system:email-learning', jsonb_build_object('status', 'suggested', 'instruction', r.instruction, 'sends', r.sends, 'dealers', r.dealers));
    perform set_config('hcps.email_rule_op', '', true);
    return jsonb_build_object('ok', true, 'status', 'inserted', 'id', r.id);
  end if;
  -- Known rule: evidence only (counts never go down — drafts older than 12 months lose their text, not their history).
  perform set_config('hcps.email_rule_op', 'note', true);
  update public.email_learning_rules
     set sends = greatest(sends, v_sends), dealers = least(greatest(sends, v_sends), greatest(dealers, v_dealers)), examples = v_ex,
         first_seen = least(first_seen, nullif(p->>'first_seen', '')::timestamptz), last_seen = greatest(last_seen, nullif(p->>'last_seen', '')::timestamptz),
         suggested_instruction = v_instr, updated_at = now()
   where id = r.id
     and (sends < v_sends or dealers < v_dealers or examples <> v_ex or suggested_instruction <> v_instr
          or first_seen is distinct from least(first_seen, nullif(p->>'first_seen', '')::timestamptz)
          or last_seen is distinct from greatest(last_seen, nullif(p->>'last_seen', '')::timestamptz));
  v_changed := found;
  perform set_config('hcps.email_rule_op', '', true);
  return jsonb_build_object('ok', true, 'status', case when v_changed then 'updated' else 'unchanged' end, 'id', r.id, 'rule_status', r.status);
end $$;

create or replace function public.hcps_email_rule_version()
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(max(version), 0) from public.email_learning_profiles
$$;

-- p = { rule_id, decision: approve | reject | retire | edit, by, reason, instruction?, expected_version, expected_status }
-- expected_status = the rule's status on the owner's screen: a reject creates no version, so the version alone cannot tell
-- a stale screen from a current one (a rule rejected in another tab is never approved from an old one).
create or replace function public.hcps_email_rule_decide(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.email_learning_rules; v_by text; v_cur int; v_id uuid; v_d text := coalesce(p->>'decision', '');
        v_reason text := btrim(coalesce(p->>'reason', '')); v_instr text := nullif(btrim(coalesce(p->>'instruction', '')), '');
        v_to text; v_ver int; v_before jsonb;
begin
  v_by := public.hcps_email_rule_president(p->>'by');
  if v_by is null then return jsonb_build_object('ok', false, 'status', 'president_only'); end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then return jsonb_build_object('ok', false, 'status', 'reason_required'); end if;
  begin v_id := (p->>'rule_id')::uuid; exception when others then return jsonb_build_object('ok', false, 'status', 'not_found'); end;
  perform pg_advisory_xact_lock(hashtext('hcps_email_learning_profile'));
  v_cur := public.hcps_email_rule_version();
  if coalesce(case when p->>'expected_version' ~ '^\d{1,9}$' then (p->>'expected_version')::int end, -1) <> v_cur then
    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur);
  end if;
  select * into r from public.email_learning_rules where id = v_id for update;
  if not found then return jsonb_build_object('ok', false, 'status', 'not_found'); end if;
  if coalesce(p->>'expected_status', '') <> r.status then
    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur, 'rule_status', r.status);
  end if;
  if v_instr is not null and (length(v_instr) < 3 or length(v_instr) > 300 or v_instr ~ '@'
                              or regexp_replace(v_instr, '[0-9]{1,3}%', '', 'g') ~ '[0-9]') then
    return jsonb_build_object('ok', false, 'status', 'bad_instruction');
  end if;
  v_to := case v_d when 'approve' then case when r.status in ('suggested','rejected','retired') then 'approved' end
                   when 'reject'  then case when r.status = 'suggested' then 'rejected' end
                   when 'retire'  then case when r.status = 'approved' then 'retired' end
                   when 'edit'    then case when r.status = 'approved' and v_instr is not null and v_instr <> r.instruction then 'approved' end end;
  if v_to is null then return jsonb_build_object('ok', false, 'status', 'not_allowed', 'rule_status', r.status); end if;
  v_before := jsonb_build_object('status', r.status, 'instruction', r.instruction);
  perform set_config('hcps.email_rule_op', 'decide', true);
  update public.email_learning_rules set status = v_to, instruction = coalesce(v_instr, instruction),
         decided_at = now(), decided_by = v_by, decision_reason = v_reason, updated_at = now()
   where id = r.id
  returning * into r;
  if v_d <> 'reject' then
    v_ver := v_cur + 1;
    insert into public.email_learning_profiles (version, created_by, action, reason, rule_id, from_version, rules)
    values (v_ver, v_by, v_d, v_reason, r.id, v_cur, public.hcps_email_rule_snapshot());
  end if;
  insert into public.email_learning_rule_events (rule_id, action, by_email, reason, before, after, version)
  values (r.id, case v_d when 'approve' then 'approved' when 'reject' then 'rejected' when 'retire' then 'retired' else 'edited' end,
          v_by, v_reason, v_before, jsonb_build_object('status', r.status, 'instruction', r.instruction), v_ver);
  perform set_config('hcps.email_rule_op', '', true);
  return jsonb_build_object('ok', true, 'status', 'decided', 'rule_status', r.status, 'version', coalesce(v_ver, v_cur));
end $$;

-- p = { to_version (0 = reset: no approved rules), by, reason, expected_version }
create or replace function public.hcps_email_profile_rollback(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_by text; v_cur int; v_to int; v_reason text := btrim(coalesce(p->>'reason', '')); v_snap jsonb; v_ver int; r record;
begin
  v_by := public.hcps_email_rule_president(p->>'by');
  if v_by is null then return jsonb_build_object('ok', false, 'status', 'president_only'); end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then return jsonb_build_object('ok', false, 'status', 'reason_required'); end if;
  v_to := case when p->>'to_version' ~ '^\d{1,9}$' then (p->>'to_version')::int end;
  perform pg_advisory_xact_lock(hashtext('hcps_email_learning_profile'));
  v_cur := public.hcps_email_rule_version();
  if coalesce(case when p->>'expected_version' ~ '^\d{1,9}$' then (p->>'expected_version')::int end, -1) <> v_cur then
    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur);
  end if;
  if v_to is null or v_to < 0 or v_to >= v_cur then return jsonb_build_object('ok', false, 'status', 'not_found'); end if;
  if v_to = 0 then v_snap := '[]'::jsonb;
  else select rules into v_snap from public.email_learning_profiles where version = v_to;
       if v_snap is null then return jsonb_build_object('ok', false, 'status', 'not_found'); end if;
  end if;
  perform set_config('hcps.email_rule_op', 'decide', true);
  v_ver := v_cur + 1;
  -- Rules in the snapshot become approved with the snapshot's wording; every other approved rule is retired.
  for r in select x.id, x.status, x.instruction, s.instruction as want
             from public.email_learning_rules x
             left join lateral (select e->>'instruction' as instruction from jsonb_array_elements(v_snap) e where (e->>'id')::uuid = x.id) s on true
            where (s.instruction is not null and (x.status <> 'approved' or x.instruction <> s.instruction))
               or (s.instruction is null and x.status = 'approved')
            for update of x loop
    update public.email_learning_rules
       set status = case when r.want is null then 'retired' else 'approved' end, instruction = coalesce(r.want, instruction),
           decided_at = now(), decided_by = v_by, decision_reason = v_reason, updated_at = now()
     where id = r.id;
    insert into public.email_learning_rule_events (rule_id, action, by_email, reason, before, after, version)
    values (r.id, case when r.want is null then 'retired' else 'restored' end, v_by, v_reason,
            jsonb_build_object('status', r.status, 'instruction', r.instruction),
            jsonb_build_object('status', case when r.want is null then 'retired' else 'approved' end, 'instruction', coalesce(r.want, r.instruction)), v_ver);
  end loop;
  insert into public.email_learning_profiles (version, created_by, action, reason, from_version, rules)
  values (v_ver, v_by, case when v_to = 0 then 'reset' else 'rollback' end, v_reason, v_to, public.hcps_email_rule_snapshot());
  perform set_config('hcps.email_rule_op', '', true);
  return jsonb_build_object('ok', true, 'status', case when v_to = 0 then 'reset' else 'rolled_back' end, 'version', v_ver);
end $$;

revoke all on function public.hcps_email_rule_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_rule_president(text) from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_rule_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_rule_version() from public, anon, authenticated;
revoke all on function public.hcps_email_rule_note(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_rule_decide(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_profile_rollback(jsonb) from public, anon, authenticated;
grant execute on function public.hcps_email_rule_version() to service_role;
grant execute on function public.hcps_email_rule_note(jsonb) to service_role;
grant execute on function public.hcps_email_rule_decide(jsonb) to service_role;
grant execute on function public.hcps_email_profile_rollback(jsonb) to service_role;

commit;

-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, '3 tables, RLS on, 0 policies' check_name,
         count(*) || ' tables, RLS ' || bool_and(c.relrowsecurity) value,
         count(*) = 3 and bool_and(c.relrowsecurity)
           and (select count(*) from pg_policy pp where pp.polrelid in ('public.email_learning_rules'::regclass, 'public.email_learning_profiles'::regclass, 'public.email_learning_rule_events'::regclass)) = 0 ok
    from pg_class c where c.oid in ('public.email_learning_rules'::regclass, 'public.email_learning_profiles'::regclass, 'public.email_learning_rule_events'::regclass)
  union all select 2, 'grants to anon / authenticated / PUBLIC (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('email_learning_rules','email_learning_profiles','email_learning_rule_events') and grantee in ('anon','authenticated','PUBLIC')
  union all select 3, 'service_role: SELECT only (3 tables)', coalesce(string_agg(distinct privilege_type, ','), '') || ' / ' || count(*),
         coalesce(string_agg(distinct privilege_type, ','), '') = 'SELECT' and count(*) = 3
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('email_learning_rules','email_learning_profiles','email_learning_rule_events') and grantee = 'service_role'
  union all select 4, 'write functions: service_role only, security definer; helpers callable by nobody',
         (select count(*) from unnest(array['public.hcps_email_rule_note(jsonb)','public.hcps_email_rule_decide(jsonb)','public.hcps_email_profile_rollback(jsonb)','public.hcps_email_rule_version()']) f
           where has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
             and not has_function_privilege('authenticated', f, 'execute') and (select prosecdef from pg_proc where oid = f::regprocedure))::text || ' of 4',
         (select count(*) from unnest(array['public.hcps_email_rule_note(jsonb)','public.hcps_email_rule_decide(jsonb)','public.hcps_email_profile_rollback(jsonb)','public.hcps_email_rule_version()']) f
           where has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
             and not has_function_privilege('authenticated', f, 'execute') and (select prosecdef from pg_proc where oid = f::regprocedure)) = 4
         and not has_function_privilege('service_role', 'public.hcps_email_rule_guard()', 'execute')
         and not has_function_privilege('service_role', 'public.hcps_email_rule_president(text)', 'execute')
         and not has_function_privilege('service_role', 'public.hcps_email_rule_snapshot()', 'execute')
  union all select 5, 'guard triggers (row + truncate, 3 tables)', count(*)::text, count(*) = 6
    from pg_trigger where tgrelid in ('public.email_learning_rules'::regclass, 'public.email_learning_profiles'::regclass, 'public.email_learning_rule_events'::regclass) and not tgisinternal
  union all select 6, 'no rows written by the install', ((select count(*) from public.email_learning_rules) + (select count(*) from public.email_learning_profiles)
         + (select count(*) from public.email_learning_rule_events))::text,
         (select count(*) from public.email_learning_rules) + (select count(*) from public.email_learning_profiles) + (select count(*) from public.email_learning_rule_events) = 0
  union all select 7, 'Phase 1 untouched (email_drafts present)', (to_regclass('public.email_drafts') is not null)::text, to_regclass('public.email_drafts') is not null
  union all select 8, 'suggestion switch NOT turned on by this migration',
         coalesce((select value->>'email_learning_suggest' from public.app_settings where key = 'phase2_flags'), 'absent'),
         coalesce((select value->>'email_learning_suggest' from public.app_settings where key = 'phase2_flags'), 'absent') <> 'true'
  union all select 9, 'one rule per edit (unique pattern_key)', coalesce((select indexdef from pg_indexes where schemaname = 'public'
           and indexname = 'email_learning_rules_pattern_uk'), 'missing'),
         exists (select 1 from pg_index i where i.indexrelid = 'public.email_learning_rules_pattern_uk'::regclass and i.indisunique)
) c order by n;
