/* Mutation harness for the Dealer 360 & CRM search.

   A search box fails in two directions and both are quiet. Missing a dealer who
   really does carry the line is the failure Angelo reported — you conclude nobody
   sells ABM in Tennessee. Returning dealers who don't is worse, because the list
   looks authoritative and gets acted on. Mutants cover both, plus the ranking, since
   a correct result set in the wrong order is a result set nobody scrolls to.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must SURVIVE;
   if it dies the harness is failing everything and no other result means anything. */
const fs = require('fs');
const suite = require('./dealersearch.test');

const src = fs.readFileSync(suite.PAGE, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: 'function dealerLines(d){\n  const by={};',
    to:   'function dealerLines(d){\n  const by={}; /* control mutant */',
    expect: 'survive' },

  // --- missing a dealer who does carry the line
  { name: 'stop indexing the granted lines',
    from: '  for(const s of (d.access||[]))    { const r=row(s); if(r) r.granted=true; }',
    to:   '  for(const s of []) { const r=row(s); if(r) r.granted=true; }' },

  { name: 'stop indexing the lines the dealer actually buys',
    from: '  for(const s of (d.buysLines||[])) { const r=row(s); if(r) r.buys=true; }',
    to:   '  for(const s of []) { const r=row(s); if(r) r.buys=true; }' },

  { name: 'stop indexing the manufacturer account numbers',
    from: '  for(const a of (d.mfrAccounts||[])){ const r=row(a&&a.slug); if(r){ r.ref=String(a.ref||""); r.refActive=a.active!==false; } }',
    to:   '  for(const a of []){ const r=row(a&&a.slug); if(r){ r.ref=String(a.ref||""); r.refActive=a.active!==false; } }' },

  { name: 'leave the lines out of the haystack, so the word filter rejects them',
    from: '  const lineHay=d._lines.map(L=>[L.slug,L.name,L.ref].filter(Boolean).join(" "));',
    to:   '  const lineHay=[];' },

  { name: 'index the slug but not the display name',
    from: '[L.slug,L.name,L.ref].filter(Boolean).join(" ")',
    to:   '[L.slug,L.ref].filter(Boolean).join(" ")' },

  { name: 'stop resolving the display name, leaving only slugs',
    from: 'name:String(MFRNAME[k]||k)',
    to:   'name:String(k)' },

  { name: 'never match a manufacturer at all',
    from: '    for(const L of lines){\n      if(!!L.buys !== buying) continue;',
    to:   '    for(const L of []){\n      if(!!L.buys !== buying) continue;' },

  { name: 'stop matching a later word of the display name',
    from: '      for(const w of L.nameLc.split(/\\s+/)){ if(w.indexOf(q)===0) return {score:s,why:lineWhy(L),mfr:L.name}; }',
    to:   '      ;' },

  { name: 'drop the whole-name prefix, so a multi-word query falls through',
    from: '      if(L.slug.indexOf(q)===0 || L.nameLc.indexOf(q)===0) return {score:s,why:lineWhy(L),mfr:L.name};',
    to:   '      if(L.slug.indexOf(q)===0) return {score:s,why:lineWhy(L),mfr:L.name};' },

  { name: 'stop ranking a buying dealer above an access-only one',
    from: '      const s = buying ? 77 : 76;',
    to:   '      const s = 76;' },

  { name: 'rank an access-only dealer above one that buys the line',
    from: '      const s = buying ? 77 : 76;',
    to:   '      const s = buying ? 76 : 77;' },

  { name: 'drop the buying/access split so the first line wins either way',
    from: '      if(!!L.buys !== buying) continue;',
    to:   '      if(false) continue;' },

  { name: 'drop the mid-word manufacturer fallback',
    from: '    if(L.nameLc.indexOf(q)!==-1 || L.slug.indexOf(q)!==-1 || (L.ref && L.ref.toLowerCase().indexOf(q)!==-1))\n      return {score:48,why:lineWhy(L),mfr:L.name};',
    to:   '    if(false)\n      return {score:48,why:lineWhy(L),mfr:L.name};' },

  { name: 'stop matching the report customer number',
    from: '  for(const a of (d.accounts||[])){ if(String(a).toLowerCase().indexOf(q)!==-1) return {score:25,why:"report ref "+String(a).split(":").slice(1).join(":")}; }',
    to:   '  ;' },

  // --- returning dealers who do NOT carry the line
  { name: 'match a manufacturer anywhere in the haystack instead of on a line',
    from: '  for(const L of lines){ if(L.ref && L.ref.toLowerCase().indexOf(q)===0) return {score:78,why:lineWhy(L),mfr:L.name}; }',
    to:   '  if(d._hay.indexOf(q)!==-1) return {score:78,why:"",mfr:""};' },

  { name: 'let a blank slug become a line',
    from: '  const row=s=>{ const k=String(s||""); if(!k) return null;',
    to:   '  const row=s=>{ const k=String(s||"");' },

  // --- ranking
  { name: 'rank a manufacturer above the dealer\'s own business name',
    from: '  if(n.indexOf(q)===0) return {score:100,why:""};                    // business name starts with query',
    to:   '  if(n.indexOf(q)===0) return {score:1,why:""};' },

  { name: 'rank a manufacturer below a coincidental contact prefix',
    from: '      const s = buying ? 77 : 76;\n      /* The whole name is tested',
    to:   '      const s = buying ? 71 : 70;\n      /* The whole name is tested' },

  // --- the labels a person reads
  { name: 'merge three sources into three separate line rows',
    from: '    if(!by[k]) by[k]={slug:k.toLowerCase(), name:String(MFRNAME[k]||k), granted:false, buys:false, ref:"", refActive:true};',
    to:   '    by[k]={slug:k.toLowerCase(), name:String(MFRNAME[k]||k), granted:false, buys:false, ref:"", refActive:true};' },

  { name: 'call a live account number "access off"',
    from: '  if(L.ref && !L.refActive) bits.push("access off");',
    to:   '  if(L.ref) bits.push("access off");' },

  { name: 'hide that an account sits on a switched-off row',
    from: '  if(L.ref && !L.refActive) bits.push("access off");',
    to:   '  ;' },

  { name: 'label a buying relationship as mere access',
    from: '  else if(L.buys) bits.push("buying");',
    to:   '  else if(false) bits.push("buying");' },

  { name: 'stop reporting which manufacturer matched, so the count cannot name it',
    from: '      for(const w of L.nameLc.split(/\\s+/)){ if(w.indexOf(q)===0) return {score:s,why:lineWhy(L),mfr:L.name}; }',
    to:   '      for(const w of L.nameLc.split(/\\s+/)){ if(w.indexOf(q)===0) return {score:s,why:lineWhy(L)}; }' },

  // --- nothing that worked before regresses
  { name: 'break the existing contact-name search',
    from: '  for(const c of d._cnames){ if(c.toLowerCase().indexOf(q)===0) return {score:72,why:"contact: "+c}; }',
    to:   '  ;' },
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
