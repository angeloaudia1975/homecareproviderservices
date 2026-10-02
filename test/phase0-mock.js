/* Phase 0 test harness: a small in-memory PostgREST + Supabase Auth + outside-services fake.
   The real Netlify function files are loaded unmodified and their handlers called with real
   events. Every outbound fetch lands here, so a test can assert both the HTTP answer AND what
   the function tried to write. Nothing touches the network or the live database. */
const path = require('path');

// Paths are relative to this file: test/ sits beside netlify/, and the ordering repo is the
// sibling folder in the same GitHub directory.
const REPO = path.join(__dirname, '..', 'netlify', 'functions');
const ORDER_REPO = path.join(__dirname, '..', '..', 'homecareproviderservicesordering', 'netlify', 'functions');
const Module = require('module');
const fs = require('fs');
/* MUTANTS. phase0.mutants.js runs the suites with P0_MUTANT set; the matching edit is applied to
   the source IN MEMORY as each file is loaded. Nothing on disk is ever changed. */
const MUTANT = process.env.P0_MUTANT ? require('./phase0.mutants.table.js')[process.env.P0_MUTANT] : null;
function compileInto(full) {
  let src = fs.readFileSync(full, 'utf8');
  if (MUTANT && path.basename(full) === MUTANT.file && path.dirname(full) === (MUTANT.ordering ? ORDER_REPO : REPO)) {
    if (!src.includes(MUTANT.from)) throw new Error('MUTANT ANCHOR NOT FOUND: ' + process.env.P0_MUTANT);
    src = src.split(MUTANT.from).join(MUTANT.to);
  }
  const m = new Module(full, module); m.filename = full; m.paths = Module._nodeModulePaths(path.dirname(full));
  require.cache[full] = m; m._compile(src, full); m.loaded = true; return m.exports;
}
const BASE = 'https://db.test';

function createWorld(seed) {
  const db = {};
  for (const [t, rows] of Object.entries(seed.tables || {})) db[t] = rows.map(r => ({ ...r }));
  const tokens = Object.assign({}, seed.tokens || {});          // bearer -> email
  const authUsers = new Set((seed.authUsers || []).map(e => e.toLowerCase()));
  const passwords = Object.assign({}, seed.passwords || {});    // email -> password
  const calls = [];                                             // every fetch, for assertions
  const writes = [];                                            // POST/PATCH/DELETE on the db
  const outbound = [];                                          // email / graph sends
  const MAX_ROWS = seed.maxRows || 1000;
  const missingTables = new Set(seed.missingTables || []);

  const decode = s => decodeURIComponent(String(s).replace(/\+/g, ' '));
  // Postgres stores a jsonb value with its OWN key order (shorter keys first, then by bytes), so an
  // object read back never has the key order it was written with. Mirror that for every
  // object-valued column, so code that compares JSON text is caught here rather than in production.
  const jsonbOrder = v => Array.isArray(v) ? v.map(jsonbOrder) : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(k => [k, jsonbOrder(v[k])])) : v;
  const jsonbRow = r => { const o = { ...r }; for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') o[k] = jsonbOrder(o[k]); return o; };
  function parseVal(v) { if (v === 'null') return null; if (v === 'true') return true; if (v === 'false') return false; return v; }
  function cmp(a, b) { if (a == null && b == null) return 0; if (a == null) return -1; if (b == null) return 1; const na = Number(a), nb = Number(b); if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb; return String(a).localeCompare(String(b)); }
  function test(row, col, op, val) {
    const cell = row[col];
    switch (op) {
      case 'eq': return String(cell) === String(parseVal(val)) || (cell == null && parseVal(val) == null);
      case 'neq': return String(cell) !== String(parseVal(val));
      case 'gt': return cmp(cell, val) > 0; case 'gte': return cmp(cell, val) >= 0;
      case 'lt': return cmp(cell, val) < 0; case 'lte': return cmp(cell, val) <= 0;
      case 'is': return val === 'null' ? cell == null : String(cell) === val;
      case 'in': { const list = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')); return list.includes(String(cell)); }
      case 'ilike': case 'like': { const re = new RegExp('^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*') + '$', op === 'ilike' ? 'i' : ''); return re.test(String(cell == null ? '' : cell)); }
      case 'cs': { // jsonb containment: stops=cs.[{"dealer_id":"x"}]
        let want; try { want = JSON.parse(val); } catch (e) { return false; }
        const contains = (h, w) => Array.isArray(w) ? (Array.isArray(h) && w.every(x => h.some(y => contains(y, x))))
          : (w && typeof w === 'object') ? (!!h && typeof h === 'object' && Object.keys(w).every(k => contains(h[k], w[k]))) : String(h) === String(w);
        return contains(cell, want); }
      default: return true;
    }
  }
  function matchCond(row, col, expr) {
    let neg = false; if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
    const i = expr.indexOf('.'); const op = expr.slice(0, i), val = expr.slice(i + 1);
    const r = test(row, col, op, val); return neg ? !r : r;
  }
  function parseOr(s) { // or=(a.eq.x,b.eq.y)
    const inner = s.replace(/^\(|\)$/g, ''); const parts = []; let depth = 0, cur = '';
    for (const ch of inner) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
    if (cur) parts.push(cur);
    return parts.map(p => { const i = p.indexOf('.'); return { col: p.slice(0, i), expr: p.slice(i + 1) }; });
  }
  function query(table, qs) {
    const params = []; const meta = {};
    for (const part of qs.split('&').filter(Boolean)) {
      const i = part.indexOf('='); const k = decode(part.slice(0, i)); const v = decode(part.slice(i + 1));
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) meta[k] = v; else params.push([k, v]);
    }
    const filt = row => params.every(([k, v]) => k === 'or' ? parseOr(v).some(c => matchCond(row, c.col, c.expr)) : matchCond(row, k, v));
    return { filt, meta };
  }
  function project(row, select) {
    if (!select || select === '*') return { ...row };
    const out = {}; for (const c of select.split(',').map(s => s.trim()).filter(Boolean)) { if (c.includes('(')) continue; if (c in row) out[c] = row[c]; else out[c] = row[c]; }
    return out;
  }

  const res = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => (headers || {})[String(k).toLowerCase()] || null }, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

  async function fetchImpl(url, opts) {
    opts = opts || {}; const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = null; try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = opts.body; }
    calls.push({ url, method, headers, body });
    const u = String(url);

    // ---- Supabase Auth ----
    if (u.startsWith(BASE + '/auth/v1/user')) {
      const tok = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
      const email = tokens[tok]; return email ? res(200, { email }) : res(401, { msg: 'bad jwt' });
    }
    if (u.startsWith(BASE + '/auth/v1/token')) {
      const email = String(body && body.email || '').toLowerCase();
      if (authUsers.has(email) && passwords[email] === body.password) { const t = 'tok-' + email; tokens[t] = email; return res(200, { access_token: t, refresh_token: 'r', expires_in: 3600 }); }
      return res(400, { error_description: 'Invalid login credentials' });
    }
    if (u.startsWith(BASE + '/auth/v1/admin/users')) {
      const email = String(body && body.email || '').toLowerCase();
      if (authUsers.has(email)) return res(422, { msg: 'A user with this email address has already been registered' });
      authUsers.add(email); passwords[email] = body.password; writes.push({ kind: 'auth_create', email, password: body.password }); return res(200, { id: 'u-' + email });
    }
    if (u.startsWith(BASE + '/auth/v1/admin/generate_link')) {
      const email = String(body && body.email || '').toLowerCase();
      if (!authUsers.has(email)) return res(404, { msg: 'User not found' });
      writes.push({ kind: 'link', type: body.type, email, redirect: body.options && body.options.redirect_to });
      return res(200, { properties: { action_link: 'https://link.test/' + body.type + '/' + email, hashed_token: 'h', email_otp: '1' } });
    }
    if (u.startsWith(BASE + '/auth/v1/recover')) { writes.push({ kind: 'supabase_recover', email: body && body.email, url: u }); return res(200, {}); }
    if (u.startsWith(BASE + '/auth/v1/verify')) return res(200, { access_token: 'imp', refresh_token: 'r', expires_in: 3600 });

    // ---- PostgREST ----
    if (u.startsWith(BASE + '/rest/v1/')) {
      const rest = u.slice((BASE + '/rest/v1/').length); const q = rest.indexOf('?');
      const table = q >= 0 ? rest.slice(0, q) : rest; const qs = q >= 0 ? rest.slice(q + 1) : '';
      if (missingTables.has(table)) return res(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}'` });
      if (!db[table]) db[table] = [];
      const { filt, meta } = query(table, qs);
      const prefer = String(headers.prefer || '');
      // seed.columns[table] = the columns this database has (a database before a migration): asking
      // for, filtering on or writing any other column fails the way PostgREST does.
      const known = seed.columns && seed.columns[table];
      if (known) {
        const used = [];
        if (meta.select && meta.select !== '*') for (const c of meta.select.split(',').map(x => x.trim())) if (c && !c.includes('(')) used.push(c);
        for (const part of qs.split('&').filter(Boolean)) { const k = decode(part.slice(0, part.indexOf('='))); const v = decode(part.slice(part.indexOf('=') + 1));
          if (k === 'or') { for (const c of parseOr(v)) used.push(c.col); } else if (!['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) used.push(k); }
        if (method === 'PATCH' && body && typeof body === 'object') for (const c of Object.keys(body)) if (!known.includes(c)) return res(400, { code: 'PGRST204', message: `Could not find the '${c}' column of '${table}' in the schema cache` });
        const bad = used.find(c => !known.includes(c)); if (bad) return res(400, { code: '42703', message: `column ${table}.${bad} does not exist` });
      }
      if (method === 'GET') {
        let rows = db[table].filter(filt);
        if (meta.order) { const [col, dir] = meta.order.split(',')[0].split('.'); rows = rows.slice().sort((a, b) => (dir === 'desc' ? -1 : 1) * cmp(a[col], b[col])); }
        const off = parseInt(meta.offset || '0', 10); const lim = Math.min(parseInt(meta.limit || String(MAX_ROWS), 10), MAX_ROWS);
        rows = rows.slice(off, off + lim);
        return res(200, rows.map(r => project(r, meta.select)));
      }
      if (method === 'POST') {
        const list = Array.isArray(body) ? body : [body]; const out = [];
        // Real PostgREST refuses a bulk insert whose rows don't all have the same keys.
        if (list.length > 1) { const sig = r => Object.keys(r || {}).sort().join(','); if (list.some(r => sig(r) !== sig(list[0]))) return res(400, { code: 'PGRST102', message: 'All object keys must match' }); }
        // Without on_conflict, PostgREST merges on the table's primary key. Tables keyed by
        // something other than "id" are listed here so the fake does the same.
        const PK = Object.assign({ dealer_directory: 'dealer_name' }, seed.pk || {});
        const keys = meta.on_conflict ? meta.on_conflict.split(',') : (/merge-duplicates|ignore-duplicates/.test(prefer) && PK[table] ? PK[table].split(',') : null);
        if (seed.rejectConflict && keys && seed.rejectConflict[table] === meta.on_conflict) return res(400, { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' });
        for (const r of list) {
          const row = jsonbRow(r);
          if (seed.columns && seed.columns[table]) { for (const c of Object.keys(row)) if (!seed.columns[table].includes(c)) return res(400, { code: 'PGRST204', message: `Could not find the '${c}' column of '${table}'` }); }
          if (keys) {
            const ex = db[table].find(x => keys.every(k => String(x[k]) === String(row[k]) && x[k] != null));
            if (ex) { if (/ignore-duplicates/.test(prefer)) continue; Object.assign(ex, row); out.push(ex); writes.push({ kind: 'upsert', table, row: { ...ex } }); continue; }
          }
          // seed.unique[table] = [[cols], …]: unique indexes (NULLs never collide, as in Postgres).
          for (const cols of ((seed.unique || {})[table] || [])) {
            if (cols.some(c => row[c] == null)) continue;
            if (db[table].some(x => cols.every(c => x[c] != null && String(x[c]) === String(row[c]))))
              return res(409, { code: '23505', message: `duplicate key value violates unique constraint (${cols.join(',')})` });
          }
          if (!('id' in row) && seed.autoId !== false) row.id = row.id || ('id-' + table + '-' + (db[table].length + 1) + '-' + Math.random().toString(36).slice(2, 7));
          if (!('created_at' in row)) row.created_at = new Date().toISOString();
          db[table].push(row); out.push(row); writes.push({ kind: 'insert', table, row: { ...row } });
        }
        return res(201, /return=representation/.test(prefer) ? out : '');
      }
      if (method === 'PATCH') {
        const hit = db[table].filter(filt);
        for (const r of hit) Object.assign(r, jsonbRow(body));
        writes.push({ kind: 'patch', table, count: hit.length, body, qs });
        return res(200, /return=representation/.test(prefer) ? hit : '');
      }
      if (method === 'DELETE') {
        const keep = [], gone = []; for (const r of db[table]) (filt(r) ? gone : keep).push(r); db[table] = keep;
        writes.push({ kind: 'delete', table, count: gone.length, qs });
        return res(200, /return=representation/.test(prefer) ? gone : '');
      }
    }

    // ---- Outside services ----
    if (u.includes('login.microsoftonline.com')) return res(200, { access_token: 'graph', expires_in: 3600 });
    if (u.includes('graph.microsoft.com')) { outbound.push({ kind: 'graph', url: u, method, body }); return res(method === 'POST' && /sendMail/.test(u) ? 202 : 200, {}); }
    if (u.includes('api.resend.com')) { outbound.push({ kind: 'resend', body }); return res(200, { id: 'm1' }); }
    if (u.includes('/data/manufacturers.json')) return res(200, []);
    // Published catalogs (Partner 360 /data/<slug>.json) and the Anthropic API, when a test supplies them.
    { const m = u.match(/\/data\/([a-z0-9-]+)\.json/); if (m) return res(200, ((seed.catalog || {})[m[1]]) || []); }
    if (u.includes('api.anthropic.com')) {
      outbound.push({ kind: 'ai', body });
      if (typeof seed.ai !== 'function') return res(500, { error: { message: 'no AI in this test' } });
      const out = seed.ai(body); if (out && out.status) return res(out.status, out.body || {});
      return res(200, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
    }
    return res(404, { error: 'unmocked ' + u });
  }

  return { db, tokens, authUsers, passwords, calls, writes, outbound, fetch: fetchImpl };
}

// Load a function file fresh, with this world's fetch and env.
function load(file, world, env, root) {
  const full = path.join(root || REPO, file);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root || REPO)) delete require.cache[k];
  global.fetch = world.fetch;
  const saved = {};
  const base = { SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE: 'svc', SUPABASE_ANON_KEY: 'anon', RESEND_API_KEY: 're', GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' };
  const all = Object.assign({}, base, env || {});
  for (const k of ['ANALYTICS_TOKEN', 'STAFF_BOOTSTRAP_EMAIL', ...Object.keys(all)]) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null) process.env[k] = v;
  // Pre-compile every sibling helper the file might require, so a mutant in a shared helper
  // (e.g. _scope.js) is the version the handler actually gets.
  if (MUTANT && MUTANT.file !== path.basename(full) && /\.js$/.test(MUTANT.file)) {   // page mutants go through adminSrc()
    const hp = path.join(MUTANT.ordering ? ORDER_REPO : REPO, MUTANT.file);
    if (fs.existsSync(hp)) compileInto(hp);
  }
  return compileInto(full);
}

function ev(body, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  return { httpMethod: opts.method || 'POST', headers, body: body == null ? '' : JSON.stringify(body), queryStringParameters: opts.qs || {} };
}
async function call(mod, body, opts) { const r = await mod.handler(ev(body, opts)); let j = null; try { j = JSON.parse(r.body); } catch (e) { j = r.body; } return { status: r.statusCode, body: j }; }

// The live shape, in miniature: three staff, dealers owned through dealers.rep_name and the
// legacy directory, one family, one unassigned dealer.
function standardSeed(extra) {
  const S = {
    tokens: { pres: 'angelo@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', stranger: 'nobody@else.com' },
    authUsers: ['angelo@hcps.us', 'greg@hcps.us', 'lori@hcps.us'],
    passwords: { 'angelo@hcps.us': 'pw-angelo-1', 'greg@hcps.us': 'pw-greg-1', 'lori@hcps.us': 'pw-lori-1' },
    tables: {
      staff_users: [
        { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', active: true, can_travel: true },
        { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', active: true, can_travel: true },
        { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', active: true },
      ],
      dealers: [
        { id: 'd-greg', business_name: 'Glasgow Prescription Center', rep_name: 'Greg Campbell', parent_id: null, email: 'g@glasgow.test', state: 'KY' },
        { id: 'd-greg-branch', business_name: 'Glasgow North', rep_name: null, parent_id: 'd-greg', state: 'KY' },
        { id: 'd-ang', business_name: 'Retail Medical Solutions', rep_name: 'Angelo Audia', parent_id: null, email: 'r@rms.test', state: 'TN' },
        { id: 'd-dir-greg', business_name: 'Directory Only Dealer', rep_name: null, parent_id: null, state: 'KY' },
        { id: 'd-none', business_name: 'Nobody Owns Me', rep_name: null, parent_id: null, state: 'OH' },
      ],
      dealer_directory: [
        { dealer_name: 'Glasgow Prescription Center', rep_name: 'Greg Campbell' },
        { dealer_name: 'Retail Medical Solutions', rep_name: 'Angelo Audia' },
        { dealer_name: 'Directory Only Dealer', rep_name: 'Greg Campbell' },
      ],
    },
  };
  if (extra) for (const [t, rows] of Object.entries(extra)) S.tables[t] = (S.tables[t] || []).concat(rows);
  return S;
}

let pass = 0, fail = 0; const failures = [];
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; failures.push(name); console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
function done(label) { console.log(`\n${label}: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return { pass, fail }; }

/* An admin page's source (src/admin/<file>), with the current mutant applied when it targets that page. */
function adminSrc(file) {
  let src = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', file), 'utf8');
  if (MUTANT && MUTANT.file === file && !MUTANT.ordering) {
    if (!src.includes(MUTANT.from)) throw new Error('MUTANT ANCHOR NOT FOUND: ' + process.env.P0_MUTANT);
    src = src.split(MUTANT.from).join(MUTANT.to);
  }
  return src;
}
module.exports = { createWorld, load, ev, call, standardSeed, t, done, REPO, ORDER_REPO, BASE, adminSrc };
