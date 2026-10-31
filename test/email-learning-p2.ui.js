/* HCPS Smart Email Learning, Phase 2 — browser QA of the owner page's Learned rules and Versions tabs through the REAL page and
   REAL handlers (mock database, synthetic data only; nothing reaches the network): look for patterns → masked suggestions;
   approve (own wording, reason required) / reject; versions, restore, reset; phone 360 / 390, tablet 768, desktop 1280 fit
   with no sideways scroll and 44px buttons on phones; Greg is refused.
     node test/email-learning-p2.ui.js        (needs Playwright with Chromium; SKIPs without it) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); } }

const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const UA = '0a0a0a0a-0000-4000-8000-00000000000a', UG = '0b0b0b0b-0000-4000-8000-00000000000b';

const FAKE2 = require('./email-learning-p2.fake');
const NAMES = ['Sampletown Medical', 'Exampleville Pharmacy', 'Testburg Home Care'];
const DS = ['0a0a0a0a-0000-4000-8000-00000000000a', '0b0b0b0b-0000-4000-8000-00000000000b', '0c0c0c0c-0000-4000-8000-00000000000c'];
function edited(i) {
  const dn = NAMES[i % 3], who = ['Pat', 'Lee', 'Kim'][i % 3];
  return { id: `${pad(i + 10)}000000-0000-4000-8000-0000000000${pad(i + 10)}`, created_at: `2026-10-${pad(i + 5)}T10:00:00Z`, author_email: 'angelo@hcps.us',
    dealer_id: DS[i % 3], email_type: 'previsit_headsup', template: 'previsit', generator: 'routes-api', sent_at: `2026-10-${pad(i + 5)}T15:00:00Z`, edited: true,
    recipient_count: 1, content_purged_at: null, content_expires_at: '2027-10-01T00:00:00Z',
    original_subject: 'HCPS will be in your area', sent_subject: 'HCPS will be in your area',
    original_body: `Hi ${who},\n\nI hope this email finds you well. I will be at ${dn} on Tuesday to walk through the new lift chairs. Please let me know if you have any questions.\n\nSam Rep\nHCPS`,
    sent_body: `Good morning ${who},\n\nI will be at ${dn} on Tuesday to walk through the new lift chairs. Want me to bring the fall catalog?\n\nSam Rep\nHCPS` };
}
function world() {
  const S = standardSeed({
    dealers: DS.map((id, i) => ({ id, business_name: NAMES[i], rep_name: 'Angelo Audia', rep_email: 'angelo@hcps.us', parent_id: null, state: 'TN' })),
    email_drafts: [edited(0), edited(1), edited(3), edited(4)], email_learning_rules: [], email_learning_profiles: [], email_learning_rule_events: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { email_learning_capture: true } }],
  });
  S.rpc = FAKE2.rpc();
  return createWorld(S);
}
function serve(w) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop(); let raw = ''; for await (const c of req) raw += c;
      const file = path.join(__dirname, '..', 'netlify', 'functions', name + '.js');
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('{}'); return; }
      try {
        const mod = load(name + '.js', w, { ANTHROPIC_API_KEY: 'k' });
        const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
        const r = await mod.handler({ httpMethod: req.method, headers, body: raw, queryStringParameters: Object.fromEntries(u.searchParams) });
        res.writeHead(r.statusCode || 200, Object.assign({ 'content-type': 'application/json' }, r.headers || {})); res.end(r.body || '');
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })); }
      return;
    }
    const p = u.pathname.startsWith('/admin/') ? path.join(ADMIN, u.pathname.slice(7)) : null;
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(''); return; }
    const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/json' }[path.extname(p)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(fs.readFileSync(p));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
const PROFILES = { pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/rep-home.html' } };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
async function ctxFor(browser, who, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device || DESKTOP));
  await ctx.addInitScript(([tok, prof]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [who, JSON.stringify(PROFILES[who])]);
  return ctx;
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const graphSends = w => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url)).map(x => (typeof x.body === 'string' ? JSON.parse(x.body) : x.body).message);


(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world(); const { srv, port } = await serve(w); const B = `http://127.0.0.1:${port}`;
  const errors = [];
  try {
    const c = await ctxFor(browser, 'pres'); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message));
    await step('Learned rules: "Look for patterns" shows masked suggestions; nothing approved by itself', async () => {
      await p.goto(`${B}/admin/email-learning.html`); await p.waitForSelector('.el-tab');
      await p.click('.el-tab[data-tab="rules"]'); await p.waitForSelector('#el-analyze');
      assert.ok(/shape your own AI drafts only while Apply learned rules is switched on \(off\)/.test(await p.textContent('#body')));
      await p.click('#el-analyze'); await p.waitForFunction(() => /new suggestion/.test(document.body.textContent));
      const n = await p.$$eval('.el-rule.s-suggested', x => x.length); assert.ok(n >= 2, 'suggestions ' + n);
      const txt = await p.textContent('#body'); for (const bad of ['Pat', 'Lee', 'Sampletown', 'Exampleville']) assert.ok(!txt.includes(bad), bad);
      assert.strictEqual(w.db.email_learning_profiles.length, 0);
    });
    await step('approve with a reason and my own wording → version 1; an empty reason is refused first', async () => {
      await p.click('.el-rule.s-suggested [data-act="approve"]'); await p.waitForSelector('#el-form');
      await p.click('#el-save'); await p.waitForFunction(() => /short reason/.test(document.body.textContent));
      assert.strictEqual(w.db.email_learning_profiles.length, 0);
      await p.click('.el-rule.s-suggested [data-act="approve"]'); await p.waitForSelector('#el-instr');
      await p.fill('#el-instr', 'Skip the small talk and get to the visit.'); await p.fill('#el-reason', 'This is how I write');
      await p.click('#el-save'); await p.waitForFunction(() => /version 1/.test(document.body.textContent));
      assert.strictEqual(w.db.email_learning_profiles.length, 1);
      assert.ok(await p.isVisible('.el-rule.s-approved:has-text("Skip the small talk")'));
    });
    await step('reject another suggestion; approve a third → version 2', async () => {
      await p.click('.el-rule.s-suggested [data-act="reject"]'); await p.fill('#el-reason', 'Only fits some dealers'); await p.click('#el-save');
      await p.waitForFunction(() => /Rejected/.test(document.body.textContent));
      await p.click('.el-rule.s-suggested [data-act="approve"]'); await p.fill('#el-reason', 'ok'); await p.click('#el-save');
      await p.waitForFunction(() => /short reason/.test(document.body.textContent));
      await p.click('.el-rule.s-suggested [data-act="approve"]'); await p.fill('#el-reason', 'Yes, mine'); await p.click('#el-save');
      await p.waitForFunction(() => /version 2/.test(document.body.textContent));
    });
    await step('Versions: history listed; restore version 1 → version 3 with exactly its rule', async () => {
      await p.click('.el-tab[data-tab="versions"]'); await p.waitForSelector('[data-ver="1"]');
      await p.click('[data-ver="1"]'); await p.fill('#el-reason', 'The second rule did not fit'); await p.click('#el-save');
      await p.waitForFunction(() => /version 3 matches version 1/.test(document.body.textContent));
      assert.strictEqual(w.db.email_learning_rules.filter(x => x.status === 'approved').length, 1);
    });
    await step('reset → no approved rule; history kept', async () => {
      await p.click('[data-ver="0"]'); await p.fill('#el-reason', 'Start over'); await p.click('#el-save');
      await p.waitForFunction(() => /has no approved rules/.test(document.body.textContent));
      assert.strictEqual(w.db.email_learning_rules.filter(x => x.status === 'approved').length, 0);
      assert.strictEqual(w.db.email_learning_profiles.length, 4);
    });
    await c.close();
    for (const [label, dev] of [['phone 360', { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }], ['phone 390', PHONE], ['tablet 768', { viewport: { width: 768, height: 1024 }, hasTouch: true }], ['desktop 1280', DESKTOP]]) {
      await step(`${label}: rules and versions fit (no sideways scroll), buttons comfortable to tap`, async () => {
        const c2 = await ctxFor(browser, 'pres', dev); const q = await c2.newPage(); q.on('pageerror', e => errors.push(e.message));
        await q.goto(`${B}/admin/email-learning.html`); await q.waitForSelector('.el-tab');
        for (const tab of ['rules', 'versions']) {
          // Wait until THIS tab has rendered (not the previous tab's cards, which are replaced when the new list arrives).
          await q.click(`.el-tab[data-tab="${tab}"]`); await q.waitForSelector(`.el-tab.on[data-tab="${tab}"]`);
          await q.waitForFunction(t => !/Loading…/.test(document.body.textContent) && document.querySelector('.el-tab.on') && document.querySelector('.el-tab.on').getAttribute('data-tab') === t && document.querySelector('.el-rule, .empty'), tab);
          const ov = await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(ov <= 1, tab + ' overflow ' + ov);
          if (dev.isMobile) { const hs = await q.evaluate(() => [...document.querySelectorAll('.el-tab, .el-rule button')].map(x => x.getBoundingClientRect().height)); assert.ok(hs.every(h => h >= 44), tab + ' ' + hs.join(',')); }
        }
        await c2.close();
      });
    }
    await step('Greg is refused the owner page', async () => {
      const c3 = await ctxFor(browser, 'greg'); const g = await c3.newPage();
      await g.goto(`${B}/admin/email-learning.html`); await g.waitForFunction(() => /owner's page/.test(document.body.textContent)); await c3.close();
    });
    await step('nothing left HCPS and no page error', async () => {
      assert.strictEqual(w.outbound.length, 0, JSON.stringify(w.outbound.map(o => o.kind)));
      assert.deepStrictEqual(errors, []);
    });
  } finally { await browser.close(); srv.close(); }
  console.log(`\nEmail learning P2 UI: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });
