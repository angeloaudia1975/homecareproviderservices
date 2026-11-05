'use strict';
/* Time-limited breaks survive every admin tier write (C3-05, 2026-11-04): Product Catalog / Price Check (save_override),
   the price-list import, the canonical record path (keepPools) and the record feed. A malformed end drops the break;
   re-sending a ladder without `until` keeps the end the break already has — a promotion can never become permanent. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'netlify', 'functions');
const SRC = fs.readFileSync(path.join(ROOT, 'catalog-api.js'), 'utf8');
const num = v => { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; };
const F = new Function('num', SRC.slice(SRC.indexOf('const cleanTiers='), SRC.indexOf('/* ─────────────────────── Duplicate detection')) + ';return {cleanTiers,keepPools};')(num);
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
  if (!/if\(\(cleanTiers\(cur\)\|\|\[\]\)\.some\(x=>x\.until\)\) nt=keepPools\(nt,cur\);/.test(so)) throw new Error('save_override does not keep the end');
  if (!/return json\(503,\{error:"the current price ladder could not be read — nothing saved"/.test(so)) throw new Error('save_override is not strict');
  if (!/if\(\(cleanTiers\(cur\)\|\|\[\]\)\.some\(x=>x\.until\)\) pf=Object\.assign\(\{\},pf,\{tiers:keepPools\(pf\.tiers,cur\)\}\);/.test(SRC)) throw new Error('import does not keep the end');
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
console.log(`\ntier until (admin): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
