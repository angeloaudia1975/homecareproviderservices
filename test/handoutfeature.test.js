/* Which line the dealer handout leads with — behaviour suite.
   Lifts the real featuredPick out of netlify/functions/routes-api.js and runs it, so
   these tests fail when the shipped decision changes rather than when a copy does. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.ROUTES_API
  || path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');

function lift(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const anchor = 'function featuredPick(';
  const at = js.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: featuredPick');
  if(js.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: featuredPick');
  let i = js.indexOf(')', at); i = js.indexOf('{', i);
  let depth = 0, end = -1;
  for(let j = i; j < js.length; j++){
    if(js[j] === '{') depth++;
    else if(js[j] === '}'){ depth--; if(depth === 0){ end = j; break; } }
  }
  if(end < 0) throw new Error('unbalanced featuredPick');
  const code = js.slice(at, end + 1) + '\n;module.exports={featuredPick};';
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

/* routes-api's own NORM_BUY, copied exactly — including the direction, which folds
   "ohio-medical" TOWARDS the retired "gce" rather than the other way round. A fixture that
   guessed the direction would pass while proving nothing about the real drift. */
const NORM = { bongo: 'airavant-bongorx', airavant: 'airavant-bongorx',
               golden: 'golden-technologies', 'ohio-medical': 'gce' };
const normBuy = s => { s = String(s || '').toLowerCase().trim(); return NORM[s] || s; };

function run(src){
  const { featuredPick } = lift(src);
  pass = 0; fail = 0; out.length = 0;

  /* CYA Mobility's real shape: approved for a handful of lines, buys only Golden. */
  const OPPS = [
    { slug: 'access4u',             name: 'Access4U' },
    { slug: 'bemis',                name: 'Bemis' },
    { slug: 'climbing-steps',       name: 'Climbing Steps' },
    { slug: 'corsicana',            name: 'Corsicana Healthcare' },
    { slug: 'strongback-mobility',  name: 'StrongBack Mobility' },
  ];
  const CARRIED = [{ slug: 'golden-technologies', name: 'Golden Technologies' }];
  const AUTO = { kind: 'new_line', slug: 'access4u', name: 'Access4U' };

  /* ---- THE ONE ANGELO ASKED FOR ------------------------------------------ */
  t('a pinned opportunity line is what the handout leads with', () => {
    const r = featuredPick('strongback-mobility', OPPS, CARRIED, AUTO, normBuy);
    eq(r, { kind: 'new_line', slug: 'strongback-mobility', name: 'StrongBack Mobility', pinned: true }, 'pick');
  });

  t('with no pin, the automatic pick stands untouched', () => {
    eq(featuredPick('', OPPS, CARRIED, AUTO, normBuy), AUTO, 'empty string');
    eq(featuredPick(null, OPPS, CARRIED, AUTO, normBuy), AUTO, 'null');
    eq(featuredPick(undefined, OPPS, CARRIED, AUTO, normBuy), AUTO, 'undefined');
    eq(featuredPick('   ', OPPS, CARRIED, AUTO, normBuy), AUTO, 'whitespace');
  });

  /* ---- a pin must never invent eligibility -------------------------------- */
  t('a pin on a line the dealer is not approved for is ignored', () => {
    // PediFix is not in this dealer's opportunities. Featuring it would put a line on the
    // sheet that the dealer cannot actually order.
    eq(featuredPick('pedifix', OPPS, CARRIED, AUTO, normBuy), AUTO, 'falls back to automatic');
  });

  t('a pin on a line that was excluded is ignored', () => {
    // Exclusions are applied before opps is built, so an excluded line simply is not there —
    // this pins the tickbox's meaning: excluded lines are never featured.
    const oppsMinusBemis = OPPS.filter(o => o.slug !== 'bemis');
    eq(featuredPick('bemis', oppsMinusBemis, CARRIED, AUTO, normBuy), AUTO, 'falls back');
  });

  t('a pin on a slug that no longer exists is ignored', () => {
    eq(featuredPick('some-dead-line', OPPS, CARRIED, AUTO, normBuy), AUTO, 'falls back');
  });

  t('an unhonourable pin with nothing to fall back to yields nothing, not a broken pick', () => {
    eq(featuredPick('pedifix', OPPS, CARRIED, null, normBuy), null, 'null');
    eq(featuredPick('pedifix', [], [], null, normBuy), null, 'no candidates at all');
  });

  /* ---- carried lines: the re-stock conversation --------------------------- */
  t('a pinned line the dealer already carries is a re-stock, not a new line', () => {
    const r = featuredPick('golden-technologies', OPPS, CARRIED, AUTO, normBuy);
    eq(r.kind, 'reorder', 'kind');
    eq(r.slug, 'golden-technologies', 'slug');
    eq(r.pinned, true, 'pinned');
  });

  t('an opportunity wins over a carried line of the same slug', () => {
    // Shouldn't happen — opps excludes what the company buys — but if the two lists ever
    // disagree, the sell-in story is the safer of the two to tell.
    const both = [{ slug: 'golden-technologies', name: 'Golden Technologies' }];
    eq(featuredPick('golden-technologies', both, CARRIED, AUTO, normBuy).kind, 'new_line', 'kind');
  });

  /* ---- slug spellings ----------------------------------------------------- */
  t('a pin matches through the retired spelling of a slug', () => {
    // The exclusions table still holds "gce" where the grid now says "ohio-medical"; a pin
    // must not be silently dropped by the same drift.
    const opps = [{ slug: 'ohio-medical', name: 'Ohio Medical / GCE' }];
    const r = featuredPick('gce', opps, [], AUTO, normBuy);
    eq(r.slug, 'ohio-medical', 'resolves to the live slug');
    eq(r.name, 'Ohio Medical / GCE', 'and its live name');
  });

  t('matching is case- and whitespace-insensitive', () => {
    eq(featuredPick('  StrongBack-Mobility  ', OPPS, CARRIED, AUTO, normBuy).slug,
       'strongback-mobility', 'slug');
  });

  t('without a normaliser it still matches on a plain lowercase comparison', () => {
    // The normaliser is optional so the function can be reasoned about on its own.
    const r = featuredPick('STRONGBACK-MOBILITY', OPPS, CARRIED, AUTO);
    eq(r.slug, 'strongback-mobility', 'slug');
    eq(featuredPick('gce', [{ slug: 'ohio-medical', name: 'x' }], [], AUTO), AUTO, 'no folding without it');
  });

  /* ---- the name and reason ----------------------------------------------- */
  t('the pick carries the line\'s own display name, not the pinned string', () => {
    eq(featuredPick('STRONGBACK-MOBILITY', OPPS, CARRIED, AUTO, normBuy).name,
       'StrongBack Mobility', 'name');
  });

  t('a pin returns no reason of its own — the caller writes the dealer-facing copy', () => {
    /* The sheet is dealer-facing and must never read "your rep chose this", so the pin
       decides WHICH line is featured and nothing about how it is explained. */
    const r = featuredPick('strongback-mobility', OPPS, CARRIED, AUTO, normBuy);
    eq('reason' in r, false, 'no reason');
    eq('basis' in r, false, 'no basis');
  });

  /* ---- shape -------------------------------------------------------------- */
  t('a blank pin never latches onto a line with a blank slug', () => {
    /* What the empty-pin guard and the trim are actually for, and the only case where
       either changes an answer: with neither, a whitespace-only pin normalises to "" and
       matches the first row whose slug is also "" — featuring a nameless line on a printed
       sheet. A mutation harness found both guards untested. */
    const ragged = [{ slug: '', name: 'Nameless' }, { slug: 'bemis', name: 'Bemis' }];
    eq(featuredPick('', ragged, [], AUTO, normBuy), AUTO, 'empty pin');
    eq(featuredPick('   ', ragged, [], AUTO, normBuy), AUTO, 'whitespace pin');
    eq(featuredPick('   ', [], [{ slug: '', name: 'Nameless' }], AUTO, normBuy), AUTO, 'nor via carried');
  });

  t('null and ragged inputs do not throw', () => {
    eq(featuredPick('x', null, null, null, normBuy), null, 'all null');
    eq(featuredPick('x', [null, undefined], [null], AUTO, normBuy), AUTO, 'ragged rows');
    eq(featuredPick('', null, null, AUTO, normBuy), AUTO, 'no pin, null lists');
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
