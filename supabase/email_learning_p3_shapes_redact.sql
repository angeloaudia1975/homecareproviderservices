-- ============================================================================================
-- HCPS Smart Email Learning — Phase 3: which version / style shaped a draft, and the owner's REDACT decision (CLAUDE.md §16).
-- Safe to run twice. NOT RUN — Angelo runs it on approval, in the Supabase SQL editor. Needs Phase 1 AND Phase 2 installed.
-- It changes NO email, generator, prompt or send, and turns no switch on.
--
-- 1. email_draft_shapes (RULE 19 locked: RLS on, no policies, anon / authenticated / PUBLIC nothing, service_role SELECT only):
--    one row per kept draft that a Phase 3 feature shaped — the approved-rules version, the writing style, AI or not.
--    Written once, only by hcps_email_draft_shape(p), only for that draft's own author. Never updated or deleted.
-- 2. Redact (President only): hcps_email_rule_redact(p) removes a rule's stored evidence for good — the masked pattern
--    becomes {"redacted":true}, the examples [], both wordings a fixed placeholder; the same wording is replaced in that
--    rule's past events and version snapshots (the snapshot keeps id / type / kind and "redacted":true); an approved rule
--    is retired (a new numbered version), a suggested one rejected. The row, its key and its history stay, so the edit can
--    never be suggested again, its evidence is never refreshed (note) and it can never be approved, edited or restored
--    (decide; a rollback treats it as absent). For a lowercase name or a spelled-out address masking could not catch.
-- Phase 2 functions replaced here: hcps_email_rule_guard (adds the 'redact' and shape rules), hcps_email_rule_note and
-- hcps_email_rule_decide (each one added line refusing a redacted rule). The Phase 2 postcheck fingerprint therefore changes
-- after this migration — the Phase 3 postcheck has the new values (docs/email-learning/PHASE3.md).
-- pg-safeupdate: every UPDATE carries a WHERE clause; no DELETE.
-- After running: scripts/email_learning_p3_public_probe_browser.js (expect every check BLOCKED / 401).
-- ============================================================================================
begin;

do $$ begin
  if to_regclass('public.email_drafts') is null then raise exception 'email_learning_p3: install Phase 1 first'; end if;
  if to_regclass('public.email_learning_rules') is null then raise exception 'email_learning_p3: install Phase 2 first'; end if;
end $$;

-- ---- 1. which version / style shaped a kept draft ----
create table if not exists public.email_draft_shapes (
  draft_id         uuid primary key references public.email_drafts(id),
  created_at       timestamptz not null default now(),
  author_email     text not null check (author_email = lower(author_email) and author_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  profile_version  integer check (profile_version is null or profile_version > 0),
  style            text check (style is null or style in ('professional_friendly','consultative','brief_direct')),
  ai               boolean not null
);
alter table public.email_draft_shapes enable row level security;
revoke all on table public.email_draft_shapes from public, anon, authenticated, service_role;
grant select on table public.email_draft_shapes to service_role;

create or replace function public.hcps_email_draft_shape_guard()
returns trigger language plpgsql as $$
declare v_owner text;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if tg_level = 'STATEMENT' or tg_op <> 'INSERT' or current_user <> v_owner
     or coalesce(current_setting('hcps.email_shape_op', true), '') <> 'create' then
    raise exception 'email_shape_guard: rows are written once, only by hcps_email_draft_shape';
  end if;
  return new;
end $$;
drop trigger if exists email_shape_guard on public.email_draft_shapes;
create trigger email_shape_guard before insert or update or delete on public.email_draft_shapes for each row execute function public.hcps_email_draft_shape_guard();
drop trigger if exists email_shape_guard_truncate on public.email_draft_shapes;
create trigger email_shape_guard_truncate before truncate on public.email_draft_shapes for each statement execute function public.hcps_email_draft_shape_guard();

-- p = { draft_id, author_email, profile_version?, style?, ai }. Only the draft's own author; once (a repeat is "exists").
create or replace function public.hcps_email_draft_shape(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_author text := lower(btrim(coalesce(p->>'author_email', ''))); v_ver int; v_style text := nullif(p->>'style', ''); v_n int;
begin
  begin v_id := (p->>'draft_id')::uuid; exception when others then return jsonb_build_object('ok', false, 'status', 'bad_request'); end;
  v_ver := case when coalesce(p->>'profile_version', '') ~ '^[1-9][0-9]{0,8}$' then (p->>'profile_version')::int end;
  if v_style is not null and v_style not in ('professional_friendly','consultative','brief_direct') then
    return jsonb_build_object('ok', false, 'status', 'bad_request');
  end if;
  if not exists (select 1 from public.email_drafts where id = v_id and author_email = v_author) then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  if v_ver is not null and not exists (select 1 from public.email_learning_profiles where version = v_ver) then
    return jsonb_build_object('ok', false, 'status', 'bad_request');   -- only a version that exists
  end if;
  perform set_config('hcps.email_shape_op', 'create', true);
  insert into public.email_draft_shapes (draft_id, author_email, profile_version, style, ai)
  values (v_id, v_author, v_ver, v_style, coalesce(p->>'ai', '') = 'true')
  on conflict (draft_id) do nothing;
  get diagnostics v_n = row_count;   -- (not FOUND: the PERFORM below would reset it)
  perform set_config('hcps.email_shape_op', '', true);
  return jsonb_build_object('ok', true, 'status', case when v_n > 0 then 'recorded' else 'exists' end);
end $$;

-- ---- 2. redact ----
alter table public.email_learning_rules add column if not exists redacted_at timestamptz;
alter table public.email_learning_rules add column if not exists redacted_by text;
alter table public.email_learning_rules drop constraint if exists email_learning_rules_redacted_ck;
alter table public.email_learning_rules add constraint email_learning_rules_redacted_ck check (redacted_at is null
  or (pattern = '{"redacted": true}'::jsonb and examples = '[]'::jsonb and status in ('rejected','retired') and redacted_by is not null));
alter table public.email_learning_rule_events drop constraint if exists email_learning_rule_events_action_check;
alter table public.email_learning_rule_events add constraint email_learning_rule_events_action_check
  check (action in ('suggested','approved','rejected','retired','edited','restored','redacted'));
alter table public.email_learning_profiles drop constraint if exists email_learning_profiles_action_check;
alter table public.email_learning_profiles add constraint email_learning_profiles_action_check
  check (action in ('approve','retire','edit','rollback','reset','redact'));

-- Guard: marker hcps.email_rule_op ('note' | 'decide' | 'redact') AND the owner's rights.
--   rules:    INSERT only by 'note' (as status suggested); UPDATE by 'note' changes only the evidence columns;
--             UPDATE by 'decide' changes only status / wording / decision columns; UPDATE by 'redact' only once, only the
--             evidence / wording / status / decision / redaction columns. A redacted rule is never changed again.
--   profiles: INSERT by 'decide' or 'redact'; UPDATE only by 'redact', only the snapshot. Never DELETE / TRUNCATE.
--   events:   INSERT by 'note', 'decide' or 'redact'; UPDATE only by 'redact', only before / after. Never DELETE / TRUNCATE.
create or replace function public.hcps_email_rule_guard()
returns trigger language plpgsql as $$
declare v_owner text; v_op text := coalesce(current_setting('hcps.email_rule_op', true), '');
        v_evidence text[] := array['sends','dealers','examples','first_seen','last_seen','suggested_instruction','updated_at'];
        v_decision text[] := array['status','instruction','decided_at','decided_by','decision_reason','updated_at'];
        v_redact text[] := array['pattern','examples','instruction','suggested_instruction','status','decided_at','decided_by',
                                 'decision_reason','updated_at','redacted_at','redacted_by'];
begin
  if tg_level = 'STATEMENT' or tg_op = 'DELETE' then raise exception 'email_rule_guard: % of % is not allowed', tg_op, tg_table_name; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if current_user <> v_owner then raise exception 'email_rule_guard: % is written only by its functions', tg_table_name; end if;
  if tg_table_name = 'email_learning_profiles' then
    if tg_op = 'INSERT' and v_op in ('decide','redact') then return new; end if;
    if tg_op = 'UPDATE' and v_op = 'redact' and (to_jsonb(new) - 'rules') = (to_jsonb(old) - 'rules') then return new; end if;
    raise exception 'email_rule_guard: versions are insert-only, by a decision';
  elsif tg_table_name = 'email_learning_rule_events' then
    if tg_op = 'INSERT' and v_op in ('note','decide','redact') then return new; end if;
    if tg_op = 'UPDATE' and v_op = 'redact' and (to_jsonb(new) - array['before','after']) = (to_jsonb(old) - array['before','after']) then return new; end if;
    raise exception 'email_rule_guard: rule events are insert-only';
  end if;
  if tg_op = 'INSERT' then
    if v_op <> 'note' or new.status <> 'suggested' or new.decided_at is not null or new.redacted_at is not null then raise exception 'email_rule_guard: a rule starts as a suggestion'; end if;
    return new;
  end if;
  if new.id <> old.id or new.rule_key <> old.rule_key or new.pattern_key <> old.pattern_key or new.created_at <> old.created_at then raise exception 'email_rule_guard: a rule keeps its identity'; end if;
  if old.redacted_at is not null then raise exception 'email_rule_guard: a redacted rule is never changed again'; end if;
  if v_op = 'note' then
    if (to_jsonb(new) - v_evidence) <> (to_jsonb(old) - v_evidence) then raise exception 'email_rule_guard: the analyser changes only the evidence'; end if;
    return new;
  elsif v_op = 'decide' then
    if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then raise exception 'email_rule_guard: a decision changes only status and wording'; end if;
    return new;
  elsif v_op = 'redact' then
    if new.redacted_at is null or (to_jsonb(new) - v_redact) <> (to_jsonb(old) - v_redact) then raise exception 'email_rule_guard: a redaction changes only the evidence and wording'; end if;
    return new;
  end if;
  raise exception 'email_rule_guard: rules are changed only by the analyser or the owner''s decision';
end $$;

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
  if r.id is not null and r.redacted_at is not null then   -- Phase 3: a redacted rule's evidence is never refreshed again
    return jsonb_build_object('ok', true, 'status', 'redacted', 'id', r.id, 'rule_status', r.status);
  end if;
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
  if r.redacted_at is not null then return jsonb_build_object('ok', false, 'status', 'redacted', 'rule_status', r.status); end if;   -- Phase 3
  if coalesce(p->>'expected_status', '') <> r.status then
    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur, 'rule_status', r.status);
  end if;
  if v_instr is not null and (length(v_instr) < 3 or length(v_instr) > 300 or v_instr ~ '@'
                              or regexp_replace(v_instr, '[0-9]{1,3}%', '', 'g') ~ '[0-9]' or v_instr ~ '[^ -~‘’“”–—…→−]') then
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


-- The placeholder every redacted wording becomes (plain text, passes the masked-evidence CHECK).
-- p = { rule_id, by, reason, expected_version, expected_status }
create or replace function public.hcps_email_rule_redact(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.email_learning_rules; v_by text; v_cur int; v_id uuid; v_ver int; v_to text;
        v_reason text := btrim(coalesce(p->>'reason', '')); v_ph text := 'Redacted by the owner — this rule is no longer used.';
        v_was text;
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
  if r.redacted_at is not null then return jsonb_build_object('ok', false, 'status', 'redacted', 'rule_status', r.status); end if;
  if coalesce(p->>'expected_status', '') <> r.status then
    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur, 'rule_status', r.status);
  end if;
  v_was := r.status;
  v_to := case r.status when 'approved' then 'retired' when 'suggested' then 'rejected' else r.status end;
  perform set_config('hcps.email_rule_op', 'redact', true);
  update public.email_learning_rules
     set pattern = '{"redacted": true}'::jsonb, examples = '[]'::jsonb, instruction = v_ph, suggested_instruction = v_ph, status = v_to,
         decided_at = now(), decided_by = v_by, decision_reason = v_reason, updated_at = now(), redacted_at = now(), redacted_by = v_by
   where id = r.id
  returning * into r;
  -- the same wording in its past events and in every version snapshot that held it
  update public.email_learning_rule_events
     set before = case when before ? 'instruction' then jsonb_set(before, '{instruction}', to_jsonb(v_ph)) else before end,
         after  = case when after  ? 'instruction' then jsonb_set(after,  '{instruction}', to_jsonb(v_ph)) else after  end
   where rule_id = r.id and ((before ? 'instruction') or (after ? 'instruction'));
  update public.email_learning_profiles
     set rules = (select coalesce(jsonb_agg(case when e->>'id' = r.id::text
                     then jsonb_build_object('id', e->'id', 'email_type', e->'email_type', 'kind', e->'kind', 'redacted', true) else e end order by o), '[]'::jsonb)
                    from jsonb_array_elements(rules) with ordinality t(e, o))
   where exists (select 1 from jsonb_array_elements(rules) e where e->>'id' = r.id::text and e ? 'instruction');
  if v_was = 'approved' then
    v_ver := v_cur + 1;
    insert into public.email_learning_profiles (version, created_by, action, reason, rule_id, from_version, rules)
    values (v_ver, v_by, 'redact', v_reason, r.id, v_cur, public.hcps_email_rule_snapshot());
  end if;
  insert into public.email_learning_rule_events (rule_id, action, by_email, reason, before, after, version)
  values (r.id, 'redacted', v_by, v_reason, jsonb_build_object('status', v_was), jsonb_build_object('status', r.status), v_ver);
  perform set_config('hcps.email_rule_op', '', true);
  return jsonb_build_object('ok', true, 'status', 'redacted', 'rule_status', r.status, 'version', coalesce(v_ver, v_cur));
end $$;

revoke all on function public.hcps_email_draft_shape_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_rule_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_draft_shape(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_rule_redact(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_rule_note(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_rule_decide(jsonb) from public, anon, authenticated;
grant execute on function public.hcps_email_draft_shape(jsonb) to service_role;
grant execute on function public.hcps_email_rule_redact(jsonb) to service_role;
grant execute on function public.hcps_email_rule_note(jsonb) to service_role;
grant execute on function public.hcps_email_rule_decide(jsonb) to service_role;

commit;

-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'email_draft_shapes: RLS on, 0 policies' check_name,
         (select relrowsecurity from pg_class where oid = 'public.email_draft_shapes'::regclass)::text || ' / ' || (select count(*) from pg_policy where polrelid = 'public.email_draft_shapes'::regclass) value,
         (select relrowsecurity from pg_class where oid = 'public.email_draft_shapes'::regclass) and (select count(*) from pg_policy where polrelid = 'public.email_draft_shapes'::regclass) = 0 ok
  union all select 2, 'grants to anon / authenticated / PUBLIC (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'email_draft_shapes' and grantee in ('anon','authenticated','PUBLIC')
  union all select 3, 'service_role: SELECT only on email_draft_shapes', coalesce(string_agg(privilege_type, ','), ''), coalesce(string_agg(privilege_type, ','), '') = 'SELECT'
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'email_draft_shapes' and grantee = 'service_role'
  union all select 4, 'new functions: service_role only, security definer; guards callable by nobody',
         (select count(*) from unnest(array['public.hcps_email_draft_shape(jsonb)','public.hcps_email_rule_redact(jsonb)','public.hcps_email_rule_note(jsonb)','public.hcps_email_rule_decide(jsonb)']) f
           where has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
             and not has_function_privilege('authenticated', f, 'execute') and (select prosecdef from pg_proc where oid = f::regprocedure))::text || ' of 4',
         (select count(*) from unnest(array['public.hcps_email_draft_shape(jsonb)','public.hcps_email_rule_redact(jsonb)','public.hcps_email_rule_note(jsonb)','public.hcps_email_rule_decide(jsonb)']) f
           where has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
             and not has_function_privilege('authenticated', f, 'execute') and (select prosecdef from pg_proc where oid = f::regprocedure)) = 4
         and not has_function_privilege('service_role', 'public.hcps_email_draft_shape_guard()', 'execute')
         and not has_function_privilege('service_role', 'public.hcps_email_rule_guard()', 'execute')
  union all select 5, 'guard triggers (shapes 2 + rules / profiles / events 6)', count(*)::text, count(*) = 8
    from pg_trigger where tgrelid in ('public.email_draft_shapes'::regclass, 'public.email_learning_rules'::regclass, 'public.email_learning_profiles'::regclass,
      'public.email_learning_rule_events'::regclass) and not tgisinternal
  union all select 6, 'redaction columns + constraint', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'email_learning_rules'
           and column_name in ('redacted_at','redacted_by'))::text || ' cols, ck ' || exists (select 1 from pg_constraint where conname = 'email_learning_rules_redacted_ck')::text,
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'email_learning_rules' and column_name in ('redacted_at','redacted_by')) = 2
           and exists (select 1 from pg_constraint where conname = 'email_learning_rules_redacted_ck')
  union all select 7, 'no rows written by the install (shapes; redacted rules)', ((select count(*) from public.email_draft_shapes) + (select count(*) from public.email_learning_rules where redacted_at is not null))::text,
         (select count(*) from public.email_draft_shapes) + (select count(*) from public.email_learning_rules where redacted_at is not null) = 0
  union all select 8, 'Phase 3 switches NOT turned on by this migration',
         coalesce((select concat_ws(' / ', value->>'email_learning_apply', value->>'email_ai_headsup', value->>'email_styles') from public.app_settings where key = 'phase2_flags'), 'absent'),
         coalesce((select (value->>'email_learning_apply' = 'true') or (value->>'email_ai_headsup' = 'true') or (value->>'email_styles' = 'true') from public.app_settings where key = 'phase2_flags'), false) is not true
) c order by n;
