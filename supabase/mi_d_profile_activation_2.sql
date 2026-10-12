-- MI Phase D — switch Complete Medical and Ovation report profiles to automatic REGISTRATION (Angelo runs this; Claude never does).
--
-- Decided by the read-only profile trials over Angelo's mailbox, 1 Oct 2025 → 12 Oct 2026 (mfr-reports-api profile_trial with the
-- proposed rules tried in memory), 2026-10-12:
--   complete-medical-supplies  10 statements, one per month (Aug 2025 → May 2026); the "Jan and Feb" email registers Jan and Feb
--                              separately (month name in the file name); 0 order acknowledgments, quotes, invoices, flyers or
--                              sell sheets registered; 0 exceptions. Rule changes: file name must say "commission"
--                              ("^homecare providers.*commi" — keeps out the "Homecare Providers flyer" list); period from the
--                              month name in the file name first; xls accepted.
--   ovation-medical            2 statements (2605 May, 2606 June 2026); the reply copy of June not registered; the 2026 price list
--                              ("… PriceList Commission Rate …") classified as a price list, never a statement; 0 exceptions.
--                              Rule changes: file name must say "summary"; expected window 13th–20th of the following month.
-- NOT activated: pedifix (its only YTD export states no period a machine can read; sent on request) and golden-technologies (no
--   commission statement found in 12 months — only order acknowledgments, quotes, inventory lists); both stay draft.
-- Registration ONLY: auto_import stays false; nothing accepted, imported or published. Capture starts from its checkpoint — NO
-- historical backfill. Only these two rows change; each is refused unless it is exactly the seeded draft. A second run is refused.
begin;
do $$
declare v_owner text; n int;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'public.mfr_report_profiles'::regclass;
  if current_user <> v_owner then raise exception 'mi_d2: run as the table owner (%), in the SQL editor', v_owner; end if;
  select count(*) into n from public.mfr_report_profiles
   where status = 'draft' and auto_register = false and auto_import = false and (
     (code = 'complete-medical-supplies:commission_statement:monthly' and rules = '{"senders":{"domains":["completemedical.com"]},"formats":["xlsx","pdf"],"file_name":"^homecare providers","period":{"order":["file_name","subject"]},"expected":{"cadence":"irregular"}}'::jsonb)
     or (code = 'ovation-medical:commission_statement:summary' and rules = '{"senders":{"domains":["ovationmed.com"]},"formats":["xlsx"],"file_name":"^\\d{4}\\s","period":{"order":["file_name_yymm","subject"]},"expected":{"cadence":"monthly"}}'::jsonb));
  if n <> 2 then raise exception 'mi_d2: expected the 2 reviewed draft profiles (seeded rules), found % — nothing written (already active?)', n; end if;

  perform set_config('hcps.capture_op', 'on', true);
  update public.mfr_report_profiles
     set status = 'active', auto_register = true, updated_at = now(), updated_by = 'angelo@homecareproviderservices.us (sql-editor, MI Phase D)',
         rules = '{"senders":{"domains":["completemedical.com"]},"formats":["xlsx","xls","pdf"],"file_name":"^homecare providers.*commi","period":{"order":["file_name_month","file_name","subject"]},"expected":{"cadence":"irregular"}}'::jsonb,
         note = coalesce(note || ' ', '') || 'Activated 2026-10-12 (registration only) after the read-only profile trial: one statement per month, month taken from the file name.'
   where code = 'complete-medical-supplies:commission_statement:monthly' and status = 'draft';
  get diagnostics n = row_count; if n <> 1 then raise exception 'mi_d2: expected 1 Complete Medical row, changed %', n; end if;
  update public.mfr_report_profiles
     set status = 'active', auto_register = true, updated_at = now(), updated_by = 'angelo@homecareproviderservices.us (sql-editor, MI Phase D)',
         rules = '{"senders":{"domains":["ovationmed.com"]},"formats":["xlsx"],"file_name":"^\\d{4}\\s.*summary","period":{"order":["file_name_yymm","subject"]},"expected":{"cadence":"monthly","days":[13,20]}}'::jsonb,
         note = coalesce(note || ' ', '') || 'Activated 2026-10-12 (registration only) after the read-only profile trial. Price lists / rate sheets are never statements.'
   where code = 'ovation-medical:commission_statement:summary' and status = 'draft';
  get diagnostics n = row_count; if n <> 1 then raise exception 'mi_d2: expected 1 Ovation row, changed %', n; end if;
  perform set_config('hcps.capture_op', 'off', true);
end $$;
commit;

-- CHECK (read-only; the SQL editor shows only this last result). Expect 10 active / 2 draft (pedifix, golden); the two new rows
-- active / true / false with the rules above.
select code, status, auto_register, auto_import, rules->>'file_name' as file_name, rules->'period'->'order' as period_order, rules->'expected' as expected
  from public.mfr_report_profiles order by status, code;
