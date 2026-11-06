// C3-07 storefront correction (owner 2026-11-06 13:25 CT) — HCPS's controls for dealer public storefronts (Connect 360 →
// Online Ordering → Storefront Advertising Rules). President / admin / owner only.
//   POST + Bearer <staff JWT>
//     {action:"get"}  -> {ok, lines:[{slug,name,policy,note,set_by,set_at,map_on_file,msrp_on_file,products}], storefronts:[…], history:[…]}
//     {action:"set_policy", slug, policy, note}   policy ∈ open | map | msrp_only | no_price | unknown; note (evidence) ≥ 5 chars
//     {action:"block", dealer_id, blocked:true|false, reason}   HCPS pauses / restores one storefront (the dealer can't clear it)
//     {action:"coverage", slug?}  -> per line: active products by default price source (official MSRP · HCPS calculated · Call for
//        Price) and every Call-for-Price code with its reason — counts and codes only, never a price or cost
// The ADVERTISING RULES decide which public prices a storefront may show (_retail_price.js): a line whose rules HCPS hasn't
// recorded shows only the manufacturer's MSRP — nothing is assumed. Stored as app_settings "advertising_policies"
// {lines:{slug:{policy,note,set_by,set_at}}, history:[…last 200]} — one record, written compare-and-set on its own text.
// Storefronts read it on their next refresh (≤ 30 s) — no deploy. No price, MAP or dealer data is changed here.
'use strict';
const RP = require('./_retail_price.js');
const RETIRED = require('./_retired_lines.js');
const SC = require('./_storefront_catalog.js');
const PR = require('./_pricing.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN = new Set(['president', 'admin', 'owner']);
const KEY = 'advertising_policies';

async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function sbAll(base) { let from = 0, out = []; for (;;) { const rows = await sb('GET', `${base}&limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) return out; from += 1000; } }
async function whoami(event) {
  const tok = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null;
    const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if (!email) return null;
    const s = await sb('GET', `staff_users?email=eq.${enc(email)}&select=email,role,active`); const su = s && s[0];
    return su && su.active !== false ? { email, role: su.role || 'rep' } : null;
  } catch (e) { return null; }
}
async function readSetting() { const r = await sb('GET', `app_settings?key=eq.${KEY}&select=value`); return (r && r[0]) ? { value: r[0].value || {}, exists: true } : { value: {}, exists: false }; }
/* compare-and-set on the record's own revision number: the write succeeds only if nobody wrote since we read */
async function writeSetting(cur, next) {
  const rev = Number(cur.value && cur.value.rev) || 0; next.rev = rev + 1;
  if (!cur.exists) {
    try { await sb('POST', 'app_settings', { key: KEY, value: next }, { Prefer: 'return=minimal' }); return true; }
    catch (e) { if (/23505|409/.test(String(e.message))) return false; throw e; }
  }
  const guard = rev ? `value->>rev=eq.${rev}` : 'value->>rev=is.null';
  const out = await sb('PATCH', `app_settings?key=eq.${KEY}&${guard}`, { value: next }, { Prefer: 'return=representation' });
  return !!(out && out.length);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  const me = await whoami(event); if (!me) return json(401, { ok: false, error: 'Please sign in again.' });
  if (!ADMIN.has(me.role)) return json(403, { ok: false, error: 'Storefront rules are managed by HCPS management.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  try {
    if (b.action === 'get') {
      const [mfrs, metas, setting, recs, custom, sfs] = await Promise.all([
        sb('GET', 'manufacturers?select=slug,name&order=name.asc'), sb('GET', 'manufacturer_meta?select=slug,active'), readSetting(),
        sbAll('product_skus?status=eq.active&select=manufacturer,map,msrp,msrp_auto&order=id.asc'), sbAll('custom_products?select=manufacturer,map,msrp&order=code.asc'),
        sb('GET', 'dealer_storefronts?select=dealer_id,slug,enabled,hcps_blocked,updated_at&order=updated_at.desc&limit=500').catch((e) => { if (/PGRST205|42P01/.test(String(e.message))) return []; throw e; })]);
      const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug));
      const pol = RP.policiesFrom(setting.value, { 'golden-technologies': 'map' }); const lines = (setting.value && setting.value.lines) || {};
      const count = {}; for (const r of (recs || []).concat(custom || [])) { const c = count[r.manufacturer] || (count[r.manufacturer] = { map: 0, msrp: 0, n: 0 }); c.n++; if (Number(r.map) > 0) c.map++; if (Number(r.msrp) > 0 && r.msrp_auto !== true) c.msrp++; }
      const out = (mfrs || []).filter((m) => m.slug && !off.has(m.slug) && !RETIRED.isRetiredLine(m.slug)).map((m) => {
        const x = lines[m.slug] || {}; const golden = m.slug === 'golden-technologies' || m.slug === 'golden';
        return { slug: m.slug, name: m.name || m.slug, policy: pol[m.slug] || 'unknown', note: x.note || (golden && !x.policy ? 'Golden publishes an eMAP for every product (Golden catalog).' : ''), set_by: x.set_by || null, set_at: x.set_at || null,
          map_on_file: golden ? 'from Golden' : (count[m.slug] || {}).map || 0, msrp_on_file: golden ? 'from Golden' : (count[m.slug] || {}).msrp || 0, products: golden ? null : (count[m.slug] || {}).n || 0 };
      });
      const ids = [...new Set((sfs || []).map((s) => s.dealer_id))];
      const names = ids.length ? await sb('GET', `dealers?id=in.(${ids.map(enc).join(',')})&select=id,business_name,city,state,is_test`) : [];
      const nm = new Map((names || []).map((d) => [String(d.id), d]));
      return json(200, { ok: true, policies: RP.POLICIES, lines: out, history: ((setting.value && setting.value.history) || []).slice(0, 50),
        storefronts: (sfs || []).map((s) => { const d = nm.get(String(s.dealer_id)) || {}; return { dealer_id: s.dealer_id, dealer: d.business_name || '', city: [d.city, d.state].filter(Boolean).join(', '), test: d.is_test === true,
          link: `${ORDERING_BASE}/store/${s.slug}`, live: !!(s.enabled && !s.hcps_blocked), enabled: !!s.enabled, blocked: !!s.hcps_blocked }; }) });
    }
    if (b.action === 'coverage') {
      const FILES = PR.remoteFiles(ORDERING_BASE); const CF = { 'ohio-medical': 'gce' };
      const deps = { sb, sbAll, catalogFile: (s2) => FILES.catalogFile(CF[s2] || s2), contentFile: FILES.contentFile };
      const [mfrs, metas, setting] = await Promise.all([sb('GET', 'manufacturers?select=slug,name&order=name.asc'), sb('GET', 'manufacturer_meta?select=slug,active'), readSetting()]);
      const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug));
      const want = (mfrs || []).filter((m) => m.slug && !off.has(m.slug) && !RETIRED.isRetiredLine(m.slug) && m.slug !== 'golden-technologies' && m.slug !== 'golden' && (!b.slug || m.slug === b.slug));
      const out = [];
      const one = async (m) => {
        try {
          const r = await SC.lineDefaults(deps, m.slug, { setting: setting.value });
          const c = { msrp: 0, calculated: 0, call: 0 }; const calls = [];
          for (const [code, d] of r.items) { if (!d.active) continue; c[d.source] = (c[d.source] || 0) + 1;
            if (d.source === 'call') calls.push({ code, reason: d.no_cost ? 'no_standard_cost' : (d.flags.length ? d.flags[d.flags.length - 1].flag : 'no_price') }); }
          return { slug: m.slug, name: m.name || m.slug, policy: r.policy, costs_readable: r.costs_readable, counts: c, call: calls.slice(0, 300) };
        } catch (e) { return { slug: m.slug, name: m.name || m.slug, error: 'could not be read' }; }
      };
      for (let i = 0; i < want.length; i += 4) out.push(...await Promise.all(want.slice(i, i + 4).map(one)));   // review fix: 4 lines at a time
      return json(200, { ok: true, lines: out });
    }
    if (b.action === 'set_policy') {
      const slug = String(b.slug || ''); if (!/^[a-z0-9-]{2,60}$/.test(slug)) return json(400, { ok: false, error: 'Unknown line.' });
      if (!RP.POLICIES.includes(b.policy)) return json(400, { ok: false, error: 'Choose one of the rules.' });
      const note = String(b.note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
      if (b.policy !== 'unknown' && note.length < 5) return json(400, { ok: false, error: 'Say where the rule comes from (for example "Bemis MAP policy, dealer agreement 2026").' });
      const m = await sb('GET', `manufacturers?slug=eq.${enc(slug)}&select=slug`); if (!(m && m.length)) return json(404, { ok: false, error: 'Unknown line.' });
      for (let i = 0; i < 3; i++) {
        const cur = await readSetting(); const v = JSON.parse(JSON.stringify(cur.value || {}));
        v.lines = v.lines && typeof v.lines === 'object' ? v.lines : {};
        const before = v.lines[slug] ? v.lines[slug].policy : 'unknown';
        const at = new Date().toISOString();
        if (b.policy === 'unknown') delete v.lines[slug]; else v.lines[slug] = { policy: b.policy, note, set_by: me.email, set_at: at };
        v.history = [{ slug, from: before, to: b.policy, note, by: me.email, at }].concat(Array.isArray(v.history) ? v.history : []).slice(0, 200);
        if (await writeSetting(cur, v)) return json(200, { ok: true, slug, policy: b.policy });
      }
      return json(409, { ok: false, error: 'Someone else changed the rules at the same time — reload and try again.' });
    }
    if (b.action === 'block') {
      if (!UUID.test(String(b.dealer_id || ''))) return json(404, { ok: false, error: 'Unknown storefront.' });
      const reason = String(b.reason || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
      if (b.blocked === true && reason.length < 5) return json(400, { ok: false, error: 'Give a reason for pausing this storefront.' });
      const cur = await sb('GET', `dealer_storefronts?dealer_id=eq.${enc(b.dealer_id)}&select=id,version`); const row = cur && cur[0];
      if (!row) return json(404, { ok: false, error: 'Unknown storefront.' });
      const out = await sb('PATCH', `dealer_storefronts?id=eq.${enc(row.id)}&version=eq.${row.version}`, { hcps_blocked: b.blocked === true, version: row.version + 1, updated_by: 'hcps:' + me.email + (reason ? ' — ' + reason : ''), updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      if (!(out && out.length)) return json(409, { ok: false, error: 'The storefront changed at the same time — reload and try again.' });
      return json(200, { ok: true, blocked: out[0].hcps_blocked });
    }
    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('storefront rules failed', e && (e.status || e.message));
    return json(503, { ok: false, error: 'Storefront rules could not be loaded just now — please try again.' });
  }
};
