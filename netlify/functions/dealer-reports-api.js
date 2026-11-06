// C3-07 Stage 6 — DEALER & BRANCH REPORTS for the 360 Dealer Portal's Reports section.
//   POST + Bearer <dealer JWT>  (or Bearer preview:<token> — HCPS staff's read-only dealer preview)
//     {action:"report", scope:"company"|<location id>, year?}   -> {ok, report, locations, head_office, scope, scope_name}
//     {action:"report_pdf", scope, year?}                      -> {ok, pdf_base64, file}
//     {action:"report_ai", scope, year?}                       -> {ok, recommendations:[{title, detail, refs}], facts}
// WHO SEES WHAT: the same rule as Account Center and quotes (_account_center.visibleLocations). A head office sees its company
// (or the locations its login is limited to); a branch login sees only its own location. "company" = every visible location.
// DATA: manufacturer-reported purchases (monthly_sales), portal orders, saved quotes, the current catalog (categories) and an
// anonymous network view (other dealers' ordering, ≥3 dealers per product, TEST dealers and this company left out, no names
// or figures returned). Everything is computed by _dealer_report.js; nothing here estimates costs, margins or traffic.
// STRICT: purchases or orders that can't be read answer 503 — never a report with history silently missing.
// AI: only on request (never on page load), every recommendation must cite the report's facts and use only their numbers
// (_dealer_report.checkRecommendations); writes nothing. ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE, ANTHROPIC_API_KEY, HCPS_AI_MODEL.
'use strict';
const AC = require('./_account_center.js');
const REP = require('./_dealer_report.js');
const RETIRED = require('./_retired_lines.js');
const STYLE = require('./_ai_style.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOG_FILE = { 'ohio-medical': 'gce' };   // the storefront's file name where it differs from the slug

async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function sbAll(base) {
  let from = 0, out = [];
  for (;;) { const rows = await sb('GET', `${base}${base.includes('?') ? '&' : '?'}limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) break; from += 1000; }
  return out;
}
async function dealerFromToken(event) {
  const raw = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!raw) return null;
  if (/^preview:/i.test(raw)) {   // HCPS staff's read-only preview of a dealer (same token as My Orders)
    const token = raw.replace(/^preview:/i, '').trim(); if (!token) return null;
    const rows = await sb('GET', `dealer_preview_tokens?token=eq.${enc(token)}&select=dealer_id,expires_at`); const t = rows && rows[0];
    if (!t || !t.dealer_id || (t.expires_at && new Date(t.expires_at).getTime() < Date.now())) return null;
    return { dealer_id: t.dealer_id, uid: null, preview: true };
  }
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${raw}` } });
  if (!ur.ok) return null; const u = await ur.json();
  const rows = await sb('GET', `dealer_users?uid=eq.${enc(u.id)}&select=status,dealer_id`); const du = rows && rows[0];
  if (!du || du.status !== 'approved' || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, uid: u.id };
}
function chicagoToday() { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; } catch (e) { return new Date().toISOString().slice(0, 10); } }

/* shared, slowly-changing inputs: cached for 10 minutes per function instance */
const CACHE = new Map();
async function cached(key, ms, fn) { const c = CACHE.get(key); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); CACHE.set(key, { at: Date.now(), v }); return v; }
async function catalogFor(slug) {
  return cached('cat:' + slug, 600000, async () => {
    try { const r = await fetch(`${ORDERING_BASE}/data/${enc(CATALOG_FILE[slug] || slug)}.json`); if (!r.ok) return null;
      const arr = await r.json(); if (!Array.isArray(arr)) return null; const o = {};
      for (const p of arr) if (p && p.code) o[String(p.code)] = { name: p.name || '', category: p.category || '' };
      return o; } catch (e) { return null; }
  });
}
async function networkRows(sinceYm) { return cached('net:' + sinceYm, 600000, () => sbAll(`monthly_sales?period=gte.${sinceYm}-01&select=dealer_id,manufacturer,product_code,product_name,qty&order=id.asc`)); }
async function coverageFor(slugs) {
  const out = {};
  await Promise.all(slugs.map(async (s) => { out[s] = await cached('cov:' + s, 600000, async () => { const r = await sb('GET', `monthly_sales?manufacturer=eq.${enc(s)}&select=period&order=period.asc&limit=1`); return r && r[0] ? String(r[0].period).slice(0, 7) : null; }); }));
  return out;
}
async function testDealers() { return cached('test', 600000, async () => new Set(((await sb('GET', 'dealers?is_test=eq.true&select=id')) || []).map((d) => String(d.id)))); }
function addMonthsYm(m, k) { let [y, mo] = m.split('-').map(Number); mo += k; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return y + '-' + String(mo).padStart(2, '0'); }

async function loadAll(who, b) {
  const did = String(who.dealer_id);
  const d = await sb('GET', `dealers?id=eq.${enc(did)}&select=id,parent_id,business_name`); const self = d && d[0];
  if (!self) return { status: 404, error: 'Account not found.' };
  const root = self.parent_id || self.id;
  const fq = `dealers?or=(id.eq.${enc(root)},parent_id.eq.${enc(root)})&select=id,parent_id,business_name,city,state`;
  let family; try { family = await sb('GET', fq + ',active&limit=200'); } catch (e) { if (!/42703/.test(String(e.message))) throw e; family = await sb('GET', fq + '&limit=200'); }
  family = (family || []).filter((x) => x.active !== false || String(x.id) === did);
  let scopeRow = null;
  if (who.uid) { try { const s = await sb('GET', `dealer_user_scope?uid=eq.${enc(who.uid)}&select=scope,locations`); scopeRow = (s && s[0]) || null; } catch (e) { if (!/PGRST205|42P01/.test(String(e.message))) throw e; } }
  const visible = AC.visibleLocations(did, family, scopeRow);
  const locations = visible.map((l) => ({ id: String(l.id), name: l.business_name || '', city: l.city || '', state: l.state || '', is_self: String(l.id) === did, head: !l.parent_id }));
  const headOffice = !self.parent_id && locations.length > 1;
  let scope = String(b.scope || (headOffice ? 'company' : did));
  if (scope === 'company' && !headOffice) scope = did;
  if (scope !== 'company' && !locations.some((l) => l.id === scope)) return { status: 403, error: 'That location is not part of your account.' };
  const ids = scope === 'company' ? locations.map((l) => l.id) : [scope];
  const scopeName = scope === 'company' ? `${self.business_name || 'Company'} — all locations` : (locations.find((l) => l.id === scope) || {}).name || '';
  const today = chicagoToday();
  const year = /^\d{4}$/.test(String(b.year || '')) && Number(b.year) >= 2015 && Number(b.year) <= Number(today.slice(0, 4)) ? String(b.year) : today.slice(0, 4);
  const inIds = ids.map(enc).join(',');
  const [sales, orders, quotesRaw, names, tests] = await Promise.all([
    sbAll(`monthly_sales?dealer_id=in.(${inIds})&select=dealer_id,manufacturer,period,product_code,product_name,qty,amount,source,external_ref&order=id.asc`),
    sb('GET', `orders?dealer_id=in.(${inIds})&select=dealer_id,manufacturer,status,subtotal,submitted_at,order_items(code,qty)&order=submitted_at.desc&limit=3000`),
    sb('GET', `dealer_saved_quotes?dealer_id=eq.${enc(root)}&location_id=in.(${inIds})&select=location_id,status,created_at,lines&limit=2000`).catch((e) => { if (/PGRST205|42P01/.test(String(e.message))) return null; throw e; }),
    sb('GET', 'manufacturers?select=slug,name'),
    testDealers(),
  ]);
  const mfrName = {}; for (const m of names || []) mfrName[m.slug] = m.name || m.slug;
  // anonymous network view: other dealers only (not this company, not TEST dealers), the past 12 months
  const since = addMonthsYm(today.slice(0, 7), -11);
  const familyIds = new Set(family.map((f) => String(f.id)));
  const net = new Map();
  for (const r of await networkRows(since)) {
    const dl = String(r.dealer_id || ''); if (!dl || familyIds.has(dl) || tests.has(dl) || !r.product_code) continue;
    const k = r.manufacturer + '|' + r.product_code; const x = net.get(k) || { manufacturer: r.manufacturer, code: String(r.product_code), name: r.product_name || '', dealerSet: new Set(), units: 0 };
    x.dealerSet.add(dl); x.units += Number(r.qty) || 0; net.set(k, x);
  }
  const network = [...net.values()].map((x) => ({ manufacturer: x.manufacturer, code: x.code, name: x.name, dealers: x.dealerSet.size, units: x.units }));
  const slugs = [...new Set((sales || []).map((r) => r.manufacturer).filter(Boolean))];
  const [coverageStart, cats] = await Promise.all([coverageFor(slugs), Promise.all(slugs.map(async (s) => [s, await catalogFor(s)]))]);
  const catalog = {}; for (const [s, c] of cats) if (c) catalog[s] = c;
  const report = REP.build({ year, today, locations, scope, sales: sales || [], orders: (orders || []).map((o) => Object.assign(o, { items: o.order_items || [] })),
    quotes: quotesRaw || [], catalog, mfrName, coverageStart, network, isRetired: RETIRED.isRetiredLine });
  if (quotesRaw == null) report.notes.push('Saved quotes are not available yet.');
  let brand = { business_name: self.business_name || '', logo_url: null };
  for (const id of [did, String(root)]) { try { const r = await sb('GET', `dealers?id=eq.${enc(id)}&select=logo_url`); if (r && r[0] && r[0].logo_url) { brand.logo_url = r[0].logo_url; break; } } catch (e) { /* no logo column yet */ } }
  if (self.parent_id) { try { const r = await sb('GET', `dealers?id=eq.${enc(root)}&select=business_name`); if (r && r[0]) brand.business_name = r[0].business_name || brand.business_name; } catch (e) {} }
  return { report, locations, headOffice, scope, scopeName, brand, today };
}

const AI_LIMIT = new Map();   // best effort, per function instance: 4 AI runs per dealer per 10 minutes
async function aiRecommendations(L, dealerId) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return { status: 503, error: 'AI suggestions are not available right now.' };
  const now = Date.now(); const hist = (AI_LIMIT.get(dealerId) || []).filter((t) => now - t < 600000);
  if (hist.length >= 4) return { status: 429, error: 'Please wait a few minutes before asking for new suggestions.' };
  hist.push(now); AI_LIMIT.set(dealerId, hist);
  const F = REP.facts(L.report, L.scopeName);
  let guide = ''; try { guide = await STYLE.loadStyleGuide((p) => sb('GET', p)); } catch (e) { guide = STYLE.STYLE_GUIDE || ''; }
  const prompt = `You are a knowledgeable HomeCare Provider Services (HCPS) representative writing short, practical growth suggestions for a home medical equipment dealer, based ONLY on these facts from their HCPS report.\n\nFACTS (id: text):\n${F.map((f) => `${f.id}: ${f.text}`).join('\n')}\n\nRULES:\n- Give 3 to 5 suggestions. Each must cite the fact ids it relies on in "refs".\n- Use only numbers that appear in the facts; do not calculate new totals, percentages, margins, costs, forecasts or customer counts.\n- Purchases are manufacturer-reported; portal orders and quotes are activity, not sales. Opportunities are what other dealers order — say so, never claim they will sell.\n- No pricing promises, discounts or medical claims. Plain, confident, helpful; no hype.\n\nStyle guide:\n${guide}\n\nAnswer with minified JSON only: {"recommendations":[{"title":"…","detail":"…","refs":["id"]}]}`;
  const send = (thinking) => fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ model: process.env.HCPS_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }, thinking ? { thinking } : {})) });
  for (let attempt = 0; attempt < 2; attempt++) {
    let r = await send({ type: 'disabled' }); let t = await r.text();
    if (r.status === 400 && /thinking/i.test(t)) { r = await send(null); t = await r.text(); }
    if (!r.ok) continue;
    let text = ''; try { for (const c of (JSON.parse(t).content || [])) if (c && typeof c.text === 'string') text += c.text; } catch (e) {}
    const s = text.indexOf('{'), e = text.lastIndexOf('}'); let raw = null; try { raw = JSON.parse(text.slice(s, e + 1)); } catch (x) {}
    const recs = REP.checkRecommendations(raw && raw.recommendations, F).filter((x) => !STYLE.findBanned(x.title + ' ' + x.detail).length);
    if (recs.length) return { recommendations: recs, facts: F };
  }
  return { status: 502, error: 'No suggestions could be checked against your figures just now — please try again later.' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  if (b.scope != null && b.scope !== 'company' && !UUID.test(String(b.scope))) return json(400, { ok: false, error: 'Unknown location.' });
  let who; try { who = await dealerFromToken(event); } catch (e) { return json(503, { ok: false, error: 'Please try again in a moment.' }); }
  if (!who) return json(401, { ok: false, error: 'Please sign in again.' });
  if (!['report', 'report_pdf', 'report_ai'].includes(b.action)) return json(400, { ok: false, error: 'unknown action' });
  if (b.action === 'report_ai' && who.preview) return json(403, { ok: false, error: 'AI suggestions are not available in preview.' });
  let L;
  try { L = await loadAll(who, b); } catch (e) { console.error('report read failed', e && e.message); return json(503, { ok: false, error: 'Your report could not be loaded just now — please try again.' }); }
  if (L.error) return json(L.status, { ok: false, error: L.error });
  try {
    if (b.action === 'report') return json(200, { ok: true, report: L.report, locations: L.locations, head_office: L.headOffice, scope: L.scope, scope_name: L.scopeName });
    if (b.action === 'report_pdf') {
      const PDF = require('./_report_pdf.js');
      const generated = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric' });
      const bytes = await PDF.render({ report: L.report, dealer: L.brand, scopeName: L.scopeName, generated });
      return json(200, { ok: true, pdf_base64: bytes.toString('base64'), file: `hcps-dealer-report-${L.report.period.year}.pdf` });
    }
    const r = await aiRecommendations(L, String(who.dealer_id));
    if (r.error) return json(r.status, { ok: false, error: r.error });
    return json(200, { ok: true, recommendations: r.recommendations, facts: r.facts });
  } catch (e) {
    console.error('report failed', e && (e.message || e.status));
    return json(503, { ok: false, error: 'That could not be completed just now — please try again.' });
  }
};
module.exports._test = { loadAll, CACHE, AI_LIMIT };
