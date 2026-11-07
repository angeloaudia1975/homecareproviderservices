// Catalog 4 §8 — publishes APPROVED scheduled posts, every 5 minutes. Does nothing unless phase2_flags.social_publishing is
// exactly true (and each platform's own approval switch + credentials — _social_publish.platformOpen). Rules:
//  - only status "approved" with a dealer approval on record, scheduled_at reached, retry time reached; a post more than 24 h
//    past its time that never started is NOT published late — it fails "missed its time" for the dealer to reschedule;
//  - claimed with a status + version guarded write (two runs never publish the same post);
//  - before publishing, the ad is checked again: every product still authorized and listed (else it fails with the reason);
//  - per platform one target row (unique); a target already published is never published again; a target left
//    "publishing" for 30+ minutes is failed "check the page before retrying" (never re-posted automatically);
//  - up to 3 attempts per target for temporary errors (15 / 30 / 60 min); paused or cancelled posts are never touched.
'use strict';
const SP = require('./_social_publish.js');
const ADS = require('./_social_ads.js');
const { flags } = require('./_flags.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = (process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app').replace(/\/+$/, '');
const enc = encodeURIComponent;
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sb(method, p, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
}
async function sbAll(base) { let from = 0, out = []; for (;;) { const rows = await sb('GET', `${base}&limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) return out; from += 1000; } }
const SH = require('./_ads_shared.js')({ sb, sbAll, SUPABASE_URL, ORDERING_BASE });
async function signed(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/social-media/${path}`, { method: 'POST', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
  if (!r.ok) return null; const j = await r.json(); const u = j && (j.signedURL || j.signedUrl); return u ? `${SUPABASE_URL}/storage/v1${u.startsWith('/') ? '' : '/'}${u}` : null;
}
const errText = (e) => String((e && e.message) || e || 'error').replace(/access_token=[^&\s"]+/gi, 'access_token=…').replace(/Bearer\s+\S+/gi, 'Bearer …').slice(0, 300);

async function run(now) {
  now = now || Date.now(); const env = process.env;
  let f; try { f = await flags((p) => sb('GET', p)); } catch (e) { return { skipped: 'flags_unreadable' }; }
  if (f.social_publishing !== true) return { skipped: 'publishing_off' };
  const iso = new Date(now).toISOString(); const out = { published: 0, failed: 0, retry: 0, stuck: 0, missed: 0 };
  /* 1. targets left "publishing" (a crash mid-call): never re-posted automatically */
  const stuck = await sb('GET', `dealer_social_post_targets?status=eq.publishing&claimed_at=lt.${enc(new Date(now - SP.STUCK_MS).toISOString())}&select=id`);
  for (const t of stuck || []) { await sb('PATCH', `dealer_social_post_targets?id=eq.${enc(t.id)}&status=eq.publishing`, { status: 'failed', last_error: 'Interrupted while publishing — check the page before retrying (it may already be posted).', attempts: SP.MAX_ATTEMPTS }, { Prefer: 'return=minimal' }); out.stuck++; }
  /* a post left "publishing" (a crash between targets) is closed from its targets; never re-run automatically */
  const stuckPosts = await sb('GET', `dealer_social_posts?status=eq.publishing&updated_at=lt.${enc(new Date(now - SP.STUCK_MS).toISOString())}&select=id,version`);
  for (const p of stuckPosts || []) { const tg = await sb('GET', `dealer_social_post_targets?post_id=eq.${enc(p.id)}&select=status`); const st = SP.rollup(tg || []);
    await sb('PATCH', `dealer_social_posts?id=eq.${enc(p.id)}&status=eq.publishing&version=eq.${p.version}`, { status: st === 'publishing' ? 'failed' : st, version: p.version + 1, last_error: st === 'published' ? null : 'Interrupted — check the pages before retrying.', updated_at: iso, updated_by: 'system' }, { Prefer: 'return=minimal' }); out.stuck++; }
  /* 2. due posts */
  const due = await sb('GET', `dealer_social_posts?status=eq.approved&approved_by=not.is.null&scheduled_at=lte.${enc(iso)}&or=(next_attempt_at.is.null,next_attempt_at.lte.${enc(iso)})&select=*&order=scheduled_at.asc&limit=10`);
  for (const post of due || []) {
    if (post.attempts === 0 && Date.parse(post.scheduled_at) < now - 24 * 3600e3) {
      await sb('PATCH', `dealer_social_posts?id=eq.${enc(post.id)}&status=eq.approved&version=eq.${post.version}`, { status: 'failed', version: post.version + 1, last_error: 'Missed its time (publishing was off) — choose a new time and approve again.', updated_at: iso, updated_by: 'system' }, { Prefer: 'return=minimal' });
      out.missed++; continue;
    }
    const claim = await sb('PATCH', `dealer_social_posts?id=eq.${enc(post.id)}&status=eq.approved&version=eq.${post.version}`, { status: 'publishing', version: post.version + 1, updated_at: iso, updated_by: 'system' }, { Prefer: 'return=representation' });
    if (!(claim && claim.length)) continue;
    const P0 = claim[0]; let finalStatus = null, lastError = null, retryable = false;
    const finish = async (status, extra) => sb('PATCH', `dealer_social_posts?id=eq.${enc(P0.id)}&status=eq.publishing&version=eq.${P0.version}`, Object.assign({ status, version: P0.version + 1, updated_at: new Date().toISOString(), updated_by: 'system' }, extra || {}), { Prefer: 'return=minimal' });
    try {
      /* the ad is checked again now: authorized products, clean words */
      const ad = (await sb('GET', `dealer_social_ads?id=eq.${enc(P0.ad_id)}&select=dealer_id,ad,version,archived_at`) || [])[0];
      if (!ad || ad.archived_at || String(ad.dealer_id) !== String(P0.dealer_id)) { await finish('failed', { last_error: 'The ad was archived or moved.' }); out.failed++; continue; }
      if (P0.ad_version == null || Number(ad.version) !== Number(P0.ad_version)) { await finish('failed', { last_error: 'The ad was edited after this post was scheduled — schedule it again.' }); out.failed++; continue; }
      const prods = await SH.productsFor({ root: P0.company_id }, String(P0.dealer_id));
      if (prods.storefront && prods.storefront.hcps_blocked) { await finish('failed', { last_error: 'HCPS has paused public marketing for this location.' }); out.failed++; continue; }
      const card = await SH.dealerCard(String(P0.dealer_id), prods.storefront);
      const v = ADS.validate(ad.ad, prods.map, { allow: [card.name, card.city] }); if (v.error) { await finish('failed', { last_error: 'The ad needs attention: ' + v.error }); out.failed++; continue; }
      /* review #115 B2: the image carries the price as scheduled — if any advertised price is different now, stop */
      const nowPrices = v.ad.products.map((r) => { const x = ADS.renderProduct(prods.map.get(`${r.manufacturer}|${String(r.code).toUpperCase()}`), r.show_price); return `${x.manufacturer}|${x.code}|${x.price}|${x.price_label}`; }).join(';');
      const thenPrices = (P0.products_snapshot || []).map((x) => `${x.manufacturer}|${x.code}|${x.price}|${x.price_label}`).join(';');
      if (nowPrices !== thenPrices) { await finish('failed', { last_error: 'A price changed since this post was scheduled — schedule it again so the image shows today\'s price.' }); out.failed++; continue; }
      const url = await signed(P0.media_path); if (!url) throw Object.assign(new Error('The image could not be read.'), { retry: true });
      const bytes = async () => { const r = await fetch(url); if (!r.ok) throw Object.assign(new Error('image ' + r.status), { retry: true }); return Buffer.from(await r.arrayBuffer()); };
      for (const platform of P0.platforms) {
        await sb('POST', 'dealer_social_post_targets?on_conflict=post_id,platform', { post_id: P0.id, platform }, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
        const tg = (await sb('GET', `dealer_social_post_targets?post_id=eq.${enc(P0.id)}&platform=eq.${platform}&select=*`))[0];
        if (!tg || tg.status === 'published' || tg.status === 'publishing' || tg.status === 'cancelled' || tg.attempts >= SP.MAX_ATTEMPTS) continue;
        const gate = SP.platformOpen(f, env, platform);
        if (!gate.ok) { await sb('PATCH', `dealer_social_post_targets?id=eq.${enc(tg.id)}`, { last_error: 'Not available: ' + gate.reason }, { Prefer: 'return=minimal' }); retryable = true; continue; }
        const conn = (await sb('GET', `dealer_social_connections?dealer_id=eq.${enc(P0.dealer_id)}&platform=eq.${platform}&status=eq.connected&select=id,external_id,token_ciphertext&order=authorized_at.desc&limit=1`))[0];
        if (!conn || !conn.token_ciphertext) { await sb('PATCH', `dealer_social_post_targets?id=eq.${enc(tg.id)}&status=in.(pending,failed)`, { status: 'failed', attempts: SP.MAX_ATTEMPTS, last_error: 'Not connected — connect the account and approve again.' }, { Prefer: 'return=minimal' }); continue; }
        const got = await sb('PATCH', `dealer_social_post_targets?id=eq.${enc(tg.id)}&status=in.(pending,failed)&attempts=eq.${tg.attempts}`, { status: 'publishing', claimed_at: new Date().toISOString(), attempts: tg.attempts + 1, connection_id: conn.id }, { Prefer: 'return=representation' });
        if (!(got && got.length)) continue;
        try {
          const ext = await SP.PROVIDERS[platform]({ fetch, env, mediaUrl: url, mediaBytes: bytes }, conn, SP.open(env, conn.token_ciphertext), { caption: [P0.caption].filter(Boolean).join(''), format: P0.format });
          await sb('PATCH', `dealer_social_post_targets?id=eq.${enc(tg.id)}&status=eq.publishing`, { status: 'published', external_post_id: ext, published_at: new Date().toISOString(), last_error: null }, { Prefer: 'return=minimal' }); out.published++;
        } catch (e) {
          const ambiguous = !!(e && e.final && e.retry);   // the posting call itself got no clear answer — it may be posted
          const again = !ambiguous && !!(e && e.retry) && tg.attempts + 1 < SP.MAX_ATTEMPTS; if (again) retryable = true;
          await sb('PATCH', `dealer_social_post_targets?id=eq.${enc(tg.id)}&status=eq.publishing`, { status: 'failed', last_error: ambiguous ? 'The platform did not confirm — check the page before retrying (it may already be posted).' : errText(e), attempts: again ? tg.attempts + 1 : SP.MAX_ATTEMPTS }, { Prefer: 'return=minimal' });
          if (e && e.status === 401) await sb('PATCH', `dealer_social_connections?id=eq.${enc(conn.id)}`, { status: 'expired', last_error: 'Sign-in expired — reconnect.', updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
          lastError = errText(e);
        }
      }
      const targets = await sb('GET', `dealer_social_post_targets?post_id=eq.${enc(P0.id)}&select=status,attempts`);
      finalStatus = SP.rollup(targets || []);
      if (retryable && finalStatus !== 'published') { await finish('approved', { attempts: P0.attempts + 1, next_attempt_at: new Date(Date.now() + SP.backoff(P0.attempts + 1)).toISOString(), last_error: lastError }); out.retry++; }
      else { await finish(finalStatus === 'publishing' ? 'failed' : finalStatus, { last_error: lastError }); if (finalStatus !== 'published') out.failed++; }
    } catch (e) {
      const again = P0.attempts + 1 < SP.MAX_ATTEMPTS && !!(e && e.retry);
      await finish(again ? 'approved' : 'failed', { attempts: P0.attempts + 1, next_attempt_at: again ? new Date(Date.now() + SP.backoff(P0.attempts + 1)).toISOString() : null, last_error: errText(e) });
      if (again) out.retry++; else out.failed++;
    }
  }
  return out;
}
exports.run = run;
exports.handler = async () => { try { const r = await run(); if (!r.skipped) console.log('social publish', JSON.stringify(r)); return { statusCode: 200, body: JSON.stringify(r) }; }
  catch (e) { console.error('social publish failed', errText(e)); return { statusCode: 200, body: '{"error":"failed"}' }; } };
