/* SOCIAL SCHEDULING & PUBLISHING — the engine (Catalog 4 §8, owner directive 2026-11-06 20:55 CT). OFF until the platforms
   approve HCPS's apps and Angelo turns it on.

   Gates (all must hold, every time — none is assumed):
     phase2_flags.social_publishing === true                       the master switch
     phase2_flags.social_meta_approved / social_linkedin_approved   that platform's app has passed its review
     env META_APP_ID + META_APP_SECRET / LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET, SOCIAL_TOKEN_KEY, SOCIAL_STATE_SECRET
     the dealer's OWN connection to that Page / account (dealer_social_connections, status connected)
     the dealer's approval of THIS post (dealer_social_posts.approved_by / approved_at — the database refuses a publishable
       status without it); HCPS never approves on a dealer's behalf
   Official APIs only: Meta Graph API (Facebook Page photos; Instagram content publishing: media → media_publish) and the
   LinkedIn Posts + Images API. Tokens: AES-256-GCM with SOCIAL_TOKEN_KEY, decrypted only inside this module, never logged and
   never returned to a browser.
   Duplicate protection: one target row per post per platform (unique); a target is claimed (pending/failed → publishing) with
   a status-guarded write before any call; a target found "publishing" for over 30 minutes is NOT retried automatically (the
   platform may have posted it) — it is marked failed "check the page before retrying" so a person decides. Retries: up to 3
   attempts per target, 15 / 30 / 60 minutes apart. Paused or cancelled posts are never claimed. */
'use strict';
const crypto = require('crypto');
const ADS = require('./_social_ads.js');

const PLATFORMS = ['facebook', 'instagram', 'linkedin'];
const APPROVAL_FLAG = { facebook: 'social_meta_approved', instagram: 'social_meta_approved', linkedin: 'social_linkedin_approved' };
const GRAPH = 'https://graph.facebook.com/v21.0';
const LI = 'https://api.linkedin.com';
const LI_VERSION = '202405';
const MAX_ATTEMPTS = 3, STUCK_MS = 30 * 60e3;
const backoff = (n) => 15 * 60e3 * Math.pow(2, Math.max(0, n - 1));

/* ---- gates ---- */
function platformOpen(flags, env, platform) {
  const f = flags || {}, e = env || {};
  if (f.social_publishing !== true) return { ok: false, reason: 'publishing_off' };
  if (f[APPROVAL_FLAG[platform]] !== true) return { ok: false, reason: 'platform_not_approved' };
  const creds = platform === 'linkedin' ? (e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_SECRET) : (e.META_APP_ID && e.META_APP_SECRET);
  if (!creds || !keyOf(e) || !e.SOCIAL_STATE_SECRET) return { ok: false, reason: 'not_configured' };
  return { ok: true };
}

/* ---- tokens: AES-256-GCM ---- */
function keyOf(env) { const k = env && env.SOCIAL_TOKEN_KEY ? Buffer.from(String(env.SOCIAL_TOKEN_KEY), 'base64') : null; return k && k.length === 32 ? k : null; }
function seal(env, plain) {
  const key = keyOf(env); if (!key) throw new Error('token key missing');
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]); return 'v1.' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
function open(env, sealed) {
  const key = keyOf(env); if (!key) throw new Error('token key missing');
  const [v, iv, tag, ct] = String(sealed || '').split('.'); if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad token');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/* ---- OAuth state: HMAC-signed, 15 minutes ---- */
function signState(env, o) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, o, { n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 15 * 60e3 }))).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', String(env.SOCIAL_STATE_SECRET)).update(body).digest('base64url');
}
function readState(env, s) {
  const [body, mac] = String(s || '').split('.'); if (!body || !mac || !env.SOCIAL_STATE_SECRET) return null;
  const want = crypto.createHmac('sha256', String(env.SOCIAL_STATE_SECRET)).update(body).digest();
  const got = Buffer.from(mac, 'base64url'); if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let o; try { o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  return o && o.exp > Date.now() ? o : null;
}
function authorizeUrl(env, platform, state, redirect) {
  if (platform === 'linkedin') return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${encodeURIComponent(env.LINKEDIN_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent('r_organization_admin w_organization_social rw_organization_admin')}`;
  const scope = platform === 'instagram' ? 'pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish,business_management' : 'pages_show_list,pages_read_engagement,pages_manage_posts';
  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(env.META_APP_ID)}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}&response_type=code`;
}

/* ---- post rules ---- */
const STATES = { draft: ['awaiting_approval', 'cancelled'], awaiting_approval: ['approved', 'draft', 'cancelled'], approved: ['paused', 'cancelled', 'publishing', 'awaiting_approval'],
  paused: ['approved', 'cancelled', 'awaiting_approval'], publishing: ['published', 'partially_published', 'failed', 'approved'], failed: ['approved', 'cancelled'], published: [], partially_published: ['approved', 'cancelled'], cancelled: [] };
const canMove = (from, to) => (STATES[from] || []).includes(to);
const editable = (status) => ['draft', 'awaiting_approval', 'approved', 'paused', 'failed'].includes(status);
function validatePost(b, now) {
  const platforms = [...new Set((Array.isArray(b.platforms) ? b.platforms : []).map(String))];
  if (!platforms.length || platforms.some((p) => !PLATFORMS.includes(p))) return { error: 'Choose Facebook, Instagram and / or LinkedIn.' };
  const at = Date.parse(b.scheduled_at); if (!Number.isFinite(at)) return { error: 'Choose a date and time.' };
  if (at < (now || Date.now()) + 5 * 60e3) return { error: 'Schedule at least 5 minutes ahead.' };
  if (at > (now || Date.now()) + 180 * 864e5) return { error: 'Schedule within the next 6 months.' };
  const caption = String(b.caption || '').trim().slice(0, ADS.LIMITS.caption);
  if (platforms.includes('instagram') && b.format === 'landscape') return { error: 'Instagram does not take the landscape size — use square, portrait or story.' };
  if (platforms.includes('linkedin') && b.format === 'story') return { error: 'LinkedIn does not take the story size.' };
  return { post: { platforms, scheduled_at: new Date(at).toISOString(), caption } };
}

/* ---- providers (official APIs). deps: { fetch, env, mediaUrl, mediaBytes } ---- */
async function call(f, url, opts) { let r; try { r = await f(url, opts); } catch (e) { const x = new Error('no answer from the platform'); x.retry = true; throw x; } const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (!r.ok) { const m = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || ('HTTP ' + r.status); const e = new Error(String(m).slice(0, 200)); e.status = r.status; e.retry = r.status >= 500 || r.status === 429; throw e; }
  return { j, headers: r.headers }; }
/* the call that actually posts: a server error / rate limit / no answer there is AMBIGUOUS (the platform may have posted) —
   marked final so the worker never retries it automatically (review #115 S1) */
const finalCall = async (f, url, opts) => { try { return await call(f, url, opts); } catch (e) { e.final = true; throw e; } };
const PROVIDERS = {
  async facebook(d, conn, token, post) {
    const body = new URLSearchParams({ url: d.mediaUrl, caption: post.caption || '', access_token: token, published: 'true' });
    const { j } = await finalCall(d.fetch, `${GRAPH}/${encodeURIComponent(conn.external_id)}/photos`, { method: 'POST', body });
    return String(j.post_id || j.id);
  },
  async instagram(d, conn, token, post) {
    const ig = encodeURIComponent(conn.external_id);
    const p = { image_url: d.mediaUrl, access_token: token }; if (post.format === 'story') p.media_type = 'STORIES'; else p.caption = post.caption || '';
    const { j } = await call(d.fetch, `${GRAPH}/${ig}/media`, { method: 'POST', body: new URLSearchParams(p) });
    const { j: k } = await finalCall(d.fetch, `${GRAPH}/${ig}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: j.id, access_token: token }) });
    return String(k.id);
  },
  async linkedin(d, conn, token, post) {
    const owner = /^urn:li:/.test(conn.external_id) ? conn.external_id : `urn:li:organization:${conn.external_id}`;
    const H = { Authorization: `Bearer ${token}`, 'LinkedIn-Version': LI_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'content-type': 'application/json' };
    const { j } = await call(d.fetch, `${LI}/rest/images?action=initializeUpload`, { method: 'POST', headers: H, body: JSON.stringify({ initializeUploadRequest: { owner } }) });
    const up = j && j.value; if (!up || !up.uploadUrl || !up.image) throw new Error('LinkedIn upload not offered');
    const bytes = await d.mediaBytes();
    const u = await d.fetch(up.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes }); if (!u.ok) { const e = new Error('LinkedIn upload ' + u.status); e.retry = u.status >= 500; throw e; }
    const { headers } = await finalCall(d.fetch, `${LI}/rest/posts`, { method: 'POST', headers: H, body: JSON.stringify({ author: owner, commentary: post.caption || '', visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, content: { media: { id: up.image } }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false }) });
    return String((headers && headers.get && (headers.get('x-restli-id') || headers.get('x-linkedin-id'))) || 'posted');
  },
};

/* overall post status from its targets */
function rollup(targets) {
  const s = targets.map((t) => t.status);
  if (s.length && s.every((x) => x === 'published')) return 'published';
  if (s.some((x) => x === 'pending' || x === 'publishing')) return 'publishing';
  if (s.some((x) => x === 'published')) return 'partially_published';
  return 'failed';
}

module.exports = { PLATFORMS, APPROVAL_FLAG, MAX_ATTEMPTS, STUCK_MS, backoff, platformOpen, seal, open, signState, readState, authorizeUrl, canMove, editable, validatePost, PROVIDERS, rollup, GRAPH, LI };
