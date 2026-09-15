/* "Ways we can help you grow" — behaviour suite.
   Lifts the real growthOpportunities out of netlify/functions/routes-api.js.

   This decides what a rep hands a dealer as new revenue. Offering a line the dealer
   already has an account with is the failure that prompted it: Glasgow Prescription
   Center's sheet printed their Ovation and PediFix account numbers across the top
   and then offered both lines as growth underneath. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.ROUTES_API
  || path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');

function lift(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const anchor = 'function growthOpportunities(';
  const at = js.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: growthOpportunities');
  if(js.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique');
  let i = js.indexOf(')', at); i = js.indexOf('{', i);
  let d = 0, end = -1;
  for(let j = i; j < js.length; j++){
    if(js[j] === '{') d++;
    else if(js[j] === '}'){ d--; if(d === 0){ end = j; break; } }
  }
  if(end < 0) throw new Error('unbalanced');
  const mod = { exports: {} };
  new Function('module', 'exports',
    js.slice(at, end + 1) + '\n;module.exports={growthOpportunities};')(mod, mod.exports);
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

/* routes-api's NORM_BUY, copied exactly — direction included. */
const NORM = { bongo:'airavant-bongorx', airavant:'airavant-bongorx',
               golden:'golden-technologies', 'ohio-medical':'gce' };
const normBuy = s => { s = String(s || '').toLowerCase().trim(); return NORM[s] || s; };

function run(src){
  const { growthOpportunities } = lift(src);
  const none = () => false;
  pass = 0; fail = 0; out.length = 0;

  /* Glasgow Prescription Center, exactly as the live data has it. */
  const ELIGIBLE = ['access4u','airavant-bongorx','bemis','climbing-steps','corsicana',
                    'golden-technologies','ohio-medical','ovation-medical','pedifix','strongback-mobility'];
  const BUYS = new Set(['bemis','golden-technologies','strongback-mobility']);   // company-wide sales
  const ACCTS = ['bemis','golden-technologies','ovation-medical','pedifix','strongback-mobility'];

  /* ---- THE ONE ANGELO REPORTED ------------------------------------------- */
  t('Glasgow is offered the five lines it has no relationship with', () => {
    eq(growthOpportunities(ELIGIBLE, BUYS, ACCTS, none, normBuy),
       ['access4u','airavant-bongorx','climbing-steps','corsicana','ohio-medical'], 'opps');
  });

  t('an account number alone removes a line, with no sales anywhere', () => {
    // Ovation and PediFix have accounts and zero commission history. Before this,
    // both were printed as growth on a sheet that also printed their account numbers.
    eq(growthOpportunities(['ovation-medical','pedifix','corsicana'], new Set(),
                           ['ovation-medical','pedifix'], none, normBuy), ['corsicana'], 'opps');
  });

  t('sales alone still remove a line, with no account on file', () => {
    eq(growthOpportunities(['bemis','corsicana'], new Set(['bemis']), [], none, normBuy),
       ['corsicana'], 'opps');
  });

  t('the two halves of the handout can no longer overlap', () => {
    /* The property that matters: "Lines you carry with us" is built from the
       account numbers, so nothing in that list may appear here. */
    const carried = new Set(ACCTS);
    const grow = growthOpportunities(ELIGIBLE, BUYS, ACCTS, none, normBuy);
    eq(grow.filter(s => carried.has(s)), [], 'intersection');
  });

  /* ---- what must still be offered ---------------------------------------- */
  t('a line they are approved for and have no relationship with is offered', () => {
    eq(growthOpportunities(['corsicana'], new Set(), [], none, normBuy), ['corsicana'], 'opps');
  });

  t('nothing outside the approved list is ever offered', () => {
    // eligible is the gate; buys and accounts only ever subtract from it.
    eq(growthOpportunities(['corsicana'], new Set(), ['pedifix'], none, normBuy), ['corsicana'], 'opps');
    eq(growthOpportunities([], new Set(), [], none, normBuy), [], 'nothing eligible');
  });

  t('a rep-excluded line is still excluded', () => {
    const ex = s => s === 'corsicana';
    eq(growthOpportunities(['corsicana','access4u'], new Set(), [], ex, normBuy), ['access4u'], 'opps');
  });

  /* ---- slug drift --------------------------------------------------------- */
  t('a line counts as carried through a retired spelling of its slug', () => {
    /* The three sources agree today. NORM_BUY exists because they have not always,
       and a subtraction that silently stops matching is this exact bug again. */
    eq(growthOpportunities(['ohio-medical'], new Set(['gce']), [], none, normBuy), [], 'sales as gce');
    eq(growthOpportunities(['gce'], new Set(), ['ohio-medical'], none, normBuy), [], 'account as ohio-medical');
    eq(growthOpportunities(['airavant-bongorx'], new Set(['bongo']), [], none, normBuy), [], 'bongo');
  });

  t('matching is case- and whitespace-insensitive', () => {
    eq(growthOpportunities(['PediFix'], new Set(), ['  pedifix '], none, normBuy), [], 'opps');
  });

  t('without a normaliser it still matches on a plain lowercase comparison', () => {
    eq(growthOpportunities(['PEDIFIX'], new Set(), ['pedifix'], none), [], 'lowercased');
    eq(growthOpportunities(['ohio-medical'], new Set(['gce']), [], none), ['ohio-medical'], 'no folding');
  });

  /* ---- order and shape ---------------------------------------------------- */
  t('the eligible order is preserved, so the handout stays stable', () => {
    eq(growthOpportunities(['pedifix','access4u','corsicana'], new Set(), [], none, normBuy),
       ['pedifix','access4u','corsicana'], 'order');
  });

  t('slugs come back as given, not as their normalised form', () => {
    // The caller looks up the display name and logo by this value.
    eq(growthOpportunities(['ohio-medical'], new Set(), [], none, normBuy), ['ohio-medical'], 'slug');
  });

  t('a blank or whitespace-only slug is never offered', () => {
    /* Whitespace is truthy, so guarding on the raw value lets it through — and it
       renders as an empty tile on a sheet handed to a dealer, with no product
       behind it. The filter tests the normalised key for exactly this. */
    eq(growthOpportunities(['  ', '', null, 'corsicana'], new Set(), [], none, normBuy),
       ['corsicana'], 'opps');
  });

  t('null and ragged inputs do not throw', () => {
    eq(growthOpportunities(null, null, null, null, normBuy), [], 'all null');
    eq(growthOpportunities(['a'], null, null, null, normBuy), ['a'], 'no sets at all');
    eq(growthOpportunities(['a', null, ''], new Set(), [], none, normBuy), ['a'], 'holes dropped');
    eq(growthOpportunities(['a'], new Set(), [null, undefined, 'a'], none, normBuy), [], 'ragged accounts');
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
