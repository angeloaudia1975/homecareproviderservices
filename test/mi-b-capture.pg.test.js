/* MI Inbox Automation, Phase B — the committed capture SQL (supabase/mi_b_report_capture.sql), run in a REAL Postgres
   (pg-safeupdate loaded) on top of the real chain: test/mi1a/fixture.sql → MI-1a Part 0/1 → Manufacturer Center
   Phase 1/2/6 → MI-1b → MI-1c → MI-B (twice). Proves: RULE 19 (closed tables, service_role reads only, functions
   server-only), the switch is checked by the database, the lease, idempotent recording, registration through MI-1b
   (new → registered, same file → linked, never a duplicate; a second dealer report for a period → exception), the
   durable retry queue with backoff, the checkpoint never passing unaccounted email, a person's decisions, the
   append-only event log and the guard against any other write.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/var/tmp/pgmi PGPORT=55433 PGUSER=postgres node test/mi-b-capture.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mib_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => (f === 'mi_b_report_capture.sql' && process.env.MIB_SQL) ? process.env.MIB_SQL : path.join(__dirname, '..', 'supabase', f);
const T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split("\n").slice(0,4).join(" | ")); } }
const q = sql => run(DB, sql);
const sr = sql => q(`begin; set local role service_role; ${sql}; commit;`);
const as = (role, sql) => q(`begin; set local role ${role}; ${sql}; commit;`);
const refused = (fn, re) => { try { fn(); } catch (e) { assert.ok(re.test(e.message), 'wrong refusal: ' + e.message.split('\n')[0]); return; } throw new Error('NOT refused'); };
const J = o => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const H = c => c.repeat(64);
const call = (fn, p) => JSON.parse(sr(`select public.${fn}(${J(p)})`).split('\n').pop());
const MB = 'angelo@homecareproviderservices.us', TOK = 'tok-0123456789abcdef', TOK2 = 'tok-fedcba9876543210';
const setSwitch = v => q(`update app_settings set value = ${v === undefined ? `value - 'mi_report_capture'` : `value || jsonb_build_object('mi_report_capture', ${v})`} where key='phase2_flags'`);
const APPSET = `create table if not exists app_settings (key text primary key, value jsonb); alter table app_settings enable row level security;
  revoke all on app_settings from anon, authenticated; insert into app_settings (key, value) values ('phase2_flags', '{"mi_import_v2": true}') on conflict do nothing`;
const prof = code => +q(`select id from mfr_report_profiles where code='${code}'`);
let msgN = 0;
const msg = o => Object.assign({ internet_message_id: `<m${++msgN}@strongbackmobility.com>`, graph_id: 'g' + msgN, received_at: '2026-10-07T14:00:00Z',
  from_address: 'amanda.erickson@strongbackmobility.com', from_name: 'Amanda', subject: 'Commission report September 2026 - Angelo Audia', folder: 'Inbox',
  manufacturer: 'strongback-mobility', match_basis: 'sender_domain', has_attachments: true }, o || {});
const record = (m, items, tok) => call('hcps_mfr_capture_record', { mailbox: MB, token: tok || TOK, message: m, items });
const classify = (item, o) => call('hcps_mfr_capture_classify', Object.assign({ mailbox: MB, token: TOK, item_id: item, outcome: 'classified' }, o));
const SR032 = (sha, o) => Object.assign({ sha256: sha, format: 'pdf', suggested: 'commission_statement', manufacturer: 'strongback-mobility',
  profile_id: String(prof('strongback-mobility:commission_statement:sr032')), kind: 'commission_statement', period_start: '2026-09-01', period_end: '2026-09-30',
  period_basis: 'file_name', signals: { signals: ['commission'] } }, o || {});
const regReq = (sha, o) => Object.assign({ manufacturer: 'strongback-mobility', kind: 'commission_statement', title: 'Strongback — commission statement 2026-09',
  file_name: '2026-09 SR032.pdf', file_sha256: sha, storage_path: `reports/strongback-mobility/commission_statement/${sha}.pdf`, file_size: 55335,
  content_type: 'application/pdf', received_date: '2026-10-07', prepared_date: '', report_period_start: '2026-09-01', report_period_end: '2026-09-30',
  supersedes_id: '', supersede_reason: '', note: 'captured' }, o || {});
const register = (item, req) => call('hcps_mfr_capture_register', { mailbox: MB, token: TOK, item_id: item, register: req });
const begin = tok => call('hcps_mfr_capture_begin', { mailbox: MB, token: tok || TOK, lease_seconds: 120 });
const finish = (cp, tok) => call('hcps_mfr_capture_finish', { mailbox: MB, token: tok || TOK, run_id: '', checkpoint_at: cp, complete: true, counts: {}, error: '' });
const item1 = (m, name, size) => ({ item_key: `att:1:${name}:${size || 100}`, part: 'attachment', ordinal: 1, file_name: name, content_type: 'application/pdf', size: size || 100 });

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
    T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
    SB('mi1b_report_register.sql')]) file(DB, f);
  q(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
     alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
     alter default privileges in schema public grant all on functions to anon, authenticated, service_role`);
  q(`alter table dealers add column if not exists is_test boolean default false, add column if not exists active boolean default true, add column if not exists account_class text`);
  q(APPSET);
  q(`create table if not exists dealer_aliases (alias_norm text primary key, raw_name text, dealer_id uuid references dealers(id), created_at timestamptz default now())`);
  q(`insert into manufacturers values ('ohio-medical','Ohio Medical'),('access4u','Access4U'),('airavant-bongorx','AirAvant / BongoRx'),('climbing-steps','Climbing Steps'),
     ('bemis','Bemis'),('complete-medical-supplies','Complete Medical Supplies'),('golden-technologies','Golden Technologies') on conflict do nothing`);
  file(DB, SB('mi1c_dealer_intel.sql'));
  // Record 7, as in production: the September dealer overview, registered by a person through MI-1b.
  const REC7 = 'f708ebaf0290bb736c7499b818655167c436c8867f16142cf122fd663bd790b5';
  sr(`select public.hcps_mfr_report_register(${J({ manufacturer: 'strongback-mobility', kind: 'dealer_report', title: 'Strongback — September 2026 Dealer Report',
    file_name: 'Strongback_Report_Overview_September_2026.pdf', file_sha256: REC7, storage_path: `reports/strongback-mobility/dealer_report/${REC7}.pdf`, file_size: 515614,
    content_type: 'application/pdf', received_date: '2026-10-11', prepared_date: '2026-10-08', report_period_start: '2026-09-01', report_period_end: '2026-09-30',
    actor: 'angelo@homecareproviderservices.us' })})`);
  const FP = `select md5(string_agg(concat_ws('|', id, kind, file_sha256, status, received_date, report_period_start), ';' order by id)) || ':' ||
    (select count(*) from mfr_source_events) || ':' || (select count(*) from monthly_sales) || ':' || (select count(*) from dealers) from mfr_sources`;
  const fp0 = q(FP);

  console.log('\n— install —');
  t('the migration applies, and applies again; all 9 install checks ok', () => {
    file(DB, SB('mi_b_report_capture.sql')); const out = file(DB, SB('mi_b_report_capture.sql'));
    const rows = out.trim().split('\n').filter(l => /^\d+\|/.test(l)); assert.strictEqual(rows.length, 9, out);
    for (const r of rows) assert.ok(/\|t$/.test(r), 'check failed: ' + r);
  });
  t('nothing existing changed (register, its events, monthly_sales, dealers); record 7 untouched', () => assert.strictEqual(q(FP), fp0));
  t('12 profiles: Strongback sales export / commission statement / dealer report active; 9 manufacturers draft; none imports', () => {
    assert.strictEqual(q(`select string_agg(kind, ',' order by kind) from mfr_report_profiles where status='active'`), 'commission_statement,dealer_report,sales_export');
    assert.strictEqual(q(`select count(distinct manufacturer) from mfr_report_profiles where status='draft'`), '9');
    assert.strictEqual(q(`select count(*) from mfr_report_profiles where auto_import or (status='draft' and auto_register)`), '0');
    refused(() => q(`select set_config('hcps.capture_op','on',false); update mfr_report_profiles set auto_import = true where true`), /auto_import_check|check constraint/);
  });

  console.log('\n— RULE 19 —');
  for (const tb of ['mfr_report_profiles', 'mfr_report_capture_state', 'mfr_report_capture_runs', 'mfr_report_messages', 'mfr_report_items', 'mfr_report_capture_events']) {
    t(`${tb}: anon / authenticated cannot read; service_role reads but cannot write`, () => {
      for (const r of ['anon', 'authenticated']) refused(() => as(r, `select count(*) from ${tb}`), /permission denied/);
      sr(`select count(*) from ${tb}`);
      const col = tb === 'mfr_report_capture_state' ? 'mailbox' : 'id';
      refused(() => sr(`insert into ${tb} default values`), /permission denied/);
      refused(() => sr(`update ${tb} set ${col} = ${col} where true`), /permission denied/);
      refused(() => sr(`delete from ${tb} where true`), /permission denied/);
    });
  }
  t('capture functions: service_role may run them; anon / authenticated may not; helpers are owner-only', () => {
    for (const r of ['anon', 'authenticated']) for (const f of ['begin', 'record', 'classify', 'fail', 'register', 'finish', 'resolve'])
      refused(() => as(r, `select public.hcps_mfr_capture_${f}('{}'::jsonb)`), /permission denied/);
    refused(() => sr(`select public.hcps_mfr_capture_switch_on()`), /permission denied/);
    refused(() => sr(`select public.hcps_mfr_capture_lease('a','b',true)`), /permission denied/);
  });
  t('the owner without a capture function is refused by the guard; service_role cannot forge the marker', () => {
    refused(() => q(`update mfr_report_capture_state set overlap_minutes = 120 where true`), /mfr_capture_guard/);
    refused(() => sr(`select set_config('hcps.capture_op','on',true); update mfr_report_capture_state set overlap_minutes = 120 where true`), /permission denied/);
    refused(() => q(`delete from mfr_report_profiles where true`), /mfr_capture_guard/);
    refused(() => q(`truncate mfr_report_capture_events`), /mfr_capture_guard/);
  });

  console.log('\n— switch and lease —');
  t('switch missing / false / "true" (text) → the database refuses to begin', () => {
    for (const v of [undefined, 'false', `'"true"'::jsonb`]) { setSwitch(v); refused(() => begin(), /capture_switch_off/); }
  });
  t('switch true → begin takes the lease; another run is told busy; the holder may continue', () => {
    setSwitch('true'); const a = begin(); assert.strictEqual(a.busy, false); assert.ok(a.run_id > 0);
    assert.strictEqual(begin(TOK2).busy, true);
    assert.strictEqual(begin(TOK).busy, false);
  });
  t('a write without the lease (wrong token) is refused', () => refused(() => record(msg(), [], TOK2), /capture_lease_lost/));

  console.log('\n— recording —');
  let m1, sr032;
  t('an email is recorded once (mailbox + internetMessageId); re-listing refreshes the locator only', () => {
    const m = msg({ internet_message_id: '<sep-sr032@strongback>' });
    const a = record(m, null); assert.strictEqual(a.items_listed, false);
    const b = record(m, [item1(m, '2026-09 SR032.pdf', 55335)]); assert.strictEqual(b.items.length, 1);
    const c = record(Object.assign({}, m, { graph_id: 'moved', subject: 'CHANGED', received_at: '2026-01-01T00:00:00Z' }), [item1(m, 'other.pdf', 9)]);
    assert.strictEqual(c.id, a.id); assert.strictEqual(c.items.length, 1, 'items are fixed once listed');
    assert.strictEqual(q(`select graph_id || '|' || subject || '|' || received_at from mfr_report_messages where id=${a.id}`),
      'moved|Commission report September 2026 - Angelo Audia|2026-10-07 09:00:00-05');
    m1 = a.id; sr032 = c.items[0].id;
  });
  t('several report attachments in one email are separate items', () => {
    const m = msg({ internet_message_id: '<two@strongback>' });
    const r = record(m, [item1(m, 'a.pdf'), Object.assign(item1(m, 'b.csv'), { item_key: 'att:2:b.csv:100', ordinal: 2 })]);
    assert.strictEqual(r.items.length, 2);
  });

  console.log('\n— registration through MI-1b —');
  const S1 = H('a');
  t('a classified SR032 statement registers as a commission statement (new record, system actor, Outlook received date)', () => {
    classify(sr032, SR032(S1));
    const r = register(sr032, regReq(S1)); assert.strictEqual(r.state, 'registered');
    assert.strictEqual(q(`select kind || '|' || created_by || '|' || received_date || '|' || status from mfr_sources where id=${r.source_id}`),
      'commission_statement|system:report-capture|2026-10-07|received');
    assert.strictEqual(q(`select state || '|' || source_id from mfr_report_items where id=${sr032}`), `registered|${r.source_id}`);
  });
  t('a settled item never changes again (classify / fail / register answer unchanged)', () => {
    assert.strictEqual(classify(sr032, { outcome: 'exception', attention: 'unidentified_type' }).unchanged, true);
    assert.strictEqual(call('hcps_mfr_capture_fail', { mailbox: MB, token: TOK, item_id: sr032, attention: 'attachment_failed' }).unchanged, true);
    assert.strictEqual(register(sr032, regReq(S1)).unchanged, true);
  });
  t('the same file in a second email (a forward) is LINKED to the same record — one register row, two source emails', () => {
    const n0 = q(`select count(*) from mfr_sources`);
    const m = msg({ internet_message_id: '<fw-sr032@strongback>', from_address: 'jennifer.johansson@strongbackmobility.com', subject: 'Fw: Commission report' });
    const it = record(m, [item1(m, '2026-09 SR032.pdf', 55335)]).items[0].id;
    classify(it, SR032(S1)); const r = register(it, regReq(S1));
    assert.strictEqual(r.state, 'linked'); assert.strictEqual(q(`select count(*) from mfr_sources`), n0);
    assert.strictEqual(q(`select count(distinct message_id) || '/' || count(distinct source_id) from mfr_report_items where sha256='${S1}'`), '2/1');
  });
  t('the 8 Oct overview email links to record 7 by its identical hash — nothing new registered, record 7 unchanged', () => {
    const before = q(`select concat_ws('|', count(*), (select count(*) from mfr_source_events)) from mfr_sources`);
    const r7 = q(`select concat_ws('|', id, status, received_date, prepared_date, created_by) from mfr_sources where file_sha256='${REC7}'`);
    const m = msg({ internet_message_id: '<overview@strongback>', from_address: 'melanie.psychas@strongbackmobility.com',
      subject: 'Your Strongback dealer overview, September 2026', received_at: '2026-10-08T15:46:00Z' });
    const it = record(m, [item1(m, 'Angelo_Strongback_Dealers_2026-09.pdf', 516016)]).items[0].id;
    classify(it, { sha256: REC7, format: 'pdf', manufacturer: 'strongback-mobility', profile_id: String(prof('strongback-mobility:dealer_report:overview')),
      kind: 'dealer_report', period_start: '2026-09-01', period_end: '2026-09-30', period_basis: 'report', prepared_date: '2026-10-08' });
    const r = register(it, regReq(REC7, { kind: 'dealer_report', file_name: 'Angelo_Strongback_Dealers_2026-09.pdf', received_date: '2026-10-08',
      prepared_date: '2026-10-08', storage_path: `reports/strongback-mobility/dealer_report/${REC7}.pdf` }));
    assert.strictEqual(r.state, 'linked'); assert.strictEqual(r.source_id, +r7.split('|')[0]);
    assert.strictEqual(q(`select concat_ws('|', count(*), (select count(*) from mfr_source_events)) from mfr_sources`), before);
    assert.strictEqual(q(`select concat_ws('|', id, status, received_date, prepared_date, created_by) from mfr_sources where file_sha256='${REC7}'`), r7);
  });
  t('a DIFFERENT dealer report for a period that already has one → exception "correction needs a decision" (never registered)', () => {
    const m = msg({ internet_message_id: '<overview2@strongback>' });
    const it = record(m, [item1(m, 'other-overview.pdf')]).items[0].id; const S = H('d');
    classify(it, { sha256: S, format: 'pdf', manufacturer: 'strongback-mobility', profile_id: String(prof('strongback-mobility:dealer_report:overview')),
      kind: 'dealer_report', period_start: '2026-09-01', period_end: '2026-09-30', period_basis: 'report', prepared_date: '2026-10-08' });
    const r = register(it, regReq(S, { kind: 'dealer_report', file_name: 'other-overview.pdf', prepared_date: '2026-10-08', storage_path: `reports/strongback-mobility/dealer_report/${S}.pdf` }));
    assert.strictEqual(r.state, 'exception'); assert.strictEqual(r.attention, 'correction_needs_decision');
    assert.strictEqual(q(`select count(*) from mfr_sources where file_sha256='${S}'`), '0');
  });
  t('the same file as another KIND → exception "duplicate conflict"', () => {
    const m = msg({ internet_message_id: '<dupkind@strongback>' });
    const it = record(m, [item1(m, 'x.csv')]).items[0].id;
    classify(it, { sha256: S1, format: 'csv', manufacturer: 'strongback-mobility', profile_id: String(prof('strongback-mobility:sales_export:orders')),
      kind: 'sales_export', period_start: '2026-09-01', period_end: '2026-09-30', period_basis: 'content_dates' });
    const r = register(it, regReq(S1, { kind: 'sales_export', file_name: 'x.csv', storage_path: `reports/strongback-mobility/sales_export/${S1}.csv` }));
    assert.strictEqual(r.attention, 'duplicate_conflict');
  });
  t('a second, different commission statement for the same period registers and is flagged "possible correction"', () => {
    const m = msg({ internet_message_id: '<revised@strongback>' }); const S = H('e');
    const it = record(m, [item1(m, '2026-09 SR032 revised.pdf')]).items[0].id;
    classify(it, SR032(S)); const r = register(it, regReq(S, { file_name: '2026-09 SR032 revised.pdf' }));
    assert.strictEqual(r.state, 'registered'); assert.ok(r.possible_correction > 0);
    assert.strictEqual(q(`select attention from mfr_report_items where id=${it}`), 'possible_correction');
  });
  t('a register request that does not describe the item is refused (received date, period, path, hash, supersedes, kind)', () => {
    const m = msg({ internet_message_id: '<mismatch@strongback>' }); const S = H('f');
    const it = record(m, [item1(m, 'm.pdf')]).items[0].id; classify(it, SR032(S));
    for (const bad of [{ received_date: '2026-10-08' }, { report_period_start: '2026-08-01' }, { storage_path: `reports/x/commission_statement/${S}.pdf` },
      { file_sha256: H('9') }, { supersedes_id: '1', supersede_reason: 'x' }, { kind: 'sales_export' }, { prepared_date: '2026-10-01' }])
      refused(() => register(it, regReq(S, bad)), /capture_register_mismatch/);
  });
  t('a DRAFT profile never registers (capture_profile_inactive), and an unclassified item cannot be registered', () => {
    const m = msg({ internet_message_id: '<bemis@x>', from_address: 'faxstar03@bemismfg.com', manufacturer: 'bemis' }); const S = H('7');
    const it = record(m, [item1(m, '705-2026-08.csv')]).items[0].id;
    refused(() => register(it, regReq(S, { manufacturer: 'bemis' })), /capture_not_ready/);
    classify(it, { sha256: S, format: 'csv', manufacturer: 'bemis', profile_id: String(prof('bemis:commission_statement:rep705')), kind: 'commission_statement',
      period_start: '2026-08-01', period_end: '2026-08-31', period_basis: 'file_name' });
    refused(() => register(it, regReq(S, { manufacturer: 'bemis', report_period_start: '2026-08-01', report_period_end: '2026-08-31',
      storage_path: `reports/bemis/commission_statement/${S}.csv` })), /capture_profile_inactive/);
  });
  t('a profile given for the wrong manufacturer or kind is refused at classify', () => {
    const m = msg({ internet_message_id: '<wrongprof@x>' }); const it = record(m, [item1(m, 'w.pdf')]).items[0].id;
    refused(() => classify(it, SR032(H('8'), { kind: 'dealer_report' })), /capture_profile_mismatch/);
    refused(() => classify(it, SR032(H('8'), { manufacturer: 'bemis' })), /capture_profile_mismatch/);
  });
  t('the same Outlook attachment with different bytes later → content_changed exception (never overwritten)', () => {
    const m = msg({ internet_message_id: '<changed@x>' }); const it = record(m, [item1(m, 'c.pdf')]).items[0].id;
    classify(it, { sha256: H('1'), format: 'pdf', manufacturer: 'strongback-mobility' });
    const r = classify(it, { sha256: H('2'), format: 'pdf', manufacturer: 'strongback-mobility' });
    assert.strictEqual(r.attention, 'content_changed'); assert.strictEqual(q(`select sha256 from mfr_report_items where id=${it}`), H('1'));
  });

  console.log('\n— the retry queue —');
  let failItem;
  t('a failed download is a queued exception with backoff; after 8 attempts it waits for a person', () => {
    const m = msg({ internet_message_id: '<fails@x>' }); failItem = record(m, [item1(m, 'f.pdf')]).items[0].id;
    const waits = [];
    for (let k = 1; k <= 8; k++) {
      const r = call('hcps_mfr_capture_fail', { mailbox: MB, token: TOK, item_id: failItem, attention: 'attachment_failed', detail: 'Graph 503' });
      assert.strictEqual(r.attempts, k); assert.strictEqual(r.retryable, k < 8);
      waits.push(+q(`select coalesce(round(extract(epoch from next_retry_at - now())/60), -1) from mfr_report_items where id=${failItem}`));
    }
    assert.deepStrictEqual(waits, [15, 30, 60, 120, 240, 480, 960, -1]);
    assert.strictEqual(q(`select count(*) from mfr_report_capture_events where item_id=${failItem} and action='exception'`), '8');
  });
  t('an unknown attention code or a too-large file: refused / not retried', () => {
    const m = msg({ internet_message_id: '<big@x>' }); const it = record(m, [item1(m, 'big.pdf', 40e6)]).items[0].id;
    refused(() => call('hcps_mfr_capture_fail', { mailbox: MB, token: TOK, item_id: it, attention: 'whatever' }), /capture_bad_attention/);
    assert.strictEqual(call('hcps_mfr_capture_fail', { mailbox: MB, token: TOK, item_id: it, attention: 'too_large', retryable: false }).retryable, false);
  });

  console.log('\n— the checkpoint —');
  t('an item still "discovered" holds the checkpoint back (refused past it); an exception does not', () => {
    const m = msg({ internet_message_id: '<pending@x>', received_at: '2026-10-09T10:00:00Z' });
    const it = record(m, [item1(m, 'p.pdf')]).items[0].id;
    refused(() => finish('2026-10-10T00:00:00Z'), /capture_checkpoint_unaccounted/);
    call('hcps_mfr_capture_fail', { mailbox: MB, token: TOK, item_id: it, attention: 'attachment_failed' });
    // the earlier test emails with items still 'discovered' (the two-attachment email, one item of the mismatch email…)
    q(`select set_config('hcps.capture_op','on',false); update mfr_report_items set state = 'ignored' where state = 'discovered'`);
    const r = finish('2026-10-10T00:00:00Z'); assert.strictEqual(new Date(r.checkpoint_at).toISOString().slice(0, 10), '2026-10-10');
    assert.strictEqual(q(`select coalesce(lock_token,'none') from mfr_report_capture_state where mailbox='${MB}'`), 'none');
  });
  t('a recorded email whose items were never listed holds the checkpoint back; the checkpoint never moves backwards', () => {
    begin();
    record(msg({ internet_message_id: '<unlisted@x>', received_at: '2026-10-11T08:00:00Z' }), null);
    refused(() => finish('2026-10-12T00:00:00Z'), /capture_checkpoint_unaccounted/);
    const r = finish('2026-10-05T00:00:00Z'); assert.strictEqual(new Date(r.checkpoint_at).toISOString().slice(0, 10), '2026-10-10');
  });
  t('a lost lease (expired) refuses capture writes; the switch going off mid-run refuses writes but the run may close', () => {
    begin(); q(`select set_config('hcps.capture_op','on',false); update mfr_report_capture_state set lock_until = now() - interval '1 minute' where true`);
    refused(() => record(msg(), null), /capture_lease_lost/);
    begin(); setSwitch('false'); refused(() => record(msg(), null), /capture_switch_off/);
    assert.ok(finish(null).checkpoint_at); setSwitch('true');
  });

  console.log('\n— a person\'s decisions —');
  t('resolve needs a staff actor and a reason; dismiss / ignore / retry behave as described', () => {
    const R = o => call('hcps_mfr_capture_resolve', Object.assign({ item_id: failItem, action: 'retry', reason: 'Graph is back', actor: 'staff:angelo@homecareproviderservices.us' }, o));
    refused(() => R({ actor: 'angelo' }), /capture_actor_required/);
    refused(() => R({ reason: '' }), /capture_reason_required/);
    refused(() => R({ action: 'delete' }), /capture_bad_action/);
    R({}); assert.strictEqual(q(`select state || '|' || retryable || '|' || (next_retry_at <= now()) from mfr_report_items where id=${failItem}`), 'exception|true|true');
    R({ action: 'dismiss', reason: 'checked in Outlook' });
    assert.strictEqual(q(`select resolution || '|' || retryable from mfr_report_items where id=${failItem}`), 'dismissed|false');
    refused(() => R({ action: 'dismiss' }), /capture_nothing_to_resolve/);
    R({ action: 'ignore', reason: 'not a report' }); assert.strictEqual(q(`select state from mfr_report_items where id=${failItem}`), 'ignored');
    refused(() => R({ item_id: sr032, action: 'ignore' }), /capture_cannot_ignore/);
    refused(() => R({ item_id: sr032, action: 'retry' }), /capture_cannot_retry/);
    assert.ok(+q(`select count(*) from mfr_report_capture_events where actor like 'staff:%'`) >= 3);
  });
  t('a person may decide even while the switch is off', () => {
    setSwitch(undefined); const m2 = q(`select id from mfr_report_items where attention='duplicate_conflict' limit 1`);
    call('hcps_mfr_capture_resolve', { item_id: +m2, action: 'dismiss', reason: 'kept as the sales export', actor: 'staff:angelo@homecareproviderservices.us' });
    setSwitch('true');
  });
  t('the event log is append-only, even for the owner with the marker', () => {
    refused(() => q(`select set_config('hcps.capture_op','on',false); update mfr_report_capture_events set reason = 'x' where true`), /append-only/);
    refused(() => q(`select set_config('hcps.capture_op','on',false); delete from mfr_report_capture_events where true`), /never deleted/);
  });
  t('nothing outside capture changed: no monthly_sales / dealers rows; only report records + their events were added by registration', () => {
    const [, , ms, dl] = q(FP).split(':'); const [, , ms0, dl0] = fp0.split(':');
    assert.strictEqual(ms, ms0); assert.strictEqual(dl, dl0);
    assert.strictEqual(q(`select count(*) from mfr_sources where created_by = 'system:report-capture' and status <> 'received'`), '0');
    assert.strictEqual(q(`select count(*) from mfr_sources where publication_status = 'published'`), '0');
  });
  console.log('\n— rollback —');
  t('the rollback refuses while captured provenance exists (nothing written)', () => {
    const before = q(`select count(*) from mfr_report_items`);
    assert.throws(() => file(DB, path.join(__dirname, '..', 'supabase', 'mi_b_report_capture_rollback.sql')), /mi_b_rollback/);
    assert.strictEqual(q(`select count(*) from mfr_report_items`), before);
  });
  t('on an empty install the rollback removes every capture object and leaves MI-1b / record 7 untouched', () => {
    const D2 = DB + '_rb'; run('postgres', `drop database if exists ${D2}`); run('postgres', `create database ${D2}`);
    try {
      for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
        T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
        SB('mi1b_report_register.sql')]) file(D2, f);
      run(D2, APPSET); run(D2, `insert into manufacturers values ('ohio-medical','O'),('access4u','A'),('airavant-bongorx','B'),('climbing-steps','C'),('bemis','D'),('complete-medical-supplies','E'),('golden-technologies','G') on conflict do nothing`);
      const fpA = run(D2, `select count(*) || md5(coalesce(string_agg(proname || md5(prosrc), ',' order by proname), '')) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'hcps_mfr_report_%'`);
      file(D2, SB('mi_b_report_capture.sql'));
      const out = file(D2, path.join(__dirname, '..', 'supabase', 'mi_b_report_capture_rollback.sql'));
      assert.ok(/mi_b capture rolled back\|0\|0/.test(out.replace(/\s+/g, '')) || /rolled back\|0\|0/.test(out), out);
      assert.strictEqual(run(D2, `select count(*) || md5(coalesce(string_agg(proname || md5(prosrc), ',' order by proname), '')) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'hcps_mfr_report_%'`), fpA);
    } finally { run('postgres', `drop database if exists ${D2}`); }
  });
} catch (e) { fail++; console.log('  FAIL setup: ' + String(e.message || e).split('\n').slice(0, 3).join(' | ')); }
finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`\nmi-b-capture (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
