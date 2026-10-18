-- HCPS Academy — A2B / M5 rollback. Removes the M5 operations and tables and gives the server role back its A1 rights
-- on the learner-side tables. Refused while ANY learner-side record exists (learners, memberships, invites, handoff
-- codes, login codes, sessions, enrollments, progress): those are people's records and need a person's decision first.
-- Redeploy the code from before A2B FIRST (it calls the M5 operations), then run this.
begin;
do $$ begin
  if to_regprocedure('public.academy_access_op_request_code(text,text,text)') is null then
    raise exception 'M5 is not installed';
  end if;
  if exists (select 1 from academy_learners) or exists (select 1 from academy_memberships) or exists (select 1 from academy_invites)
     or exists (select 1 from academy_handoff_codes) or exists (select 1 from academy_login_codes) or exists (select 1 from academy_sessions)
     or exists (select 1 from academy_enrollments) or exists (select 1 from academy_progress) then
    raise exception 'M5 rollback refused: learner records exist';
  end if;
end $$;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'academy_access_%' or p.proname like 'academy_enroll_op_%'
                                            or p.proname like 'academy_progress_op_%')
  loop execute format('drop function %s', f.sig); end loop;
end $$;
drop table public.academy_sessions;
drop table public.academy_login_codes;
alter table public.academy_learners drop constraint academy_learners_email_shape;
drop index public.academy_learners_email_uk;
alter table public.academy_learners alter column auth_user_id set not null;
do $$
declare t text;
begin
  foreach t in array array['academy_learners','academy_memberships','academy_invites','academy_handoff_codes','academy_enrollments','academy_progress']
  loop execute format('grant select, insert, update, delete on table public.%I to service_role', t); end loop;
end $$;
select 'M5 removed' as check, to_regprocedure('public.academy_access_op_request_code(text,text,text)') is null
   and to_regclass('public.academy_sessions') is null
   and has_table_privilege('service_role', 'public.academy_learners', 'insert') as ok;
commit;
