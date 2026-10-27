/* Bulk catalog corrections (Batch 2, 2026-10-26): the pure plan (_catalog_corrections.js), the queue honouring
   recorded reviews (_catalog_exceptions.js) and the catalog-api actions correction_plan / correction_apply /
   correction_undo with the network stubbed. Synthetic data only — no real price ever appears here. */
const path = require('path');
const CC = require(path.join(__dirname, '..', 'netlify', 'functions', '_catalog_corrections.js'));
const CE = require(path.join(__dirname, '..', 'netlify', 'functions', '_catalog_exceptions.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }

const R = (o) => Object.assign({ manufacturer: 'm', brand: 'B', uom: 'Each', image: '/a.png' }, o);
(async () => {
  /* ---- classification ---- */
  await t('identical rows = repeated record', () => {
    const c = CC.classifyDuplicate([R({ code: 'X', name: 'Ramp', category: 'Ramps' }), R({ code: 'X', name: 'Ramp', category: 'Ramps' })]);
    ok(c.classification === 'repeated_record' && !c.differs.length, JSON.stringify(c));
  });
  await t('same product in two sections = cross-listing (Access4U SR3 shape)', () => {
    const c = CC.classifyDuplicate([R({ code: 'SR3', name: "Starter Ramp 3' x 36", category: 'Ramp Section (Stock Orders)', family: 'RS', width_in: 36 }),
      R({ code: 'SR3', name: "Starter Ramp 3' x 36", category: 'Ramp Run (Modular System)', family: 'RR', width_in: 36 })]);
    ok(c.classification === 'cross_listing', JSON.stringify(c)); ok(c.differs.join() === 'category,family', c.differs.join());
  });
  await t('one part filed under two models = shared part (GCE Zen-O / Zen-O Lite shape)', () => {
    const c = CC.classifyDuplicate([R({ code: 'RS-1', name: 'Zen-O cannula wrench', category: 'Zen-O', subcategory: 'Accessories & Parts' }),
      R({ code: 'RS-1', name: 'Zen-O Lite cannula wrench', category: 'Zen-O Lite', subcategory: 'Accessories & Parts' })]);
    ok(c.classification === 'shared_part', JSON.stringify(c));
  });
  await t('a name word that is NOT the section is a conflict, not a shared part', () => {
    const c = CC.classifyDuplicate([R({ code: 'RS-1', name: 'Zen-O wrench', category: 'Zen-O' }), R({ code: 'RS-1', name: 'Zen-O Lite filter', category: 'Zen-O Lite' })]);
    ok(c.classification === 'conflict', JSON.stringify(c));
  });
  await t('a different unit / UPC / photo / size is a conflict (possible mapping error)', () => {
    for (const f of [{ uom: 'Case' }, { upc: '123' }, { image: '/b.png' }, { size: 'L' }, { brand: 'Other' }]) {
      const c = CC.classifyDuplicate([R({ code: 'X', name: 'N', category: 'A' }), R(Object.assign({ code: 'X', name: 'N', category: 'B' }, f))]);
      ok(c.classification === 'conflict', JSON.stringify(f) + ' ' + c.classification);
    }
  });
  await t('only a name differs (same section) is a conflict', () => {
    const c = CC.classifyDuplicate([R({ code: 'X', name: 'Ramp', category: 'A' }), R({ code: 'X', name: 'Ramp Kit', category: 'A' })]);
    ok(c.classification === 'conflict', c.classification);
  });

  /* ---- plan ---- */
  const queue = { lines: [
    { slug: 'a4u', name: 'A4U', frozen: false, items: [
      { cat: 'sku', severity: 'warn', check: 'catalog_duplicate_codes', detail: 'dups', codes: ['SR3', 'BAD'], count: 2 },
      { cat: 'images', severity: 'warn', check: 'catalog_rows_without_image', detail: 'no img', codes: ['MRS2', 'SR3'], count: 2 },
      { cat: 'pricing', severity: 'warn', check: 'no_price_source', detail: 'no source' },
      { cat: 'content', severity: 'info', check: 'few_features', detail: 'x', codes: ['p1'] },
      { cat: 'ready', severity: 'info', check: 'sku_ready', detail: 'r', codes: ['K'] }] },
    { slug: 'gold', name: 'Gold', frozen: true, items: [{ cat: 'units', severity: 'warn', check: 'sku_without_unit', detail: 'no unit', codes: ['U1'], count: 1 }] }] };
  const rows = { a4u: [R({ code: 'SR3', name: 'S', category: 'One', family: 'RS' }), R({ code: 'SR3', name: 'S', category: 'Two', family: 'RR' }),
    R({ code: 'BAD', name: 'B', category: 'One', uom: 'Each' }), R({ code: 'BAD', name: 'B', category: 'Two', uom: 'Case' }), R({ code: 'MRS2', name: 'M', image: '' })] };
  const plan = CC.buildPlan({ queue, rows, decisions: [] });
  const P = id => plan.proposals.find(p => p.id === id);
  await t('plan: duplicates classified; the conflict is never applicable', () => {
    ok(P('a4u:dup:SR3').supported && P('a4u:dup:SR3').classification === 'cross_listing', 'SR3');
    ok(!P('a4u:dup:BAD').supported && P('a4u:dup:BAD').blocked === 'owner_decision', 'BAD');
    ok(/uom/.test(P('a4u:dup:BAD').proposed), P('a4u:dup:BAD').proposed);
  });
  await t('plan: every proposal shows original, proposed, evidence, affected and the owning tool', () => {
    for (const p of plan.proposals) ok(p.original && p.proposed && Array.isArray(p.evidence) && p.evidence.length && p.affected >= 1 && p.tool && p.href, p.id);
  });
  await t('plan: image status — a photo shown for the same part number elsewhere is a candidate, otherwise source requested', () => {
    ok(P('a4u:img:MRS2:catalog_rows_without_image').status === 'source_requested', 'MRS2');
    ok(P('a4u:img:SR3:catalog_rows_without_image').status === 'candidate_same_part', 'SR3');
  });
  await t('plan: prices / units / content / freight are hand-offs, never applicable; notes and ready are not proposals', () => {
    ok(!P('a4u:no_price_source').supported && P('a4u:no_price_source').blocked === 'owning_tool', 'pricing');
    ok(!P('a4u:few_features') && !plan.proposals.some(p => p.cat === 'ready'), 'info/ready proposed');
  });
  await t('plan: a frozen line is never applicable and points to the regression-fix procedure', () => {
    const p = P('gold:sku_without_unit'); ok(p && !p.supported && p.blocked === 'frozen' && /decisions/.test(p.href), JSON.stringify(p));
  });
  await t('plan: filter by manufacturer, category and part number', () => {
    ok(CC.buildPlan({ queue, rows, filter: { manufacturers: ['gold'] } }).proposals.every(p => p.manufacturer === 'gold'), 'mfr');
    ok(CC.buildPlan({ queue, rows, filter: { categories: ['images'] } }).proposals.every(p => p.cat === 'images'), 'cat');
    const c = CC.buildPlan({ queue, rows, filter: { codes: ['sr3'] } }).proposals; ok(c.length === 2 && c.every(p => p.codes.includes('SR3')), c.map(p => p.id).join());
  });
  await t('plan hash: stable for the same plan, changes when a review is recorded', () => {
    ok(CC.buildPlan({ queue, rows }).plan_hash === plan.plan_hash, 'unstable');
    const d = [{ id: 9, manufacturer: 'a4u', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { classification: 'cross_listing' } }];
    const p2 = CC.buildPlan({ queue, rows, decisions: d }); ok(p2.plan_hash !== plan.plan_hash, 'same hash');
    ok(!p2.proposals.find(p => p.id === 'a4u:dup:SR3').supported, 'recorded review still applicable');
    const d3 = d.concat([{ id: 10, manufacturer: 'a4u', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { status: 'reopened' } }]);
    const p3 = CC.buildPlan({ queue, rows, decisions: d3 });
    ok(p3.proposals.find(p => p.id === 'a4u:dup:SR3').supported, 'reopened not applicable again');
    ok(p3.plan_hash !== plan.plan_hash, 'a review recorded and reopened since the preview leaves the hash unchanged');
  });

  /* ---- decisions ---- */
  await t('decision: append-only exception row, no price, reason required, conflict refused', () => {
    const row = CC.decisionFor(P('a4u:dup:SR3'), 'boss@test', 'Same ramp listed in both sections');
    ok(row.kind === 'exception' && row.field === 'catalog:duplicate_code' && row.code === 'SR3' && row.hcps_value.classification === 'cross_listing' && row.hcps_value.keep_all_listings === true, JSON.stringify(row));
    let e = null; try { CC.decisionFor(P('a4u:dup:SR3'), 'x', ''); } catch (x) { e = x.message; } ok(e === 'reason_required', String(e));
    e = null; try { CC.decisionFor(P('a4u:dup:BAD'), 'x', 'reason here'); } catch (x) { e = x.message; } ok(e === 'not_applicable', String(e));
    e = null; try { CC.decisionFor(Object.assign({}, P('a4u:dup:BAD'), { supported: true }), 'x', 'reason here'); } catch (x) { e = x.message; } ok(e === 'owner_decision', String(e));
    ok(!/price|tiers|msrp|map"/i.test(JSON.stringify(row)), 'price in decision');
  });
  await t('undo: a superseding "reopened" decision; the code returns to the queue', () => {
    const d = { id: 9, manufacturer: 'a4u', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { classification: 'cross_listing' } };
    const r = CC.reopenFor(d, 'boss', 'reopen this one'); ok(r.supersedes_id === 9 && r.hcps_value.status === 'reopened', JSON.stringify(r));
    const rev = CC.latestReviews([d, Object.assign({ id: 10 }, r)]);
    ok(!CC.duplicateSettled(rev, 'a4u', 'SR3'), 'still settled after reopen');
    ok(CC.duplicateSettled(CC.latestReviews([d]), 'a4u', 'sr-3'.toUpperCase().replace('-', '')), 'normalised code');
  });

  /* ---- queue honours reviews ---- */
  const qin = () => ({ manufacturers: [{ slug: 'a4u', name: 'A4U', hasData: true, freight: {} }],
    catalogs: { a4u: [{ code: 'SR3', image: 'x.png' }, { code: 'SR3', image: 'x.png' }, { code: 'PRK', image: 'x.png' }, { code: 'PRK', image: 'x.png' }, { code: 'N', image: '' }] },
    skus: [], pages: [], meta: [], lines: {}, sources: {}, measured: { master: true, pages: true, runs: true } });
  await t('queue: a reviewed duplicate becomes a note and stops counting; a conflict / reopened one keeps counting', () => {
    const before = CE.exceptionsQueue(qin()).lines[0];
    const i = qin(); i.reviews = [{ id: 1, manufacturer: 'a4u', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { classification: 'cross_listing' } }];
    const after = CE.exceptionsQueue(i).lines[0];
    ok(after.counts.sku === before.counts.sku - 1, before.counts.sku + ' → ' + after.counts.sku);
    const note = after.items.find(x => x.check === 'duplicate_reviewed'); ok(note && note.severity === 'info' && note.codes.join() === 'SR3', JSON.stringify(note));
    const j = qin(); j.reviews = i.reviews.concat([{ id: 2, manufacturer: 'a4u', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { status: 'reopened' } }]);
    ok(CE.exceptionsQueue(j).lines[0].counts.sku === before.counts.sku, 'reopened still settled');
    const k = qin(); k.reviews = [{ id: 1, manufacturer: 'a4u', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { classification: 'conflict' } }];
    ok(CE.exceptionsQueue(k).lines[0].counts.sku === before.counts.sku, 'conflict settled');
    const o = qin(); o.reviews = [{ id: 1, manufacturer: 'other', field: CC.FIELD.duplicate, code: 'SR3', hcps_value: { classification: 'cross_listing' } }];
    ok(CE.exceptionsQueue(o).lines[0].counts.sku === before.counts.sku, 'another line settled it');
  });
  await t('queue: an image review state rides along but the photo still counts (rights unresolved)', () => {
    const before = CE.exceptionsQueue(qin()).lines[0];
    const i = qin(); i.reviews = [{ id: 3, manufacturer: 'a4u', field: CC.FIELD.image, code: 'N', hcps_value: { status: 'source_requested' } }];
    const l = CE.exceptionsQueue(i).lines[0];
    ok(l.counts.images === before.counts.images && l.counts.images > 0, 'image count changed');
    ok(l.items.some(x => x.cat === 'images' && x.reviews && x.reviews.N === 'source_requested'), 'no review annotation');
  });

  /* ---- the catalog-api actions ---- */
  process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_ROLE = 'svc';
  let role = 'president', breakTable = null, posted = [], decisions = [], nextId = 100, frozenA4u = false;
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
  global.fetch = async (url, opts) => {
    const u = String(url), m = (opts && opts.method) || 'GET';
    if (u.endsWith('/auth/v1/user')) return resp(200, { email: 'boss@test' });
    if (u.includes('/rest/v1/staff_users')) return resp(200, [{ role, active: true }]);
    if (u.endsWith('/data/manufacturers.json')) return resp(200, [{ slug: 'a4u', name: 'A4U', hasData: true, freight: {} }, { slug: 'gold', name: 'Gold', hasData: true, freight: {} }]);
    if (u.includes('/data/a4u.json')) return resp(200, [
      { code: 'SR3', name: 'S', category: 'One', family: 'RS', uom: 'Each', image: 'x.png', base_price: 98.76 }, { code: 'SR3', name: 'S', category: 'Two', family: 'RR', uom: 'Each', image: 'x.png', base_price: 98.76 },
      { code: 'BAD', name: 'B', category: 'One', uom: 'Each', image: 'b.png' }, { code: 'BAD', name: 'B', category: 'Two', uom: 'Case', image: 'b.png' }, { code: 'N', name: 'N', image: '' }]);
    if (u.includes('/data/gold.json')) return resp(200, [{ code: 'G1', image: 'g.png' }, { code: 'G1', image: 'g.png' }]);
    if (breakTable && u.includes('/rest/v1/' + breakTable)) return resp(500, { message: 'down' });
    if (u.includes('/rest/v1/mfr_decisions') && m === 'POST') {
      const body = JSON.parse(opts.body); const list = Array.isArray(body) ? body : [body];
      const ins = list.map(r => Object.assign({ id: nextId++, decided_at: '2026-10-26T00:00:00Z' }, r)); posted.push(...ins); decisions.push(...ins); return resp(201, ins);
    }
    if (u.includes('/rest/v1/mfr_decisions') && /field=like\.catalog/.test(u)) return resp(200, decisions.slice());
    if (u.includes('/rest/v1/manufacturer_meta')) return resp(200, [{ slug: 'gold', frozen: true }, { slug: 'a4u', frozen: frozenA4u }]);
    if (u.includes('/rest/v1/')) return resp(200, []);
    return resp(404, {});
  };
  const api = require(path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js'));
  const call = async b => { const r = await api.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(b) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  let pl;
  await t('action plan: President gets proposals; nothing written; no price leaves', async () => {
    const r = await call({ action: 'correction_plan' }); pl = r.body;
    ok(r.status === 200 && r.body.ok && r.body.plan_hash && r.body.proposals.length, JSON.stringify(r.body).slice(0, 300));
    ok(r.body.proposals.find(p => p.id === 'a4u:dup:SR3').supported, 'SR3 not applicable');
    ok(!r.body.proposals.find(p => p.id === 'a4u:dup:BAD').supported, 'BAD applicable');
    ok(r.body.proposals.filter(p => p.manufacturer === 'gold').every(p => !p.supported), 'frozen applicable');
    ok(!posted.length, 'plan wrote'); ok(!/98\.76|base_price/.test(JSON.stringify(r.body)), 'price leaked');
  });
  await t('action apply: reason required; a stale plan, a conflict, a frozen item or an unknown id records nothing', async () => {
    ok((await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['a4u:dup:SR3'] })).status === 400, 'no reason');
    ok((await call({ action: 'correction_apply', plan_hash: 'stale', ids: ['a4u:dup:SR3'], reason: 'reason ok' })).body.error === 'plan_changed', 'stale');
    ok((await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['a4u:dup:BAD'], reason: 'reason ok' })).status === 409, 'conflict');
    const fz = pl.proposals.find(p => p.manufacturer === 'gold'); ok(fz, 'no frozen proposal');
    ok((await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: [fz.id], reason: 'reason ok' })).status === 423, 'frozen');
    ok((await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['nope'], reason: 'reason ok' })).status === 409, 'unknown');
    ok((await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['a4u:dup:SR3', 'a4u:dup:BAD'], reason: 'reason ok' })).status === 409, 'mixed batch');
    ok(!posted.length, 'something was recorded: ' + JSON.stringify(posted));
  });
  await t('action apply: dry run shows the rows and writes nothing', async () => {
    const r = await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['a4u:dup:SR3'], reason: 'reason ok', dry_run: true });
    ok(r.status === 200 && r.body.dry_run && r.body.decisions[0].field === 'catalog:duplicate_code', JSON.stringify(r.body)); ok(!posted.length, 'wrote');
  });
  await t('action apply: records the decisions and returns the recalculated queue', async () => {
    const img = pl.proposals.find(p => p.id.startsWith('a4u:img:N:'));
    const r = await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['a4u:dup:SR3', img.id], reason: 'Same ramp listed in both sections' });
    ok(r.status === 200 && r.body.recorded.length === 2, JSON.stringify(r.body).slice(0, 300));
    ok(posted.every(p => p.decided_by === 'boss@test' && p.kind === 'exception'), 'actor/kind');
    const l = r.body.queue.lines.find(x => x.slug === 'a4u');
    ok(l.items.some(x => x.check === 'duplicate_reviewed' && x.codes.includes('SR3')), 'queue not recalculated');
    ok(!/98\.76|base_price/.test(JSON.stringify(r.body)), 'price leaked');
  });
  await t('action apply: applying the same plan twice is refused (plan changed)', async () => {
    const r = await call({ action: 'correction_apply', plan_hash: pl.plan_hash, ids: ['a4u:dup:SR3'], reason: 'again please' });
    ok(r.status === 409, String(r.status));
  });
  await t('action undo: only the current review; supersedes it; the code returns to the queue', async () => {
    const dec = posted.find(p => p.code === 'SR3');
    ok((await call({ action: 'correction_undo', decision_id: dec.id })).status === 400, 'no reason');
    ok((await call({ action: 'correction_undo', decision_id: 99999, reason: 'reopen now' })).status === 404, 'unknown');
    const r = await call({ action: 'correction_undo', decision_id: dec.id, reason: 'reopen now' });
    ok(r.status === 200 && r.body.recorded[0].supersedes_id === dec.id, JSON.stringify(r.body).slice(0, 200));
    const l = r.body.queue.lines.find(x => x.slug === 'a4u'); ok(!l.items.some(x => x.check === 'duplicate_reviewed'), 'still reviewed');
    ok((await call({ action: 'correction_undo', decision_id: dec.id, reason: 'reopen again' })).status === 409, 'old decision undone twice');
  });
  await t('action: a frozen line refuses apply even if its item were applicable; undo on a frozen line refused', async () => {
    frozenA4u = true; const p = await call({ action: 'correction_plan' });
    ok(p.body.proposals.filter(x => x.manufacturer === 'a4u').every(x => !x.supported), 'frozen a4u applicable');
    const dec = posted.find(x => x.code === 'N');
    ok((await call({ action: 'correction_undo', decision_id: dec.id, reason: 'reopen now' })).status === 423, 'undo on frozen');
    frozenA4u = false;
  });
  await t('action: other roles refused; an unreadable layer is a 503', async () => {
    role = 'admin'; ok((await call({ action: 'correction_plan' })).status === 403, 'admin'); role = 'president';
    for (const tb of ['product_skus', 'mfr_decisions', 'custom_products']) { breakTable = tb; const r = await call({ action: 'correction_plan' }); breakTable = null; ok(r.status === 503, tb + ' ' + r.status); }
  });
  console.log(`\ncatalog corrections: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
