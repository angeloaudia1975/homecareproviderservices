/* Mutation harness. Each mutant is a single anchored edit to the real source.
   Every anchor must occur EXACTLY ONCE, or the mutant is reported as broken
   rather than silently doing nothing. A mutant that SURVIVES means the suite
   does not actually test that behaviour.

   CONTROL is a genuine no-op. It must SURVIVE. If it dies, the harness is
   failing everything for some unrelated reason and none of the other results
   mean anything. */
const fs = require('fs');
const { SRC } = require('./lift');
const suite = require('./msrp.test');

const src = fs.readFileSync(SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: 'const conflictsBeforeMsrp = conflicts.length;',
    to:   'const conflictsBeforeMsrp = conflicts.length; /* control mutant */',
    expect: 'survive' },

  { name: 'multiplier 2 -> 3',
    from: 'const MSRP_MULTIPLIER = 2;',
    to:   'const MSRP_MULTIPLIER = 3;' },

  { name: 'derive even when the layers dispute the MSRP',
    from: 'const derivable = derivedNow != null && !msrpDisputed',
    to:   'const derivable = derivedNow != null && true' },

  { name: 'allow a zero base price to derive',
    from: '(basePrice != null && basePrice > 0)',
    to:   '(basePrice != null && basePrice >= 0)' },

  { name: 'drop the rounding (isolated by the 1.5 multiplier test)',
    from: 'derivable ? derivedNow : statedMsrp',
    to:   'derivable ? (basePrice * MSRP_MULTIPLIER) : statedMsrp' },

  { name: 'forget a flag another layer already recorded',
    from: 'msrp_auto:    derivable ? true : flaggedAuto,',
    to:   'msrp_auto:    derivable,' },

  { name: 'let msrp_auto:false count as a vote',
    from: "gather(\"msrp_auto\", v => (v === true ? true : null)).length > 0",
    to:   "gather(\"msrp_auto\", v => (v === true)).length > 0" },

  { name: 'refresh an MSRP nobody flagged as generated',
    from: 'const staleAuto = flaggedAuto && statedMsrp != null && derivedNow != null',
    to:   'const staleAuto = statedMsrp != null && derivedNow != null' },

  { name: 'never refresh a stale generated MSRP',
    from: '&& (statedMsrp == null || staleAuto);',
    to:   '&& (statedMsrp == null);' },

  { name: 'a threshold too coarse to notice a stale MSRP',
    from: '&& Math.abs(statedMsrp - derivedNow) >= 0.005;',
    to:   '&& Math.abs(statedMsrp - derivedNow) >= 100;' },

  { name: 'derive from the stated MSRP instead of the base price',
    from: 'Math.round(basePrice * MSRP_MULTIPLIER * 100) / 100',
    to:   'Math.round(basePrice * MSRP_MULTIPLIER * 100) / 1000' },
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
