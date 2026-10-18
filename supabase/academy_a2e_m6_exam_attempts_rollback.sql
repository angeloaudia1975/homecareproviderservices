-- =============================================================================================
-- HCPS Academy — A2E / M6 ROLLBACK. Refused while any exam attempt exists (attempts are records that are never
-- rewritten or removed). Removes the M6 functions, trigger, columns and index and gives the server role back its
-- M1 start/submit rights and its table rights on academy_attempts, exactly as before M6.
-- =============================================================================================
begin;
do $$ begin
  if to_regprocedure('public.academy_exam_op_start(text,uuid)') is null then raise exception 'M6 is not installed'; end if;
  if exists (select 1 from academy_attempts) then raise exception 'M6 rollback refused: exam attempts exist'; end if;
end $$;
drop trigger academy_exam_attempt_defaults on public.academy_attempts;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_exam\_%'
  loop execute format('drop function %s', f.sig); end loop;
end $$;
drop index public.academy_attempts_learner_started;
alter table public.academy_attempts drop constraint academy_attempts_expiry,
  drop column learner_id, drop column expires_at, drop column draft_answers, drop column draft_saved_at, drop column expired;
alter table public.academy_course_versions drop column exam_time_limit_minutes, drop column exam_cooldown_minutes,
  drop column exam_daily_limit;
grant execute on function public.academy_op_start_attempt(text, uuid) to service_role;
grant execute on function public.academy_op_submit_attempt(text, uuid, jsonb) to service_role;
grant insert, update, delete on table public.academy_attempts to service_role;
select 'M6 removed' as check, to_regprocedure('public.academy_exam_op_start(text,uuid)') is null
   and has_function_privilege('service_role', 'public.academy_op_start_attempt(text,uuid)', 'execute') as ok;
commit;
