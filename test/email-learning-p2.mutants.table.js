/* Mutants for Smart Email Learning Phase 2. Each must make its suite FAIL (CONTROL must pass).
   file: a function / page file (applied in memory by phase0-mock's loader) or 'sql2' (a temporary copy of the Phase 2 migration). */
const LN = '_email_learn.js', RUN = '_email_learn_run.js', API = 'email-learning-api.js', CRON = 'email-learning-purge-cron.js';
module.exports = {
  CONTROL: { file: LN, suite: 'js2', control: true, from: 'const MIN_SENDS = 3, MIN_DEALERS = 2,', to: 'const MIN_SENDS = 3, MIN_DEALERS = 2, /* control */' },
  // owner decision 3: 3 sends across 2 dealers
  threshold_two_sends: { file: LN, suite: 'js2', from: 'const MIN_SENDS = 3, MIN_DEALERS = 2,', to: 'const MIN_SENDS = 2, MIN_DEALERS = 2,' },
  threshold_one_dealer: { file: LN, suite: 'js2', from: 'const MIN_SENDS = 3, MIN_DEALERS = 2,', to: 'const MIN_SENDS = 3, MIN_DEALERS = 1,' },
  same_email_counts_twice: { file: LN, suite: 'js2', from: '        if(c.drafts.has(d.id)) continue;', to: '        if(false) continue;',
    also: { from: 'c.drafts.add(d.id);', to: 'c.drafts.add(d.id + Math.random());' } },
  unedited_counts: { file: LN, suite: 'js2', from: "if(!d || !d.sent_at || d.edited !== true ||", to: "if(!d || !d.sent_at ||" },
  // masking (non-identifying evidence)
  no_name_mask: { file: LN, suite: 'js2', from: '  s = s.replace(/(?<=[^.!?:]\\s)[A-Z][a-zA-Z\'’-]+/g, w => (KEEP_WORDS.has(w) ? w : "{name}"));', to: '' },
  no_dealer_mask: { file: LN, suite: 'js2', from: 'if(dealer && dealer.length >= 3)', to: 'if(false)' },
  no_number_mask: { file: LN, suite: 'js2', from: '       .replace(/\\b\\d+(?:[.,]\\d+)*\\b/g, "{number}");', to: ';' },
  unsafe_phrase_kept: { file: LN, suite: 'js2', from: "!/[0-9@]/.test(t) &&", to: '' },
  // who decides
  decider_from_request: { file: API, suite: 'js2', from: 'by: me.email, reason, instruction, expected_version: ev', to: 'by: b.by || me.email, reason, instruction, expected_version: ev' },
  anyone_may_learn: { file: API, suite: 'js2', from: 'if(String(me.role).toLowerCase() !== "president")', to: 'if(false)' },
  no_reason_check: { file: API, suite: 'js2', from: '      if(reason.length < 3 || reason.length > 500) return json(422, { error: "reason_required", message: "Give a short reason (3–500 characters)." });\n      let instruction;',
    to: '      let instruction;' },
  dry_run_writes: { file: API, suite: 'js2', from: '{ apply: b.dry_run !== true }', to: '{ apply: true }' },
  wording_unchecked: { file: API, suite: 'js2', from: '        instruction = LEARN.cleanInstruction(b.instruction);', to: '        instruction = String(b.instruction);' },
  conflict_hidden: { file: API, suite: 'js2', from: 'const DECIDE_HTTP = { decided: 200, president_only: 403, version_conflict: 409,', to: 'const DECIDE_HTTP = { decided: 200, president_only: 403, version_conflict: 200,' },
  // daily job
  cron_ignores_switch: { file: CRON, suite: 'js2', from: 'if (!(await flagOn(sbGet, RUN.SWITCH_SUGGEST))) out.learning = "switch off";\n    else {', to: '{' },
  cron_loose_switch: { file: '_flags.js', suite: 'js2', from: 'return f[name]===true;', to: 'return !!f[name];' },
  // database
  sql_threshold: { file: 'sql2', suite: 'pg2', from: 'if v_sends < 3 or v_dealers < 2 then', to: 'if v_sends < 2 then' },
  sql_any_staff_decides: { file: 'sql2', suite: 'pg2', from: "and lower(coalesce(role, '')) = 'president' and active is not false", to: '' },
  sql_no_version_check: { file: 'sql2', suite: 'pg2', from: "  if coalesce(nullif(p->>'expected_version', ''), '-1')::int <> v_cur then\n    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur);\n  end if;\n  select * into r",
    to: "  select * into r" },
  sql_no_lock: { file: 'sql2', suite: 'pg2', from: "  perform pg_advisory_xact_lock(hashtext('hcps_email_learning_profile'));\n  v_cur := public.hcps_email_rule_version();\n  if coalesce(nullif(p->>'expected_version', ''), '-1')::int <> v_cur then\n    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur);\n  end if;\n  select * into r",
    to: "  v_cur := public.hcps_email_rule_version();\n  if coalesce(nullif(p->>'expected_version', ''), '-1')::int <> v_cur then\n    return jsonb_build_object('ok', false, 'status', 'version_conflict', 'version', v_cur);\n  end if;\n  select * into r" },
  sql_note_changes_status: { file: 'sql2', suite: 'pg2', from: "         suggested_instruction = v_instr, updated_at = now()", to: "         suggested_instruction = v_instr, instruction = v_instr, updated_at = now()" },
  sql_guard_owner_any: { file: 'sql2', suite: 'pg2', from: "  if current_user <> v_owner then raise exception 'email_rule_guard: % is written only by its functions', tg_table_name; end if;", to: '' },
  sql_versions_editable: { file: 'sql2', suite: 'pg2', from: "    if tg_op <> 'INSERT' or v_op <> 'decide' then raise exception 'email_rule_guard: versions are insert-only, by a decision'; end if;",
    to: "    if v_op <> 'decide' then raise exception 'email_rule_guard: versions are insert-only, by a decision'; end if;" },
  sql_rls_off: { file: 'sql2', suite: 'pg2', from: 'alter table public.email_learning_rules enable row level security;', to: '' },
  sql_anon_reads: { file: 'sql2', suite: 'pg2', from: 'grant select on table public.email_learning_rules, public.email_learning_profiles, public.email_learning_rule_events to service_role;',
    to: 'grant select on table public.email_learning_rules, public.email_learning_profiles, public.email_learning_rule_events to service_role, anon;' },
  sql_digits_allowed: { file: 'sql2', suite: 'pg2', from: "check (pattern::text !~ '[0-9@]' and examples::text !~ '[0-9@]'", to: "check (true and examples::text !~ '[@]'" },
  sql_rollback_keeps_others: { file: 'sql2', suite: 'pg2', from: "               or (s.instruction is null and x.status = 'approved')", to: '' },
};
