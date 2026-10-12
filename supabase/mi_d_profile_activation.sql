-- MI Phase D — switch FOUR manufacturer report profiles to automatic REGISTRATION (Angelo runs this; Claude never does).
--
-- Decided by the read-only profile trial over Angelo's mailbox, 1 Oct 2025 → 12 Oct 2026 (mfr-reports-api profile_trial,
-- the capture's own inspect / decide code), 2026-10-12:
--   bemis           705-YYYY-MM.csv · Jun, Jul, Aug 2026 → 3 would register, both resends recognised as copies, 0 exceptions
--   airavant        QuickBooks "Commissions – Cash Basis" PDF · Jun, Jul 2026 → 2 would register; 1 exception (rep agreement PDF)
--   access4u        monthly XLSX · Sep 2025 → Aug 2026 → 11 would register (Nov+Dec and Jul+Aug combined, "Angelo Report.xlsx"
--                   a second May file → registered with "possible correction" for a person); 2 exceptions (customer / transaction lists)
--   ohio-medical    "commission detail MMYY.xlsx" · every month → 12 would register. Two rule changes (below):
--                     · period = the month the statement runs THROUGH (not Jan → that month), the file stays marked cumulative in
--                       its note; without it every cumulative file would cover the whole year so far
--                     · "ZOL SPIFF …" workbook sent beside it every month → classified "not a report" (ignore_file_name), not an
--                       exception each month
-- NOT activated: climbing-steps — reply emails in a thread ("RE: May 2026 Commissions") would each register as a statement
--   (4 for September 2025, 4 for May 2026); stays draft until the body-only rule ignores replies. complete-medical, ovation,
--   pedifix, golden stay draft (not in this step).
--
-- Registration ONLY: auto_import stays false (the table refuses true), nothing is accepted, imported or published, commission
-- posting stays OFF. Capture starts from its checkpoint (1 Oct 2026 onward) — NO historical backfill.
-- Only these four rows change; each is refused unless it is exactly the reviewed draft (status draft, auto_register false,
-- rules equal to the seeded rules). One transaction; a second run is refused ("already active").
begin;
do $$
declare
  v_owner text; n int;
  v_expected jsonb := jsonb_build_object(
    'bemis:commission_statement:rep705', 'draft',
    'airavant-bongorx:commission_statement:cash_basis', 'draft',
    'access4u:commission_statement:monthly', 'draft',
    'ohio-medical:commission_statement:through', 'draft');
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'public.mfr_report_profiles'::regclass;
  if current_user <> v_owner then raise exception 'mi_d: run as the table owner (%), in the SQL editor', v_owner; end if;
  select count(*) into n from public.mfr_report_profiles
   where code in (select jsonb_object_keys(v_expected)) and status = 'draft' and auto_register = false and auto_import = false;
  if n <> 4 then raise exception 'mi_d: expected the 4 reviewed draft profiles, found % in that state — nothing written (already active?)', n; end if;
  if (select rules from public.mfr_report_profiles where code = 'ohio-medical:commission_statement:through')
     <> '{"senders":{"domains":["ohiomedical.com"]},"formats":["xlsx"],"content":{"sheet_names_any":["Current month payment","Sales-Commission Data"]},"period":{"order":["subject"],"cumulative":true,"subject_year":"from_received"},"expected":{"cadence":"monthly","days":[21,29]}}'::jsonb
  then raise exception 'mi_d: the Ohio Medical rules are not the seeded rules — nothing written'; end if;

  perform set_config('hcps.capture_op', 'on', true);
  update public.mfr_report_profiles
     set status = 'active', auto_register = true, updated_at = now(), updated_by = 'angelo@homecareproviderservices.us (sql-editor, MI Phase D)',
         note = coalesce(note || ' ', '') || 'Activated for automatic registration 2026-10-12 after the read-only profile trial (registration only; no import).'
   where code in ('bemis:commission_statement:rep705', 'airavant-bongorx:commission_statement:cash_basis', 'access4u:commission_statement:monthly')
     and status = 'draft';
  get diagnostics n = row_count; if n <> 3 then raise exception 'mi_d: expected 3 rows, changed %', n; end if;
  update public.mfr_report_profiles
     set status = 'active', auto_register = true, updated_at = now(), updated_by = 'angelo@homecareproviderservices.us (sql-editor, MI Phase D)',
         rules = jsonb_set(rules, '{period,cumulative}', 'false'::jsonb) || '{"ignore_file_name":"^ZOL SPIFF"}'::jsonb,
         note = coalesce(note || ' ', '') || 'Activated 2026-10-12 (registration only). Period = the month the statement runs through; each file is year-to-date (cumulative). ZOL SPIFF workbooks are not reports.'
   where code = 'ohio-medical:commission_statement:through' and status = 'draft';
  get diagnostics n = row_count; if n <> 1 then raise exception 'mi_d: expected 1 Ohio row, changed %', n; end if;
  perform set_config('hcps.capture_op', 'off', true);
end $$;
commit;

-- CHECK (read-only; the SQL editor shows only this last result). Expect 4 active rows with auto_register true, auto_import
-- false, and Ohio's period cumulative false + ignore_file_name; every other profile unchanged (draft or as before).
select code, status, auto_register, auto_import, rules->'period' as period, rules->>'ignore_file_name' as ignore_file_name
  from public.mfr_report_profiles order by status, code;
