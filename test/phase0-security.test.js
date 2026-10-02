/* Phase 0B security tests. Each test runs the REAL handler file against the fake world in
   mock.js. Written before the fixes, so a run against the old code shows which ones catch
   the reported holes; after the fixes every one must pass. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done, ORDER_REPO } = require('./phase0-mock');

const SETTINGS = [
  { key: 'handout', value: { ordering_url: 'https://order.test', updates: ['New line'], internal_note: 'do not show' } },
  { key: 'zoho_auth', value: { refresh_token: 'ZOHO-SECRET', api_domain: 'x' } },
  { key: 'commission_splits', value: { 'greg campbell': { rep_pct: 40 } } },
];

(async () => {
  /* ───────────── 0B.1 settings allowlist ───────────── */
  await t('0B.1 a rep cannot read the Zoho refresh token', async () => {
    const w = createWorld(standardSeed({ app_settings: SETTINGS }));
    const m = load('routes-api.js', w);
    const r = await call(m, { action: 'get_settings', key: 'zoho_auth' }, { token: 'greg' });
    assert.notStrictEqual(r.status, 200, 'zoho_auth must not be readable: ' + JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('ZOHO-SECRET'), 'secret leaked');
  });
  await t('0B.1 even the president cannot pull credentials through get_settings', async () => {
    const w = createWorld(standardSeed({ app_settings: SETTINGS }));
    const m = load('routes-api.js', w);
    const r = await call(m, { action: 'get_settings', key: 'zoho_auth' }, { token: 'pres' });
    assert.ok(!JSON.stringify(r.body).includes('ZOHO-SECRET'), 'secret leaked to president via settings read');
  });
  await t('0B.1 a rep cannot read commission splits or any unlisted key', async () => {
    const w = createWorld(standardSeed({ app_settings: SETTINGS }));
    const m = load('routes-api.js', w);
    for (const key of ['commission_splits', 'automation_config', 'anything']) {
      const r = await call(m, { action: 'get_settings', key }, { token: 'greg' });
      assert.strictEqual(r.status, 403, key + ' should be refused, got ' + r.status);
    }
  });
  await t('0B.1 handout settings still load for a rep, with only the public fields', async () => {
    const w = createWorld(standardSeed({ app_settings: SETTINGS }));
    const m = load('routes-api.js', w);
    const r = await call(m, { action: 'get_settings', key: 'handout' }, { token: 'greg' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.value, { ordering_url: 'https://order.test', updates: ['New line'] });
  });
  await t('0B.1 set_settings writes only allowlisted keys, president only', async () => {
    const w = createWorld(standardSeed({ app_settings: SETTINGS }));
    const m = load('routes-api.js', w);
    let r = await call(m, { action: 'set_settings', key: 'zoho_auth', value: { refresh_token: 'evil' } }, { token: 'pres' });
    assert.strictEqual(r.status, 403, 'credentials must not be writable through the handout editor');
    assert.strictEqual(w.db.app_settings.find(x => x.key === 'zoho_auth').value.refresh_token, 'ZOHO-SECRET');
    r = await call(m, { action: 'set_settings', key: 'handout', value: { ordering_url: 'https://new.test', updates: ['a'] } }, { token: 'greg' });
    assert.strictEqual(r.status, 403);
    r = await call(m, { action: 'set_settings', key: 'handout', value: { ordering_url: 'https://new.test', updates: ['a'], junk: 1 } }, { token: 'pres' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(w.db.app_settings.find(x => x.key === 'handout').value, { ordering_url: 'https://new.test', updates: ['a'] });
  });

  /* ───────────── 0B.2 passcode fails closed ───────────── */
  for (const fn of ['geocode-api.js', 'territory-api.js']) {
    await t(`0B.2 ${fn}: no token and no ANALYTICS_TOKEN is refused`, async () => {
      const w = createWorld(standardSeed()); const m = load(fn, w, { ANALYTICS_TOKEN: undefined });
      const r = await call(m, null, { method: 'GET' });
      assert.strictEqual(r.status, 401, 'anonymous request got ' + r.status);
    });
    await t(`0B.2 ${fn}: a wrong passcode is refused whether or not the variable is set`, async () => {
      let w = createWorld(standardSeed()); let m = load(fn, w, { ANALYTICS_TOKEN: undefined });
      let r = await call(m, null, { method: 'GET', headers: { 'x-analytics-token': 'guess' } });
      assert.strictEqual(r.status, 401, 'unset variable + any passcode got ' + r.status);
      w = createWorld(standardSeed()); m = load(fn, w, { ANALYTICS_TOKEN: 'right' });
      r = await call(m, null, { method: 'GET', headers: { 'x-analytics-token': 'wrong' } });
      assert.strictEqual(r.status, 401);
      r = await call(m, null, { method: 'GET' });
      assert.strictEqual(r.status, 401, 'missing header with variable set');
    });
    await t(`0B.2 ${fn}: the correct passcode and a staff sign-in still work`, async () => {
      let w = createWorld(standardSeed()); let m = load(fn, w, { ANALYTICS_TOKEN: 'right' });
      let r = await call(m, null, { method: 'GET', headers: { 'x-analytics-token': 'right' } });
      assert.strictEqual(r.status, 200, 'correct passcode got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
      w = createWorld(standardSeed()); m = load(fn, w, { ANALYTICS_TOKEN: undefined });
      r = await call(m, null, { method: 'GET', token: 'pres' });
      assert.strictEqual(r.status, 200, 'president sign-in got ' + r.status);
    });
  }
  await t('0B.2 ordering-site dealers-api and home-api refuse when the variable is unset', async () => {
    for (const fn of ['dealers-api.js', 'home-api.js']) {
      const w = createWorld(standardSeed()); const m = load(fn, w, { ANALYTICS_TOKEN: undefined }, ORDER_REPO);
      const r = await call(m, null, { method: 'GET' });
      assert.strictEqual(r.status, 401, fn + ' anonymous got ' + r.status);
    }
  });

  /* ───────────── 0B.3 staff first sign-in ───────────── */
  const newStaff = { email: 'new@hcps.us', name: 'New Rep', role: 'rep', rep_name: 'New Rep', active: true };
  await t('0B.3 an unclaimed staff account cannot be claimed by guessing a password', async () => {
    const w = createWorld(standardSeed({ staff_users: [newStaff] }));
    const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'login', email: 'new@hcps.us', password: 'attacker-chosen-pw' });
    assert.ok(!r.body.ok, 'login must fail: ' + JSON.stringify(r.body));
    assert.ok(!w.authUsers.has('new@hcps.us'), 'no login may be created from the sign-in form');
  });
  await t('0B.3 existing staff still sign in normally', async () => {
    const w = createWorld(standardSeed()); const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'login', email: 'greg@hcps.us', password: 'pw-greg-1' });
    assert.ok(r.body.ok && r.body.token, JSON.stringify(r.body));
    assert.strictEqual(r.body.profile.role, 'rep');
  });
  await t('0B.3 a failed staff lookup never bootstraps a president', async () => {
    const S = standardSeed(); S.missingTables = ['staff_users'];
    const w = createWorld(S); const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'login', email: 'greg@hcps.us', password: 'pw-greg-1' });
    assert.ok(!(r.body && r.body.ok), 'must not sign in when staff_users cannot be read');
    assert.ok(!w.writes.some(x => x.table === 'staff_users' && x.kind !== 'patch'), 'no staff row may be created');
  });
  await t('0B.3 an empty staff table does not make the first signer-in a president', async () => {
    const S = standardSeed(); S.tables.staff_users = [];
    const w = createWorld(S); const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'login', email: 'greg@hcps.us', password: 'pw-greg-1' });
    assert.ok(!(r.body && r.body.ok), 'must not sign in: ' + JSON.stringify(r.body));
    assert.strictEqual(w.db.staff_users.length, 0, 'no president may be created');
  });
  await t('0B.3 bootstrap works only for the address in STAFF_BOOTSTRAP_EMAIL', async () => {
    const S = standardSeed(); S.tables.staff_users = [];
    const w = createWorld(S); const m = load('staff-auth.js', w, { STAFF_BOOTSTRAP_EMAIL: 'angelo@hcps.us' });
    const r = await call(m, { action: 'login', email: 'angelo@hcps.us', password: 'pw-angelo-1' });
    assert.ok(r.body.ok, JSON.stringify(r.body));
    assert.strictEqual(r.body.profile.role, 'president');
  });
  await t('0B.3 adding a staff member sends a secure setup link and never exposes a password', async () => {
    const w = createWorld(standardSeed()); const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'add_user', email: 'new@hcps.us', name: 'New Rep', role: 'rep', rep_name: 'New Rep' }, { token: 'pres' });
    assert.ok(r.body.ok, JSON.stringify(r.body));
    assert.ok(w.db.staff_users.find(s => s.email === 'new@hcps.us'), 'staff row');
    const link = w.writes.find(x => x.kind === 'link' && x.email === 'new@hcps.us');
    assert.ok(link, 'a setup link must be minted');
    assert.strictEqual(link.redirect, 'https://homecareproviderservices.netlify.app/admin/reset.html', 'fixed redirect only');
    const mail = w.outbound.find(x => x.kind === 'resend' && JSON.stringify(x.body.to).includes('new@hcps.us'));
    assert.ok(mail, 'the link must be emailed to the new staff member');
    const created = w.writes.find(x => x.kind === 'auth_create' && x.email === 'new@hcps.us');
    assert.ok(created && created.password && created.password.length >= 32, 'login created with a long random password');
    assert.ok(!JSON.stringify(r.body).includes(created.password) && !JSON.stringify(r.body).includes('link.test'), 'response must not carry the password or the link');
  });
  await t('0B.3 a rep cannot add staff', async () => {
    const w = createWorld(standardSeed()); const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'add_user', email: 'x@hcps.us', role: 'president' }, { token: 'greg' });
    assert.strictEqual(r.status, 403);
  });
  await t('0B.3 president reset uses the fixed HCPS link, ignoring a supplied redirect', async () => {
    const w = createWorld(standardSeed()); const m = load('staff-auth.js', w);
    const r = await call(m, { action: 'send_reset', email: 'greg@hcps.us', redirect_to: 'https://evil.test/steal' }, { token: 'pres' });
    assert.ok(r.body.ok, JSON.stringify(r.body));
    const link = w.writes.find(x => x.kind === 'link' && x.email === 'greg@hcps.us');
    assert.ok(link && link.redirect === 'https://homecareproviderservices.netlify.app/admin/reset.html', 'redirect: ' + (link && link.redirect));
    assert.ok(!w.writes.some(x => x.kind === 'supabase_recover' && /evil/.test(x.url)), 'client redirect must not be used');
  });
  await t('0B.3 public forgot-password ignores a supplied redirect and stays generic', async () => {
    const w = createWorld(standardSeed()); const m = load('staff-auth.js', w);
    let r = await call(m, { action: 'forgot', email: 'greg@hcps.us', redirect_to: 'https://evil.test' });
    assert.ok(r.body.ok);
    assert.ok(!w.writes.some(x => x.kind === 'supabase_recover' && /evil/.test(x.url)), 'client redirect used');
    const r2 = await call(m, { action: 'forgot', email: 'nobody@nowhere.test' });
    assert.strictEqual(r2.body.message, r.body.message, 'same answer for unknown addresses');
  });

  done('0B security (part 1)');
})();
