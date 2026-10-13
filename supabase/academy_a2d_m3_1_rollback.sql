-- =============================================================================================
-- HCPS Academy — A2D migration M3.1 ROLLBACK                 supabase/academy_a2d_m3_1_rollback.sql
-- Run ONLY with Angelo's approval, and only AFTER the Course Builder code that calls academy_save_op_lesson has been
-- reverted (the old builder saves through M3's set_blocks / link_fact / unlink_fact, which M3.1 never changed). With
-- the builder still calling it, a save would then answer "not available" (503) and change nothing.
-- What it does, in ONE transaction: drops the two functions named academy_save_* and nothing else; then refuses to
-- finish unless M1 (19 functions, 6 guard triggers), M2 (15 functions, 8 guard triggers) and M3 (24 functions,
-- 7 triggers) are intact. Touches no rows: lesson screens, fact links and the audit history (save_lesson rows included)
-- all stay. Never a reaction to a suspected problem: investigate first.
-- =============================================================================================
begin;
drop function if exists public.academy_save_op_lesson(text, uuid, jsonb, jsonb);
drop function if exists public.academy_save_lesson_links(jsonb);
do $$
begin
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_save\_%') then
    raise exception 'M3.1 rollback stopped: an academy_save_* function is still present.';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')) <> 19
     or (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) <> 6
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%') <> 15
     or (select count(*) from pg_trigger where tgname in ('academy_content_guard', 'academy_content_guard_truncate') and not tgisinternal) <> 8
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_%') <> 24
     or (select count(*) from pg_trigger where tgname like 'academy\_author\_%' and not tgisinternal) <> 7 then
    raise exception 'M3.1 rollback stopped: M1, M2 or M3 is not intact. Nothing was removed.';
  end if;
end $$;
commit;
