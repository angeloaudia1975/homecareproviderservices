/* Mutants for scheduling & publishing (Catalog 4 §8 Batch D). Each must fail test/social-publish.test.js.   node test/social-publish.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const SPf = F('_social_publish.js'), CR = F('social-publish-cron.js'), API = F('dealer-ads-api.js'), CB = F('social-oauth-callback.js');
const M = [
  { f: SPf, from: "if (f.social_publishing !== true) return { ok: false, reason: 'publishing_off' };", to: "", why: 'master switch ignored' },
  { f: SPf, from: "if (f[APPROVAL_FLAG[platform]] !== true) return", to: "if (false) return", why: 'platform approval ignored' },
  { f: SPf, from: "if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;", to: "", why: 'state signature not checked' },
  { f: SPf, from: "if (at < (now || Date.now()) + 5 * 60e3)", to: "if (false)", why: 'past times accepted' },
  { f: CR, from: "if (f.social_publishing !== true) return { skipped: 'publishing_off' };", to: "", why: 'worker runs with the switch off' },
  { f: CR, from: "&approved_by=not.is.null", to: "", why: 'unapproved posts published' },
  { f: CR, from: "if (!tg || tg.status === 'published' || tg.status === 'publishing' || tg.status === 'cancelled' || tg.attempts >= SP.MAX_ATTEMPTS) continue;", to: "if (!tg) continue;", why: 'published twice (pre-check)', also: ["&status=in.(pending,failed)&attempts=eq.${tg.attempts}`, { status: 'publishing'", "&attempts=eq.${tg.attempts}`, { status: 'publishing'"] },
  { f: CR, from: "if (post.attempts === 0 && Date.parse(post.scheduled_at) < now - 24 * 3600e3) {", to: "if (false) {", why: 'published a day late' },
  { f: CR, from: "const v = ADS.validate(ad.ad, prods.map, { allow: [card.name, card.city] }); if (v.error) { await finish('failed', { last_error: 'The ad needs attention: ' + v.error }); out.failed++; continue; }", to: "const v = ADS.validate(ad.ad, new Map([...prods.map.keys()].concat(ad.ad.products.map((r) => `${r.manufacturer}|${String(r.code).toUpperCase()}`)).map((k) => [k, prods.map.get(k) || {}])), {}); if (false) {}", why: 'ad not re-checked' },
  { f: CR, from: "const again = !ambiguous && !!(e && e.retry) && tg.attempts + 1 < SP.MAX_ATTEMPTS;", to: "const again = false;", why: 'no retry' },
  { f: CR, from: "for (const t of stuck || []) {", to: "for (const t of []) {", why: 'interrupted target re-posted' },
  { f: CR, from: ".replace(/access_token=[^&\\s\"]+/gi, 'access_token=…')", to: "", why: 'token kept in an error' },
  { f: API, from: "if (missing.length) return json(409", to: "if (false) return json(409", why: 'approved without a connection' },
  { f: API, from: "status: 'awaiting_approval', approved_by: null, approved_at: null,", to: "status: 'awaiting_approval',", why: 'edit keeps the approval' },
  { f: CB, from: "token_ciphertext: SP.seal(env, a.token),", to: "token_ciphertext: a.token,", why: 'token stored in plain text' },
  { f: CB, from: "|| cookieOf(event) !== st0.nonce) return back('social=refused');", to: ") return back('social=refused');", why: 'another browser completes a sign-in' },
  { f: CB, from: "&begun_at=not.is.null&used_at=is.null&created_at", to: "&begun_at=not.is.null&created_at", why: 'a sign-in replayed' },
  { f: CB, from: "&begun_at=is.null&used_at=is.null&created_at", to: "&created_at", why: 'a begin link reused' },
  { f: CB, from: "status: 'pending', token_ciphertext:", to: "status: 'connected', token_ciphertext:", why: 'every Page connected without the dealer choosing' },
  { f: CR, from: "if (nowPrices !== thenPrices) {", to: "if (false) {", why: 'stale price published' },
  { f: CR, from: "if (P0.ad_version == null || Number(ad.version) !== Number(P0.ad_version)) {", to: "if (false) {", why: 'edited ad publishes the old image' },
  { f: CR, from: "const ambiguous = !!(e && e.final && e.retry);", to: "const ambiguous = false;", why: 'ambiguous posting call retried' },
  { f: API, from: "if (b.action === 'post_resume' && Date.parse(cur.scheduled_at) < Date.now() + 5 * 60e3) return", to: "if (false) return", why: 'paused post resumes late' },
  { f: API, from: "await sb('PATCH', `dealer_social_post_targets?post_id=eq.${enc(cur.id)}&status=in.(failed,cancelled)`", to: "if (false) await sb('PATCH', `dealer_social_post_targets?post_id=eq.${enc(cur.id)}&status=in.(failed,cancelled)`", why: 'failed platforms never restart' },
  { f: API, from: "if (!c || !C.mayWrite(c.dealer_id) || c.status !== 'pending'", to: "if (!c || c.status !== 'pending'", why: 'another location chooses an account' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'social-publish.test.js')], { encoding: 'utf8', env: process.env });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const sv = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  let mut = o.replace(m.from, m.to); if (m.also) mut = mut.replace(m.also[0], m.also[1]);   // both duplicate guards removed together
  fs.writeFileSync(m.f, mut); try { if (run().status !== 0) k++; else sv.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`social-publish mutants: ${k}/${M.length - bad.length} killed${sv.length ? ' — survivors: ' + sv.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(sv.length || bad.length ? 1 : 0);
