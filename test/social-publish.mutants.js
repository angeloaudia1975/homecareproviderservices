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
  { f: CR, from: "const v = ADS.validate(ad.ad, prods.map, {}); if (v.error)", to: "const v = {}; if (v.error)", why: 'ad not re-checked' },
  { f: CR, from: "const again = !!(e && e.retry) && tg.attempts + 1 < SP.MAX_ATTEMPTS;", to: "const again = false;", why: 'no retry' },
  { f: CR, from: "for (const t of stuck || []) {", to: "for (const t of []) {", why: 'interrupted target re-posted' },
  { f: CR, from: ".replace(/access_token=[^&\\s]+/gi, 'access_token=…')", to: "", why: 'token kept in an error' },
  { f: API, from: "if (missing.length) return json(409", to: "if (false) return json(409", why: 'approved without a connection' },
  { f: API, from: "status: 'awaiting_approval', approved_by: null, approved_at: null,", to: "status: 'awaiting_approval',", why: 'edit keeps the approval' },
  { f: CB, from: "token_ciphertext: SP.seal(env, a.token),", to: "token_ciphertext: a.token,", why: 'token stored in plain text' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'social-publish.test.js')], { encoding: 'utf8', env: process.env });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const sv = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  let mut = o.replace(m.from, m.to); if (m.also) mut = mut.replace(m.also[0], m.also[1]);   // both duplicate guards removed together
  fs.writeFileSync(m.f, mut); try { if (run().status !== 0) k++; else sv.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`social-publish mutants: ${k}/${M.length - bad.length} killed${sv.length ? ' — survivors: ' + sv.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(sv.length || bad.length ? 1 : 0);
