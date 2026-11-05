'use strict';
/* Yuwell access (C3-05 + review 2026-11-04): the line reaches every authorized ordering dealer through ONE audited
   grant (yuwell_activation.sql) — never through the territory defaults, which would also hand it to dealers with no
   ordering line, Golden-only dealers and prospects. */
const path = require('path');
const AC = require(path.join(__dirname, '..', 'netlify', 'functions', '_access.js'));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const gov = st => ({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 });
t('a dealer with no grid never gets Yuwell from the territory defaults, in any HCPS state', () => {
  for (const st of ['IN', 'OH', 'KY', 'TN', 'GA']) if (AC.computeAccess(gov(st), [], []).available.includes('yuwell')) throw new Error(st);
});
t('a Golden-only dealer does not get Yuwell by default', () => {
  if (AC.computeAccess(gov('TN'), [], ['golden-technologies']).available.includes('yuwell')) throw new Error('golden-only');
});
t('a dealer with a grid sees Yuwell only when the grant row exists', () => {
  if (AC.computeAccess(gov('KY'), [], ['pedifix']).available.includes('yuwell')) throw new Error('leaked into a grid');
  if (!AC.computeAccess(gov('KY'), [], ['pedifix', 'yuwell']).available.includes('yuwell')) throw new Error('granted row ignored');
});
t('Yuwell is never confused with the retired Ohio Medical line', () => {
  const a = AC.computeAccess(gov('TN'), [], ['ohio-medical']); if (a.available.length || a.your_accounts.length) throw new Error(JSON.stringify(a));
});
console.log(`\nyuwell access: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
