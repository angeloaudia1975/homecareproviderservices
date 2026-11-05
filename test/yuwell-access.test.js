'use strict';
/* Yuwell access (owner 2026-11-04 22:30 CT): a new manufacturer EVERY dealer may review and shop, no account needed.
   It is "available" (open a new account) until HCPS records the dealer's Yuwell account number; it is never
   confused with the retired Ohio Medical line. */
const path = require('path');
const AC = require(path.join(__dirname, '..', 'netlify', 'functions', '_access.js'));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const gov = st => ({ state: st, business_name: 'Synthetic Medical', golden_status: '', ovation_access: false, lat: 38 });
t('a dealer with no grid sees Yuwell as available in every HCPS state', () => {
  for (const st of ['IN', 'OH', 'KY', 'TN', 'GA']) { const a = AC.computeAccess(gov(st), [], []);
    if (!a.available.includes('yuwell') || a.your_accounts.includes('yuwell')) throw new Error(st); }
});
t('a Golden-only dealer sees Yuwell (Golden is not a grid)', () => {
  if (!AC.computeAccess(gov('TN'), [], ['golden-technologies']).available.includes('yuwell')) throw new Error('golden-only');
});
t('a dealer with a grid sees Yuwell once the grant row exists, as an account only once a number is recorded', () => {
  if (AC.computeAccess(gov('KY'), [], ['pedifix']).available.includes('yuwell')) throw new Error('grid not respected');
  const a = AC.computeAccess(gov('KY'), [], ['pedifix', 'yuwell']);
  if (!a.available.includes('yuwell') || a.your_accounts.includes('yuwell')) throw new Error('before the application');
  if (!AC.computeAccess(gov('KY'), ['yuwell'], ['pedifix', 'yuwell']).your_accounts.includes('yuwell')) throw new Error('after the application');
});
t('a former Ohio Medical-only dealer sees Yuwell once granted, and never Ohio Medical', () => {
  const a = AC.computeAccess(gov('TN'), [], ['ohio-medical', 'yuwell']);
  if (JSON.stringify(a.available) !== '["yuwell"]' || a.your_accounts.length) throw new Error(JSON.stringify(a));
  const b = AC.computeAccess(gov('TN'), [], ['ohio-medical']); if (b.available.length || b.your_accounts.length) throw new Error(JSON.stringify(b));
});
console.log(`\nyuwell access: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
