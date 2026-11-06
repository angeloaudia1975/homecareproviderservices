// C3-07 Stage 7 — a dealer's PUBLIC storefront (no sign-in; called by hcpsonlineordering.netlify.app/store/<slug>).
//   GET  ?s=<slug>                                   -> {ok, dealer, lines, products, privacy}   (only when the dealer turned it on
//                                                       and HCPS hasn't blocked it)
//   POST {action:"view", s, items:[{manufacturer,code}]}   -> {ok}   anonymous daily product counts (D4; ≤40 a call; only
//                                                       products this storefront shows)
//   POST {action:"inquiry", s, name, email?, phone?, message?, product?, consent:true, hp:""} -> {ok}
//        stored for the dealer (24 months, D4) and emailed to the dealer's storefront address with the customer as reply-to.
//        Limits: 10 a storefront an hour, 3 from one email address a day; the hidden "hp" field must stay empty.
// NO CHECKOUT, NO PRICES BUT VERIFIED MSRP / "Call for Price" (D3), NO wholesale, account, contract or other-dealer data:
// products pass _storefront.publicProduct's whitelist. Nothing about a visitor is stored. Strict: if the catalog or the
// commercial records can't be read the page says so (503) — never a list that might show discontinued products.
'use strict';
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
async function countRows(p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}&select=id`, { headers: { ...H(), Prefer: 'count=exact', Range: '0-0' } });
  if (!r.ok) { const e = new Error('count ' + r.status); e.status = 503; throw e; }
  const n = Number(String(r.headers.get('content-range') || '').split('/')[1]); return Number.isFinite(n) ? n : 0;
}
const CACHE = new Map();
async function cached(key, ms, fn) { const c = CACHE.get(key); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); CACHE.set(key, { at: Date.now(), v }); return v; }

async function catalogFile(slug) {
  return cached('cat:' + slug, 600000, async () => {
    const r = await fetch(`${ORDERING_BASE}/data/${enc(CATALOG_FILE[slug] || slug)}.json`);
    if (r.status === 404) return [];
    if (!r.ok) { const e = new Error('catalog ' + r.status); e.status = 503; throw e; }
    const a = await r.json(); if (!Array.isArray(a)) { const e = new Error('catalog shape'); e.status = 503; throw e; } return a;
  });
}
/* everything the public page needs for one storefront (5-minute cache per storefront) */
async function storefront(slug) {
  return cached('sf:' + slug, 300000, async () => {
    const r = await sb('GET', `dealer_storefronts?slug=eq.${enc(slug)}&select=id,dealer_id,company_id,slug,enabled,hcps_blocked,headline,about,phone,email,hours,show_address,lines,hidden_categories,price_mode`);
    const sf = r && r[0]; if (!sf || !sf.enabled || sf.hcps_blocked) return null;
    const [d, dms, names, metas] = await Promise.all([
      sb('GET', `dealers?id=eq.${enc(sf.dealer_id)}&select=id,business_name,address,city,state,zip,email,phone`),
      sb('GET', `dealer_manufacturers?dealer_id=eq.${enc(sf.dealer_id)}&active=eq.true&select=manufacturer`),
      sb('GET', 'manufacturers?select=slug,name'), sb('GET', 'manufacturer_meta?select=slug,active')]);
    const loc = d && d[0]; if (!loc) return null;
    let logo = null;
    for (const id of [sf.dealer_id, sf.company_id]) { try { const x = await sb('GET', `dealers?id=eq.${enc(id)}&select=logo_url`); const u = x && x[0] && x[0].logo_url; if (u && (/^https:\/\/[^\s"'<>`]{1,1900}$/.test(u) || /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(u))) { logo = u; break; } } catch (e) { /* no logo column */ } }
    const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug)), nm = new Map((names || []).map((m) => [m.slug, m.name || m.slug]));
    let lines = [...new Set((dms || []).map((x) => String(x.manufacturer || '')))].filter((s) => s && !GOLDEN.has(s) && !off.has(s) && !RETIRED.isRetiredLine(s));
    if (Array.isArray(sf.lines)) lines = lines.filter((s) => sf.lines.includes(s));
    const hiddenCats = new Set((sf.hidden_categories || []).map((x) => String(x).toLowerCase()));
    const products = [], lineList = [];
    for (const line of lines) {
      const q = `manufacturer=eq.${enc(line)}`;
      const [file, records, overrides, custom] = await Promise.all([catalogFile(line),
        sb('GET', `product_skus?${q}&select=code,msrp,msrp_auto,status&limit=5000`), sb('GET', `product_overrides?${q}&select=code,patch&limit=5000`), sb('GET', `custom_products?${q}&select=code,msrp,msrp_auto&limit=5000`)]);
      const facts = SF.lineFacts({ records, overrides, custom });
      let n = 0;
      for (const p of file) {
        if (!p || !p.code || facts.hidden.has(String(p.code)) || p.active === false || p.discontinued === true) continue;
        const pp = SF.publicProduct(p, line, facts, sf.price_mode);
        if (hiddenCats.has(pp.category.toLowerCase())) continue;
        products.push(pp); n++; if (products.length >= 6000) break;
      }
      if (n) lineList.push({ slug: line, name: nm.get(line) || line, count: n });
    }
    return { sf, codes: new Set(products.map((p) => p.manufacturer + '|' + p.code)), public: {
      dealer: { name: loc.business_name || '', headline: sf.headline || '', about: sf.about || '', hours: sf.hours || '', logo,
        phone: sf.phone || loc.phone || '', email: sf.email || loc.email || '',
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
      return json(200, Object.assign({ ok: true }, S.public), 'public, max-age=120');
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false });
    if (String(event.body || '').length > 20000) return json(413, { ok: false, error: 'Too long.' });
    let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false }); }
    const slug = String(b.s || '').toLowerCase(); if (!SLUG.test(slug)) return json(404, { ok: false, error: NOT_AVAILABLE });
    const S = await storefront(slug); if (!S) return json(404, { ok: false, error: NOT_AVAILABLE });
    const known = (it) => it && S.codes.has(String(it.manufacturer) + '|' + String(it.code));
    if (b.action === 'view') {
      const items = (Array.isArray(b.items) ? b.items.slice(0, 40) : []).filter(known).map((it) => { const p = S.public.products.find((x) => x.manufacturer === it.manufacturer && x.code === String(it.code)); return { manufacturer: p.manufacturer, code: p.code, category: p.category }; });
      if (items.length) await sb('POST', 'rpc/storefront_count', { p_dealer: S.sf.dealer_id, p_items: items, p_kind: 'view' });
      return json(200, { ok: true });
    }
    if (b.action === 'inquiry') {
      const v = SF.validateInquiry(b); if (v.spam) return json(200, { ok: true }); if (v.error) return json(400, { ok: false, error: v.error });
      if (v.row.manufacturer && !known({ manufacturer: v.row.manufacturer, code: v.row.product_code })) { v.row.manufacturer = null; v.row.product_code = null; v.row.product_name = null; }
      const hourAgo = new Date(Date.now() - 3600000).toISOString(), dayAgo = new Date(Date.now() - 86400000).toISOString();
      if (await countRows(`storefront_inquiries?storefront_id=eq.${enc(S.sf.id)}&created_at=gte.${enc(hourAgo)}`) >= 10) return json(429, { ok: false, error: 'This dealer has received many requests in the last hour — please call them instead, or try again later.' });
      if (v.row.email && await countRows(`storefront_inquiries?email=eq.${enc(v.row.email)}&created_at=gte.${enc(dayAgo)}`) >= 3) return json(429, { ok: false, error: 'You have already sent several requests today — the dealer will be in touch.' });
      const ins = await sb('POST', 'storefront_inquiries', Object.assign({ storefront_id: S.sf.id, dealer_id: S.sf.dealer_id }, v.row), { Prefer: 'return=representation' });
      const row = ins && ins[0];
      if (v.row.manufacturer) { try { await sb('POST', 'rpc/storefront_count', { p_dealer: S.sf.dealer_id, p_items: [{ manufacturer: v.row.manufacturer, code: v.row.product_code }], p_kind: 'inquiry' }); } catch (e) { /* a count never fails a request */ } }
      const to = S.public.dealer.email;
      if (to && SF.EMAIL_RE.test(to) && process.env.RESEND_API_KEY) {
        try {
          const m = SF.inquiryEmail(v.row, S.sf, S.public.dealer.name, `${ORDERING_BASE}/store/${slug}`);
          const from = process.env.HCPS_MAIL_FROM || 'HomeCare Provider Services <orders@homecareproviderservices.us>';
          const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ from, to: [to], subject: m.subject, html: m.html }, v.row.email ? { reply_to: v.row.email } : {})) });
          if (r.ok && row) await sb('PATCH', `storefront_inquiries?id=eq.${enc(row.id)}`, { notified: true }, { Prefer: 'return=minimal' });
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
module.exports._test = { CACHE };
