/* Dealer 360 & CRM search — behaviour suite.
   Lifts the real dealerLines / lineWhy / indexDealer / pickerScore out of
   src/admin/dealer.html and runs them, so these tests fail when the shipped search
   changes rather than when a copy of it does. */
const fs = require('fs');
const path = require('path');

const PAGE = process.env.DEALER_HTML
  || path.join(__dirname, '..', 'src', 'admin', 'dealer.html');

function fnSrc(html, name){
  const anchor = 'function ' + name + '(';
  const at = html.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: ' + name);
  if(html.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: ' + name);
  let i = html.indexOf(')', at); i = html.indexOf('{', i);
  let depth = 0;
  for(let j = i; j < html.length; j++){
    if(html[j] === '{') depth++;
    else if(html[j] === '}'){ depth--; if(depth === 0) return html.slice(at, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

function lift(src){
  const html = src !== undefined ? src : fs.readFileSync(PAGE, 'utf8');
  const code = 'let MFRNAME={};\n'
    + ['dealerLines','lineWhy','indexDealer','pickerScore'].map(n => fnSrc(html, n)).join('\n\n')
    + '\n;module.exports={dealerLines,lineWhy,indexDealer,pickerScore,'
    + 'setNames:o=>{MFRNAME=o||{};}};';
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

/* Real slugs and real names, including the drifted ones. */
const NAMES = {
  'abm-respiratory-care': 'ABM Respiratory Care',
  'bemis': 'Bemis Health Care',
  'ovation-medical': 'Ovation Medical',
  'pedifix': 'PediFix',
  'strongback-mobility': 'StrongBack Mobility',
  'ohio-medical': 'Ohio Medical',
  'airavant-bongorx': 'Airavant BongoRx',
};

function run(src){
  const M = lift(src);
  M.setNames(NAMES);

  pass = 0; fail = 0; out.length = 0;

  const D = (name, extra) => M.indexDealer(Object.assign({
    id: name.toLowerCase().replace(/\W+/g, '-'), name,
    hcps_account: '', email: '', city: '', state: '', rep: '', phone: '',
    contacts: [], aliases: [], access: [], buysLines: [], mfrAccounts: [], accounts: [],
  }, extra || {}));

  /* Rank a query across a set of dealers the way filterPicker does. */
  const rank = (dealers, q) => dealers
    .map(d => ({ d, r: M.pickerScore(d, q.toLowerCase().trim()) }))
    .filter(x => x.r)
    .sort((a, b) => b.r.score - a.r.score
      || String(a.d.name).localeCompare(String(b.d.name), 'en', { sensitivity: 'base' }))
    .map(x => x.d.name);

  /* ---- THE ONE ANGELO ASKED FOR ------------------------------------------ */
  t('typing a manufacturer name finds every dealer with that relationship', () => {
    /* Riverbend comes first because it actually buys the line; the other two are a tick on
       the access grid and an account number. Dealers with no ABM relationship are absent. */
    const all = [
      D('Med Mart Supply',    { access: ['abm-respiratory-care', 'bemis'] }),
      D('Riverbend Home Care',{ buysLines: ['abm-respiratory-care'] }),
      D('Yost Medical',       { mfrAccounts: [{ slug: 'abm-respiratory-care', ref: '4471', active: true }] }),
      D('Bluegrass Mobility', { access: ['bemis'] }),
      D('Elumina Health',     { access: ['pedifix'], buysLines: ['pedifix'] }),
    ];
    eq(rank(all, 'ABM'), ['Riverbend Home Care', 'Med Mart Supply', 'Yost Medical'], 'ABM dealers');
  });

  t('a dealer who buys the line ranks above one merely ticked for it', () => {
    /* The access grid is broad by design — on live data "pedifix" matches 330 of 444
       dealers — so purchase history is what makes a result worth looking at first. */
    const all = [
      D('Aaron Medical',   { access: ['pedifix'] }),                        // alphabetically first
      D('Zenith Footcare', { access: ['pedifix'], buysLines: ['pedifix'] }),
    ];
    eq(rank(all, 'pedifix'), ['Zenith Footcare', 'Aaron Medical'], 'buying first, despite the name');
    eq(M.pickerScore(all[1], 'pedifix').score, 77, 'buying');
    eq(M.pickerScore(all[0], 'pedifix').score, 76, 'access only');
  });

  t('a multi-word manufacturer name matches as a prefix, not as a mid-word fallback', () => {
    /* The live name is "Ohio Medical / GCE". The query has a space where the slug has a
       hyphen and it starts no single word of the name, so only a whole-name prefix test
       catches it — otherwise it lands in the weakest band and can sort below an unrelated
       contact match. The merged name also keeps the old GCE initials findable. */
    M.setNames(Object.assign({}, NAMES, { 'ohio-medical': 'Ohio Medical / GCE' }));
    try {
      const r = M.pickerScore(D('1A Medical Supply', { access: ['ohio-medical'] }), 'ohio medical');
      ok(r, 'matched');
      eq(r.score, 76, 'ranks as a manufacturer prefix');
      eq(r.mfr, 'Ohio Medical / GCE', 'mfr');
      ok(M.pickerScore(D('1A Medical Supply', { access: ['ohio-medical'] }), 'gce'), 'gce still finds it');
    } finally { M.setNames(NAMES); }
  });

  t('the slug spelling works as well as the display name', () => {
    const all = [D('Med Mart Supply', { access: ['abm-respiratory-care'] })];
    eq(rank(all, 'abm-respiratory'), ['Med Mart Supply'], 'by slug');
    eq(rank(all, 'respiratory'), ['Med Mart Supply'], 'by a later word of the name');
  });

  t('a dealer whose own name starts with the query still comes first', () => {
    // Otherwise searching for a business would be drowned by the line that shares its name.
    const all = [
      D('Riverbend Home Care', { access: ['abm-respiratory-care'] }),
      D('ABM Medical Supply'),
    ];
    eq(rank(all, 'abm'), ['ABM Medical Supply', 'Riverbend Home Care'], 'order');
  });

  t('a manufacturer match outranks a coincidental contact name', () => {
    const all = [
      D('Cumberland DME',   { contacts: [{ name: 'Abigail Stone', email: '' }] }),
      D('Tri-State Mobility', { access: ['abm-respiratory-care'] }),
    ];
    eq(rank(all, 'abi'), ['Cumberland DME'], 'a real contact prefix is not displaced');
    eq(rank(all, 'abm'), ['Tri-State Mobility'], 'the line wins its own name');
  });

  t('when BOTH match, the manufacturer comes above the contact', () => {
    /* Head-to-head against the strongest competing rule: a contact whose name really does
       start with the query still scores 72. Someone typing a line name wants the line, so
       the carrier has to sort first — a correct result set in the wrong order is one nobody
       scrolls to. */
    const all = [
      D('Barren River Medical', { contacts: [{ name: 'Pedro Alvarez', email: '' }] }),
      D('Highland Foot Care',   { access: ['pedifix'] }),
    ];
    eq(rank(all, 'ped'), ['Highland Foot Care', 'Barren River Medical'], 'order');
    eq(M.pickerScore(all[1], 'ped').score, 76, 'manufacturer prefix');
    eq(M.pickerScore(all[0], 'ped').score, 72, 'contact prefix — the rule it has to beat');
  });

  t('a word of the display name that is nowhere in the slug still matches', () => {
    /* The slug is "bemis"; the name is "Bemis Health Care". Without the display name in
       the index — or with only a whole-string prefix test — "health" finds nothing. */
    const d = D('Ridgeline Home Medical', { access: ['bemis'] });
    const r = M.pickerScore(d, 'health');
    ok(r, 'matched');
    eq(r.score, 76, 'ranks as a manufacturer prefix, not a fallback');
    eq(r.why, 'Bemis Health Care · access', 'why');
    eq(r.mfr, 'Bemis Health Care', 'the matched line is reported for the count line');
  });

  t('a manufacturer match in the middle of a word still matches, lower down', () => {
    // "back" is inside StrongBack but starts neither the slug nor any word of the name.
    const d = D('Valley Mobility', { access: ['strongback-mobility'] });
    const r = M.pickerScore(d, 'back');
    ok(r, 'matched');
    eq(r.score, 48, 'the weakest kind of line match');
    eq(r.mfr, 'StrongBack Mobility', 'still reported');
  });

  /* ---- account numbers --------------------------------------------------- */
  t('a manufacturer account number finds its dealer', () => {
    const all = [
      D('Yost Medical', { mfrAccounts: [{ slug: 'bemis', ref: 'BM-99120', active: true }] }),
      D('Other Dealer', { access: ['bemis'] }),
    ];
    eq(rank(all, 'BM-99120'), ['Yost Medical'], 'found');
    const r = M.pickerScore(all[0], 'bm-99120');
    eq(r.why, 'Bemis Health Care · acct BM-99120', 'why');
  });

  t('a manufacturer report customer number also finds its dealer', () => {
    // `accounts` is the customer # off the manufacturer's commission report — a different
    // number from the account ref, and it was not searchable at all before.
    const d = D('Riverbend Home Care', { accounts: ['ovation-medical:C-55021'] });
    const r = M.pickerScore(d, 'c-55021');
    ok(r, 'matched');
    eq(r.why, 'report ref C-55021', 'why');
  });

  t('an account number on a switched-off row is findable and says so', () => {
    const d = D('Lapsed Medical', { mfrAccounts: [{ slug: 'pedifix', ref: 'PF-7', active: false }] });
    const r = M.pickerScore(d, 'pedifix');
    ok(r, 'still matched');
    eq(r.why, 'PediFix · acct PF-7 · access off', 'why');
  });

  /* ---- how a match is explained ------------------------------------------ */
  t('the row says which of the three kinds of relationship matched', () => {
    const granted = D('A', { access: ['bemis'] });
    const buying  = D('B', { buysLines: ['bemis'] });
    const acct    = D('C', { access: ['bemis'], mfrAccounts: [{ slug: 'bemis', ref: '12', active: true }] });
    eq(M.pickerScore(granted, 'bemis').why, 'Bemis Health Care · access', 'access only');
    eq(M.pickerScore(buying,  'bemis').why, 'Bemis Health Care · buying', 'buying');
    eq(M.pickerScore(acct,    'bemis').why, 'Bemis Health Care · acct 12', 'account number wins the label');
  });

  t('the matched manufacturer is reported so the count line can name it', () => {
    const d = D('Med Mart Supply', { access: ['abm-respiratory-care'] });
    eq(M.pickerScore(d, 'abm').mfr, 'ABM Respiratory Care', 'mfr');
    eq(M.pickerScore(D('Med Mart Supply'), 'med').mfr, undefined, 'no mfr on a name match');
  });

  /* ---- the merge of the three sources ------------------------------------ */
  t('one manufacturer named by all three sources is one row, not three', () => {
    const d = D('Med Mart Supply', {
      access: ['bemis'], buysLines: ['bemis'],
      mfrAccounts: [{ slug: 'bemis', ref: '12', active: true }],
    });
    eq(d._lines.length, 1, 'rows');
    eq(d._lines[0], { slug:'bemis', name:'Bemis Health Care', granted:true, buys:true,
                      ref:'12', refActive:true, nameLc:'bemis health care' }, 'merged row');
  });

  t('lines are listed by display name, not by slug', () => {
    const d = D('Wide Dealer', { access: ['strongback-mobility', 'abm-respiratory-care', 'ohio-medical'] });
    eq(d._lines.map(L => L.name), ['ABM Respiratory Care', 'Ohio Medical', 'StrongBack Mobility'], 'order');
  });

  t('a slug with no name on record falls back to the slug itself', () => {
    const d = D('Legacy Dealer', { access: ['some-new-line'] });
    eq(d._lines[0].name, 'some-new-line', 'name');
    ok(M.pickerScore(d, 'some-new'), 'still findable');
  });

  /* ---- narrowing --------------------------------------------------------- */
  t('a manufacturer and a city together narrow to the intersection', () => {
    const all = [
      D('Louisville Home Medical', { city: 'Louisville', access: ['abm-respiratory-care'] }),
      D('Nashville Home Medical',  { city: 'Nashville',  access: ['abm-respiratory-care'] }),
      D('Louisville Mobility',     { city: 'Louisville', access: ['bemis'] }),
    ];
    eq(rank(all, 'abm louisville'), ['Louisville Home Medical'], 'intersection');
  });

  t('a dealer with no relationship to the line is not returned', () => {
    eq(rank([D('Bluegrass Mobility', { access: ['bemis'] })], 'abm'), [], 'no match');
  });

  /* ---- nothing that worked before stops working -------------------------- */
  t('business, account #, contact, email, alias and rep search still work', () => {
    const d = D('Cumberland DME', {
      hcps_account: 'H-3310', email: 'orders@cumberlanddme.com', rep: 'Greg Campbell',
      aliases: ['Cumberland Durable Medical'], city: 'Cookeville', state: 'TN',
      contacts: [{ name: 'Dana Reed', email: 'dana@cumberlanddme.com' }],
      access: ['bemis'],
    });
    eq(M.pickerScore(d, 'cumber').score, 100, 'business name prefix');
    eq(M.pickerScore(d, 'h-3310').score, 80, 'hcps account prefix');
    eq(M.pickerScore(d, 'dana').score, 72, 'contact prefix');
    eq(M.pickerScore(d, 'dme').score, 86, 'a name word prefix');
    eq(M.pickerScore(d, 'dana@cumber').score, 46, 'contact email');
    eq(M.pickerScore(d, 'durable').score, 40, 'alias');
    eq(M.pickerScore(d, 'greg').score, 30, 'rep');
    eq(M.pickerScore(d, 'cookeville').score, 20, 'city falls through to the floor');
    eq(M.pickerScore(d, 'zzzz'), null, 'no match');
  });

  t('a dealer with no manufacturer data at all does not throw', () => {
    const d = M.indexDealer({ name: 'Bare Record' });
    eq(d._lines, [], 'no lines');
    ok(M.pickerScore(d, 'bare'), 'still searchable');
    eq(M.pickerScore(d, 'abm'), null, 'no false match');
  });

  t('a blank slug is not indexed as a relationship', () => {
    const d = D('Odd Record', { access: ['', null], mfrAccounts: [{ slug: '', ref: 'X', active: true }] });
    eq(d._lines, [], 'no phantom line');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, lift, PAGE };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
