/* Mutation check for C3-07 Stage 7 storefronts: test/storefront.test.js must fail on every mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const R = F('_storefront.js'), P = F('storefront-public.js'), D = F('dealer-storefront-api.js');
const M = [
  { f: R, from: 'if (r.msrp_auto !== true && num(r.msrp))', to: 'if (num(r.msrp))', why: 'HCPS-derived MSRP shown publicly' },
  { f: R, from: "if (r.status && r.status !== 'active') hidden.add(String(r.code));", to: '', why: 'discontinued product shown' },
  { f: R, from: 'if (p.active === false || ', to: 'if (', why: 'switched-off product shown' },
  { f: R, from: 'return { manufacturer: line, code:', to: 'return { ...p, manufacturer: line, code:', why: 'catalog fields (wholesale) leak' },
  { f: R, from: "image: IMG.test(String(p.image || '')) ? String(p.image) : null", to: 'image: p.image || null', why: 'unsafe image URL' },
  { f: R, from: "const price = priceMode === 'msrp' ?", to: 'const price = true ?', why: 'Call for Price mode ignored' },
  { f: R, from: "if (String(b.hp || '')) return { spam: true };", to: '', why: 'honeypot ignored' },
  { f: R, from: "  if (b.consent !== true) return { error: 'Please agree to the dealer contacting you about your request.' };\n", to: '', why: 'no consent needed' },
  { f: R, from: "if (L.some((x) => !ok.has(x))) return { error: 'You can show only lines your account is authorized for.' };", to: '', why: 'unauthorized line allowed' },
  { f: R, from: 'if (RESERVED.has(s) || /--/.test(s))', to: 'if (false)', why: 'reserved address allowed' },
  { f: R, from: '<td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td>', to: '<td style="padding:4px 0;white-space:pre-wrap">${v}</td>', why: 'email not escaped' },
  { f: P, from: "s && !GOLDEN.has(s) && !off.has(s)", to: 's && !off.has(s)', why: 'Golden shown' },
  { f: P, from: "s && !GOLDEN.has(s) && !off.has(s) && !RETIRED.isRetiredLine(s)", to: 's && !GOLDEN.has(s) && !RETIRED.isRetiredLine(s)', why: 'switched-off line shown' },
  { f: P, from: 'if (!sf || !sf.enabled || sf.hcps_blocked) return null;', to: 'if (!sf || !sf.enabled) return null;', why: 'blocked storefront shown' },
  { f: P, from: 'if (!sf || !sf.enabled || sf.hcps_blocked) return null;', to: 'if (!sf || sf.hcps_blocked) return null;', why: 'turned-off storefront shown' },
  { f: P, from: 'if (hiddenCats.has(pp.category.toLowerCase())) continue;', to: '', why: 'hidden category shown' },
  { f: P, from: "(Array.isArray(b.items) ? b.items.slice(0, 40) : []).filter(known)", to: "(Array.isArray(b.items) ? b.items.slice(0, 40) : []).filter((x) => x && x.code)", why: 'counts for products not shown' },
  { f: P, from: '&created_at=gte.${enc(dayAgo)}`) >= 3)', to: '&created_at=gte.${enc(dayAgo)}`) >= 30)', why: 'no per-email limit' },
  { f: P, from: '&created_at=gte.${enc(hourAgo)}`) >= 10)', to: '&created_at=gte.${enc(hourAgo)}`) >= 100)', why: 'no per-storefront limit' },
  { f: P, from: 'v.row.email ? { reply_to: v.row.email } : {}', to: '{}', why: 'no reply-to' },
  { f: P, from: "sb('GET', `product_skus?${q}&select=code,msrp,msrp_auto,status&limit=5000`)", to: "sb('GET', `product_skus?${q}&select=code,msrp,msrp_auto,status&limit=5000`).catch(() => [])", why: 'unreadable records shown as none' },
  { f: P, from: "if (v.row.manufacturer && !known(", to: "if (false && !known(", why: 'foreign product kept on an inquiry' },
  { f: D, from: "const mayWrite = (loc) => !who.preview && mayRead(loc) && (headOffice || String(loc) === did);", to: "const mayWrite = (loc) => mayRead(loc) && (headOffice || String(loc) === did);", why: 'preview writes' },
  { f: D, from: 'if (taken && taken.length)', to: 'if (false)', why: 'taken address reused' },
  { f: D, from: 'if (Number(b.version) !== row.version)', to: 'if (false)', why: 'stale save accepted' },
  { f: D, from: "if (!s || GOLDEN.has(s) || off.has(s)", to: "if (!s || off.has(s)", why: 'Golden offered to the dealer' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'storefront.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`storefront mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);
