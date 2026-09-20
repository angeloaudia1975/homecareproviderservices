/* The purchasing table's scope — behaviour suite.
   Lifts the real companyLines, shortLocation and whereLabel out of routes-api.js and runs them.

   The bug: the table was scoped to the one location the sheet is for, while the dollar figures
   printed above it were company-wide. Glasgow Prescription Center printed "$100,908 lifetime"
   over a table adding up to $99,892, and the $1,016 of StrongBack its own Hosparus warehouse had
   bought appeared nowhere — so a dealer holding the sheet sees us not knowing about their own
   orders. 108 of 444 dealers were in that position; 47 printed a company total over an empty
   table.

   None of that throws. It prints, it looks finished, and it is wrong in the dealer's hand. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.ROUTES_API || path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');

function lift(src, name){
  const anchor = 'function ' + name + '(';
  const at = src.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: ' + name);
  if(src.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: ' + name);
  let i = src.indexOf('{', at), depth = 0, end = -1;
  for(; i < src.length; i++){
    const c = src[i];
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0){ end = i + 1; break; } }
  }
  if(end < 0) throw new Error('unbalanced braces: ' + name);
  return src.slice(at, end);
}
function load(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const code = lift(js, 'shortLocation') + '\n' + lift(js, 'whereLabel') + '\n' + lift(js, 'companyLines')
    + '\n' + lift(js, 'companyProducts')
    + '\nmodule.exports={shortLocation,whereLabel,companyLines,companyProducts};';
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

/* Glasgow, with the real figures: the shop bought Golden and Bemis, the warehouse bought
   StrongBack, and only the first two have ever reached the sheet. */
const HERE = 'glasgow', WAREHOUSE = 'hosparus';
const NAMES = { glasgow: 'Glasgow Prescription Center',
                hosparus: 'Glasgow Prescription Center Hosparus Warehouse' };
const BY = {
  glasgow: { lines: {
    'golden-technologies': { name:'Golden Technologies', amount:99685, qty:120, orders:108, last:'2026-08-01', d60:7620, d120:16065, d180:30972 },
    'bemis': { name:'Bemis', amount:207.45, qty:9, orders:9, last:'2026-06-01', d60:0, d120:207.45, d180:207.45 },
  } },
  hosparus: { lines: {
    'strongback-mobility': { name:'Strongback Mobility', amount:1016, qty:14, orders:6, last:'2026-07-01', d60:0, d120:340, d180:1016 },
  } },
};

function run(src){
  const M = load(src);
  pass = 0; fail = 0; out.length = 0;
  const rows = M.companyLines([HERE, WAREHOUSE], BY, HERE, NAMES, NAMES[HERE]);
  const row = s => rows.find(r => r.slug === s);

  /* ---- the missing line -------------------------------------------------- */
  t('THE ONE THAT STARTED THIS — the warehouse\'s StrongBack orders reach the sheet', () => {
    const sb = row('strongback-mobility');
    ok(sb, 'StrongBack is still missing from the table');
    eq(sb.amount, 1016, 'amount');
    eq(sb.where, 'Hosparus Warehouse', 'and the sheet says which location bought it');
  });

  t('the table now adds up to the company figure printed above it', () => {
    const total = rows.reduce((n, r) => n + r.amount, 0);
    eq(Math.round(total * 100) / 100, 100908.45, 'company lifetime');
  });

  t('a line bought only at this shop says nothing about location', () => {
    eq(row('golden-technologies').where, '', 'Golden, bought here');
    eq(row('bemis').where, '', 'Bemis, bought here');
  });

  t('rows are ordered by what the dealer spends most on', () => {
    eq(rows.map(r => r.slug), ['golden-technologies', 'strongback-mobility', 'bemis'], 'order');
  });

  /* ---- merging the same line across locations ----------------------------- */
  t('one line bought at two locations is ONE row with both amounts in it', () => {
    const by = { a: { lines: { x: { name:'X', amount:100, qty:2, orders:2, last:'2026-05-01', d60:10, d120:20, d180:40 } } },
                 b: { lines: { x: { name:'X', amount:50,  qty:1, orders:1, last:'2026-07-01', d60:5,  d120:5,  d180:50 } } } };
    const r = M.companyLines(['a','b'], by, 'a', { a:'Shop', b:'Shop Annex' }, 'Shop')[0];
    eq([r.amount, r.qty, r.orders], [150, 3, 3], 'summed');
    eq([r.d60, r.d120, r.d180], [15, 25, 90], 'windows summed');
    eq(r.last, '2026-07-01', 'the most recent order date of either');
    eq(r.where, '+ Annex', 'bought here AND there');
  });

  t('the most recent order date wins whichever location it came from', () => {
    const by = { a: { lines: { x: { name:'X', amount:1, last:'2026-01-01' } } },
                 b: { lines: { x: { name:'X', amount:1, last:'2026-09-01' } } } };
    eq(M.companyLines(['a','b'], by, 'a', {}, '')[0].last, '2026-09-01', 'later location read second');
    /* And the other way round, which is the case that catches "whatever was read last wins":
       the newest order is at the location read FIRST. */
    const rev = { a: { lines: { x: { name:'X', amount:1, last:'2026-09-01' } } },
                  b: { lines: { x: { name:'X', amount:1, last:'2026-01-01' } } } };
    eq(M.companyLines(['a','b'], rev, 'a', {}, '')[0].last, '2026-09-01', 'later location read first');
  });

  t('the location that bought most is named first', () => {
    /* The order of `by` decides which name the column leads with when two locations bought — and
       a dealer reading "Annex & Depot" expects the bigger one first. */
    const by = { a: { lines: { x: { name:'X', amount:10, last:'2026-01-01' } } },
                 b: { lines: { x: { name:'X', amount:90, last:'2026-01-01' } } },
                 c: { lines: { x: { name:'X', amount:50, last:'2026-01-01' } } } };
    const r = M.companyLines(['a','b','c'], by, 'zz', { a:'Small', b:'Biggest', c:'Middle' }, '')[0];
    eq(r.by.map(x => x.name), ['Biggest', 'Middle', 'Small'], 'biggest buyer first');
  });

  t('A LOCATION THAT BOUGHT NOTHING IS NOT NAMED', () => {
    /* A zero-amount row would otherwise credit a branch with a purchase it never made. */
    const by = { a: { lines: { x: { name:'X', amount:60, last:'2026-05-01' } } },
                 b: { lines: { x: { name:'X', amount:0,  last:'2026-05-01' } } } };
    const r = M.companyLines(['a','b'], by, 'a', { a:'Shop', b:'Annex' }, '')[0];
    eq(r.where, '', 'no location named');
    eq(r.by.length, 1, 'only the one that bought');
  });

  /* ---- what the location column says -------------------------------------- */
  t('the column names one other location, two, or counts them', () => {
    const mk = n => ({ by: Array.from({ length: n }, (_, i) => ({ name: 'L' + i, amount: 10, here: false })) });
    eq(M.whereLabel(mk(1).by), 'L0', 'one');
    eq(M.whereLabel(mk(2).by), 'L0 & L1', 'two');
    eq(M.whereLabel(mk(3).by), '3 other locations', 'several');
  });

  t('"+" means this shop bought some of it too', () => {
    eq(M.whereLabel([{ name:'Here', amount:5, here:true }, { name:'Annex', amount:5, here:false }]), '+ Annex', 'both');
    eq(M.whereLabel([{ name:'Annex', amount:5, here:false }]), 'Annex', 'only the other');
    eq(M.whereLabel([{ name:'Here', amount:5, here:true }]), '', 'only here');
    eq(M.whereLabel([]), '', 'nobody');
  });

  t('a branch name drops the company name it repeats', () => {
    eq(M.shortLocation('Glasgow Prescription Center Hosparus Warehouse', 'Glasgow Prescription Center'),
       'Hosparus Warehouse', 'prefix dropped');
    eq(M.shortLocation('Med Mart Kettering', 'Med Mart'), 'Kettering', 'prefix dropped');
    eq(M.shortLocation('Med Mart - Kettering', 'Med Mart'), 'Kettering', 'separator dropped too');
  });

  t('a name that is not a prefix is left exactly as it is', () => {
    eq(M.shortLocation('Georges Medical Blue Ash', 'Georges Pharmacy'), 'Georges Medical Blue Ash', 'different name');
    eq(M.shortLocation('Shop', 'Shop'), 'Shop', 'identical — never blanked');
    /* Longer than the company name but nothing left once the separator goes. A blank here would
       print a row whose location column is empty for a purchase made somewhere else. */
    eq(M.shortLocation('Shop -', 'Shop'), 'Shop -', 'nothing distinguishing left — keep the full name');
    eq(M.shortLocation('', 'Shop'), '', 'nothing');
    eq(M.shortLocation('Annex', ''), 'Annex', 'no company name to drop');
  });

  /* ---- the things that must not have changed ------------------------------ */
  t('A LINE WITH NO ORDERS NEVER REACHES THIS TABLE', () => {
    /* Ovation and PediFix are accounts Glasgow holds with nothing bought through them. They
       belong on the tiles, not in a purchasing history — a row of dashes is not history. */
    const by = { a: { lines: {} } };
    eq(M.companyLines(['a'], by, 'a', {}, ''), [], 'nothing bought, nothing listed');
  });

  t('a single-location dealer is completely unaffected', () => {
    const by = { solo: { lines: { x: { name:'X', amount:500, qty:1, orders:1, last:'2026-04-01', d60:0, d120:0, d180:500 } } } };
    const r = M.companyLines(['solo'], by, 'solo', { solo:'Solo Shop' }, 'Solo Shop');
    eq(r.length, 1, 'one row');
    eq([r[0].amount, r[0].where], [500, ''], 'its own figure, no location column');
  });

  t('a family member with no sales at all is simply skipped', () => {
    const by = { a: { lines: { x: { name:'X', amount:10, last:'2026-01-01' } } } };
    const r = M.companyLines(['a','b','c'], by, 'a', {}, '');
    eq(r.length, 1, 'one row');
    eq(r[0].amount, 10, 'amount');
  });

  t('an empty family, or none at all, yields nothing rather than throwing', () => {
    eq(M.companyLines([], {}, 'a', {}, ''), [], 'empty');
    eq(M.companyLines(null, null, null, null, null), [], 'nothing at all');
  });

  /* ---- the products underneath the table ---------------------------------- */
  t('the products follow the table, so a line is never listed without its products', () => {
    /* The StrongBack row and the StrongBack part numbers have to come from the same place, or
       the sheet contradicts itself between one section and the next. */
    const pd = { glasgow: { 'pr447-med': { code:'PR447-MED', name:'PR447-MED', line:'Golden Technologies', qty:2, amount:4000, orders:2, last:'2026-07-01', d60:0, d120:4000, d180:4000 } },
                 hosparus: { 'es0001': { code:'ES0001', name:'ES0001', line:'Strongback Mobility', qty:3, amount:600, orders:1, last:'2026-07-01', d60:0, d120:600, d180:600 } } };
    const p = M.companyProducts([HERE, WAREHOUSE], pd);
    eq(p.map(x => x.code).sort(), ['ES0001', 'PR447-MED'], 'both locations\' products');
  });

  t('one part number bought at two locations is one entry carrying both', () => {
    const pd = { a: { k: { code:'K', name:'K', line:'L', qty:1, amount:10, orders:1, last:'2026-01-01', d60:0, d120:0, d180:10 } },
                 b: { k: { code:'K', name:'K', line:'L', qty:4, amount:40, orders:2, last:'2026-08-01', d60:40, d120:40, d180:40 } } };
    const p = M.companyProducts(['a','b'], pd);
    eq(p.length, 1, 'one entry');
    eq([p[0].qty, p[0].amount, p[0].orders, p[0].last], [5, 50, 3, '2026-08-01'], 'summed, newest date');
    /* Reversed, so "whatever was read last wins" cannot pass: the newest order is read FIRST. */
    const pd2 = { a: { k: { code:'K', qty:4, amount:40, orders:2, last:'2026-08-01' } },
                  b: { k: { code:'K', qty:1, amount:10, orders:1, last:'2026-01-01' } } };
    eq(M.companyProducts(['a','b'], pd2)[0].last, '2026-08-01', 'newest date read first');
  });

  t('no products anywhere is an empty list rather than a throw', () => {
    eq(M.companyProducts(['a'], {}), [], 'none');
    eq(M.companyProducts(null, null), [], 'nothing at all');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, load, lift, SRC };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
