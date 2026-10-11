/* HCPS Academy A2A — the committed SQL files, run in a REAL Postgres with pg-safeupdate loaded (as Supabase's API
   sessions do), against a fixture with the parts of the Supabase project the Academy touches. What is tested is
   what Angelo runs: supabase/academy_a1_foundation.sql, academy_a2a_m1_*.sql and both acceptance-test files.
   Needs psql and a server (and the safeupdate library); skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-a2a.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const FIX = path.join(__dirname, 'academy', 'fixture.sql');
const ATOM = path.join(__dirname, 'academy', 'atomicity.sql');
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const fileStatus = (db, f) => psql(db, ['-f', f]);
// The SQL editor sends a file as ONE request; psql -c does the same (one implicit transaction, last result shown).
const asEditor = (db, f) => { const r = psql(db, ['-c', fs.readFileSync(f, 'utf8')]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }
const results = out => out.split('\n').filter(l => /^\d+\|/.test(l)).map(l => { const [n, test, result] = l.split('|'); return { n: +n, test, result }; });
// Outside-the-Academy fingerprint: grants, policies, columns of every other public table (the A1 preflight's own query).
const FP = db => JSON.stringify(JSON.parse(file(db, SUP('academy_a1_preflight.sql'))).fingerprints);

const DB = 'academy_a2a_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, FIX);
  t('pg-safeupdate is loaded in every session (as on Supabase)', () => {
    assert.strictEqual(run(DB, 'show session_preload_libraries'), 'safeupdate');
    assert.throws(() => run(DB, 'create temp table x(a int); insert into x values (1); update x set a = 2'), /WHERE/);
  });
  file(DB, SUP('academy_a1_foundation.sql'));
  const before = FP(DB);
  t('A1 acceptance tests: 26 + leftover check pass before M1', () => {
    const r = results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql')));
    assert.strictEqual(r.length, 27); assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []);
  });
  const pre = JSON.parse(file(DB, SUP('academy_a2a_m1_preflight.sql')));
  t('M1 preflight (read-only) before M1: ready, A1 present 18/18, no M1 objects, no Academy rows', () => {
    assert.strictEqual(pre.ready_for_m1, true); assert.strictEqual(pre.m1_installed, false);
    assert.strictEqual(pre.a1_installed.tables_present, '18 / 18');
    assert.ok(Object.values(pre.academy_rows).every(n => n === 0));
  });
  file(DB, SUP('academy_a2a_m1_audited_ops.sql'));
  t('M1 preflight after M1: 15 functions + 6 guard triggers; Academy grants/policies/columns/RLS and outside fingerprints identical', () => {
    const post = JSON.parse(file(DB, SUP('academy_a2a_m1_preflight.sql')));
    assert.strictEqual(post.ready_for_m1, false); assert.strictEqual(post.m1_installed, true);
    assert.strictEqual(post.m1_objects.functions.length, 15); assert.strictEqual(post.m1_objects.guard_triggers_on.length, 6);
    assert.deepStrictEqual(post.academy_fingerprints, pre.academy_fingerprints);
    assert.deepStrictEqual(post.fingerprints, pre.fingerprints);
    assert.deepStrictEqual(post.a1_installed.a1_triggers, pre.a1_installed.a1_triggers);
  });
  t('M1 changes nothing outside the Academy (grants, policies, columns, key row counts identical)', () => assert.strictEqual(FP(DB), before));
  t('M1 refuses to run twice', () => assert.notStrictEqual(fileStatus(DB, SUP('academy_a2a_m1_audited_ops.sql')).status, 0));
  t('M1 acceptance tests: 30 + leftover check pass', () => {
    const r = results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql')));
    assert.strictEqual(r.length, 31); assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []);
  });
  t('A1 acceptance tests still pass with M1 installed (setup goes through the audited operations)', () => {
    const r = results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql')));
    assert.strictEqual(r.length, 27); assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []);
  });
  t('All or nothing: with the audit store refusing writes, each of the 10 operations fails and changes nothing', () => {
    const out = file(DB, ATOM).split('\n').filter(l => l.includes('|'));
    assert.strictEqual(out.length, 10, out.join(' / '));
    assert.deepStrictEqual(out.filter(l => !l.endsWith('|PASS')), []);
  });
  t('The public key roles cannot run any operation (anon, authenticated)', () => {
    for (const role of ['anon', 'authenticated'])
      assert.throws(() => run(DB, `set role ${role}; select academy_op_withdraw_fact('x', gen_random_uuid(), 'x')`), /permission denied/);
  });
  t('The server role cannot bypass the guards with a direct write (RLS bypass does not help)', () => {
    run(DB, "grant all on all tables in schema public to service_role");   // as on Supabase
    assert.throws(() => run(DB, `set role service_role; insert into academy_certificates (cert_number, learner_id, enrollment_id, version_id, attempt_id, learner_name)
      values ('HCPS-AAAA-BBBB', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')`), /audited operation/);
  });
  t('Nothing was left behind by the tests', () => assert.strictEqual(run(DB, 'select count(*) from academy_events') + run(DB, 'select count(*) from product_facts'), '00'));
  t('Rollback removes M1 completely and changes nothing outside the Academy', () => {
    file(DB, SUP('academy_a2a_m1_rollback.sql'));
    assert.strictEqual(run(DB, "select count(*) from pg_proc where proname like 'academy\\_op\\_%' or proname = 'academy_audited_guard'"), '0');
    assert.strictEqual(run(DB, "select count(*) from pg_trigger where tgname = 'academy_audited_guard'"), '0');
    assert.strictEqual(FP(DB), before);
  });
  t('After rollback the A1 acceptance tests pass again, and M1 can be re-applied', () => {
    const r = results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql')));
    assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []);
    file(DB, SUP('academy_a2a_m1_audited_ops.sql'));
    const r2 = results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql')));
    assert.deepStrictEqual(r2.filter(x => x.result !== 'PASS'), []);
  });
  t('Every UPDATE / DELETE in the A2A SQL files has a WHERE clause (pg-safeupdate)', () => {
    for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2a_m1_rollback.sql']) {
      const sql = fs.readFileSync(SUP(f), 'utf8').replace(/--[^\n]*/g, '');
      for (const stmt of sql.split(';')) if (/\b(update|delete\s+from)\s+(?!.*\bon\b)/i.test(stmt) && !/\bdrop\b|\bcreate\s+trigger\b|before\s+insert/i.test(stmt))
        assert.ok(/\bwhere\b/i.test(stmt), f + ': ' + stmt.trim().slice(0, 80));
    }
  });
} finally {
  run('postgres', `drop database if exists ${DB}`);
}
console.log(`\nacademy-a2a.pg: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
