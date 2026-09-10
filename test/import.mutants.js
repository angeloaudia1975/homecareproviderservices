/* Mutation harness for the price-list import diff.
   The mutants that matter are the ones that would let a wrong price through
   silently, or let the importer decide something it must not decide.
   CONTROL must survive. */
const fs = require('fs');
const { SRC } = require('./lift');
const suite = require('./import.test');

const src = fs.readFileSync(SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '  const seen = new Set();',
    to:   '  const seen = new Set(); /* control mutant */',
    expect: 'survive' },

  { name: 'let a silent list blank a field',
    from: '      if(want == null) return;              // the list is silent — leave the record alone',
    to:   '      if(false) return;' },

  { name: 'derive the MSRP from the OLD price, not the new one',
    from: '                   : (listBase != null && listBase > 0 ? Math.round(listBase * mult * 100) / 100 : null);',
    to:   '                   : (rec2 != null ? null : null);' },

  { name: 'ignore a quoted MSRP and always derive',
    from: '    const wantMsrp = listMsrp != null ? listMsrp',
    to:   '    const wantMsrp = false ? listMsrp' },

  { name: 'stop tracking whether an MSRP is ours',
    from: '    if(wantMsrp != null && (rec.msrp_auto === true) !== wantMsrpAuto)',
    to:   '    if(false)' },

  { name: 'treat a code absent from the list as a change',
    from: '  const absent = (records || [])',
    to:   '  const absent = [] || (records || [])' },

  { name: 'create new SKUs instead of reporting them',
    from: '    if(!rec){\n      added.push(',
    to:   '    if(!rec){\n      changed.push(' },

  { name: 'compare codes raw instead of normalised',
    from: '  const key = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");\n  const money = v => { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; };',
    to:   '  const key = c => String(c == null ? "" : c);\n  const money = v => { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; };' },

  { name: 'apply the last mention of a duplicated code, not the first',
    from: '    if(seen.has(k)) return;                 // a list that names a code twice gets read once',
    to:   '    if(false) return;' },

  { name: 'let a blank code become a product',
    from: "    if(!code) return;\n    const k = key(code);",
    to:   "    if(false) return;\n    const k = key(code);" },

  { name: 'call a half-cent difference a price change',
    from: '                       : Math.abs(Number(a) - Number(b)) < 0.005;\n  const ladder =',
    to:   '                       : Math.abs(Number(a) - Number(b)) < 0;\n  const ladder =' },

  /* DELIBERATELY NOT A MUTANT: swapping `ladder` for JSON.stringify.
     It survives, and it survives for a good reason rather than a gap in the
     tests. cleanTiers already sorts rungs by quantity and normalises them to
     {min_qty, price}, and BOTH sides of the ladder comparison go through it —
     so by the time `ladder` runs, two equal ladders are already identical
     objects in identical order and any faithful stringifier gives the same
     answer. The invariant lives in one place, which is why it cannot be broken
     from here. Listing an equivalent mutant as if it were killable would make
     this harness look stronger than it is. */
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
