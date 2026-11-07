/* Shared by dealer-ads-api and social-publish-cron: the location's ad products (the public storefront's own set and prices)
   and the dealer's card (name, address, phone, website / storefront link, logo). */
'use strict';
const SC = require('./_storefront_catalog.js');
const PR = require('./_pricing.js');
const { flags } = require('./_flags.js');
module.exports = function make(o) {
  const { sb, sbAll, SUPABASE_URL, ORDERING_BASE } = o; const enc = encodeURIComponent;
  const FILES = PR.remoteFiles(ORDERING_BASE);
  const CATALOG_FILE = { 'ohio-medical': 'gce' };
  const catalogFile = (slug) => FILES.catalogFile(CATALOG_FILE[slug] || slug);
  let FLAGS = null, FLAGS_AT = 0;
  const getFlags = async () => { if (!FLAGS || Date.now() - FLAGS_AT > 60000) { FLAGS = await flags((p) => sb('GET', p)); FLAGS_AT = Date.now(); } return FLAGS; };
/* the location's authorized, currently listed products — the public storefront's own set and prices (cached 5 minutes) */
const PCACHE = new Map();
async function productsFor(C, loc) {   // C: { root }
  const c = PCACHE.get(loc); if (c && Date.now() - c.at < 300000) return c.v;
  const cur = await sb('GET', `dealer_storefronts?dealer_id=eq.${enc(loc)}&select=dealer_id,company_id,slug,enabled,hcps_blocked,lines,hidden_categories,price_mode,phone,email`).catch((e) => { if (/PGRST205|42P01/.test(String(e.message))) return []; throw e; });
  const row = (cur && cur[0]) || null;
  const sf = Object.assign({ dealer_id: loc, company_id: C.root, slug: (row && row.slug) || 'ads', lines: null, hidden_categories: [], price_mode: 'msrp', show_address: true }, row || {}, { dealer_id: loc, company_id: C.root });
  const built = await SC.build(sf, { sb, sbAll, catalogFile, contentFile: FILES.contentFile, flags: getFlags, supabaseUrl: SUPABASE_URL }, {});
  const map = new Map();
  for (const p of built.products || []) map.set(`${p.manufacturer}|${String(p.code).toUpperCase()}`, p);
  const v = { map, lines: built.lineList || [], storefront: row };
  PCACHE.set(loc, { at: Date.now(), v }); if (PCACHE.size > 50) PCACHE.delete(PCACHE.keys().next().value);
  return v;
}
async function dealerCard(loc, sfRow) {
  let d; try { d = await sb('GET', `dealers?id=eq.${enc(loc)}&select=business_name,address,city,state,zip,phone,website,logo_url,parent_id`); }
  catch (e) { if (!/42703/.test(String(e.message))) throw e; d = await sb('GET', `dealers?id=eq.${enc(loc)}&select=business_name,address,city,state,zip,phone,parent_id`); }
  const x = (d && d[0]) || {};
  let logo = x.logo_url || null;
  if (!logo && x.parent_id) { try { const p = await sb('GET', `dealers?id=eq.${enc(x.parent_id)}&select=logo_url`); logo = (p && p[0] && p[0].logo_url) || null; } catch (e) { /* no logo column */ } }
  const live = !!(sfRow && sfRow.enabled && !sfRow.hcps_blocked);
  const site = /^https?:\/\/[^\s]+$/i.test(String(x.website || '').trim()) ? String(x.website).trim() : (x.website ? 'https://' + String(x.website).trim().replace(/^\/+/, '') : null);
  return { name: x.business_name || '', address: x.address || '', city: x.city || '', state: x.state || '', zip: x.zip || '', phone: (sfRow && sfRow.phone) || x.phone || '',
    website: site, link: live ? `${ORDERING_BASE}/store/${sfRow.slug}` : null, has_logo: !!logo, _logo: logo };
}
  return { productsFor, dealerCard, getFlags };
};
