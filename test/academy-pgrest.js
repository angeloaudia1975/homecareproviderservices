/* A tiny stand-in for Supabase in front of a REAL local Postgres, for the Academy Course Builder tests (A2D Stage 3).
   The real Netlify function runs unchanged; its fetch() calls are answered here:
     /rest/v1/rpc/<fn>            -> calls the real database function (named arguments, the function's own types)
     /rest/v1/<table>?…           -> a SELECT (eq / in / is.null filters, select, order, limit, offset) or an INSERT
     /auth/v1/user                -> the sign-in behind a test token (tokens map to staff emails)
     /storage/v1/object/…         -> an in-memory private bucket (upload without overwrite, list, remove, sign)
   Database errors come back the way PostgREST sends them ({ code, message }), so the function's own error handling is
   what is tested. Nothing here talks to the internet. The base URL is a made-up host, never the project's address. */
const { spawnSync } = require('child_process');

const BASE = 'https://pgshim.test';
const IDENT = /^[a-z_][a-z0-9_]*$/;
const lit = v => "'" + String(v).replace(/'/g, "''") + "'";

function shim(opts) {
  const db = opts.db, PSQL = opts.psql || 'psql', tokens = opts.tokens || {};
  const storage = opts.storage || new Map();   // path -> { bytes, type, created_at }
  const calls = [];
  const sql = text => {
    const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-d', db, '-c', '\\set VERBOSITY verbose', '-c', text], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || /ERROR:/.test(r.stderr)) {
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.stderr || '') || [];
      return { error: { code: m[1] || 'XX000', message: m[2] || String(r.stderr).trim() } };
    }
    return { out: r.stdout.trim() };
  };
  const argTypes = {};
  function types(fn) {
    if (argTypes[fn]) return argTypes[fn];
    const r = sql(`select coalesce(json_agg(json_build_object('n', n, 't', t)), '[]') from pg_proc p, unnest(p.proargnames, p.proargtypes::oid[]::regtype[]::text[]) x(n, t) where p.proname = ${lit(fn)} and p.pronamespace = 'public'::regnamespace`);
    const list = r.error ? [] : JSON.parse(r.out || '[]');
    return (argTypes[fn] = list.length ? Object.fromEntries(list.map(x => [x.n, x.t])) : null);
  }
  function value(v, type) {
    if (v == null) return 'null';
    if (type === 'jsonb' || type === 'json') return lit(JSON.stringify(v)) + '::' + type;
    if (/\[\]$/.test(type)) { if (!Array.isArray(v)) return lit(String(v)) + '::' + type; return lit('{' + v.map(x => '"' + String(x).replace(/["\\]/g, '\\$&') + '"').join(',') + '}') + '::' + type; }
    if (typeof v === 'object') return lit(JSON.stringify(v)) + '::' + type;
    return lit(v) + '::' + type;
  }
  function select(table, qs) {
    if (!IDENT.test(table)) return { status: 404, body: { code: 'PGRST205', message: 'no table' } };
    let cols = '*', order = '', limit = '', offset = ''; const where = [];
    for (const part of qs.split('&').filter(Boolean)) {
      const i = part.indexOf('='); const k = decodeURIComponent(part.slice(0, i)); const v = decodeURIComponent(part.slice(i + 1));
      if (k === 'select') { const c = v.split(',').map(x => x.trim()); if (!c.every(x => x === '*' || IDENT.test(x))) return { status: 400, body: { code: 'PGRST100', message: 'bad select' } }; cols = c.join(','); continue; }
      if (k === 'order') { const [c, dir] = v.split('.'); if (!IDENT.test(c)) return { status: 400, body: { code: 'PGRST100', message: 'bad order' } }; order = ` order by ${c} ${dir === 'desc' ? 'desc' : 'asc'}`; continue; }
      if (k === 'limit') { limit = ' limit ' + Number(v); continue; }
      if (k === 'offset') { offset = ' offset ' + Number(v); continue; }
      if (!IDENT.test(k)) return { status: 400, body: { code: 'PGRST100', message: 'bad filter' } };
      if (v.startsWith('eq.')) where.push(`${k}::text = ${lit(v.slice(3))}`);
      else if (v.startsWith('neq.')) where.push(`${k}::text is distinct from ${lit(v.slice(4))}`);
      else if (v.startsWith('ilike.')) where.push(`${k}::text ilike ${lit(v.slice(6).replace(/\*/g, '%'))}`);
      else if (v === 'is.null') where.push(`${k} is null`);
      else if (/^(gt|lt|gte|lte)\.-?\d+$/.test(v)) { const [op, n] = v.split('.'); where.push(`${k} ${{ gt: '>', lt: '<', gte: '>=', lte: '<=' }[op]} ${Number(n)}`); }
      else if (v.startsWith('in.(') && v.endsWith(')')) { const items = v.slice(4, -1).split(',').filter(x => x !== ''); where.push(items.length ? `${k}::text in (${items.map(lit).join(',')})` : 'false'); }
      else return { status: 400, body: { code: 'PGRST100', message: 'unsupported filter ' + v } };
    }
    const r = sql(`select coalesce(json_agg(row_to_json(t)), '[]') from (select ${cols} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order}${limit}${offset}) t`);
    if (r.error) return { status: 400, body: r.error };
    return { status: 200, body: JSON.parse(r.out || '[]') };
  }
  function insert(table, body) {
    if (!IDENT.test(table)) return { status: 404, body: { code: 'PGRST205', message: 'no table' } };
    const rows = Array.isArray(body) ? body : [body];
    for (const row of rows) {
      const keys = Object.keys(row).filter(k => IDENT.test(k));
      const r = sql(`insert into public.${table} (${keys.join(',')}) select ${keys.join(',')} from jsonb_populate_record(null::public.${table}, ${lit(JSON.stringify(row))}::jsonb)`);
      if (r.error) return { status: r.error.code === '42501' ? 403 : 400, body: r.error };
    }
    return { status: 201, body: '' };
  }
  const respond = (status, body, type) => new Response(body == null || body === '' ? null : (Buffer.isBuffer(body) ? body : JSON.stringify(body)), { status, headers: { 'content-type': type || 'application/json' } });

  async function fetchFn(url, o) {
    const u = String(url); o = o || {};
    const method = (o.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (!u.startsWith(BASE)) return opts.passthrough ? opts.passthrough(url, o) : respond(599, { message: 'blocked: ' + u });
    const p = u.slice(BASE.length);
    calls.push({ method, path: p });
    if (p.startsWith('/auth/v1/user')) {
      const tok = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
      const who = tokens[tok]; if (!who) return respond(401, { msg: 'invalid token' });
      return typeof who === 'object' ? respond(200, { id: who.id, email: who.email }) : respond(200, { id: 'u-' + tok, email: who });
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length).split('?')[0];
      if (!IDENT.test(fn)) return respond(404, { code: 'PGRST202', message: 'no function' });
      const t = types(fn); if (!t) return respond(404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
      const args = o.body ? JSON.parse(o.body) : {};
      if (api.onRpc) { const forced = await api.onRpc(fn, args); if (forced) return respond(forced.status, forced.body); }
      for (const k of Object.keys(args)) if (!t[k]) return respond(404, { code: 'PGRST202', message: `no argument ${k} on ${fn}` });
      const r = sql(`select to_jsonb(public.${fn}(${Object.keys(args).map(k => `${k} => ${value(args[k], t[k])}`).join(', ')}))`);
      if (r.error) return respond(r.error.code === 'P0002' ? 404 : r.error.code === '42501' ? 403 : 400, r.error);
      return respond(200, r.out ? JSON.parse(r.out) : null);
    }
    if (p.startsWith('/rest/v1/')) {
      const rest = p.slice('/rest/v1/'.length); const q = rest.indexOf('?');
      const table = q >= 0 ? rest.slice(0, q) : rest, qs = q >= 0 ? rest.slice(q + 1) : '';
      if (method === 'GET') { const r = select(table, qs); return respond(r.status, r.body); }
      if (method === 'POST') { const r = insert(table, JSON.parse(o.body || '{}')); return respond(r.status, r.body); }
      return respond(405, { code: 'PGRST', message: 'the builder never sends ' + method + ' to a table' });
    }
    // ---- storage (the private Academy bucket) ----
    const SIGN = '/storage/v1/object/sign/academy-private/', OBJ = '/storage/v1/object/academy-private';
    if (p.startsWith(SIGN)) { const path = p.slice(SIGN.length).split('/').map(decodeURIComponent).join('/'); return respond(200, { signedURL: '/object/sign/academy-private/' + path + '?token=t' }); }
    if (p === '/storage/v1/object/list/academy-private' && method === 'POST') {
      const { prefix } = JSON.parse(o.body || '{}'); const seen = new Map();
      for (const [path, f] of storage) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), i = rest.indexOf('/');
        if (i >= 0) seen.set(rest.slice(0, i), { name: rest.slice(0, i), id: null, metadata: null });
        else seen.set(rest, { name: rest, id: 'obj-' + rest, metadata: { size: f.bytes.length, mimetype: f.type }, created_at: f.created_at });
      }
      return respond(200, [...seen.values()].sort((a, b) => a.name < b.name ? -1 : 1));
    }
    if (p === OBJ && method === 'DELETE') { const { prefixes } = JSON.parse(o.body || '{}'); const gone = []; for (const x of prefixes || []) if (storage.delete(x)) gone.push({ name: x }); return respond(200, gone); }
    if (p.startsWith(OBJ + '/') && method === 'POST') {
      const path = p.slice(OBJ.length + 1).split('/').map(decodeURIComponent).join('/');
      if (storage.has(path) && headers['x-upsert'] !== 'true') return respond(409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      storage.set(path, { bytes: Buffer.from(o.body), type: headers['content-type'], created_at: new Date().toISOString() });
      return respond(200, { Key: 'academy-private/' + path });
    }
    return respond(404, { message: 'not emulated: ' + method + ' ' + p });
  }
  const api = { fetch: fetchFn, storage, calls, sql, BASE, onRpc: null };
  return api;
}

module.exports = { shim, BASE };
