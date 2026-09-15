/* Mutation harness for the dealer handout.

   Every mutant here is a version of the sheet that still renders, still looks like a handout, and
   is wrong in someone's hand: a logo back at its old size, a manufacturer printing as an empty
   rectangle, the momentum table back on page 1 pushing CardChamp off it, a card torn across the
   page boundary. None of them would throw.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must SURVIVE; if it dies
   the harness is failing everything. */
const fs = require('fs');
const suite = require('./handout.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '      .tiles{display:flex;flex-wrap:wrap;gap:5px;margin:2px 0}',
    to:   '      /* control */\n      .tiles{display:flex;flex-wrap:wrap;gap:5px;margin:2px 0}',
    expect: 'survive' },

  // --- the logos go back to being hard to read across a counter
  { name: 'put the tile logos back to their old height',
    from: '.ltile img{max-height:68px;max-width:240px',
    to:   '.ltile img{max-height:34px;max-width:240px' },

  { name: 'put the tile logos back to their old width',
    from: '.ltile img{max-height:68px;max-width:240px',
    to:   '.ltile img{max-height:68px;max-width:120px' },

  { name: 'narrow the tile so a 2x logo cannot fit in it',
    from: 'padding:5px 8px;min-width:150px;min-height:68px',
    to:   'padding:5px 8px;min-width:96px;min-height:68px' },

  { name: 'drop the tile\'s minimum height, so a name-only tile is short',
    from: 'padding:5px 8px;min-width:150px;min-height:68px',
    to:   'padding:5px 8px;min-width:150px' },

  // --- a tile prints as an empty rectangle
  { name: 'HIDE THE NAME ON EVERY TILE, so a manufacturer with no logo prints blank',
    from: '.ltile .ln{font-size:10.5px;line-height:1.15;color:#333c47;font-weight:600}',
    to:   '.ltile .ln{display:none}' },

  { name: 'mark every tile as having a logo, whether it has one or not',
    from: '${x.logo?" haslogo":""}',
    to:   '${" haslogo"}' },

  { name: 'stop emitting the name at all — the old logo-only shortcut',
    from: '<span class="ln">${esc(x.name)}</span>',
    to:   '${""}' },

  { name: 'let a broken logo hide itself and leave the tile empty',
    from: "onerror=\"this.style.display='none';this.parentNode.classList.remove('haslogo')\"",
    to:   "onerror=\"this.style.display='none'\"" },

  // --- the page the reader is holding
  { name: 'stop forcing What\'s new onto its own page',
    from: '      .p2{break-before:page;page-break-before:always}',
    to:   '      .p2{}' },

  { name: 'put the momentum table back on page 1, which pushes CardChamp off it',
    from: '        ${cardchampHtml}\n        <div class="p2">',
    to:   '        ${activityHtml}${cardchampHtml}\n        <div class="p2">' },

  { name: 'move CardChamp onto page 2 with the rest',
    from: '        ${cardchampHtml}\n        <div class="p2">',
    to:   '        <div class="p2">\n        ${cardchampHtml}' },

  { name: 'let a card tear across the page boundary',
    from: '      .cc,.cross,.ltile,.repcard,.stat{break-inside:avoid;page-break-inside:avoid}',
    to:   '      .repcard,.stat{break-inside:avoid;page-break-inside:avoid}' },

  { name: 'let a heading print alone at the foot of a page',
    from: 'padding-bottom:3px;break-after:avoid;page-break-after:avoid}',
    to:   'padding-bottom:3px}' },

  { name: 'leave the printer margins to the browser',
    from: '      @page{size:letter;margin:0.3in 0.38in}',
    to:   '      @page{size:letter}' },

  // --- the quiet ones
  { name: 'stop escaping the dealer\'s own name',
    from: 'var esc=function(s){return String(s==null?"":s).replace(/[&<>"]/g,',
    to:   'var esc=function(s){return String(s==null?"":s).replace(/[\\u0000]/g,' },

  { name: 'drop the print trigger, so the sheet opens but never prints',
    from: 'window.onload=function(){window.print();}',
    to:   'window.onload=function(){}' },
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
  const ok = survived === wantSurvive;
  if(!ok) bad++;

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
