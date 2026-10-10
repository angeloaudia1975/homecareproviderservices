-- =============================================================================================
-- HCPS Academy — Phase A1 foundation ROLLBACK           supabase/academy_a1_foundation_rollback.sql
-- Removes ONLY what academy_a1_foundation.sql created. Touches nothing else.
--
-- Safe by default: it refuses to run if any learner record, exam attempt or certificate exists,
-- because dropping them would destroy certification history. To roll back after real use,
-- export the academy tables first, then run with:   set academy.rollback_confirm = 'drop-learner-data';
-- Do not run it merely because a problem is suspected: investigate first (project rule).
-- =============================================================================================
begin;

do $$
declare n bigint := 0;
begin
  if to_regclass('public.academy_learners') is not null then
    select (select count(*) from public.academy_learners)
         + (select count(*) from public.academy_attempts)
         + (select count(*) from public.academy_certificates) into n;
  end if;
  if n > 0 and coalesce(current_setting('academy.rollback_confirm', true), '') <> 'drop-learner-data' then
    raise exception 'Academy holds % learner, attempt or certificate rows. Export them, then set academy.rollback_confirm.', n;
  end if;
end $$;

-- Bucket: refuse if it still holds files (Storage objects must be removed through the Storage API).
do $$
begin
  if exists (select 1 from storage.objects where bucket_id = 'academy-private') then
    raise exception 'academy-private still holds files. Remove them through Storage first.';
  end if;
end $$;
delete from storage.buckets where id = 'academy-private';

delete from public.app_settings where key = 'academy';

drop table if exists
  public.academy_events,
  public.academy_external_certs,
  public.academy_certificates,
  public.academy_attempts,
  public.academy_progress,
  public.academy_enrollments,
  public.academy_content_refs,
  public.academy_questions,
  public.academy_lessons,
  public.academy_modules,
  public.academy_course_versions,
  public.academy_courses,
  public.academy_media,
  public.academy_handoff_codes,
  public.academy_invites,
  public.academy_memberships,
  public.academy_learners,
  public.product_facts;   -- no CASCADE: if anything outside the academy depends on these, stop and investigate

drop function if exists public.academy_block_frozen_content();
drop function if exists public.academy_course_versions_guard();
drop function if exists public.product_facts_append_only();
drop function if exists public.academy_events_append_only();
drop function if exists public.academy_certificates_guard();

commit;
