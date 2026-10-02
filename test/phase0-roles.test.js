/* Phase 0K: the Relations policy, end to end, against the real handlers.
   Relations (Lori) works EVERY dealer and the marketing tools, with NO management powers and only
   her own performance and pay. The president is the control; Greg (rep) stays fenced. */
const assert = require('assert');
const vm = require('vm');
const { createWorld, load, call, standardSeed, t, done, adminSrc } = require('./phase0-mock');

function seed() {
  const S = standardSeed({
    dealer_tasks: [{ id: 't1', dealer_id: 'd-ang', title: 'x', status: 'open', priority: 'normal', assigned_rep: 'Angelo Audia' }],
    opportunities: [{ id: 'o1', dealer_id: 'd-ang', title: 'RMS deal', stage: 'identified', status: 'open', owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us', value: 100 }],
    dealer_engagement: ['d-greg', 'd-ang', 'd-none', 'd-dir-greg'].map(id => ({ dealer_id: id, status: 'watch', score: 50, rep_name: '', total_sales: 1 })),
    dealer_intent: ['d-greg', 'd-ang', 'd-none'].map(id => ({ dealer_id: id, score_total: 50, tier: 'high', top_manufacturer: 'golden' })),
    monthly_sales: [
      { id: 1, dealer_id: 'd-ang', manufacturer: 'golden', period: '2026-08-01', amount: 100, commission: 10, customer_name: 'Retail Medical Solutions' },
      { id: 2, dealer_id: 'd-greg', manufacturer: 'golden', period: '2026-08-01', amount: 50, commission: 5, customer_name: 'Glasgow Prescription Center' }],
    email_messages: [{ id: 'm-un', dealer_id: null, from_address: 'stranger@x.test', mailbox_upn: 'angelo@hcps.us', direction: 'inbound', received_at: '2026-09-01' }],
    call_outcomes: [{ outcome: 'reached', angle: 'reorder', manufacturer: 'golden', call_hour: 9, rep_name: 'Angelo Audia', rep_email: 'angelo@hcps.us', called_at: '2026-09-01' }],
    manufacturers: [{ slug: 'golden', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'commission_splits', value: { 'greg campbell': { rep_pct: 40 } } }],
  });
  return S;
}
const W = () => createWorld(seed());
const ALL = ['d-ang', 'd-dir-greg', 'd-greg', 'd-greg-branch', 'd-none'];

(async () => {
  /* ── what Relations HAS ── */
  await t('0K Relations: Dealer 360, notes and contacts on any dealer', async () => {
    const w = W();
    for (const id of ALL) assert.strictEqual((await call(load('crm-api.js', w), { action: 'list', dealer_id: id }, { token: 'lori' })).status, 200, id);
    const r = await call(load('crm-api.js', w), { action: 'add_note', dealer_id: 'd-ang', body: 'Spoke with the buyer' }, { token: 'lori' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });
  await t('0K Relations: Command Center 360 shows every dealer, and the rep selector works', async () => {
    const w = W();
    let r = await call(load('command360-api.js', w), { action: 'summary' }, { token: 'lori' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.penetration.total, ALL.length, 'Lori sees ' + r.body.penetration.total);
    assert.strictEqual(r.body.email_unmatched.messages, 0, 'unmatched-email review is management\'s');
    const p = await call(load('command360-api.js', w), { action: 'summary' }, { token: 'pres' });
    assert.strictEqual(p.body.email_unmatched.messages, 1, 'the president still sees it');
    r = await call(load('command360-api.js', w), { action: 'summary', rep: 'Greg Campbell' }, { token: 'lori' });
    assert.ok(r.body.penetration.total >= 1 && r.body.penetration.total < ALL.length, 'rep view total ' + r.body.penetration.total);
    const g = await call(load('command360-api.js', w), { action: 'summary', rep: 'Angelo Audia' }, { token: 'greg' });
    assert.ok(!g.body.dealers.some(d => d.id === 'd-ang'), 'a rep must not use the selector to see another book');
  });
  await t('0K Relations: the marketing list covers every dealer', async () => {
    const w = W();
    const r = await call(load('marketing-api.js', w), { action: 'today' }, { token: 'lori' });
    const ids = new Set((r.body.opportunities || []).map(o => o.dealer_id));
    for (const id of ['d-greg', 'd-ang', 'd-none']) assert.ok(ids.has(id), 'missing ' + id);
  });
  await t('0K Relations: Audiences, Campaign Studio and CardChamp open', async () => {
    const w = W();
    for (const [fn, body] of [['audiences-api.js', { action: 'list' }], ['campaign-api.js', { action: 'list' }], ['partner-api.js', { action: 'report' }]])
      assert.strictEqual((await call(load(fn, w), body, { token: 'lori' })).status, 200, fn);
  });
  await t('0K Relations: Dealer Manager lists every dealer and is READ-ONLY (server-enforced)', async () => {
    const w = W();
    const r = await call(load('dealers-api.js', w), null, { token: 'lori', method: 'GET' });
    assert.strictEqual(r.body.dealers.length, ALL.length);
    const before = JSON.stringify(w.db.dealers);
    const WRITES = [
      { action: 'edit', dealer_id: 'd-ang', phone: '615-000' },
      { action: 'edit', dealer_id: 'd-ang', business_name: 'Renamed Co' },
      { action: 'access', dealer_id: 'd-ang', manufacturers: ['golden'] },
      { action: 'verify_email', dealer_id: 'd-ang' },
      { action: 'rep', dealer_id: 'd-ang', rep_name: 'Lori Hunt' },
      { action: 'create_dealer', business_name: 'New Co', parent_id: 'd-ang' },
      { action: 'set_contract_price', dealer_id: 'd-ang', manufacturer: 'golden', code: 'X', price: 1 },
      { action: 'no_such_action', dealer_id: 'd-ang' } ];
    for (const body of WRITES) {
      const x = await call(load('dealers-api.js', w), body, { token: 'lori' });
      assert.strictEqual(x.status, 403, body.action + ' answered ' + x.status + ' ' + JSON.stringify(x.body).slice(0, 120));
    }
    assert.strictEqual(JSON.stringify(w.db.dealers), before, 'a refused write still changed a dealer row');
    for (const body of [{ action: 'portal_access', dealer_id: 'd-greg' }, { action: 'preview_link', dealer_id: 'd-greg' }]) {
      const x = await call(load('dealers-api.js', w), body, { token: 'lori' });
      assert.notStrictEqual(x.status, 403, body.action + ' (a read) was refused: ' + JSON.stringify(x.body).slice(0, 120));
    }
    const p = await call(load('dealers-api.js', w), { action: 'edit', dealer_id: 'd-ang', phone: '615-000' }, { token: 'pres' });
    assert.strictEqual(p.status, 200, 'the president can still edit: ' + JSON.stringify(p.body).slice(0, 120));
  });
  await t('Dealer settings are management-only: a rep cannot change them even on a dealer in his own book', async () => {
    const w = W();
    const before = JSON.stringify(w.db.dealers), lines = JSON.stringify(w.db.dealer_manufacturers || []);
    for (const body of [
      { action: 'edit', dealer_id: 'd-greg', phone: '615-111' },
      { action: 'edit', dealer_id: 'd-greg', business_name: 'Renamed' },
      { action: 'access', dealer_id: 'd-greg', manufacturers: ['golden'] },
      { action: 'verify_email', dealer_id: 'd-greg' },
      { action: 'rep', dealer_id: 'd-greg', rep_name: 'Greg Campbell' } ]) {
      const x = await call(load('dealers-api.js', w), body, { token: 'greg' });
      assert.strictEqual(x.status, 403, 'rep ' + body.action + ' on own dealer answered ' + x.status);
    }
    assert.strictEqual(JSON.stringify(w.db.dealers), before, 'a refused rep write changed a dealer');
    for (const tok of ['greg', 'lori']) {
      const a = await call(load('crm-api.js', w), { action: 'save_account_ref', dealer_id: 'd-greg', manufacturer: 'golden', account_ref: 'NEW-1' }, { token: tok });
      assert.strictEqual(a.status, 403, tok + ' saved an account number (ordering access): ' + a.status);
    }
    assert.strictEqual(JSON.stringify(w.db.dealer_manufacturers || []), lines, 'a refused account-number save changed ordering access');
    const r = await call(load('dealers-api.js', w), { action: 'portal_access', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.notStrictEqual(r.status, 403, 'reading portal access on his own dealer was refused');
    const p = await call(load('crm-api.js', w), { action: 'save_account_ref', dealer_id: 'd-greg', manufacturer: 'golden', account_ref: 'NEW-1' }, { token: 'pres' });
    assert.strictEqual(p.status, 200, 'the president can still set account numbers: ' + JSON.stringify(p.body).slice(0, 120));
  });
  await t('0K Relations: the Dealer Manager page shows no edit controls to Relations (president unchanged)', async () => {
    const html = adminSrc('dealers.html');
    const detail = role => {
      const body = { innerHTML: '' }; const stub = { textContent: '', className: '', innerHTML: '', value: '', style: {}, classList: { toggle() {} } };
      const ctx = { console, URLSearchParams, setTimeout, clearTimeout, Promise,
        window: { addEventListener() {} }, location: { hash: '', search: '', href: '' },
        HCPS: { profile: () => ({ role, email: role + '@hcps.us' }), token: () => 't' },
        fetch: () => new Promise(() => {}),
        document: { querySelector: s => (s === '#body' ? body : stub), querySelectorAll: () => [], getElementById: () => stub, addEventListener() {}, createElement: () => stub } };
      vm.createContext(ctx);
      vm.runInContext(html.split('<script>\r\n').slice(-1)[0].split('<script>\n').slice(-1)[0].split('</script>')[0], ctx);
      vm.runInContext(`DATA={email_verified_supported:true,manufacturers:[{slug:'golden',name:'Golden'},{slug:'pride',name:'Pride'}],repOptions:['Greg Campbell'],logins:[],mfrName:{},
        dealers:[{id:'d1',name:'Acme Medical',status:'review',email:'buyer@acme.test',email_verified:false,contact_name:'Pat',phone:'1',access:['golden'],buysLines:[],aliases:[],periods:[],accounts:[],addresses:[],
          contacts:[{name:'Pat',email:'buyer@acme.test'},{name:'Sam',email:'sam@acme.test'}],rep:'Greg Campbell',sales:0,comm:0,recs:0,branches:[]}]}; DETAIL='d1'; renderDetail();`, ctx);
      return { html: body.innerHTML, status: vm.runInContext('emailStatus(DATA.dealers[0])', ctx) };
    };
    const lori = detail('relations'), pres = detail('president');
    for (const [what, re] of [['Save details', /saveDetail\(/], ['Save access', /saveAccess\(/], ['Make default', /setDefaultEmail\(/], ['Confirm as new', /confirmNew\(/]]) {
      assert.ok(re.test(pres.html), 'president lost ' + what);
      assert.ok(!re.test(lori.html), 'Relations still sees ' + what);
    }
    assert.ok(/verifyEmail\(/.test(pres.status) && !/verifyEmail\(/.test(lori.status), 'verify link');
    assert.ok(/<input type="checkbox" value="golden" checked disabled/.test(lori.html), 'access boxes not locked for Relations');
    assert.ok(/id="f_business_name"[^>]*readonly/.test(lori.html) && !/id="f_business_name"[^>]*readonly/.test(pres.html), 'detail fields not read-only');
    assert.ok(/id="f_rep"[^>]*readonly/.test(lori.html), 'owner field not read-only');
    assert.ok(/Read-only for Customer Relations/.test(lori.html), 'no read-only notice');
    const d360 = adminSrc('dealer.html');
    assert.ok(/\$\{!isMgmt\(\)\?"":`<button class="btn ghost sm" onclick="editCompany\(\)">/.test(d360), 'Dealer 360 "Edit company info" is not gated on management');
    const mg = d360.match(/const isMgmt=\(\)=>[^\n]*/); assert.ok(mg, 'isMgmt not found');
    const isMgmtFor = role => new Function('ME', mg[0] + '; return isMgmt();')({ role });
    for (const role of ['president', 'admin', 'owner']) assert.strictEqual(isMgmtFor(role), true, role);
    for (const role of ['rep', 'relations', '']) assert.strictEqual(isMgmtFor(role), false, 'Dealer 360 offers dealer settings to ' + (role || 'no role'));
    assert.ok(/\$\{isMgmt\(\)\?`<input id="acct_/.test(d360), 'account-number inputs are not management-only');
  });
  await t('0K Relations: pipeline shows every deal', async () => {
    const w = W();
    const r = await call(load('pipeline-api.js', w), { action: 'board' }, { token: 'lori' });
    assert.ok((r.body.opportunities || []).some(o => o.id === 'o1'));
  });

  /* ── what Relations does NOT have ── */
  const REFUSED = [
    ['staff-auth.js', { action: 'list_users' }, 'user management'],
    ['staff-auth.js', { action: 'add_user', email: 'x@hcps.us', role: 'rep' }, 'adding staff'],
    ['staff-auth.js', { action: 'impersonate', email: 'greg@hcps.us' }, 'View-as'],
    ['platform-api.js', { action: 'set', mode: 'live' }, 'Go Live / platform mode'],
    ['routes-api.js', { action: 'set_settings', key: 'handout', value: { updates: [] } }, 'app settings'],
    ['routes-api.js', { action: 'get_settings', key: 'zoho_auth' }, 'integration secrets'],
    ['zoho-api.js', { action: 'status' }, 'Zoho integration'],
    ['campaign-api.js', { action: 'connect_zoho', code: 'abc' }, 'Zoho Campaigns credentials'],
    ['campaign-api.js', { action: 'save_style_guide', text: 'x' }, 'AI style guide'],
    ['sales-import-api.js', { action: 'preview', rows: [] }, 'sales import'],
    ['commissions-api.js', { action: 'config' }, 'commission import'],
    ['crm-api.js', { action: 'set_automation_config', patch: { engine_enabled: true } }, 'engine configuration'],
    ['crm-api.js', { action: 'run_engine_now' }, 'running the engine'],
    ['dealers-api.js', { action: 'rep', dealer_id: 'd-ang', rep_name: 'Lori Hunt' }, 'rep assignment'],
    ['dealers-api.js', { action: 'merge', ids: ['d-ang', 'd-none'] }, 'merging dealers'],
    ['dealers-api.js', { action: 'import_contacts', rows: [{ company: 'x' }] }, 'contact import'],
    ['email-sync-api.js', { action: 'status' }, 'mailbox sync administration'],
    ['rep-usage-api.js', { action: 'summary' }, 'team usage monitoring'],
    ['ai-usage-api.js', { action: 'summary' }, 'AI spend'],
    ['reps-api.js', { action: 'set_target', rep_name: 'Greg Campbell', year: 2026, target: 1 }, 'setting targets'],
  ];
  await t('0K Relations has no management powers (' + REFUSED.length + ' checks)', async () => {
    const w = W();
    for (const [fn, body, what] of REFUSED) {
      const r = await call(load(fn, w), body, { token: 'lori' });
      assert.ok(r.status === 403 || r.status === 401, `${what} (${fn} ${body.action}) answered ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
    }
  });
  await t('0K Relations sees only her own pay and no team leaderboard', async () => {
    const w = W();
    const a = await call(load('analytics.js', w), null, { token: 'lori', method: 'GET' });
    assert.strictEqual(a.status, 200);
    assert.ok((a.body.facts || []).every(f => f.rep === 'Lori Hunt' || f.comm === 0), 'someone else\'s commission is visible');
    assert.ok((a.body.facts || []).some(f => f.sales > 0), 'company-wide sales should still be there');
    assert.ok(!a.body.commissionSplits, 'the split table is management\'s');
    const s = await call(load('reps-api.js', w), { action: 'scorecards' }, { token: 'lori' });
    assert.ok((s.body.reps || []).every(r => r.rep === 'Lori Hunt'), 'team scorecards leaked: ' + JSON.stringify((s.body.reps || []).map(r => r.rep)));
    const i = await call(load('call-brief-api.js', w), { action: 'insights' }, { token: 'lori' });
    assert.deepStrictEqual(i.body.by_rep, [], 'rep-by-rep call results are team performance');
    const ip = await call(load('call-brief-api.js', w), { action: 'insights' }, { token: 'pres' });
    assert.ok(ip.body.by_rep.length > 0, 'the president still sees them');
  });

  await t('0K the menu: Relations gets the rep workspace plus Dealer Manager and the marketing tools; a rep does not', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'admin', 'admin-chrome.js'), 'utf8');
    const grab = re => { const m = src.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };
    const code = grab(/var REP_TOOLS = \[[\s\S]*?\];/) + grab(/var RELATIONS_TOOLS = \[[\s\S]*?\];/) + grab(/function workspaceTools\(me\)\{[^\n]*\}/);
    const tools = new Function(code + '; return workspaceTools;')();
    const hrefs = role => tools({ role }).map(x => x.href);
    for (const h of ['/admin/dealers.html', '/admin/audiences.html', '/admin/campaigns.html', '/admin/cardchamp.html']) {
      assert.ok(hrefs('relations').includes(h), 'relations menu lacks ' + h); assert.ok(!hrefs('rep').includes(h), 'rep menu has ' + h); }
    assert.ok(!hrefs('relations').some(h => /staff|platform|import|settings/.test(h)), 'a management page in the Relations menu');
  });
  done('0K relations policy');
})();
