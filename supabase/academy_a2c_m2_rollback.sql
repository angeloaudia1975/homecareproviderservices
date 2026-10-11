-- =============================================================================================
-- HCPS Academy — A2C migration M2 ROLLBACK                   supabase/academy_a2c_m2_rollback.sql
-- Removes the content operations, their helpers and the content guard triggers; touches no rows. Run ONLY with
-- Angelo's approval and only after the Command Center code that calls these operations is switched off or reverted
-- (otherwise those calls fail with "unavailable"). Removing the guard re-opens plain writes to courses, versions,
-- modules and lessons, so this is never a reaction to a suspected problem: investigate first (rule 19).
-- Drops every public function named academy_content_* whatever its signature, and the 4 academy_content_guard
-- triggers. M1 (academy_op_*, academy_audited_guard and its 6 triggers) and the A1 rule triggers are NOT touched; the
-- last block refuses to finish unless M1's 19 functions and 6 triggers are all still there.
-- =============================================================================================
begin;
drop trigger if exists academy_content_guard on public.academy_courses;
drop trigger if exists academy_content_guard on public.academy_course_versions;
drop trigger if exists academy_content_guard on public.academy_modules;
drop trigger if exists academy_content_guard on public.academy_lessons;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_content\_%' loop
    execute format('drop function %s', f.sig);
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'academy\_content\_%')
     or exists (select 1 from pg_trigger where tgname = 'academy_content_guard') then
    raise exception 'M2 rollback incomplete: a content-operation function or guard trigger remains';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')) <> 19
     or (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) <> 6 then
    raise exception 'M2 rollback stopped: M1 is not intact (expected 19 functions and 6 guard triggers). Nothing was removed.';
  end if;
end $$;
commit;
