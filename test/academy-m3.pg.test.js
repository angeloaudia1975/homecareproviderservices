/* HCPS Academy A2D M3 — the committed M3 SQL files, run in a REAL Postgres with pg-safeupdate loaded (as Supabase's
   API sessions do), on top of A1, M1 and M2 exactly as installed in production. What is tested is what Angelo would run:
   supabase/academy_a2d_m3_{preflight,author_ops,postcheck,acceptance_tests,rollback}.sql, plus the A1/M1/M2 acceptance
   files and the local hardening files again (they must still pass with M3 installed), test/academy/m3_author.sql, and
   two-session concurrency checks. Skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-m3.pg.test.js
   PG17 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1 (drops the fixture line that loads it; the static WHERE check covers it). */
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const LOCAL = f => path.join(__dirname, 'academy', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const asEditorText = (db, text) => { const r = psql(db, ['-c', text]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const asEditor = (db, f) => asEditorText(db, fs.readFileSync(f, 'utf8'));
const crlf = s => s.replace(/\r?\n/g, '\r\n');
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 12).join('\n       ')); } }
async function ta(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 12).join('\n       ')); } }
const results = out => out.split('\n').filter(l => /^\d+\|/.test(l)).map(l => { const [n, test, result, detail] = l.split('|'); return { n: +n, test, result, detail }; });
const allPass = (r, count) => { assert.strictEqual(r.length, count, r.map(x => x.n).join(',')); assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []); };
const hardening = (db, f, count, re = /^\d\d\|/) => { const out = file(db, LOCAL(f)).split('\n').filter(l => re.test(l)); assert.strictEqual(out.length, count, out.join(' / ')); return out; };
const json = s => JSON.parse(s);
const HEADER = fs.readFileSync(SUP('academy_a2d_m3_postcheck.sql'), 'utf8');
const hdr = re => (HEADER.match(re) || [])[1];
const FP = { m3: hdr(/m3_code_fingerprint\s+([0-9a-f]{32}) when installed/), m3crlf: hdr(/\n--\s+([0-9a-f]{32}) when pasted/),
             sa: hdr(/start_attempt_fingerprint\s+([0-9a-f]{32}) \(Unix\)/), sacrlf: hdr(/start_attempt_fingerprint\s+[0-9a-f]{32} \(Unix\) or ([0-9a-f]{32})/) };
const M1_LF = '130e45fa36f768e032a89da43b645f8a', M1_CRLF = 'e70543ba23d96ca7c5aec8eeff0ea341';
const M1X_LF = 'e05951fca31652f7289b1be904cc079a', M1X_CRLF = '30a6a689fca7ed63c0c24ce774d514be';
const M2_LF = 'f24e4f888c8ed7a4e0765382737dfe35', M2_CRLF = '794f3c3e007bf3cc6d72b574aac614e3';
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixtureText = () => { let s = fs.readFileSync(LOCAL('fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };

function freshDb(name, windows) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  asEditorText(name, fixtureText());
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');   // as on Supabase
  run(name, "insert into staff_users (email, name, role, active) values ('owner3@test.example', 'Third Admin', 'owner', true)");
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql']) {
    if (windows) asEditorText(name, crlf(fs.readFileSync(SUP(f), 'utf8'))); else file(name, SUP(f));
  }
}
// Runs SQL in its own session in the background; resolves with { ms, ok, out, err }.
function bg(db, sql) {
  return new Promise(res => {
    const t0 = Date.now();
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ ms: Date.now() - t0, ok: code === 0, out: out.trim(), err }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DB = 'academy_m3_' + process.pid, DB2 = 'academy_m3crlf_' + process.pid, DBC = 'academy_m3cc_' + process.pid;
(async () => {
try {
  freshDb(DB);
  t('Preflight readiness: academy_admin ON (the pilot) is allowed; any other Academy switch ON is not', () => {
    run(DB, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
    assert.strictEqual(json(file(DB, SUP('academy_a2d_m3_preflight.sql'))).ready_for_m3, true);
    run(DB, `update app_settings set value = value || '{"academy_learner": true}' where key = 'phase2_flags'`);
    assert.strictEqual(json(file(DB, SUP('academy_a2d_m3_preflight.sql'))).ready_for_m3, false);
    run(DB, `update app_settings set value = '{"academy_admin": true}' where key = 'phase2_flags'`);
  });
  const pre = json(file(DB, SUP('academy_a2d_m3_preflight.sql')));
  t('Preflight (read-only) before M3: ready; M1 and M2 exactly as approved; no M3 objects; no exam_quota column', () => {
    assert.strictEqual(pre.ready_for_m3, true); assert.strictEqual(pre.m3_installed, false); assert.strictEqual(pre.exam_quota_column, false);
    assert.deepStrictEqual(pre.m1, { functions: 19, guard_triggers: 6, code_fingerprint: M1_LF });
    assert.deepStrictEqual(pre.m2, { functions: 15, guard_triggers: 8, code_fingerprint: M2_LF });
    assert.deepStrictEqual(pre.start_attempt.draws_through_m3, false);
  });
  t('Before M3 a direct question insert is possible for the owner (the gap M3 closes)', () => {
    run(DB, "begin; insert into academy_media (kind, storage_path, rights) values ('pdf', 'media/x/pre.pdf', 'hcps_owned'); rollback");
  });
  t('A1, M1 and M2 acceptance tests pass before M3 (the M3-aware setup changes nothing without M3)', () => {
    allPass(results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql'))), 27);
    allPass(results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql'))), 43);
    allPass(results(asEditor(DB, SUP('academy_a2c_m2_acceptance_tests.sql'))), 21);
  });
  file(DB, SUP('academy_a2d_m3_author_ops.sql'));
  const post = json(file(DB, SUP('academy_a2d_m3_postcheck.sql')));
  t('Postcheck after M3: 24 functions, 12 server-only operations, no helper for the server, nothing for the public keys; guards on questions, media, fact links; publish check; start-attempt server-only and drawing through M3', () => {
    assert.strictEqual(post.functions, 24); assert.strictEqual(post.operations_server_only, 12);
    assert.strictEqual(post.helpers_callable_by_server, 0); assert.strictEqual(post.callable_by_public_keys, 0);
    assert.deepStrictEqual(post.guard_triggers_on, ['academy_content_refs', 'academy_media', 'academy_questions']);
    assert.deepStrictEqual(post.truncate_guard_on, post.guard_triggers_on);
    assert.deepStrictEqual(post.publish_check_on, ['academy_course_versions']);
    assert.deepStrictEqual(post.start_attempt, { draws_through_m3: true, server_only: true });
    assert.strictEqual(post.exam_quota_column, true);
    assert.strictEqual(post.m1_except_start_attempt, M1X_LF); assert.strictEqual(post.m2_code_fingerprint, M2_LF);
    assert.strictEqual(post.m1_functions, 19); assert.strictEqual(post.m1_guard_triggers, 6);
    assert.strictEqual(post.m2_functions, 15); assert.strictEqual(post.m2_guard_triggers, 8);
  });
  t('The installed M3 code and start-attempt match the fingerprints written in the postcheck header (Unix line endings)', () => {
    assert.ok(FP.m3 && FP.sa, 'fingerprints in header'); assert.strictEqual(post.m3_code_fingerprint, FP.m3); assert.strictEqual(post.start_attempt_fingerprint, FP.sa);
  });
  t('Preflight after M3: every fingerprint inside and outside the Academy identical (grants, policies, other columns, RLS, other functions, row counts); M1 except start-attempt and M2 unchanged; only the M3 objects changed', () => {
    const after = json(file(DB, SUP('academy_a2d_m3_preflight.sql')));
    assert.strictEqual(after.ready_for_m3, false); assert.strictEqual(after.m3_installed, true); assert.strictEqual(after.exam_quota_column, true);
    assert.strictEqual(after.m3_objects.functions.length, 24);
    assert.deepStrictEqual(after.fingerprints, pre.fingerprints);
    assert.deepStrictEqual(after.academy_fingerprints, pre.academy_fingerprints);
    assert.deepStrictEqual(after.m2, pre.m2);
    assert.strictEqual(after.m1.functions, 19); assert.strictEqual(after.m1.guard_triggers, 6); assert.notStrictEqual(after.m1.code_fingerprint, M1_LF);
    assert.deepStrictEqual(after.start_attempt, { fingerprint: FP.sa, draws_through_m3: true, server: true, public_keys: false });
    assert.deepStrictEqual(after.content_triggers.filter(x => !/\.academy_author_(guard|guard_truncate|publish_check)$/.test(x)), pre.content_triggers);
    assert.deepStrictEqual(after.content_rows, pre.content_rows); assert.strictEqual(after.audit_rows, pre.audit_rows);
  });
  t('M3 refuses to run twice', () => assert.notStrictEqual(psql(DB, ['-f', SUP('academy_a2d_m3_author_ops.sql')]).status, 0));
  t('M3 acceptance tests: 24 + leftover check pass (sent as ONE request, like the SQL editor), incl. the non-President part', () => {
    const r = results(asEditor(DB, SUP('academy_a2d_m3_acceptance_tests.sql')));
    allPass(r, 25); assert.ok(!/not run/.test(r.find(x => x.n === 13).detail), r.find(x => x.n === 13).detail);
  });
  t('M3 hardening (roles as the API uses them, a non-President administrator, answer-key exposure, marker, M1 messages, unverified pins, credential media): all 12 pass', () => {
    const out = hardening(DB, 'm3_author.sql', 12); assert.deepStrictEqual(out.filter(l => !/^\d\d\|PASS\|/.test(l)), []);
  });
  t('With M3 installed: A1 (27), M1 (43), M2 (21) acceptance, M1 hardening (28), M1 all-or-nothing (11), M2 hardening (9) all still pass', () => {
    allPass(results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql'))), 27);
    allPass(results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql'))), 43);
    allPass(results(asEditor(DB, SUP('academy_a2c_m2_acceptance_tests.sql'))), 21);
    assert.deepStrictEqual(hardening(DB, 'm1_hardening.sql', 28).filter(l => !/^\d\d\|PASS\|/.test(l)), []);
    const a = file(DB, LOCAL('atomicity.sql')).split('\n').filter(l => l.includes('|'));
    assert.strictEqual(a.length, 11); assert.deepStrictEqual(a.filter(l => !l.endsWith('|PASS')), []);
    assert.deepStrictEqual(hardening(DB, 'm2_content.sql', 9).filter(l => !/^\d\d\|PASS\|/.test(l)), []);
  });
  t('The public keys cannot run any M3 operation, and the server role cannot write questions, media or fact links directly', () => {
    for (const role of ['anon', 'authenticated'])
      assert.throws(() => run(DB, `set role ${role}; select academy_author_op_create_media('staff:admin@test.example', null, '{"kind":"link","external_url":"https://example.com/x","rights":"link_only"}')`), /permission denied/);
    assert.throws(() => run(DB, `set role service_role; select set_config('academy.op','forged',false); insert into academy_media (kind, external_url, rights) values ('link','https://example.com/x','link_only')`), /audited operations/);
    assert.throws(() => run(DB, `set role service_role; select academy_author_exam_draw(gen_random_uuid(), true)`), /permission denied/);
  });
  // ---- Concurrency: two real sessions (own database, so the A1 'nothing left' check keeps working on DB) ----
  freshDb(DBC); file(DBC, SUP('academy_a2d_m3_author_ops.sql'));
  t('The server role (the API) runs an operation in one call: change and audit row together', () => {
    const r = json(run(DBC, `set role service_role; select academy_author_op_create_media('staff:admin@test.example', null, '{"kind":"link","external_url":"https://example.com/api-call","rights":"link_only","alt_text":"API call"}')`));
    assert.strictEqual(r.kind, 'link');
    assert.strictEqual(run(DBC, `select count(*) from academy_events where entity_id = '${r.id}' and action = 'create_media'`), '1');
    run(DBC, `set role service_role; select academy_author_op_delete_media('staff:admin@test.example', '${r.id}')`);
  });

  // A draft course: version V (2 modules, exam 2), lesson L, media M; a second lesson L2 (another session uses M).
  const setup = json(run(DBC, `set role service_role; select jsonb_build_object('c', c.id) from (select (academy_content_op_create_course('staff:admin@test.example', null,
    '{"slug":"cc-course","title":"CC","course_type":"hcps_certification"}')->>'id')::uuid id) c`));
  const S = (sql) => run(DBC, `set role service_role; ${sql}`);
  const V = json(S(`select academy_content_op_create_version('staff:admin@test.example', null, '${setup.c}', '{"exam_questions":2}')`)).id;
  const MA = json(S(`select academy_content_op_create_module('staff:admin@test.example', null, '${V}', '{"title":"A"}')`)).id;
  const MB = json(S(`select academy_content_op_create_module('staff:admin@test.example', null, '${V}', '{"title":"B"}')`)).id;
  const L = json(S(`select academy_content_op_create_lesson('staff:admin@test.example', null, '${MA}', '{"title":"L"}')`)).id;
  const MEDIA = json(S(`select academy_author_op_create_media('staff:admin@test.example', null, '{"kind":"image","storage_path":"media/cc/chair.jpg","rights":"hcps_owned","alt_text":"A lift chair shown upright, front view"}')`)).id;
  for (const [m, p] of [[MA, 'CA?'], [MB, 'CB?']])
    S(`select academy_author_op_create_question('staff:admin@test.example', null, '${V}', '{"module_id":"${m}","kind":"single","prompt":"${p}","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')`);
  const SR = `set role service_role; `;

  await ta('Concurrency: a media delete waits for a lesson save that is using the file, then refuses (the file is still used); nothing is lost', async () => {
    const a = bg(DBC, `${SR} begin; select academy_author_op_set_blocks('staff:admin@test.example', '${L}', '[{"kind":"image","media_id":"${MEDIA}"}]'); select pg_sleep(1.5); commit;`);
    await sleep(400);
    const b = await bg(DBC, `${SR} select academy_author_op_delete_media('staff:admin@test.example', '${MEDIA}')`);
    const ra = await a;
    assert.ok(ra.ok, ra.err); assert.ok(!b.ok && /still used/.test(b.err), b.err); assert.ok(b.ms > 700, 'delete waited ' + b.ms + ' ms');
    assert.strictEqual(run(DBC, `select count(*) from academy_media where id = '${MEDIA}'`), '1');
  });
  await ta('Concurrency: a media edit waits for a publish that uses the file, then refuses (the file now belongs to published content)', async () => {
    const a = bg(DBC, `${SR} begin; select academy_op_publish_version('staff:admin@test.example', '${V}'); select pg_sleep(1.5); commit;`);
    await sleep(400);
    const b = await bg(DBC, `${SR} select academy_author_op_update_media('staff:admin@test.example', '${MEDIA}', '{"alt_text":"A lift chair shown upright, changed"}')`);
    const ra = await a;
    assert.ok(ra.ok, ra.err); assert.ok(!b.ok && /used by content learners can see/.test(b.err), b.err); assert.ok(b.ms > 700, 'edit waited ' + b.ms + ' ms');
    assert.strictEqual(run(DBC, `select alt_text from academy_media where id = '${MEDIA}'`), 'A lift chair shown upright, front view');
  });
  await ta('Concurrency: two administrators recording the same stored file at the same time: the second waits, then is refused (one record per file)', async () => {
    const a = bg(DBC, `${SR} begin; select academy_author_op_create_media('staff:admin@test.example', null, '{"kind":"pdf","storage_path":"media/cc/same.pdf","rights":"hcps_owned"}'); select pg_sleep(1.2); commit;`);
    await sleep(300);
    const b = await bg(DBC, `${SR} select academy_author_op_create_media('staff:owner3@test.example', null, '{"kind":"pdf","storage_path":"media/cc/same.pdf","rights":"hcps_owned"}')`);
    const ra = await a;
    assert.ok(ra.ok, ra.err); assert.ok(!b.ok && /already uses that file/.test(b.err), b.err); assert.ok(b.ms > 600, 'second waited ' + b.ms + ' ms');
    assert.strictEqual(run(DBC, `select count(*) from academy_media where storage_path = 'media/cc/same.pdf'`), '1');
  });
  const V2 = json(S(`select academy_content_op_create_version('staff:admin@test.example', null, '${setup.c}', '{"exam_questions":2}')`)).id;
  const MC = json(S(`select academy_content_op_create_module('staff:admin@test.example', null, '${V2}', '{"title":"C"}')`)).id;
  const MD = json(S(`select academy_content_op_create_module('staff:admin@test.example', null, '${V2}', '{"title":"D"}')`)).id;
  await ta('Concurrency: two administrators saving the order and the distribution of one draft at the same time are served one after the other; both saved, each with its audit row', async () => {
    const [a, b] = await Promise.all([
      bg(DBC, `${SR} begin; select academy_author_op_reorder_modules('staff:admin@test.example', '${V2}', array['${MD}','${MC}']::uuid[]); select pg_sleep(1); commit;`),
      (async () => { await sleep(300); return bg(DBC, `${SR} select academy_author_op_set_exam_distribution('staff:owner3@test.example', '${V2}', '{"${MC}":1,"${MD}":1}')`); })()]);
    assert.ok(a.ok, a.err); assert.ok(b.ok, b.err); assert.ok(b.ms > 500, 'second waited ' + b.ms + ' ms');
    assert.strictEqual(run(DBC, `select string_agg(title || ':' || position || ':' || exam_quota, ',' order by position) from academy_modules where version_id = '${V2}'`), 'D:1:1,C:2:1');
    assert.strictEqual(run(DBC, `select count(*) from academy_events where entity_id = '${V2}' and action in ('reorder_modules','set_exam_distribution')`), '2');
  });
  await ta('Concurrency: an edit that waits for a publish of the same version is refused once the version is published (draft-only holds under a race)', async () => {
    S(`select academy_author_op_create_question('staff:admin@test.example', null, '${V2}', '{"module_id":"${MC}","kind":"single","prompt":"C?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')`);
    S(`select academy_author_op_create_question('staff:admin@test.example', null, '${V2}', '{"module_id":"${MD}","kind":"single","prompt":"D?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')`);
    S(`select academy_op_retire_version('staff:admin@test.example', '${V}', 'replacing for the race test')`);
    const a = bg(DBC, `${SR} begin; select academy_op_publish_version('staff:admin@test.example', '${V2}'); select pg_sleep(1.2); commit;`);
    await sleep(300);
    const b = await bg(DBC, `${SR} select academy_author_op_create_question('staff:owner3@test.example', null, '${V2}', '{"module_id":"${MC}","kind":"single","prompt":"Late?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')`);
    const ra = await a;
    assert.ok(ra.ok, ra.err); assert.ok(!b.ok && /can no longer change/.test(b.err), b.err);
    assert.strictEqual(run(DBC, `select count(*) from academy_questions where version_id = '${V2}'`), '2');
  });

  // ---- Rollback ----
  t('Rollback refuses while a module still holds an exam distribution (nothing removed)', () => {
    const r = psql(DBC, ['-f', SUP('academy_a2d_m3_rollback.sql')]);   // the race tests left V2 published with a distribution
    assert.notStrictEqual(r.status, 0); assert.ok(/still has an exam distribution/.test(r.stderr), r.stderr);
    assert.strictEqual(run(DBC, "select count(*) from pg_proc where proname like 'academy\\_author\\_%'"), '24');
  });
  t('Rollback refuses to run if M2 is not intact (nothing removed)', () => {
    const sql = fs.readFileSync(SUP('academy_a2d_m3_rollback.sql'), 'utf8').replace(/^begin;$/m, '').replace(/^commit;$/m, '');
    const r = psql(DB, ['-c', "begin; set local session_replication_role = replica; update academy_modules set exam_quota = null where true; set local session_replication_role = origin; drop trigger academy_content_guard_truncate on public.academy_lessons; " + sql + " rollback;"]);
    assert.notStrictEqual(r.status, 0); assert.ok(/M2 is not intact/.test(r.stderr), r.stderr);
    assert.strictEqual(run(DB, "select count(*) from pg_proc where proname like 'academy\\_author\\_%'"), '24');
  });
  t('Rollback removes M3 completely, restores M1 byte for byte (fingerprint 130e45fa…), keeps M2 and every row', () => {
    const rows = run(DB, "select (select count(*) from academy_questions) || '/' || (select count(*) from academy_media) || '/' || (select count(*) from academy_content_refs) || '/' || (select count(*) from academy_events)");
    file(DB, SUP('academy_a2d_m3_rollback.sql'));
    assert.strictEqual(run(DB, "select count(*) from pg_proc where proname like 'academy\\_author\\_%'"), '0');
    assert.strictEqual(run(DB, "select count(*) from pg_trigger where tgname like 'academy\\_author\\_%'"), '0');
    const after = json(file(DB, SUP('academy_a2d_m3_preflight.sql')));
    assert.deepStrictEqual(after.m1, pre.m1); assert.deepStrictEqual(after.m2, pre.m2);
    assert.deepStrictEqual(after.fingerprints, pre.fingerprints); assert.deepStrictEqual(after.academy_fingerprints, pre.academy_fingerprints);
    assert.strictEqual(after.exam_quota_column, false); assert.strictEqual(after.start_attempt.server, true); assert.strictEqual(after.start_attempt.public_keys, false);
    assert.strictEqual(run(DB, "select (select count(*) from academy_questions) || '/' || (select count(*) from academy_media) || '/' || (select count(*) from academy_content_refs) || '/' || (select count(*) from academy_events)"), rows);
  });
  t('After rollback A1, M1 and M2 acceptance pass; M3 can be re-applied and passes again', () => {
    allPass(results(asEditor(DB, SUP('academy_a1_acceptance_tests.sql'))), 27);
    allPass(results(asEditor(DB, SUP('academy_a2a_m1_acceptance_tests.sql'))), 43);
    allPass(results(asEditor(DB, SUP('academy_a2c_m2_acceptance_tests.sql'))), 21);
    file(DB, SUP('academy_a2d_m3_author_ops.sql'));
    allPass(results(asEditor(DB, SUP('academy_a2d_m3_acceptance_tests.sql'))), 25);
  });

  // ---- Production form: M1 and M2 were pasted from Windows; M3 will be too ----
  t('Production form (M1 and M2 installed with Windows line endings): preflight ready with e70543ba… / 794f3c3e…; M3 pasted the same way installs in ONE request; postcheck gives the CRLF fingerprints in its header; all acceptance tests pass', () => {
    freshDb(DB2, true);
    const p2 = json(file(DB2, SUP('academy_a2d_m3_preflight.sql')));
    assert.strictEqual(p2.ready_for_m3, true); assert.strictEqual(p2.m1.code_fingerprint, M1_CRLF); assert.strictEqual(p2.m2.code_fingerprint, M2_CRLF);
    asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2d_m3_author_ops.sql'), 'utf8')));
    const pc = json(file(DB2, SUP('academy_a2d_m3_postcheck.sql')));
    assert.ok(FP.m3crlf && FP.sacrlf, 'CRLF fingerprints in header');
    assert.strictEqual(pc.m3_code_fingerprint, FP.m3crlf); assert.strictEqual(pc.start_attempt_fingerprint, FP.sacrlf);
    assert.strictEqual(pc.m1_except_start_attempt, M1X_CRLF); assert.strictEqual(pc.m2_code_fingerprint, M2_CRLF);
    allPass(results(asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2d_m3_acceptance_tests.sql'), 'utf8')))), 25);
    allPass(results(asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2a_m1_acceptance_tests.sql'), 'utf8')))), 43);
    allPass(results(asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2c_m2_acceptance_tests.sql'), 'utf8')))), 21);
    allPass(results(asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a1_acceptance_tests.sql'), 'utf8')))), 27);
  });
  t('Production form: the rollback pasted from Windows restores M1 to e70543ba… exactly', () => {
    asEditorText(DB2, crlf(fs.readFileSync(SUP('academy_a2d_m3_rollback.sql'), 'utf8')));
    const p = json(file(DB2, SUP('academy_a2d_m3_preflight.sql')));
    assert.strictEqual(p.m1.code_fingerprint, M1_CRLF); assert.strictEqual(p.m2.code_fingerprint, M2_CRLF); assert.strictEqual(p.ready_for_m3, true);
  });

  // ---- Static checks of the committed files ----
  t('Every UPDATE / DELETE in the M3 SQL files has a WHERE clause (pg-safeupdate)', () => {
    for (const f of ['academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_rollback.sql', 'academy_a2d_m3_acceptance_tests.sql']) {
      const sql = fs.readFileSync(SUP(f), 'utf8').replace(/--[^\n]*/g, '');
      for (const stmt of sql.split(';')) if (/\b(update|delete\s+from)\s+(?!.*\bon\b)(?!of\b)/.test(stmt) && !/\bdrop\b|\bcreate\s+trigger\b|before\s+insert|for\s+update|for\s+share/i.test(stmt))
        assert.ok(/\bwhere\b/i.test(stmt), f + ': ' + stmt.trim().slice(0, 100));
    }
  });
  t('M3 writes only Academy content, media, fact links, the audit row and attempts; alters only academy_modules (one column); drops nothing', () => {
    const sql = fs.readFileSync(SUP('academy_a2d_m3_author_ops.sql'), 'utf8').replace(/--[^\n]*/g, '');
    const written = new Set([...sql.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z_]+)/gi)].map(m => m[1].toLowerCase()).filter(x => !['or', 'of'].includes(x)));
    assert.deepStrictEqual([...written].filter(x => !['academy_lessons', 'academy_modules', 'academy_questions', 'academy_media', 'academy_content_refs', 'academy_attempts'].includes(x)), []);
    assert.deepStrictEqual([...sql.matchAll(/alter\s+table\s+(?:public\.)?([a-z_]+)/gi)].map(m => m[1]), ['academy_modules']);
    assert.ok(!/\bdrop\b|(^|;)\s*truncate\b/im.test(sql));
  });
  t('The rollback restores start-attempt with exactly the text of the approved M1 file', () => {
    const m1 = fs.readFileSync(SUP('academy_a2a_m1_audited_ops.sql'), 'utf8');
    const a = m1.indexOf('create function public.academy_op_start_attempt('); const orig = m1.slice(a, m1.indexOf('end $$;\n', a) + 8);
    assert.ok(fs.readFileSync(SUP('academy_a2d_m3_rollback.sql'), 'utf8').includes(orig.replace('create function', 'create or replace function')));
  });
  t('M3 changes exactly one line of start-attempt (the draw) — everything else is the approved M1 text', () => {
    const m1 = fs.readFileSync(SUP('academy_a2a_m1_audited_ops.sql'), 'utf8'), m3 = fs.readFileSync(SUP('academy_a2d_m3_author_ops.sql'), 'utf8');
    const grab = (s, h) => { const a = s.indexOf(h); return s.slice(a, s.indexOf('end $$;\n', a) + 8).split('\n'); };
    const o = grab(m1, 'create function public.academy_op_start_attempt('), n = grab(m3, 'create or replace function public.academy_op_start_attempt(');
    const diff = n.filter(l => !o.includes(l)), gone = o.filter(l => !n.includes(l));
    assert.deepStrictEqual(diff, ['create or replace function public.academy_op_start_attempt(p_actor text, p_enrollment_id uuid)',
      "  v_ids := academy_author_exam_draw(v_ver.id, v_ver.status = 'published' and v_enr.status <> 'withdrawn');   -- A2D M3: per-module draw"]);
    assert.strictEqual(gone.length, 4, gone.join(' | '));   // the old 3-line draw and the "create function" line
  });
} finally {
  run('postgres', `drop database if exists ${DB}`); run('postgres', `drop database if exists ${DB2}`); run('postgres', `drop database if exists ${DBC}`);
}
console.log(`\nacademy-m3.pg: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
})();
