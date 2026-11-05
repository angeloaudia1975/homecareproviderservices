'use strict';
/* Time-limited breaks survive every admin tier write (C3-05, 2026-11-04): Product Catalog / Price Check (save_override),
   the price-list import, the canonical record path (keepPools) and the record feed. A malformed end drops the break;
   re-sending a ladder without `until` keeps the end the break already has — a promotion can never become permanent. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'netlify', 'functions');
const SRC = fs.readFileSync(path.join(ROOT, 'catalog-api.js'), 'utf8');
const num = v => { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; };
const F = new Function('num', SRC.slice(SRC.indexOf('const UNTIL_RE='), SRC.indexOf('/* ─────────────────────── Duplicate detection')) + ';return {cleanTiers,keepPools,hasNoEnd};')(num);
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const E = '2027-01-01T06:00:00Z';
t('cleanTiers keeps a full ISO end and drops the WHOLE break when the end is malformed or date-only', () => {
  eq(F.cleanTiers([{ min_qty: 4, price: 90, until: E }]), [{ min_qty: 4, price: 90, until: E }]);
  eq(F.cleanTiers([{ min_qty: 4, price: 90, until: ' 2027-01-01T00:00:00-06:00 ' }]), [{ min_qty: 4, price: 90, until: '2027-01-01T00:00:00-06:00' }]);
  for (const bad of ['2027-01-01', 'soon', '2027-13-45T99:99:99Z']) eq(F.cleanTiers([{ min_qty: 4, price: 90, until: bad }, { min_qty: 2, price: 95 }]), [{ min_qty: 2, price: 95 }], bad);
  eq(F.cleanTiers([{ min_qty: 4, price: 90, until: '' }]), [{ min_qty: 4, price: 90 }]);
});
t('keepPools keeps the existing end (and pool) when an edit re-sends the ladder without them', () => {
  eq(F.keepPools([{ min_qty: 4, price: 85 }], [{ min_qty: 4, price: 90, until: E }]), [{ min_qty: 4, price: 85, until: E }]);
  eq(F.keepPools([{ min_qty: 2, price: 9 }], [{ min_qty: 2, price: 9, pool: 'x' }]), [{ min_qty: 2, price: 9, pool: 'x' }]);
  eq(F.keepPools([{ min_qty: 6, price: 80 }], [{ min_qty: 4, price: 90, until: E }]), [{ min_qty: 6, price: 80 }], 'a different break gets no end');
});
t('save_override and the price-list import both merge with the current ladder when it has an end (strict read)', () => {
  const so = SRC.slice(SRC.indexOf('if(b.action==="save_override"){'), SRC.indexOf('if("active" in p) patch.active=(p.active!==false);'));
  if (!/if\(\(cleanTiers\(cur\)\|\|\[\]\)\.some\(x=>x\.until\)\) nt=keepPools\(p\.tiers,cur\);/.test(so)) throw new Error('save_override does not keep the end');
  if (!/return json\(503,\{error:"the current price ladder could not be read — nothing saved"/.test(so)) throw new Error('save_override is not strict');
  if (!/if\(\(cleanTiers\(cur\)\|\|\[\]\)\.some\(x=>x\.until\)\) pf=Object\.assign\(\{\},pf,\{tiers:keepPools\(r\.tiers,cur\)\}\);/.test(SRC)) throw new Error('import does not keep the end');
});
t('the record feed carries the end exactly like catalog-feed (both repos)', () => {
  const P = require(path.join(ROOT, '_pricing.js'));
  const rows = [{ code: 'S', base_price: 100, tiers: [{ min_qty: 4, price: 90, until: E }, { min_qty: 2, price: 95, pool: 'p' }] }];
  const got = P.feedRows(JSON.parse(JSON.stringify(rows)))[0].tiers;
  eq(got, [{ min_qty: 2, price: 95, pool: 'p' }, { min_qty: 4, price: 90, until: E }]);
  const ORD = process.env.ORDER_REPO || path.join(__dirname, '..', '..', 'homecareproviderservicesordering');
  const f = path.join(ORD, 'netlify', 'functions', 'catalog-feed.js');
  if (fs.existsSync(f)) eq(require(f).feedRows(JSON.parse(JSON.stringify(rows)))[0].tiers, got, 'catalog-feed');
});
t('impossible calendar instants end the break (V8 would roll them forward; Safari refuses them)', () => {
  for (const bad of ['2027-02-30T00:00:00Z', '2027-01-01T24:00Z', '2027-04-31T06:00:00Z', '2027-01-01T06:60:00Z', '2027-01-01T06:00:00+24:00'])
    eq(F.cleanTiers([{ min_qty: 4, price: 90, until: bad }, { min_qty: 2, price: 95 }]), [{ min_qty: 2, price: 95 }], bad);
  eq(F.cleanTiers([{ min_qty: 4, price: 90, until: '2028-02-29T06:00:00Z' }])[0].until, '2028-02-29T06:00:00Z', 'leap day is real');
});
t('until:"none" removes an end explicitly; a new price at the same quantity otherwise keeps it', () => {
  eq(F.keepPools([{ min_qty: 4, price: 88, until: 'none' }], [{ min_qty: 4, price: 90, until: E }]), [{ min_qty: 4, price: 88 }]);
  eq(F.keepPools([{ min_qty: 4, price: 88, until: 'NONE' }, { min_qty: 2, price: 9 }], [{ min_qty: 4, price: 90, until: E }, { min_qty: 2, price: 9, pool: 'x' }]),
     [{ min_qty: 2, price: 9, pool: 'x' }, { min_qty: 4, price: 88 }], 'pool still kept');
  eq(F.cleanTiers([{ min_qty: 4, price: 88, until: 'none' }]), [{ min_qty: 4, price: 88 }], 'none is not a malformed end');
});
t('save_product keeps an end on the override layer AND on custom_products (strict read)', () => {
  const sp = SRC.slice(SRC.indexOf('if(!inCustom && baseRec){'), SRC.indexOf('return json(200,{ok:true});', SRC.indexOf('if(!inCustom && baseRec){')));
  if (!/const cur=patch\.tiers\|\|\(baseRec&&baseRec\.tiers\); let t=cleanTiers\(p\.tiers\);\s*if\(t&&\(cleanTiers\(cur\)\|\|\[\]\)\.some\(x=>x\.until\)\) t=keepPools\(p\.tiers,cur\);/.test(sp)) throw new Error('override branch');
  if (!/custom_products\?manufacturer=eq\.\$\{encodeURIComponent\(mfr\)\}&code=eq\.\$\{encodeURIComponent\(String\(p\.code\)\.trim\(\)\)\}&select=tiers/.test(sp)) throw new Error('custom row not read');
  if (!/tiers:pv\("tiers"\)!==undefined\?pv\("tiers"\):cpTiers/.test(sp)) throw new Error('custom write');
});
t('every comparison of ladders sees the end: MC staging, mc_verify, parity, import review', () => {
  const MC = fs.readFileSync(path.join(ROOT, '_mc.js'), 'utf8');
  if (!/x\.until \? \[x\.min_qty, x\.price, x\.pool \|\| null, x\.until\]/.test(MC)) throw new Error('planStage');
  if (!/\+ \(x\.u \? "~" \+ x\.u : ""\)/.test(MC)) throw new Error('ladderKey');
  if (!/\(x\.pool\?"@"\+x\.pool:""\)\+\(x\.until\?"~"\+x\.until:""\)\)\.join\(","\):""; \};/.test(SRC)) throw new Error('parityCompare');
  const CI = fs.readFileSync(path.join(ROOT, '_catalog_import.js'), 'utf8');
  if (!/x\.until \? " until " \+ x\.until : ""/.test(CI)) throw new Error('import review');
});
t('until:"none" reaches keepPools AND the record in save_override and the price-list import (raw ladder)', () => {
  const so = SRC.slice(SRC.indexOf('if(b.action==="save_override"){'), SRC.indexOf('const wantStatus=', SRC.indexOf('if(b.action==="save_override"){')));
  if (!/some\(x=>x\.until\)\) nt=keepPools\(p\.tiers,cur\);/.test(so)) throw new Error('save_override cleans before keepPools');
  if (!/if\("tiers" in want && hasNoEnd\(p\.tiers\)\) want\.tiers=p\.tiers;/.test(so)) throw new Error('save_override record');
  if (!/pf=Object\.assign\(\{\},pf,\{tiers:keepPools\(r\.tiers,cur\)\}\)/.test(SRC)) throw new Error('import cleans before keepPools');
  if (!/if\("tiers" in want && hasNoEnd\(r\.tiers\)\) want\.tiers=r\.tiers;/.test(SRC)) throw new Error('import record');
  // and the behaviour those lines rely on: the raw ladder clears the end; the cleaned one would not
  const cur = [{ min_qty: 4, price: 90, until: E }], raw = [{ min_qty: 4, price: 85, until: 'none' }];
  eq(F.keepPools(raw, cur), [{ min_qty: 4, price: 85 }]);
  eq(F.keepPools(F.cleanTiers(raw), cur), [{ min_qty: 4, price: 85, until: E }], 'why the raw ladder is needed');
  eq([F.hasNoEnd(raw), F.hasNoEnd(F.cleanTiers(raw)), F.hasNoEnd(null)], [true, false, false]);
});
console.log(`\ntier until (admin): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
