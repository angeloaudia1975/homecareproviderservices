/* MI-1b — manufacturer report history on mfr_sources. The committed SQL, run in a REAL Postgres
   (pg-safeupdate loaded) on top of the real MI-1a Part 0/1 and Manufacturer Center Phase 1–2 files:
     test/mi1a/fixture.sql → mi1a_part0 → mi1a_part1 → test/mc-guard.stub.sql → migrate-phase2-product-skus.sql
     → test/mc-guard.data.sql → mc_phase1_foundation → mc_phase1_backfill → mc_phase2_freeze_guard
     → (a sixth catalog row, as in production) → supabase/mi1b_report_register.sql (twice)
   Needs psql and a server; skipped when there is none.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/var/tmp/pgmi PGPORT=55433 PGUSER=postgres node test/mi1b-register.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mi1b_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => (f === 'mi1b_report_register.sql' && process.env.MI1B_SQL) ? process.env.MI1B_SQL : path.join(__dirname, '..', 'supabase', f),   // MI1B_SQL: a mutant copy (test/mi1b.mutants.js)
  SB0 = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }
const q = sql => run(DB, sql);
const sr = sql => q(`begin; set local role service_role; ${sql}; commit;`);              // as the API's service role
const refused = (sql, re) => { try { sr(sql); } catch (e) { assert.ok(re.test(e.message), 'wrong refusal: ' + e.message.split('\n')[0]); return; } throw new Error('NOT refused: ' + sql.slice(0, 90)); };
const H = c => c.repeat(64);                                                             // a sha256-shaped hex string
const reg = o => `select public.hcps_mfr_report_register('${JSON.stringify(Object.assign({
  manufacturer: 'strongback-mobility', kind: 'dealer_report', file_name: 'Strongback_Report_Overview_September_2026.pdf', title: 'Strongback dealer report — September 2026',
  file_size: 412345, content_type: 'application/pdf', received_date: '2026-10-10', prepared_date: '2026-10-08',
  report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'angelo@homecareproviderservices.us' }, o)).replace(/'/g, "''")}'::jsonb)`;
const path_ = (kind, sha, ext, mfr) => `reports/${mfr || 'strongback-mobility'}/${kind}/${sha}.${ext || 'pdf'}`;
const regq = o => { const sha = o.file_sha256; const kind = o.kind || 'dealer_report'; return JSON.parse(sr(reg(Object.assign({ storage_path: path_(kind, sha, o.ext, o.manufacturer) }, o)))); };
const CATALOG_FP = `select md5(string_agg(concat_ws('|', id, manufacturer, kind, title, file_name, file_sha256, storage_path, received_date, legacy,
  manufacturer_effective_date, effective_date_status, supersedes_id, status, accepted_by, accepted_at, note, created_at, created_by), ';' order by id))
  from mfr_sources where kind not in ('sales_export','commission_statement','dealer_report')`;

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
let catalogFp = '';
try {
  for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
    T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql')]) file(DB, f);
  // Production holds a sixth catalog row: a second legacy registration of the Ovation 2026 price list (same file name).
  q(`insert into mfr_sources (manufacturer, kind, title, file_name, legacy, manufacturer_effective_date, effective_date_status, status, accepted_by, accepted_at, note, created_by)
     values ('ovation-medical','price_list','2026 ovation medical pricelist 1092026.xlsx · row 94','2026 ovation medical pricelist 1092026.xlsx', true, '2026-10-09','stated','accepted','backfill',now(),'Legacy registration','backfill')`);
  console.log('\n— install —');
  t('six catalog rows before MI-1b, as in production', () => assert.strictEqual(q('select count(*) from mfr_sources'), '6'));
  catalogFp = q(CATALOG_FP);
  t('MI-1b applies, and applies again; the six catalog rows are byte-identical (original columns)', () => {
    file(DB, SB('mi1b_report_register.sql')); file(DB, SB('mi1b_report_register.sql'));
    assert.strictEqual(q('select count(*) from mfr_sources'), '6'); assert.strictEqual(q(CATALOG_FP), catalogFp);
    assert.strictEqual(q(`select count(*) from mfr_sources where report_period_start is not null or publication_status is not null or prepared_date_status is not null`), '0');
  });
  t('the unique (manufacturer, file_sha256) index is unchanged', () =>
    assert.strictEqual(q(`select indexdef from pg_indexes where indexname='mfr_sources_file_uk'`), 'CREATE UNIQUE INDEX mfr_sources_file_uk ON public.mfr_sources USING btree (manufacturer, file_sha256) WHERE (file_sha256 IS NOT NULL)'));
  t('kind check = the seven catalog kinds + the three report kinds', () => {
    const d = q(`select pg_get_constraintdef(oid) from pg_constraint where conname='mfr_sources_kind_check'`);
    for (const k of ['price_list','terms','catalog','images','cross_reference','status_list','other','sales_export','commission_statement','dealer_report']) assert.ok(d.includes(`'${k}'`), k);
  });

  console.log('\n— catalog sources keep working (Manufacturer Center compatibility) —');
  t('a new catalog source registers exactly as before (no report fields, no guard)', () => {
    q(`insert into mfr_sources (manufacturer,kind,title,file_name,file_sha256,received_date,effective_date_status) values ('bemis','catalog','Bemis 2026 Bath Safety catalog','bath.pdf','${H('c')}','2026-10-10','pending')`);
    q(`update mfr_sources set status='accepted', accepted_by='x', accepted_at=now() where file_sha256='${H('c')}'`);
    q(`delete from mfr_sources where file_sha256='${H('c')}'`);
  });
  t('a catalog row cannot carry report fields', () => {
    assert.throws(() => q(`update mfr_sources set report_period_start='2026-09-01', report_period_end='2026-09-30' where id=1`), /catalog_shape/);
    assert.throws(() => q(`update mfr_sources set publication_status='published' where id=1`), /catalog_shape|publication/);
  });
  t('a catalog row cannot be turned into a report, nor inserted as one directly', () => {
    assert.throws(() => q(`update mfr_sources set kind='dealer_report' where id=1`), /mfr_report_guard/);
    assert.throws(() => sr(`insert into mfr_sources (manufacturer,kind,title,file_name,received_date) values ('pedifix','sales_export','x','x.csv','2026-10-10')`), /mfr_report_guard/);
  });
  t('Manufacturer Center catalog writes (service_role) and the freeze-guard self-test still work after MI-1b', () => {
    sr(`insert into mfr_sources (manufacturer,kind,title,file_name,file_sha256,received_date,effective_date_status) values ('pedifix','price_list','PediFix 2026','p.xlsx','${H('5')}','2026-10-10','pending')`);
    sr(`update mfr_sources set status='accepted', accepted_by='x', accepted_at=now() where file_sha256='${H('5')}'`);
    q(`delete from mfr_sources where file_sha256='${H('5')}'`);
    assert.strictEqual(q(CATALOG_FP), catalogFp);
    const res = JSON.parse(q('select public.mfr_freeze_guard_selftest()'));
    const rows = Array.isArray(res) ? res : (res.attempts || []);
    assert.ok(rows.length > 0 && rows.every(x => x.result === 'blocked' || x.result === 'no active record'), JSON.stringify(rows).slice(0, 200));
  });

  console.log('\n— Rule 19 —');
  t('mfr_source_events: RLS on, no policies, nothing for anon/authenticated; service_role select+insert only', () => {
    assert.strictEqual(q(`select relrowsecurity from pg_class where relname='mfr_source_events'`), 't');
    assert.strictEqual(q(`select count(*) from pg_policy where polrelid='mfr_source_events'::regclass`), '0');
    for (const r of ['anon', 'authenticated']) for (const p of ['select', 'insert', 'update', 'delete'])
      assert.strictEqual(q(`select has_table_privilege('${r}','public.mfr_source_events','${p}')`), 'f', `${r} ${p}`);
    assert.strictEqual(q(`select has_table_privilege('service_role','public.mfr_source_events','select') and has_table_privilege('service_role','public.mfr_source_events','insert')`), 't');
    assert.strictEqual(q(`select has_table_privilege('service_role','public.mfr_source_events','update') or has_table_privilege('service_role','public.mfr_source_events','delete')`), 'f');
    assert.strictEqual(q(`select has_table_privilege('service_role','public.mfr_source_events','truncate')`), 'f');
    const seq = q(`select pg_get_serial_sequence('public.mfr_source_events','id')`);
    assert.strictEqual(q(`select has_sequence_privilege('anon','${seq}','usage') or has_sequence_privilege('authenticated','${seq}','usage')`), 'f');
  });
  t('MI-1b functions: not executable by anon/authenticated/public; executable by service_role', () => {
    assert.strictEqual(q(`select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.proname like 'hcps_mfr_%' and has_function_privilege(r,p.oid,'execute')`), '0');
    assert.strictEqual(q(`select bool_and(has_function_privilege('service_role',p.oid,'execute')) from pg_proc p where p.proname like 'hcps_mfr_report_%'`), 't');
    for (const r of ['anon', 'authenticated']) assert.throws(() => q(`begin; set local role ${r}; ${reg({ file_sha256: H('0'), storage_path: path_('dealer_report', H('0')) })}; commit;`), /permission denied/);
  });

  console.log('\n— register: idempotent, honest dates, one file one kind —');
  let sep;
  t('registers the September dealer report as received + unpublished, with an audit event', () => {
    const r = regq({ file_sha256: H('a') }); sep = r.id;
    assert.strictEqual(r.existing, false);
    assert.strictEqual(q(`select concat_ws('|',status,publication_status,prepared_date,prepared_date_status,received_date,report_period_start,report_period_end,legacy,effective_date_status) from mfr_sources where id=${sep}`),
      'received|unpublished|2026-10-08|stated|2026-10-10|2026-09-01|2026-09-30|f|not_applicable');
    assert.strictEqual(q(`select action||'|'||actor from mfr_source_events where source_id=${sep}`), 'registered|angelo@homecareproviderservices.us');
  });
  t('the identical file again: returns the existing record, writes nothing (idempotent)', () => {
    const n = q('select count(*) from mfr_sources') + '/' + q('select count(*) from mfr_source_events');
    const r = regq({ file_sha256: H('a'), title: 'different title' });
    assert.deepStrictEqual([r.existing, r.id], [true, sep]);
    assert.strictEqual(q('select count(*) from mfr_sources') + '/' + q('select count(*) from mfr_source_events'), n);
  });
  t('the same file under another kind is refused (one file, one kind)', () =>
    refused(reg({ kind: 'sales_export', file_sha256: H('a'), storage_path: path_('sales_export', H('a')) }), /mi1b_hash_registered_as_other_kind/));
  t('the same hash for ANOTHER manufacturer is its own record (index is per manufacturer)', () => {
    const r = regq({ manufacturer: 'pedifix', kind: 'sales_export', file_sha256: H('a'), ext: 'csv', content_type: 'text/csv', prepared_date: '', report_period_start: '2025-01-01', report_period_end: '2026-09-30' });
    assert.strictEqual(r.existing, false);
  });
  t('a prepared date that is not stated stays empty ("not_stated") — never the received date', () => {
    const r = regq({ kind: 'sales_export', file_sha256: H('b'), ext: 'csv', content_type: 'text/csv', prepared_date: '', report_period_start: '2026-09-01', report_period_end: '2026-09-30' });
    assert.strictEqual(q(`select coalesce(prepared_date::text,'null')||'|'||prepared_date_status||'|'||(publication_status is null) from mfr_sources where id=${r.id}`), 'null|not_stated|true');
  });
  const AUG = { report_period_start: '2026-08-01', report_period_end: '2026-08-31' };
  t('refusals: no received date, bad period, prepared after received, bad hash, catalog kind, no actor', () => {
    refused(reg(Object.assign({ file_sha256: H('d'), storage_path: path_('dealer_report', H('d')), received_date: null }, AUG)), /mi1b_received_date_required/);
    refused(reg({ file_sha256: H('d'), storage_path: path_('dealer_report', H('d')), report_period_start: '2026-10-01', report_period_end: '2026-09-30' }), /mi1b_bad_period/);
    refused(reg(Object.assign({ file_sha256: H('d'), storage_path: path_('dealer_report', H('d')), prepared_date: '2026-10-11' }, AUG)), /report_shape/);
    refused(reg({ file_sha256: 'abc', storage_path: path_('dealer_report', 'abc') }), /mi1b_bad_hash/);
    refused(reg({ kind: 'price_list', file_sha256: H('d') }), /mi1b_bad_kind/);
    refused(reg(Object.assign({ file_sha256: H('d'), storage_path: path_('dealer_report', H('d')), actor: '' }, AUG)), /mi1b_actor_required/);
  });
  t('the stored file must sit at its canonical, hash-named private path', () => {
    refused(reg(Object.assign({ file_sha256: H('d'), storage_path: 'public/x.pdf' }, AUG)), /report_shape/);
    refused(reg(Object.assign({ file_sha256: H('d'), storage_path: path_('dealer_report', H('e')) }, AUG)), /report_shape/);
    refused(reg(Object.assign({ file_sha256: H('d'), storage_path: path_('dealer_report', H('d'), 'exe') }, AUG)), /report_shape/);
  });
  t('a second, different file for the same report period is refused unless it is a correction', () =>
    refused(reg({ file_sha256: H('d'), storage_path: path_('dealer_report', H('d')) }), /mi1b_period_already_registered/));

  console.log('\n— guard: file facts are immutable; nothing is deleted —');
  t('direct writes to a report row are refused, even for service_role', () => {
    refused(`update mfr_sources set status='accepted', accepted_by='x', accepted_at=now() where id=${sep}`, /mfr_report_guard/);
    refused(`update mfr_sources set publication_status='published', published_at=now(), published_by='x' where id=${sep}`, /mfr_report_guard/);
    refused(`delete from mfr_sources where id=${sep}`, /never deleted/);
    assert.throws(() => q(`delete from mfr_sources where id=${sep}`), /never deleted/, 'not even the owner');
  });
  t('even with the function flag, the file facts cannot change', () => {
    assert.throws(() => q(`begin; select set_config('hcps.mfr_report_op','on',true); update mfr_sources set received_date='2026-10-01' where id=${sep}; commit;`), /never change/);
    assert.throws(() => q(`begin; select set_config('hcps.mfr_report_op','on',true); update mfr_sources set file_sha256='${H('f')}' where id=${sep}; commit;`), /never change/);
    assert.throws(() => q(`begin; select set_config('hcps.mfr_report_op','on',true); update mfr_sources set report_period_end='2026-10-31' where id=${sep}; commit;`), /never change/);
  });
  t('the audit trail is append-only', () => {
    assert.throws(() => q(`update mfr_source_events set actor='x' where source_id=${sep}`), /append-only/);
    assert.throws(() => q(`delete from mfr_source_events where source_id=${sep}`), /append-only/);
    assert.throws(() => q(`truncate mfr_source_events`), /append-only/);
  });

  console.log('\n— accept / reject / publication (separate) —');
  t('rejecting needs a reason; accepting records who/when; a decided report is not decided again', () => {
    refused(`select hcps_mfr_report_decide('{"id":${sep},"decision":"rejected","actor":"a"}')`, /mi1b_reason_required/);
    const r = JSON.parse(sr(`select hcps_mfr_report_decide('{"id":${sep},"decision":"accepted","actor":"angelo","reason":"Checked against the PDF"}')`));
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(q(`select status||'|'||accepted_by||'|'||(accepted_at is not null)||'|'||publication_status from mfr_sources where id=${sep}`), 'accepted|angelo|true|unpublished');
    refused(`select hcps_mfr_report_decide('{"id":${sep},"decision":"rejected","actor":"a","reason":"x"}')`, /mi1b_already_decided/);
  });
  t('accepting does NOT publish; publishing is refused while no MI-1c intelligence exists', () => {
    assert.strictEqual(q(`select publication_status from mfr_sources where id=${sep}`), 'unpublished');
    refused(`select hcps_mfr_report_publication('{"id":${sep},"action":"publish","actor":"a"}')`, /mi1b_publish_unavailable/);
    assert.strictEqual(q(`select count(*) from mfr_source_events where action='published'`), '0');
  });
  t('publication applies only to dealer reports, and only to accepted ones', () => {
    const se = q(`select id from mfr_sources where file_sha256='${H('b')}'`);
    refused(`select hcps_mfr_report_publication('{"id":${se},"action":"publish","actor":"a"}')`, /mi1b_not_a_dealer_report/);
    refused(`select hcps_mfr_report_publication('{"id":1,"action":"publish","actor":"a"}')`, /mi1b_not_a_dealer_report/);
  });
  t('with staged intelligence (a stand-in MI-1c table), an accepted report can be published and withdrawn with a reason', () => {
    q(`create table public.mfr_dealer_snapshots (id bigserial primary key, source_id bigint references mfr_sources(id))`);
    refused(`select hcps_mfr_report_publication('{"id":${sep},"action":"publish","actor":"a"}')`, /mi1b_publish_unavailable/);   // table, but no rows for it
    q(`insert into mfr_dealer_snapshots(source_id) values (${sep})`);
    sr(`select hcps_mfr_report_publication('{"id":${sep},"action":"publish","actor":"angelo","reason":"reviewed"}')`);
    assert.strictEqual(q(`select publication_status||'|'||published_by from mfr_sources where id=${sep}`), 'published|angelo');
    refused(`select hcps_mfr_report_publication('{"id":${sep},"action":"withdraw","actor":"a"}')`, /mi1b_reason_required/);
  });

  console.log('\n— supersession —');
  let corr;
  t('a correction registers against the accepted report, with a reason; without one it is refused', () => {
    refused(reg({ file_sha256: H('9'), storage_path: path_('dealer_report', H('9')), supersedes_id: sep }), /mi1b_supersede_reason_required/);
    refused(reg({ file_sha256: H('9'), storage_path: path_('dealer_report', H('9')), supersede_reason: 'x' }), /mi1b_bad_supersedes/);
    corr = regq({ file_sha256: H('9'), supersedes_id: sep, supersede_reason: 'Strongback re-sent September with corrected Lacey Drug figures' }).id;
    assert.strictEqual(q(`select status from mfr_sources where id=${sep}`), 'accepted', 'the original stays accepted until the correction is accepted');
    refused(reg({ file_sha256: H('8'), storage_path: path_('dealer_report', H('8')), supersedes_id: sep, supersede_reason: 'y' }), /duplicate key|open_correction/);
  });
  t('accepting the correction supersedes the original and withdraws its publication, in one transaction', () => {
    sr(`select hcps_mfr_report_decide('{"id":${corr},"decision":"accepted","actor":"angelo"}')`);
    assert.strictEqual(q(`select status||'|'||publication_status from mfr_sources where id=${sep}`), 'superseded|withdrawn');
    assert.strictEqual(q(`select status||'|'||publication_status from mfr_sources where id=${corr}`), 'accepted|unpublished', 'the correction is NOT published automatically');
    assert.strictEqual(q(`select string_agg(action,',' order by id) from mfr_source_events where source_id=${sep}`), 'registered,accepted,published,superseded,withdrawn');
    assert.strictEqual(q(`select count(*) from mfr_sources where id in (${sep},${corr})`), '2', 'the original is kept');
  });
  t('a superseded report cannot be corrected again or published', () => {
    refused(reg({ file_sha256: H('7'), storage_path: path_('dealer_report', H('7')), supersedes_id: sep, supersede_reason: 'z' }), /mi1b_bad_supersedes/);
    refused(`select hcps_mfr_report_publication('{"id":${sep},"action":"publish","actor":"a"}')`, /mi1b_not_accepted/);
  });
  t('a rejected correction leaves the original accepted', () => {
    const r2 = regq({ file_sha256: H('6'), supersedes_id: corr, supersede_reason: 'another correction' }).id;
    sr(`select hcps_mfr_report_decide('{"id":${r2},"decision":"rejected","actor":"angelo","reason":"same figures"}')`);
    assert.strictEqual(q(`select status from mfr_sources where id=${corr}`), 'accepted');
  });

  console.log('\n— import-batch links: never historical —');
  t('a batch created BEFORE the file was registered is refused (no links to historical imports)', () => {
    const se = q(`select id from mfr_sources where file_sha256='${H('b')}'`);
    sr(`select hcps_mfr_report_decide('{"id":${se},"decision":"accepted","actor":"angelo"}')`);
    const old = q(`insert into mfr_report_batches (manufacturer,lane,source_file,content_sha,row_count,total_amount,total_commission,created_at)
                   values ('strongback-mobility','sales_report','Strongback_Report_Overview_September_2026.pdf','x',1,1,0,'2026-01-01') returning id`).split('\n')[0];
    refused(`select hcps_mfr_report_link_batch('{"id":${se},"batch_id":"${old}","actor":"a"}')`, /predates/);
  });
  t('wrong lane, other manufacturer, other file name, a dealer report: refused; the right batch links once', () => {
    const se = q(`select id from mfr_sources where file_sha256='${H('b')}'`);
    const mk = (mfr, lane, file) => q(`insert into mfr_report_batches (manufacturer,lane,source_file,content_sha,row_count,total_amount,total_commission)
                   values ('${mfr}','${lane}',${file ? `'${file}'` : 'null'},'x',1,1,0) returning id`).split('\n')[0];
    refused(`select hcps_mfr_report_link_batch('{"id":${se},"batch_id":"${mk('strongback-mobility', 'commission', null)}","actor":"a"}')`, /commission batch/);
    refused(`select hcps_mfr_report_link_batch('{"id":${se},"batch_id":"${mk('pedifix', 'sales_report', null)}","actor":"a"}')`, /is for pedifix/);
    refused(`select hcps_mfr_report_link_batch('{"id":${se},"batch_id":"${mk('strongback-mobility', 'sales_report', 'other.csv')}","actor":"a"}')`, /imported from/);
    refused(`select hcps_mfr_report_link_batch('{"id":${corr},"batch_id":"${mk('strongback-mobility', 'sales_report', null)}","actor":"a"}')`, /only a sales export/);
    const good = mk('strongback-mobility', 'sales_report', 'Strongback_Report_Overview_September_2026.pdf');
    sr(`select hcps_mfr_report_link_batch('{"id":${se},"batch_id":"${good}","actor":"angelo"}')`);
    assert.strictEqual(q(`select import_batch_id from mfr_sources where id=${se}`), good);
    refused(`select hcps_mfr_report_link_batch('{"id":${se},"batch_id":"${mk('strongback-mobility', 'sales_report', null)}","actor":"a"}')`, /already linked/);
  });

  console.log('\n— catalog rows still untouched; rollback —');
  t('after all report activity, the six catalog rows are byte-identical', () => assert.strictEqual(q(CATALOG_FP), catalogFp));
  t('rollback refuses while report history exists — nothing written', () => {
    assert.throws(() => file(DB, SB('mi1b_report_register_rollback.sql')), /report history is never dropped|report records exist/);
    assert.strictEqual(q(`select count(*) from mfr_source_events`) > '0', true);
  });
  t('on a database with no report records, rollback restores the Phase 1 shape exactly and keeps the catalog rows', () => {
    const D2 = DB + '_rb'; run('postgres', `drop database if exists ${D2}`); run('postgres', `create database ${D2}`);
    for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
      T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql')]) file(D2, f);
    const shape = `select md5(string_agg(column_name||':'||data_type, ',' order by column_name)) || '|' ||
      (select md5(string_agg(conname||pg_get_constraintdef(oid), ',' order by conname)) from pg_constraint where conrelid='public.mfr_sources'::regclass) ||'|'||
      (select count(*) from pg_trigger where tgrelid='public.mfr_sources'::regclass and not tgisinternal)
      from information_schema.columns where table_schema='public' and table_name='mfr_sources'`;
    const before = run(D2, shape), fp = run(D2, CATALOG_FP.replace(/ where kind not in .*$/s, ''));
    file(D2, SB('mi1b_report_register.sql')); file(D2, SB('mi1b_report_register_rollback.sql'));
    assert.strictEqual(run(D2, shape), before, 'columns, constraints and triggers are back to Phase 1');
    assert.strictEqual(run(D2, CATALOG_FP.replace(/ where kind not in .*$/s, '')), fp);
    assert.strictEqual(run(D2, `select to_regclass('public.mfr_source_events') is null and not exists (select 1 from pg_proc where proname like 'hcps_mfr_%')`), 't');
    file(D2, SB('mi1b_report_register.sql'));   // and it can be installed again
    run('postgres', `drop database if exists ${D2}`);
  });
} finally {
  run('postgres', `drop database if exists ${DB}`);
}
console.log(`\nmi1b-register (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
