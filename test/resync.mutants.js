/* Mutation harness for layer-write detection.

   Both failure directions are silent and both are expensive. Miss a write and the
   record quietly keeps an old price while the admin shows the new one — the exact
   divergence the master record exists to end. Over-match and the mirror either
   rebuilds the wrong manufacturer from its layers, or recurses on its own output.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must
   SURVIVE; if it dies the harness is failing everything and no other result means
   anything. */
const fs = require('fs');
const suite = require('./resync.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: 'function slugOfWrite(path, body){',
    to:   'function slugOfWrite(path, body){ /* control mutant */',
    expect: 'survive' },

  // --- missing a write that should be mirrored
  { name: 'stop recognising custom_products as a layer',
    from: 'const LAYER_TABLE = /^(custom_products|product_overrides)(\\?|$)/;',
    to:   'const LAYER_TABLE = /^(product_overrides)(\\?|$)/;' },

  { name: 'stop recognising product_overrides as a layer',
    from: 'const LAYER_TABLE = /^(custom_products|product_overrides)(\\?|$)/;',
    to:   'const LAYER_TABLE = /^(custom_products)(\\?|$)/;' },

  { name: 'only match a bare table name, so every filtered write is missed',
    from: 'const LAYER_TABLE = /^(custom_products|product_overrides)(\\?|$)/;',
    to:   'const LAYER_TABLE = /^(custom_products|product_overrides)$/;' },

  { name: 'stop reading the slug off the path',
    from: '  const m = /[?&]manufacturer=eq\\.([^&]+)/.exec(path);',
    to:   '  const m = null;' },

  { name: 'stop reading the slug out of the body',
    from: '  for(const r of rows) if(r && r.manufacturer) return String(r.manufacturer);',
    to:   '  ;' },

  { name: 'ignore a batch body, so only single-row upserts are attributed',
    from: '  const rows = Array.isArray(body) ? body : (body ? [body] : []);',
    to:   '  const rows = Array.isArray(body) ? [] : (body ? [body] : []);' },

  // --- matching too much
  { name: 'match any table that merely starts with a layer name',
    from: 'const LAYER_TABLE = /^(custom_products|product_overrides)(\\?|$)/;',
    to:   'const LAYER_TABLE = /^(custom_products|product_overrides)/;' },

  { name: 'match the manufacturer column name as if it were a value',
    from: '  const m = /[?&]manufacturer=eq\\.([^&]+)/.exec(path);',
    to:   '  const m = /manufacturer/.exec(path) && [null, "unknown"];' },

  { name: 'let the body override the filter the write actually used',
    from: '  if(m) { try { return decodeURIComponent(m[1]); } catch(e) { return m[1]; } }',
    to:   '  ;' },

  { name: 'guess a manufacturer when the write cannot be attributed',
    from: '  return null;\n}\nasync function sb(method,path,body,extra){',
    to:   '  return "bemis";\n}\nasync function sb(method,path,body,extra){' },

  // --- the loop the hook must not create
  { name: 'treat the record itself as a layer, so the mirror re-triggers itself',
    from: 'const LAYER_TABLE = /^(custom_products|product_overrides)(\\?|$)/;',
    to:   'const LAYER_TABLE = /^(custom_products|product_overrides|product_skus)(\\?|$)/;' },

  // --- decoding
  { name: 'stop decoding, so an encoded slug never matches its meta row',
    from: '  if(m) { try { return decodeURIComponent(m[1]); } catch(e) { return m[1]; } }',
    to:   '  if(m) { return m[1]; }' },

  { name: 'let a malformed escape throw instead of falling back to the raw slug',
    from: '  if(m) { try { return decodeURIComponent(m[1]); } catch(e) { return m[1]; } }',
    to:   '  if(m) { return decodeURIComponent(m[1]); }' },
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
