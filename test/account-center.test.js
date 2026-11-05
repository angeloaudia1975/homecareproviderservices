/* C3-07 Stage 3 — Dealer Account Management Center. Runs the REAL dealer-tools-api, dealer-auth and dealers-api handlers
   against the in-memory PostgREST fake (test/phase0-mock.js), plus the pure rules in _account_center.js.
   Covers: D2 location scope (head office sees its company, a branch only itself — never widened), account statuses
   (green verified / amber pending / red none), change requests are REQUESTS (nothing applied until HCPS approves),
   approval applies company / addresses / contacts, default ship-to, logo upload (real JPEG/PNG only, 1 MB), account-number
   claims (verify never turns ordering on; a different number on file is never silently replaced), the closed credit
   form (D5: nothing stored, nothing emailed), and a database before the Stage 3 SQL.
     node test/account-center.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const AC = require(path.join(ROOT, '_account_center.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };

const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', BR2 = '33333333-3333-3333-3333-333333333333', OTHER = '44444444-4444-4444-4444-444444444444';
const UHQ = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', UBR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, failRead: o.failRead, failWrite: o.failWrite, missingTables: o.missingTables, columns: o.columns,
    uniquePartial: { dealer_account_claims: [{ cols: ['dealer_id', 'manufacturer'], where: r => r.status === 'pending' }] }, tables: {
      manufacturer_meta: [{ slug: 'yuwell', active: true }, { slug: 'dalton', active: false }],
      app_settings: [{ key: 'platform_state', value: { mode: 'development' } }],
      manufacturers: [{ slug: 'yuwell', name: 'Yuwell' }, { slug: 'access4u', name: 'Access4U' }, { slug: 'ohio-medical', name: 'Ohio Medical' }, { slug: 'dalton', name: 'Dalton' }],
      dealers: [
        { id: HQ, parent_id: null, business_name: 'Acme HQ', hcps_account: 'H-1', contact_name: 'Ann', email: 'ann@acme.test', phone: '555-111-2222', website: '', address: '1 Main St', city: 'Dayton', state: 'OH', zip: '45402', logo_url: null, golden_status: 'Account', rep_email: 'greg@homecareproviderservices.us' },
        { id: BR, parent_id: HQ, business_name: 'Acme Branch', address: '2 Side St', city: 'Xenia', state: 'OH', zip: '45385', golden_status: null },
        { id: BR2, parent_id: HQ, business_name: 'Acme Branch Two', address: '3 Far Rd', city: 'Troy', state: 'OH', zip: '45373' },
        { id: OTHER, parent_id: null, business_name: 'Someone Else', address: '9 Elm', city: 'Lima', state: 'OH', zip: '45801' }],
      dealer_users: [{ uid: UHQ, status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: UBR, status: 'approved', dealer_id: BR, email: 'br@acme.test' }],
      dealer_manufacturers: o.dm || [{ dealer_id: HQ, manufacturer: 'yuwell', account_ref: 'Y-100', active: true, verified_at: '2026-11-01T00:00:00Z' },
        { dealer_id: HQ, manufacturer: 'access4u', account_ref: 'A-9', active: true, verified_at: null },
        { dealer_id: BR, manufacturer: 'access4u', account_ref: 'A-10', active: true, verified_at: null },
        { dealer_id: OTHER, manufacturer: 'yuwell', account_ref: 'SECRET-1', active: true, verified_at: '2026-01-01T00:00:00Z' }],
      dealer_contacts: [{ id: 'c0000000-0000-0000-0000-000000000001', dealer_id: HQ, name: 'Bob', title: 'Buyer', email: 'bob@acme.test', phone: '555-000-1111' },
        { id: 'c0000000-0000-0000-0000-000000000009', dealer_id: OTHER, name: 'Other Person', email: 'o@else.test' }],
      dealer_addresses: [{ dealer_id: HQ, addr_key: 'bill', label: 'Billing', address: '1 Main St', city: 'Dayton', state: 'OH', zip: '45402', pri: 1 },
        { dealer_id: HQ, addr_key: 'ship-wh', label: 'Warehouse', address: '50 Dock Rd', city: 'Dayton', state: 'OH', zip: '45404', pri: 2 }],
      dealer_access_requests: [], dealer_change_requests: o.changes || [], dealer_account_claims: o.claims || [], dealer_user_scope: o.scope || [],
      dealer_contract_prices: [], dealer_line_discounts: [], geocache: [], staff_users: [{ email: 'angelo@homecareproviderservices.us', role: 'president', active: true }],
      credit_applications: [], resale_certs: [], dealer_terms: [] } });
  const inner = W.fetch; W.mail = []; W.storage = [];
  W.fetch = async (url, opts) => { const u = String(url);
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(((opts && opts.headers) || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      const map = { hq: { id: UHQ, email: 'hq@acme.test' }, br: { id: UBR, email: 'br@acme.test' }, staff: { id: 'sss', email: 'angelo@homecareproviderservices.us' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok], text: async () => JSON.stringify(map[tok]) } : { ok: false, status: 401, json: async () => ({}), text: async () => '{}' }; }
    if (u.startsWith(M.BASE + '/storage/v1/object/dealer-logos/')) { W.storage.push({ url: u, headers: opts.headers, bytes: opts.body.length });
      if (o.storageFails) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, text: async () => '{"Key":"x"}' }; }
    if (u.startsWith('https://api.resend.com')) { W.mail.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ id: 'm' }) }; }
    return inner(url, opts); };
  return W;
}
const tools = W => M.load('dealer-tools-api.js', W, { RESEND_API_KEY: 'k' }, ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const writesTo = (W, table) => W.calls.filter(c => c.method !== 'GET' && String(c.url || '').includes('/rest/v1/' + table));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);

(async () => {
  /* ---------- pure rules ---------- */
  await t('D2: head office sees its company; a branch only itself; a scope row never widens a branch', async () => {
    const fam = [{ id: HQ, parent_id: null }, { id: BR, parent_id: HQ }, { id: BR2, parent_id: HQ }];
    eq(AC.visibleLocations(HQ, fam, null).map(x => x.id), [HQ, BR, BR2]);
    eq(AC.visibleLocations(BR, fam, null).map(x => x.id), [BR]);
    eq(AC.visibleLocations(BR, fam, { scope: 'company' }).map(x => x.id), [BR], 'branch never widened');
    eq(AC.visibleLocations(HQ, fam, { scope: 'own' }).map(x => x.id), [HQ]);
    eq(AC.visibleLocations(HQ, fam, { scope: 'list', locations: [BR2, OTHER] }).map(x => x.id), [HQ, BR2], 'a list never reaches outside the company');
    eq(AC.visibleLocations(OTHER, fam, null), [], 'unknown self → nothing');
  });
  await t('status: verified / pending (on file, submitted, access asked, ordering only) / none; Golden from its status', async () => {
    eq(AC.accountStatus({ slug: 'y', dm: { account_ref: 'Y1', verified_at: 'x', active: true } }).status, 'verified');
    eq(AC.accountStatus({ slug: 'y', dm: { account_ref: 'Y1', active: true } }).status, 'pending');
    eq(AC.accountStatus({ slug: 'y', dm: null, claim: { account_ref: 'Z' } }).label, 'Submitted — HCPS is verifying');
    eq(AC.accountStatus({ slug: 'y', dm: null, verifiedClaim: { account_ref: 'Z' } }).status, 'verified');
    eq(AC.accountStatus({ slug: 'y', dm: null, accessOpen: true }).status, 'pending');
    eq(AC.accountStatus({ slug: 'y', dm: { active: true } }).label, 'Ordering set up — account number not on file');
    eq(AC.accountStatus({ slug: 'y' }).status, 'none');
    eq(AC.accountStatus({ slug: 'golden-technologies', goldenStatus: 'Account' }).status, 'verified');
    eq(AC.accountStatus({ slug: 'golden-technologies', goldenStatus: 'Prospect' }).status, 'none');
    eq(AC.accountStatus({ slug: 'y', dm: { account_ref: 'Y1', verified_at: 'x', active: false } }).ordering, false, 'verified ≠ ordering');
  });
  await t('validation: bad email / state / ZIP / website / too many / nothing — refused; good input passes trimmed', async () => {
    ok(AC.validateChanges({ company: { email: 'nope' } }).error, 'email');
    ok(AC.validateChanges({ business: { address: '1', city: 'a', state: 'Ohio', zip: '45402' } }).error, 'state');
    ok(AC.validateChanges({ business: { address: '1', city: 'a', state: 'OH', zip: '4540' } }).error, 'zip');
    ok(AC.validateChanges({ company: { website: 'javascript:alert(1)' } }).error, 'website');
    ok(AC.validateChanges({ ship_to: new Array(11).fill({ address: '1', city: 'a', state: 'OH', zip: '45402' }) }).error, '11 ship-tos');
    ok(AC.validateChanges({}).error, 'nothing');
    ok(AC.validateChanges({ contacts: [{ name: '' }] }).error, 'contact name');
    const v = AC.validateChanges({ company: { phone: ' 555-222-3333 ' }, contacts: [{ name: ' Cy\u0007 ', email: 'CY@ACME.TEST' }] });
    eq(v.changes, { company: { phone: '555-222-3333' }, contacts: [{ name: 'Cy', title: '', email: 'cy@acme.test', phone: '' }] });
  });
  await t('logo sniff: real JPEG / PNG pass; GIF, SVG text, renamed text and > 1 MB refused', async () => {
    eq(AC.sniffLogo(JPEG).ext, 'jpg'); eq(AC.sniffLogo(PNG).ext, 'png');
    ok(AC.sniffLogo(Buffer.from('GIF89a....')).error); ok(AC.sniffLogo(Buffer.from('<svg onload=alert(1)>')).error);
    ok(AC.sniffLogo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1048576)])).error, 'too big');
  });

  /* ---------- dealer side ---------- */
  await t('head-office login: company, contacts, addresses (business first), 3 locations, statuses — nothing of another dealer', async () => {
    const W = world(); const r = await as(tools(W), 'hq', { action: 'account_center' });
    eq([r.status, r.body.ok], [200, true], JSON.stringify(r.body));
    eq(r.body.company.business_name, 'Acme HQ'); eq(r.body.company.head_office, true);
    eq(r.body.contacts.map(c => c.name), ['Bob']);
    eq(r.body.addresses.map(a => a.key), ['main', 'bill', 'ship-wh']);
    eq(r.body.locations.map(l => l.name), ['Acme HQ', 'Acme Branch', 'Acme Branch Two']); eq(r.body.scope, 'company');
    const self = r.body.locations.find(l => l.is_self), st = s => self.accounts.find(a => a.slug === s);
    eq([st('yuwell').status, st('access4u').status, st('golden-technologies').status], ['verified', 'pending', 'verified']);
    ok(!self.accounts.some(a => a.slug === 'ohio-medical'), 'retired line hidden'); ok(!self.accounts.some(a => a.slug === 'dalton'), 'switched-off line hidden');
    ok(!JSON.stringify(r.body).includes('SECRET-1') && !JSON.stringify(r.body).includes('Someone Else') && !JSON.stringify(r.body).includes('Other Person'), 'no other dealer');
  });
  await t('branch login: only its own location (D2), its own accounts', async () => {
    const W = world(); const r = await as(tools(W), 'br', { action: 'account_center' });
    eq(r.body.locations.map(l => l.name), ['Acme Branch']); eq(r.body.scope, 'own'); eq(r.body.company.head_office, false);
    eq(r.body.locations[0].accounts.find(a => a.slug === 'access4u').account_ref, 'A-10');
  });
  await t('HCPS narrowed a head office to "own": it sees only itself', async () => {
    const W = world({ scope: [{ uid: UHQ, scope: 'own', locations: null, set_by: 'x' }] });
    eq((await as(tools(W), 'hq', { action: 'account_center' })).body.locations.map(l => l.name), ['Acme HQ']);
  });
  await t('an unreadable store answers 503 (never a partial account); signed-out → unauthorized', async () => {
    const W = world({ failRead: tb => tb === 'dealer_manufacturers' ? 500 : 0 });
    const r = await as(tools(W), 'hq', { action: 'account_center' }); eq([r.status, r.body.ok], [503, false]);
    eq((await as(tools(world()), 'nobody', { action: 'account_center' })).body.status, 'unauthorized');
  });
  await t('before the Stage 3 SQL: the page still loads (no verified column, no claims / scope tables)', async () => {
    const W = world({ missingTables: ['dealer_account_claims', 'dealer_user_scope'], columns: {
      dealer_manufacturers: ['dealer_id', 'manufacturer', 'account_ref', 'active'],
      dealers: ['id', 'business_name', 'hcps_account', 'contact_name', 'email', 'phone', 'website', 'address', 'city', 'state', 'zip', 'parent_id', 'logo_url', 'golden_status', 'rep_email'] } });
    const r = await as(tools(W), 'hq', { action: 'account_center' });
    eq([r.status, r.body.ok], [200, true], JSON.stringify(r.body).slice(0, 200));
    eq(r.body.locations[0].accounts.find(a => a.slug === 'yuwell').status, 'pending', 'unverified until the column exists');
    eq((await as(tools(W), 'hq', { action: 'account_claim', manufacturer: 'yuwell', account_ref: 'Y-2' })).status, 503);
    eq((await as(tools(W), 'hq', { action: 'default_ship_set', key: 'main' })).status, 503);
  });
  await t('a change is a REQUEST: queued for HCPS, the dealer record and contacts untouched', async () => {
    const W = world();
    const r = await as(tools(W), 'hq', { action: 'account_change_request', changes: { company: { phone: '555-999-0000' }, contacts: [{ name: 'Cy', email: 'cy@acme.test' }], ship_to: [{ label: 'Store 2', address: '7 Oak Ave', city: 'Kettering', state: 'oh', zip: '45429' }] } });
    eq([r.status, r.body.ok], [200, true], JSON.stringify(r.body));
    eq(W.db.dealer_change_requests.length, 1); eq(W.db.dealer_change_requests[0].dealer_id, HQ); eq(W.db.dealer_change_requests[0].status, 'pending');
    eq(W.db.dealer_change_requests[0].changes.ship_to[0].state, 'OH');
    eq(writesTo(W, 'dealers').length + writesTo(W, 'dealer_contacts').length + writesTo(W, 'dealer_addresses').length, 0, 'nothing applied');
  });
  await t('change requests: invalid input 400; a sixth waiting request 429', async () => {
    eq((await as(tools(world()), 'hq', { action: 'account_change_request', changes: { company: { email: 'x' } } })).status, 400);
    const W = world({ changes: [1, 2, 3, 4, 5].map(i => ({ id: i, dealer_id: HQ, status: 'pending', changes: {} })) });
    eq((await as(tools(W), 'hq', { action: 'account_change_request', changes: { company: { phone: '555-999-0000' } } })).status, 429);
  });
  await t('default ship-to: one of its own addresses only', async () => {
    const W = world(); const C = tools(W);
    eq((await as(C, 'hq', { action: 'default_ship_set', key: 'ship-wh' })).body.default_ship_key, 'ship-wh');
    eq(W.db.dealers.find(d => d.id === HQ).default_ship_key, 'ship-wh');
    eq((await as(C, 'hq', { action: 'default_ship_set', key: 'nope' })).status, 400);
    eq((await as(C, 'br', { action: 'default_ship_set', key: 'ship-wh' })).status, 400, 'another dealer\'s address');
  });
  await t('logo: a real JPEG is stored privately-named (sha, no overwrite) and saved; a fake image never reaches storage', async () => {
    const W = world(); const C = tools(W);
    const r = await as(C, 'hq', { action: 'logo_upload', data: 'data:image/jpeg;base64,' + JPEG.toString('base64') });
    eq([r.status, r.body.ok], [200, true], JSON.stringify(r.body));
    ok(new RegExp('/storage/v1/object/dealer-logos/' + HQ + '/[0-9a-f]{32}\\.jpg$').test(W.storage[0].url), W.storage[0].url);
    eq(W.storage[0].headers['x-upsert'], 'false'); eq(W.storage[0].headers['content-type'], 'image/jpeg');
    ok(/\/object\/public\/dealer-logos\//.test(W.db.dealers.find(d => d.id === HQ).logo_url), 'logo_url saved');
    const bad = await as(C, 'hq', { action: 'logo_upload', data: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)></svg>').toString('base64') });
    eq(bad.status, 400); eq(W.storage.length, 1, 'nothing more uploaded');
    const W2 = world({ storageFails: true }); const f = await as(tools(W2), 'hq', { action: 'logo_upload', data: PNG.toString('base64') });
    eq(f.status, 503); eq(W2.db.dealers.find(d => d.id === HQ).logo_url, null, 'not saved when storage failed');
  });
  await t('account claim: queued (no number in the email), one open per line, same number on file = already; ordering untouched', async () => {
    const W = world(); const C = tools(W);
    const r = await as(C, 'hq', { action: 'account_claim', manufacturer: 'yuwell', account_ref: 'Y-200' });
    eq([r.status, r.body.saved], [200, true], JSON.stringify(r.body));
    eq(W.db.dealer_account_claims.map(x => [x.dealer_id, x.manufacturer, x.account_ref, x.status]), [[HQ, 'yuwell', 'Y-200', 'pending']]);
    eq(W.mail.length, 1); ok(!JSON.stringify(W.mail[0]).includes('Y-200'), 'number not emailed');
    eq((await as(C, 'hq', { action: 'account_claim', manufacturer: 'yuwell', account_ref: 'Y-300' })).body.already, true);
    eq((await as(C, 'hq', { action: 'account_claim', manufacturer: 'access4u', account_ref: 'a-9' })).body.already_on_file, true);
    eq((await as(C, 'hq', { action: 'account_claim', manufacturer: 'ohio-medical', account_ref: 'X' })).status, 400, 'retired');
    eq((await as(C, 'hq', { action: 'account_claim', manufacturer: 'yuwell', account_ref: '<b>' })).status, 400, 'bad number');
    eq(writesTo(W, 'dealer_manufacturers').length, 0, 'ordering untouched');
  });
  await t('D5: the old credit form stores and emails NOTHING (410)', async () => {
    const W = world(); const r = await as(tools(W), 'hq', { action: 'credit_application', manufacturer: 'yuwell', ein: '12-3456789', bank_ref: 'Bank 123' });
    eq(r.status, 410); eq(W.db.credit_applications.length, 0); eq(W.mail.length, 0);
  });
  await t('checkout default ship-to reaches the storefront payload (dealer-auth)', async () => {
    const W = world(); W.db.dealers.find(d => d.id === HQ).default_ship_key = 'ship-wh';
    const r = await as(M.load('dealer-auth.js', W, {}, ROOT), 'hq', { action: 'me' });
    eq(r.body.dealer.default_ship_key, 'ship-wh'); ok(r.body.dealer.addresses.some(a => a.key === 'ship-wh'), 'keys carried');
    const W0 = world({ columns: { dealers: ['id', 'business_name', 'hcps_account', 'contact_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'parent_id', 'golden_status', 'ovation_access', 'golden_url', 'is_test', 'rep_email', 'active', 'status', 'account_class'] } });
    const r0 = await as(M.load('dealer-auth.js', W0, {}, ROOT), 'hq', { action: 'me' });
    eq([r0.body.status, r0.body.dealer.default_ship_key], ['approved', null], 'sign-in works before the SQL');
  });

  /* ---------- HCPS side (dealers-api) ---------- */
  const adm = W => M.load('dealers-api.js', W, { ADMIN_TOKEN: 'adm' }, ROOT);
  const post = (C, body) => M.call(C, body, { headers: { authorization: 'Bearer staff' } });
  await t('approve: company, business address, ship-to and contacts applied; removal NOT applied', async () => {
    const W = world({ changes: [{ id: 7, dealer_id: HQ, status: 'pending', changes: {
      company: { phone: '555-999-0000', website: 'https://acme.test' }, business: { address: '5 New St', city: 'Dayton', state: 'OH', zip: '45403' },
      ship_to: [{ label: 'Store 2', address: '7 Oak Ave', city: 'Kettering', state: 'OH', zip: '45429' }, { key: 'ship-wh', label: 'Warehouse', address: '51 Dock Rd', city: 'Dayton', state: 'OH', zip: '45404' }],
      contacts: [{ name: 'Cy', email: 'cy@acme.test', title: '', phone: '' }, { id: 'c0000000-0000-0000-0000-000000000001', name: 'Bob B', title: 'Owner', email: 'bob@acme.test', phone: '' },
        { id: 'c0000000-0000-0000-0000-000000000009', name: 'Hijack', email: 'h@x.test' }, { id: 'c0000000-0000-0000-0000-000000000001', remove: true }] } }] });
    const r = await post(adm(W), { action: 'approve_change', id: 7 });
    eq([r.status, r.body.ok], [200, true], JSON.stringify(r.body));
    const d = W.db.dealers.find(x => x.id === HQ); eq([d.phone, d.website, d.address], ['555-999-0000', 'https://acme.test', '5 New St']);
    const a = W.db.dealer_addresses.filter(x => x.dealer_id === HQ);
    ok(a.some(x => x.label === 'Store 2' && /^ship-[0-9a-f]{8}$/.test(x.addr_key)), 'new ship-to'); eq(a.find(x => x.addr_key === 'ship-wh').address, '51 Dock Rd');
    eq(W.db.dealer_contacts.filter(x => x.dealer_id === HQ).map(x => x.name).sort(), ['Bob B', 'Cy'], 'added + updated, not removed');
    eq(W.db.dealer_contacts.find(x => x.id === 'c0000000-0000-0000-0000-000000000009').name, 'Other Person', 'another dealer\'s contact never touched');
    eq(W.db.dealer_change_requests[0].status, 'approved');
  });
  await t('claim verify: number confirmed on the existing row, ordering NOT turned on; no row → none created', async () => {
    const W = world({ dm: [{ dealer_id: HQ, manufacturer: 'yuwell', account_ref: null, active: false }],
      claims: [{ id: 1, dealer_id: HQ, manufacturer: 'yuwell', account_ref: 'Y-200', status: 'pending' }, { id: 2, dealer_id: HQ, manufacturer: 'access4u', account_ref: 'A-1', status: 'pending' }] });
    const C = adm(W);
    eq((await post(C, { action: 'claim_verify', id: 1 })).body.updated_ordering_row, true);
    const row = W.db.dealer_manufacturers.find(x => x.manufacturer === 'yuwell'); eq([row.account_ref, row.active, !!row.verified_at], ['Y-200', false, true]);
    eq((await post(C, { action: 'claim_verify', id: 2 })).body.updated_ordering_row, false);
    eq(W.db.dealer_manufacturers.length, 1, 'nothing created'); eq(W.db.dealer_account_claims.map(x => x.status), ['verified', 'verified']);
    eq((await post(C, { action: 'claim_verify', id: 1 })).status, 409, 'already decided');
  });
  await t('claim verify: a DIFFERENT number on file is never replaced silently (409), only with confirm', async () => {
    const W = world({ claims: [{ id: 3, dealer_id: HQ, manufacturer: 'access4u', account_ref: 'A-NEW', status: 'pending' }] });
    const C = adm(W); const r = await post(C, { action: 'claim_verify', id: 3 });
    eq([r.status, r.body.error, r.body.on_file], [409, 'account_conflict', 'A-9']); eq(W.db.dealer_manufacturers.find(x => x.dealer_id === HQ && x.manufacturer === 'access4u').account_ref, 'A-9');
    eq((await post(C, { action: 'claim_verify', id: 3, confirm_replace: true })).body.ok, true);
    eq(W.db.dealer_manufacturers.find(x => x.dealer_id === HQ && x.manufacturer === 'access4u').account_ref, 'A-NEW');
  });
  await t('dm verify / undo, needs a number; set_user_scope is President-only and validated', async () => {
    const W = world(); const C = adm(W);
    eq((await post(C, { action: 'dm_verify', dealer_id: HQ, manufacturer: 'access4u' })).body.ok, true);
    ok(W.db.dealer_manufacturers.find(x => x.dealer_id === HQ && x.manufacturer === 'access4u').verified_at, 'verified');
    eq((await post(C, { action: 'dm_unverify', dealer_id: HQ, manufacturer: 'access4u' })).body.ok, true);
    eq(W.db.dealer_manufacturers.find(x => x.dealer_id === HQ && x.manufacturer === 'access4u').verified_at, null);
    eq((await post(C, { action: 'set_user_scope', uid: UHQ, scope: 'own' })).body.scope, 'own'); eq(W.db.dealer_user_scope[0].scope, 'own');
    eq((await post(C, { action: 'set_user_scope', uid: UHQ, scope: 'everything' })).status, 400);
    eq((await post(C, { action: 'set_user_scope', uid: UHQ, scope: 'default' })).body.scope, 'default'); eq(W.db.dealer_user_scope.length, 0);
  });
  await t('dealer side cannot reach the HCPS actions (no staff token)', async () => {
    const W = world(); const r = await as(adm(W), 'hq', { action: 'claim_verify', id: 1 });
    ok(r.status === 401 || r.status === 403, 'refused ' + r.status);
  });
  console.log(`\naccount center: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
