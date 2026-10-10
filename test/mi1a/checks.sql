-- MI-1a rev 2 behaviour checks on the local fixture. Each block raises on failure (ON_ERROR_STOP).
\set QUIET on
set client_min_messages = notice;
create or replace function t_expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm like p_like then raise notice 'ok   refused as expected: %', left(sqlerrm, 100); return; end if;
    raise exception 'FAIL wrong error: % (wanted %)', sqlerrm, p_like; end;
  raise exception 'FAIL expected an error like %', p_like;
end $$;
create or replace function t_snap() returns text language sql as $$
  select md5(string_agg(concat_ws('|', id, manufacturer, source, period, dealer_id, amount, commission, external_ref, batch_id, source_file), ';' order by id::text)) from monthly_sales $$;
create or replace function t_row(i_no text, sku text, qty numeric, amt numeric, d date, dealer uuid, cust text default 'Williams Brothers', ref text default 'wbhcp') returns jsonb language sql as $$
  select jsonb_build_object('manufacturer','strongback-mobility','period',date_trunc('month',d)::date,'order_date',d,'invoice_no',i_no,
    'product_code',sku,'product_name',sku,'qty',qty,'amount',amt,'commission',round(amt*0.09,2),'commission_rate',0.09,
    'customer_name',cust,'customer_ref',ref,'dealer_id',dealer,'line_type',case when amt>0 then 'sale' else 'collateral' end,'rep_name','Angelo Audia') $$;
create or replace function t_c(mfr text, per date, cust text, inv text, code text, qty numeric, amt numeric, com numeric) returns jsonb language sql as $$
  select jsonb_build_object('manufacturer',mfr,'period',per,'customer_name',cust,'invoice_no',inv,'product_code',code,'qty',qty,'amount',amt,'commission',com) $$;
create or replace function t_cfile(mfr text, file text, months jsonb, decisions jsonb default '{}', apply boolean default true, paid boolean default false, reason text default null) returns jsonb language sql as $$
  select hcps_commission_file_apply(jsonb_build_object('manufacturer',mfr,'source_file',file,'months',months,'decisions',decisions,
    'apply',apply,'approve_paid',paid,'approve_reason',reason,'actor','angelo')) $$;

-- ===== Baseline: re-key + enrolment =====
do $$ begin
  assert (select count(*) from monthly_sales where manufacturer='strongback-mobility' and external_ref like 'strongback-mobility|v2|%') = 8, 'rekeyed';
  assert (select sum(amount) from monthly_sales where manufacturer='strongback-mobility') = 3602, 'sum unchanged';
  assert exists (select 1 from mi1a_enrollment where manufacturer='strongback-mobility' and lane='sales_report'), 'strongback enrolled';
  assert (select count(*) from mi1a_enrollment) = 1, 'only strongback enrolled';
  raise notice 'ok   re-key: totals unchanged, Strongback enrolled, nothing else enrolled';
end $$;

-- ===== SAFEGUARD 3: identity only for audited manufacturers; semantic collisions blocked =====
select t_expect_error($q$select hcps_sales_report_apply(jsonb_build_object('manufacturer','pedifix','apply',false,'rows','[]'::jsonb))$q$, 'mi1a_identity_not_approved%');
do $$ declare r jsonb; s text := t_snap(); begin   -- same invoice number, a different order 13 months later
  r := hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',false,'rows', jsonb_build_array(
     t_row('6491','1010-2025',1,536,'2027-05-02',null))));
  assert jsonb_array_length(r->'semantic_collisions') = 1 and r->'semantic_collisions'->0->>'where' = 'vs_hcps', 'collision vs hcps found';
  assert t_snap() = s, 'preview wrote nothing';
  raise notice 'ok   collision: reused invoice number with a date 13 months away is flagged in preview';
end $$;
select t_expect_error($q$select hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'rows', jsonb_build_array(
     t_row('6491','1010-2025',1,536,'2027-05-02',null))))$q$, 'mi1a_semantic_collision%');
select t_expect_error($q$select hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'rows', jsonb_build_array(
     t_row('9100','ES0001',1,440,'2026-08-01',null,'Lacey Drug','lacey'), t_row('9100','1007-2025',1,536,'2026-08-01',null,'Davis Drugs','davis'))))$q$, 'mi1a_semantic_collision%');
do $$ declare r jsonb; begin   -- a genuinely repeated invoice line on one order is NOT a collision
  r := hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',false,'rows', jsonb_build_array(
     t_row('6491','1010-2025',1,536,'2026-04-15',null), t_row('6491','1010-2025',1,536,'2026-04-15',null), t_row('6491','Brochure Trifold',1,0,'2026-04-15',null))));
  assert jsonb_array_length(r->'semantic_collisions') = 0 and (r->'orders'->>'unchanged')::int = 1, 'repeated lines fine';
  raise notice 'ok   repeated identical lines on one invoice: kept, no collision';
end $$;

-- ===== Core sales behaviour (rev 1, still required) =====
do $$ declare r jsonb; s text := t_snap(); begin
  r := hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'source_file','reordered.xlsx','rows', jsonb_build_array(
     t_row('7001','1007-2025',1,536,'2026-07-09','00000000-0000-0000-0000-00000000000c'),
     t_row('6491','Brochure Trifold',1,0,'2026-04-15','00000000-0000-0000-0000-00000000000a'),
     t_row('6491','1010-2025',1,536,'2026-04-15','00000000-0000-0000-0000-00000000000a'),
     t_row('6491','1010-2025',1,536,'2026-04-15','00000000-0000-0000-0000-00000000000a'))));
  assert (r->>'noop')::boolean and t_snap() = s, 'reordered = noop';
  raise notice 'ok   reordered file with repeated lines: no-op, 0 rows written';
end $$;

-- ===== SAFEGUARD 4: non-financial differences reported; confirmed attribution kept =====
do $$ declare r jsonb; s text := t_snap(); begin
  r := hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'rows', jsonb_build_array(
     jsonb_set(jsonb_set(t_row('7001','1007-2025',1,536,'2026-07-09','00000000-0000-0000-0000-00000000000a','Williams Bros HQ'),
       '{ship_city}','"Washington"'), '{ship_zip}','"47501"'))));
  assert (r->>'noop')::boolean and t_snap() = s, 'money unchanged -> nothing written';
  assert exists (select 1 from jsonb_array_elements(r->'nonfinancial_differences') d where d->>'field'='dealer_id' and d->>'kept'='hcps'), 'dealer diff reported';
  assert (select count(*) from jsonb_array_elements(r->'nonfinancial_differences') d where d->>'field' in ('customer_name','ship_city','ship_zip')) = 3, 'name/ship diffs reported';
  assert (select dealer_id from monthly_sales where invoice_no='7001') = '00000000-0000-0000-0000-00000000000c', 'Vincennes kept';
  raise notice 'ok   non-financial: dealer, name, ship-to differences listed; Vincennes attribution kept; nothing written';
end $$;
do $$ declare r jsonb; begin   -- on a real correction the differences are recorded on the batch
  r := hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'actor','angelo','rows', jsonb_build_array(
     t_row('7001','1007-2025',2,1072,'2026-07-09','00000000-0000-0000-0000-00000000000a','Williams Bros HQ'))));
  assert (select dealer_id from monthly_sales where invoice_no='7001') = '00000000-0000-0000-0000-00000000000c', 'branch kept on correction';
  assert jsonb_array_length((select summary->'nonfinancial_differences' from mfr_report_batches where id=(r->>'batch_id')::uuid)) >= 1, 'diffs stored on batch';
  assert (select (row_data->>'amount')::numeric from monthly_sales_superseded where reason='corrected') = 536, 'old archived';
  raise notice 'ok   correction: replaced, archived, branch kept, differences stored on the batch';
end $$;

-- Paid month protection and atomic failure (rev 1).
insert into commission_period_locks(manufacturer, period, locked_by) values ('strongback-mobility','2026-04-01','angelo');
select t_expect_error($q$select hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'rows',
  jsonb_build_array(t_row('6491','1010-2025',1,536,'2026-04-15',null))))$q$, 'mi1a_paid_period_change%');
do $$ declare s text := t_snap(); a int := (select count(*) from monthly_sales_superseded); begin
  begin
    perform hcps_sales_report_apply(jsonb_build_object('manufacturer','strongback-mobility','apply',true,'approve_paid',true,'approve_reason','x','rows', jsonb_build_array(
      t_row('6491','1010-2025',1,999,'2026-04-15',null), t_row('8001','ES0001',1,440,'2026-08-01','00000000-0000-0000-0000-0000000000ff'))));
    raise exception 'should have failed';
  exception when foreign_key_violation then null; end;
  assert t_snap() = s and (select count(*) from monthly_sales_superseded) = a, 'nothing changed';
  raise notice 'ok   failure after delete: no rows lost or doubled, no history written';
end $$;

-- ===== SAFEGUARD 1: historical (pre-MI-1a) statement re-imported under a new file name =====
do $$ declare r jsonb; s text := t_snap(); begin
  r := t_cfile('ovation-medical','ovation-jul-v2.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
         t_c('ovation-medical','2026-07-01','Williams Brothers','INV-3','GEN2-SHORT',1,100,10),
         t_c('ovation-medical','2026-07-01','Scenic City','INV-1','4900-WRAP',10,200,20),
         t_c('ovation-medical','2026-07-01','Williams Brothers','INV-2','GEN2-TALL',2,300,30)))), '{}', false);
  assert (r->'months'->0->>'needs_decision')::boolean, 'decision needed';
  assert r->'months'->0->'identical_to' ? 'ovation-jul.xlsx', 'identical to historical file';
  assert r->'months'->0->'existing_files'->0->>'loaded' = 'before MI-1a', 'historical shown';
  assert (r->'months'->0->>'overlapping_lines')::int = 3, 'all lines overlap';
  assert t_snap() = s, 'preview wrote nothing';
  raise notice 'ok   historical statement under a new name: preview shows prior file, totals, identical, 3/3 overlap';
end $$;
select t_expect_error($q$select t_cfile('ovation-medical','ovation-jul-v2.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
  t_c('ovation-medical','2026-07-01','Scenic City','INV-1','4900-WRAP',10,200,20), t_c('ovation-medical','2026-07-01','Williams Brothers','INV-2','GEN2-TALL',2,300,30),
  t_c('ovation-medical','2026-07-01','Williams Brothers','INV-3','GEN2-SHORT',1,100,10)))))$q$, '%decision_required%');
select t_expect_error($q$select t_cfile('ovation-medical','ovation-jul-v2.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
  t_c('ovation-medical','2026-07-01','Scenic City','INV-1','4900-WRAP',10,200,20), t_c('ovation-medical','2026-07-01','Williams Brothers','INV-2','GEN2-TALL',2,300,30),
  t_c('ovation-medical','2026-07-01','Williams Brothers','INV-3','GEN2-SHORT',1,100,10)))),
  '{"2026-07":{"action":"append","reason":"new file","confirm_overlap":true}}', true, true, 'x')$q$, '%append_identical_statement%');
do $$ declare r jsonb; s text := t_snap(); begin
  r := t_cfile('ovation-medical','ovation-jul-v2.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
         t_c('ovation-medical','2026-07-01','Scenic City','INV-1','4900-WRAP',10,200,20)))), '{"2026-07":{"action":"reject"}}');
  assert (r->>'noop')::boolean and t_snap() = s, 'reject writes nothing';
  raise notice 'ok   reviewed choice "reject": nothing written';
end $$;
-- a partial overlap needs confirm_overlap + reason to append; distinct lines append cleanly
select t_expect_error($q$select t_cfile('ovation-medical','ovation-jul-late.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
  t_c('ovation-medical','2026-07-01','Scenic City','INV-1','4900-WRAP',10,200,20), t_c('ovation-medical','2026-07-01','Larco Medical','INV-9','4900-WRAP',5,100,10)))),
  '{"2026-07":{"action":"append","reason":"late lines"}}', true, true, 'late')$q$, '%append_overlaps_existing_lines%');
do $$ declare r jsonb; begin
  r := t_cfile('ovation-medical','ovation-jul-late.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
         t_c('ovation-medical','2026-07-01','Larco Medical','INV-9','4900-WRAP',5,100,10)))),
         '{"2026-07":{"action":"append","reason":"late adjustment statement"}}', true, true, 'late lines');
  assert (select sum(commission) from monthly_sales where manufacturer='ovation-medical' and period='2026-07-01') = 70, 'distinct append adds 10';
  raise notice 'ok   reviewed choice "append" of distinct lines: added once, with reason on the batch';
end $$;
do $$ declare r jsonb; begin   -- replace the historical file explicitly: no doubling
  r := t_cfile('ovation-medical','ovation-jul-corrected.xlsx', jsonb_build_array(jsonb_build_object('period','2026-07-01','rows', jsonb_build_array(
         t_c('ovation-medical','2026-07-01','Scenic City','INV-1','4900-WRAP',10,200,20),
         t_c('ovation-medical','2026-07-01','Williams Brothers','INV-2','GEN2-TALL',2,300,30),
         t_c('ovation-medical','2026-07-01','Williams Brothers','INV-3','GEN2-SHORT',2,200,20)))),
         '{"2026-07":{"action":"replace","replace_files":["ovation-jul.xlsx"]}}', true, true, 'corrected statement from Ovation');
  assert (select sum(commission) from monthly_sales where manufacturer='ovation-medical' and period='2026-07-01') = 80, '70 + 10 correction, not doubled';
  assert (select count(*) from monthly_sales_superseded where reason='statement_replaced' and row_data->>'source_file'='ovation-jul.xlsx') = 3, 'historical archived';
  raise notice 'ok   reviewed choice "replace": historical file archived and replaced, late file untouched, no doubling';
end $$;

-- ===== SAFEGUARD 2: multi-month file is one transaction =====
do $$ declare s text := t_snap(); begin
  begin   -- August fails a control total -> the whole file is refused, September/October not written
    perform t_cfile('pedifix','pedifix-q3.csv', jsonb_build_array(
      jsonb_build_object('period','2026-08-01','rows', jsonb_build_array(t_c('pedifix','2026-08-01','Scenic City','P1','X',1,50,5)),'control_total',6),
      jsonb_build_object('period','2026-09-01','rows', jsonb_build_array(t_c('pedifix','2026-09-01','Scenic City','P2','X',1,60,6)))));
    raise exception 'should have failed';
  exception when others then if sqlerrm not like 'mi1a_commission_file_refused%control_total_mismatch%' then raise; end if; end;
  begin   -- September's insert fails at the database (unknown dealer) after August was written -> all undone
    perform t_cfile('pedifix','pedifix-q3.csv', jsonb_build_array(
      jsonb_build_object('period','2026-08-01','rows', jsonb_build_array(t_c('pedifix','2026-08-01','Scenic City','P1','X',1,50,5))),
      jsonb_build_object('period','2026-09-01','rows', jsonb_build_array(t_c('pedifix','2026-09-01','Scenic City','P2','X',1,60,6)
                         || '{"dealer_id":"00000000-0000-0000-0000-0000000000ff"}'))));
    raise exception 'should have failed';
  exception when foreign_key_violation then null; end;
  assert t_snap() = s and (select count(*) from mfr_report_batches where manufacturer='pedifix') = 0, 'no month of the file written';
  raise notice 'ok   multi-month file: a failure in any month leaves every month unwritten';
end $$;
do $$ declare r jsonb; begin
  r := t_cfile('pedifix','pedifix-q3.csv', jsonb_build_array(
      jsonb_build_object('period','2026-08-01','rows', jsonb_build_array(t_c('pedifix','2026-08-01','Scenic City','P1','X',1,50,5))),
      jsonb_build_object('period','2026-09-01','rows', jsonb_build_array(t_c('pedifix','2026-09-01','Scenic City','P2','X',1,60,6)))));
  assert (select count(*) from monthly_sales where batch_id=(r->>'batch_id')::uuid) = 2, 'both months, one batch';
  assert (select period_start||'/'||period_end from mfr_report_batches where id=(r->>'batch_id')::uuid) = '2026-08-01/2026-09-01', 'batch spans file';
  raise notice 'ok   multi-month file: both months written under one batch';
end $$;

-- ===== Cross-lane: the same sale loaded through both importers (found live: AirAvant June 2026) =====
do $$ declare r jsonb; begin
  insert into mi1a_enrollment(manufacturer,lane,enrolled_by) values ('pedifix','sales_report','test');   -- test-only enrolment
  perform set_config('hcps.ms_writer','mi1a',true);
  insert into monthly_sales(manufacturer,period,order_date,invoice_no,product_code,qty,amount,commission,source,external_ref,order_key,line_key,line_hash)
    values ('pedifix','2026-08-01','2026-08-03','5917','BNG500',10,50,5,'sales_report','pedifix|v2|O:5917|BNG500|1','pedifix|O:5917','O:5917|BNG500|1',hcps_ms_line_hash(10,50,null,'2026-08-03'));
  perform set_config('hcps.ms_writer','',true);
  begin perform t_cfile('pedifix','pedifix-aug-stmt.xlsx', jsonb_build_array(jsonb_build_object('period','2026-08-01','rows', jsonb_build_array(
      t_c('pedifix','2026-08-01','Scenic City',null,null,10,50,5)))), '{"2026-08":{"action":"append","reason":"x"}}', true, true, 'x');
    raise exception 'should refuse';
  exception when others then if sqlerrm not like '%cross_lane_duplicate%' then raise; end if; end;
  perform set_config('hcps.ms_writer','mi1a',true);
  delete from monthly_sales where external_ref='pedifix|v2|O:5917|BNG500|1';
  perform set_config('hcps.ms_writer','',true);
  delete from mi1a_enrollment where manufacturer='pedifix';
  raise notice 'ok   cross-lane: a statement line matching a sales-report line for the same month is refused without confirmation';
end $$;

-- ===== SAFEGUARD 4b: write guard blocks old endpoints on enrolled rows =====
select t_expect_error($q$insert into monthly_sales(manufacturer,period,amount,source,external_ref) values ('strongback-mobility','2026-08-01',10,'sales_report','strongback-mobility|9999|X|0')$q$, 'mi1a_write_guard%');
select t_expect_error($q$delete from monthly_sales where manufacturer='strongback-mobility' and invoice_no='6854'$q$, 'mi1a_write_guard%');
select t_expect_error($q$update monthly_sales set amount=amount+1 where manufacturer='strongback-mobility' and invoice_no='6854'$q$, 'mi1a_write_guard%');
do $$ begin
  update monthly_sales set dealer_id='00000000-0000-0000-0000-00000000000c' where manufacturer='strongback-mobility' and invoice_no='6854';
  update monthly_sales set dealer_id='00000000-0000-0000-0000-00000000000a' where manufacturer='strongback-mobility' and invoice_no='6854';
  insert into monthly_sales(manufacturer,period,amount,source,external_ref) values ('pedifix','2026-10-01',1,'sales_report','pedifix|x|0');
  delete from monthly_sales where manufacturer='pedifix' and external_ref='pedifix|x|0';
  raise notice 'ok   guard: re-attribution allowed; un-enrolled manufacturers unaffected';
end $$;
insert into mi1a_enrollment(manufacturer,lane,enrolled_by) values ('*','commission','angelo');
select t_expect_error($q$insert into monthly_sales(manufacturer,period,amount,commission,source) values ('pedifix','2026-11-01',1,1,'commission')$q$, 'mi1a_write_guard%');
select t_expect_error($q$delete from monthly_sales where manufacturer='ovation-medical' and source='commission'$q$, 'mi1a_write_guard%');

-- ===== Rollback order =====
do $$ declare b record; begin
  for b in select id from mfr_report_batches where status='imported' order by created_at desc loop
    perform hcps_import_batch_rollback(jsonb_build_object('batch_id',b.id,'actor','angelo')); end loop;
  assert (select sum(commission) from monthly_sales where manufacturer='ovation-medical' and period='2026-07-01') = 60, 'historical statement restored';
  assert (select amount from monthly_sales where invoice_no='7001') = 536, 'sales restored';
  raise notice 'ok   every batch rolled back newest first: historical Ovation statement and Strongback 7001 restored';
end $$;
do $$ begin
  assert has_function_privilege('service_role','hcps_commission_file_apply(jsonb)','execute') and not has_function_privilege('anon','hcps_commission_file_apply(jsonb)','execute'), 'grants';
  raise notice 'ok   grants: service role only';
end $$;
