/* Mutation harness for the purchasing table's scope.

   Every mutant still prints a table. That is what makes this class of bug expensive: the sheet
   looks finished either way, and the dealer is the one who notices that their own orders are
   missing — or that a branch has been credited with a purchase it never made.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must SURVIVE; if it dies
   the harness is failing everything. */
const fs = require('fs');
const suite = require('./companylines.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '      const L=src.lines[slug]||{};',
    to:   '      const L=src.lines[slug]||{}; /* control */',
    expect: 'survive' },

  // --- back to one location's worth
  { name: 'read only the location the sheet is for, which is the original bug',
    from: '  (memberIds||[]).forEach(did=>{\n    const src=(byDealer||{})[did]; if(!src||!src.lines) return;',
    to:   '  [hereId].forEach(did=>{\n    const src=(byDealer||{})[did]; if(!src||!src.lines) return;' },

  { name: 'drop every line the other locations bought',
    from: '      if((Number(L.amount)||0)>0)\n        M.by.push({ dealer_id:did, name:shortLocation((nameById||{})[did], companyName),\n                    amount:Number(L.amount)||0, here:did===hereId });',
    to:   '      if(did===hereId && (Number(L.amount)||0)>0)\n        M.by.push({ dealer_id:did, name:shortLocation((nameById||{})[did], companyName),\n                    amount:Number(L.amount)||0, here:did===hereId });' },

  // --- the arithmetic
  { name: 'keep the biggest location\'s figure instead of summing them',
    from: '      M.amount+=Number(L.amount)||0; M.qty+=Number(L.qty)||0; M.orders+=Number(L.orders)||0;',
    to:   '      M.amount=Math.max(M.amount,Number(L.amount)||0); M.qty+=Number(L.qty)||0; M.orders+=Number(L.orders)||0;' },

  { name: 'stop summing the 60/120/180 day windows',
    from: '      M.d60+=Number(L.d60)||0; M.d120+=Number(L.d120)||0; M.d180+=Number(L.d180)||0;',
    to:   '      M.d60=Number(L.d60)||0; M.d120=Number(L.d120)||0; M.d180=Number(L.d180)||0;' },

  { name: 'take the last order date of whichever location came last in the list',
    from: '      if(String(L.last||"")>M.last) M.last=String(L.last||"");',
    to:   '      M.last=String(L.last||"");' },

  { name: 'stop sorting, so the biggest line is wherever it happens to fall',
    from: '  }).sort((a,b)=>b.amount-a.amount);',
    to:   '  });' },

  // --- crediting the wrong shop
  { name: 'CREDIT A LOCATION THAT BOUGHT NOTHING',
    from: '      if((Number(L.amount)||0)>0)',
    to:   '      if(true)' },

  { name: 'mark every location as if it were this one, so nothing is ever named',
    from: '                    amount:Number(L.amount)||0, here:did===hereId });',
    to:   '                    amount:Number(L.amount)||0, here:true });' },

  { name: 'mark no location as this one, so the sheet names the shop it is handed to',
    from: '                    amount:Number(L.amount)||0, here:did===hereId });',
    to:   '                    amount:Number(L.amount)||0, here:false });' },

  { name: 'name the biggest buyer last instead of first',
    from: '    M.by.sort((a,b)=>b.amount-a.amount);',
    to:   '    M.by.sort((a,b)=>a.amount-b.amount);' },

  // --- the label itself
  { name: 'say nothing at all about which location bought',
    from: '    M.where=whereLabel(M.by);',
    to:   '    M.where="";' },

  { name: 'lose the "+" that means this shop bought some of it too',
    from: '  return list.some(x=>x.here) ? "+ "+label : label;',
    to:   '  return label;' },

  { name: 'list every location by name however many there are',
    from: '              : (names.length+" other locations");',
    to:   '              : names.join(", ");' },

  // --- the branch name
  { name: 'print the whole branch name, company prefix and all',
    from: '  const rest=n.slice(c.length).replace(/^[\\s\\-–—·,:]+/,"").trim();\n  return rest||n;',
    to:   '  return n;' },

  { name: 'blank a branch whose name IS the company name',
    from: '  return rest||n;',
    to:   '  return rest;' },

  { name: 'strip the prefix from a name that merely starts with similar words',
    from: '  if(n.slice(0,c.length).toLowerCase()!==c.toLowerCase()) return n;',
    to:   '  ;' },

  // --- the products underneath the table
  { name: 'leave the products on this location while the table covers the company',
    from: '  (memberIds||[]).forEach(did=>{\n    const src=(prodByDealer||{})[did]; if(!src) return;',
    to:   '  [memberIds&&memberIds[0]].forEach(did=>{\n    const src=(prodByDealer||{})[did]; if(!src) return;' },

  { name: 'stop summing a part number bought at two locations',
    from: '      M.qty+=Number(P.qty)||0; M.amount+=Number(P.amount)||0; M.orders+=Number(P.orders)||0;',
    to:   '      M.qty=Number(P.qty)||0; M.amount=Number(P.amount)||0; M.orders=Number(P.orders)||0;' },

  { name: 'take whichever order date was read last for a product',
    from: '      if(String(P.last||"")>M.last) M.last=String(P.last||"");',
    to:   '      M.last=String(P.last||"");' },
];

let bad = 0;
console.log('mutant                                                              anchors  result');
console.log('-'.repeat(92));

for(const m of MUTANTS){
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(64) + String(hits).padStart(6) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
    bad++; continue;
  }
  const mutated = src.replace(m.from, m.to);
  let r;
  try { r = suite.run(mutated); }
  catch(e){ r = { pass: 0, fail: -1, report: 'threw: ' + e.message }; }

  const survived = r.fail === 0;
  const wantSurvive = m.expect === 'survive';
  if(survived !== wantSurvive) bad++;

  const verdict = survived
    ? (wantSurvive ? 'survived (correct — no-op)' : 'SURVIVED — untested behaviour')
    : (wantSurvive ? 'KILLED — harness is broken' : 'killed by ' + r.fail + ' test(s)');
  console.log(m.name.padEnd(64) + String(hits).padStart(6) + '   ' + verdict);
}

console.log('-'.repeat(92));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
