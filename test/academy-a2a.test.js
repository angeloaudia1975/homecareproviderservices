/* HCPS Academy A2A — security and authorization. The real functions, loaded unmodified in the Phase 0 harness
   (in-memory PostgREST + Supabase Auth). Run: node test/academy-a2a.test.js
   Covers: sign-in refusals, audience separation, switches, inactive people, dealer and branch isolation, request
   bodies that try to widen access, strict reads, audit records, safe responses, input limits, cross-site requests,
   the session value itself, and the audited-operation error mapping. */
const assert = require('assert');
const { createWorld, load, call, t, done, BASE } = require('./phase0-mock.js');

const HQ = '10000000-0000-4000-8000-0000000000a1', BR = '10000000-0000-4000-8000-0000000000a2', OTHER = '10000000-0000-4000-8000-0000000000b1';
const REP_DEALER = '10000000-0000-4000-8000-0000000000c1';
const L_TM_HQ = '20000000-0000-4000-8000-000000000001', L_TM_BR = '20000000-0000-4000-8000-000000000002', L_PLAIN = '20000000-0000-4000-8000-000000000003',
      L_CLOSED = '20000000-0000-4000-8000-000000000004', L_ENDED = '20000000-0000-4000-8000-000000000005', L_STAFF = '20000000-0000-4000-8000-000000000006',
      L_OTHER = '20000000-0000-4000-8000-000000000007';
const U = n => '30000000-0000-4000-8000-00000000000' + n;
const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const ORIGIN = 'https://homecareproviderservices.org';

function seed(extra) {
  const s = {
    tokens: { pres: 'angelo@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', old: 'former@hcps.us', dealer: 'buyer@hqmed.test' },
    tables: {
      staff_users: [
        { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', active: true },
        { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', active: true },
        { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', active: true },
        { email: 'former@hcps.us', name: 'Former', role: 'president', active: false },
      ],
      dealers: [
        { id: HQ, business_name: 'HQ Medical', parent_id: null, rep_name: 'Greg Campbell', rep_email: 'greg@hcps.us' },
        { id: BR, business_name: 'HQ Medical North', parent_id: HQ, rep_name: null, rep_email: null },
        { id: OTHER, business_name: 'Other Dealer', parent_id: null, rep_name: 'Angelo Audia', rep_email: 'angelo@hcps.us' },
        { id: REP_DEALER, business_name: 'Greg Solo', parent_id: null, rep_name: 'Greg Campbell', rep_email: 'greg@hcps.us' },
      ],
      dealer_directory: [],
      app_settings: [{ key: 'phase2_flags', value: { academy_admin: true, academy_learner: true, timeline: true } }],
      academy_learners: [
        { id: L_TM_HQ, auth_user_id: U(1), full_name: 'HQ Manager', email: 'tm@hqmed.test', status: 'active' },
        { id: L_TM_BR, auth_user_id: U(2), full_name: 'Branch Manager', email: 'tm@north.test', status: 'active' },
        { id: L_PLAIN, auth_user_id: U(3), full_name: 'Plain Learner', email: 'learner@hqmed.test', status: 'active' },
        { id: L_CLOSED, auth_user_id: U(4), full_name: 'Closed', email: 'closed@hqmed.test', status: 'closed' },
        { id: L_ENDED, auth_user_id: U(5), full_name: 'Ended', email: 'ended@hqmed.test', status: 'active' },
        { id: L_STAFF, auth_user_id: U(6), full_name: 'Greg as learner', email: 'greg@hcps.us', status: 'active' },
        { id: L_OTHER, auth_user_id: U(7), full_name: 'Other Learner', email: 'x@other.test', status: 'active' },
      ],
      academy_memberships: [
        { id: 'm1', learner_id: L_TM_HQ, dealer_id: HQ, role: 'training_manager', access_type: 'dealer_user', status: 'active' },
        { id: 'm2', learner_id: L_TM_BR, dealer_id: BR, role: 'training_manager', access_type: 'training_only', status: 'active' },
        { id: 'm3', learner_id: L_PLAIN, dealer_id: HQ, role: 'learner', access_type: 'training_only', status: 'active' },
        { id: 'm4', learner_id: L_CLOSED, dealer_id: HQ, role: 'learner', access_type: 'training_only', status: 'active' },
        { id: 'm5', learner_id: L_ENDED, dealer_id: HQ, role: 'training_manager', access_type: 'training_only', status: 'ended' },
        { id: 'm6', learner_id: L_STAFF, dealer_id: HQ, role: 'learner', access_type: 'training_only', status: 'active' },
        { id: 'm7', learner_id: L_OTHER, dealer_id: OTHER, role: 'learner', access_type: 'training_only', status: 'active' },
      ],
      academy_events: [],
    },
  };
  return Object.assign(s, extra || {});
}
const ENV = { ACADEMY_SESSION_SECRET: SECRET };
function world(extra) { return createWorld(seed(extra)); }
const mod = (w, f, env) => load(f, w, Object.assign({}, ENV, env || {}));
// Session cookies are made ONCE, up front: loading a module in the harness re-points the fake database, so a test
// must never load anything after it has loaded the module under test.
const S0 = load('_academy_session.js', createWorld(seed()), ENV);
const COOKIES = {};
const cookieFor = (w, learnerId, authUid) => { const k = learnerId + '/' + authUid; return COOKIES[k] || (COOKIES[k] = S0.COOKIE + '=' + S0.issue(learnerId, authUid)); };
const learnerOpts = (cookie, extra) => Object.assign({ headers: Object.assign({ cookie, origin: ORIGIN, 'x-academy-request': '1' }, (extra && extra.headers) || {}) },
                                                      extra && extra.method ? { method: extra.method } : {});
const LUID = { [L_TM_HQ]: U(1), [L_TM_BR]: U(2), [L_PLAIN]: U(3), [L_CLOSED]: U(4), [L_ENDED]: U(5), [L_STAFF]: U(6), [L_OTHER]: U(7) };
const w0 = null;
const as = id => cookieFor(w0, id, LUID[id]);
for (const id of Object.keys(LUID)) as(id);
cookieFor(null, L_PLAIN, U(9));

(async () => {
  // ---------- 1. sign-in refusals ----------
  await t('no token: the admin API refuses every action', async () => {
    const w = world(); const m = mod(w, 'academy-admin-api.js');
    for (const action of ['whoami', 'anything', 'list_learners']) assert.strictEqual((await call(m, { action })).status, 401, action);
  });
  await t('the public key used as a token, an expired or a forged token: refused', async () => {
    const w = world(); const m = mod(w, 'academy-admin-api.js');
    for (const token of ['anon', 'expired-token', 'eyJhbGciOiJIUzI1NiJ9.forged.sig']) assert.strictEqual((await call(m, { action: 'whoami' }, { token })).status, 401, token);
  });
  await t('no session cookie: the learner API refuses', async () => {
    const w = world(); const m = mod(w, 'academy-api.js');
    assert.strictEqual((await call(m, { action: 'me' }, learnerOpts(''))).status, 401);
  });
  await t('tampered, expired, wrong-secret and malformed session cookies are refused', async () => {
    const w = world(); const S = mod(w, '_academy_session.js'); const m = mod(w, 'academy-api.js');
    const good = S.issue(L_PLAIN, U(3)); const [p, s] = good.split('.');
    const tampered = Buffer.from(JSON.stringify({ v: 1, sub: L_TM_HQ, uid: U(1), iat: 1, exp: 9999999999 })).toString('base64url') + '.' + s;
    const expired = S.issue(L_PLAIN, U(3), Date.now() - 9 * 3600 * 1000);
    const otherSecret = mod(w, '_academy_session.js', { ACADEMY_SESSION_SECRET: 'another-secret-0123456789-abcdefghijklmnop' }).issue(L_PLAIN, U(3));
    const m2 = mod(w, 'academy-api.js');
    for (const v of [tampered, expired, otherSecret, 'garbage', p + '.', '.' + s, good + '.x'])
      assert.strictEqual((await call(m2, { action: 'me' }, learnerOpts(S.COOKIE + '=' + v))).status, 401, v.slice(0, 20));
    assert.strictEqual((await call(m, { action: 'me' }, learnerOpts(S.COOKIE + '=' + good))).status, 200);
  });
  await t('no session secret configured: learner sign-in is unavailable (fails closed), never accepted', async () => {
    const w = world(); const m = mod(w, 'academy-api.js', { ACADEMY_SESSION_SECRET: '' });
    const r = await call(m, { action: 'me' }, learnerOpts(as(L_PLAIN)));
    assert.strictEqual(r.status, 503); assert.strictEqual(mod(w, '_academy_session.js', { ACADEMY_SESSION_SECRET: 'short' }).issue(L_PLAIN, U(3)), null);
  });

  // ---------- 2. audience separation ----------
  await t('a learner session is not accepted by the admin API; a staff token is not accepted by the learner API', async () => {
    const w = world();
    assert.strictEqual((await call(mod(w, 'academy-admin-api.js'), { action: 'whoami' }, learnerOpts(as(L_TM_HQ)))).status, 401);
    const r = await call(mod(w, 'academy-api.js'), { action: 'me' }, Object.assign(learnerOpts(''), { token: 'pres' }));
    assert.strictEqual(r.status, 401);
  });
  await t('a Partner 360 dealer token is not an Academy session', async () => {
    const w = world(); const r = await call(mod(w, 'academy-api.js'), { action: 'me' }, Object.assign(learnerOpts(''), { token: 'dealer' }));
    assert.strictEqual(r.status, 401);
  });

  // ---------- 3. switches ----------
  await t('switches off: the learner API and every admin action except whoami are refused', async () => {
    const w = world({}); w.db.app_settings[0].value = { timeline: true };
    assert.strictEqual((await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_PLAIN)))).body.error, 'flag_off');
    const a = mod(w, 'academy-admin-api.js');
    assert.strictEqual((await call(a, { action: 'list_learners' }, { token: 'pres' })).body.error, 'flag_off');
    const who = await call(a, { action: 'whoami' }, { token: 'pres' });
    assert.strictEqual(who.status, 200); assert.strictEqual(who.body.enabled, false);
    assert.ok(Object.values(who.body.switches).every(v => v === false));
  });
  await t('a switch is on only when exactly true; an unreadable switch row means off', async () => {
    const w = world(); w.db.app_settings[0].value = { academy_learner: 'true', academy_admin: 1 };
    assert.strictEqual((await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_PLAIN)))).body.error, 'flag_off');
    const w2 = createWorld(Object.assign(seed(), { failRead: table => table === 'app_settings' ? 500 : 0 }));
    assert.strictEqual((await call(mod(w2, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_PLAIN)))).body.error, 'flag_off');
  });
  await t('the Partner 360 entry answers enabled:false and mints nothing', async () => {
    const w = world(); const h = mod(w, 'academy-handoff.js');
    const s = await call(h, { action: 'status' }, { token: 'dealer', headers: { origin: 'https://hcpsonlineordering.netlify.app' } });
    assert.deepStrictEqual(s.body, { enabled: false });
    for (const action of ['mint', 'redeem']) assert.strictEqual((await call(h, { action }, { token: 'dealer' })).status, 403);
    assert.strictEqual(w.writes.length, 0);
  });

  // ---------- 4. inactive people ----------
  await t('inactive staff, a closed learner, an HCPS staff email as a learner (D6): refused', async () => {
    const w = world();
    assert.strictEqual((await call(mod(w, 'academy-admin-api.js'), { action: 'whoami' }, { token: 'old' })).status, 401);
    assert.strictEqual((await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_CLOSED)))).status, 401);
    assert.strictEqual((await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_STAFF)))).status, 401);
  });
  await t('a session issued for one login cannot be used once the learner record points at another login', async () => {
    const w = world(); const c = cookieFor(w, L_PLAIN, U(9));
    assert.strictEqual((await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(c))).status, 401);
  });
  await t('an ended membership gives no dealership: the learner sees no memberships and manages nobody', async () => {
    const w = world(); const r = await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_ENDED)));
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.memberships, []);
    const A = mod(w, '_academy.js'); const actor = await A.learnerActor({ headers: { cookie: as(L_ENDED) } });
    assert.strictEqual((await A.dealerScope(actor)).ids.size, 0);
  });

  // ---------- 5. dealer and branch isolation ----------
  await t('ISOLATION: a head-office Training Manager reaches the head office and its branch, nothing else', async () => {
    const w = world(); const A = mod(w, '_academy.js'); const a = await A.learnerActor({ headers: { cookie: as(L_TM_HQ) } });
    const s = await A.dealerScope(a);
    assert.deepStrictEqual([...s.ids].sort(), [HQ, BR].sort()); assert.strictEqual(s.all, false);
    assert.strictEqual(await A.canSeeDealer(a, OTHER), false); assert.strictEqual(await A.canSeeDealer(a, REP_DEALER), false);
  });
  await t('ISOLATION: a branch Training Manager reaches the branch only, never the head office (D3)', async () => {
    const w = world(); const A = mod(w, '_academy.js'); const a = await A.learnerActor({ headers: { cookie: as(L_TM_BR) } });
    assert.deepStrictEqual([...(await A.dealerScope(a)).ids], [BR]);
    assert.strictEqual(await A.canSeeDealer(a, HQ), false); assert.strictEqual(await A.canSeeDealer(a, OTHER), false);
  });
  await t('ISOLATION: a plain learner manages no dealership, even their own', async () => {
    const w = world(); const A = mod(w, '_academy.js'); const a = await A.learnerActor({ headers: { cookie: as(L_PLAIN) } });
    assert.strictEqual((await A.dealerScope(a)).ids.size, 0); assert.strictEqual(await A.canSeeDealer(a, HQ), false);
    await assert.rejects(A.requireDealer(a, HQ), e => e.status === 403);
  });
  await t('ISOLATION: a rep reaches exactly their book (with its family); Relations and the president reach all', async () => {
    const w = world(); const A = mod(w, '_academy.js');
    const greg = await A.staffActor({ headers: { authorization: 'Bearer greg' } });
    const s = await A.dealerScope(greg);
    assert.deepStrictEqual([...s.ids].sort(), [HQ, BR, REP_DEALER].sort()); assert.strictEqual(await A.canSeeDealer(greg, OTHER), false);
    for (const tok of ['lori', 'pres']) assert.strictEqual((await A.dealerScope(await A.staffActor({ headers: { authorization: 'Bearer ' + tok } }))).all, true);
  });
  await t('scores: admin everywhere, a Training Manager for their own dealership, never reps or Relations', async () => {
    const w = world(); const A = mod(w, '_academy.js');
    const st = async tok => A.staffActor({ headers: { authorization: 'Bearer ' + tok } });
    assert.strictEqual(await A.canSeeScores(await st('pres'), OTHER), true);
    assert.strictEqual(await A.canSeeScores(await st('greg'), HQ), false);
    assert.strictEqual(await A.canSeeScores(await st('lori'), HQ), false);
    const tm = await A.learnerActor({ headers: { cookie: as(L_TM_HQ) } });
    assert.strictEqual(await A.canSeeScores(tm, BR), true); assert.strictEqual(await A.canSeeScores(tm, OTHER), false);
  });
  await t('a learner id or dealer id placed in the request cannot widen access', async () => {
    const w = world();
    const r = await call(mod(w, 'academy-api.js'), { action: 'me', learner_id: L_TM_HQ, dealer_id: OTHER, role: 'training_manager' }, learnerOpts(as(L_PLAIN)));
    assert.strictEqual(r.body.learner.id, L_PLAIN); assert.deepStrictEqual(r.body.memberships.map(m => m.dealer_id), [HQ]);
  });

  // ---------- 6. strict reads ----------
  await t('an unreadable learner, membership or staff table gives 503, never an empty answer or a sign-in', async () => {
    for (const bad of ['academy_learners', 'academy_memberships', 'staff_users']) {
      const w = createWorld(Object.assign(seed(), { failRead: table => table === bad ? 500 : 0 }));
      assert.strictEqual((await call(mod(w, 'academy-api.js'), { action: 'me' }, learnerOpts(as(L_PLAIN)))).status, 503, bad);
    }
    const w = createWorld(Object.assign(seed(), { failRead: table => table === 'staff_users' ? 500 : 0 }));
    assert.strictEqual((await call(mod(w, 'academy-admin-api.js'), { action: 'whoami' }, { token: 'pres' })).status, 503);
  });
  await t('an unreadable dealer table while scoping gives 503 (rep and Training Manager)', async () => {
    const w = createWorld(Object.assign(seed(), { failRead: table => table === 'dealers' ? 500 : 0 }));
    const A = mod(w, '_academy.js');
    await assert.rejects(A.dealerScope(await A.staffActor({ headers: { authorization: 'Bearer greg' } })), e => e.status === 503);
    await assert.rejects(A.dealerScope(await A.learnerActor({ headers: { cookie: as(L_TM_HQ) } })), e => e.status === 503);
  });

  // ---------- 7. audit ----------
  await t('audit: one academy_events row with who, what, before and after; secrets are never written', async () => {
    const w = world(); const A = mod(w, '_academy.js');
    const greg = await A.staffActor({ headers: { authorization: 'Bearer greg' } });
    const ok = await A.audit(greg, 'academy_invites', 'i1', 'invite', null, { email: 'a@b.c', token: 'SECRET-TOKEN', nested: { code_hash: 'abc', password: 'pw' } });
    assert.strictEqual(ok, true); const ev = w.db.academy_events;
    assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].actor, 'staff:greg@hcps.us'); assert.strictEqual(ev[0].actor_type, 'staff');
    const txt = JSON.stringify(ev[0]); assert.ok(!/SECRET-TOKEN|abc"|"pw"/.test(txt), txt);
  });
  await t('a failed audit write is reported (false + logged), never thrown away silently', async () => {
    const w = createWorld(Object.assign(seed(), { failWrite: (m, table) => table === 'academy_events' ? 500 : 0 }));
    const A = mod(w, '_academy.js'); const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
    try { assert.strictEqual(await A.audit(null, 'x', '1', 'y', null, {}), false); } finally { console.error = orig; }
    assert.ok(logs.some(l => /audit write failed/.test(l)));
  });

  // ---------- 8. responses, input, cross-site ----------
  await t('responses are never cached and carry nosniff; only allow-listed origins are echoed', async () => {
    const w = world(); const m = mod(w, 'academy-admin-api.js');
    const ok = await m.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer pres', origin: ORIGIN }, body: '{"action":"whoami"}' });
    assert.strictEqual(ok.headers['cache-control'], 'no-store'); assert.strictEqual(ok.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(ok.headers['access-control-allow-origin'], ORIGIN);
    const evil = await m.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer pres', origin: 'https://evil.example' }, body: '{"action":"whoami"}' });
    assert.strictEqual(evil.headers['access-control-allow-origin'], undefined);
    const h = mod(w, 'academy-handoff.js');
    assert.strictEqual((await h.handler({ httpMethod: 'GET', headers: { origin: 'https://hcpsonlineordering.netlify.app' }, queryStringParameters: { action: 'status' } })).headers['access-control-allow-origin'], 'https://hcpsonlineordering.netlify.app');
    assert.strictEqual((await m.handler({ httpMethod: 'GET', headers: { origin: 'https://hcpsonlineordering.netlify.app', authorization: 'Bearer pres' }, queryStringParameters: { action: 'whoami' } })).headers['access-control-allow-origin'], undefined);
  });
  await t('an oversized body gives 413; unreadable JSON gives 400; bad ids are refused', async () => {
    const w = world(); const m = mod(w, 'academy-admin-api.js');
    const big = await m.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer pres' }, body: JSON.stringify({ action: 'whoami', pad: 'x'.repeat(300 * 1024) }) });
    assert.strictEqual(big.statusCode, 413);
    assert.strictEqual((await m.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer pres' }, body: '{nope' })).statusCode, 400);
    const A = mod(w, '_academy.js'); assert.throws(() => A.uuid('1; drop table', 'learner'), e => e.status === 400);
    assert.throws(() => A.oneOf('owner', ['learner', 'training_manager']), e => e.status === 400);
  });
  await t('cross-site: a cookie request without the Academy header, or from another origin, is refused', async () => {
    const w = world(); const m = mod(w, 'academy-api.js'); const c = as(L_PLAIN);
    assert.strictEqual((await call(m, { action: 'me' }, { headers: { cookie: c, origin: ORIGIN } })).status, 403);
    assert.strictEqual((await call(m, { action: 'me' }, { headers: { cookie: c, origin: 'https://evil.example', 'x-academy-request': '1' } })).status, 403);
    assert.strictEqual((await call(m, { action: 'me' }, { headers: { cookie: c, 'x-academy-request': '1' } })).status, 403);
    assert.strictEqual((await m.handler({ httpMethod: 'GET', headers: { cookie: c }, queryStringParameters: { action: 'me' } })).statusCode, 200);
  });
  await t('nothing internal leaks: an unexpected error returns a plain 500 and logs no secret', async () => {
    const w = createWorld(Object.assign(seed(), {}));
    const m = mod(w, 'academy-admin-api.js'); const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.map(String).join(' '));
    // An unexpected failure (not one the Academy anticipated): the sign-in service answers with unreadable data.
    const saved = global.fetch; global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('leak svc ' + process.env.SUPABASE_SERVICE_ROLE); }, text: async () => '' });
    let r; try { r = await call(m, { action: 'whoami' }, { token: 'pres' }); } finally { global.fetch = saved; console.error = orig; }
    assert.strictEqual(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('svc'), JSON.stringify(r.body));
    assert.ok(!logs.join('\n').includes(process.env.SUPABASE_SERVICE_ROLE || 'svc-unset'), logs.join('|'));
  });

  await t('GET can only read: a GET that names any other action, or another method, is refused (review C1)', async () => {
    const w = world(); const m = mod(w, 'academy-api.js'); const c = as(L_PLAIN);
    m._actions.submit_attempt = async () => ({ statusCode: 200, body: '{"changed":true}' });
    const g = await m.handler({ httpMethod: 'GET', headers: { cookie: c }, queryStringParameters: { action: 'submit_attempt' } });
    assert.strictEqual(g.statusCode, 405);
    assert.strictEqual((await m.handler({ httpMethod: 'PUT', headers: { cookie: c, origin: ORIGIN, 'x-academy-request': '1' }, body: '{"action":"me"}' })).statusCode, 405);
    assert.strictEqual((await call(m, { action: 'submit_attempt' }, learnerOpts(c))).status, 200);
  });

  // ---------- 9. the session value ----------
  await t('the session cookie is HttpOnly, Secure, SameSite=Strict, host-only (__Host-), 8 hours', async () => {
    const w = world(); const S = mod(w, '_academy_session.js'); const c = S.setCookie('v');
    assert.ok(c.startsWith('__Host-hcps_academy=v; Path=/;')); for (const f of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=28800']) assert.ok(c.includes(f), f);
    assert.ok(!/Domain=/i.test(c)); assert.ok(S.clearCookie().includes('Max-Age=0'));
    const v = S.issue(L_PLAIN, U(3)); const claims = S.verify(v);
    assert.strictEqual(claims.learner_id, L_PLAIN); assert.strictEqual(claims.exp - claims.iat, 28800);
    assert.notStrictEqual(S.issue(L_PLAIN, U(3)), v, 'each session value is unique');
  });

  // ---------- 10. audited operations ----------
  await t('audited operations: database refusals map to plain answers; "not installed" is 503, never a silent success', async () => {
    const w = world(); const A = mod(w, '_academy.js');
    const cases = [[{ code: '22023', message: 'academy: a rejection needs a note' }, 400, 'refused'], [{ code: 'P0002' }, 404, 'not_found'],
                   [{ code: '42501' }, 403, 'forbidden'], [{ code: '23505' }, 409, 'conflict'], [{ code: 'PGRST202' }, 503, 'not_installed'], [{ code: 'XX000' }, 502, 'write_failed']];
    const saved = global.fetch;
    try {
      for (const [bodyOut, status, code] of cases) {
        global.fetch = async (url) => { assert.ok(String(url).startsWith(BASE + '/rest/v1/rpc/academy_op_')); return { ok: false, status: status === 503 ? 404 : 400, text: async () => JSON.stringify(bodyOut) }; };
        await assert.rejects(A.op('review_external_cert', {}), e => e.status === status && e.code === code, code);
      }
      global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"status":"verified"}' });
      assert.deepStrictEqual(await A.op('review_external_cert', {}), { status: 'verified' });
      await assert.rejects(A.op('x; drop', {}), e => e.status === 500);
    } finally { global.fetch = saved; }
  });

  await t('canonical host: Academy redirects end on www (the primary domain) and can never loop', async () => {
    const toml = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify.toml'), 'utf8');
    const rules = toml.split('[[redirects]]').slice(1).map(b => ({ from: (b.match(/from\s*=\s*"([^"]+)"/) || [])[1] || '', to: (b.match(/to\s*=\s*"([^"]+)"/) || [])[1] || '' }))
      .filter(r => /\/academy/.test(r.from + r.to));
    assert.deepStrictEqual(rules, [{ from: 'https://homecareproviderservices.netlify.app/academy/*', to: 'https://www.homecareproviderservices.org/academy/:splat' }]);
    // Netlify already sends the bare domain to www; nothing may send www (or anything) back to the bare domain.
    assert.ok(!/to\s*=\s*"https:\/\/homecareproviderservices\.org/.test(toml), 'a rule targets the bare domain (loop with the primary-domain redirect)');
  });

  done('academy-a2a');
})();
