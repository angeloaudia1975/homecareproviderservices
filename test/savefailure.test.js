/* What a failed save TELLS you — behaviour suite.
   Loads the real functions out of routes-api.js and dealer.html and runs them.

   The bug this exists for: the Feature button on the dealer handout could not save, and the
   platform said "Couldn't save." The API had been answering, in every single response, that the
   table the pin lives in did not exist — PGRST205, with the table named. Three words on screen
   threw that away, and the button looked broken instead of unconfigured.

   So this suite is not about formatting. It asserts that a reason survives the trip from
   Supabase to the rep's screen, and that a real bug is never dressed up as a missing
   migration (or the reverse). */
const fs = require('fs');
const path = require('path');

const API  = process.env.ROUTES_API  || path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');
const PAGE = process.env.DEALER_HTML || path.join(__dirname, '..', 'src', 'admin', 'dealer.html');
const CAT  = process.env.CATALOG_API || path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');

/* Lift one function out of a source file by name, balancing braces. Nothing is re-typed or
   re-implemented here: a test that runs a copy of the code proves nothing about the code. */
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

function load(apiSrc, pageSrc, catSrc){
  const api  = apiSrc  !== undefined ? apiSrc  : fs.readFileSync(API, 'utf8');
  const page = pageSrc !== undefined ? pageSrc : fs.readFileSync(PAGE, 'utf8');
  const cat  = catSrc  !== undefined ? catSrc  : fs.readFileSync(CAT, 'utf8');
  /* The regexes are consts beside their functions; take the real lines, not copies. */
  const reLine = /const MISSING_TABLE\s*=\s*\/[^\n]*;/.exec(api);
  if(!reLine) throw new Error('MISSING_TABLE not found in routes-api.js');
  const reCat = /const SCHEMA_MISSING\s*=\s*\/[^\n]*;/.exec(cat);
  if(!reCat) throw new Error('SCHEMA_MISSING not found in catalog-api.js');
  const js = reLine[0] + '\n' + lift(api, 'writeFailure') + '\n' + lift(page, 'saveErr') + '\n'
           + reCat[0] + '\n' + lift(cat, 'schemaFailure')
           + '\nmodule.exports = { writeFailure, saveErr, schemaFailure };';
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
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
function ok(v, msg){ if(!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v)); }
function has(hay, needle, what){
  if(String(hay).toLowerCase().indexOf(String(needle).toLowerCase()) < 0)
    throw new Error((what || 'text') + ': ' + JSON.stringify(String(hay)) + ' does not mention ' + JSON.stringify(needle));
}
function hasNot(hay, needle, what){
  if(String(hay).toLowerCase().indexOf(String(needle).toLowerCase()) >= 0)
    throw new Error((what || 'text') + ': ' + JSON.stringify(String(hay)) + ' should not mention ' + JSON.stringify(needle));
}

/* The exact answer Supabase gave for the real bug, verbatim from the live API. */
const REAL_PGRST205 = 'Supabase 404: {"code":"PGRST205","details":null,"hint":"Perhaps you meant the table '
  + '\'public.dealer_handout_exclusions\'","message":"Could not find the table \'public.dealer_handout_feature\''
  + ' in the schema cache"}';

/* The three answers the record-authority switch was refused by, in the order they happened.
   PGRST102 and 42P10 were faults in catalog-api itself; PGRST204 was a migration nobody had run.
   Telling those two classes apart is the entire job of the mapping tested below. */
const REAL_PGRST102 = 'Supabase 400: {"code":"PGRST102","details":null,"hint":null,"message":"All object keys must match"}';
const REAL_42P10    = 'Supabase 400: {"code":"42P10","details":null,"hint":null,"message":"there is no unique or exclusion constraint matching the ON CONFLICT specification"}';
const REAL_PGRST204 = 'Supabase 400: {"code":"PGRST204","details":null,"hint":null,"message":"Could not find the '
  + "'record_authoritative' column of 'manufacturer_meta' in the schema cache\"}";

function run(apiSrc, pageSrc, catSrc){
  const M = load(apiSrc, pageSrc, catSrc);
  pass = 0; fail = 0; out.length = 0;

  /* ---- the server half: an error that names its own cure --------------------- */
  t('the real missing-table error becomes a distinct answer, not an anonymous 500', () => {
    const f = M.writeFailure(new Error(REAL_PGRST205), 'dealer_handout_feature', 'supabase/handout_feature.sql');
    eq(f.code, 503, 'status');
    eq(f.body.error, 'storage_missing', 'error code the page keys off');
    eq(f.body.table, 'dealer_handout_feature', 'table named');
    has(f.body.detail, 'supabase/handout_feature.sql', 'detail names the file to run');
  });

  t('the sentence alone is enough, without the PGRST code', () => {
    // Supabase has reworded these before; either signal must land.
    const f = M.writeFailure(new Error('Supabase 404: Could not find the table \'public.x\''), 'x', 'supabase/x.sql');
    eq(f.code, 503, 'status');
    eq(f.body.error, 'storage_missing', 'matched on the sentence');
  });

  t('the code alone is enough, without the sentence', () => {
    const f = M.writeFailure(new Error('PGRST205'), 'x', 'supabase/x.sql');
    eq(f.code, 503, 'status');
  });

  t('A REAL BUG IS NOT DRESSED UP AS A MISSING MIGRATION', () => {
    /* The dangerous direction. If a constraint violation, a bad column or a timeout came back
       as "run the setup SQL", the fix would be looked for in the wrong place entirely. */
    const cases = [
      'Supabase 400: {"code":"PGRST102","message":"All object keys must match"}',
      'Supabase 409: duplicate key value violates unique constraint',
      'Supabase 500: canceling statement due to statement timeout',
      'fetch failed',
    ];
    for(const c of cases){
      const f = M.writeFailure(new Error(c), 'dealer_handout_feature', 'supabase/handout_feature.sql');
      eq(f.code, 500, 'status for ' + JSON.stringify(c));
      has(f.body.error, c.slice(0, 20), 'the real reason is carried through');
      hasNot(JSON.stringify(f.body), 'storage_missing', 'not mislabelled');
    }
  });

  t('a bare string and an Error are treated the same', () => {
    eq(M.writeFailure(REAL_PGRST205, 't', 'f.sql').code, 503, 'string');
    eq(M.writeFailure(new Error(REAL_PGRST205), 't', 'f.sql').code, 503, 'Error');
  });

  t('an empty failure still says something', () => {
    const f = M.writeFailure(undefined, 't', 'f.sql');
    eq(f.code, 500, 'status');
    if(!String(f.body.error || '').trim()) throw new Error('empty error text reaches the page');
  });

  t('each caller names its own table and file', () => {
    const a = M.writeFailure(new Error('PGRST205'), 'dealer_handout_feature', 'supabase/handout_feature.sql');
    const b = M.writeFailure(new Error('PGRST205'), 'dealer_handout_exclusions', 'supabase/dealer_handout_exclusions.sql');
    eq([a.body.table, b.body.table], ['dealer_handout_feature', 'dealer_handout_exclusions'], 'tables');
    has(b.body.detail, 'dealer_handout_exclusions.sql', 'exclusions file');
  });

  /* ---- the page half: the sentence the rep reads ----------------------------- */
  t('THE WHOLE POINT — the rep is told what to run, not "Couldn\'t save."', () => {
    const f = M.writeFailure(new Error(REAL_PGRST205), 'dealer_handout_feature', 'supabase/handout_feature.sql');
    const shown = M.saveErr(f.body, 'feature a line');
    has(shown, 'handout_feature.sql', 'names the setup file');
    hasNot(shown, "Couldn't save", 'no longer the generic message');
  });

  t('a permission refusal is put in the rep\'s words, using the verb it was given', () => {
    eq(M.saveErr({ error: 'not your account' }, 'feature a line'),
       'You can only feature a line on your own accounts.', 'feature');
    eq(M.saveErr({ error: 'not your account' }, 'exclude a line'),
       'You can only exclude a line on your own accounts.', 'exclude');
  });

  t('an older deploy that sends no detail still gets a useful sentence', () => {
    // storage_missing without detail, and the raw Supabase text with no mapping at all.
    has(M.saveErr({ error: 'storage_missing' }, 'feature a line'), 'setup', 'code only');
    has(M.saveErr({ error: REAL_PGRST205 }, 'feature a line'), 'setup', 'raw supabase text');
  });

  t('an expired sign-in says so, instead of looking like a broken button', () => {
    has(M.saveErr({ error: 'unauthorized' }, 'feature a line'), 'sign in again', 'unauthorized');
    has(M.saveErr(new Error('HTTP 401'), 'feature a line'), 'sign in again', '401');
  });

  t('AN UNRECOGNISED REASON IS SHOWN, NOT SWALLOWED', () => {
    /* This is the property that made the original bug invisible. Anything we have no mapping
       for must still reach the screen verbatim. */
    const shown = M.saveErr({ error: 'Supabase 409: duplicate key value violates unique constraint' }, 'feature a line');
    has(shown, 'duplicate key', 'the real reason survives');
  });

  t('a thrown network error reaches the screen too', () => {
    has(M.saveErr(new TypeError('Failed to fetch'), 'feature a line'), 'Failed to fetch', 'offline');
  });

  t('no reason at all never produces a blank or a dangling sentence', () => {
    for(const r of [null, undefined, {}, { ok: false }, { error: '' }]){
      const s = M.saveErr(r, 'feature a line');
      if(!s || !s.trim()) throw new Error('blank message for ' + JSON.stringify(r));
      if(/—\s*\.?$/.test(s.trim())) throw new Error('dangling sentence for ' + JSON.stringify(r) + ': ' + s);
    }
  });

  t('a wall of server text is trimmed to something readable', () => {
    const s = M.saveErr({ error: 'x'.repeat(4000) }, 'feature a line');
    if(s.length > 200) throw new Error('message is ' + s.length + ' chars — it sits on one line beside a button');
  });

  t('a detail written for a person wins over our own mapping', () => {
    /* The API knows more about the failure than the page does. When it writes a sentence, that
       sentence is what shows — otherwise improving the server message would have no effect. */
    eq(M.saveErr({ error: 'storage_missing', detail: 'Run supabase/handout_feature.sql, then try again.' }, 'feature a line'),
       'Run supabase/handout_feature.sql, then try again.', 'detail verbatim');
  });

  t('a blank detail does not shadow the reason underneath it', () => {
    has(M.saveErr({ error: 'not your account', detail: '   ' }, 'feature a line'), 'your own accounts', 'falls through');
  });

  /* ---- the catalog side: a missing COLUMN, which is the same lesson again ----- */
  t('THE THIRD REFUSAL — a missing column names the migration to run', () => {
    const f = M.schemaFailure(new Error(REAL_PGRST204), 'supabase/record_authority.sql');
    eq(f.code, 503, 'status');
    eq(f.body.error, 'schema_missing', 'error code');
    has(f.body.detail, 'supabase/record_authority.sql', 'names the file');
    has(f.body.supabase, 'record_authoritative', 'keeps what Supabase actually said');
  });

  t('a missing table is caught by the same mapping', () => {
    ok(M.schemaFailure(new Error("Could not find the table 'public.x' in the schema cache"), 'f.sql'),
      'PGRST205-shaped message');
    ok(M.schemaFailure(new Error('PGRST205'), 'f.sql'), 'code alone');
    ok(M.schemaFailure(new Error('PGRST204'), 'f.sql'), 'column code alone');
  });

  t('WITH NO FILE TO NAME, SUPABASE\'S OWN WORDS ARE PASSED THROUGH', () => {
    /* The mirror reads tables three migrations create between them. Guessing which one is
       missing would be worse than saying nothing — but the message already names it. */
    const f = M.schemaFailure(new Error(REAL_PGRST204));
    eq(f.body.setup, null, 'no file claimed');
    has(f.body.detail, 'record_authoritative', 'the missing thing is still named');
  });

  t('THE TWO REAL BUGS ARE NOT CALLED MISSING MIGRATIONS', () => {
    /* PGRST102 and 42P10 were both faults in catalog-api. If either had been reported as "run
       the setup SQL", the fix would have been looked for in the database and never found. */
    eq(M.schemaFailure(new Error(REAL_PGRST102), 'f.sql'), null, 'PGRST102 passes through');
    eq(M.schemaFailure(new Error(REAL_42P10), 'f.sql'), null, '42P10 passes through');
    eq(M.schemaFailure(new Error('duplicate key value violates unique constraint'), 'f.sql'), null, 'constraint');
    eq(M.schemaFailure(new Error('fetch failed'), 'f.sql'), null, 'network');
    eq(M.schemaFailure(undefined, 'f.sql'), null, 'nothing at all');
  });

  t('the page turns a schema failure into the same sentence as everything else', () => {
    // End to end: catalog-api's answer, rendered by the page the rep is looking at.
    const f = M.schemaFailure(new Error(REAL_PGRST204), 'supabase/record_authority.sql');
    has(M.saveErr(f.body, 'switch authority'), 'record_authority.sql', 'reaches the screen');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, load, lift, API, PAGE, CAT, REAL_PGRST205, REAL_PGRST204, REAL_42P10 };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
