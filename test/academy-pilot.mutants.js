/* Mutation check for the PILOT GATE: each mutant removes or weakens one gate; test/academy-pilot.pg.test.js must fail
   on every one (and pass on the clean code first). Files are restored after each run. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const R = f => path.join(__dirname, '..', 'netlify', 'functions', f);
const AC = R('_academy.js'), LRN = R('_academy_learner.js'), HAND = R('academy-handoff.js'), ADM = R('academy-admin-api.js');
const M = [
  { f: AC, from: "async function pilotMode() { return !(await switchOn('academy_open')); }", to: "async function pilotMode() { return false; }", why: 'pilot mode never on' },
  { f: AC, from: "  if (!(await pilotMode())) return mem;\n", to: "  return mem;\n", why: 'sessions not filtered to TEST dealerships' },
  { f: AC, from: "&is_test=eq.true&select=id`", to: "&select=id`", why: 'every dealership counted as TEST' },
  { f: AC, from: "  if ((await testDealerIds(inv.map(i => i.dealer_id))).size) return true;", to: "  if (inv.length) return true;", why: 'any invitation counts, not only a TEST one' },
  { f: AC, from: "  if (!(await testDealerIds([dealerId])).has(String(dealerId))) refuse(", to: "  if (false) refuse(", why: 'pilotDealer never refuses' },
  { f: LRN, from: "  if (real && !(await A.pilotEmailAllowed(addr))) {", to: "  if (false) {", why: 'real-dealership learners still get a code' },
  { f: LRN, from: "  if (!(await A.pilotEmailAllowed(addr))) return A.respond(event, 403", to: "  if (false) return A.respond(event, 403", why: 'an earlier code still opens a session' },
  { f: ADM, from: "  await A.pilotDealer(A.uuid(b.dealer_id, 'dealership'));   // pilot gate", to: "  // removed", why: 'HCPS invites at a real dealership' },
  { f: ADM, from: "WRITE.restore_membership = async (staff, b) => (await A.pilotDealer(A.uuid(b.dealer_id, 'dealership')), {", to: "WRITE.restore_membership = async (staff, b) => ({", why: 'restore at a real dealership' },
  { f: ADM, from: "    await A.pilotDealer(mm.dealer_id);", to: "    void mm;", why: 'Training Manager appointed at a real dealership' },
  { f: ADM, from: "    if (!(await A.testDealerIds(ms.map(m => m.dealer_id))).size) A.refuse(403, 'pilot_only'", to: "    if (false) A.refuse(403, 'pilot_only'", why: 'enrollment of a real-dealership learner' },
  { f: HAND, from: "  if (await A.pilotMode() && !(await testLogin(event, u)))", to: "  if (false)", why: 'real dealership gets a Training link' },
  { f: HAND, from: "    if (on && await A.pilotMode()) return A.respond(event, 200, { enabled: await testLogin(event) }, OPTS);", to: "", why: 'Training button shown to every dealership' },
  { f: LRN, from: " inScope(scope, dealer);\n  await A.pilotDealer(dealer);\n  const name", to: " inScope(scope, dealer);\n  const name", why: 'TM invite not gated (scope only)' },
];
const runTest = () => spawnSync(process.execPath, [path.join(__dirname, 'academy-pilot.pg.test.js')], { encoding: 'utf8', env: process.env, timeout: 600000 });
const control = runTest();
if (control.status !== 0) { console.log('CONTROL FAILED — mutation results would be meaningless\n' + control.stdout.slice(-800)); process.exit(1); }
let killed = 0, survived = [];
for (const m of M) {
  const orig = fs.readFileSync(m.f, 'utf8');
  if (!orig.includes(m.from)) { console.log('  MISSING ' + m.why); survived.push(m.why + ' (pattern missing)'); continue; }
  fs.writeFileSync(m.f, orig.replace(m.from, m.to));
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  try { const r = runTest(); if (r.status !== 0) { killed++; console.log('  killed   ' + m.why); } else { survived.push(m.why); console.log('  SURVIVED ' + m.why); } }
  finally { fs.writeFileSync(m.f, orig); }
}
console.log(`\nacademy-pilot mutants: ${killed}/${M.length} killed${survived.length ? ' — survivors: ' + survived.join('; ') : ''}`);
process.exit(survived.length ? 1 : 0);
