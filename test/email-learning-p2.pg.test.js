/* HCPS Smart Email Learning, Phase 2 — supabase/email_learning_p2_rules.sql in a REAL Postgres (synthetic data only), on top of
   Phase 1: install checks; RULE 19; the guard refuses every write that is not one of the functions (owner included, server role
   with a forged marker included); a suggestion needs 3 sends across 2 dealers; the analyser never changes a rule's status or
   wording; only the ACTIVE President decides, with a reason, from the current version (stale screens refused, simultaneous
   decisions serialised); every change of the approved set is a numbered version; rollback / reset restore exactly; versions and
   events are insert-only; a second run is safe; rollback of the migration refuses with rows and leaves Phase 1 alone.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/email-learning-p2.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_el2_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const P1 = path.join(__dirname, '..', 'supabase', 'email_learning_p1_capture.sql');
const SQL = process.env.EL2_SQL || path.join(__dirname, '..', 'supabase', 'email_learning_p2_rules.sql');
const RB = path.join(__dirname, '..', 'supabase', 'email_learning_p2_rules_rollback.sql');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 2).join(' | ')); } }
const q = sql => run(DB, sql);
const as = (role, sql) => run(DB, `set role ${role}; ${sql}`);
const refused = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('refused for another reason: ' + e.message.split('\n')[0]); return; } throw new Error('expected a refusal'); };
const lit = o => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const call = (fn, o) => JSON.parse(as('service_role', `select public.${fn}(${lit(o)})::text`));
const PRES = 'owner@hcps.test', REP = 'rep@hcps.test', GONE = 'former@hcps.test';
const key = n => (n.toString(16) + '0'.repeat(32)).slice(0, 32).replace(/[^0-9a-f]/g, 'a');
const note = (n, o) => call('hcps_email_rule_note', Object.assign({ rule_key: key(n), pattern_key: key(n + 500), email_type: 'previsit_headsup', kind: 'remove_phrase',
  pattern: { phrase: 'I hope this email finds you well' }, instruction: 'Don\'t write “I hope this email finds you well”.',
  examples: ['− I hope this email finds you well'], sends: 3, dealers: 2, first_seen: '2026-10-01T10:00:00Z', last_seen: '2026-10-20T10:00:00Z' }, o || {}));
const ver = () => +as('service_role', 'select public.hcps_email_rule_version()');
const decide = o => call('hcps_email_rule_decide', Object.assign({ by: PRES, reason: 'Matches how I write', expected_version: ver() }, o));
const ruleOf = id => JSON.parse(q(`select row_to_json(r)::text from public.email_learning_rules r where id = '${id}'`));

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  q(`do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$`);
  q(`alter role service_role bypassrls`);
  q(`create table app_settings (key text primary key, value jsonb); insert into app_settings values ('phase2_flags','{"email_learning_capture":true}')`);
  q(`create table staff_users (email text primary key, role text, active boolean, name text);
     insert into staff_users values ('${PRES}','president',true,'Owner'),('${REP}','rep',true,'Rep'),('${GONE}','president',false,'Former')`);
  q(`grant usage on schema public to anon, authenticated, service_role`);

  t('Phase 2 refuses to install without Phase 1', () => { refused(() => file(DB, SQL), /install Phase 1/); });
  file(DB, P1);

  t('install: every check ok', () => {
    const out = file(DB, SQL).trim().split('\n').filter(l => /^\d+\|/.test(l));
    assert.strictEqual(out.length, 8, out.join('\n'));
    for (const l of out) assert.ok(/\|t$/.test(l), 'check ' + l);
  });
  t('the static safe-update rule: every UPDATE carries a WHERE clause; no DELETE statement', () => {
    const src = fs.readFileSync(SQL, 'utf8').replace(/--[^\n]*/g, '');
    const updates = src.split(/;\s*/).filter(s => /\bupdate\s+public\./i.test(s));
    assert.ok(updates.length >= 3); for (const u of updates) assert.ok(/\bwhere\b/i.test(u), u.slice(0, 120));
    assert.ok(!/\bdelete\s+from\b/i.test(src));
  });
  t('RULE 19: anon and authenticated reach no table and no function', () => {
    for (const r of ['anon', 'authenticated']) {
      for (const tb of ['email_learning_rules', 'email_learning_profiles', 'email_learning_rule_events']) refused(() => as(r, `select count(*) from public.${tb}`), /permission denied/);
      for (const f of ['hcps_email_rule_note', 'hcps_email_rule_decide', 'hcps_email_profile_rollback']) refused(() => as(r, `select public.${f}('{}'::jsonb)`), /permission denied/);
      refused(() => as(r, 'select public.hcps_email_rule_version()'), /permission denied/);
    }
  });
  t('the server role reads, but cannot write a table or call the helpers', () => {
    assert.strictEqual(as('service_role', 'select count(*) from public.email_learning_rules'), '0');
    refused(() => as('service_role', `insert into public.email_learning_rules (rule_key, email_type, kind, pattern, instruction, suggested_instruction, sends, dealers)
      values ('${key(99)}','all','shorter','{}','Keep it shorter.','Keep it shorter.',3,2)`), /permission denied/);
    refused(() => as('service_role', `select public.hcps_email_rule_president('${PRES}')`), /permission denied/);
    refused(() => as('service_role', `select public.hcps_email_rule_snapshot()`), /permission denied/);
  });
  t('the guard: the owner without a marker and the server role with a forged marker are both refused', () => {
    refused(() => q(`insert into public.email_learning_rules (rule_key, email_type, kind, pattern, instruction, suggested_instruction, sends, dealers)
      values ('${key(98)}','all','shorter','{}','Keep it shorter.','Keep it shorter.',3,2)`), /email_rule_guard/);
    refused(() => q(`insert into public.email_learning_profiles (version, created_by, action, reason, rules) values (1,'x','approve','why','[]')`), /email_rule_guard/);
    refused(() => as('service_role', `select set_config('hcps.email_rule_op','note',false); insert into public.email_learning_rules (rule_key, email_type, kind, pattern, instruction, suggested_instruction, sends, dealers)
      values ('${key(97)}','all','shorter','{}','Keep it shorter.','Keep it shorter.',3,2)`), /permission denied|email_rule_guard/);
  });

  let A, B, C;
  t('a suggestion needs 3 sends across 2 dealers (checked in the database)', () => {
    assert.strictEqual(note(1, { sends: 2, dealers: 2 }).status, 'below_threshold');
    assert.strictEqual(note(1, { sends: 5, dealers: 1 }).status, 'below_threshold');
    assert.strictEqual(q('select count(*) from public.email_learning_rules'), '0');
    const r = note(1); assert.strictEqual(r.status, 'inserted'); A = r.id;
    assert.strictEqual(ruleOf(A).status, 'suggested');
    assert.strictEqual(q(`select action || '/' || by_email from public.email_learning_rule_events where rule_id = '${A}'`), 'suggested/system:email-learning');
  });
  t('the same evidence again changes nothing; more evidence updates only the counts and examples', () => {
    assert.strictEqual(note(1).status, 'unchanged');
    const r = note(1, { sends: 6, dealers: 3, examples: ['− I hope this email finds you well', '− I hope you are well'] });
    assert.strictEqual(r.status, 'updated');
    const x = ruleOf(A); assert.strictEqual(x.sends, 6); assert.strictEqual(x.dealers, 3); assert.strictEqual(x.status, 'suggested');
    assert.strictEqual(note(1, { sends: 4, dealers: 2, examples: ['− I hope this email finds you well', '− I hope you are well'] }).status, 'unchanged', 'counts never go down');
    assert.strictEqual(ruleOf(A).sends, 6);
  });
  t('the same edit under another email type is never a new rule (a decided edit is never suggested again in another scope)', () => {
    assert.strictEqual(note(8, { pattern_key: key(501), email_type: 'all' }).status, 'sibling_exists');
    assert.strictEqual(q(`select count(*) from public.email_learning_rules where pattern_key = '${key(501)}'`), '1');
  });
  t('bad input answers a status, never an error', () => {
    assert.strictEqual(note(9, { dealers: null }).status, 'below_threshold');
    assert.strictEqual(note(9, { sends: 'many' }).status, 'bad_request');
    assert.strictEqual(call('hcps_email_rule_decide', { rule_id: A, decision: 'approve', by: PRES, reason: 'Fine by me', expected_version: 'x' }).status, 'version_conflict');
    assert.strictEqual(call('hcps_email_profile_rollback', { to_version: 'x', by: PRES, reason: 'Fine by me', expected_version: 0 }).status, 'not_found');
  });
  t('non-identifying evidence: a pattern or example holding a digit or "@" is refused', () => {
    refused(() => note(2, { pattern: { phrase: 'Call me at 615 555 0100' } }), /masked_ck/);
    refused(() => note(3, { examples: ['− write to pat@example.test'] }), /masked_ck/);
    refused(() => note(4, { instruction: 'Write to pat@example.test.' }), /masked_ck/);
  });
  B = note(5, { kind: 'greeting', pattern: { from: 'Hi {name}', to: 'Good morning {name}' }, instruction: 'Open with “Good morning {name}”.', examples: [] }).id;
  C = note(6, { email_type: 'all', kind: 'shorter', pattern: {}, instruction: 'Keep it shorter — you usually cut about 30% of the draft.', examples: [] }).id;

  t('decisions: only the ACTIVE President, with a reason, from the current version', () => {
    assert.strictEqual(decide({ rule_id: A, decision: 'approve', by: REP }).status, 'president_only');
    assert.strictEqual(decide({ rule_id: A, decision: 'approve', by: GONE }).status, 'president_only');
    assert.strictEqual(decide({ rule_id: A, decision: 'approve', reason: ' ' }).status, 'reason_required');
    assert.strictEqual(decide({ rule_id: A, decision: 'approve', expected_version: 7 }).status, 'version_conflict');
    assert.strictEqual(decide({ rule_id: '00000000-0000-4000-8000-000000000000', decision: 'approve' }).status, 'not_found');
    assert.strictEqual(ver(), 0);
  });
  t('approve → version 1 holding exactly that rule; the President is recorded', () => {
    const r = decide({ rule_id: A, decision: 'approve' });
    assert.strictEqual(r.status, 'decided'); assert.strictEqual(r.version, 1);
    const p = JSON.parse(q(`select row_to_json(p)::text from public.email_learning_profiles p where version = 1`));
    assert.strictEqual(p.action, 'approve'); assert.strictEqual(p.created_by, PRES); assert.deepStrictEqual(p.rules.map(x => x.id), [A]);
    assert.strictEqual(ruleOf(A).decided_by, PRES);
  });
  t('reject a suggestion: no new version; a rejected rule cannot be rejected or retired again', () => {
    assert.strictEqual(decide({ rule_id: B, decision: 'reject' }).version, 1);
    assert.strictEqual(ruleOf(B).status, 'rejected');
    assert.strictEqual(decide({ rule_id: B, decision: 'retire' }).status, 'not_allowed');
    assert.strictEqual(decide({ rule_id: A, decision: 'reject' }).status, 'not_allowed', 'an approved rule is retired, not rejected');
  });
  t('the analyser never changes the status or wording of a decided rule', () => {
    note(1, { sends: 9, dealers: 4, instruction: 'Never say “I hope this email finds you well”.' });
    const x = ruleOf(A); assert.strictEqual(x.status, 'approved'); assert.strictEqual(x.instruction, 'Don\'t write “I hope this email finds you well”.');
    assert.strictEqual(x.suggested_instruction, 'Never say “I hope this email finds you well”.'); assert.strictEqual(x.sends, 9);
    note(5, { kind: 'greeting', pattern: { from: 'Hi {name}', to: 'Good morning {name}' }, sends: 8, dealers: 3, instruction: 'Open with “Good morning {name}”.', examples: [] });
    assert.strictEqual(ruleOf(B).status, 'rejected', 'a rejected rule is never suggested again');
  });
  t('edit wording → version 2; the same wording is not a change; an "@" is refused', () => {
    assert.strictEqual(decide({ rule_id: A, decision: 'edit', instruction: 'Skip “I hope this email finds you well” — get to the point.' }).version, 2);
    assert.strictEqual(decide({ rule_id: A, decision: 'edit', instruction: 'Skip “I hope this email finds you well” — get to the point.' }).status, 'not_allowed');
    assert.strictEqual(decide({ rule_id: A, decision: 'edit', instruction: 'Write to me at x@y.test' }).status, 'bad_instruction');
  });
  t('approve a second rule → version 3 holds both; retire → version 4 holds one', () => {
    assert.strictEqual(decide({ rule_id: C, decision: 'approve' }).version, 3);
    assert.strictEqual(+q(`select jsonb_array_length(rules) from public.email_learning_profiles where version = 3`), 2);
    assert.strictEqual(decide({ rule_id: A, decision: 'retire' }).version, 4);
    assert.deepStrictEqual(JSON.parse(q(`select rules::text from public.email_learning_profiles where version = 4`)).map(x => x.id), [C]);
  });
  t('rollback to version 2: exactly its rules, with its wording; the others retired', () => {
    const r = call('hcps_email_profile_rollback', { to_version: 2, by: PRES, reason: 'Back to before', expected_version: ver() });
    assert.strictEqual(r.status, 'rolled_back'); assert.strictEqual(r.version, 5);
    assert.strictEqual(ruleOf(A).status, 'approved'); assert.strictEqual(ruleOf(A).instruction, 'Skip “I hope this email finds you well” — get to the point.');
    assert.strictEqual(ruleOf(C).status, 'retired');
    assert.deepStrictEqual(JSON.parse(q(`select rules::text from public.email_learning_profiles where version = 5`)),
      JSON.parse(q(`select rules::text from public.email_learning_profiles where version = 2`)));
    assert.strictEqual(q(`select from_version || '/' || action from public.email_learning_profiles where version = 5`), '2/rollback');
  });
  t('rollback guards: stale version, current or unknown version, non-President', () => {
    assert.strictEqual(call('hcps_email_profile_rollback', { to_version: 1, by: PRES, reason: 'x y z', expected_version: 1 }).status, 'version_conflict');
    assert.strictEqual(call('hcps_email_profile_rollback', { to_version: 5, by: PRES, reason: 'x y z', expected_version: 5 }).status, 'not_found');
    assert.strictEqual(call('hcps_email_profile_rollback', { to_version: 42, by: PRES, reason: 'x y z', expected_version: 5 }).status, 'not_found');
    assert.strictEqual(call('hcps_email_profile_rollback', { to_version: 1, by: REP, reason: 'x y z', expected_version: 5 }).status, 'president_only');
  });
  t('reset (version 0): no approved rule remains; the history stays', () => {
    const r = call('hcps_email_profile_rollback', { to_version: 0, by: PRES, reason: 'Start over', expected_version: ver() });
    assert.strictEqual(r.status, 'reset'); assert.strictEqual(r.version, 6);
    assert.strictEqual(q(`select count(*) from public.email_learning_rules where status = 'approved'`), '0');
    assert.strictEqual(q(`select rules::text from public.email_learning_profiles where version = 6`), '[]');
    assert.strictEqual(q('select count(*) from public.email_learning_profiles'), '6');
    assert.ok(+q('select count(*) from public.email_learning_rule_events') >= 9);
  });
  t('simultaneous decisions: the second waits for the first, then is told the version changed (never two version N+1)', () => {
    const v = ver(), D = note(7, { kind: 'subject', pattern: { from: 'HCPS will be in your area', to: 'Quick visit next week' }, instruction: 'Subject: “Quick visit next week”.', examples: [] }).id;
    const dec = rid => `select public.hcps_email_rule_decide(${lit({ rule_id: rid, decision: 'approve', by: PRES, reason: 'Matches how I write', expected_version: v })})::text;`;
    // A decides and holds its transaction open for a second; B starts while A is still open.
    const A1 = `begin; set role service_role; ${dec(C)} select pg_sleep(1.2); commit;`, B1 = `select pg_sleep(0.4); set role service_role; ${dec(D)}`;
    const esc = x => x.replace(/"/g, '\\"');
    const sh = `${PSQL} -X -q -A -t -d ${DB} -c "${esc(A1)}" 2>&1 & ${PSQL} -X -q -A -t -d ${DB} -c "${esc(B1)}" 2>&1 & wait`;
    const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: process.env });
    const outs = r.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    assert.strictEqual(outs.length, 2, r.stdout + r.stderr);
    assert.deepStrictEqual(outs.map(o => o.status).sort(), ['decided', 'version_conflict']);
    assert.strictEqual(ver(), v + 1);
  });
  t('the guard: even a role GIVEN write rights on the tables, with the marker set, is refused (only the owner\'s functions write)', () => {
    q(`do $$ begin if not exists (select 1 from pg_roles where rolname='el_writer') then create role el_writer; end if; end $$; alter role el_writer bypassrls;
       grant usage on schema public to el_writer; grant select, insert, update on public.email_learning_rules, public.email_learning_profiles to el_writer`);
    try {
      refused(() => as('el_writer', `select set_config('hcps.email_rule_op','note',false); insert into public.email_learning_rules (rule_key, email_type, kind, pattern, instruction, suggested_instruction, sends, dealers)
        values ('${key(96)}','all','shorter','{}','Keep it shorter.','Keep it shorter.',3,2)`), /email_rule_guard/);
      refused(() => as('el_writer', `select set_config('hcps.email_rule_op','decide',false); update public.email_learning_rules set status = 'approved' where id = '${B}'`), /email_rule_guard/);
    } finally { q(`revoke all on public.email_learning_rules, public.email_learning_profiles from el_writer; revoke usage on schema public from el_writer`); }
  });
  t('versions and events are insert-only — no update, delete or truncate, owner included', () => {
    refused(() => q(`select set_config('hcps.email_rule_op','decide',false); update public.email_learning_profiles set reason = 'rewritten' where version = 1`), /email_rule_guard/);
    refused(() => q(`delete from public.email_learning_profiles where version = 1`), /email_rule_guard/);
    refused(() => q(`update public.email_learning_rule_events set reason = 'x' where id = 1`), /email_rule_guard/);
    refused(() => q(`delete from public.email_learning_rules where id = '${A}'`), /email_rule_guard/);
    for (const tb of ['email_learning_rules', 'email_learning_profiles', 'email_learning_rule_events']) refused(() => q(`truncate public.${tb} cascade`), /email_rule_guard/);
    refused(() => q(`select set_config('hcps.email_rule_op','note',false); update public.email_learning_rules set status = 'approved' where id = '${B}'`), /email_rule_guard/);
  });
  t('a second run of the migration is safe and keeps every row', () => {
    const before = q(`select count(*) || '/' || (select count(*) from public.email_learning_profiles) from public.email_learning_rules`);
    file(DB, SQL);
    assert.strictEqual(q(`select count(*) || '/' || (select count(*) from public.email_learning_profiles) from public.email_learning_rules`), before);
  });
  t('rollback of the migration refuses while rules exist', () => { refused(() => file(DB, RB), /rules, versions or events exist/); });
  t('rollback on an empty install removes Phase 2 and leaves Phase 1 installed', () => {
    const D2 = DB + '_e'; run('postgres', `drop database if exists ${D2}`); run('postgres', `create database ${D2}`);
    try {
      run(D2, `do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if; end $$;
        create table app_settings (key text primary key, value jsonb); create table staff_users (email text primary key, role text, active boolean, name text)`);
      file(D2, P1); file(D2, SQL);
      const out = file(D2, RB);
      assert.ok(/email_learning_p2 removed\|t/.test(out), out);
      assert.strictEqual(run(D2, `select to_regclass('public.email_learning_rules') is null and to_regclass('public.email_drafts') is not null`), 't');
    } finally { run('postgres', `drop database if exists ${D2}`); }
  });
} finally { run('postgres', `drop database if exists ${DB}`); }
console.log(`\nEmail learning P2 (Postgres): ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
