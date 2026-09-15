/* The dealer handout — behaviour suite.
   Loads the real src/admin/dealer-handout.js and renders a sheet with it.

   This is the sheet a rep prints and hands to a dealer, so the things asserted here are the
   things that are wrong in someone's hand rather than on a screen: which page a section lands
   on, whether a manufacturer with no logo prints as an empty box, and whether the logos are the
   size they were asked to be. It needs no browser — the page order and the fallback are decided
   in the markup, and that is what is checked.

   The layout itself was measured in a real print engine before these numbers were chosen:
   doubling the logos adds ~260px to page 1, and every point of padding and printer margin that
   could come out came to ~90px. That is why the momentum table moved to page 2 and the tile
   names came off; put either back and CardChamp prints on page 2. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.HANDOUT_JS
  || path.join(__dirname, '..', 'src', 'admin', 'dealer-handout.js');

function load(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const win = {};
  new Function('window', js)(win);
  if(!win.DealerHandout) throw new Error('dealer-handout.js did not register window.DealerHandout');
  return win.DealerHandout;
}

const CASE = {
  name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY', multi_location: true,
  ytd: 50815.45, total: 99892.45, recent60: 7620, company_total: 100908.45, company_ytd: 51831.45,
  accounts: [{ name: 'Bemis', account: '723079' }],
  lines: [
    { slug: 'golden-technologies', name: 'Golden Technologies', amount: 99685, last: '2026-08-01', d60: 7620, d120: 16065, d180: 30972 },
    { slug: 'bemis', name: 'Bemis', amount: 207.45, last: '2026-06-01', d60: 0, d120: 207.45, d180: 207.45 },
  ],
  products: [],
  carried: [
    { slug: 'bemis', name: 'Bemis', logo: 'https://logo.test/bemis.png' },
    { slug: 'ovation-medical', name: 'Ovation Medical', logo: '' },          // no logo on file
  ],
  opps: [{ slug: 'corsicana', name: 'Corsicana Healthcare', logo: 'https://logo.test/corsicana.png' }],
  crossover: { kind: 'new_line', name: 'Corsicana Healthcare', slug: 'corsicana',
               logo: 'https://logo.test/corsicana.png', reason: 'Approved for your territory.' },
  golden: '', golden_logo: '', rep_name: 'Angelo Audia', rep_email: 'angelo@homecareproviderservices.us',
};
const CTX = { HANDOUT: { ordering_url: 'https://hcpsonlineordering.netlify.app',
                         updates: ['New online ordering platform.'] },
              ME: { name: 'Angelo Audia', email: 'angelo@homecareproviderservices.us' } };

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
/* Where a thing sits in the document. Order in the markup IS order on the printed sheet. */
const at = (html, s) => html.indexOf(s);
function before(html, a, b, what){
  const i = at(html, a), j = at(html, b);
  ok(i >= 0, 'missing from the sheet: ' + a);
  ok(j >= 0, 'missing from the sheet: ' + b);
  ok(i < j, (what || 'order') + ': "' + a + '" must come before "' + b + '"');
}

function run(src){
  const DH = load(src);
  const html = DH.html(CASE, CTX);
  pass = 0; fail = 0; out.length = 0;

  /* ---- what is on which page ---------------------------------------------- */
  t('THE PAGE BREAK — What\'s new opens page 2, and the break is declared', () => {
    ok(/\.p2\{[^}]*break-before:\s*page/.test(html), '.p2 does not force a new page');
    const p2 = at(html, '<div class="p2">');
    ok(p2 >= 0, 'there is no page-2 section');
    const nx = at(html, "What's new at HCPS");
    ok(nx > p2, "What's new is not inside the page-2 section");
    // …and it is the FIRST thing there, not buried under something else.
    ok(html.slice(p2, nx).indexOf('<h2>') === html.slice(p2, nx).lastIndexOf('<h2>'),
      "something else opens page 2 ahead of What's new");
  });

  t('CardChamp is the last thing on page 1', () => {
    before(html, 'Ways we can help you grow', 'Turn card fees into cash flow', 'grow then CardChamp');
    before(html, 'Turn card fees into cash flow', '<div class="p2">', 'CardChamp before the page break');
  });

  t('the momentum detail moved to page 2 — this is what made room', () => {
    const p2 = at(html, '<div class="p2">');
    ok(at(html, 'Purchasing activity') > p2, 'the momentum table is back on page 1');
    before(html, "What's new at HCPS", 'Purchasing activity', "What's new opens page 2, then the detail");
  });

  t('page 1 still leads with the business and the line to lead with', () => {
    before(html, 'Your business with HCPS', 'This visit\'s opportunity', 'stats then opportunity');
    before(html, 'This visit\'s opportunity', 'Lines you carry with us', 'opportunity then lines');
    before(html, 'Lines you carry with us', 'Ways we can help you grow', 'carried then grow');
  });

  t('a card that will not fit moves whole instead of tearing in half', () => {
    /* Page 2 used to open in the middle of the CardChamp block, on "Lower or offset merchant
       fees" — the block was being split by the page boundary. */
    /* There is more than one such rule (table rows have their own), so every selector list that
       carries it is collected rather than just the first one found. */
    const protectedBy = [...html.matchAll(/([^{}]+)\{[^}]*break-inside:\s*avoid[^}]*\}/g)]
      .map(m => m[1]).join(' , ');
    ok(protectedBy, 'no break-inside rule at all');
    ok(/\.cc\b/.test(protectedBy), 'the CardChamp block is not protected from a page break');
    ok(/\.cross\b/.test(protectedBy), 'the opportunity card is not protected');
    ok(/\.ltile\b/.test(protectedBy), 'a line tile can be split across the page boundary');
  });

  t('a heading never prints alone at the foot of a page', () => {
    ok(/h2\{[^}]*break-after:\s*avoid/.test(html), 'h2 can be orphaned from what it introduces');
  });

  /* ---- the logos ---------------------------------------------------------- */
  t('THE LOGOS ARE TWICE THE SIZE THEY WERE', () => {
    // They printed at 34x120 and were hard to recognise across a counter. 68x240 is 2x.
    const m = /\.ltile img\{([^}]*)\}/.exec(html);
    ok(m, 'no .ltile img rule');
    ok(/max-height:\s*68px/.test(m[1]), 'tile logo height is not 68px (2x of 34px): ' + m[1]);
    ok(/max-width:\s*240px/.test(m[1]), 'tile logo width is not 240px (2x of 120px): ' + m[1]);
  });

  t('the tile is wide enough and tall enough to hold one', () => {
    const m = /\.ltile\{([^}]*)\}/.exec(html);
    ok(m && /min-width:\s*150px/.test(m[1]), 'the tile is too narrow for a 2x logo');
    ok(m && /min-height:\s*68px/.test(m[1]), 'a name-only tile would be shorter than its neighbours');
  });

  /* ---- no tile can print empty -------------------------------------------- */
  t('NO LOGO ON FILE — the tile prints the manufacturer\'s name', () => {
    /* Angelo's standing rule: never ship a broken image, fall back gracefully. A logo-only tile
       with no logo would otherwise print as an empty rectangle. */
    const i = html.indexOf('Ovation Medical');
    ok(i >= 0, 'a manufacturer with no logo vanished from the sheet');
    const tile = html.slice(html.lastIndexOf('<div class="ltile', i), i);
    ok(tile.indexOf('haslogo') < 0, 'a tile with no logo is marked as having one, so its name is hidden');
    /* …and nothing hides the name unconditionally. A rule that hides .ln outside the .haslogo
       scope empties this tile just as thoroughly as never emitting the name would. */
    for(const m of html.matchAll(/([^{}]*\.ln[^{}]*)\{([^}]*)\}/g))
      if(/display:\s*none/.test(m[2]))
        ok(/haslogo/.test(m[1]), 'the tile name is hidden by "' + m[1].trim()
          + '", which also hides it on tiles that have no logo to show instead');
  });

  t('a logo that fails to load puts the name back', () => {
    const img = /<img src="https:\/\/logo\.test\/bemis\.png"[^>]*>/.exec(html);
    ok(img, 'the logo image is not being rendered');
    ok(/onerror=/.test(img[0]), 'a broken logo would print as a broken image');
    ok(/classList\.remove\('haslogo'\)/.test(img[0]),
      'a broken logo hides itself but leaves the tile empty — the name must come back');
  });

  t('every tile carries its name in the markup, shown or not', () => {
    // The name is always present and hidden by CSS, which is what makes the fallback possible.
    ok(/\.ltile\.haslogo \.ln\{display:none\}/.test(html), 'the name is not hidden by the logo rule');
    ok(html.indexOf('<span class="ln">Bemis</span>') >= 0, 'a tile with a logo dropped its name entirely');
  });

  /* ---- things that must not have broken ----------------------------------- */
  t('the sheet still prints itself, once', () => {
    ok(/window\.print\(\)/.test(html), 'the print trigger is gone');
    eq(html.split('Purchasing activity —').length - 1, 1, 'the momentum table renders more than once');
    eq(html.split('Turn card fees into cash flow').length - 1, 1, 'CardChamp renders more than once');
  });

  t('the dealer\'s own details are escaped, not injected', () => {
    const evil = DH.html(Object.assign({}, CASE, { name: '<script>x</script>' }), CTX);
    ok(evil.indexOf('<script>x</script>') < 0, 'a dealer name is written into the sheet unescaped');
    ok(evil.indexOf('&lt;script&gt;') >= 0, 'the name was dropped rather than escaped');
  });

  t('the printer margins are set by the sheet, not left to the browser', () => {
    ok(/@page\{[^}]*margin:/.test(html), 'no @page margin — the browser default would apply');
  });

  t('both surfaces still get the same sheet', () => {
    // map.html and dealer.html both call this; the export shape is the contract between them.
    ok(typeof DH.html === 'function', 'DealerHandout.html is gone');
    ok(Array.isArray(DH.UPDATES) && DH.UPDATES.length, 'the fallback updates list is gone');
    ok(typeof DH.ORDERING_URL === 'string' && DH.ORDERING_URL, 'the fallback ordering URL is gone');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, load, SRC };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
