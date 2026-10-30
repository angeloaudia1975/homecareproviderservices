-- READ-ONLY postcheck for supabase/email_learning_p1_capture.sql. Changes nothing. Every row: ok = true.
-- code_fp = md5 of the installed function bodies; expected values (both line-ending forms, see the PR) are listed in
-- docs/email-learning/PHASE1.md — the SQL editor stores a pasted file with Windows line endings.
select * from (
  select 1 n, 'functions installed (4)' check_name, count(*)::text value, count(*) = 4 ok
    from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hcps_email_draft_create','hcps_email_draft_record_send','hcps_email_draft_purge_expired','hcps_email_draft_sha')
  union all select 2, 'code fingerprint', md5(string_agg(prosrc, '|' order by proname)), true
    from pg_proc where pronamespace = 'public'::regnamespace and proname in ('hcps_email_draft_create','hcps_email_draft_record_send','hcps_email_draft_purge_expired','hcps_email_draft_sha','hcps_email_draft_guard')
  union all select 3, 'RLS on, 0 policies', (select relrowsecurity::text from pg_class where oid = 'public.email_drafts'::regclass) || ' / ' ||
         (select count(*) from pg_policy where polrelid = 'public.email_drafts'::regclass)::text,
         (select relrowsecurity from pg_class where oid = 'public.email_drafts'::regclass) and (select count(*) from pg_policy where polrelid = 'public.email_drafts'::regclass) = 0
  union all select 4, 'anon / authenticated / PUBLIC grants (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'email_drafts' and grantee in ('anon','authenticated','PUBLIC')
  union all select 5, 'guard triggers', count(*)::text, count(*) = 2 from pg_trigger where tgrelid = 'public.email_drafts'::regclass and not tgisinternal
  union all select 6, 'capture switch', coalesce((select value->>'email_learning_capture' from public.app_settings where key = 'phase2_flags'), 'absent'), true
  union all select 7, 'drafts kept / sent / edited', (select count(*) || ' / ' || count(sent_at) || ' / ' || count(*) filter (where edited) from public.email_drafts), true
) c order by n;
