-- MI Phase D — switch the Climbing Steps report profile to automatic REGISTRATION (Angelo runs this; Claude never does).
--
-- Decided by the read-only profile trial over Angelo's mailbox, 1 Oct 2025 → 12 Oct 2026 (mfr-reports-api profile_trial with
-- the reply / forward rule deployed and this file-name rule tried in memory), 2026-10-12:
--   one statement per month — Sep 2025 (email body), Oct ("October 2025.xlsx"), Nov, Dec 2025, Jan, Mar, May 2026 (files),
--   Aug 2026 (email body); every RE: / FW: reply is classified (body never registered; a file in a reply only when no record
--   of that month exists); 0 exceptions. Feb, Apr, Jun, Jul 2026: no statement in the mailbox (as in the Phase A inventory).
-- One rule change: the file-name rule also accepts a month-name file ("October 2025.xlsx"); nothing else in its rules changes.
-- Registration ONLY: auto_import stays false (the table refuses true); nothing is accepted, imported or published. Capture
-- starts from its checkpoint — NO historical backfill. Only this one row changes; refused unless it is exactly the seeded
-- draft. One transaction; a second run is refused ("already active").
begin;
do $$
declare v_owner text; n int;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'public.mfr_report_profiles'::regclass;
  if current_user <> v_owner then raise exception 'mi_d_cs: run as the table owner (%), in the SQL editor', v_owner; end if;
  select count(*) into n from public.mfr_report_profiles
   where code = 'climbing-steps:commission_statement:monthly' and status = 'draft' and auto_register = false and auto_import = false
     and rules = '{"senders":{"domains":["climbingsteps.com"]},"formats":["xls","xlsx"],"file_name":"commi?ss?ion|comms","body_only":true,"period":{"order":["subject","file_name"]},"expected":{"cadence":"monthly","days":[4,12]}}'::jsonb;
  if n <> 1 then raise exception 'mi_d_cs: expected the reviewed Climbing Steps draft profile (seeded rules), found % — nothing written (already active?)', n; end if;

  perform set_config('hcps.capture_op', 'on', true);
  update public.mfr_report_profiles
     set status = 'active', auto_register = true, updated_at = now(), updated_by = 'angelo@homecareproviderservices.us (sql-editor, MI Phase D)',
         rules = jsonb_set(rules, '{file_name}', to_jsonb('commi?ss?ion|comms|^(january|february|march|april|may|june|july|august|september|october|november|december) \d{4}\.xlsx?$'::text)),
         note = coalesce(note || ' ', '') || 'Activated 2026-10-12 (registration only) after the read-only profile trial. Replies / forwards never register a body; month-name files ("October 2025.xlsx") are statements.'
   where code = 'climbing-steps:commission_statement:monthly' and status = 'draft';
  get diagnostics n = row_count; if n <> 1 then raise exception 'mi_d_cs: expected 1 row, changed %', n; end if;
  perform set_config('hcps.capture_op', 'off', true);
end $$;
commit;

-- CHECK (read-only; the SQL editor shows only this last result). Expect climbing-steps active / true / false with the new
-- file-name rule; the other 7 active and 4 draft profiles as before.
select code, status, auto_register, auto_import, rules->>'file_name' as file_name
  from public.mfr_report_profiles order by status, code;
