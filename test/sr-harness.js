/* Scheduled Routes / Territory — shared browser harness.
   Serves the REAL src/admin pages and answers every /.netlify/functions call with the REAL handler
   running against the fake database in phase0-mock.js. Nothing leaves the machine: Graph / Resend
   sends are captured in world.outbound, and OpenRouteService "directions" is answered with the
   synthetic drive legs the test supplies (opts.legs(coords) → [{duration_s}]).

   Synthetic data only. Used by test/sr-email-editor.qa.js and test/sr-eta.qa.js. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createWorld, load, standardSeed } = require('./phase0-mock');

let chromium = null;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); } catch (e2) {} }

const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

const PROFILES = {
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/rep-home.html' },
  pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
};

function world(extra, opts) {
  const S = standardSeed(Object.assign({
    dealer_visit_reports: [],
    dealer_contacts: [
      { id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', title: 'Pharmacist', phone: '270-111' },
      { id: 'c-stacey', dealer_id: 'd-greg', name: 'Stacey New', email: 'stacey@glasgow.test', title: 'Buyer' },
    ],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { adhoc_visit: true } }],
  }, extra || {}));
  S.unique = { dealer_visit_reports: [['route_id', 'dealer_id']], dealer_tasks: [['origin_type', 'origin_id', 'origin_key']] };
  S.ai = (opts && opts.ai) || (() => ({ subject: 'Following up on our visit', body: 'Hi Bryant,\n\nThank you for meeting with me on October 2.' }));
  return createWorld(S);
}

function serve(w, opts) {
  opts = opts || {};
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) {}
      calls.push({ name, body });
      if (opts.slow) { const ms = opts.slow(name, body); if (ms) await new Promise(r => setTimeout(r, ms)); }
      if (name === 'routes-api' && body.action === 'directions') {
        const coords = body.coords || [];
        const legs = opts.legs ? opts.legs(coords) : coords.slice(1).map(() => ({ duration_s: 1800 }));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, legs, geometry: coords, distance_m: 0, duration_s: legs.reduce((a, l) => a + l.duration_s, 0) })); return;
      }
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
    let p = u.pathname.startsWith('/admin/') ? path.join(ADMIN, u.pathname.slice(7)) : null;
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(''); return; }
    let src = fs.readFileSync(p);
    if (opts.mutate && opts.mutate[path.basename(p)]) {
      const m = opts.mutate[path.basename(p)]; let s = src.toString('utf8');
      if (!s.includes(m.from)) throw new Error('MUTANT ANCHOR NOT FOUND in ' + path.basename(p));
      src = Buffer.from(s.split(m.from).join(m.to));
    }
    const ext = path.extname(p); const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(src);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, calls })));
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const DESKTOP = { viewport: { width: 1366, height: 900 } };

async function ctxFor(browser, who, device, tz) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block', timezoneId: tz || 'America/Chicago' }, device));
  await ctx.addInitScript(([tok, prof]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [who, JSON.stringify(PROFILES[who])]);
  return ctx;
}

function runner() {
  let pass = 0, fail = 0;
  return {
    async step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } },
    done(label) { console.log(`\n${label}: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return { pass, fail }; },
  };
}

module.exports = { chromium, world, serve, ctxFor, PHONE, DESKTOP, dayStr, runner };
