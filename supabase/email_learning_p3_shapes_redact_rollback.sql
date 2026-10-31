-- ============================================================================================
-- ROLLBACK of supabase/email_learning_p3_shapes_redact.sql — puts Phase 2's guard, note and decide back exactly, and removes
-- the shapes table and the redact function. REFUSES (changes nothing) while any rule is redacted or any shape row exists:
-- a redaction is never undone (that would need evidence that no longer exists), and Phase 2's guard would let the analyser
-- refresh a redacted rule's evidence again. First turn the Phase 3 switches off (no deploy needed), then run this.
-- ============================================================================================
begin;
do $$ begin
  if exists (select 1 from public.email_learning_rules where redacted_at is not null) then
    raise exception 'email_learning_p3 rollback: a rule has been redacted — rolling back is refused (nothing was changed)';
  end if;
  if to_regclass('public.email_draft_shapes') is not null and exists (select 1 from public.email_draft_shapes) then
    raise exception 'email_learning_p3 rollback: email_draft_shapes holds rows — rolling back is refused (nothing was changed)';
  end if;
end $$;
drop function if exists public.hcps_email_rule_redact(jsonb);
drop function if exists public.hcps_email_draft_shape(jsonb);
drop table if exists public.email_draft_shapes;
drop function if exists public.hcps_email_draft_shape_guard();
alter table public.email_learning_rules drop constraint if exists email_learning_rules_redacted_ck;
alter table public.email_learning_rules drop column if exists redacted_at;
alter table public.email_learning_rules drop column if exists redacted_by;
alter table public.email_learning_rule_events drop constraint if exists email_learning_rule_events_action_check;
alter table public.email_learning_rule_events add constraint email_learning_rule_events_action_check
  check (action in ('suggested','approved','rejected','retired','edited','restored'));
alter table public.email_learning_profiles drop constraint if exists email_learning_profiles_action_check;
alter table public.email_learning_profiles add constraint email_learning_profiles_action_check
  check (action in ('approve','retire','edit','rollback','reset'));
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


revoke all on function public.hcps_email_rule_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_rule_note(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_rule_decide(jsonb) from public, anon, authenticated;
grant execute on function public.hcps_email_rule_note(jsonb) to service_role;
grant execute on function public.hcps_email_rule_decide(jsonb) to service_role;
commit;
