-- ROLLBACK of supabase/email_learning_p2_rules.sql (Smart Email Learning Phase 2). Phase 1 (email_drafts) is untouched.
-- Turn phase2_flags.email_learning_suggest off first. Refuses while any rule, version or event exists: removing the
-- owner's decisions is its own decision.
begin;
do $$ begin
  if to_regclass('public.email_learning_rules') is not null and (
       (select count(*) from public.email_learning_rules) > 0 or (select count(*) from public.email_learning_profiles) > 0
       or (select count(*) from public.email_learning_rule_events) > 0) then
    raise exception 'email_learning_p2 rollback: rules, versions or events exist — nothing removed';
  end if;
end $$;
drop function if exists public.hcps_email_profile_rollback(jsonb);
drop function if exists public.hcps_email_rule_decide(jsonb);
drop function if exists public.hcps_email_rule_note(jsonb);
drop function if exists public.hcps_email_rule_version();
drop function if exists public.hcps_email_rule_snapshot();
drop function if exists public.hcps_email_rule_president(text);
drop table if exists public.email_learning_rule_events;
drop table if exists public.email_learning_profiles;
drop table if exists public.email_learning_rules;
drop function if exists public.hcps_email_rule_guard();
commit;
select 'email_learning_p2 removed' as result, to_regclass('public.email_drafts') is not null as phase1_still_installed;
