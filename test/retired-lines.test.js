'use strict';
/* Retired manufacturer lines (owner 2026-10-23 Complete Medical; 2026-11-04 Ohio Medical / GCE, replaced by Yuwell).
   Admin-site side: the order server never prices a retired line under either identifier; dealer access never
   offers it ("your accounts" or "available"); the dealer grid and the territory picker leave it out. The database
   rows (dealer_manufacturers, account numbers, sales, commissions) are not touched by any of this. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'netlify', 'functions', '_retired_lines.js'));
const AC = require(path.join(ROOT, 'netlify', 'functions', '_access.js'));
let pass = 0, fail = 0; const t = async (n, f) => { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const WANT = ['complete-medical-supplies', 'gce', 'ohio-medical'];

(async () => {
await t('one frozen list, Ohio Medical under both identifiers', () => {
  if (JSON.stringify(Object.keys(R.RETIRED_LINES).sort()) !== JSON.stringify(WANT)) throw new Error(Object.keys(R.RETIRED_LINES).join());
  if (!Object.isFrozen(R.RETIRED_LINES)) throw new Error('not frozen');
  for (const s of ['yuwell', 'pedifix', 'access4u']) if (R.isRetiredLine(s)) throw new Error('live line retired: ' + s);
});
await t('dealer access: no state rule offers Ohio Medical, and account rows under either slug are dropped', () => {
  if (Object.keys(AC.STATE_RULES).some(R.isRetiredLine)) throw new Error('a state rule still offers a retired line');
  const src = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', '_access.js'), 'utf8');
  if (!/const RETIRED = require\("\.\/_retired_lines\.js"\);/.test(src)) throw new Error('_access does not read the shared list');
  for (const st of ['TN', 'KY', 'IN', 'OH', 'GA']) {
    const a = AC.computeAccess({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 }, ['ohio-medical', 'gce', 'pedifix'], ['ohio-medical', 'gce']);
    const all = JSON.stringify(a);
    if (/ohio-medical|"gce"/.test(all)) throw new Error(st + ': ' + all);
  }
});
await t('the dealer grid and the territory picker use the same trimmed, case-insensitive test', () => {
  for (const [f, re] of [['dealers-api.js', /const RETIRED=\{has:\(slug\)=>_RL\.isRetiredLine\(slug\)\|\|/],
    ['territory-api.js', /const NOT_REPRESENTED=\{has:\(slug\)=>_RL\.isRetiredLine\(slug\)\};/]]) {
    const src = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', f), 'utf8');
    if (!re.test(src) || !/const _RL=require\("\.\/_retired_lines\.js"\);/.test(src)) throw new Error(f);
  }
});
await t('a dealer whose ONLY grant is a retired line gets nothing — never the territory line-up (review finding 1)', () => {
  for (const st of ['TN', 'KY', 'IN', 'OH', 'GA']) {
    for (const g of [['ohio-medical'], ['gce'], [' OHIO-MEDICAL '], ['complete-medical-supplies'], ['ohio-medical', 'golden-technologies']]) {
      const a = AC.computeAccess({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 }, [], g);
      if (a.your_accounts.length || a.available.length) throw new Error(st + ' ' + JSON.stringify(g) + ' -> ' + JSON.stringify(a));
    }
    // a retired grant beside a live one leaves exactly the live one
    const b = AC.computeAccess({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 }, ['pedifix'], ['ohio-medical', 'pedifix']);
    if (JSON.stringify([...b.your_accounts, ...b.available]) !== '["pedifix"]') throw new Error(st + ' mixed: ' + JSON.stringify(b));
    // no grid at all (Golden only, or nothing) still uses the territory rules
    const c = AC.computeAccess({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 }, [], ['golden-technologies']);
    if (!c.available.includes('access4u')) throw new Error(st + ' territory fallback lost: ' + JSON.stringify(c));
  }
});
await t('the order server refuses a retired line even when manufacturers.json lists it and its layers hold rows', () => {
  const src = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', '_pricing.js'), 'utf8');
  if (!/const listed = s => !RETIRED\.isRetiredLine\(s\) && /.test(src)) throw new Error('_pricing does not gate on the retired list');
});
await t('the ordering site holds the identical list (when its checkout is beside this one)', () => {
  const other = process.env.ORDERING_REPO || path.join(ROOT, '..', 'homecareproviderservicesordering');
  const f = path.join(other, 'netlify', 'functions', '_retired_lines.js');
  if (!fs.existsSync(f)) { console.log('     (ordering checkout not found — set ORDERING_REPO to compare)'); return; }
  if (JSON.stringify(require(f).RETIRED_LINES) !== JSON.stringify(R.RETIRED_LINES)) throw new Error('the two repos disagree');
});
console.log(`\nretired lines (admin): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
