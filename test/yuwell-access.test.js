'use strict';
/* Yuwell territory (owner 2026-11-04): the line is carried in every HCPS territory, so the territory rules offer it
   to every dealer without an access grid — exactly like Access4U, AIRAVANT and Corsicana. A dealer WITH a grid
   sees it only when an active dealer_manufacturers row grants it (yuwell_activation.sql). */
const path = require('path');
const AC = require(path.join(__dirname, '..', 'netlify', 'functions', '_access.js'));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const gov = st => ({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 });
t('every territory state offers Yuwell to a dealer with no grid', () => {
  for (const st of ['IN', 'OH', 'KY', 'TN', 'GA']) if (!AC.computeAccess(gov(st), [], []).available.includes('yuwell')) throw new Error(st);
});
t('a dealer with a grid that does not include Yuwell does not see it; one that does, does', () => {
  if (AC.computeAccess(gov('KY'), [], ['pedifix']).available.includes('yuwell')) throw new Error('leaked into a grid');
  if (!AC.computeAccess(gov('KY'), [], ['pedifix', 'yuwell']).available.includes('yuwell')) throw new Error('granted row ignored');
});
t('Yuwell is never confused with the retired Ohio Medical line', () => {
  const a = AC.computeAccess(gov('TN'), [], ['ohio-medical']); if (a.available.length || a.your_accounts.length) throw new Error(JSON.stringify(a));
});
console.log(`\nyuwell access: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
