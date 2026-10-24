/* Catalog importer → Manufacturer Center handoff (PR #35 review). The package a stageable line produces is sent, as a
   DRY RUN, through the REAL catalog-api actions mc_import_source_rows and stage_record_source (in-memory PostgREST
   from phase0-mock.js — nothing reaches a database). Then the offline CLI: byte-identical reruns, stop-on-blocker
   (no import rows written), the gce alias, and a batch where one failing line does not stop the others.
   Synthetic sources only: both repos are public. */
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = path.join(__dirname, '..', 'netlify', 'functions');
const CI = require(path.join(ROOT, '_catalog_import.js'));
const A = require(path.join(ROOT, '_import_adapters.js'));
const CLI = path.join(__dirname, '..', 'scripts', 'catalog-import.js');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const norm = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const OB = 'https://ordering.test', SL = 'ohio-medical';

function xlsx(aoa) { const X = require('xlsx'); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), 'Sheet1'); return X.write(wb, { type: 'buffer', bookType: 'xlsx' }); }
const SHEET = [['Item Number', 'Description', 'Category', 'Package Contents', 'Product Weight', 'Oxygen Flow', 'Price Each', 'Price 5+', 'MSRP'],
  ['SYN-1', 'Synthetic concentrator', 'Cat', '', '', '', '$100.00', '$90.00', '$250.00'], ['CAN-55', 'Synthetic cannula', 'Cat', '', '', '', '$5.00', '', '']];

function world() {
  const W = M.createWorld({ serialIds: require('./mc-gates.js').SERIAL, tables: {
    manufacturer_meta: [{ slug: SL, frozen: false, record_authoritative: false }],
    product_skus: [{ manufacturer: SL, code: 'SYN-1', base_price: 95, msrp: 240, map: 200, tiers: [{ min_qty: 5, price: 88 }], status: 'active', uom: 'Each', case_qty: 1, source_file: 'old.xlsx', effective_date: '2025-01-01' },
      { manufacturer: SL, code: 'LEGACY-9', base_price: 7, status: 'active', uom: 'Each' }],
    mfr_sources: [{ id: 3, manufacturer: SL, kind: 'price_list', title: 'Synthetic list', file_name: 'synthetic.xlsx', status: 'accepted', received_date: '2026-10-20', effective_date_status: 'pending', manufacturer_effective_date: null }],
    price_imports: [], custom_products: [], product_overrides: [], product_content: [], mfr_decisions: [] } });
  const inner = W.fetch;
  W.fetch = async (u, o) => { u = String(u); if (u.startsWith(OB + '/data/')) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    (W.db.product_skus || []).forEach(r => { r.code_norm = norm(r.code); }); return inner(u, o); };
  return W;
}
const mod = W => M.load('catalog-api.js', W, { ANALYTICS_TOKEN: 'pass', ORDERING_BASE: OB }, ROOT);
const call = (C, b) => M.call(C, b, { headers: { 'x-analytics-token': 'pass' } });
const buildPkg = (slug, received) => {
  const L = A.adapterFor(slug).fn(xlsx(SHEET), 'synthetic.xlsx'); CI.applyReceipt(L, received === undefined ? { date: '2026-10-20', basis: 'mailbox_attachment_match', attachment_name: 'synthetic.xlsx', attachment_sha256: L.source.sha256, message_id: '<syn@x>' } : received);
  const V = CI.validateLine(L); return CI.buildPackage(V, CI.compareLine(V, {}), { today: '2026-10-23' });
};

(async () => {
await t('handoff: the package is accepted by the real mc_import_source_rows (dry run) with provenance on every row', async () => {
  const P = buildPkg('gce'); eq([P.stageable, P.manufacturer], [true, SL], JSON.stringify(P.exceptions));
  const W = world(), C = mod(W);
  const r = await call(C, Object.assign({}, P.handoff.mc_import_source_rows, { source_id: 3, dry_run: true }));
  eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.would_insert, 2);
  for (const x of r.body.rows) {
    eq([x.source_file, x.effective_date, x.source_id], ['synthetic.xlsx', null, 3], 'register provenance');
    eq(x.raw._provenance, { file: 'synthetic.xlsx', sha256: P.handoff.register.sha256, received_date: '2026-10-20', received_basis: 'mailbox_attachment_match',
      received_evidence: { basis: 'mailbox_attachment_match', attachment_name: 'synthetic.xlsx', attachment_sha256: P.handoff.register.sha256, message_id: '<syn@x>', verified_by: null, note: null },
      effective_date: null, effective_date_status: 'not_stated' });
  }
  eq(r.body.rows.map(x => [x.code, x.base_price, x.msrp, (x.tiers || []).length]), [['SYN-1', 100, 250, 2], ['CAN-55', 5, null, 0]]);
  eq(W.writes.length, 0, 'a dry run writes nothing');
});
await t('handoff: stage_record_source (dry run) plans only the listed SKUs, clears nothing, keeps unstated fields, never retires by omission', async () => {
  const P = buildPkg('ohio-medical'); const W = world(), C = mod(W);
  const r = await call(C, Object.assign({}, P.handoff.stage_record_source, { source_id: 3 }));
  eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.dry_run, true);
  eq(r.body.plan.map(p => p.code + ':' + p.action), ['SYN-1:update', 'CAN-55:create'], 'LEGACY-9 is not in the plan');
  eq(r.body.would_clear_refused, [], 'nothing would be cleared');
  const p1 = r.body.plan.find(p => p.code === 'SYN-1');
  eq(Object.keys(p1.changed).sort(), ['base_price', 'msrp', 'tiers']); ok(p1.not_in_source.includes('map') && p1.not_in_source.includes('status'), 'MAP and status kept');
  eq([p1.provenance.source_file, p1.provenance.source_id, p1.provenance.effective_date], ['synthetic.xlsx', 3, null], 'a new file never inherits the old effective date');
  eq(W.db.product_skus.find(x => x.code === 'LEGACY-9').status, 'active'); eq(W.writes.length, 0);
});
await t('handoff: a frozen line and a retired line produce no payload at all', async () => {
  for (const s of ['bemis', 'climbing-steps', 'ovation-medical', 'strongback-mobility', 'complete-medical-supplies']) {
    const V = CI.validateLine({ manufacturer: s, source: { file: 'x.xlsx', sha256: 'h', received_date: '2026-10-20', effective_date_status: 'not_stated' }, rows: [{ code: 'A', dealer_price: 1, flags: [] }] });
    const P = CI.buildPackage(V, CI.compareLine(V, {}), { today: '2026-10-23' });
    eq([P.stageable, P.handoff], [false, null], s);
  }
});

// ---- the CLI
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catimp-'));
const file = path.join(tmp, 'synthetic.xlsx'); fs.writeFileSync(file, xlsx(SHEET));
const shop = path.join(tmp, 'shop'); fs.mkdirSync(path.join(shop, 'public', 'data'), { recursive: true });
fs.writeFileSync(path.join(shop, 'public', 'data', 'gce.json'), JSON.stringify([{ code: 'SYN-1', name: 'Synthetic concentrator', base_price: 95, msrp: 240, image: '/assets/a.jpg' }, { code: 'OLD-1', name: 'Old', base_price: 3, image: '/assets/b.jpg' }]));
const fileSha = CI.sha256(fs.readFileSync(file));
const evMatch = path.join(tmp, 'ev-match.json'); fs.writeFileSync(evMatch, JSON.stringify({ date: '2026-10-20', basis: 'mailbox_attachment_match', attachment_name: 'synthetic.xlsx', attachment_sha256: fileSha }));
const evOther = path.join(tmp, 'ev-other.json'); fs.writeFileSync(evOther, JSON.stringify({ date: '2026-10-20', basis: 'mailbox_attachment_match', attachment_name: 'corrected.xlsx', attachment_sha256: 'f'.repeat(64) }));
const run = (args) => cp.spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8' });
const files = d => Object.fromEntries(fs.readdirSync(d).sort().map(f => [f, fs.readFileSync(path.join(d, f), 'utf8')]));
await t('CLI: identical inputs give byte-identical outputs (every file)', async () => {
  const base = ['--mfr', 'gce', '--file', file, '--received-evidence', evMatch, '--shop', shop, '--today', '2026-10-23'];
  const a = run(base.concat(['--out', path.join(tmp, 'o1')])), b = run(base.concat(['--out', path.join(tmp, 'o2')]));
  eq([a.status, b.status], [0, 0], a.stderr + b.stderr);
  const A1 = files(path.join(tmp, 'o1')), B1 = files(path.join(tmp, 'o2'));
  eq(Object.keys(A1), ['before_after.csv', 'before_after.json', 'exceptions.json', 'handoff.json', 'line.json', 'package.json', 'price_import_rows.json', 'report.json', 'review.csv']);
  for (const k of Object.keys(A1)) ok(A1[k] === B1[k], k + ' differs between runs');
  const pk = JSON.parse(A1['package.json']), ba = JSON.parse(A1['before_after.json']);
  eq([pk.manufacturer, pk.stageable], [SL, true], 'the gce alias runs as ohio-medical');
  eq(pk.before_after_sha256, CI.sha256(A1['before_after.json']) + ':' + CI.sha256(A1['before_after.csv']), 'the recorded hash is the files\' hash');
  eq(ba.rows.map(r => r.code + ':' + r.row_kind), ['CAN-55:new', 'OLD-1:not_on_source_preserved', 'SYN-1:changed'], 'compared with the gce.json storefront file');
  eq(ba.rows[2].fields.dealer_price, { before: 95, after: 100, change: 'changed' });
});
await t('CLI: a blocked line writes no import rows — and a re-run removes rows left by an earlier stageable run', async () => {
  const out = path.join(tmp, 'o1');
  const r = run(['--mfr', 'ohio-medical', '--file', file, '--shop', shop, '--today', '2026-10-23', '--out', out]);   // no --received
  eq(r.status, 0, r.stderr);
  ok(!fs.existsSync(path.join(out, 'price_import_rows.json')) && !fs.existsSync(path.join(out, 'handoff.json')), 'no rows, no handoff');
  const pk = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  eq([pk.stageable, pk.handoff_file, pk.exceptions.filter(x => x.blocking).map(x => x.kind)], [false, null, ['provenance_incomplete']]);
});
await t('CLI: a non-matching attachment or a bare date never stages; the date is not given to the file', async () => {
  const o3 = path.join(tmp, 'o3'), o4 = path.join(tmp, 'o4');
  eq(run(['--mfr', 'ohio-medical', '--file', file, '--received-evidence', evOther, '--shop', shop, '--today', '2026-10-23', '--out', o3]).status, 0);
  const p3 = JSON.parse(fs.readFileSync(path.join(o3, 'package.json'), 'utf8')), l3 = JSON.parse(fs.readFileSync(path.join(o3, 'line.json'), 'utf8'));
  eq([p3.stageable, l3.source.received_date, p3.exceptions.filter(x => x.blocking).map(x => x.kind).sort()], [false, null, ['provenance_incomplete', 'received_date_mismatch']]);
  ok(!fs.existsSync(path.join(o3, 'price_import_rows.json')), 'no rows');
  eq(run(['--mfr', 'ohio-medical', '--file', file, '--received', '2026-10-20', '--shop', shop, '--today', '2026-10-23', '--out', o4]).status, 0);
  const p4 = JSON.parse(fs.readFileSync(path.join(o4, 'package.json'), 'utf8'));
  eq([p4.stageable, p4.exceptions.filter(x => x.blocking).map(x => x.kind)], [false, ['received_unverified']]);
});
await t('CLI batch: one exceptions queue per run; a failing or refused line never stops the others', async () => {
  const batch = path.join(tmp, 'batch.json'), out = path.join(tmp, 'b');
  fs.writeFileSync(batch, JSON.stringify([{ mfr: 'gce', name: 'ohio', file, received_evidence: evMatch }, { mfr: 'dalton', file: path.join(tmp, 'missing.pdf') },
    { mfr: 'complete-medical-supplies', file }, { mfr: 'bemis', file }]));
  const r = run(['--batch', batch, '--shop', shop, '--today', '2026-10-23', '--out', out]);
  eq(r.status, 0, r.stderr);
  const runj = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
  eq(runj.lines.map(l => l.name + ':' + l.stageable), ['ohio:true', 'dalton:false', 'complete-medical-supplies:false', 'bemis:false']);
  ok(fs.existsSync(path.join(out, 'ohio', 'price_import_rows.json')), 'the clean line still produced its rows');
  ok(!fs.existsSync(path.join(out, 'bemis', 'price_import_rows.json')) && !fs.existsSync(path.join(out, 'complete-medical-supplies', 'price_import_rows.json')), 'refused lines: none');
  const q = JSON.parse(fs.readFileSync(path.join(out, 'exceptions.json'), 'utf8'));
  eq(q.filter(x => x.blocking).map(x => x.manufacturer + ':' + x.kind), ['dalton:import_failed', 'complete-medical-supplies:activation_hold', 'bemis:line_frozen']);
  const csv = fs.readFileSync(path.join(out, 'exceptions.csv'), 'utf8').split('\n');
  eq(csv[0], 'id,manufacturer,sku,kind,status,blocking,evidence,source_ref,required_decision'); eq(csv.length, q.length + 2);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\ncatalog-import handoff: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
