/* Mutation harness for the upsert/index pairing.

   The original bug was invisible to every existing test because the JavaScript was valid and the
   SQL was valid — only the PAIR was wrong. So the mutants break the pair in both directions: the
   code names the wrong columns, or the migration stops making those columns unique.

   Every anchor must occur exactly once in its own file. CONTROL is a genuine no-op and must
   SURVIVE; if it dies the harness is failing everything. */
const fs = require('fs');
const suite = require('./conflicttarget.test');

const apiSrc = fs.readFileSync(suite.API, 'utf8');
const sqlSrc = fs.readFileSync(suite.SQL, 'utf8');

const TARGET = 'product_skus?on_conflict=manufacturer,code_norm';

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing', where: 'api',
    from: '  const writeAll=async rows=>{',
    to:   '  /* control */\n  const writeAll=async rows=>{',
    expect: 'survive' },

  // --- the code names columns the database does not make unique
  { name: 'conflict on the raw code — the exact 42P10 that refused Bemis twice', where: 'api',
    from: TARGET, to: 'product_skus?on_conflict=manufacturer,code' },

  { name: 'conflict on the code alone, so one part number could exist once across all 12 lines', where: 'api',
    from: TARGET, to: 'product_skus?on_conflict=code_norm' },

  { name: 'conflict on the manufacturer alone, which would collapse a line to one SKU', where: 'api',
    from: TARGET, to: 'product_skus?on_conflict=manufacturer' },

  { name: 'add a column to the target, matching no index', where: 'api',
    from: TARGET, to: 'product_skus?on_conflict=manufacturer,code_norm,status' },

  { name: 'empty target', where: 'api',
    from: TARGET, to: 'product_skus?on_conflict=' },

  { name: 'write the generated column, which Postgres refuses for the whole batch', where: 'api',
    from: '  const payload=applied.ready.map(x=>Object.assign({},x,{updated_at:now,updated_by:by}));',
    to:   '  const payload=applied.ready.map(x=>Object.assign({},x,{updated_at:now,updated_by:by,code_norm:String(x.code||"").toUpperCase()}));' },

  // --- the migration stops backing the target
  { name: 'drop the unique index the mirror depends on', where: 'sql',
    from: 'create unique index if not exists product_skus_mfr_code_norm_uk\n  on public.product_skus (manufacturer, code_norm);',
    to:   'create index if not exists product_skus_mfr_code_norm_uk\n  on public.product_skus (manufacturer, code_norm);' },

  { name: 'make the index unique on the raw code instead of the normalised one', where: 'sql',
    from: 'create unique index if not exists product_skus_mfr_code_norm_uk\n  on public.product_skus (manufacturer, code_norm);',
    to:   'create unique index if not exists product_skus_mfr_code_norm_uk\n  on public.product_skus (manufacturer, code);' },
];

let bad = 0;
console.log('mutant                                                              src  anchors  result');
console.log('-'.repeat(96));

for(const m of MUTANTS){
  const src = m.where === 'sql' ? sqlSrc : apiSrc;
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(64) + m.where.padStart(5) + String(hits).padStart(9) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
    bad++; continue;
  }
  const mutated = src.replace(m.from, m.to);
  let r;
  try {
    r = m.where === 'sql' ? suite.run(apiSrc, mutated) : suite.run(mutated, sqlSrc);
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
