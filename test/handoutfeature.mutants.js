/* Mutation harness for the handout's featured-line decision.

   The dangerous direction here is a pin that gets FORCED. A rep pins a line, the
   line turns out not to be sellable to that dealer — not approved, or marked a poor
   fit — and the sheet features it anyway. That prints, gets handed across a counter,
   and nobody finds out until the order is refused. The opposite failure, a pin that
   quietly does nothing, is merely annoying. Mutants cover both, weighted that way.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must SURVIVE;
   if it dies the harness is failing everything and no other result means anything. */
const fs = require('fs');
const suite = require('./handoutfeature.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '  const pin = String(pinSlug||"").trim();',
    to:   '  const pin = String(pinSlug||"").trim(); /* control mutant */',
    expect: 'survive' },

  // --- forcing a pin that must not be honoured
  { name: 'feature a pinned line the dealer is not approved for',
    from: '  return auto || null;   // a pin we cannot honour is dropped, not forced',
    to:   '  return { kind:"new_line", slug:pin, name:pin, pinned:true };' },

  { name: 'let a pin outrank the eligibility lists entirely',
    from: '  const inOpps = (opps||[]).find(o => o && key(o.slug) === k);',
    to:   '  const inOpps = { slug:pin, name:pin };' },

  { name: 'call a carried line a new-line opportunity',
    from: '  if(inCarried) return { kind:"reorder", slug:inCarried.slug, name:inCarried.name, pinned:true };',
    to:   '  if(inCarried) return { kind:"new_line", slug:inCarried.slug, name:inCarried.name, pinned:true };' },

  // --- a pin that quietly does nothing
  { name: 'ignore the pin and always take the automatic pick',
    from: '  if(!pin) return auto || null;',
    to:   '  return auto || null; if(!pin) return auto || null;' },

  { name: 'never honour a pin on an opportunity line',
    from: '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:inOpps.name, pinned:true };',
    to:   '  ;' },

  { name: 'never honour a pin on a line they already carry',
    from: '  const inCarried = (carried||[]).find(l => l && key(l.slug) === k);',
    to:   '  const inCarried = null;' },

  { name: 'drop the pin when a slug has drifted to a new spelling',
    from: '  const key = s => String(norm ? norm(s) : String(s||"").toLowerCase().trim());',
    to:   '  const key = s => String(s||"");' },

  { name: 'stop trimming, so a padded slug never matches',
    from: '  const pin = String(pinSlug||"").trim();',
    to:   '  const pin = String(pinSlug||"");' },

  // --- the shape the caller depends on
  { name: 'stop marking the pick as pinned, so the card cannot say so',
    from: '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:inOpps.name, pinned:true };',
    to:   '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:inOpps.name };' },

  { name: 'return the pinned string as the display name',
    from: '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:inOpps.name, pinned:true };',
    to:   '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:pin, pinned:true };' },

  { name: 'invent a dealer-facing reason the sheet would print',
    from: '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:inOpps.name, pinned:true };',
    to:   '  if(inOpps) return { kind:"new_line", slug:inOpps.slug, name:inOpps.name, pinned:true, reason:"Chosen by your rep." };' },

  { name: 'treat a blank pin as a real one',
    from: '  if(!pin) return auto || null;',
    to:   '  if(false) return auto || null;' },
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
