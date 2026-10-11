/* Connect 360 shared header — phone / tablet / desktop QA across EVERY admin page (RULE 10).
   Serves src/admin locally (functions answer a harmless {"ok":true}; nothing leaves this machine) and, for each page,
   role and width, checks the masthead the way a person would use it:
     - the Lock / Exit view-as button is on screen, not covered, and at least 44px tall on phones;
     - account controls (My Sales Workspace, favourites, task badge when shown) are on screen;
     - every navigation link is on screen or inside a row that scrolls sideways, the CURRENT page's link is visible
       without scrolling, and phone tap targets are at least 44px tall;
     - the header never makes the page scroll sideways.
   Roles: president (admin hubs), president in My Sales Workspace, president viewing as a rep, rep, relations.
   Widths: 360, 390 (phones), 768 (tablet), 1280 (desktop).
     PLAYWRIGHT_MODULE=/path/to/node_modules/playwright [SHOTS=/dir] [PAGES=a.html,b.html] node test/admin-header.mobile.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const SRC = path.join(__dirname, '..', 'src', 'admin');
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const SHOTS = process.env.SHOTS || null;
const WIDTHS = (process.env.WIDTHS || '360,390,768,1280').split(',').map(Number);
const PHONE = 600;
const pages = (process.env.PAGES ? process.env.PAGES.split(',') : fs.readdirSync(SRC).filter(f => f.endsWith('.html')))
  .filter(f => { const s = fs.readFileSync(path.join(SRC, f), 'utf8'); return /admin-chrome\.js/.test(s); })   // pages that carry the shared header
  .map(f => f === 'index.html' ? '/admin/' : '/admin/' + f);
const ROLES = {
  president: { profile: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president' } },
  workspace: { profile: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president' }, session: { hcps_workspace: 'mine' }, url: '?workspace=mine' },
  viewas: { profile: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep' }, local: { hcps_impersonation: JSON.stringify({ by_name: 'Angelo Audia', rep_name: 'Greg Campbell', rep_email: 'greg@hcps.us', at: Date.now() }) } },
  rep: { profile: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep' } },
  relations: { profile: { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations' } },
};

const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  const f = p === '/admin/' ? path.join(SRC, 'index.html') : p.startsWith('/admin/') ? path.join(SRC, path.basename(p)) : null;
  if (f && fs.existsSync(f)) {
    res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.json') ? 'application/json' : 'text/html' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('');
});

/* Runs in the page. Returns a list of problems with the masthead. */
function inspect([PHONE, WIDTH]) {
  const W = WIDTH, out = [];   // the screen width asked for (a phone browser would shrink an overflowing page to fit, hiding the fault)
  const head = document.querySelector('#ac-head.ac-head') || document.querySelector('header');
  if (!head) return { problems: ['no header found'], height: 0 };
  const scroller = el => { for (let a = el.parentElement; a && a !== head.parentElement; a = a.parentElement) { const cs = getComputedStyle(a); if (/(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1) return a; } return null; };
  const label = el => (el.id ? '#' + el.id : '') + (el.textContent || '').trim().slice(0, 28);
  const covered = el => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || x > W || y < 0 || y > window.innerHeight) return 'off screen'; const t = document.elementFromPoint(x, y); return t && (t === el || el.contains(t)) ? null : 'covered by ' + (t ? t.tagName + '.' + t.className : 'nothing'); };
  // 1. nothing in the header runs off the side, unless it sits in a sideways-scrolling row that itself fits
  for (const el of head.querySelectorAll('*')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if ((r.right > W + 1 || r.left < -1) && !scroller(el)) out.push('off the side: ' + el.tagName + '.' + el.className + ' ' + label(el) + ' (' + Math.round(r.left) + '–' + Math.round(r.right) + ')');
  }
  for (const s of head.querySelectorAll('*')) { const cs = getComputedStyle(s); if (/(auto|scroll)/.test(cs.overflowX) && s.scrollWidth > s.clientWidth + 1) { const r = s.getBoundingClientRect(); if (r.right > W + 1 || r.left < -1) out.push('scroll row wider than screen: ' + s.className); } }
  // 2. account controls usable
  const lock = head.querySelector('#ac-lock') || [...head.querySelectorAll('button')].find(b => /^(Lock|Exit view-as)$/.test(b.textContent.trim()));
  if (!lock) out.push('no Lock button');
  else {
    const r = lock.getBoundingClientRect(); const c = covered(lock); if (c) out.push('Lock ' + c);
    if (r.right > W + 1 || r.left < -1) out.push('Lock off the side'); if (W <= PHONE && r.height < 44) out.push('Lock is ' + Math.round(r.height) + 'px tall (< 44)');
  }
  for (const el of head.querySelectorAll('#ac-ws-enter, .wsbtn, #ac-imp-exit, #ac-ws-exit, #ac-fav, #ac-taskbadge')) {
    if (getComputedStyle(el).display === 'none') continue; const c = covered(el); if (c) out.push(label(el) + ' ' + c);
    if (W <= PHONE && el.getBoundingClientRect().height < 44 && !/ac-fav|ac-taskbadge/.test(el.id)) out.push(label(el) + ' is ' + Math.round(el.getBoundingClientRect().height) + 'px tall (< 44)');
  }
  // 3. navigation: reachable, current page visible, tap targets
  const links = [...head.querySelectorAll('nav a')];
  for (const a of links) {
    const r = a.getBoundingClientRect(); if (!r.width) continue;
    const sc = scroller(a);
    if (!sc && (r.right > W + 1 || r.left < -1)) out.push('nav link unreachable: ' + label(a));
    if (W <= PHONE && r.height < 44) { out.push('nav tap target < 44px'); break; }
  }
  // the current page: in each row that has one, at least one highlighted link is visible without scrolling (two links
  // to the same page — e.g. Territory Map and map.html#handout — are both highlighted; only one can be centred)
  for (const row of head.querySelectorAll('nav')) {
    const on = [...row.querySelectorAll('a.on')]; if (!on.length) continue;
    const vis = on.some(a => { const r = a.getBoundingClientRect(), sc = scroller(a); const box = sc ? sc.getBoundingClientRect() : { left: 0, right: W };
      return r.left >= box.left - 1 && r.right <= box.right + 1; });
    if (!vis) out.push('current page link not visible: ' + label(on[0]));
  }
  if (document.documentElement.scrollWidth > W + 1) {
    // is the header the cause? (page bodies are checked by each tool's own QA)
    const wide = [...head.querySelectorAll('*')].some(el => el.getBoundingClientRect().right > W + 1 && !scroller(el));
    if (wide) out.push('header makes the page scroll sideways');
  }
  return { problems: [...new Set(out)], height: Math.round(head.getBoundingClientRect().height), sticky: getComputedStyle(head).position, links: links.length };
}

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: EXE });
  const results = []; let bad = 0;
  try {
    for (const width of WIDTHS) for (const [role, R] of Object.entries(ROLES)) {
      const ctx = await browser.newContext({ viewport: { width, height: width <= PHONE ? 800 : 900 }, hasTouch: width <= PHONE, deviceScaleFactor: 1 });
      await ctx.route(u => !/^http:\/\/127\.0\.0\.1[:/]/.test(String(u)), r => r.abort());
      await ctx.addInitScript(R2 => { try {
        localStorage.setItem('hcps_staff_token', 'tok'); localStorage.setItem('hcps_staff_profile', JSON.stringify(R2.profile));
        for (const [k, v] of Object.entries(R2.local || {})) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(R2.session || {})) sessionStorage.setItem(k, v);
      } catch (e) {} }, R);
      const pg = await ctx.newPage(); pg.on('dialog', d => d.dismiss().catch(() => {}));
      for (const url of pages) {
        try { await pg.goto(origin + url + (R.url || ''), { waitUntil: 'load', timeout: 15000 }); } catch (e) { /* a page that redirects keeps going */ }
        await pg.waitForTimeout(500);
        let r = null; for (let i = 0; i < 4 && !r; i++) { r = await pg.evaluate(inspect, [PHONE, width]).catch(() => null); if (!r) await pg.waitForTimeout(500); }
        r = r || { problems: ['page never settled'], height: 0 };
        const landed = new URL(pg.url()).pathname;
        results.push({ width, role, url, landed, ...r }); if (r.problems.length) bad++;
        if (SHOTS && r.problems.length && width <= PHONE) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, `hdr-${width}-${role}-${path.basename(url) || 'dashboard'}.png`) }).catch(() => {}); }
      }
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  // summary: problems grouped, and header heights on phones
  const groups = {};
  for (const r of results) for (const p of r.problems) { const k = `${r.width} ${r.role}: ${p.replace(/\(\d+–\d+\)/, '').replace(/ is \d+px/, ' is <44px')}`; (groups[k] = groups[k] || []).push(r.landed); }
  for (const [k, v] of Object.entries(groups)) console.log(`PROBLEM ${k}  — ${v.length} page(s): ${[...new Set(v)].slice(0, 4).join(', ')}${v.length > 4 ? ' …' : ''}`);
  const phones = results.filter(r => r.width <= PHONE);
  const hs = phones.map(r => r.height).sort((a, b) => a - b);
  if (hs.length) console.log(`phone header height: min ${hs[0]}px, median ${hs[Math.floor(hs.length / 2)]}px, max ${hs[hs.length - 1]}px; position: ${[...new Set(phones.map(r => r.sticky))].join('/')}`);
  console.log(`\nadmin header: ${results.length - bad} of ${results.length} page views clean (${pages.length} pages × ${Object.keys(ROLES).length} roles × ${WIDTHS.length} widths)`);
  if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(results, null, 1));
  process.exitCode = bad ? 1 : 0;
})();
