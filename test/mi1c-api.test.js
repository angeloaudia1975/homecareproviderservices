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
const HOLDS = require('./mi1c-holds.js').strongback();   // as the migration seeds mfr_intel_holds

function world(o) {
  o = o || {};
  const st = { calls: [], rpcs: [] };
  const src = (o.sources || [{ id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', title: 'Strongback — September 2026', file_name: 'Strongback_Report_Overview_September_2026.pdf',
    file_sha256: sha(PDF), storage_path: `reports/strongback-mobility/dealer_report/${sha(PDF)}.pdf`, received_date: '2026-10-10', prepared_date: '2026-10-08', prepared_date_status: 'stated',
    report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'accepted', publication_status: 'unpublished' }]);
  const dealers = FX.dealers.map(d => ({ ...d, rep_email: d.rep === 'Greg' ? 'greg@hcps.us' : 'angelo@hcps.us', rep_name: null }));
  // monthly_sales rows: the fixture's per-name totals spread over months inside the report's 12 months.
  const sales = []; let k = 0;
  for (const s of FX.sales) for (let i = 0; i < s.n; i++) sales.push({ id: 'ms' + (++k), customer_name: s.customer_name, ship_city: s.ship_city, ship_state: s.ship_state,
    dealer_id: s.dealer_id, amount: Math.round(s.amount / s.n * 100) / 100, qty: 1, period: `2026-0${1 + (i % 8)}-01`, order_date: `2026-0${1 + (i % 8)}-15`, source: 'sales_report', external_ref: 'sb:' + k });
  // Optional: commission-statement / other-lane rows (e.g. a statement that repeats sales-report orders).
  for (const x of (o.extraSales ? o.extraSales(sales) : [])) sales.push(x);
  const tables = { dealers, dealer_aliases: FX.aliases, monthly_sales: sales, mfr_dealer_snapshots: o.snapshots || [], mfr_intel_reports: o.reports || [],
    dealer_manufacturers: [{ dealer_id: dealers[0].id, manufacturer: 'strongback-mobility', active: true, account_ref: 'SB-1' }],
    staff_users_all: [{ email: 'angelo@hcps.us', name: 'Angelo Audia' }, { email: 'greg@hcps.us', name: 'Greg Campbell' }],
    mfr_dealer_observations: [], mfr_intel_events: [], app_settings: o.app_settings || [], mfr_auto_import_log: o.logs || [], mfr_intel_holds: o.holds || HOLDS.map((h, i) => ({ id: i + 1, ...h })) };
  const snapById = o.snapById || { 5: { id: 5, manufacturer: 'strongback-mobility', printed_name: 'Larco Medical' },
    6: { id: 6, manufacturer: 'strongback-mobility', printed_name: "Wyatt's Pharmacy Inc" }, 8: { id: 8, manufacturer: 'strongback-mobility', printed_name: 'WYATTS PHARMACY' } };
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
    if (t === 'mfr_dealer_snapshots' && /[?&]id=eq\./.test(u)) { const id = u.match(/[?&]id=eq\.(\d+)/)[1]; return res(200, snapById[id] ? [snapById[id]] : []); }
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
    for (const tb of ['dealers', 'dealer_aliases', 'monthly_sales', 'mfr_dealer_snapshots', 'dealer_manufacturers', 'mfr_intel_holds']) {
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
    console.log('\n— prepared date (report vs register) —');
    for (const [label, srcOver, want] of [['the register says 2026-10-07, the report prints 8 October 2026', { prepared_date: '2026-10-07', prepared_date_status: 'stated' }, /prints prepared 8 October 2026 \(2026-10-08\), the register says 2026-10-07/],
                                          ['the register says NOT STATED, the report prints 8 October 2026', { prepared_date: null, prepared_date_status: 'not_stated' }, /the register says not stated/]]) {
      await t(`MISMATCH shown first in the preview and the import refused (422), nothing written — ${label}`, async () => {
        const src = { id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', file_name: 'S.pdf', file_sha256: sha(PDF), storage_path: 'reports/x.pdf', received_date: '2026-10-10',
          report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'accepted', publication_status: 'unpublished', ...srcOver };
        const { w, m } = boot({ sources: [src] }); const pv = await call(m, { action: 'preview', source_id: 7 }, as('pres'));
        assert.strictEqual(pv.status, 200); assert.strictEqual(pv.body.prepared_date.status, 'mismatch'); assert.ok(want.test(pv.body.prepared_date.message), pv.body.prepared_date.message);
        assert.strictEqual(pv.body.unresolved[0].status, 'prepared_date_mismatch'); assert.ok(!/2026-10-10/.test(pv.body.prepared_date.message), 'the received date is never offered');
        const r = await call(m, { action: 'import', source_id: 7, preview_hash: pv.body.preview_hash }, as('pres'));
        assert.strictEqual(r.status, 422); assert.strictEqual(r.body.error, 'mi1c_prepared_date_mismatch'); assert.strictEqual(w.rpcs.length, 0); assert.strictEqual(writesOf(w).length, 0);
      });
    }
    await t('the register and the report agree (2026-10-08, stated) → shown as agreeing', async () => {
      assert.strictEqual(PV.prepared_date.status, 'agrees'); assert.strictEqual(PV.prepared_date.pdf, '2026-10-08'); assert.strictEqual(PV.prepared_date.register, '2026-10-08');
    });

    console.log('\n— recorded holds come from the database —');
    await t('the preview holds Wyatt\'s because mfr_intel_holds names it; the payload carries it as held', async () => {
      assert.deepStrictEqual(PV.holds.map(h => h.printed_name), ["Wyatt's Pharmacy Inc"]);
      assert.strictEqual(imp.p.dealers.find(d => /Wyatt/.test(d.printed_name)).match.method, 'held');
    });
    await t('with no recorded hold the matcher holds nothing (no hidden copy in code) — and the database import would then refuse nothing it did not hold', async () => {
      const { m } = boot({ holds: [] }); const r = await call(m, { action: 'preview', source_id: 7 }, as('pres'));
      assert.strictEqual(r.body.counts.held, 0); assert.notStrictEqual(r.body.preview_hash, PV.preview_hash);
    });

    console.log('\n— reconciliation uses the sales-report lane only —');
    await t('commission-statement rows repeating sales-report orders (and an "other" source) do NOT change the HCPS sales figures; they are listed apart', async () => {
      const dup = sales => sales.filter(x => x.period === '2026-09-01' || x.period === '2026-08-01').slice(0, 6)
        .map((x, i) => ({ ...x, id: 'c' + i, source: i < 5 ? 'commission' : null, external_ref: null, commission: 9 }))
        .concat([{ id: 'o1', customer_name: 'X', dealer_id: null, amount: 777, qty: 1, period: '2026-09-01', source: 'portal', external_ref: 'p1' }]);
      const { m } = boot({ extraSales: dup }); const r = await call(m, { action: 'preview', source_id: 7 }, as('pres'));
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.reconciliation.map(x => [x.hcps, x.hcps_lines]), PV.reconciliation.map(x => [x.hcps, x.hcps_lines]), 'the sales figures are unchanged');
      assert.deepStrictEqual(r.body.counts, PV.counts, 'the matches are unchanged');
      assert.strictEqual(r.body.preview_hash, PV.preview_hash, 'the import payload (matches + evidence) is unchanged — commission rows never add to the sales evidence');
      const lanes = r.body.reconciliation[1].other_lanes; const com = lanes.find(l => l.lane === 'commission');
      assert.strictEqual(com.rows, 6); assert.strictEqual(com.same_as_sales_report, 6); assert.ok(lanes.some(l => l.lane === 'other:portal' && l.amount === 777));
      assert.ok(PV.reconciliation.every(x => x.other_lanes.length === 0), 'production today: Strongback has sales-report rows only');
    });
  } else if (process.env.MI1C_ALLOW_NO_PDF === '1') console.log('  (the real September PDF is not present — real-report API tests NOT run, allowed by MI1C_ALLOW_NO_PDF=1)');
  else await t('the REAL September PDF is present (set MI1C_PDF; MI1C_ALLOW_NO_PDF=1 to run without it)', async () => { throw new Error('real PDF missing: ' + PDF_PATH); });

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
  await t('decide on the HELD dealer (recorded hold): refused 423 for every decision, before the database, nothing written', async () => {
    for (const [sid, decision] of [[6, 'matched'], [6, 'review'], [6, 'unmatched'], [6, 'held'], [8, 'unmatched']]) {
      const b = boot(); const r = await call(b.m, { action: 'decide', snapshot_id: sid, decision, dealer_id: decision === 'matched' ? FX.dealers[0].id : '', reason: 'owner says so', expected_version: 0 }, as('pres'));
      assert.strictEqual(r.status, 423, `${sid} ${decision} → ${r.status}`); assert.strictEqual(r.body.error, 'mi1c_held_locked'); assert.strictEqual(b.w.rpcs.length, 0); assert.strictEqual(writesOf(b.w).length, 0);
    }
  });
  await t('decide: the database refusal mi1c_held_locked also comes back as 423 (second line of defence); unreadable holds → 503, nothing written; unknown snapshot → 404', async () => {
    let b = boot({ holds: [], rpc: () => ({ status: 400, body: { message: 'mi1c_held_locked: "Wyatt\'s Pharmacy Inc" is held by a recorded owner decision' } }) });
    let r = await call(b.m, { action: 'decide', snapshot_id: 6, decision: 'unmatched', reason: 'x', expected_version: 0 }, as('pres')); assert.strictEqual(r.status, 423); assert.strictEqual(r.body.error, 'mi1c_held_locked');
    b = boot({ failRead: u => /mfr_intel_holds/.test(u) }); r = await call(b.m, { action: 'decide', snapshot_id: 5, decision: 'review', reason: 'x', expected_version: 0 }, as('pres'));
    assert.strictEqual(r.status, 503); assert.strictEqual(b.w.rpcs.length, 0);
    b = boot(); r = await call(b.m, { action: 'decide', snapshot_id: 99, decision: 'review', reason: 'x', expected_version: 0 }, as('pres')); assert.strictEqual(r.status, 404); assert.strictEqual(b.w.rpcs.length, 0);
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
  await t('the API never writes to any table directly (only its database functions), across every action above', async () => {
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', 'mfr-intel-api.js'), 'utf8');
    assert.ok(!/method:\s*"(PATCH|DELETE|PUT)"/.test(src), 'no PATCH/DELETE/PUT');
    // The automatic run (Angelo's activation, 2026-10-13) adds exactly three: accept the record, publish it, and the audit log.
    assert.deepStrictEqual([...new Set([...src.matchAll(/rpc\("([a-z_0-9]+)"/g)].map(x => x[1]))].sort(), ['hcps_mfr_auto_import_log', 'hcps_mfr_intel_import', 'hcps_mfr_intel_match', 'hcps_mfr_report_decide', 'hcps_mfr_report_publication']);
    assert.ok(!/zoho|dealer_contacts|dealer_tasks|opportunit|campaign|dealer_aliases"\s*,\s*\{|monthly_sales\?[^"]*method/i.test(src.replace(/\/\/.*$/gm, '')), 'no reach into other stores');
  });

  console.log('\n— automatic processing (runAutoIntel, 2026-10-13) —');
  const autoWorld = (o) => { o = o || {};
    const rpcs = (fn, p) => { if (o.rpc) { const r = o.rpc(fn, p); if (r) return r; }
      if (fn === 'hcps_mfr_report_decide') return { status: 200, body: { ok: true, id: p.id, status: 'accepted' } };
      if (fn === 'hcps_mfr_report_publication') return { status: 200, body: { ok: true, id: p.id, publication_status: 'published' } };
      if (fn === 'hcps_mfr_auto_import_log') return { status: 200, body: { ok: true, log_id: 1 } }; return null; };
    return boot(Object.assign({}, o, { rpc: rpcs, app_settings: [{ key: 'phase2_flags', value: { mi_intel_publish: !o.off } }] })); };
  const srcRec = (x) => [Object.assign({ id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', title: 'Strongback — September 2026', file_name: 'Strongback_Report_Overview_September_2026.pdf',
    file_sha256: sha(PDF), storage_path: `reports/strongback-mobility/dealer_report/${sha(PDF)}.pdf`, received_date: '2026-10-11', prepared_date: '2026-10-08', prepared_date_status: 'stated',
    report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'received', publication_status: 'unpublished' }, x || {})];
  await t('switch off: nothing is read, accepted, imported or published', async () => {
    const { w, m } = autoWorld({ off: true, sources: srcRec() }); const r = await m.runAutoIntel();
    assert.strictEqual(r.skipped, 'switch_off'); assert.strictEqual(w.rpcs.length, 0);
  });
  if (HAVE_PDF) {
    await t('received report: accepted → imported (the same payload a person imports) → published; logged final with the counts', async () => {
      const { w, m } = autoWorld({ sources: srcRec() }); const r = await m.runAutoIntel();
      assert.deepStrictEqual(w.rpcs.map(x => x.fn), ['hcps_mfr_report_decide', 'hcps_mfr_intel_import', 'hcps_mfr_report_publication', 'hcps_mfr_auto_import_log']);
      assert.strictEqual(w.rpcs[0].p.actor, 'system:auto-import'); assert.strictEqual(w.rpcs[1].p.actor, 'system:auto-import'); assert.strictEqual(w.rpcs[2].p.action, 'publish');
      const lg = w.rpcs[3].p; assert.strictEqual(lg.outcome, 'imported'); assert.strictEqual(lg.detail.code, 'intel_published'); assert.strictEqual(lg.detail.final, true);
      assert.deepStrictEqual(lg.detail.counts, { matched: 15, review: 7, unmatched: 2, held: 1 });
      assert.ok(lg.detail.needs_review.some(x => /wyatt/i.test(x.printed_name) && x.status === 'held'), 'the recorded hold waits for Angelo');
      assert.strictEqual(lg.detail.needs_review.length, 10); assert.strictEqual(r.results[0].code, 'intel_published');
      const imp = w.rpcs[1].p; assert.ok(imp.dealers.filter(d => d.match_status === 'matched').every(d => d.dealer_id), 'matched rows carry a dealer');
      assert.ok(imp.dealers.filter(d => d.match_status !== 'matched').every(d => !d.dealer_id), 'review / held / unmatched rows carry no dealer');
    });
    await t('already imported: not imported twice — only published', async () => {
      const { w, m } = autoWorld({ sources: srcRec({ status: 'accepted' }), reports: [{ id: 1, source_id: 7, imported_by: 'x', imported_at: 'x', match_summary: {}, content_hash: 'h' }] });
      await m.runAutoIntel(); assert.deepStrictEqual(w.rpcs.map(x => x.fn), ['hcps_mfr_report_publication', 'hcps_mfr_auto_import_log']);
    });
    await t('prepared date differs from the register: held, nothing accepted, imported or published', async () => {
      const { w, m } = autoWorld({ sources: srcRec({ prepared_date: '2026-10-09' }) }); await m.runAutoIntel();
      assert.deepStrictEqual(w.rpcs.map(x => x.fn), ['hcps_mfr_auto_import_log']); assert.strictEqual(w.rpcs[0].p.detail.code, 'prepared_date_mismatch');
    });
    await t('the database refuses the import: logged as refused and NOT published', async () => {
      const { w, m } = autoWorld({ sources: srcRec(), rpc: fn => fn === 'hcps_mfr_intel_import' ? { status: 400, body: { message: 'mi1c_held_locked: test' } } : null });
      await m.runAutoIntel(); assert.ok(!w.rpcs.some(x => x.fn === 'hcps_mfr_report_publication'));
      const lg = w.rpcs.find(x => x.fn === 'hcps_mfr_auto_import_log').p; assert.strictEqual(lg.outcome, 'refused'); assert.strictEqual(lg.detail.code, 'mi1c_held_locked');
    });
    await t('a report already published is left alone', async () => {
      const { w, m } = autoWorld({ sources: srcRec({ status: 'accepted', publication_status: 'published' }) }); const r = await m.runAutoIntel();
      assert.strictEqual(w.rpcs.length, 0); assert.deepStrictEqual(r.results, []);
    });
  }
  console.log(`\nmi1c-api: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
