-- HCPS Academy — C2 / M4 rollback. Restores the server role's EXECUTE on M1 publish / retire and removes the M4
-- functions. Refused while any course is published through a course status M4 wrote that M1 alone would not keep
-- consistent (a retired course, or a published manufacturer program): those decisions need a person first.
-- Redeploy the code from before M4 FIRST (it calls academy_publish_op_*), then run this.
begin;
do $$ begin
  if exists (select 1 from academy_courses where status = 'retired')
     or exists (select 1 from academy_courses where status = 'published' and course_type = 'manufacturer_program') then
    raise exception 'M4 rollback refused: retired courses or published manufacturer programs exist';
  end if;
end $$;
drop function if exists public.academy_publish_op_publish_version(text,uuid,text);
drop function if exists public.academy_publish_op_retire_version(text,uuid,text);
drop function if exists public.academy_publish_op_retire_course(text,uuid,text);
drop function if exists public.academy_publish_op_publish_course(text,uuid);
drop function if exists public.academy_publish_consistency();
drop function if exists public.academy_publish_set_course(text,uuid,text,text);
grant execute on function public.academy_op_publish_version(text,uuid) to service_role;
grant execute on function public.academy_op_retire_version(text,uuid,text) to service_role;
select 'M4 removed' as check, to_regprocedure('public.academy_publish_op_publish_version(text,uuid,text)') is null as ok;
commit;
