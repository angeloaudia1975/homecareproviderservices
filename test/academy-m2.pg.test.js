/* HCPS Academy A2C M2 — the committed M2 SQL files, run in a REAL Postgres with pg-safeupdate loaded (as Supabase's
   API sessions do), on top of A1 and M1 exactly as installed in production. What is tested is what Angelo would run:
   supabase/academy_a2c_m2_{preflight,content_ops,postcheck,acceptance_tests,rollback}.sql, plus the A1/M1 acceptance
   files again (they must still pass with M2 installed) and the local hardening file test/academy/m2_content.sql.
   Skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-m2.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const LOCAL = f => path.join(__dirname, 'academy', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
// The SQL editor sends a file as ONE request; psql -c does the same (one implicit transaction, last result shown).
const asEditorText = (db, text) => { const r = psql(db, ['-c', text]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const asEditor = (db, f) => asEditorText(db, fs.readFileSync(f, 'utf8'));
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }
const results = out => out.split('\n').filter(l => /^\d+\|/.test(l)).map(l => { const [n, test, result, detail] = l.split('|'); return { n: +n, test, result, detail }; });
const allPass = (r, count) => { assert.strictEqual(r.length, count, r.map(x => x.n).join(',')); assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []); };
const json = s => JSON.parse(s);
const POSTCHECK_HEADER = fs.readFileSync(SUP('academy_a2c_m2_postcheck.sql'), 'utf8');
const FP_LF = (POSTCHECK_HEADER.match(/m2_code_fingerprint\s+([0-9a-f]{32}) when installed with the file's own/) || [])[1];
const FP_CRLF = (POSTCHECK_HEADER.match(/([0-9a-f]{32}) when pasted into the SQL editor from Windows/) || [])[1];

function freshDb(name) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  file(name, LOCAL('fixture.sql'));
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');   // as on Supabase
  file(name, SUP('academy_a2a_m1_audited_ops.sql'));
}
const DB = 'academy_m2_' + process.pid, DB2 = 'academy_m2crlf_' + process.pid;
try {
  freshDb(DB);
  const pre = json(file(DB, SUP('academy_a2c_m2_preflight.sql')));
  t('Preflight (read-only) before M2: ready; M1 exactly as approved (19 functions, 6 triggers, fingerprint 130e45fa…); no M2 objects', () => {
    assert.strictEqual(pre.ready_for_m2, true); assert.strictEqual(pre.m2_installed, false);
    assert.deepStrictEqual(pre.m1, { functions: 19, guard_triggers: 6, code_fingerprint: '130e45fa36f768e032a89da43b645f8a' });
    assert.strictEqual(pre.active_presidents, 1);
  });
  t('Before M2 a direct content write is possible (the gap M2 closes)', () => {
    run(DB, "begin; insert into academy_courses (slug, title, course_type, issuer) values ('pre-m2', 'x', 'training', 'none'); rollback");
  });
  t('A1 and M1 acceptance tests pass before M2 (the M2-aware setup changes nothing without M2)', () => {
    allPass(results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql'))), 27);
    allPass(results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql'))), 43);
  });
  file(DB, SUP('academy_a2c_m2_content_ops.sql'));
  const post = json(file(DB, SUP('academy_a2c_m2_postcheck.sql')));
  t('Postcheck after M2: 15 functions, 11 server-only operations, no helper for the server, nothing for the public keys, guard on the 4 content tables; M1 unchanged', () => {
    assert.strictEqual(post.functions, 15); assert.strictEqual(post.operations_server_only, 11);
    assert.strictEqual(post.helpers_callable_by_server, 0); assert.strictEqual(post.callable_by_public_keys, 0);
    assert.deepStrictEqual(post.guard_triggers_on, ['academy_course_versions', 'academy_courses', 'academy_lessons', 'academy_modules']);
    assert.strictEqual(post.m1_code_fingerprint, '130e45fa36f768e032a89da43b645f8a');
    assert.strictEqual(post.m1_functions, 19); assert.strictEqual(post.m1_guard_triggers, 6);
  });
  t('The installed M2 code matches the fingerprint written in the postcheck header (Unix line endings)', () => {
    assert.ok(FP_LF, 'fingerprint in header'); assert.strictEqual(post.m2_code_fingerprint, FP_LF);
  });
  t('Preflight after M2: every fingerprint inside and outside the Academy identical (tables, grants, policies, RLS, other functions, key row counts); only the M2 objects changed', () => {
    const after = json(file(DB, SUP('academy_a2c_m2_preflight.sql')));
    assert.strictEqual(after.ready_for_m2, false); assert.strictEqual(after.m2_installed, true);
    assert.strictEqual(after.m2_objects.functions.length, 15);
    assert.deepStrictEqual(after.fingerprints, pre.fingerprints);
    assert.deepStrictEqual(after.academy_fingerprints, pre.academy_fingerprints);
    assert.deepStrictEqual(after.m1, pre.m1);
    assert.deepStrictEqual(after.content_triggers.filter(x => !x.endsWith('.academy_content_guard')), pre.content_triggers);
  });
  t('M2 refuses to run twice', () => assert.notStrictEqual(psql(DB, ['-f', SUP('academy_a2c_m2_content_ops.sql')]).status, 0));
  t('M2 acceptance tests: 20 + leftover check pass (sent as ONE request, like the SQL editor)', () => {
    allPass(results(asEditor(DB, SUP('academy_a2c_m2_acceptance_tests.sql'))), 21);
  });
  t('M2 hardening (roles as the API uses them, a non-President administrator, a caught failure): all 7 pass', () => {
    const out = file(DB, LOCAL('m2_content.sql')).split('\n').filter(l => /^\d\d\|/.test(l));
    assert.strictEqual(out.length, 7, out.join(' / '));
    assert.deepStrictEqual(out.filter(l => !/^\d\d\|PASS\|/.test(l)), []);
  });
  t('With M2 installed: A1 acceptance (27), M1 acceptance (43), M1 hardening (28) and M1 all-or-nothing (11) all still pass', () => {
    allPass(results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql'))), 27);
    allPass(results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql'))), 43);
    const h = file(DB, LOCAL('m1_hardening.sql')).split('\n').filter(l => /^\d\d\|/.test(l));
    assert.strictEqual(h.length, 28); assert.deepStrictEqual(h.filter(l => !/^\d\d\|PASS\|/.test(l)), []);
    const a = file(DB, LOCAL('atomicity.sql')).split('\n').filter(l => l.includes('|'));
    assert.strictEqual(a.length, 11); assert.deepStrictEqual(a.filter(l => !l.endsWith('|PASS')), []);
  });
  t('The public keys cannot run any content operation, and the server role cannot write content directly', () => {
    for (const role of ['anon', 'authenticated'])
      assert.throws(() => run(DB, `set role ${role}; select academy_content_op_create_course('staff:admin@test.example', null, '{"slug":"x-y","title":"x","course_type":"training"}')`), /permission denied/);
    assert.throws(() => run(DB, `set role service_role; select set_config('academy.op','forged',false); insert into academy_courses (slug, title, course_type, issuer) values ('x-y','x','training','none')`), /audited operations/);
    assert.throws(() => run(DB, `set role service_role; select academy_content_lock_draft(gen_random_uuid())`), /permission denied/);
  });
  t('Rollback refuses to run if M1 is not intact (nothing removed)', () => {
    const r = psql(DB, ['-c', "begin; drop trigger academy_audited_guard on public.product_facts; " + fs.readFileSync(SUP('academy_a2c_m2_rollback.sql'), 'utf8').replace(/^begin;$/m, '').replace(/^commit;$/m, '') + " rollback;"]);
    assert.notStrictEqual(r.status, 0); assert.ok(/M1 is not intact/.test(r.stderr), r.stderr);
    assert.strictEqual(run(DB, "select count(*) from pg_proc where proname like 'academy\\_content\\_%'"), '15');
  });
  t('Rollback removes M2 completely, keeps M1 (19 functions, 6 triggers, same fingerprint) and every row', () => {
    const rows = run(DB, 'select (select count(*) from academy_courses) || \'/\' || (select count(*) from academy_events)');
    file(DB, SUP('academy_a2c_m2_rollback.sql'));
    assert.strictEqual(run(DB, "select count(*) from pg_proc where proname like 'academy\\_content\\_%'"), '0');
    assert.strictEqual(run(DB, "select count(*) from pg_trigger where tgname = 'academy_content_guard'"), '0');
    const after = json(file(DB, SUP('academy_a2c_m2_preflight.sql')));
    assert.deepStrictEqual(after.m1, pre.m1); assert.deepStrictEqual(after.fingerprints, pre.fingerprints);
    assert.deepStrictEqual(after.academy_fingerprints, pre.academy_fingerprints);
    assert.strictEqual(run(DB, 'select (select count(*) from academy_courses) || \'/\' || (select count(*) from academy_events)'), rows);
  });
  t('After rollback the A1 and M1 acceptance tests pass, and M2 can be re-applied and passes again', () => {
    allPass(results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql'))), 27);
    allPass(results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql'))), 43);
    file(DB, SUP('academy_a2c_m2_content_ops.sql'));
    allPass(results(asEditor(DB, SUP('academy_a2c_m2_acceptance_tests.sql'))), 21);
  });
  t('Pasted from Windows (every line ending \\r\\n) in ONE request: installs, gives the CRLF fingerprint in the postcheck header, and all tests pass', () => {
    freshDb(DB2);
    const crlf = s => s.replace(/\r?\n/g, '\r\n');
    asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2c_m2_content_ops.sql'), 'utf8')));
    assert.ok(FP_CRLF, 'CRLF fingerprint in header');
    assert.strictEqual(json(file(DB2, SUP('academy_a2c_m2_postcheck.sql'))).m2_code_fingerprint, FP_CRLF);
    allPass(results(asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2c_m2_acceptance_tests.sql'), 'utf8')))), 21);
  });
  t('The server role (the API) runs an operation in one call: change and audit row together', () => {
    const r = json(run(DB2, `set role service_role; select academy_content_op_create_course('staff:admin@test.example', null, '{"slug":"api-call","title":"API","course_type":"training"}')`));
    assert.strictEqual(r.status, 'draft');
    assert.strictEqual(run(DB2, `select count(*) from academy_events where entity_id = '${r.id}' and action = 'create_course'`), '1');
  });
  t('Every UPDATE / DELETE in the M2 SQL files has a WHERE clause (pg-safeupdate)', () => {
    for (const f of ['academy_a2c_m2_content_ops.sql', 'academy_a2c_m2_rollback.sql', 'academy_a2c_m2_acceptance_tests.sql']) {
      const sql = fs.readFileSync(SUP(f), 'utf8').replace(/--[^\n]*/g, '');
      for (const stmt of sql.split(';')) if (/\b(update|delete\s+from)\s+(?!.*\bon\b)/.test(stmt) && !/\bdrop\b|\bcreate\s+trigger\b|before\s+insert/i.test(stmt))
        assert.ok(/\bwhere\b/i.test(stmt), f + ': ' + stmt.trim().slice(0, 80));
    }
  });
  t('M2 writes no HCPS table outside the Academy content and audit tables, and drops nothing', () => {
    const sql = fs.readFileSync(SUP('academy_a2c_m2_content_ops.sql'), 'utf8').replace(/--[^\n]*/g, '');
    const written = new Set([...sql.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z_]+)/gi)].map(m => m[1].toLowerCase()).filter(x => x !== 'or'));   // 'before insert or update or delete on' is a trigger, not a write
    assert.deepStrictEqual([...written].filter(x => !['academy_courses', 'academy_course_versions', 'academy_modules', 'academy_lessons'].includes(x)), []);
    assert.ok(!/\bdrop\b|\balter\s+table\b|\btruncate\b/i.test(sql));
  });
} finally {
  run('postgres', `drop database if exists ${DB}`); run('postgres', `drop database if exists ${DB2}`);
}
console.log(`\nacademy-m2.pg: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
