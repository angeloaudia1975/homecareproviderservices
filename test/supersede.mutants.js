/* Mutation harness for the supersession work. Every anchor must occur exactly
   once. CONTROL is a genuine no-op and must SURVIVE; if it dies the harness is
   failing everything and no other result means anything. */
const fs = require('fs');
const { SRC } = require('./lift');
const suite = require('./supersede.test');

const src = fs.readFileSync(SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '  const rows = [], refused = [];',
    to:   '  const rows = [], refused = []; /* control mutant */',
    expect: 'survive' },

  { name: 'stop capturing the pointer on a dead group',
    from: '      const pointer = members.map(m => m.merged_into).find(Boolean);',
    to:   '      const pointer = null;' },

  { name: 'call every supersession a same-code twin',
    from: '          same_code: norm(pointer) === key',
    to:   '          same_code: true' },

  { name: 'call every supersession cross-code',
    from: '          same_code: norm(pointer) === key',
    to:   '          same_code: false' },

  { name: 'stop checking the replacement survived',
    from: '    if(!liveNorm.has(to)){',
    to:   '    if(false){' },

  { name: 'stop checking the dead code is not itself live',
    from: "    if(liveNorm.has(from)){\n      refused.push({ code:s.code, superseded_by:s.superseded_by,",
    to:   "    if(false){\n      refused.push({ code:s.code, superseded_by:s.superseded_by," },

  { name: 'let a record supersede itself in another spelling',
    from: '    if(from === to) return;                       // a spelling twin, not a replacement',
    to:   '    if(false) return;' },


  { name: 'stop tombstoning a code with no successor',
    from: "    if(!from || taken.has(from)) return;",
    to:   "    if(true) return;" },

  { name: 'tombstone a superseded code a second time',
    from: "  const taken = new Set();                        // one row per part number, whichever route it came by",
    to:   "  const taken = { has:()=>false, add:()=>{} };" },

  { name: 'give an orphan tombstone a pointer it does not have',
    from: "    rows.push({ manufacturer, code:s.code, superseded_by:null,",
    to:   "    rows.push({ manufacturer, code:s.code, superseded_by:s.code,",
  },

  { name: 'leave an orphan tombstone active',
    from: '                status:"discontinued", status_note:"discontinued — no replacement",',
    to:   '                status:"active", status_note:"discontinued — no replacement",' },

  { name: 'tombstone a skipped code that is actually live',
    from: "    if(liveNorm.has(from)){\n      refused.push({ code:s.code, superseded_by:null,",
    to:   "    if(false){\n      refused.push({ code:s.code, superseded_by:null," },

  { name: 'compare codes raw instead of normalised',
    from: '  const key = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");\n  const liveNorm =',
    to:   '  const key = c => String(c == null ? "" : c);\n  const liveNorm =' },

  { name: 'give the tombstone a price after all',
    from: '    rows.push({ manufacturer, code:s.code, superseded_by:s.superseded_by,',
    to:   '    rows.push({ base_price: 0, manufacturer, code:s.code, superseded_by:s.superseded_by,' },

  { name: 'leave the tombstone active',
    from: '                status:"discontinued", status_note:"superseded by " + s.superseded_by,',
    to:   '                status:"active", status_note:"superseded by " + s.superseded_by,' },
];

let bad = 0;
console.log('mutant                                                    anchors  result');
console.log('-'.repeat(78));

for(const m of MUTANTS){
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(56) + String(hits).padStart(6) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
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
  console.log(m.name.padEnd(56) + String(hits).padStart(6) + '   ' + verdict);
}

console.log('-'.repeat(78));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
