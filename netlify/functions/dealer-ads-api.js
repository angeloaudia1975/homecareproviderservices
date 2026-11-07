// CATALOG 4 §8 — SOCIAL MEDIA AD BUILDER (360 Dealer Portal → Social Ads).
//   POST + Bearer <dealer JWT>  (a HCPS preview token may only read)
//     {action:"ads_context", location_id?}  -> {ok, locations, location, dealer, products, templates, formats, fonts, ctas, publishing}
//     {action:"ads_list"}                   -> {ok, ads:[{id, dealer_id, title, template, format, products, updated_at, updated_by}]}
//     {action:"ads_get", id}                -> {ok, ad, row, products:[rendered], problems:[…]}
//     {action:"ads_save", id?, version?, location_id, ad} -> {ok, row}        (create, or compare-and-set on version)
//     {action:"ads_duplicate", id}          -> {ok, row}
//     {action:"ads_archive", id}            -> {ok}
//     {action:"ads_check", location_id, ad}  -> {ok, products} | 400 {error, field}   (the download gate — nothing stored)
//     {action:"ads_suggest", location_id, products, cta?} -> {ok, captions, hashtags}
//     {action:"ad_image", location_id, manufacturer, code} | {action:"ad_image", location_id, logo:true}
//                                           -> {ok, data_url}  (the official photo / the dealer's own logo, fetched by the
//                                              server so the editor's canvas can export it; only photos of the location's
//                                              authorized products and only the account's own logo — never a typed URL)
// Products = exactly the location's public storefront product set (_storefront_catalog.build): active Dealer Manager lines
// only, discontinued / hidden / switched-off never, official photos and descriptions, the advertised price under the
// line's advertising (MAP) rules or "Call for Price". The ad stores product references; prices are re-resolved on every read.
// Words are checked by _social_ads.claimProblem (no prices, discounts, promotions or claims typed by hand).
// WHO: the same D2 scope as My Storefront — a head office manages its visible locations' ads; a branch login only its own.
// Publishing to social networks is NOT here (dealer-social-api; off until the platforms approve the apps).
'use strict';
const AC = require('./_account_center.js');
const ADS = require('./_social_ads.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING = (e) => /PGRST205|42P01/.test(String(e && e.message)) && /dealer_social/.test(String(e && e.message));
const ROW = 'id,company_id,dealer_id,title,ad,version,created_by,created_at,updated_by,updated_at,archived_at';
const GOLDEN_IMG = /^https:\/\/(d3325uqufdmhie\.cloudfront\.net|cdn\.wdgtsrc\.com|goldenonlineordering\.netlify\.app|goldentech\.com|www\.goldentech\.com)\/[^'"\s<>\\`]{1,500}$/;
const OWN_IMG = /^\/assets\/[A-Za-z0-9._\/%+-]{1,300}$/;
const IMG_MAX = 4 * 1024 * 1024;
const SP = require('./_social_publish.js');
const crypto = require('crypto');
const POST_ROW = 'id,company_id,dealer_id,ad_id,caption,format,media_path,media_sha256,platforms,scheduled_at,status,approved_by,approved_at,version,attempts,next_attempt_at,last_error,updated_at';
const CONN_ROW = 'id,dealer_id,platform,external_id,account_name,status,token_expires_at,authorized_by,authorized_at,revoked_at,last_error';
const envNow = () => process.env;
const SELF_BASE = (process.env.URL || 'https://homecareproviderservices.netlify.app').replace(/\/+$/, '');

async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function sbAll(base) { let from = 0, out = []; for (;;) { const rows = await sb('GET', `${base}&limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) return out; from += 1000; } }
async function dealerFromToken(event) {
  const raw = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!raw) return null;
  if (/^preview:/i.test(raw)) {
    const rows = await sb('GET', `dealer_preview_tokens?token=eq.${enc(raw.slice(8).trim())}&select=dealer_id,expires_at`); const t = rows && rows[0];
    if (!t || !t.dealer_id || !t.expires_at || !(new Date(t.expires_at).getTime() > Date.now())) return null;
    return { dealer_id: t.dealer_id, uid: null, preview: true, email: 'hcps-preview' };
  }
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${raw}` } });
  if (!ur.ok) return null; const u = await ur.json();
  const rows = await sb('GET', `dealer_users?uid=eq.${enc(u.id)}&select=status,dealer_id,email`); const du = rows && rows[0];
  if (!du || du.status !== 'approved' || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, uid: u.id, email: String(du.email || u.email || '') };
}
async function context(who) {
  const did = String(who.dealer_id);
  const d = await sb('GET', `dealers?id=eq.${enc(did)}&select=id,parent_id,business_name`); const self = d && d[0];
  if (!self) return null;
  const root = String(self.parent_id || self.id);
  const fq = `dealers?or=(id.eq.${enc(root)},parent_id.eq.${enc(root)})&select=id,parent_id,business_name,city,state`;
  let family; try { family = await sb('GET', fq + ',active&limit=500'); } catch (e) { if (!/42703/.test(String(e.message))) throw e; family = await sb('GET', fq + '&limit=500'); }
  family = (family || []).filter((x) => x.active !== false || String(x.id) === did);
  let scopeRow = null;
  if (who.uid) { try { const s = await sb('GET', `dealer_user_scope?uid=eq.${enc(who.uid)}&select=scope,locations`); scopeRow = (s && s[0]) || null; } catch (e) { if (!/PGRST205|42P01/.test(String(e.message))) throw e; } }
  const visible = AC.visibleLocations(did, family, scopeRow);
  const headOffice = !self.parent_id;
  const mayRead = (loc) => visible.some((v) => String(v.id) === String(loc));
  const mayWrite = (loc) => !who.preview && mayRead(loc) && (headOffice || String(loc) === did);
  return { did, self, root, visible, headOffice, mayRead, mayWrite };
}

const SH = require('./_ads_shared.js')({ sb, sbAll, SUPABASE_URL, ORDERING_BASE });
const { productsFor, dealerCard, getFlags } = SH;
/* review #115 (L1): when HCPS has blocked a location's public storefront, its public marketing is paused — ads too */
const BLOCKED = (P) => !!(P && P.storefront && P.storefront.hcps_blocked);
const blockedReply = () => json(423, { ok: false, error: 'HCPS has paused public marketing for this location — please contact HCPS.' });
const pub = (card) => { const o = Object.assign({}, card); delete o._logo; return o; };
const listShape = (r) => ({ id: r.id, dealer_id: r.dealer_id, title: r.title || null, template: r.ad && r.ad.template, format: r.ad && r.ad.format, headline: r.ad && r.ad.headline,
  products: ((r.ad && r.ad.products) || []).length, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by });

/* review #115 (H1): bounded fetch — 6 s, 4 MB counted while streaming, image types only, no redirects */
async function imageData(url) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { redirect: 'error', signal: ac.signal });
    if (!r.ok) throw new Error('image ' + r.status);
    const type = String((r.headers && r.headers.get && r.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) throw new Error('not an image');
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length')); if (len > IMG_MAX) throw new Error('too large');
    let buf;
    if (r.body && typeof r.body.getReader === 'function') { const rd = r.body.getReader(); const parts = []; let n = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > IMG_MAX) { try { await rd.cancel(); } catch (e) {} throw new Error('too large'); } parts.push(Buffer.from(value)); }
      buf = Buffer.concat(parts); }
    else { buf = Buffer.from(await r.arrayBuffer()); if (buf.length > IMG_MAX) throw new Error('too large'); }
    return `data:${type};base64,${buf.toString('base64')}`;
  } finally { clearTimeout(tm); }
}
/* the logo is a URL the dealer typed: its host must resolve to PUBLIC addresses only (no loopback, private, link-local,
   carrier-grade NAT, unique-local or metadata ranges) */
const dns = require('dns');
function privateIp(ip) {
  const v = String(ip || '').toLowerCase().replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) { const [a, b2] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b2 === 254) || (a === 172 && b2 >= 16 && b2 <= 31) || (a === 192 && b2 === 168) || (a === 100 && b2 >= 64 && b2 <= 127) || a >= 224 || (a === 192 && b2 === 0) || (a === 198 && (b2 === 18 || b2 === 19)); }
  return v === '::' || v === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
}
async function publicHost(u) {
  let host; try { host = new URL(u).hostname.replace(/\.$/, ''); } catch (e) { return false; }
  try { const addrs = await dns.promises.lookup(host, { all: true }); return addrs.length > 0 && addrs.every((a) => !privateIp(a.address)); } catch (e) { return false; }
}
const httpsImage = (u) => { try { const x = new URL(u); const h = x.hostname.replace(/\.$/, ''); return x.protocol === 'https:' && !x.port && !x.username && !/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(h) && !/\.(internal|local|localhost)$/i.test(h); } catch (e) { return false; } };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  let who; try { who = await dealerFromToken(event); } catch (e) { return json(503, { ok: false, error: 'Please try again in a moment.' }); }
  if (!who) return json(401, { ok: false, error: 'Please sign in again.' });
  let C; try { C = await context(who); } catch (e) { console.error('ads scope failed', e && e.message); return json(503, { ok: false, error: 'The ad builder could not be loaded just now — please try again.' }); }
  if (!C) return json(404, { ok: false, error: 'Account not found.' });
  const by = who.preview ? 'hcps-preview' : (who.email || 'dealer');
  const WRITES = new Set(['ads_save', 'ads_duplicate', 'ads_archive', 'social_connect', 'social_disconnect', 'post_save', 'post_approve', 'post_pause', 'post_resume', 'post_cancel']);
  if (who.preview && WRITES.has(b.action)) return json(403, { ok: false, error: "This is HCPS's read-only preview — nothing can be changed here." });
  const locOf = (v) => { const l = String(v || ''); return UUID.test(l) && C.mayRead(l) ? l : null; };
  try {
    if (b.action === 'ads_context') {
      const loc = locOf(b.location_id || C.did) || String(C.visible[0] && C.visible[0].id || '');
      if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      const P = await productsFor(C, loc);
      const card = await dealerCard(loc, P.storefront);
      const f = await getFlags().catch(() => ({}));
      const products = [...P.map.values()].map((p) => ADS.renderProduct(p, true));
      return json(200, { ok: true, preview: !!who.preview, head_office: C.headOffice, location_id: loc, can_edit: C.mayWrite(loc) && !BLOCKED(P), blocked: BLOCKED(P),
        locations: C.visible.map((v) => ({ id: v.id, name: v.business_name || '', city: v.city || '', state: v.state || '', can_edit: C.mayWrite(v.id) })),
        dealer: pub(card), lines: P.lines, products, templates: ADS.TEMPLATES, formats: ADS.FORMATS, fonts: ADS.FONTS, ctas: ADS.CTAS, limits: ADS.LIMITS,
        publishing: { enabled: f.social_publishing === true, note: 'Scheduling and publishing to Facebook, Instagram and LinkedIn open once the platforms approve HCPS\'s apps. Download your ad and post it yourself meanwhile.' } });
    }
    /* the export gate: the same checks as a save, nothing stored (works before the ads table exists and in a preview) */
    if (b.action === 'ads_check') {
      const loc = locOf(b.location_id); if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      const P = await productsFor(C, loc); if (BLOCKED(P)) return blockedReply(); const card = await dealerCard(loc, P.storefront);
      const v = ADS.validate(b.ad, P.map, { allow: [card.name, card.city] }); if (v.error) return json(400, { ok: false, error: v.error, field: v.field });
      return json(200, { ok: true, products: v.ad.products.map((r) => ADS.renderProduct(P.map.get(`${r.manufacturer}|${String(r.code).toUpperCase()}`), r.show_price)) });
    }
    if (b.action === 'ads_suggest') {
      const loc = locOf(b.location_id); if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      const P = await productsFor(C, loc); const card = await dealerCard(loc, P.storefront);
      const ps = (Array.isArray(b.products) ? b.products : []).slice(0, 4).map((x) => P.map.get(`${x && x.manufacturer}|${String((x && x.code) || '').toUpperCase()}`)).filter(Boolean);
      return json(200, Object.assign({ ok: true }, ADS.suggest({ products: ps, dealer: card, cta: typeof b.cta === 'string' ? b.cta.slice(0, 40) : null })));
    }
    if (b.action === 'ad_image') {
      const loc = locOf(b.location_id); if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      let url = null;
      if (b.logo === true) {
        const card = await dealerCard(loc, null); const l = card._logo;
        if (!l) return json(404, { ok: false, error: 'No logo on your account yet — add one in Account & Pricing.' });
        if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(l)) return json(200, { ok: true, data_url: l });
        if (!httpsImage(l) || !(await publicHost(l))) return json(404, { ok: false, error: 'Your logo could not be loaded.' });
        url = l;
      } else {
        const P = await productsFor(C, loc); const p = P.map.get(`${b.manufacturer}|${String(b.code || '').toUpperCase()}`);
        if (!p) return json(404, { ok: false, error: 'That product is not one of your authorized products.' });
        const img = String(p.image || '');
        url = OWN_IMG.test(img) ? ORDERING_BASE + img : GOLDEN_IMG.test(img) ? img : null;
        if (!url) return json(404, { ok: false, error: 'This product has no official photo yet.' });
      }
      try { return json(200, { ok: true, data_url: await imageData(url) }); }
      catch (e) { console.error('ad image failed', String(e && e.message).slice(0, 80)); return json(502, { ok: false, error: 'The photo could not be loaded just now — please try again.' }); }
    }
    if (b.action === 'ads_list') {
      const ids = C.visible.map((v) => String(v.id));
      const rows = await sb('GET', `dealer_social_ads?dealer_id=in.(${ids.map(enc).join(',')})&archived_at=is.null&select=${ROW}&order=updated_at.desc&limit=200`);
      return json(200, { ok: true, ads: (rows || []).map(listShape) });
    }
    const getRow = async (id) => { if (!UUID.test(String(id || ''))) return null; const r = await sb('GET', `dealer_social_ads?id=eq.${enc(id)}&select=${ROW}`); const x = r && r[0]; return x && C.mayRead(x.dealer_id) ? x : null; };
    if (b.action === 'ads_get') {
      const row = await getRow(b.id); if (!row || row.archived_at) return json(404, { ok: false, error: 'That ad is not available.' });
      const P = await productsFor(C, String(row.dealer_id));
      const problems = []; const products = [];
      for (const r of (row.ad && row.ad.products) || []) {
        const p = P.map.get(`${r.manufacturer}|${String(r.code).toUpperCase()}`);
        if (!p) { problems.push({ manufacturer: r.manufacturer, code: r.code, problem: 'This product is no longer one of your authorized, listed products — replace or remove it before using the ad.' }); continue; }
        products.push(ADS.renderProduct(p, r.show_price !== false));
      }
      return json(200, { ok: true, row: listShape(row), ad: row.ad, products, problems, can_edit: C.mayWrite(row.dealer_id) });
    }
    if (b.action === 'ads_save') {
      const loc = locOf(b.location_id); if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      if (!C.mayWrite(loc)) return json(403, { ok: false, error: 'Only your head office can make ads for this location.' });
      const P = await productsFor(C, loc); if (BLOCKED(P)) return blockedReply(); const card = await dealerCard(loc, P.storefront);
      const v = ADS.validate(b.ad, P.map, { allow: [card.name, card.city] }); if (v.error) return json(400, { ok: false, error: v.error, field: v.field });
      const now = new Date().toISOString();
      if (!b.id) {
        const out = await sb('POST', 'dealer_social_ads', { company_id: C.root, dealer_id: loc, title: v.ad.title, ad: v.ad, created_by: by, updated_by: by }, { Prefer: 'return=representation' });
        return json(200, { ok: true, row: listShape(out[0]) });
      }
      const row = await getRow(b.id); if (!row || row.archived_at) return json(404, { ok: false, error: 'That ad is not available.' });
      if (!C.mayWrite(row.dealer_id)) return json(403, { ok: false, error: 'Only your head office can change this ad.' });
      if (String(row.dealer_id) !== loc) return json(400, { ok: false, error: 'An ad stays with its location — duplicate it to make one for another location.' });
      if (Number(b.version) !== row.version) return json(409, { ok: false, error: 'This ad was changed somewhere else — reopen it.' });
      const out = await sb('PATCH', `dealer_social_ads?id=eq.${enc(row.id)}&version=eq.${row.version}`, { title: v.ad.title, ad: v.ad, version: row.version + 1, updated_by: by, updated_at: now }, { Prefer: 'return=representation' });
      if (!(out && out.length)) return json(409, { ok: false, error: 'This ad was changed somewhere else — reopen it.' });
      return json(200, { ok: true, row: listShape(out[0]) });
    }
    if (b.action === 'ads_duplicate') {
      const row = await getRow(b.id); if (!row || row.archived_at) return json(404, { ok: false, error: 'That ad is not available.' });
      const loc = locOf(b.location_id || row.dealer_id); if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      if (!C.mayWrite(loc)) return json(403, { ok: false, error: 'Only your head office can make ads for this location.' });
      const P = await productsFor(C, loc); if (BLOCKED(P)) return blockedReply();
      const kept = ((row.ad && row.ad.products) || []).filter((r) => P.map.has(`${r.manufacturer}|${String(r.code).toUpperCase()}`));   // a copy never carries an unauthorized product
      const card = await dealerCard(loc, P.storefront);
      const v = ADS.validate(Object.assign({}, row.ad, { title: ((row.ad && row.ad.title) || row.title || 'Ad').slice(0, 72) + ' (copy)', products: kept }), P.map, { allow: [card.name, card.city] });
      if (v.error) return json(400, { ok: false, error: 'The copy needs attention first: ' + v.error, field: v.field });   // review #115: a copy is checked for ITS location
      const ad = v.ad;
      const out = await sb('POST', 'dealer_social_ads', { company_id: C.root, dealer_id: loc, title: ad.title, ad, created_by: by, updated_by: by }, { Prefer: 'return=representation' });
      return json(200, { ok: true, row: listShape(out[0]), dropped: ((row.ad && row.ad.products) || []).length - ad.products.length });
    }
    if (b.action === 'ads_archive') {
      const row = await getRow(b.id); if (!row || row.archived_at) return json(404, { ok: false, error: 'That ad is not available.' });
      if (!C.mayWrite(row.dealer_id)) return json(403, { ok: false, error: 'Only your head office can change this ad.' });
      await sb('PATCH', `dealer_social_ads?id=eq.${enc(row.id)}`, { archived_at: new Date().toISOString(), updated_by: by }, { Prefer: 'return=minimal' });
      return json(200, { ok: true });
    }
    /* ---------------- scheduling & publishing (Batch D) — off until the platforms approve HCPS's apps ---------------- */
    if (b.action === 'social_status') {
      const loc = locOf(b.location_id || C.did); if (!loc) return json(404, { ok: false, error: 'That location is not part of your account.' });
      const f = await getFlags().catch(() => ({})); const env = envNow();
      const [conns, posts] = await Promise.all([
        sb('GET', `dealer_social_connections?dealer_id=eq.${enc(loc)}&select=${CONN_ROW}&order=authorized_at.desc`),
        sb('GET', `dealer_social_posts?dealer_id=eq.${enc(loc)}&scheduled_at=gte.${enc(new Date(Date.now() - 60 * 864e5).toISOString())}&select=${POST_ROW}&order=scheduled_at.asc&limit=300`)]);
      return json(200, { ok: true, platforms: SP.PLATFORMS.map((p) => Object.assign({ platform: p }, SP.platformOpen(f, env, p))), connections: conns || [], posts: posts || [], can_edit: C.mayWrite(loc) });
    }
    if (b.action === 'social_connect') {
      const loc = locOf(b.location_id); if (!loc || !C.mayWrite(loc)) return json(403, { ok: false, error: 'Only your head office can connect accounts for this location.' });
      const platform = String(b.platform || ''); if (!SP.PLATFORMS.includes(platform)) return json(400, { ok: false, error: 'Choose Facebook, Instagram or LinkedIn.' });
      const gate = SP.platformOpen(await getFlags(), envNow(), platform);
      if (!gate.ok) return json(409, { ok: false, error: 'Connecting social accounts opens once the platforms approve HCPS\'s apps.', reason: gate.reason });
      const state = SP.signState(envNow(), { loc, root: C.root, platform, by, uid: who.uid || null });
      return json(200, { ok: true, url: SP.authorizeUrl(envNow(), platform, state, `${SELF_BASE}/.netlify/functions/social-oauth-callback`) });
    }
    const getPost = async (id) => { if (!UUID.test(String(id || ''))) return null; const r = await sb('GET', `dealer_social_posts?id=eq.${enc(id)}&select=${POST_ROW}`); const x = r && r[0]; return x && C.mayRead(x.dealer_id) ? x : null; };
    if (b.action === 'social_disconnect') {
      if (!UUID.test(String(b.id || ''))) return json(404, { ok: false, error: 'That connection is not available.' });
      const r = await sb('GET', `dealer_social_connections?id=eq.${enc(b.id)}&select=id,dealer_id`); const c = r && r[0];
      if (!c || !C.mayWrite(c.dealer_id)) return json(404, { ok: false, error: 'That connection is not available.' });
      await sb('PATCH', `dealer_social_connections?id=eq.${enc(c.id)}`, { status: 'revoked', revoked_at: new Date().toISOString(), token_ciphertext: null, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
      return json(200, { ok: true });
    }
    if (b.action === 'post_save') {
      const ad = await getRow(b.ad_id); if (!ad || ad.archived_at) return json(404, { ok: false, error: 'Save the ad first, then schedule it.' });
      const loc = String(ad.dealer_id); if (!C.mayWrite(loc)) return json(403, { ok: false, error: 'Only your head office can schedule posts for this location.' });
      const P = await productsFor(C, loc); if (BLOCKED(P)) return blockedReply(); const card = await dealerCard(loc, P.storefront);
      const va = ADS.validate(ad.ad, P.map, { allow: [card.name, card.city] }); if (va.error) return json(400, { ok: false, error: 'The ad needs attention first: ' + va.error });
      const vp = SP.validatePost(Object.assign({}, b, { format: ad.ad.format })); if (vp.error) return json(400, { ok: false, error: vp.error });
      const cp = ADS.claimProblem(vp.post.caption, [card.name, card.city].concat(...ad.ad.products.map((r) => { const x = P.map.get(`${r.manufacturer}|${String(r.code).toUpperCase()}`); return x ? [x.name, x.category, x.brand] : []; })));
      if (cp) return json(400, { ok: false, error: `The caption contains ${cp.reason} ("${cp.phrase}").` });
      const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.media || ''));
      if (!m) return json(400, { ok: false, error: 'The ad image is missing — try again.' });
      const bytes = Buffer.from(m[2], 'base64'); if (bytes.length < 200 || bytes.length > 8 * 1024 * 1024) return json(400, { ok: false, error: 'The ad image is too large.' });
      const sig = m[1] === 'png' ? bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : (bytes[0] === 0xff && bytes[1] === 0xd8);
      if (!sig) return json(400, { ok: false, error: 'The ad image is not a PNG or JPEG.' });
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const path = `${C.root}/${loc}/${sha}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/social-media/${path}`, { method: 'POST', headers: { ...H(), 'content-type': 'image/' + m[1], 'x-upsert': 'true' }, body: bytes });
      if (!up.ok) return json(503, { ok: false, error: 'The image could not be stored just now — please try again.' });
      const now = new Date().toISOString();
      const fields = { caption: vp.post.caption, format: ad.ad.format, media_path: path, media_sha256: sha, platforms: vp.post.platforms, scheduled_at: vp.post.scheduled_at,
        status: 'awaiting_approval', approved_by: null, approved_at: null, attempts: 0, next_attempt_at: null, last_error: null, updated_by: by, updated_at: now };   // any edit needs a fresh approval
      if (!b.id) { const out = await sb('POST', 'dealer_social_posts', Object.assign({ company_id: C.root, dealer_id: loc, ad_id: ad.id, created_by: by }, fields), { Prefer: 'return=representation' }); return json(200, { ok: true, post: out[0] }); }
      const cur = await getPost(b.id); if (!cur || String(cur.ad_id) !== String(ad.id)) return json(404, { ok: false, error: 'That post is not available.' });
      if (!SP.editable(cur.status)) return json(409, { ok: false, error: 'This post can no longer be changed (' + cur.status + ').' });
      if (Number(b.version) !== cur.version) return json(409, { ok: false, error: 'This post was changed somewhere else — reopen it.' });
      const out = await sb('PATCH', `dealer_social_posts?id=eq.${enc(cur.id)}&version=eq.${cur.version}&status=eq.${enc(cur.status)}`, Object.assign({ version: cur.version + 1 }, fields), { Prefer: 'return=representation' });
      if (!(out && out.length)) return json(409, { ok: false, error: 'This post was changed somewhere else — reopen it.' });
      return json(200, { ok: true, post: out[0] });
    }
    if (['post_approve', 'post_pause', 'post_resume', 'post_cancel'].includes(b.action)) {
      const cur = await getPost(b.id); if (!cur) return json(404, { ok: false, error: 'That post is not available.' });
      if (!C.mayWrite(cur.dealer_id)) return json(403, { ok: false, error: 'Only your head office can change this post.' });
      if (Number(b.version) !== cur.version) return json(409, { ok: false, error: 'This post was changed somewhere else — reopen it.' });
      const to = { post_approve: 'approved', post_pause: 'paused', post_resume: 'approved', post_cancel: 'cancelled' }[b.action];
      if (b.action === 'post_resume' && cur.status !== 'paused') return json(409, { ok: false, error: 'Only a paused post can be resumed.' });
      if (b.action === 'post_approve' && cur.status !== 'awaiting_approval') return json(409, { ok: false, error: 'Only a post waiting for approval can be approved.' });
      if (!SP.canMove(cur.status, to)) return json(409, { ok: false, error: `A ${cur.status.replace('_', ' ')} post can't be ${to}.` });
      const patch = { status: to, version: cur.version + 1, updated_by: by, updated_at: new Date().toISOString() };
      if (b.action === 'post_approve') {
        if (!who.uid) return json(403, { ok: false, error: 'Only a signed-in dealer user can approve a post.' });
        if (Date.parse(cur.scheduled_at) < Date.now()) return json(409, { ok: false, error: 'The scheduled time has passed — choose a new time.' });
        const conns = await sb('GET', `dealer_social_connections?dealer_id=eq.${enc(cur.dealer_id)}&status=eq.connected&select=platform`);
        const have = new Set((conns || []).map((c) => c.platform)); const missing = cur.platforms.filter((p) => !have.has(p));
        if (missing.length) return json(409, { ok: false, error: 'Connect ' + missing.join(', ') + ' first.' });
        Object.assign(patch, { approved_by: by, approved_at: patch.updated_at });
      }
      if (b.action === 'post_resume' && cur.approved_by) patch.status = 'approved'; else if (b.action === 'post_resume') patch.status = 'awaiting_approval';
      const out = await sb('PATCH', `dealer_social_posts?id=eq.${enc(cur.id)}&version=eq.${cur.version}&status=eq.${enc(cur.status)}`, patch, { Prefer: 'return=representation' });
      if (!(out && out.length)) return json(409, { ok: false, error: 'This post was changed somewhere else — reopen it.' });
      return json(200, { ok: true, post: out[0] });
    }
    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    if (MISSING(e)) return json(503, { ok: false, error: 'Saving ads opens shortly — you can still design and download an ad now.' });
    console.error('ads api failed', e && (e.status || e.message));
    return json(503, { ok: false, error: 'That could not be completed just now — please try again.' });
  }
};
