-- =============================================================================================
-- HCPS Academy — Phase A2A migration M1 ROLLBACK (rev 2)      supabase/academy_a2a_m1_rollback.sql
-- Removes the audited operations, their helpers and the guard triggers; touches no rows. Run ONLY with Angelo's
-- approval and only after the A2A code that calls these operations is switched off or reverted (otherwise those calls
-- fail). Removing the guards re-opens the plain-write road for sensitive changes, so this is never a reaction to a
-- suspected problem: investigate first (rule 19).
-- Drops every public function named academy_op_* plus academy_audited_guard, whatever its signature, so it also
-- removes any earlier M1 revision. It touches nothing else.
-- =============================================================================================
begin;
drop trigger if exists academy_audited_guard on public.academy_memberships;
drop trigger if exists academy_audited_guard on public.academy_external_certs;
drop trigger if exists academy_audited_guard on public.academy_certificates;
drop trigger if exists academy_audited_guard on public.academy_course_versions;
drop trigger if exists academy_audited_guard on public.academy_attempts;
drop trigger if exists academy_audited_guard on public.product_facts;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard') loop
    execute format('drop function %s', f.sig);
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard'))
     or exists (select 1 from pg_trigger where tgname = 'academy_audited_guard') then
    raise exception 'M1 rollback incomplete: an audited-operation function or guard trigger remains';
  end if;
end $$;
commit;
