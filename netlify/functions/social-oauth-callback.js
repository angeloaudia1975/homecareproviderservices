// Catalog 4 §8 — the platforms' official sign-in returns here (GET ?code&state). OFF until the platforms approve HCPS's apps.
// The signed state (dealer-ads-api social_connect, 15 minutes) names the location, the head office, the platform and the
// dealer user who started it — a callback without a valid state is refused. The code is exchanged SERVER-side; tokens are
// sealed (AES-256-GCM) before they are stored and never reach a browser. Meta: the Pages the person manages (Facebook) or
// the Instagram Professional accounts linked to them; LinkedIn: the organizations the person administers. Then back to the
// portal's Social Ads view.
'use strict';
const SP = require('./_social_publish.js');
const { flags } = require('./_flags.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const SELF_BASE = (process.env.URL || 'https://homecareproviderservices.netlify.app').replace(/\/+$/, '');
const enc = encodeURIComponent;
const back = (q) => ({ statusCode: 302, headers: { location: `${ORDERING_BASE}/dashboard.html#ads?${q}`, 'cache-control': 'no-store' }, body: '' });
async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
}
async function getJson(url, opts) { const r = await fetch(url, opts); const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error('provider ' + r.status); return j; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '' };
  const q = event.queryStringParameters || {}; const env = process.env;
  const st = SP.readState(env, q.state);
  if (!st || !SP.PLATFORMS.includes(st.platform)) return back('social=refused');
  if (q.error || !q.code) return back('social=cancelled');
  let f = {}; try { f = await flags((p) => sb('GET', p)); } catch (e) { return back('social=unavailable'); }
  if (!SP.platformOpen(f, env, st.platform).ok) return back('social=unavailable');
  const redirect = `${SELF_BASE}/.netlify/functions/social-oauth-callback`;
  try {
    const accounts = [];   // { external_id, account_name, token, expires_at, scopes }
    if (st.platform === 'linkedin') {
      const tok = await getJson('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirect, client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }) });
      const acl = await getJson(`${SP.LI}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`, { headers: { Authorization: `Bearer ${tok.access_token}`, 'LinkedIn-Version': '202405', 'X-Restli-Protocol-Version': '2.0.0' } });
      for (const el of (acl.elements || []).slice(0, 20)) { const org = String(el.organization || el.organizationTarget || ''); if (/^urn:li:organization:\d+$/.test(org))
        accounts.push({ external_id: org, account_name: null, token: tok.access_token, expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null, scopes: String(tok.scope || '').split(/[\s,]+/).filter(Boolean) }); }
    } else {
      const short = await getJson(`${SP.GRAPH}/oauth/access_token?client_id=${enc(env.META_APP_ID)}&redirect_uri=${enc(redirect)}&client_secret=${enc(env.META_APP_SECRET)}&code=${enc(q.code)}`);
      const long = await getJson(`${SP.GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${enc(env.META_APP_ID)}&client_secret=${enc(env.META_APP_SECRET)}&fb_exchange_token=${enc(short.access_token)}`);
      const pages = await getJson(`${SP.GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=50`, { headers: { Authorization: `Bearer ${long.access_token}` } });
      for (const p of (pages.data || []).slice(0, 50)) {
        if (!p || !p.id || !p.access_token) continue;
        if (st.platform === 'facebook') accounts.push({ external_id: String(p.id), account_name: p.name || null, token: p.access_token, expires_at: null, scopes: [] });
        else if (p.instagram_business_account && p.instagram_business_account.id) accounts.push({ external_id: String(p.instagram_business_account.id), account_name: p.instagram_business_account.username || p.name || null, token: p.access_token, expires_at: null, scopes: [] });
      }
    }
    if (!accounts.length) return back(`social=none&platform=${st.platform}`);
    const now = new Date().toISOString();
    for (const a of accounts) {
      await sb('POST', 'dealer_social_connections?on_conflict=dealer_id,platform,external_id', { company_id: st.root, dealer_id: st.loc, platform: st.platform, external_id: a.external_id, account_name: a.account_name,
        status: 'connected', token_ciphertext: SP.seal(env, a.token), token_expires_at: a.expires_at, scopes: a.scopes, authorized_by: st.by, authorized_at: now, revoked_at: null, last_error: null, updated_at: now },
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
    return back(`social=connected&platform=${st.platform}&n=${accounts.length}`);
  } catch (e) {
    console.error('social connect failed', st.platform, String(e && e.message).slice(0, 120));   // never the code or a token
    return back('social=failed');
  }
};
