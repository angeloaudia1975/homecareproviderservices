// C3-07 Stage 8 — HCPS DEMAND INTELLIGENCE (staff only): what retail customers look at across dealer storefronts.
//   POST + Bearer <staff JWT>
//     {action:"overview", days?:7|30|90|365}   -> {ok, installed, days, since, ...report}     (Connect 360 → Demand Intelligence;
//                                                  Command Center card)
//     {action:"dealer", dealer_id, days?}       -> {ok, installed, storefront, ...report for that dealer}   (Dealer 360 card)
// WHO: management and Relations see every dealer; a rep only the dealers in their book (_scope.dealerScope). Interest is
// anonymous (storefront_daily_counts: views and "Request information" counts — D4); inquiry CONTACTS belong to the dealer and
// are never read here. Interest is never presented as a sale (_demand.js). Read-only; no AI; no outreach.
'use strict';
const DM = require('./_demand.js');
const SC = require('./_scope.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOG_FILE = { 'ohio-medical': 'gce' };

async function sbGet(p) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H() }); const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; } return t ? JSON.parse(t) : null; }
async function sbAll(base) { let from = 0, out = []; for (;;) { const rows = await sbGet(`${base}${base.includes('?') ? '&' : '?'}limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) break; from += 1000; } return out; }
async function whoami(event) {
  const tok = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null;
    const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if (!email) return null;
    const s = await sbGet(`staff_users?email=eq.${enc(email)}&select=*`); const su = s && s[0];
    return su && su.active !== false ? { role: su.role || 'rep', rep_name: su.rep_name || '', name: su.name || email, email } : null;
  } catch (e) { return null; }
}
const CACHE = new Map();
async function cached(key, ms, fn) { const c = CACHE.get(key); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); CACHE.set(key, { at: Date.now(), v }); return v; }
async function catalogNames(slug) {
  return cached('cat:' + slug, 600000, async () => { try { const r = await fetch(`${ORDERING_BASE}/data/${enc(CATALOG_FILE[slug] || slug)}.json`); if (!r.ok) return {}; const a = await r.json(); const o = {}; for (const p of (Array.isArray(a) ? a : [])) if (p && p.code) o[String(p.code)] = String(p.name || '').slice(0, 200); return o; } catch (e) { return {}; } });
}
function chicagoDay(offsetDays) { const d = new Date(Date.now() - offsetDays * 86400000); try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d); } catch (e) { return d.toISOString().slice(0, 10); } }

async function report(me, days, onlyDealer, event) {
  const since = chicagoDay(days - 1);
  let counts;
  try { counts = await sbAll(`storefront_daily_counts?day=gte.${since}${onlyDealer ? `&dealer_id=eq.${enc(onlyDealer)}` : ''}&select=day,dealer_id,manufacturer,code,category,views,inquiries&order=day.asc`); }
  catch (e) { if (/PGRST205|42P01/.test(String(e.message))) return { installed: false }; throw e; }
  const dl = await sbAll('dealers?select=id,business_name,city,state,parent_id,is_test&order=id.asc');
  const dealers = new Map((dl || []).map((d) => [String(d.id), { name: d.business_name || '', city: d.city || '', state: d.state || '', root: String(d.parent_id || d.id), is_test: d.is_test === true }]));
  // My Sales Workspace narrows to the President's own book (rule 16), the same resolver a rep gets
  const scope = SC.workspaceMine(event, me) ? await SC.ownBook(me, (p) => sbGet(p)) : await SC.dealerScope(me, (p) => sbGet(p));
  const scopeIds = scope.isAll ? null : new Set([...scope.ids].map(String));
  const mfrs = [...new Set(counts.map((c) => c.manufacturer))];
  const [mrows, nameRows] = await Promise.all([sbGet('manufacturers?select=slug,name'), Promise.all(mfrs.map(async (m) => [m, await catalogNames(m)]))]);
  const mfrName = {}; for (const m of mrows || []) mfrName[m.slug] = m.name || m.slug;
  const names = {}; for (const [m, n] of nameRows) names[m] = n;
  // ordering (12 months) — never interest. Network: how many dealer COMPANIES (families) bought each product, from
  // manufacturer-reported purchases (either lane — a company is counted once, no amounts are added). "Not ordered" is judged
  // for the dealer's whole family: its purchases plus its live portal orders (cancelled and test orders don't count).
  const y = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 7) + '-01';
  const network = new Map(), bought = new Map();
  const activeRoots = new Set(counts.map((c) => (dealers.get(String(c.dealer_id)) || {}).root).filter(Boolean));
  const addBought = (root, k) => (bought.get(root) || bought.set(root, new Set()).get(root)).add(k);
  if (mfrs.length) {
    const sales = await sbAll(`monthly_sales?period=gte.${y}&manufacturer=in.(${mfrs.map(enc).join(',')})&select=dealer_id,manufacturer,product_code&order=id.asc`);
    const comp = new Map();
    for (const s of sales) {
      const d = dealers.get(String(s.dealer_id)); if (!d || d.is_test || !s.product_code) continue;
      const k = s.manufacturer + '|' + s.product_code; (comp.get(k) || comp.set(k, new Set()).get(k)).add(d.root);
      if (activeRoots.has(d.root)) addBought(d.root, k);
    }
    for (const [k, x] of comp) network.set(k, { dealers: x.size });
    const members = [...dealers.entries()].filter(([, d]) => activeRoots.has(d.root)).map(([id]) => id);
    for (let i = 0; i < members.length; i += 100) {     // batches keep the address short however many storefronts there are
      const ids = members.slice(i, i + 100);
      const orders = await sbAll(`orders?dealer_id=in.(${ids.map(enc).join(',')})&submitted_at=gte.${y}&status=neq.cancelled&env=eq.live&select=id,dealer_id,manufacturer,order_items(code)&order=id.asc`);
      for (const o of orders) { const d = dealers.get(String(o.dealer_id)); if (d) for (const it of (o.order_items || [])) addBought(d.root, o.manufacturer + '|' + it.code); }
    }
  }
  return Object.assign({ installed: true, days, since }, DM.build({ counts, dealers, names, mfrName, scopeIds, bought, network }));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  const me = await whoami(event); if (!me) return json(401, { ok: false, error: 'Please sign in again.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  const days = [7, 30, 90, 365].includes(Number(b.days)) ? Number(b.days) : 30;
  try {
    if (b.action === 'overview') return json(200, Object.assign({ ok: true }, await report(me, days, null, event)));
    if (b.action === 'dealer') {
      if (!UUID.test(String(b.dealer_id || ''))) return json(404, { ok: false, error: 'Unknown dealer.' });
      const scope = SC.workspaceMine(event, me) ? await SC.ownBook(me, (p) => sbGet(p)) : await SC.dealerScope(me, (p) => sbGet(p));
      if (!scope.isAll && !scope.ids.has(String(b.dealer_id))) return json(403, { ok: false, error: 'Not your dealer.' });
      let sf = null; try { const r = await sbGet(`dealer_storefronts?dealer_id=eq.${enc(b.dealer_id)}&select=slug,enabled,hcps_blocked,updated_at`); sf = (r && r[0]) || null; } catch (e) { if (!/PGRST205|42P01/.test(String(e.message))) throw e; }
      const rep = await report(me, days, String(b.dealer_id), event);
      return json(200, Object.assign({ ok: true, storefront: sf && { link: `${ORDERING_BASE}/store/${sf.slug}`, live: !!(sf.enabled && !sf.hcps_blocked), blocked: !!sf.hcps_blocked } }, rep));
    }
    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('demand intel failed', e && (e.status || e.message));
    return json(503, { ok: false, error: 'Demand figures could not be loaded just now — please try again.' });
  }
};
