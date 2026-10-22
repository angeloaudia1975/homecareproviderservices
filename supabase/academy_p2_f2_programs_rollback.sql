-- HCPS Academy — Phase 2 / F2 ROLLBACK. Removes the program-page table and the three operations. Refused while any
-- program page or any learner self-report / certificate upload made through F2 exists (records are never thrown away by a
-- rollback). Learners' credential rows (academy_external_certs, A1) are not touched by this file.
begin;
do $$ begin
  if to_regclass('public.academy_program_details') is null then raise exception 'F2 is not installed'; end if;
  if exists (select 1 from academy_program_details)
     or exists (select 1 from academy_events where action in ('ext_watched','ext_quiz_submitted','ext_certificate')) then
    raise exception 'F2 rollback refused: program pages or learner steps exist';
  end if;
end $$;
drop table public.academy_program_details;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_%'
  loop execute format('drop function %s', f.sig); end loop;
end $$;
commit;
