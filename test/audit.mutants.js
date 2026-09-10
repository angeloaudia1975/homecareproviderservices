/* Mutation harness for the record consistency audit.
   Two failure modes matter here and they pull opposite ways: an audit that
   misses a real defect is useless, and an audit that cries wolf on nine Bemis
   SKUs gets switched off. Mutants cover both. CONTROL must survive. */
const fs = require('fs');
const { SRC } = require('./lift');
const suite = require('./audit.test');

const src = fs.readFileSync(SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '  const findings = [];',
    to:   '  const findings = []; /* control mutant */',
    expect: 'survive' },

  // --- missing a real defect
  { name: 'stop checking the quantity-1 rung',
    from: '      if(Math.abs(t.price - base) >= 0.005)',
    to:   '      if(false)' },

  { name: 'stop checking for a tier above base price',
    from: '      if(t.price > base + 0.005)',
    to:   '      if(false)' },

  { name: 'stop checking that a ladder descends',
    from: '      if(rungs[i].price > rungs[i-1].price + 0.005)',
    to:   '      if(false)' },

  { name: 'stop checking MAP against the dealer price',
    from: '    if(map != null && perUnit != null && map < perUnit - 0.005)',
    to:   '    if(false)' },

  { name: 'stop checking MSRP against MAP',
    from: '    if(msrp != null && map != null && msrp < map - 0.005)',
    to:   '    if(false)' },

  { name: 'stop checking a derived MSRP against its price',
    from: '      if(Math.abs(msrp - want) >= 0.005)',
    to:   '      if(false)' },

  { name: 'stop noticing an active SKU with no price',
    from: '      add(code, "no_dealer_price", "active with no dealer price — the card reads Call for pricing");',
    to:   '      ;' },

  { name: 'audit tombstones as if they were live',
    from: '    if(status !== "active"){',
    to:   '    if(false){' },

  // --- crying wolf
  { name: 'ignore the pack size, so every case-priced SKU looks broken',
    from: '    const perUnit = base == null ? null : base / pack;',
    to:   '    const perUnit = base;' },

  /* DELIBERATELY NOT A MUTANT: relaxing the pack test from p > 1 to p > 0.
     It survives because it cannot change an answer. Any case_qty at or below 1
     rounds to a pack of 1 under either test, and anything above 1 passes both.
     The guard reads as intent — "a pack of one is not a pack" — rather than as
     behaviour the tests can pin, and pretending otherwise would overstate what
     this harness proves. */

  { name: 'call a quoted MSRP stale too',
    from: '    if(r.msrp_auto === true && msrp != null && perUnit != null && perUnit > 0){',
    to:   '    if(msrp != null && perUnit != null && perUnit > 0){' },

  { name: 'flag a half-cent rounding as a conflict',
    from: '      if(Math.abs(t.price - base) >= 0.005)\n        add(code, "qty1_rung_conflicts"',
    to:   '      if(Math.abs(t.price - base) > 0)\n        add(code, "qty1_rung_conflicts"' },

  { name: 'read a pack of one out of the unit of measure',
    from: '  return (isFinite(n) && n > 1) ? n : null;',
    to:   '  return (isFinite(n) && n > 0) ? n : null;' },
];

let bad = 0;
console.log('mutant                                                    anchors  result');
console.log('-'.repeat(78));

for(const m of MUTANTS){
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(56) + String(hits).padStart(6) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
    bad++; continue;
  }
  const mutated = src.replace(m.from, m.to);
  let r;
  try { r = suite.run(mutated); }
  catch(e){ r = { pass: 0, fail: -1, report: 'threw: ' + e.message }; }

  const survived = r.fail === 0;
  const wantSurvive = m.expect === 'survive';
  const ok = survived === wantSurvive;
  if(!ok) bad++;

  const verdict = survived
    ? (wantSurvive ? 'survived (correct — no-op)' : 'SURVIVED — untested behaviour')
    : (wantSurvive ? 'KILLED — harness is broken' : 'killed by ' + r.fail + ' test(s)');
  console.log(m.name.padEnd(56) + String(hits).padStart(6) + '   ' + verdict);
}

console.log('-'.repeat(78));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
