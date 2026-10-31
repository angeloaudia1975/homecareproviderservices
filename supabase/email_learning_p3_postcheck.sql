-- READ-ONLY postcheck for supabase/email_learning_p3_shapes_redact.sql. Changes nothing. Every row: ok = true.
-- code_fp = md5 of the installed Phase 2 + Phase 3 function bodies; expected values (both line-ending forms) are in
-- docs/email-learning/PHASE3.md. (The Phase 2 postcheck's row 2 changes after this migration, by design.)
select * from (
  select 1 n, 'functions installed (10)' check_name, count(*)::text value, count(*) = 10 ok
    from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hcps_email_rule_guard','hcps_email_rule_president','hcps_email_rule_snapshot',
      'hcps_email_rule_version','hcps_email_rule_note','hcps_email_rule_decide','hcps_email_profile_rollback',
      'hcps_email_rule_redact','hcps_email_draft_shape','hcps_email_draft_shape_guard')
  union all select 2, 'code fingerprint', md5(string_agg(prosrc, '|' order by proname)), true
    from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hcps_email_rule_guard','hcps_email_rule_president','hcps_email_rule_snapshot',
      'hcps_email_rule_version','hcps_email_rule_note','hcps_email_rule_decide','hcps_email_profile_rollback',
      'hcps_email_rule_redact','hcps_email_draft_shape','hcps_email_draft_shape_guard')
  union all select 3, 'RLS on (4 tables), 0 policies', count(*) filter (where relrowsecurity) || ' / ' ||
         (select count(*) from pg_policy where polrelid in ('public.email_draft_shapes'::regclass,'public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass)),
         count(*) filter (where relrowsecurity) = 4 and (select count(*) from pg_policy where polrelid in ('public.email_draft_shapes'::regclass,'public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass)) = 0
    from pg_class where oid in ('public.email_draft_shapes'::regclass,'public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass)
  union all select 4, 'anon / authenticated / PUBLIC grants (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('email_draft_shapes','email_learning_rules','email_learning_profiles','email_learning_rule_events') and grantee in ('anon','authenticated','PUBLIC')
  union all select 5, 'guard triggers (8)', count(*)::text, count(*) = 8
    from pg_trigger where tgrelid in ('public.email_draft_shapes'::regclass,'public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass) and not tgisinternal
  union all select 6, 'Phase 3 switches (apply / ai_headsup / styles)', coalesce((select concat_ws(' / ', coalesce(value->>'email_learning_apply','absent'),
           coalesce(value->>'email_ai_headsup','absent'), coalesce(value->>'email_styles','absent')) from public.app_settings where key = 'phase2_flags'), 'absent'), true
  union all select 7, 'shapes / redacted rules', (select count(*) from public.email_draft_shapes) || ' / ' || (select count(*) from public.email_learning_rules where redacted_at is not null), true
) c order by n;
