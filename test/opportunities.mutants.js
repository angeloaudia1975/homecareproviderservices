/* Mutation harness for the growth-opportunity rule.

   Both directions land on a printed sheet in a dealer's hands. Offering a line
   they already have an account with is the bug this fixes — it reads as a rep who
   does not know the account. Dropping a line they genuinely could add is quieter
   and costs an order that was never asked for.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must
   SURVIVE; if it dies the harness is failing everything. */
const fs = require('fs');
const suite = require('./opportunities.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '  const bought = new Set();',
    to:   '  const bought = new Set(); /* control mutant */',
    expect: 'survive' },

  // --- offering what is already theirs
  { name: 'stop counting an account number as carrying the line',
    from: '  (accountSlugs || []).forEach(s => bought.add(key(s)));',
    to:   '  ;' },

  { name: 'stop counting purchase history as carrying the line',
    from: '  (buySet ? [...buySet] : []).forEach(s => bought.add(key(s)));',
    to:   '  ;' },

  { name: 'offer everything they are approved for',
    from: '    return !!k && !bought.has(k) && !(isExcluded && isExcluded(x));',
    to:   '    return true;' },

  { name: 'ignore the rep\'s exclusions',
    from: '    return !!k && !bought.has(k) && !(isExcluded && isExcluded(x));',
    to:   '    return !!k && !bought.has(k);' },

  { name: 'stop folding retired slugs, so a renamed line looks unsold',
    from: '  const key = s => String(norm ? norm(s) : String(s||"").toLowerCase().trim());\n  const bought = new Set();',
    to:   '  const key = s => String(s);\n  const bought = new Set();' },

  // --- withholding a real opportunity
  { name: 'subtract the accounts from the wrong side, dropping real opportunities',
    from: '    return !!k && !bought.has(k) && !(isExcluded && isExcluded(x));',
    to:   '    return !!k && bought.has(k) && !(isExcluded && isExcluded(x));' },

  /* DELIBERATELY NOT A MUTANT: appending accountSlugs to eligible before the
     filter. It survives, and for a reason rather than a gap — every slug in
     accountSlugs was just added to `bought`, so each appended entry is removed by
     the very next test. The guarantee lives in one place, which is why it cannot
     be broken from here. Listing it as killable would overstate this harness. */

  { name: 'return nothing at all',
    from: '    return !!k && !bought.has(k) && !(isExcluded && isExcluded(x));',
    to:   '    return false;' },

  // --- shape the caller depends on
  { name: 'return the normalised slug instead of the one the caller indexes by',
    from: '  return (eligible || []).filter(x => {',
    to:   '  return (eligible || []).map(key).filter(x => {' },

  { name: 'sort the list, so the handout order drifts from the approved order',
    from: '  return (eligible || []).filter(x => {',
    to:   '  return (eligible || []).slice().sort((a,b)=>String(b).localeCompare(String(a))).filter(x => {' },

  { name: 'keep blank and whitespace-only slugs, so an empty tile renders on the sheet',
    from: '    return !!k && !bought.has(k) && !(isExcluded && isExcluded(x));',
    to:   '    return !bought.has(k) && !(isExcluded && isExcluded(x));' },
];

let bad = 0;
console.log('mutant                                                          anchors  result');
console.log('-'.repeat(84));

for(const m of MUTANTS){
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(62) + String(hits).padStart(6) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
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
  console.log(m.name.padEnd(62) + String(hits).padStart(6) + '   ' + verdict);
}

console.log('-'.repeat(84));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
