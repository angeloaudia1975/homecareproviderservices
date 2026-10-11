/* MI-1c — netlify/functions/mfr-intel-api.js, loaded unmodified (mutant-capable via phase0-mock's loader) against a
   fake of Supabase Auth, PostgREST, RPC and Storage. The database's own rules are proven by test/mi1c-intel.pg.test.js;
   this proves the API: who may call it; that it reads the STORED original and checks its SHA-256; that a preview writes
   nothing; that an import recomputes everything on the server and needs the exact preview the operator saw; that the
   acting person always comes from the sign-in; and that it never writes anything but the two MI-1c functions.
   Uses the real September 2026 PDF when present (MI1C_PDF, default the uploaded copy). */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const { load, call } = require('./phase0-mock');
const BASE = 'https://db.test';
const PDF_PATH = process.env.MI1C_PDF || '/mnt/user-data/uploads/Strongback_Report_Overview_September_2026.pdf';
const HAVE_PDF = fs.existsSync(PDF_PATH);
const PDF = HAVE_PDF ? fs.readFileSync(PDF_PATH) : Buffer.from('%PDF-1.4\n%%EOF');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const FX = require('./fixtures/mi1c-hcps-2026-10-11.json');

function world(o) {
  o = o || {};
  const st = { calls: [], rpcs: [] };
  const src = (o.sources || [{ id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', title: 'Strongback — September 2026', file_name: 'Strongback_Report_Overview_September_2026.pdf',
    file_sha256: sha(PDF), storage_path: `reports/strongback-mobility/dealer_report/${sha(PDF)}.pdf`, received_date: '2026-10-10', prepared_date: '2026-10-08',
    report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'accepted', publication_status: 'unpublished' }]);
  const dealers = FX.dealers.map(d => ({ ...d, rep_email: d.rep === 'Greg' ? 'greg@hcps.us' : 'angelo@hcps.us', rep_name: null }));
  // monthly_sales rows: the fixture's per-name totals spread over months inside the report's 12 months.
  const sales = []; let k = 0;
  for (const s of FX.sales) for (let i = 0; i < s.n; i++) sales.push({ id: 'ms' + (++k), customer_name: s.customer_name, ship_city: s.ship_city, ship_state: s.ship_state,
    dealer_id: s.dealer_id, amount: Math.round(s.amount / s.n * 100) / 100, period: `2026-0${1 + (i % 8)}-01`, order_date: `2026-0${1 + (i % 8)}-15` });
  const tables = { dealers, dealer_aliases: FX.aliases, monthly_sales: sales, mfr_dealer_snapshots: o.snapshots || [], mfr_intel_reports: o.reports || [],
    dealer_manufacturers: [{ dealer_id: dealers[0].id, manufacturer: 'strongback-mobility', active: true, account_ref: 'SB-1' }],
    staff_users_all: [{ email: 'angelo@hcps.us', name: 'Angelo Audia' }, { email: 'greg@hcps.us', name: 'Greg Campbell' }],
    mfr_dealer_observations: [], mfr_intel_events: [] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = String(url), m = (opts.method || 'GET').toUpperCase(); st.calls.push({ u, m, body: opts.body });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const em = { pres: 'angelo@hcps.us', admin: 'ad@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', off: 'gone@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users?email=eq.')) { const em = decodeURIComponent(u.match(/email=eq\.([^&]+)/)[1]);
      const s = { 'angelo@hcps.us': { role: 'president' }, 'ad@hcps.us': { role: 'admin' }, 'greg@hcps.us': { role: 'rep' }, 'lori@hcps.us': { role: 'relations' }, 'gone@hcps.us': { role: 'president', active: false } }[em];
      return res(200, s ? [{ email: em, ...s }] : []); }
    if (o.failRead && m === 'GET' && u.includes('/rest/v1/') && o.failRead(u)) return res(500, { message: 'forced' });
    if (u.startsWith(BASE + '/storage/v1/object/mfr-sources/')) { if (o.storage) return o.storage(res); return res(200, o.fileBytes || PDF); }
    if (u.startsWith(BASE + '/rest/v1/rpc/')) { const fn = u.split('/rpc/')[1]; const p = JSON.parse(opts.body).p; st.rpcs.push({ fn, p });
      if (o.rpc) { const r = o.rpc(fn, p); if (r) return res(r.status, r.body); }
      if (fn === 'hcps_mfr_intel_import') return res(200, { ok: true, existing: false, report_id: 1, source_id: p.source_id, dealers: p.dealers.length, observations: p.observations.length });
      if (fn === 'hcps_mfr_intel_match') return res(200, { ok: true, unchanged: false, snapshot_id: p.snapshot_id, match_status: p.decision, match_version: (p.expected_version || 0) + 1 });
      return res(404, { message: 'unexpected rpc' }); }
    const tm = u.match(/\/rest\/v1\/([a-z_]+)\?/); const t = tm && tm[1];
    const page = /offset=([1-9])/.test(u);
    if (t === 'mfr_sources') { let rows = src; const id = u.match(/[?&]id=eq\.(\d+)/); if (id) rows = rows.filter(r => String(r.id) === id[1]);
      if (/kind=eq\.dealer_report/.test(u)) rows = rows.filter(r => r.kind === 'dealer_report'); return res(200, page ? [] : rows); }
    if (t === 'staff_users') return res(200, page ? [] : tables.staff_users_all);
    if (t === 'dealers' && /business_name=ilike/.test(u)) { const qq = decodeURIComponent(u.match(/ilike\.\*([^*]*)\*/)[1]).toLowerCase(); st.search = u;
      return res(200, dealers.filter(d => d.business_name.toLowerCase().includes(qq)).slice(0, 25)); }
    if (t === 'dealers' && /id=in\./.test(u)) { const ids = u.match(/id=in\.\(([^)]*)\)/)[1].split(','); return res(200, dealers.filter(d => ids.includes(d.id))); }
    if (t === 'mfr_intel_reports' && /source_id=eq\./.test(u)) { const id = u.match(/source_id=eq\.(\d+)/)[1]; return res(200, tables.mfr_intel_reports.filter(r => String(r.source_id) === id)); }
    if (t && tables[t]) return res(200, page ? [] : tables[t]);
    return res(404, { message: 'unexpected call ' + m + ' ' + u });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('mfr-intel-api.js', w) }; };
const as = tok => ({ token: tok });
const writesOf = w => w.calls.filter(c => c.m !== 'GET' && !/\/auth\/v1\//.test(c.u));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

(async () => {
  console.log('\n— who may call it —');
  await t('no sign-in → 401; rep → 403; Relations → 403; inactive staff → 401; forged token → 401; nothing read or written', async () => {
    for (const [tok, code] of [[null, 401], ['greg', 403], ['lori', 403], ['off', 401], ['forged', 401]]) {
      const { w, m } = boot(); const r = await call(m, { action: 'sources' }, tok ? as(tok) : {});
      assert.strictEqual(r.status, code, `${tok} → ${r.status}`); assert.strictEqual(writesOf(w).length, 0);
      assert.ok(!w.calls.some(c => /mfr_sources|storage/.test(c.u)), 'no data read before the role check');
    }
  });
  await t('GET is refused (POST only); admin and president may call', async () => {
    const { m } = boot(); const r = await m.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer pres' }, body: '' }); assert.strictEqual(r.statusCode, 405);
    for (const tok of ['pres', 'admin']) { const b = boot(); assert.strictEqual((await call(b.m, { action: 'sources' }, as(tok))).status, 200); }
  });
  await t('sources lists dealer reports with whether each has a reader and an import', async () => {
    const { m } = boot(); const r = await call(m, { action: 'sources' }, as('pres'));
    assert.deepStrictEqual(r.body.readers, ['strongback-mobility']); assert.strictEqual(r.body.sources[0].has_reader, true); assert.strictEqual(r.body.sources[0].imported, null);
  });

  console.log('\n— preview: the stored original, checked; nothing written —');
  await t('a stored file whose SHA-256 differs from the register is refused (409 file_changed), nothing parsed', async () => {
    const { w, m } = boot({ fileBytes: Buffer.concat([PDF, Buffer.from('x')]) }); const r = await call(m, { action: 'preview', source_id: 7 }, as('pres'));
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'file_changed'); assert.strictEqual(writesOf(w).length, 0);
  });
  await t('storage unreadable → 502; an unknown source → 404; a non-dealer report → 422; a manufacturer with no reader → 422', async () => {
    let b = boot({ storage: res => res(500, 'down') }); assert.strictEqual((await call(b.m, { action: 'preview', source_id: 7 }, as('pres'))).status, 502);
    b = boot(); assert.strictEqual((await call(b.m, { action: 'preview', source_id: 99 }, as('pres'))).status, 404);
    b = boot({ sources: [{ id: 8, manufacturer: 'strongback-mobility', kind: 'sales_export', file_sha256: sha(PDF), storage_path: 'x' }] });
    assert.strictEqual((await call(b.m, { action: 'preview', source_id: 8 }, as('pres'))).body.error, 'mi1c_not_a_dealer_report');
    b = boot({ sources: [{ id: 9, manufacturer: 'pedifix', kind: 'dealer_report', file_sha256: sha(PDF), storage_path: 'x' }] });
    assert.strictEqual((await call(b.m, { action: 'preview', source_id: 9 }, as('pres'))).body.error, 'no_parser');
  });
  await t('a file that is not a Strongback report is refused with the reader\'s reason, never guessed', async () => {
    const junk = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const b = boot({ sources: [{ id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', file_sha256: sha(junk), storage_path: 'reports/x.pdf', status: 'accepted' }], fileBytes: junk });
    const r = await call(b.m, { action: 'preview', source_id: 7 }, as('pres')); assert.strictEqual(r.status, 422); assert.ok(/unreadable_pdf|not_a_strongback_report/.test(r.body.error), r.body.error);
  });
  await t('an unreadable evidence table stops the preview (503) — never treated as "no evidence"', async () => {
    for (const tb of ['dealers', 'dealer_aliases', 'monthly_sales', 'mfr_dealer_snapshots', 'dealer_manufacturers']) {
      const b = boot({ failRead: u => u.includes('/rest/v1/' + tb + '?') }); const r = await call(b.m, { action: 'preview', source_id: 7 }, as('pres'));
      assert.strictEqual(r.status, HAVE_PDF ? 503 : 422, tb + ' → ' + r.status);
    }
  });
  if (HAVE_PDF) {
    let PV;
    await t('the real September report previews: 25 dealers, 0 errors, 15 matched / 7 review / 1 held / 2 unmatched — and NOTHING is written', async () => {
      const { w, m } = boot(); const r = await call(m, { action: 'preview', source_id: 7 }, as('pres'));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200)); PV = r.body;
      assert.strictEqual(PV.dealers.length, 25); assert.strictEqual(PV.errors.length, 0);
      assert.deepStrictEqual(PV.counts, { matched: 15, review: 7, unmatched: 2, held: 1 });
      assert.strictEqual(writesOf(w).length, 0, 'a preview writes nothing'); assert.strictEqual(w.rpcs.length, 0);
    });
    await t('the preview shows the extraction, evidence, unresolved items, differences and reconciliation', async () => {
      const lacey = PV.dealers.find(d => d.printed.name === 'Lacey Drug Company');
      assert.strictEqual(lacey.printed.city, 'Ackworth'); assert.strictEqual(lacey.match.status, 'matched');
      assert.ok(lacey.differences.dealers[0].differences.some(x => /HCPS city Acworth/.test(x)));
      assert.ok(lacey.differences.dealers[0].differences.some(x => /HCPS rep Greg Campbell .* report addressed to Angelo Audia/.test(x)), 'rep difference shown, ownership kept');
      assert.strictEqual(PV.unresolved.filter(u => u.printed_name).length, 10);
      assert.ok(PV.unresolved.some(u => /Wyatt/.test(u.printed_name) && u.status === 'held'));
      assert.strictEqual(PV.reconciliation[0].strongback_text, '$2,159'); assert.strictEqual(PV.reconciliation[1].strongback_text, '$43,317');
      assert.ok(/never added to HCPS sales or commissions/.test(PV.note));
      assert.strictEqual(PV.observations.contact_person, 32); assert.strictEqual(PV.observations.contact_log, 51);
    });

    console.log('\n— import: recomputed on the server; the exact preview the operator saw —');
    await t('without the preview hash, or with another one → 409 preview_changed, nothing written', async () => {
      for (const h of [undefined, 'f'.repeat(64)]) { const { w, m } = boot(); const r = await call(m, { action: 'import', source_id: 7, preview_hash: h }, as('pres'));
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'preview_changed'); assert.strictEqual(w.rpcs.length, 0); }
    });
    await t('a report that is not accepted is not imported (422), nothing written', async () => {
      const s = { id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', file_sha256: sha(PDF), storage_path: 'x', status: 'received' };
      const { w, m } = boot({ sources: [s] }); const r = await call(m, { action: 'import', source_id: 7, preview_hash: PV.preview_hash }, as('pres'));
      assert.strictEqual(r.body.error, 'mi1c_not_accepted'); assert.strictEqual(w.rpcs.length, 0);
    });
    let imp;
    await t('with the reviewed preview hash: ONE call to hcps_mfr_intel_import, the payload built on the server, nothing else written', async () => {
      const { w, m } = boot();
      const r = await call(m, { action: 'import', source_id: 7, preview_hash: PV.preview_hash, actor: 'someone@else.com', dealers: [], observations: [], matches: [] }, as('admin'));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); imp = w.rpcs[0];
      assert.deepStrictEqual(w.rpcs.map(x => x.fn), ['hcps_mfr_intel_import']);
      assert.deepStrictEqual(writesOf(w).map(c => c.u.replace(BASE, '')), ['/rest/v1/rpc/hcps_mfr_intel_import']);
      assert.strictEqual(imp.p.actor, 'ad@hcps.us', 'the acting person is the sign-in, never the request body');
      assert.strictEqual(imp.p.dealers.length, 25); assert.strictEqual(imp.p.file_sha256, sha(PDF)); assert.strictEqual(imp.p.errors.length, 0);
    });
    await t('the payload keeps Strongback\'s wording and positions, and every observation has a printed position', async () => {
      const w = imp.p.dealers.find(d => /Wyatt/.test(d.printed_name));
      assert.strictEqual(w.match.status, 'held'); assert.strictEqual(w.match.dealer_id, null); assert.strictEqual(w.trend, 'One-Hit Wonder');
      assert.ok(imp.p.observations.every(o => /^p\d+:y\d+\.\d(:x\d+)?$/.test(o.position_key)), 'every observation is keyed by where it is printed');
      assert.strictEqual(new Set(imp.p.observations.map(o => o.kind + '|' + o.position_key)).size, imp.p.observations.length, 'positions are unique');
      assert.ok(imp.p.observations.filter(o => o.kind === 'offer').every(o => /unverified/.test(o.structured.status)));
      const owners = imp.p.observations.filter(o => o.kind === 'contact_person' && o.structured.role === 'report_owner');
      assert.strictEqual(owners.length, 2); assert.ok(owners.every(o => o.review_state === null), 'the report owner is never proposed as a dealer contact');
      assert.strictEqual(imp.p.observations.filter(o => o.review_state === 'proposed').length, 30);
    });
    await t('the same preview hash on a second run is the same payload (deterministic), so a repeat import is idempotent in the database', async () => {
      const { m, w } = boot(); await call(m, { action: 'import', source_id: 7, preview_hash: PV.preview_hash }, as('pres'));
      assert.strictEqual(JSON.stringify({ ...w.rpcs[0].p, actor: 0 }), JSON.stringify({ ...imp.p, actor: 0 }));
    });
    await t('a parse with reading errors is never imported (422), even with the matching preview hash', async () => {
      const { w, m } = boot();
      const DIm = require.cache[require('path').join(__dirname, '..', 'netlify', 'functions', '_dealer_intel.js')].exports;
      const real = DIm.PARSERS['strongback-mobility'];
      DIm.PARSERS['strongback-mobility'] = () => ({ parseReport: L => { const p = real().parseReport(L); p.errors = [{ id: 'forced', detail: 'forced error' }]; return p; } });
      try { const pv = await call(m, { action: 'preview', source_id: 7 }, as('pres'));
        const r = await call(m, { action: 'import', source_id: 7, preview_hash: pv.body.preview_hash }, as('pres'));
        assert.strictEqual(r.status, 422); assert.strictEqual(r.body.error, 'mi1c_parse_errors'); assert.strictEqual(w.rpcs.length, 0);
      } finally { DIm.PARSERS['strongback-mobility'] = real; }
    });
    await t('when HCPS evidence changes between preview and import (a new alias), the import is refused as changed', async () => {
      const { w, m } = boot(); w.fetch; FX.aliases.push({ alias_norm: 'NEBCARE', dealer_id: FX.dealers[0].id });
      try { const r = await call(m, { action: 'import', source_id: 7, preview_hash: PV.preview_hash }, as('pres'));
        assert.strictEqual(r.body.error, 'preview_changed'); assert.strictEqual(w.rpcs.length, 0); } finally { FX.aliases.pop(); }
    });
  } else console.log('  (the real September PDF is not present here — the real-report API tests did not run; set MI1C_PDF)');

  console.log('\n— decisions, search, report —');
  await t('decide: one call to hcps_mfr_intel_match; actor from the sign-in; a database refusal comes back with its code', async () => {
    let b = boot(); let r = await call(b.m, { action: 'decide', snapshot_id: 5, decision: 'matched', dealer_id: FX.dealers[0].id, reason: 'family root', expected_version: 0, actor: 'x@y' }, as('pres'));
    assert.strictEqual(r.status, 200); assert.strictEqual(b.w.rpcs[0].fn, 'hcps_mfr_intel_match'); assert.strictEqual(b.w.rpcs[0].p.actor, 'angelo@hcps.us');
    assert.strictEqual(b.w.rpcs[0].p.expected_version, 0, 'the version the person saw reaches the database');
    assert.deepStrictEqual(writesOf(b.w).map(c => c.u.replace(BASE, '')), ['/rest/v1/rpc/hcps_mfr_intel_match']);
    b = boot({ rpc: () => ({ status: 400, body: { message: 'mi1c_stale: snapshot 5 changed since it was shown' } }) });
    r = await call(b.m, { action: 'decide', snapshot_id: 5, decision: 'review', reason: 'x', expected_version: 0 }, as('pres')); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'mi1c_stale');
    b = boot(); r = await call(b.m, { action: 'decide', snapshot_id: 5, decision: 'matched', dealer_id: 'not-a-uuid', reason: 'x' }, as('pres')); assert.strictEqual(r.status, 400); assert.strictEqual(b.w.rpcs.length, 0);
    b = boot(); r = await call(b.m, { action: 'decide', decision: 'review', reason: 'x' }, as('pres')); assert.strictEqual(r.status, 400);
  });
  await t('reps and Relations cannot decide or search', async () => {
    for (const tok of ['greg', 'lori']) { const b = boot();
      assert.strictEqual((await call(b.m, { action: 'decide', snapshot_id: 5, decision: 'review', reason: 'x' }, as(tok))).status, 403);
      assert.strictEqual((await call(b.m, { action: 'dealer_search', q: 'Williams' }, as(tok))).status, 403); assert.strictEqual(b.w.rpcs.length, 0); }
  });
  await t('dealer_search: read-only, excludes TEST dealers, cleans the query', async () => {
    let b = boot(); let r = await call(b.m, { action: 'dealer_search', q: 'Williams' }, as('pres'));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.dealers.length, 10, 'nine Williams Brothers + ARH Williamson'); assert.ok(/or=\(is_test\.is\.null,is_test\.is\.false\)/.test(b.w.search));
    b = boot(); r = await call(b.m, { action: 'dealer_search', q: 'Williams*),(x' }, as('pres'));
    assert.ok(!/[*),(]/.test(decodeURIComponent(b.w.search.split('ilike.')[1].split('&')[0]).slice(1, -1)), 'no PostgREST syntax from the user reaches the filter');
    assert.strictEqual(writesOf(b.w).length, 0);
  });
  await t('report: 404 before an import; unknown action → 400', async () => {
    let b = boot(); assert.strictEqual((await call(b.m, { action: 'report', source_id: 7 }, as('pres'))).status, 404);
    b = boot(); assert.strictEqual((await call(b.m, { action: 'publish', source_id: 7 }, as('pres'))).status, 400);
  });
  await t('the API never writes to any table directly (only the two MI-1c functions), across every action above', async () => {
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', 'mfr-intel-api.js'), 'utf8');
    assert.ok(!/method:\s*"(PATCH|DELETE|PUT)"/.test(src), 'no PATCH/DELETE/PUT');
    assert.deepStrictEqual([...src.matchAll(/rpc\("([a-z_0-9]+)"/g)].map(x => x[1]).sort(), ['hcps_mfr_intel_import', 'hcps_mfr_intel_match']);
    assert.ok(!/zoho|dealer_contacts|dealer_tasks|opportunit|campaign|dealer_aliases"\s*,\s*\{|monthly_sales\?[^"]*method/i.test(src.replace(/\/\/.*$/gm, '')), 'no reach into other stores');
  });
  console.log(`\nmi1c-api: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
