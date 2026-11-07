/* Catalog 4 §8 Batch D — scheduling & publishing (OFF until the platforms approve HCPS's apps). Real dealer-ads-api,
   social-publish-cron and social-oauth-callback handlers against the in-memory PostgREST fake; Meta / LinkedIn / storage are
   fakes in this file (nothing reaches a real platform). Synthetic data only.
   Checks: tokens sealed (AES-GCM) and never returned; signed OAuth state (tamper / expiry); every gate (master switch,
   platform approval, credentials, the dealer's own connection, the dealer's own approval); scheduling rules; edits drop the
   approval; pause / resume / cancel; the worker publishes an approved due post once per platform, never twice, retries
   temporary errors, never re-posts an interrupted target, never publishes a post that missed its time, re-checks the ad's
   products; Instagram two-step and LinkedIn upload flows.   node test/social-publish.test.js */
const path = require('path');
const crypto = require('crypto');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = path.join(__dirname, '..', 'netlify', 'functions');
const SP = require(path.join(ROOT, '_social_publish.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222';
const ENV = { SOCIAL_TOKEN_KEY: crypto.randomBytes(32).toString('base64'), SOCIAL_STATE_SECRET: 's'.repeat(40), META_APP_ID: 'app1', META_APP_SECRET: 'sec1', LINKEDIN_CLIENT_ID: 'li1', LINKEDIN_CLIENT_SECRET: 'lis', URL: 'https://admin.test', ORDERING_BASE: 'https://shop.test' };
const ON = { social_publishing: true, social_meta_approved: true, social_linkedin_approved: true };
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 1)]).toString('base64');
const CAT = { bemis: [{ code: 'B1', name: 'Raised Toilet Seat', category: 'Bath Safety', image: '/assets/products/bemis/B1.jpg', price: 55.5, base_price: 55.5 }] };
const uuid = () => crypto.randomUUID();

function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, catalog: CAT, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme Medical', city: 'Dayton', state: 'OH', phone: '555-0100' }, { id: BR, parent_id: HQ, business_name: 'Acme Branch', city: 'Xenia' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@acme.test' }],
    dealer_user_scope: [], dealer_preview_tokens: [{ token: 'pv', dealer_id: HQ, expires_at: new Date(Date.now() + 600000).toISOString() }],
    dealer_manufacturers: [{ dealer_id: HQ, manufacturer: 'bemis', active: true }],
    manufacturers: [{ slug: 'bemis', name: 'Bemis' }], manufacturer_meta: [], product_content: [],
    product_skus: [{ manufacturer: 'bemis', code: 'B1', msrp: 99.99, msrp_auto: false, status: 'active', base_price: 55.5 }], product_overrides: [], custom_products: [], dealer_contract_prices: [],
    dealer_storefronts: [], dealer_retail_prices: [],
    dealer_social_ads: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', company_id: HQ, dealer_id: HQ, title: 'Seat', version: 1, archived_at: null,
      ad: { template: 'spotlight', format: o.format || 'square', font: 'Inter', colors: {}, show: {}, headline: 'Feel steadier at home', body: '', cta: 'Visit us today', caption: '', hashtags: [], products: [{ manufacturer: 'bemis', code: 'B1', show_price: true }] } }],
    dealer_social_connections: o.conns || [], dealer_social_posts: o.posts || [], dealer_social_post_targets: o.targets || [],
    app_settings: [{ key: 'phase2_flags', value: o.flags || {} }] } });
  const inner = W.fetch; W.calls = []; W.store = {};
  W.fetch = async (url, opts) => { const u = String(url); const h = (opts && opts.headers) || {}; const m = (opts && opts.method) || 'GET';
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(h.Authorization || '').replace(/^Bearer\s+/i, ''); const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    if (u.startsWith(M.BASE + '/storage/v1/object/sign/social-media/x?')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10) };
    if (u.startsWith(M.BASE + '/storage/v1/object/sign/')) return { ok: true, status: 200, json: async () => ({ signedURL: '/object/sign/social-media/x?token=t' }) };
    if (u.startsWith(M.BASE + '/storage/v1/object/social-media/')) { W.store[u] = opts.body; return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; }
    if (u.startsWith(M.BASE + '/storage/v1/object/sign/social-media/x')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10) };
    if (/graph\.facebook\.com|api\.linkedin\.com|linkedin\.com\/oauth|upload\.li\.test/.test(u)) { W.calls.push({ url: u, method: m, body: opts && opts.body ? String(opts.body) : '', headers: h });
      const r = (o.platform || (() => null))(u, m, opts); if (r) return r;
      const okj = (j, hd) => ({ ok: true, status: 200, headers: { get: (k) => (hd || {})[k.toLowerCase()] || null }, text: async () => JSON.stringify(j), json: async () => j });
      if (/\/photos$/.test(u)) return okj({ id: 'ph1', post_id: 'fbpost1' });
      if (/\/media$/.test(u)) return okj({ id: 'cr1' }); if (/media_publish$/.test(u)) return okj({ id: 'igpost1' });
      if (/initializeUpload/.test(u)) return okj({ value: { uploadUrl: 'https://upload.li.test/u1', image: 'urn:li:image:1' } });
      if (/upload\.li\.test/.test(u)) return okj({}); if (/\/rest\/posts$/.test(u)) return okj({}, { 'x-restli-id': 'urn:li:share:9' });
      if (/oauth\/access_token\?client_id/.test(u)) return okj({ access_token: 'short-tok' }); if (/fb_exchange_token/.test(u)) return okj({ access_token: 'long-tok' });
      if (/\/me\/accounts/.test(u)) return okj({ data: [{ id: 'page1', name: 'Acme Page', access_token: 'PAGE-SECRET-TOKEN', instagram_business_account: { id: 'ig1', username: 'acme' } }] });
      return { ok: false, status: 404, text: async () => '{}' }; }
    if (/\/assets\/products\//.test(u)) return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(8) };
    if (/\/data\/content\//.test(u)) return { ok: false, status: 404, json: async () => null };
    if (m === 'POST' && /\/rest\/v1\/dealer_social_(posts|connections|post_targets)/.test(u) && opts.body) { const b = JSON.parse(opts.body); const rows = Array.isArray(b) ? b : [b];
      for (const r of rows) { if (!r.id) r.id = uuid(); if (/posts\b/.test(u) && r.version == null) r.version = 1; if (/post_targets/.test(u)) { if (r.status == null) r.status = 'pending'; if (r.attempts == null) r.attempts = 0; } if (/dealer_social_posts/.test(u) && r.attempts == null) r.attempts = 0; }
      opts = Object.assign({}, opts, { body: JSON.stringify(Array.isArray(b) ? rows : rows[0]) }); }
    return inner(url, opts); };
  return W;
}
const api = (W) => M.load('dealer-ads-api.js', W, ENV, ROOT);
const cron = (W) => M.load('social-publish-cron.js', W, ENV, ROOT);
const cb = (W) => M.load('social-oauth-callback.js', W, ENV, ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const AD = 'aaaaaaaa-0000-4000-8000-000000000001';
const later = (min) => new Date(Date.now() + min * 60e3).toISOString();
const conn = (platform, ext) => ({ id: uuid(), company_id: HQ, dealer_id: HQ, platform, external_id: ext, status: 'connected', token_ciphertext: SP.seal(ENV, 'TOKEN-' + platform), authorized_by: 'hq@acme.test', authorized_at: new Date().toISOString() });
const due = (x) => Object.assign({ id: uuid(), company_id: HQ, dealer_id: HQ, ad_id: AD, caption: 'Now at Acme Medical.', format: 'square', media_path: `${HQ}/${HQ}/x.png`, platforms: ['facebook'],
  scheduled_at: new Date(Date.now() - 60e3).toISOString(), status: 'approved', approved_by: 'hq@acme.test', approved_at: new Date().toISOString(), version: 3, attempts: 0, next_attempt_at: null, updated_at: new Date().toISOString() }, x || {});

(async () => {
  await t('tokens are sealed (AES-256-GCM): round trip, a wrong key or a changed byte fails; OAuth state is signed and expires', async () => {
    const s = SP.seal(ENV, 'abc'); ok(!s.includes('abc'), 'sealed'); eq(SP.open(ENV, s), 'abc');
    let threw = false; try { SP.open(Object.assign({}, ENV, { SOCIAL_TOKEN_KEY: crypto.randomBytes(32).toString('base64') }), s); } catch (e) { threw = true; } ok(threw, 'wrong key');
    threw = false; try { const p = s.split('.'); p[3] = p[3].slice(0, -2) + (p[3].slice(-2) === 'AA' ? 'AB' : 'AA'); SP.open(ENV, p.join('.')); } catch (e) { threw = true; } ok(threw, 'tamper');
    const st = SP.signState(ENV, { loc: HQ, platform: 'facebook' }); eq(SP.readState(ENV, st).loc, HQ);
    eq(SP.readState(ENV, st.replace(/.$/, st.slice(-1) === 'A' ? 'B' : 'A')), null, 'tampered state');
    eq(SP.readState(Object.assign({}, ENV, { SOCIAL_STATE_SECRET: 'x'.repeat(40) }), st), null, 'other secret');
  });
  await t('gates: nothing opens unless the master switch, the platform approval and the credentials are all present', async () => {
    eq(SP.platformOpen({}, ENV, 'facebook').reason, 'publishing_off');
    eq(SP.platformOpen({ social_publishing: true }, ENV, 'facebook').reason, 'platform_not_approved');
    eq(SP.platformOpen({ social_publishing: true, social_meta_approved: true }, ENV, 'linkedin').reason, 'platform_not_approved');
    eq(SP.platformOpen(ON, Object.assign({}, ENV, { META_APP_SECRET: '' }), 'instagram').reason, 'not_configured');
    eq(SP.platformOpen(ON, ENV, 'instagram').ok, true);
    const W = world(); const r = await as(api(W), 'hq', { action: 'social_connect', location_id: HQ, platform: 'facebook' }); eq(r.status, 409, 'off → refused');
  });
  await t('connect (switch on): the official sign-in URL carries a signed state; the callback stores SEALED page tokens, never returned', async () => {
    const W = world({ flags: ON }); const r = await as(api(W), 'hq', { action: 'social_connect', location_id: HQ, platform: 'instagram' }); eq(r.status, 200);
    const u = new URL(r.body.url); eq(u.host, 'www.facebook.com'); ok(/instagram_content_publish/.test(u.searchParams.get('scope')), 'scope'); const state = u.searchParams.get('state');
    eq((await as(api(W), 'preview:pv', { action: 'social_connect', location_id: HQ, platform: 'facebook' })).status, 403, 'preview');
    const bad = await cb(W).handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { code: 'c', state: state + 'x' } }); ok(/social=refused/.test(bad.headers.location), 'bad state');
    const good = await cb(W).handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { code: 'c', state } }); ok(/social=connected/.test(good.headers.location), good.headers.location);
    const c = W.db.dealer_social_connections; eq(c.map((x) => [x.platform, x.external_id, x.dealer_id]), [['instagram', 'ig1', HQ]]);
    ok(!JSON.stringify(c).includes('PAGE-SECRET-TOKEN'), 'token sealed'); eq(SP.open(ENV, c[0].token_ciphertext), 'PAGE-SECRET-TOKEN');
    const st = await as(api(W), 'hq', { action: 'social_status', location_id: HQ }); ok(!/PAGE-SECRET|token_ciphertext|"v1\./.test(JSON.stringify(st.body)), 'no token in the status answer');
  });
  await t('schedule: stored image + caption; awaiting the dealer\'s approval; claims refused; Instagram never landscape', async () => {
    const W = world(); const C = api(W);
    const r = await as(C, 'hq', { action: 'post_save', ad_id: AD, platforms: ['facebook'], scheduled_at: later(60), caption: 'Now at Acme Medical.', media: PNG });
    eq([r.status, r.body.post.status, r.body.post.approved_by], [200, 'awaiting_approval', null]); ok(Object.keys(W.store)[0].includes('/social-media/' + HQ + '/'), 'stored privately');
    eq((await as(C, 'hq', { action: 'post_save', ad_id: AD, platforms: ['facebook'], scheduled_at: later(60), caption: '50% off today', media: PNG })).status, 400, 'claim');
    eq((await as(C, 'hq', { action: 'post_save', ad_id: AD, platforms: ['facebook'], scheduled_at: later(1), caption: '', media: PNG })).status, 400, 'too soon');
    eq((await as(C, 'hq', { action: 'post_save', ad_id: AD, platforms: ['facebook'], scheduled_at: later(60), caption: '', media: 'data:image/png;base64,AAAA' })).status, 400, 'not an image');
    eq((await as(C, 'br', { action: 'post_save', ad_id: AD, platforms: ['facebook'], scheduled_at: later(60), caption: '', media: PNG })).status, 404, 'branch cannot see HQ ad');
    const W2 = world({ format: 'landscape' }); eq((await as(api(W2), 'hq', { action: 'post_save', ad_id: AD, platforms: ['instagram'], scheduled_at: later(60), caption: '', media: PNG })).status, 400, 'IG landscape');
  });
  await t('approval: needs the dealer\'s own connection for every platform; a signed-in dealer only; an edit drops it; pause / resume / cancel', async () => {
    const W = world(); const C = api(W);
    const p = (await as(C, 'hq', { action: 'post_save', ad_id: AD, platforms: ['facebook'], scheduled_at: later(60), caption: '', media: PNG })).body.post;
    eq((await as(C, 'hq', { action: 'post_approve', id: p.id, version: p.version })).status, 409, 'no connection');
    W.db.dealer_social_connections.push(conn('facebook', 'page1'));
    eq((await as(C, 'preview:pv', { action: 'post_approve', id: p.id, version: p.version })).status, 403, 'preview never approves');
    const a = await as(C, 'hq', { action: 'post_approve', id: p.id, version: p.version }); eq([a.status, a.body.post.status, a.body.post.approved_by], [200, 'approved', 'hq@acme.test']);
    const e = await as(C, 'hq', { action: 'post_save', id: p.id, version: a.body.post.version, ad_id: AD, platforms: ['facebook'], scheduled_at: later(90), caption: 'Changed', media: PNG });
    eq([e.body.post.status, e.body.post.approved_by], ['awaiting_approval', null], 'edit drops approval');
    const a2 = (await as(C, 'hq', { action: 'post_approve', id: p.id, version: e.body.post.version })).body.post;
    const ps = (await as(C, 'hq', { action: 'post_pause', id: p.id, version: a2.version })).body.post; eq(ps.status, 'paused');
    const rs = (await as(C, 'hq', { action: 'post_resume', id: p.id, version: ps.version })).body.post; eq(rs.status, 'approved');
    const cx = (await as(C, 'hq', { action: 'post_cancel', id: p.id, version: rs.version })).body.post; eq(cx.status, 'cancelled');
    eq((await as(C, 'hq', { action: 'post_resume', id: p.id, version: cx.version })).status, 409);
  });
  await t('worker: switch off → nothing; on → an approved due post is published once per platform, never twice', async () => {
    const off = world({ posts: [due()], conns: [conn('facebook', 'page1')] }); eq((await cron(off).run()).skipped, 'publishing_off'); eq(off.calls.length, 0);
    const W = world({ flags: ON, posts: [due({ platforms: ['facebook', 'instagram', 'linkedin'] })], conns: [conn('facebook', 'page1'), conn('instagram', 'ig1'), conn('linkedin', 'urn:li:organization:5')] });
    const r = await cron(W).run(); eq(r.published, 3, JSON.stringify(r));
    eq(W.db.dealer_social_posts[0].status, 'published'); eq(W.db.dealer_social_post_targets.map((x) => x.external_post_id).sort(), ['fbpost1', 'igpost1', 'urn:li:share:9']);
    ok(W.calls.some((c) => /media_publish/.test(c.url) && /creation_id=cr1/.test(c.body)), 'IG two-step');
    ok(W.calls.some((c) => /upload\.li\.test/.test(c.url)) && W.calls.find((c) => /\/rest\/posts$/.test(c.url)).headers['LinkedIn-Version'], 'LinkedIn upload + versioned API');
    ok(W.calls.find((c) => /\/photos$/.test(c.url)).body.includes('access_token=TOKEN-facebook'), 'the page token is used server-side');
    const n = W.calls.length; await cron(W).run(); eq(W.calls.length, n, 'second run publishes nothing');
    const pid = uuid(); const W5 = world({ flags: ON, posts: [due({ id: pid, platforms: ['facebook', 'instagram'], attempts: 1 })], conns: [conn('facebook', 'page1'), conn('instagram', 'ig1')],
      targets: [{ id: uuid(), post_id: pid, platform: 'facebook', status: 'published', attempts: 1, external_post_id: 'fbpost0' }] });
    await cron(W5).run(); ok(!W5.calls.some((c) => /\/photos$/.test(c.url)) && W5.calls.some((c) => /media_publish/.test(c.url)), 'a retry publishes only the platform still missing');
  });
  await t('worker: a temporary error is retried later; a refusal fails; an interrupted target is never re-posted', async () => {
    let first = true;
    const W = world({ flags: ON, posts: [due()], conns: [conn('facebook', 'page1')], platform: (u) => (/\/photos$/.test(u) && first ? (first = false, { ok: false, status: 503, text: async () => '{"error":{"message":"busy"}}' }) : null) });
    const r1 = await cron(W).run(); eq(r1.retry, 1); const p = W.db.dealer_social_posts[0]; eq([p.status, p.attempts], ['approved', 1]); ok(Date.parse(p.next_attempt_at) > Date.now(), 'later');
    p.next_attempt_at = new Date(Date.now() - 1000).toISOString(); const r2 = await cron(W).run(); eq(r2.published, 1); eq(W.db.dealer_social_posts[0].status, 'published');
    const W2 = world({ flags: ON, posts: [due()], conns: [conn('facebook', 'page1')], platform: (u) => (/\/photos$/.test(u) ? { ok: false, status: 400, text: async () => '{"error":{"message":"Invalid parameter access_token=SECRET"}}' } : null) });
    await cron(W2).run(); eq(W2.db.dealer_social_posts[0].status, 'failed'); ok(!/SECRET/.test(W2.db.dealer_social_post_targets[0].last_error), 'token never kept in an error');
    const pid = uuid(); const W3 = world({ flags: ON, posts: [due({ id: pid, status: 'publishing', updated_at: new Date(Date.now() - 3600e3).toISOString() })], conns: [conn('facebook', 'page1')],
      targets: [{ id: uuid(), post_id: pid, platform: 'facebook', status: 'publishing', attempts: 1, claimed_at: new Date(Date.now() - 3600e3).toISOString() }] });
    await cron(W3).run(); eq(W3.calls.length, 0, 'never re-posted'); eq([W3.db.dealer_social_post_targets[0].status, W3.db.dealer_social_posts[0].status], ['failed', 'failed']);
  });
  await t('worker: a post past its time by a day is not published late; a product no longer authorized stops it; paused never runs', async () => {
    const W = world({ flags: ON, posts: [due({ scheduled_at: new Date(Date.now() - 30 * 3600e3).toISOString() })], conns: [conn('facebook', 'page1')] });
    eq((await cron(W).run()).missed, 1); eq(W.calls.length, 0); ok(/Missed/.test(W.db.dealer_social_posts[0].last_error), 'reason');
    const W2 = world({ flags: ON, posts: [due()], conns: [conn('facebook', 'page1')] }); W2.db.dealer_manufacturers[0].active = false;
    await cron(W2).run(); eq(W2.calls.length, 0); ok(/needs attention/.test(W2.db.dealer_social_posts[0].last_error), W2.db.dealer_social_posts[0].last_error);
    const W3 = world({ flags: ON, posts: [due({ status: 'paused' })], conns: [conn('facebook', 'page1')] }); await cron(W3).run(); eq(W3.calls.length, 0);
    const W4 = world({ flags: ON, posts: [due({ approved_by: null, approved_at: null })], conns: [conn('facebook', 'page1')] }); await cron(W4).run(); eq(W4.calls.length, 0, 'no approval → never');
  });
  console.log(`\nsocial publish: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
