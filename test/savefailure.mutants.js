/* Mutation harness for what a failed save tells you.

   The failure being guarded against is silence, not a crash. The Feature button was reported as
   "the platform will not allow me to select a featured product" when the platform had in fact
   been naming the exact missing table in every response — so every mutant here is a way of
   losing, blunting, or mislabelling a reason that was already in hand.

   Two sources are mutated: the server's mapping in routes-api.js and the page's wording in
   dealer.html. Every anchor must occur exactly once in its own file. CONTROL is a genuine no-op
   and must SURVIVE; if it dies the harness is failing everything. */
const fs = require('fs');
const suite = require('./savefailure.test');

const apiSrc  = fs.readFileSync(suite.API, 'utf8');
const pageSrc = fs.readFileSync(suite.PAGE, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing', where: 'api',
    from: '  const m = String((err && err.message) || err || "");',
    to:   '  const m = String((err && err.message) || err || ""); /* control */',
    expect: 'survive' },

  // --- the server: losing or mislabelling the reason
  { name: 'drop the missing-table case, leaving the anonymous 500 that started this', where: 'api',
    from: '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"storage_missing", table:table,',
    to:   '  if(false) return { code:503, body:{ error:"storage_missing", table:table,' },

  { name: 'report EVERY failure as a missing migration, sending the fix hunt to the wrong place', where: 'api',
    from: '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"storage_missing", table:table,',
    to:   '  if(true) return { code:503, body:{ error:"storage_missing", table:table,' },

  { name: 'match only the PGRST code, so a reworded Supabase message is missed', where: 'api',
    from: 'const MISSING_TABLE = /PGRST205|Could not find the table/i;',
    to:   'const MISSING_TABLE = /PGRST205/i;' },

  { name: 'match only the sentence, so the code alone is missed', where: 'api',
    from: 'const MISSING_TABLE = /PGRST205|Could not find the table/i;',
    to:   'const MISSING_TABLE = /Could not find the table/i;' },

  { name: 'answer the missing table with a 500, indistinguishable from a real fault', where: 'api',
    from: '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"storage_missing", table:table,',
    to:   '  if(MISSING_TABLE.test(m)) return { code:500, body:{ error:"storage_missing", table:table,' },

  { name: 'rename the error code the page keys off', where: 'api',
    from: '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"storage_missing", table:table,',
    to:   '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"missing", table:table,' },

  { name: 'stop naming which table is missing', where: 'api',
    from: '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"storage_missing", table:table,',
    to:   '  if(MISSING_TABLE.test(m)) return { code:503, body:{ error:"storage_missing", table:null,' },

  { name: 'stop naming the file to run, leaving the rep told only that something is missing', where: 'api',
    from: '    detail:"This needs a one-time database setup that hasn\'t been run yet (" + setupFile + ")." } };',
    to:   '    detail:"This needs a one-time database setup that hasn\'t been run yet." } };' },

  { name: 'throw away the real error text on a genuine fault', where: 'api',
    from: '  return { code:500, body:{ error: m || "write failed" } };',
    to:   '  return { code:500, body:{ error: "write failed" } };' },

  // --- the page: losing the reason on the last step
  { name: 'ignore the detail the API wrote, so improving the server message changes nothing', where: 'page',
    from: '  if(detail) return detail;',
    to:   '  ;' },

  { name: 'fall back to the old "Couldn\'t save." with the reason thrown away', where: 'page',
    from: '  return "Couldn\'t save — " + (m ? m.slice(0, 160) : "the server gave no reason") + ".";',
    to:   '  return "Couldn\'t save.";' },

  { name: 'drop the permission wording, so a refusal reads as a fault', where: 'page',
    from: '  if(/not your account/i.test(m)) return "You can only " + verb + " on your own accounts.";',
    to:   '  ;' },

  { name: 'hard-code the verb, so excluding reports itself as featuring', where: 'page',
    from: '  if(/not your account/i.test(m)) return "You can only " + verb + " on your own accounts.";',
    to:   '  if(/not your account/i.test(m)) return "You can only feature a line on your own accounts.";' },

  { name: 'drop the missing-table wording an older deploy depends on', where: 'page',
    from: '  if(/storage_missing|PGRST205|Could not find the table/i.test(m))',
    to:   '  if(false)' },

  { name: 'drop the expired-session wording', where: 'page',
    from: '  if(/unauthor|expired|\\b401\\b/i.test(m)) return "Your sign-in expired — reload the page and sign in again.";',
    to:   '  ;' },

  { name: 'print the server\'s whole wall of text beside the button', where: 'page',
    from: '  return "Couldn\'t save — " + (m ? m.slice(0, 160) : "the server gave no reason") + ".";',
    to:   '  return "Couldn\'t save — " + (m ? m : "the server gave no reason") + ".";' },

  { name: 'treat a whitespace-only detail as a real one, hiding the reason underneath', where: 'page',
    from: '  const detail = (r && typeof r.detail === "string") ? r.detail.trim() : "";',
    to:   '  const detail = (r && typeof r.detail === "string") ? r.detail : "";' },
];

let bad = 0;
console.log('mutant                                                              src  anchors  result');
console.log('-'.repeat(96));

for(const m of MUTANTS){
  const src = m.where === 'page' ? pageSrc : apiSrc;
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(64) + m.where.padStart(5) + String(hits).padStart(9) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
    bad++; continue;
  }
  const mutated = src.replace(m.from, m.to);
  let r;
  try {
    r = m.where === 'page' ? suite.run(apiSrc, mutated) : suite.run(mutated, pageSrc);
  } catch(e){ r = { pass: 0, fail: -1, report: 'threw: ' + e.message }; }

  const survived = r.fail === 0;
  const wantSurvive = m.expect === 'survive';
  const ok = survived === wantSurvive;
  if(!ok) bad++;

  const verdict = survived
    ? (wantSurvive ? 'survived (correct — no-op)' : 'SURVIVED — untested behaviour')
    : (wantSurvive ? 'KILLED — harness is broken' : 'killed by ' + r.fail + ' test(s)');
  console.log(m.name.padEnd(64) + m.where.padStart(5) + String(hits).padStart(9) + '   ' + verdict);
}

console.log('-'.repeat(96));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
