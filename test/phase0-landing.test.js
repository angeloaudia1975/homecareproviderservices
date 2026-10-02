/* Phase 0L: one landing rule (staff-auth landingFor -> profile.landing), OFF by default so every
   landing is exactly today's; the sign-in pages follow it and accept only a same-site /admin/ path. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, load, call, standardSeed, t, done, adminSrc } = require('./phase0-mock');

const login = async (w, who) => (await call(load('staff-auth.js', w), { action: 'login', email: who + '@hcps.us', password: 'pw-' + who + '-1' })).body;
function world(setting) {
  const S = standardSeed(setting === undefined ? {} : { app_settings: [{ key: 'rep_landing', value: setting }] });
  S.authUsers.push('pat@hcps.us'); S.passwords['pat@hcps.us'] = 'pw-pat-1';
  S.tables.staff_users.push({ email: 'pat@hcps.us', name: 'Pat Rep', role: 'rep', rep_name: 'Pat Rep', active: true });
  return createWorld(S);
}
const CC = '/admin/command-center.html';

(async () => {
  await t('0L with no setting every landing is today\'s', async () => {
    const w = world();
    assert.strictEqual((await login(w, 'angelo')).profile.landing, '/admin/');
    assert.strictEqual((await login(w, 'greg')).profile.landing, '/admin/rep-home.html');
    assert.strictEqual((await login(w, 'lori')).profile.landing, '/admin/rep-home.html');
  });
  await t('0L "off" keeps today\'s landing even with a URL filled in', async () => {
    const w = world({ mode: 'off', url: CC });
    assert.strictEqual((await login(w, 'greg')).profile.landing, '/admin/rep-home.html');
  });
  await t('0L a pilot sends only the listed reps; "on" sends every rep; management and Relations never move', async () => {
    let w = world({ mode: 'pilot', url: CC, emails: ['GREG@hcps.us'] });
    assert.strictEqual((await login(w, 'greg')).profile.landing, CC);
    assert.strictEqual((await login(w, 'pat')).profile.landing, '/admin/rep-home.html');
    w = world({ mode: 'on', url: CC });
    assert.strictEqual((await login(w, 'greg')).profile.landing, CC);
    assert.strictEqual((await login(w, 'pat')).profile.landing, CC);
    assert.strictEqual((await login(w, 'angelo')).profile.landing, '/admin/');
    assert.strictEqual((await login(w, 'lori')).profile.landing, '/admin/rep-home.html');
  });
  await t('0L only a same-site /admin/ page is accepted as a landing', async () => {
    for (const url of ['https://evil.test/x', '//evil.test', '/admin/../reset.html', 'javascript:alert(1)', '/elsewhere.html']) {
      const w = world({ mode: 'on', url });
      assert.strictEqual((await login(w, 'greg')).profile.landing, '/admin/rep-home.html', url);
    }
  });
  await t('0L session refresh and "me" carry the same landing', async () => {
    const w = world({ mode: 'on', url: CC });
    const me = await call(load('staff-auth.js', w), { action: 'me' }, { token: 'greg' });
    assert.strictEqual(me.body.profile.landing, CC);
  });

  /* The pages: lifted from the shipped HTML. */
  const ADMIN = path.join(__dirname, '..', 'src', 'admin');
  const src = f => adminSrc(f);
  await t('0L rep-login follows profile.landing and refuses anything off-site', async () => {
    const m = src('rep-login.html').match(/function landingOf\(p\)\{[^\n]*\}/); assert.ok(m, 'landingOf not found');
    const landingOf = new Function(m[0] + '; return landingOf;')();
    assert.strictEqual(landingOf({ landing: CC }), CC);
    assert.strictEqual(landingOf({ landing: 'https://evil.test' }), null);
    assert.strictEqual(landingOf({ landing: '/admin/../x' }), null);
    assert.strictEqual(landingOf({}), null);
    assert.ok(/location\.replace\(landingOf\(j\.profile\)\|\|/.test(src('rep-login.html')), 'sign-in does not use the landing');
  });
  await t('0L the /admin/ dashboard sends a sales rep and Relations to their landing; only management stays', async () => {
    const m = src('index.html').match(/function repLanding\(\)\{[\s\S]*?\n\}/); assert.ok(m, 'repLanding not found');
    const make = me => new Function('ME', m[0] + '; return repLanding();')(me);
    assert.strictEqual(make({ role: 'rep' }), '/admin/rep-home.html');
    assert.strictEqual(make({ role: 'rep', landing: CC }), CC);
    assert.strictEqual(make({ role: 'rep', landing: 'https://evil.test' }), '/admin/rep-home.html');
    assert.strictEqual(make({ role: 'president', landing: '/admin/' }), null);
    assert.strictEqual(make({ role: 'relations' }), '/admin/rep-home.html');
    assert.strictEqual(make({ role: 'relations', landing: '/admin/rep-home.html' }), '/admin/rep-home.html');
    assert.strictEqual(make({ role: 'Relations', landing: '/admin/' }), '/admin/rep-home.html', 'Relations must never stay on the Admin dashboard');
    for (const role of ['president', 'admin', 'owner']) assert.strictEqual(make({ role }), null, role + ' must keep the Admin dashboard');
    assert.ok(/function showApp\(\)\{\s*const away=repLanding\(\); if\(away\)\{ location\.replace\(away\); return; \}/.test(src('index.html')), 'showApp does not check first');
  });

  done('0L landing preparation');
})();
