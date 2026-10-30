-- READ-ONLY postcheck for supabase/email_learning_p2_rules.sql. Changes nothing. Every row: ok = true.
-- code_fp = md5 of the installed function bodies; expected values (both line-ending forms) are in docs/email-learning/PHASE2.md.
select * from (
  select 1 n, 'functions installed (7)' check_name, count(*)::text value, count(*) = 7 ok
    from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hcps_email_rule_guard','hcps_email_rule_president','hcps_email_rule_snapshot',
      'hcps_email_rule_version','hcps_email_rule_note','hcps_email_rule_decide','hcps_email_profile_rollback')
  union all select 2, 'code fingerprint', md5(string_agg(prosrc, '|' order by proname)), true
    from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hcps_email_rule_guard','hcps_email_rule_president','hcps_email_rule_snapshot',
      'hcps_email_rule_version','hcps_email_rule_note','hcps_email_rule_decide','hcps_email_profile_rollback')
  union all select 3, 'RLS on (3 tables), 0 policies', count(*) filter (where relrowsecurity) || ' / ' ||
         (select count(*) from pg_policy where polrelid in ('public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass)),
         count(*) filter (where relrowsecurity) = 3 and (select count(*) from pg_policy where polrelid in ('public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass)) = 0
    from pg_class where oid in ('public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass)
  union all select 4, 'anon / authenticated / PUBLIC grants (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('email_learning_rules','email_learning_profiles','email_learning_rule_events') and grantee in ('anon','authenticated','PUBLIC')
  union all select 5, 'guard triggers', count(*)::text, count(*) = 6
    from pg_trigger where tgrelid in ('public.email_learning_rules'::regclass,'public.email_learning_profiles'::regclass,'public.email_learning_rule_events'::regclass) and not tgisinternal
  union all select 6, 'suggestion switch', coalesce((select value->>'email_learning_suggest' from public.app_settings where key = 'phase2_flags'), 'absent'), true
  union all select 7, 'rules suggested / approved / versions', (select count(*) filter (where status = 'suggested') || ' / ' || count(*) filter (where status = 'approved') from public.email_learning_rules)
         || ' / ' || (select count(*) from public.email_learning_profiles), true
) c order by n;
