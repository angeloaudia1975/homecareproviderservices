/* C3-07 Stage 4 — saved customer quotes, the quote document and quote email. Runs the REAL dealer-quotes-api handler
   against the in-memory PostgREST fake (nothing reaches Supabase or a mail provider).
   Checks: save / reopen / edit (stale edit refused) / delete; D2 (head office: company quotes; branch: its own, never another
   branch; never another dealer); the three price bases resolved on HCPS's records (verified MSRP — never a 2x estimate,
   an upgrade has none —, the saved retail price with the location's own winning, a one-time price); the dealer's cost /
   contract / MAP tables are NEVER read; branding from HCPS's dealer record, never the request; HTML escaped; email only
   for a saved quote, one recipient, the dealer's own reply-to, the send limit recorded first (refused past it, marked
   failed when the provider refuses); strict reads (503); a database before the saved-quotes SQL.
     node test/quotes.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const DOC = require(path.join(ROOT, '_quote_doc.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', BR2 = '33333333-3333-3333-3333-333333333333', OTHER = '44444444-4444-4444-4444-444444444444';
function world(o) {
  o = o || {};
  const sends = [];
  const W = M.createWorld({ tokens: {}, failRead: o.failRead, failWrite: o.failWrite, missingTables: o.missingTables, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme Medical <HQ>', address: '1 Main St', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0100', email: 'sales@acme.test', website: 'acme.test', logo_url: 'https://cdn.acme.test/logo.png' },
      { id: BR, parent_id: HQ, business_name: 'Acme Branch', city: 'Xenia', state: 'OH', phone: '555-0200', email: 'br@acme.test', logo_url: null },
      { id: BR2, parent_id: HQ, business_name: 'Acme Two' }, { id: OTHER, parent_id: null, business_name: 'Else' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@acme.test' },
      { uid: 'u-b2', status: 'approved', dealer_id: BR2, email: 'b2@acme.test' }, { uid: 'u-ot', status: 'approved', dealer_id: OTHER, email: 'x@else.test' }],
    dealer_user_scope: [], dealer_saved_quotes: o.quotes || [],
    dealer_retail_prices: [{ id: 1, dealer_id: HQ, location_id: null, manufacturer: 'yuwell', code: 'YU-1', price: 120 }, { id: 2, dealer_id: HQ, location_id: BR, manufacturer: 'yuwell', code: 'YU-1', price: 125 },
      { id: 3, dealer_id: OTHER, location_id: null, manufacturer: 'yuwell', code: 'YU-1', price: 1 }],
    product_skus: [{ manufacturer: 'yuwell', code: 'YU-1', msrp: 159.99, base_price: 54.99 }, { manufacturer: 'yuwell', code: 'YU-2', msrp: null, base_price: 10 }],
    product_overrides: [{ manufacturer: 'bemis', code: 'BE-1', patch: { msrp: 49.5, base_price: 20 } }], custom_products: [],
    dealer_contract_prices: [{ dealer_id: HQ, code: 'YU-1', price: 33.33 }] } });
  const inner = W.fetch;
  W.fetch = async (url, opts) => { const u = String(url);
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(((opts && opts.headers) || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' }, b2: { id: 'u-b2' }, ot: { id: 'u-ot' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    if (u.startsWith(M.BASE + '/rest/v1/rpc/dealer_document_send_reserve')) {
      const b = JSON.parse(opts.body); sends.push(b);
      const n = sends.filter((s) => s.p_dealer === b.p_dealer).length;
      const body = o.limitAfter && n > o.limitAfter ? { ok: false, reason: 'hour', limit: 10 } : { ok: true, id: n };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }; }
    if (u.includes('api.resend.com') && o.mailFails) { W.outbound.push({ kind: 'resend-refused' }); return { ok: false, status: 422, text: async () => 'no', json: async () => ({}) }; }
    return inner(url, opts); };
  W.sends = sends;
  return W;
}
const api = (W, env) => M.load('dealer-quotes-api.js', W, Object.assign({ RESEND_API_KEY: 're_test', HCPS_MAIL_FROM: 'HCPS <orders@hcps.test>' }, env || {}), ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const L = (x) => Object.assign({ mfr: 'yuwell', code: 'YU-1', sku: 'YU-1', name: 'Yuwell Concentrator', qty: 1, basis: 'msrp' }, x);
const readsOf = (W, tb) => W.calls.filter((c) => c.method === 'GET' && String(c.url || '').includes('/rest/v1/' + tb + '?'));

(async () => {
  await t('document: lines validated (qty, basis, one-time price, 60 max), images https only', async () => {
    eq(DOC.cleanLines([L({ qty: 0 })]).error.includes('whole number'), true);
    eq(DOC.cleanLines([L({ basis: 'cost' })]).error.includes('choose MSRP'), true);
    eq(DOC.cleanLines([L({ basis: 'once' })]).error.includes('one-time price'), true);
    eq(DOC.cleanLines([L({ basis: 'once', unit: '-5' })]).error.includes('more than $0'), true);
    eq(DOC.cleanLines(Array.from({ length: 61 }, () => L())).error.includes('60'), true);
    const c = DOC.cleanLines([L({ image: 'javascript:alert(1)' }), L({ image: 'http://x.test/a.png' }), L({ image: 'https://x.test/a.png', basis: 'once', unit: '$1,234.5' })]);
    eq(c.lines.map((l) => l.image), ['', '', 'https://x.test/a.png']); eq(c.lines[2].unit, 1234.5);
    ok(DOC.cleanHeader({ customer_email: 'nope' }).error, 'bad email accepted');
  });
  await t('save → list → get → edit (stale refused) → delete; numbered Qyymmdd-XXXX', async () => {
    const W = world(); const C = api(W);
    const s = await as(C, 'hq', { action: 'quote_save', header: { customer_name: 'Pat', valid_for: '14 days' }, lines: [L(), L({ code: 'YU-2', sku: 'YU-2', basis: 'once', unit: 80, qty: 2 })] });
    eq(s.status, 200, JSON.stringify(s.body)); ok(/^Q\d{6}-[0-9A-Z]{4}$/.test(s.body.quote.quote_no), s.body.quote.quote_no);
    const row = W.db.dealer_saved_quotes[0]; eq([row.dealer_id, row.location_id, row.lines.length, row.created_by], [HQ, HQ, 2, 'hq@acme.test']);
    ok(!JSON.stringify(row.lines).includes('54.99'), 'cost stored on the quote');
    const list = await as(C, 'hq', { action: 'quote_list' }); eq(list.body.quotes.map((q) => [q.quote_no, q.line_count]), [[s.body.quote.quote_no, 2]]);
    const g = await as(C, 'hq', { action: 'quote_get', id: s.body.quote.id }); eq(g.body.quote.customer_name, 'Pat');
    const e1 = await as(C, 'hq', { action: 'quote_save', id: s.body.quote.id, updated_at: g.body.quote.updated_at, header: { customer_name: 'Pat Lee' }, lines: [L({ qty: 3 })] });
    eq(e1.status, 200, JSON.stringify(e1.body)); eq(W.db.dealer_saved_quotes[0].lines[0].qty, 3);
    const stale = await as(C, 'hq', { action: 'quote_save', id: s.body.quote.id, updated_at: g.body.quote.updated_at, header: {}, lines: [L()] });
    eq(stale.status, 409);
    eq((await as(C, 'hq', { action: 'quote_delete', id: s.body.quote.id })).status, 200); eq(W.db.dealer_saved_quotes.length, 0);
  });
  await t('D2: branch sees only its own; head office sees company; another branch / dealer cannot read, change or send', async () => {
    const W = world(); const C = api(W);
    const hq = (await as(C, 'hq', { action: 'quote_save', header: {}, lines: [L()] })).body.quote;
    const br = (await as(C, 'br', { action: 'quote_save', header: {}, lines: [L()] })).body.quote;
    eq(W.db.dealer_saved_quotes.map((q) => [q.dealer_id, q.location_id]).sort(), [[HQ, HQ], [HQ, BR]].sort());
    eq((await as(C, 'br', { action: 'quote_list' })).body.quotes.map((q) => q.id), [br.id]);
    eq((await as(C, 'hq', { action: 'quote_list' })).body.quotes.length, 2);
    eq((await as(C, 'br', { action: 'quote_get', id: hq.id })).status, 404);
    eq((await as(C, 'b2', { action: 'quote_get', id: br.id })).status, 404);
    eq((await as(C, 'ot', { action: 'quote_get', id: br.id })).status, 404);
    eq((await as(C, 'b2', { action: 'quote_delete', id: br.id })).status, 404);
    eq((await as(C, 'ot', { action: 'quote_email', id: br.id, to: 'c@cust.test' })).status, 404);
    eq((await as(C, 'nobody', { action: 'quote_list' })).status, 401);
  });
  await t('prices: verified MSRP, saved retail (location wins), one-time; no 2x estimate; upgrade has no MSRP; cost tables never read', async () => {
    const W = world(); const C = api(W);
    const r = await as(C, 'br', { action: 'quote_render', header: { customer_name: 'Pat' }, lines: [L({ qty: 2 }), L({ basis: 'retail' }), L({ code: 'YU-2', sku: 'YU-2' }),
      L({ code: 'YU-1|u=Heavy', sku: 'YU-1' }), L({ mfr: 'bemis', code: 'BE-1', sku: 'BE-1' }), L({ basis: 'once', unit: 99.95, qty: 3 })] });
    eq(r.status, 200, JSON.stringify(r.body)); const h = r.body.html;
    ok(h.includes('$319.98'), 'MSRP x2'); ok(h.includes('$125.00'), 'branch retail (own wins over 120)'); ok(!h.includes('$120.00'), 'company default shown at the branch');
    ok(h.includes('$49.50'), 'override MSRP'); ok(h.includes('$299.85'), 'one-time x3');
    ok((h.match(/MSRP not provided/g) || []).length >= 2, 'no-MSRP and upgrade lines priced');
    ok(!h.includes('54.99') && !h.includes('33.33') && !h.includes('$20.00'), 'a dealer cost leaked');
    ok(h.includes('$794.33'), 'total = 319.98+125+49.50+299.85');
    eq(readsOf(W, 'dealer_contract_prices').length + readsOf(W, 'dealer_tiers').length, 0);
    ok(!readsOf(W, 'product_skus').some((c) => /base_price/.test(c.url)), 'cost column read');
  });
  await t('branding from HCPS: name/address/phone/logo escaped; a branch without a logo uses its head office logo; request cannot brand', async () => {
    const W = world(); const C = api(W);
    const hq = (await as(C, 'hq', { action: 'quote_render', header: { customer_name: '<img src=x onerror=alert(1)>' }, lines: [L()], dealer: { business_name: 'Evil' } })).body.html;
    ok(hq.includes('Acme Medical &lt;HQ&gt;') && hq.includes('555-0100') && hq.includes('https://cdn.acme.test/logo.png'), 'HQ brand');
    ok(!hq.includes('<img src=x') && hq.includes('&lt;img src=x'), 'customer name not escaped'); ok(!hq.includes('Evil'), 'request branded the quote');
    const br = (await as(C, 'br', { action: 'quote_render', header: {}, lines: [L()] })).body.html;
    ok(br.includes('Acme Branch') && br.includes('https://cdn.acme.test/logo.png'), 'branch uses HQ logo');
  });
  await t('email: saved quotes only, one valid recipient, dealer reply-to, limit recorded first, quote marked sent, no cost in mail', async () => {
    const W = world(); const C = api(W);
    eq((await as(C, 'hq', { action: 'quote_email', header: {}, lines: [L()], to: 'c@cust.test' })).status, 400);
    const q = (await as(C, 'hq', { action: 'quote_save', header: { customer_name: 'Pat' }, lines: [L()] })).body.quote;
    eq((await as(C, 'hq', { action: 'quote_email', id: q.id, to: 'a@b.test, c@d.test' })).status, 400);
    const r = await as(C, 'hq', { action: 'quote_email', id: q.id, to: 'pat@cust.test', message: 'Hi <b>Pat</b>' });
    eq([r.status, r.body.sent_to], [200, 'pat@cust.test'], JSON.stringify(r.body));
    eq(W.sends.length, 1); eq([W.sends[0].p_kind, W.sends[0].p_dealer, W.sends[0].p_domain], ['quote', HQ, 'cust.test']); ok(!JSON.stringify(W.sends[0]).includes('pat@'), 'address stored');
    const mail = W.outbound.filter((x) => x.kind === 'resend'); eq(mail.length, 1);
    eq([mail[0].body.to, mail[0].body.reply_to], [['pat@cust.test'], 'hq@acme.test']); eq(mail[0].body.from, '"Acme Medical HQ via HCPS" <orders@hcps.test>');
    ok(mail[0].body.html.includes('Hi &lt;b&gt;Pat&lt;/b&gt;') && !mail[0].body.html.includes('54.99'), 'mail body');
    const row = W.db.dealer_saved_quotes[0]; eq([row.status, row.sent_count, row.customer_email], ['sent', 1, 'pat@cust.test']);
  });
  await t('email: past the limit refused before sending; provider refusal marks the send failed', async () => {
    const W = world({ limitAfter: 1 }); const C = api(W);
    const q = (await as(C, 'hq', { action: 'quote_save', header: {}, lines: [L()] })).body.quote;
    eq((await as(C, 'hq', { action: 'quote_email', id: q.id, to: 'a@cust.test' })).status, 200);
    const r = await as(C, 'hq', { action: 'quote_email', id: q.id, to: 'b@cust.test' }); eq(r.status, 429); ok(/hour/.test(r.body.error), r.body.error);
    eq(W.outbound.filter((x) => x.kind === 'resend').length, 1);
    const W2 = world({ mailFails: true }); const C2 = api(W2);
    const q2 = (await as(C2, 'hq', { action: 'quote_save', header: {}, lines: [L()] })).body.quote;
    eq((await as(C2, 'hq', { action: 'quote_email', id: q2.id, to: 'a@cust.test' })).status, 502);
    ok(W2.calls.some((c) => c.method === 'PATCH' && /dealer_document_sends/.test(c.url) && c.body && c.body.status === 'failed'), 'not marked failed');
    eq(W2.db.dealer_saved_quotes[0].status, 'draft');
  });
  await t('strict: an unreadable price store → 503 (never a quote with missing prices); before the SQL → "open shortly"', async () => {
    const W = world({ failRead: (tb) => tb === 'dealer_retail_prices' ? 500 : 0 }); const C = api(W);
    eq((await as(C, 'hq', { action: 'quote_render', header: {}, lines: [L({ basis: 'retail' })] })).status, 503);
    const W2 = world({ missingTables: ['dealer_saved_quotes'] }); const C2 = api(W2);
    const r = await as(C2, 'hq', { action: 'quote_list' }); eq([r.status, r.body.error], [503, 'Saved quotes open shortly.']);
  });
  await t('quote number uses the Chicago day (late evening CT is still that day)', async () => {
    const C = api(world());
    ok(/^Q261105-[0-9A-HJ-NP-Z]{4}$/.test(C._newQuoteNo(new Date('2026-11-06T04:30:00Z'))), 'not the Chicago day');
    ok(/^Q260101-/.test(C._newQuoteNo(new Date('2026-01-01T06:30:00Z'))), 'winter offset');
  });
  await t('review fixes: one plain address only; quoted From; "$" in a message is text; part number = the code; upgrade has no MSRP basis', async () => {
    const W = world(); const C = api(W);
    W.db.dealers[0].business_name = 'Smith Medical, LLC';
    const q = (await as(C, 'hq', { action: 'quote_save', header: {}, lines: [L()] })).body.quote;
    for (const bad of ['foo<pat@cust.test>', '"Pat" <pat@cust.test>', 'pat@cust.test (x)', 'pat@@cust.test'])
      eq((await as(C, 'hq', { action: 'quote_email', id: q.id, to: bad })).status, 400, bad);
    eq(W.sends.length, 0, 'a refused address reached the limiter');
    eq((await as(C, 'hq', { action: 'quote_email', id: q.id, to: 'pat@cust.test', message: "costs $' and $&" })).status, 200);
    const m = W.outbound.filter((x) => x.kind === 'resend')[0];
    eq(m.body.from, '"Smith Medical, LLC via HCPS" <orders@hcps.test>');
    ok(m.body.html.includes("costs $' and $amp;") || m.body.html.includes("costs $' and $&amp;"), 'message text mangled');
    eq((m.body.html.match(/Raised|Yuwell Concentrator/g) || []).length < 4, true, 'quote duplicated by a $ pattern');
    eq((await as(C, 'hq', { action: 'quote_render', header: {}, lines: [L({ sku: 'BE-1' })] })).status, 400, 'another product\'s MSRP');
    eq((await as(C, 'hq', { action: 'quote_render', header: {}, lines: [L({ mfr: 'golden', code: 'PR501|u=Heat', sku: 'PR501', basis: 'msrp', unit: 999 })] })).status, 400, 'Golden upgrade priced as MSRP from the request');
    eq((await as(C, 'hq', { action: 'quote_render', header: {}, lines: [L({ mfr: 'golden', code: 'PR501-XXX|std|Black|standard|0', sku: 'PR501-ABC', basis: 'msrp', unit: 1299 })] })).status, 200, 'Golden configuration key');
  });
  await t('review fixes: closed locations hidden; limits per company; a head office opening a branch quote gets that branch\'s retail', async () => {
    const W = world(); W.db.dealers.push({ id: '55555555-5555-5555-5555-555555555555', parent_id: HQ, business_name: 'Closed Br', active: false });
    W.db.dealer_saved_quotes.push({ id: '66666666-6666-6666-6666-666666666666', dealer_id: HQ, location_id: '55555555-5555-5555-5555-555555555555', quote_no: 'Q261105-AAAA', lines: [], status: 'draft', updated_at: 'x' });
    const C = api(W);
    eq((await as(C, 'hq', { action: 'quote_get', id: '66666666-6666-6666-6666-666666666666' })).status, 404, 'closed location visible');
    const bq = (await as(C, 'br', { action: 'quote_save', header: {}, lines: [L({ basis: 'retail' })] })).body.quote;
    const g = await as(C, 'hq', { action: 'quote_get', id: bq.id });
    eq([g.body.own_location, g.body.retail_at_location['yuwell|YU-1']], [false, 125]);
    eq((await as(C, 'br', { action: 'quote_email', id: bq.id, to: 'c@cust.test' })).status, 200);
    eq(W.sends[0].p_dealer, HQ, 'counted against the branch, not the company');
  });
  console.log(`\nquotes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
