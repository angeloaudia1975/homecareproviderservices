/* Every upsert must name an index that exists — behaviour suite.
   Reads the real catalog-api.js and the real product_skus migration and compares them.

   The bug: the record mirror upserted with on_conflict=(manufacturer,code), and product_skus has
   no unique constraint on those columns. Postgres refuses the statement outright —

     42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification

   — so the mirror could never run, and Bemis could not be given authority over its own prices.
   Nothing about the JavaScript was wrong; it named a constraint that was never created.

   Checked empirically against this table's DDL on Postgres 16 before the fix was written:
     ON CONFLICT (manufacturer, code)       -> 42P10, nothing written
     ON CONFLICT (manufacturer, code_norm)  -> inserts, and updates on a second run
     a payload naming code_norm             -> 428C9, a generated column cannot be written
     two spellings of one code in ONE batch -> 21000, and the WHOLE batch is discarded
   The last one is why the index, not the raw code, has to be the conflict target: twin
   spellings are one row, and a batch that names that row twice loses every row in it.

   A unit test cannot reach the database, so this pins the pairing that the database enforces:
   the columns the code conflicts on must be the columns the migration made unique. */
const fs = require('fs');
const path = require('path');

const API = process.env.CATALOG_API
  || path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');
const SQL = process.env.SKUS_SQL
  || path.join(__dirname, '..', 'migrate-phase2-product-skus.sql');

/* Every "<table>?on_conflict=<cols>" the code asks PostgREST for. */
function upsertTargets(src){
  const out = [];
  const re = /([a-z_][a-z0-9_]*)\?on_conflict=([a-z0-9_,]+)/gi;
  let m;
  while((m = re.exec(src))) out.push({ table: m[1], cols: m[2].split(',').map(s => s.trim()).filter(Boolean) });
  return out;
}

/* Every unique index the migration declares, as {table, cols}. */
function uniqueIndexes(sql){
  const out = [];
  const re = /create\s+unique\s+index(?:\s+if\s+not\s+exists)?\s+\S+\s+on\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)/gi;
  let m;
  while((m = re.exec(sql)))
    out.push({ table: m[1], cols: m[2].split(',').map(s => s.trim().toLowerCase()).filter(Boolean) });
  return out;
}

const sameSet = (a, b) => a.length === b.length
  && a.map(String).sort().join(',') === b.map(String).sort().join(',');

let pass = 0, fail = 0;
const out = [];
function t(name, fn){
  try { fn(); pass++; out.push('  ok   ' + name); }
  catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); }
}
function ok(v, msg){ if(!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, what){
  if(JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}

function run(apiSrc, sqlSrc){
  const api = apiSrc !== undefined ? apiSrc : fs.readFileSync(API, 'utf8');
  const sql = sqlSrc !== undefined ? sqlSrc : fs.readFileSync(SQL, 'utf8');
  pass = 0; fail = 0; out.length = 0;

  const targets = upsertTargets(api);
  const indexes = uniqueIndexes(sql);
  const skuIx = indexes.filter(i => i.table === 'product_skus');
  const skuTargets = targets.filter(t2 => t2.table === 'product_skus');

  t('the migration is readable and declares the master record\'s unique index', () => {
    ok(skuIx.length >= 1, 'no unique index on product_skus found in ' + path.basename(SQL)
      + ' — either the migration moved or the index is gone, and every upsert below is unverifiable');
  });

  t('THE ONE THAT BROKE BEMIS — every product_skus upsert names a real unique index', () => {
    ok(skuTargets.length >= 1, 'no product_skus upsert found in catalog-api.js — has the mirror stopped writing?');
    for(const t2 of skuTargets){
      const hit = skuIx.some(i => sameSet(i.cols, t2.cols));
      ok(hit, 'on_conflict=' + t2.cols.join(',') + ' matches no unique index on product_skus. '
            + 'Declared: ' + skuIx.map(i => '(' + i.cols.join(',') + ')').join(' ')
            + '. Postgres answers this with 42P10 and writes nothing.');
    }
  });

  t('the master record is keyed on the NORMALISED code, not the raw one', () => {
    /* If this ever changes, the duplicate class the whole migration exists to end is back:
       MP-P08-KIT and mp-p08-kit would be two rows with two prices. */
    ok(skuIx.some(i => sameSet(i.cols, ['manufacturer', 'code_norm'])),
      'the (manufacturer, code_norm) unique index is gone');
  });

  t('nothing conflicts on the raw code, which is not unique and never was', () => {
    for(const t2 of skuTargets)
      ok(!sameSet(t2.cols, ['manufacturer', 'code']),
        'on_conflict=manufacturer,code is back — this is the exact 42P10 that refused Bemis');
  });

  t('a conflict target is never a partial key', () => {
    /* on_conflict=code_norm alone matches no index either, and would be a far worse bug if it
       ever did: one part number could only exist once across twelve manufacturers. */
    for(const t2 of skuTargets)
      ok(t2.cols.length >= 2 && t2.cols.indexOf('manufacturer') >= 0,
        'on_conflict=' + t2.cols.join(',') + ' leaves the manufacturer out of the key');
  });

  t('the code never writes the generated column', () => {
    /* code_norm is `generated always as (...) stored`. Postgres refuses any payload naming it
       (428C9), so one stray key in one row would fail that whole batch. */
    ok(!/\bcode_norm\s*:/.test(api),
      'catalog-api builds a row with a code_norm key — a generated column cannot be written');
  });

  t('every OTHER upsert in the file still names something plausible', () => {
    /* Not a schema check — those tables live in other migrations — but a blank or malformed
       target is always a bug, and this is the file where one would land unnoticed. */
    for(const t2 of targets){
      ok(t2.cols.length >= 1, 'empty on_conflict for ' + t2.table);
      for(const c of t2.cols) ok(/^[a-z0-9_]+$/i.test(c), 'odd column ' + JSON.stringify(c) + ' for ' + t2.table);
    }
  });

  t('the parsers actually parse — they are the whole test', () => {
    // A silently-empty parser would make every assertion above vacuously true.
    eq(upsertTargets('sb("POST","t?on_conflict=a,b",x)'), [{ table:'t', cols:['a','b'] }], 'target parser');
    eq(uniqueIndexes('create unique index if not exists q_uk\n  on public.q (m, c_norm);'),
       [{ table:'q', cols:['m','c_norm'] }], 'index parser');
    ok(targets.length >= 2, 'found only ' + targets.length + ' upserts in catalog-api.js');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, upsertTargets, uniqueIndexes, API, SQL };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
