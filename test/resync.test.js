/* Layer-write detection — behaviour suite.
   Lifts the real LAYER_TABLE and slugOfWrite out of catalog-api.js and runs them.

   These two decide whether a price edit ever reaches the master record. Seventeen
   actions write to the layers and none of them share a helper, so this is the only
   thing standing between "the admin saved it" and "the storefront serves it". A
   miss here is silent by construction: the write succeeds, the page says saved,
   and the record keeps the old price until somebody reconciles by hand. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.CATALOG_API
  || path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');

function decl(js, name, kind){
  const anchor = kind + ' ' + name;
  const at = js.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: ' + name);
  if(js.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: ' + name);
  if(kind === 'const'){ const end = js.indexOf('\n', at); return js.slice(at, end); }
  let i = js.indexOf(')', at); i = js.indexOf('{', i);
  let d = 0;
  for(let j = i; j < js.length; j++){
    if(js[j] === '{') d++;
    else if(js[j] === '}'){ d--; if(d === 0) return js.slice(at, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

function lift(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const code = decl(js, 'LAYER_TABLE', 'const') + '\n'
             + decl(js, 'slugOfWrite', 'function')
             + '\n;module.exports={LAYER_TABLE,slugOfWrite};';
  const mod = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports;
}

let pass = 0, fail = 0;
const out = [];
function t(name, fn){
  try { fn(); pass++; out.push('  ok   ' + name); }
  catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); }
}
function eq(a, b, what){
  if(JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}
function ok(v, msg){ if(!v) throw new Error(msg || 'expected truthy'); }

function run(src){
  const { LAYER_TABLE, slugOfWrite } = lift(src);
  const isLayer = p => LAYER_TABLE.test(p);
  pass = 0; fail = 0; out.length = 0;

  /* ---- which tables count as a layer write ------------------------------- */
  t('the two legacy layer tables are recognised', () => {
    ok(isLayer('custom_products'), 'custom_products bare');
    ok(isLayer('product_overrides'), 'product_overrides bare');
    ok(isLayer('custom_products?manufacturer=eq.bemis&code=eq.7YA05313GRY'), 'filtered patch');
    ok(isLayer('product_overrides?on_conflict=manufacturer,code'), 'upsert');
  });

  t('product_skus is NOT a layer write, or the mirror would chase its own tail', () => {
    // The resync writes product_skus. If that counted, every mirror would mark the
    // line dirty again and the next request would mirror it again, for ever.
    eq(isLayer('product_skus'), false, 'bare');
    eq(isLayer('product_skus?on_conflict=manufacturer,code'), false, 'upsert');
    eq(isLayer('product_skus?manufacturer=eq.bemis&code=eq.X'), false, 'filtered delete');
  });

  t('tables that merely start with the same letters are not layer writes', () => {
    eq(isLayer('custom_products_archive'), false, 'suffixed table');
    eq(isLayer('product_overrides_log?select=*'), false, 'suffixed with a query');
    eq(isLayer('product_content?manufacturer=eq.bemis'), false, 'enrichment');
    eq(isLayer('manufacturer_meta?on_conflict=slug'), false, 'meta');
    eq(isLayer('reconcile_conflicts?manufacturer=eq.bemis'), false, 'decisions');
  });

  /* ---- finding the manufacturer ------------------------------------------ */
  t('the manufacturer is read off a filtered write', () => {
    eq(slugOfWrite('custom_products?manufacturer=eq.bemis&code=eq.7YA05313GRY', null), 'bemis', 'patch');
    eq(slugOfWrite('product_overrides?manufacturer=eq.ovation-medical', null), 'ovation-medical', 'delete');
  });

  t('the manufacturer is read out of the body when the path carries no filter', () => {
    eq(slugOfWrite('product_overrides?on_conflict=manufacturer,code',
                   { manufacturer: 'bemis', code: 'X', patch: {} }), 'bemis', 'single row');
    eq(slugOfWrite('custom_products?on_conflict=manufacturer,code',
                   [{ manufacturer: 'climbing-steps', code: 'A' },
                    { manufacturer: 'climbing-steps', code: 'B' }]), 'climbing-steps', 'batch');
  });

  t('the path wins over the body, because the path is what the write applied to', () => {
    // An upsert body can name a line the filter does not; the filter is the truth.
    eq(slugOfWrite('custom_products?manufacturer=eq.bemis&code=eq.X',
                   { manufacturer: 'pedifix' }), 'bemis', 'slug');
  });

  t('a percent-encoded slug is decoded', () => {
    eq(slugOfWrite('product_overrides?manufacturer=eq.ohio%2Dmedical', null), 'ohio-medical', 'decoded');
  });

  t('a slug that cannot be decoded is used raw rather than dropped', () => {
    // A malformed escape must not lose the write; a rebuild of the right line
    // beats no rebuild at all.
    eq(slugOfWrite('custom_products?manufacturer=eq.be%mis', null), 'be%mis', 'raw');
  });

  t('a write we cannot attribute marks nothing', () => {
    /* Deliberately null rather than a guess: an unattributable write triggering a
       blind rebuild would rebuild the WRONG manufacturer from its layers. */
    eq(slugOfWrite('custom_products?code=eq.X', null), null, 'no filter, no body');
    eq(slugOfWrite('custom_products', {}), null, 'empty body');
    eq(slugOfWrite('custom_products', []), null, 'empty batch');
    eq(slugOfWrite('custom_products', [{ code: 'X' }]), null, 'rows without a manufacturer');
    eq(slugOfWrite('custom_products', null), null, 'null body');
  });

  t('a manufacturer= that is not an eq. filter is not mistaken for one', () => {
    // on_conflict names the COLUMN manufacturer; it is not a value.
    eq(slugOfWrite('product_overrides?on_conflict=manufacturer,code', null), null, 'on_conflict alone');
    eq(slugOfWrite('custom_products?select=manufacturer,code', null), null, 'select list');
  });

  t('the first row of a batch supplies the slug', () => {
    eq(slugOfWrite('custom_products', [{ manufacturer: 'bemis' }, { manufacturer: 'bemis' }]), 'bemis', 'slug');
  });

  t('ragged rows do not throw', () => {
    eq(slugOfWrite('custom_products', [null, undefined, { manufacturer: 'bemis' }]), 'bemis', 'skips holes');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, lift, SRC };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
