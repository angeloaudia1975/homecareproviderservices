// C3-07 Stage 7 — a dealer's PUBLIC storefront (no sign-in; called by hcpsonlineordering.netlify.app/store/<slug>).
//   GET  ?s=<slug>                                   -> {ok, dealer, lines, products, privacy}   (only when the dealer turned it on
//                                                       and HCPS hasn't blocked it)
//   POST {action:"view", s, items:[{manufacturer,code}]}   -> {ok}   anonymous daily product counts (D4; ≤40 a call; only
//                                                       products this storefront shows)
//   POST {action:"inquiry", s, name, email?, phone?, message?, product?, consent:true, hp:""} -> {ok}
//        stored for the dealer (24 months, D4) and emailed to the dealer's storefront address with the customer as reply-to.
//        All limits are checked and the row written in ONE database call (storefront_inquiry_add — no race): per visitor 3 an
//        hour / 8 a day, per email or phone 3 a day, 200 stored a storefront a day; at most 10 emailed a storefront an hour
//        (the rest wait in My Storefront). The hidden "hp" field must stay empty.
// A visitor is known to the limits only as a keyed hash of the network address (x-nf-client-connection-ip — never
// X-Forwarded-For, which a visitor can set), kept 2 days; the address itself is never stored.
// NO CHECKOUT, NO PRICES BUT VERIFIED MSRP / "Call for Price" (D3), NO wholesale, account, contract or other-dealer data:
// products pass _storefront.publicProduct's whitelist. Nothing about a visitor is stored. Strict: if the catalog or the
// commercial records can't be read the page says so (503) — never a list that might show discontinued products.
'use strict';
const crypto = require('crypto');
const SF = require('./_storefront.js');
const RETIRED = require('./_retired_lines.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (c, o, cache) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': cache || 'no-store', 'x-robots-tag': 'noindex', ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
const GOLDEN = new Set(['golden-technologies', 'golden']);
const CATALOG_FILE = { 'ohio-medical': 'gce' };
const NOT_AVAILABLE = 'This storefront isn\'t available.';
const PRIVACY = 'Your request is sent only to this dealer, who uses it to answer you. It is kept for up to 24 months and then deleted; ask the dealer to delete it sooner. This site sets no tracking cookies; product views are counted anonymously.';

async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
const CACHE = new Map(), CACHE_MAX = 200;
/* a short cache; never holds "not found" (a storefront just switched on shows at once) and never grows past CACHE_MAX */
async function cached(key, ms, fn) {
  const c = CACHE.get(key); if (c && Date.now() - c.at < ms) return c.v;
  const v = await fn(); if (v == null) { CACHE.delete(key); return v; }
  CACHE.delete(key); CACHE.set(key, { at: Date.now(), v }); while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return v;
}
function clientKey(event) {
  const h = event.headers || {}; const ip = String(h['x-nf-client-connection-ip'] || '').trim().slice(0, 64);
  if (!ip) return 'none';
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHmac('sha256', String(SERVICE_ROLE)).update('storefront|' + day + '|' + ip).digest('hex').slice(0, 32);
}
/* every row of a read, a page at a time — a full page is never taken as the whole answer */
async function sbAll(base) { let from = 0, out = []; for (;;) { const rows = await sb('GET', `${base}&limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) return out; from += 1000; } }

async function catalogFile(slug) {
  return cached('cat:' + slug, 600000, async () => {
    const r = await fetch(`${ORDERING_BASE}/data/${enc(CATALOG_FILE[slug] || slug)}.json`);
    if (r.status === 404) return [];
    if (!r.ok) { const e = new Error('catalog ' + r.status); e.status = 503; throw e; }
    const a = await r.json(); if (!Array.isArray(a)) { const e = new Error('catalog shape'); e.status = 503; throw e; } return a;
  });
}
/* everything the public page needs for one storefront (30-second cache per storefront) */
async function storefront(slug) {
  return cached('sf:' + slug, 30000, async () => {
    const r = await sb('GET', `dealer_storefronts?slug=eq.${enc(slug)}&select=id,dealer_id,company_id,slug,enabled,hcps_blocked,headline,about,phone,email,hours,show_address,lines,hidden_categories,price_mode`);
    const sf = r && r[0]; if (!sf || !sf.enabled || sf.hcps_blocked) return null;
    const [d, dms, names, metas] = await Promise.all([
      sb('GET', `dealers?id=eq.${enc(sf.dealer_id)}&select=id,business_name,address,city,state,zip,active,parent_id`),
      sb('GET', `dealer_manufacturers?dealer_id=eq.${enc(sf.dealer_id)}&active=eq.true&select=manufacturer`),
      sb('GET', 'manufacturers?select=slug,name'), sb('GET', 'manufacturer_meta?select=slug,active,enriched_only')]);
    const loc = d && d[0]; if (!loc || loc.active === false) return null;            // a closed location is never public
    for (const hid of [loc.parent_id, sf.company_id].filter((x) => x && String(x) !== String(loc.id))) {
      const h = await sb('GET', `dealers?id=eq.${enc(hid)}&select=active`); if (!(h && h[0]) || h[0].active === false) return null;   // nor one whose head office is
    }
    let logo = null;
    for (const id of [sf.dealer_id, sf.company_id]) { try { const x = await sb('GET', `dealers?id=eq.${enc(id)}&select=logo_url`); const u = x && x[0] && x[0].logo_url; if (u && SF.logoOk(u, SUPABASE_URL)) { logo = u; break; } } catch (e) { /* no logo column */ } }
    const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug)), enrOnly = new Set((metas || []).filter((m) => m.enriched_only === true).map((m) => m.slug)), nm = new Map((names || []).map((m) => [m.slug, m.name || m.slug]));
    let lines = [...new Set((dms || []).map((x) => String(x.manufacturer || '')))].filter((s) => s && !GOLDEN.has(s) && !off.has(s) && !RETIRED.isRetiredLine(s));
    if (Array.isArray(sf.lines)) lines = lines.filter((s) => sf.lines.includes(s));
    const hiddenCats = new Set((sf.hidden_categories || []).map((x) => String(x).toLowerCase()));
    const products = [], lineList = [];
    for (const line of lines) {
      const q = `manufacturer=eq.${enc(line)}`;
      const [file, records, overrides, custom, pages] = await Promise.all([catalogFile(line),
        sbAll(`product_skus?${q}&select=code,msrp,msrp_auto,status&order=code.asc`), sbAll(`product_overrides?${q}&select=code,patch&order=code.asc`),
        sbAll(`custom_products?${q}&select=code,msrp,msrp_auto&order=code.asc`), sbAll(`product_content?${q}&select=page_key,status,disabled,skus&order=page_key.asc`)]);
      const facts = SF.lineFacts({ records, overrides, custom, pages, enrichedOnly: enrOnly.has(line) });
      let n = 0;
      for (const p of file) {
        if (!p || !p.code || facts.isHidden(p.code) || p.active === false || p.discontinued === true) continue;
        const pp = SF.publicProduct(p, line, facts, sf.price_mode);
        if (hiddenCats.has(pp.category.toLowerCase())) continue;
        products.push(pp); n++; if (products.length >= 6000) break;
      }
      if (n) lineList.push({ slug: line, name: nm.get(line) || line, count: n });
    }
    return { sf, codes: new Set(products.map((p) => p.manufacturer + '|' + p.code)), public: {
      dealer: { name: loc.business_name || '', headline: sf.headline || '', about: sf.about || '', hours: sf.hours || '', logo,
        phone: sf.phone || '', email: sf.email || '',            // only contact details the dealer entered for the storefront
        address: sf.show_address ? { street: loc.address || '', city: loc.city || '', state: loc.state || '', zip: loc.zip || '' } : { city: loc.city || '', state: loc.state || '' } },
      lines: lineList, products, price_note: sf.price_mode === 'msrp' ? 'Prices shown are the manufacturer\'s suggested retail price (MSRP). Call the dealer for current pricing and availability.' : 'Call the dealer for pricing and availability.',
      privacy: PRIVACY } };
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  try {
    if (event.httpMethod === 'GET') {
      const slug = String((event.queryStringParameters || {}).s || '').toLowerCase();
      if (!SLUG.test(slug)) return json(404, { ok: false, error: NOT_AVAILABLE });
      const S = await storefront(slug); if (!S) return json(404, { ok: false, error: NOT_AVAILABLE });
      return json(200, Object.assign({ ok: true }, S.public), 'public, max-age=30');
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false });
    if (String(event.body || '').length > 20000) return json(413, { ok: false, error: 'Too long.' });
    let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false }); }
    const slug = String(b.s || '').toLowerCase(); if (!SLUG.test(slug)) return json(404, { ok: false, error: NOT_AVAILABLE });
    const S = await storefront(slug); if (!S) return json(404, { ok: false, error: NOT_AVAILABLE });
    const find = (m, c) => S.public.products.find((x) => x.manufacturer === String(m) && x.code === String(c));
    const client = clientKey(event);
    if (b.action === 'view') {
      const seen = new Set(), items = [];
      for (const it of Array.isArray(b.items) ? b.items.slice(0, 40) : []) {
        const p = it && typeof it === 'object' ? find(it.manufacturer, it.code) : null; if (!p || seen.has(p.manufacturer + '|' + p.code)) continue;
        seen.add(p.manufacturer + '|' + p.code); items.push({ manufacturer: p.manufacturer, code: p.code, category: p.category });
      }
      if (items.length) await sb('POST', 'rpc/storefront_count', { p_dealer: S.sf.dealer_id, p_items: items, p_client: client });
      return json(200, { ok: true });
    }
    if (b.action === 'inquiry') {
      const v = SF.validateInquiry(b); if (v.spam) return json(200, { ok: true }); if (v.error) return json(400, { ok: false, error: v.error });
      const p = v.row.manufacturer ? find(v.row.manufacturer, v.row.product_code) : null;
      if (p) { v.row.product_name = p.name; v.row.category = p.category; } else { v.row.manufacturer = null; v.row.product_code = null; v.row.product_name = null; }
      const res = await sb('POST', 'rpc/storefront_inquiry_add', { p_storefront: S.sf.id, p_row: v.row, p_client: client });
      if (res && res.refused) {
        if (res.refused === 'unavailable') { CACHE.delete('sf:' + slug); return json(404, { ok: false, error: NOT_AVAILABLE }); }
        if (res.refused === 'contact') return json(429, { ok: false, error: 'You have already sent several requests today — the dealer will be in touch.' });
        return json(429, { ok: false, error: 'Too many requests just now — please call the dealer instead, or try again later.' });
      }
      const to = res && res.send && res.to;     // read inside the same database call: a storefront switched off or re-addressed is honoured at once
      if (to && SF.EMAIL_RE.test(to) && process.env.RESEND_API_KEY) {
        try {
          const m = SF.inquiryEmail(v.row, S.sf, S.public.dealer.name, `${ORDERING_BASE}/store/${slug}`);
          const from = process.env.HCPS_MAIL_FROM || 'HomeCare Provider Services <orders@homecareproviderservices.us>';
          const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ from, to: [to], subject: m.subject, html: m.html }, v.row.email ? { reply_to: v.row.email } : {})) });
          if (r.ok && res.id) await sb('PATCH', `storefront_inquiries?id=eq.${enc(res.id)}`, { notified: true }, { Prefer: 'return=minimal' });
        } catch (e) { console.error('inquiry email failed', e && e.message); }   // the request is stored either way; the dealer sees it in My Storefront
      }
      return json(200, { ok: true });
    }
    return json(400, { ok: false });
  } catch (e) {
    if (/PGRST205|42P01/.test(String(e && e.message)) && /storefront/.test(String(e && e.message))) return json(404, { ok: false, error: NOT_AVAILABLE });
    console.error('storefront public failed', e && (e.status || e.message));
    return json(503, { ok: false, error: 'This storefront can\'t be shown just now — please try again shortly.' });
  }
};
module.exports._test = { CACHE, clientKey, cached };
