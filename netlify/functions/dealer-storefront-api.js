// C3-07 Stage 7 — the dealer manages its PUBLIC STOREFRONT (360 Dealer Portal → My Storefront).
//   POST + Bearer <dealer JWT>  (a HCPS preview token may only read)
//     {action:"sf_get"}                                       -> {ok, head_office, locations:[{id, name, can_edit, lines, storefront, suggested_slug, link}]}
//     {action:"sf_save", location_id, version?, settings:{…}} -> {ok, storefront}     (create when none; else compare-and-set on version)
//     {action:"sf_inquiries", location_id?}                  -> {ok, inquiries:[…]}   (newest 300 of the visible locations)
//     {action:"sf_inquiry_set", id, status:"new"|"handled"}  -> {ok}
//     {action:"sf_inquiry_delete", id}                        -> {ok}                  (D4 deletion control)
// WHO: D2 — a head office manages its visible locations' storefronts; a branch login only its own (_account_center.visibleLocations).
// Lines a storefront may show = the location's ACTIVE manufacturer accounts (dealer_manufacturers), never a retired or switched-off
// line, never Golden (its storefront is Golden's own). HCPS's block (hcps_blocked) can't be changed here.
'use strict';
const AC = require('./_account_center.js');
const SF = require('./_storefront.js');
const RETIRED = require('./_retired_lines.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING = (e) => /PGRST205|42P01/.test(String(e && e.message)) && /storefront/.test(String(e && e.message));
const SEL = 'id,dealer_id,company_id,slug,enabled,hcps_blocked,headline,about,phone,email,hours,show_address,lines,hidden_categories,price_mode,version,updated_at';
const GOLDEN = new Set(['golden-technologies', 'golden']);

async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
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
  const fq = `dealers?or=(id.eq.${enc(root)},parent_id.eq.${enc(root)})&select=id,parent_id,business_name,city,state,email,phone`;
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
async function authorizedLines(ids) {
  const inIds = ids.map(enc).join(',');
  const [dms, names, metas] = await Promise.all([
    sb('GET', `dealer_manufacturers?dealer_id=in.(${inIds})&active=eq.true&select=dealer_id,manufacturer`),
    sb('GET', 'manufacturers?select=slug,name'), sb('GET', 'manufacturer_meta?select=slug,active')]);
  const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug));
  const nm = new Map((names || []).map((m) => [m.slug, m.name || m.slug]));
  const by = new Map(ids.map((i) => [String(i), []]));
  for (const r of dms || []) { const s = String(r.manufacturer || ''); if (!s || GOLDEN.has(s) || off.has(s) || RETIRED.isRetiredLine(s)) continue; const L = by.get(String(r.dealer_id)); if (L && !L.some((x) => x.slug === s)) L.push({ slug: s, name: nm.get(s) || s }); }
  for (const L of by.values()) L.sort((a, b) => a.name.localeCompare(b.name));
  return by;
}
const link = (slug) => `${ORDERING_BASE}/store/${slug}`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  let who; try { who = await dealerFromToken(event); } catch (e) { return json(503, { ok: false, error: 'Please try again in a moment.' }); }
  if (!who) return json(401, { ok: false, error: 'Please sign in again.' });
  let C; try { C = await context(who); } catch (e) { console.error('storefront scope failed', e && e.message); return json(503, { ok: false, error: 'Your storefront could not be loaded just now — please try again.' }); }
  if (!C) return json(404, { ok: false, error: 'Account not found.' });
  const by = who.preview ? 'hcps-preview' : (who.email || 'dealer');
  try {
    if (b.action === 'sf_get') {
      const ids = C.visible.map((v) => String(v.id));
      const [rows, lines] = await Promise.all([sb('GET', `dealer_storefronts?dealer_id=in.(${ids.map(enc).join(',')})&select=${SEL}`), authorizedLines(ids)]);
      const sfBy = new Map((rows || []).map((r) => [String(r.dealer_id), r]));
      return json(200, { ok: true, head_office: C.headOffice, preview: !!who.preview, base: ORDERING_BASE + '/store/',
        locations: C.visible.map((v) => { const s = sfBy.get(String(v.id)) || null;
          return { id: v.id, name: v.business_name || '', city: v.city || '', state: v.state || '', can_edit: C.mayWrite(v.id), lines: lines.get(String(v.id)) || [],
            default_email: v.email || '', default_phone: v.phone || '', storefront: s, suggested_slug: SF.slugify(`${v.business_name || ''}${v.city && C.visible.length > 1 ? ' ' + v.city : ''}`) || null,
            link: s ? link(s.slug) : null, live: !!(s && s.enabled && !s.hcps_blocked) }; }) });
    }
    if (b.action === 'sf_save') {
      const loc = String(b.location_id || '');
      if (!UUID.test(loc) || !C.mayRead(loc)) return json(404, { ok: false, error: 'That location is not part of your account.' });
      if (!C.mayWrite(loc)) return json(403, { ok: false, error: who.preview ? 'Read-only preview.' : 'Only your head office can change this location\'s storefront.' });
      const lines = (await authorizedLines([loc])).get(loc) || [];
      const v = SF.validateSettings(b.settings || {}, lines.map((l) => l.slug)); if (v.error) return json(400, { ok: false, error: v.error });
      const cur = await sb('GET', `dealer_storefronts?dealer_id=eq.${enc(loc)}&select=${SEL}`); const row = cur && cur[0];
      if (v.patch.slug && (!row || row.slug !== v.patch.slug)) {
        const taken = await sb('GET', `dealer_storefronts?slug=eq.${enc(v.patch.slug)}&select=dealer_id`);
        if (taken && taken.length) return json(409, { ok: false, error: 'That web address is already taken — please choose another.', taken: true });
      }
      // the public page shows ONLY contact details entered here (never the account's own email / phone): a live storefront needs one
      const eff = Object.assign({}, row || {}, v.patch);
      if (eff.enabled === true && !eff.phone && !eff.email) return json(400, { ok: false, error: 'Add a phone number or an email address for customers before turning your storefront on.' });
      const now = new Date().toISOString();
      let out;
      try {
        if (!row) {
          if (!v.patch.slug) return json(400, { ok: false, error: 'Choose your storefront web address first.' });
          out = await sb('POST', 'dealer_storefronts', Object.assign({ dealer_id: loc, company_id: C.root, created_by: by, updated_by: by }, v.patch), { Prefer: 'return=representation' });
        } else {
          if (Number(b.version) !== row.version) return json(409, { ok: false, error: 'Your storefront was changed somewhere else — reload it.' });
          out = await sb('PATCH', `dealer_storefronts?id=eq.${enc(row.id)}&version=eq.${row.version}`, Object.assign({}, v.patch, { version: row.version + 1, updated_by: by, updated_at: now }), { Prefer: 'return=representation' });
          if (!(out && out.length)) return json(409, { ok: false, error: 'Your storefront was changed somewhere else — reload it.' });
        }
      } catch (e) { if (/23505/.test(String(e.message))) return json(409, { ok: false, error: 'That web address is already taken — please choose another.', taken: true }); throw e; }
      const s = out[0];
      return json(200, { ok: true, storefront: s, link: link(s.slug), live: !!(s.enabled && !s.hcps_blocked) });
    }
    if (b.action === 'sf_inquiries') {
      if (who.preview) return json(200, { ok: true, inquiries: [], hidden_in_preview: true });   // customers' contact details stay with the dealer
      const ids = C.visible.map((v) => String(v.id)).filter((i) => !b.location_id || i === String(b.location_id));
      if (!ids.length) return json(404, { ok: false, error: 'That location is not part of your account.' });
      const rows = await sb('GET', `storefront_inquiries?dealer_id=in.(${ids.map(enc).join(',')})&select=id,dealer_id,created_at,name,email,phone,message,manufacturer,product_code,product_name,status,handled_at,delete_after&order=created_at.desc&limit=300`);
      return json(200, { ok: true, inquiries: rows || [] });
    }
    if (b.action === 'sf_inquiry_set' || b.action === 'sf_inquiry_delete') {
      if (!UUID.test(String(b.id || ''))) return json(404, { ok: false, error: 'That request isn\'t available.' });
      const r = await sb('GET', `storefront_inquiries?id=eq.${enc(b.id)}&select=id,dealer_id`); const q = r && r[0];
      if (!q || !C.mayRead(q.dealer_id)) return json(404, { ok: false, error: 'That request isn\'t available.' });
      if (!C.mayWrite(q.dealer_id)) return json(403, { ok: false, error: who.preview ? 'Read-only preview.' : 'Only your head office can change this location\'s requests.' });
      if (b.action === 'sf_inquiry_delete') { await sb('DELETE', `storefront_inquiries?id=eq.${enc(q.id)}`, null, { Prefer: 'return=minimal' }); return json(200, { ok: true }); }
      if (!['new', 'handled'].includes(b.status)) return json(400, { ok: false, error: 'Choose new or handled.' });
      await sb('PATCH', `storefront_inquiries?id=eq.${enc(q.id)}`, { status: b.status, handled_at: b.status === 'handled' ? new Date().toISOString() : null }, { Prefer: 'return=minimal' });
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    if (MISSING(e)) return json(503, { ok: false, error: 'Storefronts open shortly.' });
    console.error('storefront api failed', e && (e.status || e.message));
    return json(503, { ok: false, error: 'That could not be completed just now — please try again.' });
  }
};
