-- =============================================================================================
-- HCPS Academy — Phase A2A migration M1 ROLLBACK              supabase/academy_a2a_m1_rollback.sql
-- Removes the audited operations and their guard triggers; touches no rows. Run ONLY with Angelo's approval and
-- only after the A2A code that calls these operations is switched off or reverted (otherwise those calls fail).
-- Removing the guards re-opens the plain-write road for sensitive changes, so this is never a reaction to a
-- suspected problem: investigate first (rule 19).
-- =============================================================================================
begin;
drop trigger if exists academy_audited_guard on public.academy_memberships;
drop trigger if exists academy_audited_guard on public.academy_external_certs;
drop trigger if exists academy_audited_guard on public.academy_certificates;
drop trigger if exists academy_audited_guard on public.academy_course_versions;
drop trigger if exists academy_audited_guard on public.academy_attempts;
drop trigger if exists academy_audited_guard on public.product_facts;
drop function if exists public.academy_audited_guard();
drop function if exists public.academy_op_set_training_manager(text, uuid, boolean, text);
drop function if exists public.academy_op_review_external_cert(text, uuid, text, text, text, text);
drop function if exists public.academy_op_issue_certificate(text, text, uuid, text);
drop function if exists public.academy_op_revoke_certificate(text, uuid, text);
drop function if exists public.academy_op_publish_version(text, uuid);
drop function if exists public.academy_op_retire_version(text, uuid, text);
drop function if exists public.academy_op_submit_attempt(text, uuid, jsonb);
drop function if exists public.academy_op_correct_attempt(text, uuid, int, boolean, text);
drop function if exists public.academy_op_record_fact(text, jsonb, uuid, text);
drop function if exists public.academy_op_withdraw_fact(text, uuid, text);
drop function if exists public.academy_op_norm_answer(jsonb);
drop function if exists public.academy_op_audit(text, text, text, text, text, jsonb, jsonb);
drop function if exists public.academy_op_end();
drop function if exists public.academy_op_begin(text, text);
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')) then
    raise exception 'M1 rollback incomplete: an audited-operation function remains';
  end if;
end $$;
commit;
