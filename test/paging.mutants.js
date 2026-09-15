/* Mutation harness for the paged Supabase read.

   Every failure here is silent by construction. A short answer is indistinguishable
   from a small table, a repeated page inflates a total, and a skipped page deflates
   one — none of them raise anything, and all of them print a plausible dollar figure
   on a sheet a rep hands to a dealer.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must
   SURVIVE; if it dies the harness is failing everything. */
const fs = require('fs');
const suite = require('./paging.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '  let out=[], from=0;',
    to:   '  let out=[], from=0; /* control mutant */',
    expect: 'survive' },

  // --- returning less than everything
  { name: 'stop after the first page, which is the bug itself',
    from: '    if(!rows||rows.length<1000) break;',
    to:   '    break;' },

  { name: 'stop one page early on an exact multiple of the page size',
    from: '    if(!rows||rows.length<1000) break;',
    to:   '    if(!rows||rows.length<=1000) break;' },

  { name: 'throw away everything but the last page',
    from: '    out=out.concat(rows||[]);',
    to:   '    out=(rows||[]);' },

  // --- returning more, or the wrong rows
  { name: 'never advance the offset, so page one repeats for ever',
    from: '    from+=1000;',
    to:   '    ;' },

  { name: 'advance the offset by one row, duplicating almost every row',
    from: '    from+=1000;',
    to:   '    from+=1;' },

  { name: 'skip a row at every page boundary',
    from: '    from+=1000;',
    to:   '    from+=1001;' },

  { name: 'ask for a page size the offset arithmetic does not match',
    from: '    const rows=await sbGet(`${path}${sep}limit=1000&offset=${from}`);',
    to:   '    const rows=await sbGet(`${path}${sep}limit=500&offset=${from}`);' },

  // --- the URL it builds
  { name: 'always use ? so an existing query string is destroyed',
    from: '  const sep=path.indexOf("?")>=0?"&":"?";',
    to:   '  const sep="?";' },

  { name: 'always use & so a bare table name gets a malformed query',
    from: '  const sep=path.indexOf("?")>=0?"&":"?";',
    to:   '  const sep="&";' },

  // --- the safety valve
  { name: 'remove the runaway cap',
    from: '    if(from>=max) break;',
    to:   '    ;' },

  { name: 'ignore the caller\'s cap and use the default',
    from: '  const max=cap||100000;',
    to:   '  const max=100000;' },

  // --- swallowing a failure
  { name: 'return what we have instead of raising, so an outage looks like a small table',
    from: '    const rows=await sbGet(`${path}${sep}limit=1000&offset=${from}`);',
    to:   '    let rows; try{ rows=await sbGet(`${path}${sep}limit=1000&offset=${from}`); }catch(e){ break; }' },
];

let bad = 0;
(async () => {
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
    try {
      r = await Promise.race([
        suite.run(mutated),
        new Promise(res => setTimeout(() => res({ pass: 0, fail: -1, report: 'timed out — probably an endless loop' }), 5000)),
      ]);
    } catch(e){ r = { pass: 0, fail: -1, report: 'threw: ' + e.message }; }

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
})();
