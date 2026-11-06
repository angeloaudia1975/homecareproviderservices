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
  { f: P, from: 'v.row.email ? { reply_to: v.row.email } : {}', to: '{}', why: 'no reply-to' },
  { f: D, from: "const mayWrite = (loc) => !who.preview && mayRead(loc) && (headOffice || String(loc) === did);", to: "const mayWrite = (loc) => mayRead(loc) && (headOffice || String(loc) === did);", why: 'preview writes' },
  { f: D, from: 'if (taken && taken.length)', to: 'if (false)', why: 'taken address reused' },
  { f: D, from: 'if (Number(b.version) !== row.version)', to: 'if (false)', why: 'stale save accepted' },
  { f: D, from: "if (!s || GOLDEN.has(s) || off.has(s)", to: "if (!s || off.has(s)", why: 'Golden offered to the dealer' },
  { f: P, from: "const p = it && typeof it === 'object' ? find(it.manufacturer, it.code) : null;", to: "const p = it && typeof it === 'object' ? (find(it.manufacturer, it.code) || { manufacturer: 'golden-technologies', code: String(it.code), category: 'x' }) : null;", why: 'counts for products not shown' },
  { f: P, from: "sbAll(`product_skus?${q}&select=code,msrp,msrp_auto,status,uom,case_qty,msrp_basis&order=code.asc`)", to: "sbAll(`product_skus?${q}&select=code,msrp,msrp_auto,status,uom,case_qty,msrp_basis&order=code.asc`).catch(() => [])", why: 'unreadable records shown as none' },
  { f: P, from: "if (p) { v.row.product_name = p.name; v.row.category = p.category; } else {", to: "if (true) { v.row.product_name = p ? p.name : 'x'; } else {", why: 'foreign product kept on an inquiry' },
  { f: P, from: "v.row.product_name = p.name;", to: "v.row.product_name = (b.product && b.product.name) || p.name;", why: 'visitor product name trusted' },
  { f: P, from: "if (!loc || loc.active === false) return null;", to: "if (!loc) return null;", why: 'closed location public' },
  { f: P, from: "if (!(h && h[0]) || h[0].active === false) return null;", to: "", why: 'closed head office ignored' },
  { f: P, from: "phone: sf.phone || '', email: sf.email || '',", to: "phone: sf.phone || '555-0100', email: sf.email || 'hq@acme.test',", why: 'account contacts made public' },
  { f: P, from: "u && SF.logoOk(u, SUPABASE_URL)", to: "u", why: 'third-party logo' },
  { f: P, from: "const v = await fn(); if (v == null) { CACHE.delete(key); return v; }", to: "const v = await fn();", why: 'not-found cached' },
  { f: P, from: "while (CACHE.size > CACHE_MAX)", to: "while (false)", why: 'unbounded cache' },
  { f: P, from: "const to = res && res.send && res.to;", to: "const to = S.public.dealer.email || (res && res.to);", why: 'email limit / live address ignored' },
  { f: P, from: "if (res.refused === 'unavailable') {", to: "if (false) {", why: 'switched-off storefront accepts' },
  { f: P, from: "if (res && res.refused) {", to: "if (false) {", why: 'refusals ignored' },
  { f: P, from: ".digest('hex').slice(0, 32);", to: ".digest('hex').slice(0, 32) && ip;", why: 'raw address sent' },
  { f: R, from: "if (st === 'discontinued' || sx.disabled === true || sst === 'hidden' || sst === 'discontinued') hiddenU.add(c);", to: "if (sx.disabled === true || sst === 'hidden') hiddenU.add(c);", why: 'discontinued page shown' },
  { f: R, from: "if (st === 'discontinued' || sx.disabled === true || sst === 'hidden' || sst === 'discontinued') hiddenU.add(c);", to: "if (st === 'discontinued' || sst === 'discontinued') hiddenU.add(c);", why: 'hidden SKU shown' },
  { f: R, from: "if (pg.disabled === true || !['published', 'active', 'discontinued'].includes(st)) continue;", to: "", why: 'hidden / off pages hide catalog products (shop parity)' },
  { f: R, from: "if (basis === 'each') return 'each';", to: "", why: 'per-piece MSRP labelled per case' },
  { f: R, from: "const u = clean(r.uom || p.uom, 40); const q = Number(r.case_qty || p.case_qty);", to: "const u = clean(p.uom, 40); const q = Number(p.case_qty);", why: 'record unit ignored' },
  { f: R, from: "const IMG = /^\\/assets\\/[A-Za-z0-9._\\/%+-]{1,300}$/;", to: "const IMG = /^(\\/assets\\/[A-Za-z0-9._\\/%+-]{1,300}|https:.*)$/;", why: 'third-party photo host' },
  { f: P, from: "if (ip.includes(':')) { const full = expand6(ip); if (full) ip = full.slice(0, 4).join(':') + '::/64'; }", to: "", why: 'IPv6 rotation defeats limits' },
  { f: R, from: "(only ? !only.has(U(code)) : false)", to: "false", why: 'enriched-only ignored' },
  { f: R, from: "if (pg.disabled === true || !['published', 'active', 'discontinued'].includes(st)) continue;", to: "if (pg.disabled === true) continue;", why: 'draft page counts for enriched-only' },
  { f: R, from: ".replace(/[\\r\\n\\t]+/g, ' ');\n  return { subject: subj,", to: ";\n  return { subject: subj,", why: 'line breaks in subject' },
  { f: D, from: "if (eff.enabled === true && !eff.phone && !eff.email)", to: "if (false)", why: 'live storefront without contact' },
  { f: D, from: "if (who.preview) return json(200, { ok: true, inquiries: [], hidden_in_preview: true });", to: "", why: 'preview reads customers' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'storefront.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`storefront mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);
