/* MI-1c — manufacturer dealer intelligence. The committed SQL (supabase/mi1c_dealer_intel.sql), run in a REAL Postgres
   with pg-safeupdate loaded, on top of the real chain: test/mi1a/fixture.sql → MI-1a Part 0/1 → Manufacturer Center
   Phase 1/2/6 → MI-1b → MI-1c (twice). HCPS dealers = the read-only production snapshot in
   test/fixtures/mi1c-hcps-2026-10-11.json.
   Two kinds of payload: a small synthetic report (always), and the REAL September 2026 Strongback PDF parsed by the
   real parser and matched by the real matcher (when the file is present: MI1C_PDF, default the uploaded copy). The PDF
   holds dealer contact details, so it is not committed to the repository.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/var/tmp/pgmi PGPORT=55433 PGUSER=postgres node test/mi1c-intel.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mi1c_' + process.pid;
const PDF = process.env.MI1C_PDF || '/mnt/user-data/uploads/Strongback_Report_Overview_September_2026.pdf';
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => (f === 'mi1c_dealer_intel.sql' && process.env.MI1C_SQL) ? process.env.MI1C_SQL : path.join(__dirname, '..', 'supabase', f),   // MI1C_SQL: a mutant copy
  T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
const FX = require('./fixtures/mi1c-hcps-2026-10-11.json');
const { buildPayload } = require('../netlify/functions/_dealer_intel.js');
const { matchDealers } = require('../netlify/functions/_dealer_intel_match.js');
const { HELD } = require('../netlify/functions/_dealer_intel.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }
const q = sql => run(DB, sql);
// Run SQL as a role, through a file (dollar-quoted jsonb, so any text in a payload survives as is).
const tmp = path.join(os.tmpdir(), 'mi1c_' + process.pid + '.sql');
function as(role, sql) { fs.writeFileSync(tmp, `begin; set local role ${role}; ${sql}; commit;\n`); return file(DB, tmp).trim(); }
const sr = sql => as('service_role', sql);
const J = o => `$mi1c$${JSON.stringify(o)}$mi1c$::jsonb`;
const imp = p => JSON.parse(sr(`select public.hcps_mfr_intel_import(${J(p)})`));
const dec = p => JSON.parse(sr(`select public.hcps_mfr_intel_match(${J(p)})`));
const refused = (fn, re) => { try { fn(); } catch (e) { assert.ok(re.test(e.message), 'wrong refusal: ' + e.message.split('\n').find(l => /ERROR/.test(l))); return; } throw new Error('NOT refused'); };
const H = c => c.repeat(64);
const U = s => s; // fixture ids are already uuids

// Fingerprints of everything MI-1c must never change.
const FP = `select md5(coalesce((select string_agg(t::text, ';' order by t.id) from dealers t),'')) || '|' ||
  md5(coalesce((select string_agg(t::text, ';' order by t.alias_norm) from dealer_aliases t),'')) || '|' ||
  md5(coalesce((select string_agg(t::text, ';' order by t.id) from monthly_sales t),'')) || '|' ||
  md5(coalesce((select string_agg(t::text, ';' order by t.id) from mfr_sources t),'')) || '|' ||
  (select count(*) from mfr_source_events)`;

// --- payloads -------------------------------------------------------------------------------------------
function synthParse(o) {
  o = o || {};
  const mk = (row_no, name, city, state, l12, extra) => Object.assign({ row_no, pos: `p1:y${700 - row_no * 30}.0`, page: 1, name, city_text: `${city}, ${state}`, city, state_text: state, state,
    tier: 'T3', trend: 'Growth Potential', l12m_text: '$' + l12, l12m: l12, month_text: '$0', month_amount: 0, last_order_text: '2026-08-21', last_order_date: '2026-08-21',
    ergosteel_text: 'not yet', ergosteel_chairs: null, floor_text: 'not known', detail_page: null }, extra || {});
  const page = (name, pos) => ({ name, pos, group: 'Trending up', tier_text: 'Tier 3', trend: 'Growth Potential', city_text: 'x', prior12_text: '$0', prior12: 0, bought_text: 'What they bought…',
    detail: { contacts: [{ lines: ['Pat Owner', 'Owner', '615-555-0100', 'pat@example.com'], name: 'Pat Owner', title: 'Owner', phones: ['615-555-0100'], emails: ['pat@example.com'], role: 'dealer_contact', pos: pos + ':x125' },
                         { lines: ['Angelo Audia', '(937) 626-5141'], name: 'Angelo Audia', title: null, phones: ['(937) 626-5141'], emails: [], role: 'report_owner', pos: pos + ':x283' }],
      last_order: { text: '2026-08-21', date: '2026-08-21', pos: 'x', lines: [{ text: 'Comfort M (1007-2025)', name: 'Comfort M', code: '1007-2025', class: 'product', pos: pos.replace(/y(\d+)/, (m, y) => 'y' + (y - 40)) }] },
      ergosteel: { text: 'Not ordered yet.', status: 'not_ordered', chairs: 0, orders: 0, first: null, last: null, note: null },
      floor: { text: 'Not known. Worth a look on your next visit.', status: 'not_known', note: 'Worth a look on your next visit.' },
      told_us: { text: 'Customer needed a 16x16 seat (2026-09-24).', dates: ['2026-09-24'], pos: pos.replace(/y(\d+)/, (m, y) => 'y' + (y - 60)) },
      // Two IDENTICAL notes printed in two places: two observations (source-position identity).
      contact_log: [{ date: '2026-07-02', channel: 'Email', text: 'Account/invoice follow-up.', pos: pos.replace(/y(\d+)/, (m, y) => 'y' + (y - 80)) },
                    { date: '2026-07-02', channel: 'Email', text: 'Account/invoice follow-up.', pos: pos.replace(/y(\d+)/, (m, y) => 'y' + (y - 95)) }] } });
  const dealers = [
    mk(1, 'Larco Medical', 'Cookeville', 'TN', 1576, { detail_page: page('Larco Medical', 'p10:y390.0') }),
    mk(2, 'Integrity Home Medical', 'Germantown', 'TN', 2023, { detail_page: page('Integrity Home Medical', 'p10:y739.5') }),
    mk(3, 'Nebcare', 'Columbus', 'GA', 0, { tier: 'T4', trend: 'One-Hit Wonder', l12m_text: '$0' }),
    mk(4, "Wyatt's Pharmacy Inc", 'Lithia Springs', 'GA', 0, { tier: 'T4', trend: 'One-Hit Wonder', l12m_text: '$0', floor_text: 'sample sent' }),
  ];
  return Object.assign({ parser: 'strongback-dealer-report/1',
    header: { title: 'Angelo Audia: your Strongback dealers', owner: 'Angelo Audia', through_text: 'September 2026', through_month: '2026-09', dealer_count: dealers.length, prepared_date: '2026-10-08' },
    kpis: [], sections: [], figures: {}, table: { footnote: 'x', tier_rule: { T1: 6550, T2: 2200, T3: 300 } }, groups: [{ heading: 'Trending up', count: 2, description: 'x', pos: 'p8:y741.0', dealers: [] }],
    dealers, offers: [{ text: 'No orders in a while. If it helps: 5% on the next Premium Chair order, Amanda sets it up.', where: 'group: Quiet lately', pos: 'p12:y725.3' }],
    checks: [{ id: 'dealer_count', ok: true, level: 'error', detail: 'x' }], errors: [], warnings: [] }, o);
}
const matchOf = parse => matchDealers({ rows: parse.dealers, hcps: FX, held: HELD['strongback-mobility'] });

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
(async () => {
  let real = null;
  if (fs.existsSync(PDF)) {
    const { extractLayout } = require('../netlify/functions/_strongback_layout.js');
    const { parseReport } = require('../netlify/functions/_strongback_report.js');
    const bytes = fs.readFileSync(PDF);
    const parse = parseReport(await extractLayout(bytes));
    real = { parse, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  try {
    for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
      T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
      SB('mi1b_report_register.sql')]) file(DB, f);
    // Production dealers carry these columns; the MI-1a fixture's minimal table does not.
    q(`alter table dealers add column if not exists is_test boolean default false, add column if not exists active boolean default true, add column if not exists account_class text`);
    q(`create table if not exists dealer_aliases (alias_norm text primary key, raw_name text, dealer_id uuid references dealers(id), created_at timestamptz default now())`);
    const vals = FX.dealers.map(d => `('${d.id}', $n$${d.business_name}$n$, ${d.parent_id ? `'${d.parent_id}'` : 'null'}, $c$${d.city || ''}$c$, '${d.state || ''}')`);
    q(`insert into dealers (id, business_name, parent_id, city, state) values ${vals.join(',')}`);
    q(`insert into dealer_aliases (alias_norm, dealer_id) values ${FX.aliases.map(a => `($a$${a.alias_norm}$a$, '${a.dealer_id}')`).join(',')}`);
    q(`insert into dealers (id, business_name, city, state, is_test) values ('00000000-0000-4000-8000-0000000000aa','TEST sandbox dealer','Nowhere','TN', true)`);

    // An accepted September dealer report (MI-1b), plus an August one for the closed-source checks.
    const register = (sha, start, end, extra) => JSON.parse(sr(`select public.hcps_mfr_report_register(${J(Object.assign({ manufacturer: 'strongback-mobility', kind: 'dealer_report',
      file_name: 'Strongback_Report_Overview_' + start + '.pdf', file_sha256: sha, storage_path: `reports/strongback-mobility/dealer_report/${sha}.pdf`, file_size: 515614,
      content_type: 'application/pdf', received_date: '2026-10-10', prepared_date: '2026-10-08', report_period_start: start, report_period_end: end, actor: 'angelo@hcps.us' }, extra || {}))})`));
    const accept = id => sr(`select public.hcps_mfr_report_decide(${J({ id, decision: 'accepted', actor: 'angelo@hcps.us' })})`);

    console.log('\n— install —');
    let fp0;
    t('MI-1c applies, and applies again; every install check ok', () => {
      file(DB, SB('mi1c_dealer_intel.sql')); const out = file(DB, SB('mi1c_dealer_intel.sql'));
      const rows = out.trim().split('\n').filter(l => /^\d+\|/.test(l)); assert.strictEqual(rows.length, 7, out);
      for (const r of rows) assert.ok(/\|t$/.test(r), 'check failed: ' + r);
      fp0 = q(FP);
    });
    t('nothing existing changed by the install (dealers, aliases, monthly_sales, mfr_sources, MI-1b events)', () => assert.strictEqual(q(FP), fp0));
    t('MI-1b publication still refuses a dealer report with no staged intelligence', () => {
      const s = register(H('1'), '2026-07-01', '2026-07-31'); accept(s.id);
      refused(() => sr(`select public.hcps_mfr_report_publication(${J({ id: s.id, action: 'publish', actor: 'a' })})`), /mi1b_publish_unavailable/);
    });

    console.log('\n— RULE 19: who can read or write —');
    for (const tb of ['mfr_intel_reports', 'mfr_dealer_snapshots', 'mfr_dealer_observations', 'mfr_intel_events']) {
      t(`${tb}: anon and authenticated cannot read; service_role reads but cannot insert/update/delete`, () => {
        for (const r of ['anon', 'authenticated']) refused(() => as(r, `select count(*) from ${tb}`), /permission denied/);
        assert.strictEqual(sr(`select count(*) from ${tb}`).split('\n').pop(), '0');
        refused(() => sr(`insert into ${tb} (id) values (1)`), /permission denied/);
        refused(() => sr(`update ${tb} set id = id where true`), /permission denied/);
        refused(() => sr(`delete from ${tb} where true`), /permission denied/);
      });
    }
    t('anon / authenticated cannot run import or match; nobody but the owner runs the guard', () => {
      for (const r of ['anon', 'authenticated']) {
        refused(() => as(r, `select public.hcps_mfr_intel_import('{}'::jsonb)`), /permission denied/);
        refused(() => as(r, `select public.hcps_mfr_intel_match('{}'::jsonb)`), /permission denied/); }
      assert.strictEqual(q(`select has_function_privilege('service_role','public.hcps_mfr_intel_guard()','execute')`), 'f');
    });
    t('even the owner cannot write a row by hand (guard): insert, and a forged op flag as service_role', () => {
      refused(() => q(`insert into mfr_intel_events (source_id, action, actor) values (1,'imported','x')`), /written only by|only through/);
      refused(() => sr(`select set_config('hcps.mfr_intel_op','import',true); insert into mfr_intel_events (source_id, action, actor) values (1,'imported','x')`), /permission denied/);
    });

    console.log('\n— import: refusals (nothing written) —');
    const sep = register(real ? real.sha : H('a'), '2026-09-01', '2026-09-30'); accept(sep.id);
    const sepSha = real ? real.sha : H('a');
    const sp = synthParse(); const sm = matchOf(sp);
    const P = (o) => Object.assign(buildPayload({ source: { id: sep.id, file_sha256: sepSha }, parse: sp, matches: sm, actor: 'angelo@hcps.us' }), o || {});
    const before = () => q(`select (select count(*) from mfr_intel_reports)||'/'||(select count(*) from mfr_dealer_snapshots)||'/'||(select count(*) from mfr_dealer_observations)||'/'||(select count(*) from mfr_intel_events)`);
    const empty = before();
    const cases = [
      ['no actor', P({ actor: '' }), /mi1c_actor_required/],
      ['an unknown source', P({ source_id: 999999 }), /mi1c_no_source/],
      ['a source that is not a dealer report', (() => { const s = JSON.parse(sr(`select public.hcps_mfr_report_register(${J({ manufacturer: 'strongback-mobility', kind: 'sales_export', file_name: 'o.xlsx', file_sha256: H('2'), storage_path: `reports/strongback-mobility/sales_export/${H('2')}.xlsx`, file_size: 9, content_type: 'x', received_date: '2026-10-10', report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'a' })})`)); return P({ source_id: s.id }); })(), /mi1c_not_a_dealer_report/],
      ['a received (not accepted) report', (() => { const s = register(H('3'), '2026-06-01', '2026-06-30'); return P({ source_id: s.id, file_sha256: H('3'), period_start: '2026-06-01', period_end: '2026-06-30' }); })(), /mi1c_not_accepted/],
      ['a different file than the one registered', P({ file_sha256: H('4') }), /mi1c_wrong_file/],
      ['a period that differs from the register', P({ period_start: '2026-08-01', period_end: '2026-08-31' }), /mi1c_period_mismatch/],
      ['a parse with errors', P({ errors: [{ id: 'x', detail: 'y' }] }), /mi1c_parse_errors/],
      ['fewer dealer rows than the report says', (() => { const p = P(); p.dealers = p.dealers.slice(1); return p; })(), /mi1c_dealer_count/],
      ['a "matched" row naming a dealer that does not exist', (() => { const p = P(); p.dealers[0].match.dealer_id = '00000000-0000-4000-8000-0000000000ff'; return p; })(), /mi1c_bad_match/],
      ['a "matched" row naming a TEST dealer', (() => { const p = P(); p.dealers[0].match.dealer_id = '00000000-0000-4000-8000-0000000000aa'; return p; })(), /mi1c_bad_match/],
      ['a "review" row naming a dealer', (() => { const p = P(); p.dealers[1].match.dealer_id = p.dealers[1].match.evidence.candidates[0].dealer_id; return p; })(), /mi1c_bad_match/],
      ['an observation for a row the report does not have', (() => { const p = P(); p.observations.push({ row_no: 77, kind: 'told_us', position_key: 'p9:y1.0', text: 'x' }); return p; })(), /mi1c_orphan_observation/],
      ['an unknown chair-on-floor wording', (() => { const p = P(); p.dealers[2].floor_text = 'on display'; return p; })(), /display_status|not-null|null value/],
      ['an unknown observation kind', (() => { const p = P(); p.observations[0].kind = 'task'; return p; })(), /mfr_dealer_observations_kind_check|check constraint/],
    ];
    for (const [name, p, re] of cases) t(`refused: ${name}`, () => { refused(() => imp(p), re); assert.strictEqual(before(), empty); });

    console.log('\n— import: one transaction, idempotent, nothing else touched —');
    let res;
    t('the synthetic report imports: 4 snapshots, every observation, one audit event', () => {
      res = imp(P());
      assert.strictEqual(res.ok, true); assert.strictEqual(res.dealers, 4); assert.strictEqual(res.existing, false);
      assert.strictEqual(q(`select count(*) from mfr_intel_events where action='imported' and source_id=${sep.id}`), '1');
      assert.strictEqual(+res.observations, P().observations.length);
    });
    t('matches as proposed: Larco matched (automatic), Integrity review, Nebcare unmatched, Wyatt\'s held', () => {
      const r = q(`select string_agg(printed_name||':'||match_status||':'||coalesce(left(dealer_id::text,8),'-')||':'||coalesce(matched_by,'-'), ' | ' order by row_no) from mfr_dealer_snapshots where source_id=${sep.id}`);
      assert.strictEqual(r, "Larco Medical:matched:4e9c6a43:system:mi1c-matcher | Integrity Home Medical:review:-:- | Nebcare:unmatched:-:- | Wyatt's Pharmacy Inc:held:-:-");
    });
    t('Strongback wording kept as printed; "sample sent" is stored as sample_sent, never as on display', () => {
      assert.strictEqual(q(`select display_status||'/'||floor_text||'/'||trend from mfr_dealer_snapshots where source_id=${sep.id} and row_no=4`), 'sample_sent/sample sent/One-Hit Wonder');
    });
    t('two identical notes printed in two places stay two observations (source-position identity)', () => {
      assert.strictEqual(q(`select count(*) from mfr_dealer_observations o join mfr_dealer_snapshots s on s.id=o.snapshot_id where s.source_id=${sep.id} and s.row_no=1 and o.kind='contact_log'`), '2');
    });
    t('dealer contacts are proposals; the report-owner column is kept but never proposed', () => {
      assert.strictEqual(q(`select string_agg(structured->>'role'||':'||coalesce(review_state,'-'), ',' order by o.position_key) from mfr_dealer_observations o join mfr_dealer_snapshots s on s.id=o.snapshot_id where s.row_no=1 and s.source_id=${sep.id} and o.kind='contact_person'`), 'dealer_contact:proposed,report_owner:-');
    });
    t('the offer is a report-level observation, marked unverified', () => {
      assert.ok(/unverified/.test(q(`select structured->>'status' from mfr_dealer_observations where kind='offer' and source_id=${sep.id}`)));
    });
    t('the same import again returns the existing one and writes nothing', () => {
      const n = before(); const r2 = imp(P()); assert.strictEqual(r2.existing, true); assert.strictEqual(r2.report_id, res.report_id); assert.strictEqual(before(), n);
    });
    t('a DIFFERENT parse for the same source is refused (a correction is a new source)', () => {
      const p = P(); p.dealers[0].l12m_text = '$9,999'; refused(() => imp(p), /mi1c_already_imported/);
    });
    t('dealers, aliases, monthly_sales, mfr_sources and MI-1b events are byte-identical after the import', () => {
      // mfr_sources/events changed only by this test's own MI-1b registrations above, so re-take after them.
      const now = q(FP).split('|'), was = fp0.split('|');
      assert.deepStrictEqual(now.slice(0, 3), was.slice(0, 3));
    });

    console.log('\n— guard: the manufacturer\'s figures never change —');
    const snap = q(`select id from mfr_dealer_snapshots where source_id=${sep.id} and row_no=2`);
    t('updating a printed figure by hand is refused (owner included)', () => refused(() => q(`update mfr_dealer_snapshots set l12m_text='$1' where id=${snap}`), /only through|never change|only the match/));
    t('deleting a snapshot / observation / report / event is refused', () => {
      refused(() => q(`delete from mfr_dealer_snapshots where id=${snap}`), /never deleted/);
      refused(() => q(`delete from mfr_dealer_observations where source_id=${sep.id}`), /never deleted/);
      refused(() => q(`delete from mfr_intel_reports where source_id=${sep.id}`), /never deleted/);
      refused(() => q(`delete from mfr_intel_events where source_id=${sep.id}`), /never deleted/);
    });
    t('truncating any MI-1c table is refused', () => { for (const tb of ['mfr_intel_reports', 'mfr_dealer_snapshots', 'mfr_dealer_observations', 'mfr_intel_events']) refused(() => q(`truncate ${tb} cascade`), /never truncated/); });
    t('an observation never changes once written', () => refused(() => q(`update mfr_dealer_observations set text='x' where source_id=${sep.id}`), /never change|only through/));

    console.log('\n— match decisions —');
    const ver = () => +q(`select match_version from mfr_dealer_snapshots where id=${snap}`);
    const GERM = 'e7e2133a-0000-4000-8000-000000000000';
    t('a person matches the review row: version +1, method manual, reason and actor kept, one audit event with the evidence', () => {
      const r = dec({ snapshot_id: +snap, decision: 'matched', dealer_id: GERM, reason: 'Strongback means the Germantown store (root of the family)', actor: 'angelo@hcps.us', expected_version: 0 });
      assert.strictEqual(r.match_version, 1);
      assert.strictEqual(q(`select match_status||'/'||dealer_id||'/'||match_method||'/'||matched_by from mfr_dealer_snapshots where id=${snap}`), `matched/${GERM}/manual/angelo@hcps.us`);
      const ev = JSON.parse(q(`select detail from mfr_intel_events where snapshot_id=${snap} and action='match_decided'`));
      assert.strictEqual(ev.from.status, 'review'); assert.strictEqual(ev.to.dealer_id, GERM); assert.ok(ev.evidence.candidates.length >= 2);
    });
    t('replaying the same decision is a no-op (no new event, same version)', () => {
      const n = q(`select count(*) from mfr_intel_events where snapshot_id=${snap}`);
      const r = dec({ snapshot_id: +snap, decision: 'matched', dealer_id: GERM, reason: 'again', actor: 'angelo@hcps.us', expected_version: 0 });
      assert.strictEqual(r.unchanged, true); assert.strictEqual(q(`select count(*) from mfr_intel_events where snapshot_id=${snap}`), n); assert.strictEqual(ver(), 1);
    });
    t('a stale decision (shown before someone else decided) is refused', () =>
      refused(() => dec({ snapshot_id: +snap, decision: 'review', reason: 'x', actor: 'b', expected_version: 0 }), /mi1c_stale/));
    t('refused: no reason; a dealer with a non-match; "matched" without a dealer; a TEST dealer; an unknown decision', () => {
      refused(() => dec({ snapshot_id: +snap, decision: 'review', reason: ' ', actor: 'a', expected_version: 1 }), /mi1c_reason_required/);
      refused(() => dec({ snapshot_id: +snap, decision: 'review', dealer_id: GERM, reason: 'x', actor: 'a', expected_version: 1 }), /mi1c_bad_decision/);
      refused(() => dec({ snapshot_id: +snap, decision: 'matched', reason: 'x', actor: 'a', expected_version: 1 }), /mi1c_bad_decision/);
      refused(() => dec({ snapshot_id: +snap, decision: 'matched', dealer_id: '00000000-0000-4000-8000-0000000000aa', reason: 'x', actor: 'a', expected_version: 1 }), /mi1c_bad_match/);
      refused(() => dec({ snapshot_id: +snap, decision: 'merge', reason: 'x', actor: 'a', expected_version: 1 }), /mi1c_bad_decision/);
      assert.strictEqual(ver(), 1);
    });
    t('a match never changes the dealer, its family, its rep or its aliases (fingerprints)', () => assert.deepStrictEqual(q(FP).split('|').slice(0, 3), fp0.split('|').slice(0, 3)));
    t('Wyatt\'s stays held until a person decides — and a person may decide, with a reason', () => {
      const w = q(`select id||'/'||match_version from mfr_dealer_snapshots where source_id=${sep.id} and row_no=4`).split('/');
      const r = dec({ snapshot_id: +w[0], decision: 'unmatched', reason: 'confirmed: not a Weaver location', actor: 'angelo@hcps.us', expected_version: +w[1] });
      assert.strictEqual(r.match_status, 'unmatched');
    });

    console.log('\n— concurrency (two real sessions) —');
    const race = (sqlA, sqlB) => {
      const fa = tmp + '.a', fb = tmp + '.b';
      fs.writeFileSync(fa, `begin; set local role service_role; ${sqlA}; select pg_sleep(1.5); commit;\n`); fs.writeFileSync(fb, `begin; set local role service_role; ${sqlB}; commit;\n`);
      const ps = f => `${PSQL} -X -q -A -t -v ON_ERROR_STOP=1 -d ${DB} -f ${f}`;
      const r = spawnSync('bash', ['-c', `(${ps(fa)}) > ${fa}.out 2>&1 & sleep 0.4; (${ps(fb)}) > ${fb}.out 2>&1; wait; echo "A:"; cat ${fa}.out; echo "B:"; cat ${fb}.out`], { encoding: 'utf8' });
      for (const f of [fa, fb, fa + '.out', fb + '.out']) try { fs.unlinkSync(f); } catch (e) {}
      const out = r.stdout || ''; const i = out.indexOf('\nB:'); return { a: out.slice(3, i), b: out.slice(i + 3) };
    };
    t('the same report imported by two sessions at once → ONE import; the second gets "existing"', () => {
      const s = register(H('5'), '2026-05-01', '2026-05-31'); accept(s.id);
      const p = Object.assign(P(), { source_id: s.id, file_sha256: H('5'), period_start: '2026-05-01', period_end: '2026-05-31' });
      const sql = `select public.hcps_mfr_intel_import(${J(p)})`;
      const r = race(sql, sql);
      assert.ok(/"existing": false/.test(r.a), 'A imports: ' + r.a); assert.ok(/"existing": true/.test(r.b), 'B finds it: ' + r.b);
      assert.strictEqual(q(`select count(*) from mfr_intel_reports where source_id=${s.id}`), '1');
      assert.strictEqual(q(`select count(*) from mfr_dealer_snapshots where source_id=${s.id}`), '4');
    });
    t('two people deciding the same row at once → one decision lands, the other is told it is stale', () => {
      const id = q(`select s.id from mfr_dealer_snapshots s join mfr_sources m on m.id=s.source_id where m.file_sha256='${H('5')}' and s.row_no=2`);
      const mk = (dealer) => `select public.hcps_mfr_intel_match(${J({ snapshot_id: +id, decision: 'matched', dealer_id: dealer, reason: 'race', actor: 'a', expected_version: 0 })})`;
      const r = race(mk(GERM), mk('186eb95f-0000-4000-8000-000000000000'));
      assert.ok(/"unchanged": false/.test(r.a), r.a); assert.ok(/mi1c_stale/.test(r.b), 'B: ' + r.b);
      assert.strictEqual(q(`select match_version||'/'||dealer_id from mfr_dealer_snapshots where id=${id}`), `1/${GERM}`);
      assert.strictEqual(q(`select count(*) from mfr_intel_events where snapshot_id=${id}`), '1');
    });

    console.log('\n— closed reports (MI-1b supersession) —');
    t('after a correction supersedes the report, its matches no longer change (snapshots kept)', () => {
      const corr = register(H('6'), '2026-09-01', '2026-09-30', { supersedes_id: sep.id, supersede_reason: 'Strongback re-sent September' });
      accept(corr.id);
      assert.strictEqual(q(`select status from mfr_sources where id=${sep.id}`), 'superseded');
      const s = q(`select id||'/'||match_version from mfr_dealer_snapshots where source_id=${sep.id} and row_no=3`).split('/');
      refused(() => dec({ snapshot_id: +s[0], decision: 'review', reason: 'x', actor: 'a', expected_version: +s[1] }), /mi1c_source_closed/);
      assert.strictEqual(q(`select count(*) from mfr_dealer_snapshots where source_id=${sep.id}`), '4');
      refused(() => imp(P()), /mi1c_not_accepted/);
    });
    t('MI-1b publish of the imported May report is possible once intelligence exists (publication stays a separate, explicit step)', () => {
      const s = q(`select id from mfr_sources where file_sha256='${H('5')}'`);
      const r = JSON.parse(sr(`select public.hcps_mfr_report_publication(${J({ id: +s, action: 'publish', actor: 'angelo@hcps.us' })})`));
      assert.strictEqual(r.publication_status, 'published');
    });

    if (real) {
      console.log('\n— the REAL September 2026 report (parser + matcher + SQL) —');
      const corr = q(`select id from mfr_sources where file_sha256='${H('6')}'`);
      // The real file is registered as source `sep`, now superseded in this test database; register the real file under a fresh period-free database.
      const D2 = DB + '_real'; run('postgres', `drop database if exists ${D2}`); run('postgres', `create database ${D2}`);
      const q2 = s => run(D2, s);
      const as2 = (role, sql) => { fs.writeFileSync(tmp, `begin; set local role ${role}; ${sql}; commit;\n`); return file(D2, tmp).trim(); };
      for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
        T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
        SB('mi1b_report_register.sql'), SB('mi1c_dealer_intel.sql')]) file(D2, f);
      q2(`alter table dealers add column if not exists is_test boolean default false, add column if not exists active boolean default true, add column if not exists account_class text`);
      q2(`insert into dealers (id, business_name, parent_id, city, state) values ${vals.join(',')}`);
      const fpReal0 = run(D2, FP.replace(/md5\(coalesce\(\(select string_agg\(t::text, ';' order by t.alias_norm\) from dealer_aliases t\),''\)\) \|\| '\|' \|\|/, ''));
      const s = JSON.parse(as2('service_role', `select public.hcps_mfr_report_register(${J({ manufacturer: 'strongback-mobility', kind: 'dealer_report', file_name: 'Strongback_Report_Overview_September_2026.pdf',
        file_sha256: real.sha, storage_path: `reports/strongback-mobility/dealer_report/${real.sha}.pdf`, file_size: 515614, content_type: 'application/pdf', received_date: '2026-10-10',
        prepared_date: '2026-10-08', report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'angelo@hcps.us' })})`));
      as2('service_role', `select public.hcps_mfr_report_decide(${J({ id: s.id, decision: 'accepted', actor: 'angelo@hcps.us' })})`);
      const m = matchOf(real.parse);
      const p = buildPayload({ source: { id: s.id, file_sha256: real.sha }, parse: real.parse, matches: m, actor: 'angelo@hcps.us' });
      let r;
      t('the real report imports: 25 dealers, 0 parse errors', () => {
        r = JSON.parse(as2('service_role', `select public.hcps_mfr_intel_import(${J(p)})`));
        assert.strictEqual(r.dealers, 25); assert.strictEqual(real.parse.errors.length, 0);
      });
      t('match outcomes: 15 matched, 7 review, 1 held (Wyatt\'s), 2 unmatched (GF Health, Nebcare)', () => {
        assert.strictEqual(q2(`select string_agg(match_status||':'||n, ',' order by match_status) from (select match_status, count(*) n from mfr_dealer_snapshots group by 1) x`), 'held:1,matched:15,review:7,unmatched:2');
        assert.strictEqual(q2(`select string_agg(printed_name, ',' order by printed_name) from mfr_dealer_snapshots where match_status in ('held','unmatched')`), "GF Health Products Inc,Nebcare,Wyatt's Pharmacy Inc");
      });
      t('observations: 30 dealer contacts proposed + 2 report-owner columns, 34 product lines, 8 told-us notes, 51 contact-log entries, 2 offers', () => {
        assert.strictEqual(q2(`select string_agg(kind||':'||n, ',' order by kind) from (select kind, count(*) n from mfr_dealer_observations group by 1) x`),
          'contact_log:51,contact_person:32,offer:2,product_line:34,told_us:8');
        assert.strictEqual(q2(`select count(*) from mfr_dealer_observations where kind='contact_person' and review_state='proposed'`), '30');
      });
      t('printed spellings kept: Lacey "Ackworth", and matched to Lacey Drug Company (Acworth) by its sales history', () =>
        assert.strictEqual(q2(`select printed_city||'/'||left(dealer_id::text,8) from mfr_dealer_snapshots where printed_name='Lacey Drug Company'`), 'Ackworth/a8697eec'));
      t('report header keeps Strongback\'s own figures as printed (September $2,159; 12 months $43,317; prepared 2026-10-08)', () =>
        assert.strictEqual(q2(`select (header->'kpis'->0->>'value_text')||'/'||(header->'kpis'->3->>'value_text')||'/'||prepared_date from mfr_intel_reports`), '$2,159/$43,317/2026-10-08'));
      t('importing the real report changed no dealer, sale or source record', () =>
        assert.strictEqual(run(D2, FP.replace(/md5\(coalesce\(\(select string_agg\(t::text, ';' order by t.alias_norm\) from dealer_aliases t\),''\)\) \|\| '\|' \|\|/, '')).split('|').slice(0, 2).join('|'), fpReal0.split('|').slice(0, 2).join('|')));
      t('the real import is idempotent', () => { const r2 = JSON.parse(as2('service_role', `select public.hcps_mfr_intel_import(${J(p)})`)); assert.strictEqual(r2.existing, true); });
      run('postgres', `drop database if exists ${D2}`);
    } else console.log('\n  (the real September PDF is not present here — the real-report section did not run; set MI1C_PDF)');

    console.log('\n— rollback —');
    t('rollback refuses while imported intelligence exists — nothing written', () => {
      assert.throws(() => file(DB, SB('mi1c_dealer_intel_rollback.sql')), /never dropped|exist/);
      assert.ok(+q(`select count(*) from mfr_dealer_snapshots`) > 0);
    });
    t('on a database with no imports, rollback removes MI-1c completely, leaves MI-1b intact, and MI-1c installs again', () => {
      const D3 = DB + '_rb'; run('postgres', `drop database if exists ${D3}`); run('postgres', `create database ${D3}`);
      for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
        T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'), SB('mi1b_report_register.sql')]) file(D3, f);
      const shape = `select count(*) || '/' || (select count(*) from pg_proc where proname like 'hcps_mfr_%') || '/' || (select md5(string_agg(conname, ',' order by conname)) from pg_constraint where conrelid='public.mfr_sources'::regclass) from pg_class where relname like 'mfr\\_%'`;
      const b = run(D3, shape);
      file(D3, SB('mi1c_dealer_intel.sql')); file(D3, SB('mi1c_dealer_intel_rollback.sql'));
      assert.strictEqual(run(D3, shape), b);
      file(D3, SB('mi1c_dealer_intel.sql'));
      run('postgres', `drop database if exists ${D3}`);
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
    run('postgres', `drop database if exists ${DB}`);
  }
  console.log(`\nmi1c-intel (Postgres): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
