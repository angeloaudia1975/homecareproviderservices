-- ============================================================================================
-- ROLLBACK of supabase/email_learning_p1_capture.sql. Turn the capture switch off and redeploy the code
-- without capture FIRST. Refuses while any draft is stored: removing them is a separate, explicit decision
-- (they are the owner's email content), never a side effect of a rollback.
-- ============================================================================================
begin;
do $$ begin
  if to_regclass('public.email_drafts') is not null and exists (select 1 from public.email_drafts) then
    raise exception 'email_learning_p1 rollback refused: email_drafts holds rows — decide separately what happens to them';
  end if;
end $$;
drop function if exists public.hcps_email_draft_purge_expired();
drop function if exists public.hcps_email_draft_record_send(jsonb);
drop function if exists public.hcps_email_draft_create(jsonb);
drop function if exists public.hcps_email_draft_sha(text, text);
drop table if exists public.email_drafts;
drop function if exists public.hcps_email_draft_guard();
commit;
select 'email_drafts removed' result, to_regclass('public.email_drafts') is null ok;
