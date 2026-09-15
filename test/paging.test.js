/* Paged Supabase reads — behaviour suite.
   Lifts the real sbGetAll out of routes-api.js and drives it with a stub sbGet, so
   the paging loop is exercised without a network.

   PostgREST returns at most 1000 rows and reports nothing about having stopped. An
   eight-stop visit package printed 12-22% of each dealer's real lifetime sales and
   looked completely normal doing it. Anything that quietly returns "most of the
   rows" is the same bug again. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.ROUTES_API
  || path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');

function lift(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const anchor = 'async function sbGetAll(';
  const at = js.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: sbGetAll');
  if(js.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: sbGetAll');
  let i = js.indexOf(')', at); i = js.indexOf('{', i);
  let d = 0, end = -1;
  for(let j = i; j < js.length; j++){
    if(js[j] === '{') d++;
    else if(js[j] === '}'){ d--; if(d === 0){ end = j; break; } }
  }
  if(end < 0) throw new Error('unbalanced sbGetAll');
  const mod = { exports: {} };
  new Function('module', 'exports', 'setGet',
    'let sbGet;\n' + js.slice(at, end + 1)
    + '\n;module.exports={sbGetAll, _set:f=>{sbGet=f;}};')(mod, mod.exports);
  return mod.exports;
}

let pass = 0, fail = 0;
const out = [];
const todo = [];
function t(name, fn){ todo.push([name, fn]); }
async function drain(){
  for(const [name, fn] of todo){
    try { await fn(); pass++; out.push('  ok   ' + name); }
    catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); }
  }
  todo.length = 0;
}
function eq(a, b, what){
  if(JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}

/* A fake table of n rows that answers exactly as PostgREST does.
   The call budget is what makes a runaway loop FAIL rather than hang: a mutant that
   forgets to advance the offset would otherwise page for ever, and a test suite that
   hangs tells you nothing. Twelve pages is the largest a real read needs here. */
function server(n, budget){
  const calls = [];
  const get = async p => {
    calls.push(p);
    if(calls.length > (budget || 50))
      throw new Error('runaway: ' + calls.length + ' pages requested');
    const lim = Number((/[?&]limit=(\d+)/.exec(p) || [])[1] || 1000);
    const off = Number((/[?&]offset=(\d+)/.exec(p) || [])[1] || 0);
    const rows = [];
    for(let i = off; i < Math.min(n, off + lim); i++) rows.push({ id: i });
    return rows;
  };
  return { get, calls };
}

async function run(src){
  const M = lift(src);
  pass = 0; fail = 0; out.length = 0;

  /* ---- THE ONE THAT COST THE NUMBERS ------------------------------------- */
  t('a table larger than one page comes back whole', async () => {
    const s = server(11985);            // the real monthly_sales row count
    M._set(s.get);
    const rows = await M.sbGetAll('monthly_sales?select=id&order=id');
    eq(rows.length, 11985, 'rows');
    eq(rows[0].id, 0, 'first');
    eq(rows[11984].id, 11984, 'last');
    eq(s.calls.length, 12, 'pages fetched');
  });

  t('every row appears exactly once, in order', async () => {
    const s = server(2500);
    M._set(s.get);
    const rows = await M.sbGetAll('t?order=id');
    eq(rows.map(r => r.id).every((v, i) => v === i), true, 'no gaps, no repeats');
  });

  /* ---- page boundaries ---------------------------------------------------- */
  t('a table smaller than one page takes a single call', async () => {
    const s = server(117);              // Glasgow's own sales rows
    M._set(s.get);
    eq((await M.sbGetAll('t?order=id')).length, 117, 'rows');
    eq(s.calls.length, 1, 'calls');
  });

  t('an exact multiple of the page size is not cut short', async () => {
    /* The classic off-by-one: 1000 rows look like "there may be more", and 2000
       look like two full pages. Both must terminate with everything. */
    const s = server(1000);
    M._set(s.get);
    eq((await M.sbGetAll('t?order=id')).length, 1000, 'exactly one page');
    eq(s.calls.length, 2, 'needs the empty second page to know it is done');
    const s2 = server(2000);
    M._set(s2.get);
    eq((await M.sbGetAll('t?order=id')).length, 2000, 'exactly two pages');
  });

  t('an empty table is an empty list, not a failure', async () => {
    const s = server(0);
    M._set(s.get);
    eq(await M.sbGetAll('t?order=id'), [], 'rows');
    eq(s.calls.length, 1, 'calls');
  });

  /* ---- the query it builds ------------------------------------------------ */
  t('limit and offset are appended with the right separator', async () => {
    const s = server(1);
    M._set(s.get);
    await M.sbGetAll('monthly_sales?dealer_id=in.(a,b)&order=id');
    eq(/\?dealer_id=in\.\(a,b\)&order=id&limit=1000&offset=0$/.test(s.calls[0]), true,
       'existing query string: ' + s.calls[0]);
    const s2 = server(1);
    M._set(s2.get);
    await M.sbGetAll('dealers');
    eq(/^dealers\?limit=1000&offset=0$/.test(s2.calls[0]), true,
       'no query string: ' + s2.calls[0]);
  });

  t('the offset advances by a full page each time', async () => {
    const s = server(2500);
    M._set(s.get);
    await M.sbGetAll('t?order=id');
    eq(s.calls.map(p => Number(/offset=(\d+)/.exec(p)[1])), [0, 1000, 2000], 'offsets');
  });

  /* ---- the safety valve --------------------------------------------------- */
  t('a runaway read stops at the cap instead of looping for ever', async () => {
    const s = server(1e9);
    M._set(s.get);
    const rows = await M.sbGetAll('t?order=id', 3000);
    eq(rows.length, 3000, 'rows');
    eq(s.calls.length, 3, 'calls');
  });

  t('a null page is treated as the end, not as a crash', async () => {
    let n = 0;
    M._set(async () => (n++ === 0 ? null : []));
    eq(await M.sbGetAll('t?order=id'), [], 'rows');
  });

  t('an error is raised, never swallowed into a short answer', async () => {
    /* Returning what we have so far would be indistinguishable from a small table,
       which is precisely the failure this function exists to remove. */
    M._set(async () => { throw new Error('Supabase 503'); });
    let threw = false;
    try { await M.sbGetAll('t?order=id'); } catch(e){ threw = /503/.test(e.message); }
    eq(threw, true, 'threw');
  });

  await drain();
  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, lift, SRC };

if(require.main === module){
  run().then(r => {
    console.log(r.report);
    console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
    process.exit(r.fail ? 1 : 0);
  });
}
