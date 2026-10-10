/* MI-1a compatibility — the enrolment gate and the mi_import_v2 / mi_commission_v2 switches must not
   change any manufacturer's import that has not been approved for the new identity.
   Runs the REAL sales-import-api.js and commissions-api.js against the in-memory PostgREST fake
   (test/phase0-mock.js). The two MI-1a database functions are stood in for by a recorder: these tests
   prove WHICH path each import takes and what reaches monthly_sales directly; the functions' own
   behaviour is proven in Postgres by test/mi1a-identity.pg.test.js.
     node test/mi1a-compat.test.js */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const MFRS = ['strongback-mobility', 'pedifix', 'abm-respiratory-care', 'airavant-bongorx', 'golden-technologies', 'access4u'];
function seed(opts) {
  opts = opts || {};
  const S = standardSeed({
    manufacturers: MFRS.map(slug => ({ slug, name: slug })),
    dealer_manufacturers: [], dealer_aliases: [{ alias_norm: 'WYATT S PHARMACY', raw_name: "Wyatt's Pharmacy", dealer_id: 'd-ang' }],
    monthly_sales: [
      { id: 'sb-1', manufacturer: 'strongback-mobility', period: '2026-07-01', source: 'sales_report', amount: 536, commission: 48.24,
        external_ref: 'strongback-mobility|v2|O:7001|1007-2025|1', order_key: 'strongback-mobility|O:7001', dealer_id: 'd-ang' },
      { id: 'pf-c', manufacturer: 'pedifix', period: '2026-07-01', source: 'commission', amount: 100, commission: 10, source_file: 'pf-jul.csv' },
      { id: 'pf-s', manufacturer: 'pedifix', period: '2026-07-01', source: 'sales_report', amount: 70, commission: 7, external_ref: 'pedifix|X|Y|0' },
    ],
    app_settings: opts.flags ? [{ key: 'phase2_flags', value: opts.flags }] : [],
  });
  if (opts.enrolled) S.tables.mi1a_enrollment = opts.enrolled;
  else S.missingTables = ['mi1a_enrollment'];               // Part 1 not installed yet
  if (opts.failRead) S.failRead = opts.failRead;
  if (opts.failWrite) S.failWrite = opts.failWrite;
  return S;
}
// Load a function and put a recorder in front of the two MI-1a database functions.
function boot(file, s) {
  const w = createWorld(s); const m = load(file, w);
  const inner = global.fetch; w.rpc = [];
  global.fetch = async (url, init) => {
    const u = String(url); const hit = u.match(/\/rest\/v1\/rpc\/(hcps_sales_report_apply|hcps_commission_file_apply)/);
    if (hit) { const body = JSON.parse(init.body); w.rpc.push({ fn: hit[1], p: body.p });
      return { ok: true, status: 200, async text() { return JSON.stringify({ applied: !!body.p.apply, noop: false, inserted: 1, orders: { new: 1 }, months: [], will_write: { rows: 1 } }); }, async json() { return JSON.parse(await this.text()); } }; }
    return inner(url, init);
  };
  return { w, m };
}
const salesRows = [{ order_number: '9001', date: '2026-08-02', company: 'Retail Medical Solutions', product_code: 'X1', qty: 1, unit_price: 100 }];
const commRows = [{ customer_name: 'Retail Medical Solutions', amount: 100, commission: 10, order_date: '2026-08-02' }];
const directSales = w => w.writes.filter(x => x.table === 'monthly_sales');
const PRES = { token: 'pres' };

(async () => {
  /* ── 1. Before Part 1 (no enrolment table), switches off: every manufacturer = today's path ── */
  await t('before Part 1: Sales Report Import works exactly as today for all manufacturers', async () => {
    for (const slug of ['strongback-mobility', 'pedifix', 'abm-respiratory-care', 'airavant-bongorx']) {
      const { w, m } = boot('sales-import-api.js', seed());
      const r = await call(m, { action: 'import', manufacturer: slug, commission_rate: 9, rows: salesRows }, PRES);
      assert.strictEqual(r.status, 200, slug + ' ' + JSON.stringify(r.body));
      assert.strictEqual(w.rpc.length, 0, slug + ' must not use the MI-1a function');
      assert.ok(directSales(w).some(x => x.kind === 'insert' || x.kind === 'upsert'), slug + ' legacy write');
    }
  });

  /* ── 2. Part 1 + Part 2 run (only Strongback enrolled), switch OFF ── */
  const enrolledSB = [{ manufacturer: 'strongback-mobility', lane: 'sales_report', enrolled_by: 'angelo' }];
  await t('switch off: Strongback imports pause with a clear message; nothing is written', async () => {
    const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB }));
    for (const action of ['preview', 'import']) {
      const r = await call(m, { action, manufacturer: 'strongback-mobility', commission_rate: 9, rows: salesRows }, PRES);
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'import_paused');
    }
    assert.strictEqual(directSales(w).length, 0); assert.strictEqual(w.rpc.length, 0);
  });
  await t('switch off: PediFix, ABM and AirAvant (not enrolled) import exactly as today', async () => {
    for (const slug of ['pedifix', 'abm-respiratory-care', 'airavant-bongorx']) {
      const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB }));
      const p = await call(m, { action: 'preview', manufacturer: slug, commission_rate: 9, rows: salesRows }, PRES);
      assert.strictEqual(p.status, 200); assert.ok(p.body.preview && !p.body.preview.path, slug + ' legacy preview');
      const r = await call(m, { action: 'import', manufacturer: slug, commission_rate: 9, rows: salesRows }, PRES);
      assert.strictEqual(r.status, 200); assert.strictEqual(w.rpc.length, 0);
      const wr = directSales(w).filter(x => x.kind !== 'delete');
      assert.ok(wr.length >= 1 && String(wr[0].row.external_ref).startsWith(slug + '|9001|'), slug + ' keeps the legacy key, got ' + JSON.stringify(wr[0] && wr[0].row.external_ref));
    }
  });

  /* ── 3. Switch ON ── */
  const ON = { mi_import_v2: true };
  await t('switch on: Strongback goes through the atomic function only — no direct monthly_sales write', async () => {
    const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB, flags: ON }));
    const p = await call(m, { action: 'preview', manufacturer: 'strongback-mobility', commission_rate: 9, rows: salesRows }, PRES);
    assert.strictEqual(p.status, 200); assert.strictEqual(p.body.preview.path, 'v2');
    assert.strictEqual(w.rpc[0].fn, 'hcps_sales_report_apply'); assert.strictEqual(w.rpc[0].p.apply, false);
    const r = await call(m, { action: 'import', manufacturer: 'strongback-mobility', commission_rate: 9, rows: salesRows, approve_paid: true, approve_reason: 'x' }, PRES);
    assert.strictEqual(r.status, 200); assert.strictEqual(w.rpc[1].p.apply, true);
    assert.strictEqual(w.rpc[1].p.approve_paid, true); assert.strictEqual(w.rpc[1].p.approve_reason, 'x');
    assert.ok(!('external_ref' in w.rpc[1].p.rows[0]), 'the database sets the key, never the browser');
    assert.strictEqual(directSales(w).length, 0);
  });
  await t('switch on: PediFix, ABM and AirAvant still import exactly as today (no enrolment = no new identity)', async () => {
    for (const slug of ['pedifix', 'abm-respiratory-care', 'airavant-bongorx']) {
      const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB, flags: ON }));
      const r = await call(m, { action: 'import', manufacturer: slug, commission_rate: 9, rows: salesRows }, PRES);
      assert.strictEqual(r.status, 200); assert.strictEqual(w.rpc.length, 0, slug);
      assert.ok(directSales(w).some(x => x.kind === 'insert' || x.kind === 'upsert'), slug);
    }
  });
  await t('no code path ever enrols a manufacturer', async () => {
    const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB.slice(), flags: ON }));
    for (const slug of MFRS) await call(m, { action: 'import', manufacturer: slug, commission_rate: 9, rows: salesRows }, PRES);
    assert.strictEqual(w.writes.filter(x => x.table === 'mi1a_enrollment').length, 0);
    assert.strictEqual(w.db.mi1a_enrollment.length, 1);
  });
  await t('an unreadable enrolment table stops the import (never guesses "not enrolled")', async () => {
    const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB, flags: ON, failRead: tb => tb === 'mi1a_enrollment' ? 500 : 0 }));
    const r = await call(m, { action: 'import', manufacturer: 'pedifix', commission_rate: 9, rows: salesRows }, PRES);
    assert.strictEqual(r.status, 500); assert.strictEqual(directSales(w).length, 0);
  });
  await t('a refusal from the database (e.g. paid month) is shown, and nothing is written', async () => {
    const { w, m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB, flags: ON }));
    const inner = global.fetch;
    global.fetch = async (url, init) => /rpc\/hcps_sales_report_apply/.test(String(url))
      ? { ok: false, status: 400, async text() { return JSON.stringify({ code: 'P0001', message: 'mi1a_paid_period_change: ["2026-07"] (approve_paid + approve_reason required)' }); } }
      : inner(url, init);
    const r = await call(m, { action: 'import', manufacturer: 'strongback-mobility', commission_rate: 9, rows: salesRows }, PRES);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'mi1a_paid_period_change'); assert.ok(/approve_paid/.test(r.body.message));
    assert.strictEqual(directSales(w).length, 0);
  });

  /* ── 4. Commission Report Import ── */
  await t('commission import, switch off (any sales-switch state): every manufacturer uses today\'s path', async () => {
    for (const flags of [undefined, ON]) for (const slug of MFRS) {
      const { w, m } = boot('commissions-api.js', seed({ enrolled: enrolledSB, flags }));
      const r = await call(m, { action: 'import', manufacturer: slug, period: '2026-08', source_file: 'f.csv', rows: commRows }, PRES);
      assert.strictEqual(r.status, 200, slug + ' ' + JSON.stringify(r.body)); assert.strictEqual(w.rpc.length, 0);
      assert.ok(directSales(w).some(x => x.kind === 'insert'), slug + ' legacy insert');
    }
  });
  await t('legacy commission import never deletes Sales Report Import rows (no-file-name import)', async () => {
    const { w, m } = boot('commissions-api.js', seed());
    const r = await call(m, { action: 'import', manufacturer: 'pedifix', period: '2026-07', rows: commRows }, PRES);
    assert.strictEqual(r.status, 200);
    assert.ok(w.db.monthly_sales.some(x => x.id === 'pf-s'), 'the PediFix sales-report row survived');
    assert.ok(!w.db.monthly_sales.some(x => x.id === 'pf-c'), 'the old commission row was replaced');
  });
  await t('legacy commission import: a failed delete writes nothing for that month (no doubling)', async () => {
    const { w, m } = boot('commissions-api.js', seed({ failWrite: (meth, tb) => (meth === 'DELETE' && tb === 'monthly_sales') ? 500 : 0 }));
    const r = await call(m, { action: 'import', manufacturer: 'pedifix', period: '2026-07', source_file: 'pf-jul.csv', rows: commRows }, PRES);
    assert.strictEqual(r.status, 502); assert.strictEqual(r.body.error, 'replace_failed');
    assert.strictEqual(directSales(w).filter(x => x.kind === 'insert').length, 0);
  });
  await t('commission switch on: the WHOLE file (every month) goes to the database in one call', async () => {
    const { w, m } = boot('commissions-api.js', seed({ enrolled: enrolledSB, flags: { mi_commission_v2: true } }));
    const rows = [{ customer_name: 'Retail Medical Solutions', amount: 100, commission: 10, order_date: '2026-08-02' },
                  { customer_name: 'Retail Medical Solutions', amount: 50, commission: 5, order_date: '2026-09-04' }];
    const a = await call(m, { action: 'analyze', manufacturer: 'pedifix', period: 'auto', multi_month: true, source_file: 'q3.csv', rows }, PRES);
    assert.strictEqual(a.status, 200); assert.strictEqual(w.rpc[0].p.apply, false);
    const r = await call(m, { action: 'import', manufacturer: 'pedifix', period: 'auto', multi_month: true, source_file: 'q3.csv', rows,
      decisions: { '2026-08': { action: 'append', reason: 'r' } }, approve_paid: true, approve_reason: 'ok' }, PRES);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const call1 = w.rpc.filter(x => x.p.apply === true);
    assert.strictEqual(call1.length, 1, 'one call for the whole file');
    assert.deepStrictEqual(call1[0].p.months.map(x => x.period), ['2026-08-01', '2026-09-01']);
    assert.strictEqual(call1[0].p.decisions['2026-08'].action, 'append');
    assert.strictEqual(directSales(w).length, 0);
  });

  await t('commission lane enrolled for every manufacturer ("*") but switch off: imports pause, nothing written', async () => {
    const enrolledAll = enrolledSB.concat([{ manufacturer: '*', lane: 'commission', enrolled_by: 'angelo' }]);
    for (const slug of ['pedifix', 'golden-technologies']) {
      const { w, m } = boot('commissions-api.js', seed({ enrolled: enrolledAll }));
      const r = await call(m, { action: 'import', manufacturer: slug, period: '2026-08', source_file: 'f.csv', rows: commRows }, PRES);
      assert.strictEqual(r.status, 409, slug); assert.strictEqual(r.body.error, 'import_paused');
      assert.strictEqual(directSales(w).length, 0); assert.strictEqual(w.rpc.length, 0);
    }
  });

  /* ── 5. Alias guard ── */
  await t('alias guard: switch off = today (overwrites); switch on = refused with both dealers, replace:true overwrites', async () => {
    let { w, m } = boot('sales-import-api.js', seed());
    let r = await call(m, { action: 'add_alias', company: "Wyatt's Pharmacy", dealer_id: 'd-greg' }, PRES);
    assert.strictEqual(r.status, 200); assert.strictEqual(w.db.dealer_aliases[0].dealer_id, 'd-greg');
    ({ w, m } = boot('sales-import-api.js', seed({ flags: ON })));
    r = await call(m, { action: 'add_alias', company: "Wyatt's Pharmacy Inc", dealer_id: 'd-greg' }, PRES);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'alias_conflict');
    assert.strictEqual(r.body.current.id, 'd-ang'); assert.strictEqual(w.db.dealer_aliases[0].dealer_id, 'd-ang');
    r = await call(m, { action: 'add_alias', company: "Wyatt's Pharmacy Inc", dealer_id: 'd-greg', replace: true }, PRES);
    assert.strictEqual(r.status, 200); assert.strictEqual(w.db.dealer_aliases[0].dealer_id, 'd-greg');
  });

  /* ── 6. Roles unchanged ── */
  await t('roles unchanged: reps and Relations still cannot import', async () => {
    for (const tok of ['greg', 'lori']) {
      const { m } = boot('sales-import-api.js', seed({ enrolled: enrolledSB, flags: ON }));
      const r = await call(m, { action: 'import', manufacturer: 'strongback-mobility', rows: salesRows }, { token: tok });
      assert.strictEqual(r.status, 403, tok);
    }
  });
  done();
})();
