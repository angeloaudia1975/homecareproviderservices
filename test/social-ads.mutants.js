/* Mutants for the Social Media Ad Builder (Catalog 4 §8). Each must fail test/social-ads.test.js.   node test/social-ads.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const A = F('dealer-ads-api.js'), S = F('_social_ads.js');
const M = [
  { f: S, from: "if (!products || !products.has(key)) return", to: "if (false) return", why: 'unauthorized product accepted' },
  { f: S, from: "const c = claimProblem(out[f], allow); if (c) return", to: "const c = null; if (c) return", why: 'claims not checked' },
  { f: S, from: "[/\\$\\s*\\d[\\d,.]*|", to: "[/\\$\\$\\$|", why: 'typed prices allowed' },
  { f: S, from: "if (T.kind === 'multi' && (n < 2 || n > max))", to: "if (false)", why: 'grid with one product' },
  { f: S, from: "if (t.length >= 3) s = s.split(", to: "if (false) s = s.split(", why: 'official names treated as claims' },
  { f: S, from: "price_label: showPrice ? (price != null ? (p.price_label || null) : 'Call for Price') : null", to: "price_label: p.price_label || null", why: 'no Call for Price' },
  { f: A, from: "if (Number(b.version) !== row.version) return json(409", to: "if (false) return json(409", why: 'no compare-and-set' },
  { f: A, from: "if (!p) { problems.push(", to: "if (!p && false) { problems.push(", why: 'unauthorized product silently kept' },
  { f: A, from: "url = OWN_IMG.test(img) ? ORDERING_BASE + img : GOLDEN_IMG.test(img) ? img : null;", to: "url = b.url || (OWN_IMG.test(img) ? ORDERING_BASE + img : null);", why: 'typed image URL fetched' },
  { f: A, from: "if (!httpsImage(l)) return", to: "if (false) return", why: 'internal logo URL fetched' },
  { f: A, from: "&archived_at=is.null&select=", to: "&select=", why: 'archived ads listed' },
  { f: A, from: "return x && C.mayRead(x.dealer_id) ? x : null;", to: "return x || null;", why: 'another company\'s ad readable' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'social-ads.test.js')], { encoding: 'utf8', env: process.env });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const sv = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else sv.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`social-ads mutants: ${k}/${M.length - bad.length} killed${sv.length ? ' — survivors: ' + sv.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(sv.length || bad.length ? 1 : 0);
