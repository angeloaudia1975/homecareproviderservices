/* HCPS Academy A2D M3.1 — the atomic lesson save, run in a REAL Postgres with pg-safeupdate loaded (as Supabase's API
   sessions do), on top of A1, M1, M2 and M3 exactly as committed. What is tested is what Angelo would run:
   supabase/academy_a2d_m3_1_{preflight,save_lesson,postcheck,acceptance_tests,rollback}.sql, plus the A1 / M1 / M2 / M3
   acceptance files again (they must still pass with M3.1 installed), and two- and three-session concurrency checks
   (simultaneous saves, a reader during a save, a save killed half way). Skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-m3_1.pg.test.js
   PG17.6 (no pg-safeupdate build): PGTEST_NO_SAFEUPDATE=1 PGHOST=/tmp/pg17sock PGPORT=55433 (the static WHERE check covers it). */
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const LOCAL = f => path.join(__dirname, 'academy', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const editor = (db, text) => { const r = psql(db, ['-c', text]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const crlf = s => s.replace(/\r?\n/g, '\r\n');
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 10).join('\n       ')); } }
const results = out => out.split('\n').filter(l => /^\d+\|/.test(l)).map(l => { const [n, test, result, detail] = l.split('|'); return { n: +n, test, result, detail }; });
const allPass = (r, count) => { assert.strictEqual(r.length, count, r.map(x => x.n).join(',')); assert.deepStrictEqual(r.filter(x => x.result !== 'PASS'), []); };
const json = s => JSON.parse(s);
const MIG = SUP('academy_a2d_m3_1_save_lesson.sql');
const HEADER = fs.readFileSync(SUP('academy_a2d_m3_1_postcheck.sql'), 'utf8');
const FP_LF = (HEADER.match(/m3_1_code_fingerprint\s+([0-9a-f]{32}) when installed/) || [])[1];
const FP_CRLF = (HEADER.match(/\n--\s+([0-9a-f]{32}) when pasted/) || [])[1];
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixtureText = () => { let s = fs.readFileSync(LOCAL('fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };

function freshDb(name, windows) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  editor(name, fixtureText());
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql']) {
    if (windows) editor(name, crlf(fs.readFileSync(SUP(f), 'utf8'))); else file(name, SUP(f));
  }
  run(name, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
}
function bg(db, sql, app) {
  return new Promise(res => {
    const t0 = Date.now();
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { env: Object.assign({}, process.env, app ? { PGAPPNAME: app } : {}) });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ ms: Date.now() - t0, ok: code === 0, out: out.trim(), err }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PRES = `'staff:admin@test.example'`;
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const OBJ = { kind: 'objectives', items: ['Explain the first thing', 'Explain the second thing'] };
const TXT = h => ({ kind: 'text', heading: h, body: 'Words for ' + h + '.' });
const FACT = (model, field) => ({ kind: 'fact', manufacturer_slug: 'golden-technologies', model_code: model, field, label: field });
// A course with one draft version, one module and two lessons, made through the M2 operations.
function makeLessons(db, slug) {
  const c = json(run(db, `select academy_content_op_create_course(${PRES}, null, ${J({ slug, title: 'M3.1 local', course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`)).id;
  const v = json(run(db, `select academy_content_op_create_version(${PRES}, null, '${c}', '{"exam_questions":2}')`)).id;
  const m = json(run(db, `select academy_content_op_create_module(${PRES}, null, '${v}', '{"title":"Module"}')`)).id;
  const l1 = json(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', '{"title":"One","est_minutes":12}')`)).id;
  const l2 = json(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', '{"title":"Two","est_minutes":12}')`)).id;
  return { c, v, m, l1, l2 };
}
const blocksOf = (db, id) => json(run(db, `select blocks from academy_lessons where id = '${id}'`));
const refsOf = (db, id) => run(db, `select coalesce(string_agg(upper(model_code) || ':' || field, ',' order by upper(model_code), field), '') from academy_content_refs where lesson_id = '${id}'`);
const count = (db, q) => Number(run(db, q));
const save = (id, base, blocks) => `select academy_save_op_lesson(${PRES}, '${id}', ${J(base)}, ${J(blocks)})`;

const DB = 'academy_m31_' + process.pid, DB2 = 'academy_m31crlf_' + process.pid;
(async () => {
try {
  freshDb(DB);
  const pre = json(file(DB, SUP('academy_a2d_m3_1_preflight.sql')));
  await t('Preflight (read-only) before M3.1: ready; M1 / M2 / M3 exactly as installed; no M3.1 object', () => {
    assert.strictEqual(pre.ready_for_m3_1, true, JSON.stringify(pre).slice(0, 400)); assert.strictEqual(pre.m3_1_installed, false);
    assert.deepStrictEqual(pre.m1, { functions: 19, guard_triggers: 6, code_fingerprint: '2802eaad1697750470f840f4b90d68d9' });
    assert.deepStrictEqual(pre.m2, { functions: 15, guard_triggers: 8, code_fingerprint: 'f24e4f888c8ed7a4e0765382737dfe35' });
    assert.deepStrictEqual(pre.m3, { functions: 24, triggers: 7, code_fingerprint: 'e48e4c2758dae2be0e679c3b9cbe97e8' });
  });
  await t('Preflight readiness refuses when a learner switch is on', () => {
    run(DB, `update app_settings set value = value || '{"academy_learner": true, "academy_open": true}' where key = 'phase2_flags'`);
    assert.strictEqual(json(file(DB, SUP('academy_a2d_m3_1_preflight.sql'))).ready_for_m3_1, false);
    run(DB, `update app_settings set value = '{"academy_admin": true}' where key = 'phase2_flags'`);
  });
  // real content BEFORE the migration (as in production: the Golden draft), saved the M3 way
  const live = makeLessons(DB, 'golden-like-draft');
  run(DB, `select academy_author_op_link_fact(${PRES}, null, ${J({ lesson_id: live.l1, manufacturer_slug: 'golden-technologies', model_code: 'PR511', field: 'sizes' })})`);
  run(DB, `select academy_author_op_set_blocks(${PRES}, '${live.l1}', ${J([OBJ, FACT('PR511', 'sizes')])})`);
  const before = json(file(DB, SUP('academy_a2d_m3_1_preflight.sql')));

  await t('Static: every UPDATE and DELETE in the M3.1 files carries a WHERE clause (pg-safeupdate)', () => {
    for (const f of ['academy_a2d_m3_1_save_lesson.sql', 'academy_a2d_m3_1_rollback.sql', 'academy_a2d_m3_1_acceptance_tests.sql']) {
      const s = fs.readFileSync(SUP(f), 'utf8').replace(/--[^\n]*/g, '');
      let seen = 0;
      for (const m of s.matchAll(/(?:^|[;(]|\bthen|\bbegin|\bas)\s*(update|delete\s+from)\s+[a-z_.]+(\s+[a-z]+)?\b([\s\S]*?);/gim)) {
        if (/^update\s+app_settings|on conflict/i.test(m[0])) continue;
        assert.ok(/\bwhere\b/i.test(m[0]), f + ': ' + m[0].slice(0, 80)); seen++;
      }
      if (f === 'academy_a2d_m3_1_save_lesson.sql') assert.strictEqual(seen, 2, 'the migration has one UPDATE and one DELETE');
    }
  });
  await t('Migration installs (one transaction); a second run is refused and changes nothing', () => {
    file(DB, MIG);
    const r = tryRun(DB, fs.readFileSync(MIG, 'utf8'));
    assert.strictEqual(r.ok, false); assert.match(r.err, /already exists/);
    assert.strictEqual(count(DB, `select count(*) from pg_proc where proname like 'academy\\_save\\_%'`), 2);
  });
  const post = json(file(DB, SUP('academy_a2d_m3_1_postcheck.sql')));
  await t('Postcheck: M3.1 fingerprint as recorded (Unix form); M1 / M2 / M3 unchanged; server-only; nothing for public keys; no row written', () => {
    assert.ok(FP_LF && FP_CRLF && FP_LF !== FP_CRLF);
    assert.strictEqual(post.m3_1_code_fingerprint, FP_LF);
    assert.strictEqual(post.m3_code_fingerprint, 'e48e4c2758dae2be0e679c3b9cbe97e8');
    assert.strictEqual(post.m1_code_fingerprint, '2802eaad1697750470f840f4b90d68d9');
    assert.strictEqual(post.m2_code_fingerprint, 'f24e4f888c8ed7a4e0765382737dfe35');
    assert.deepStrictEqual([post.functions, post.operation_server_only, post.helper_callable_by_server, post.callable_by_public_keys], [2, true, false, 0]);
    assert.deepStrictEqual([post.m1_functions, post.m1_guard_triggers, post.m2_functions, post.m2_guard_triggers, post.m3_functions, post.m3_triggers], [19, 6, 15, 8, 24, 7]);
    assert.strictEqual(post.lessons_fingerprint, before.lessons_fingerprint); assert.strictEqual(post.content_refs_fingerprint, before.content_refs_fingerprint);
    assert.strictEqual(post.audit_rows, before.audit_rows);
  });
  await t('Preflight after: only m3_1_installed / m3_1_objects / ready_for_m3_1 moved; every other value identical (outside the Academy too)', () => {
    const after = json(file(DB, SUP('academy_a2d_m3_1_preflight.sql')));
    for (const k of Object.keys(before)) if (!['m3_1_installed', 'm3_1_objects', 'ready_for_m3_1'].includes(k)) assert.deepStrictEqual(after[k], before[k], k);
    assert.strictEqual(after.m3_1_installed, true); assert.deepStrictEqual(after.m3_1_objects, ['academy_save_lesson_links', 'academy_save_op_lesson']);
  });
  await t('Acceptance tests: 17/17 PASS with real content present; run twice (nothing left behind, real lessons untouched)', () => {
    allPass(results(file(DB, SUP('academy_a2d_m3_1_acceptance_tests.sql'))), 17);
    allPass(results(file(DB, SUP('academy_a2d_m3_1_acceptance_tests.sql'))), 17);
    const again = json(file(DB, SUP('academy_a2d_m3_1_preflight.sql')));
    assert.strictEqual(again.lessons_fingerprint, before.lessons_fingerprint); assert.strictEqual(again.audit_rows, before.audit_rows);
  });
  await t('M3 acceptance (25) and M2 acceptance (21) still pass with M3.1 installed', () => {
    allPass(results(file(DB, SUP('academy_a2d_m3_acceptance_tests.sql'))), 25);
    allPass(results(file(DB, SUP('academy_a2c_m2_acceptance_tests.sql'))), 21);
  });

  /* ---------------- concurrency: real sessions ---------------- */
  const X = makeLessons(DB, 'm31-concurrency');
  await t('Simultaneous saves of the same lesson from the same starting point: exactly one wins, the other is refused "changed"; never a mixed result', async () => {
    const A = [OBJ, TXT('Mine A'), FACT('PRA1', 'sizes')], B = [OBJ, TXT('Theirs B'), FACT('PRB1', 'sizes')];
    const e0 = count(DB, 'select count(*) from academy_events');
    const [ra, rb] = await Promise.all([bg(DB, save(X.l1, [], A)), bg(DB, save(X.l1, [], B))]);
    assert.strictEqual([ra, rb].filter(r => r.ok).length, 1, ra.err + rb.err);
    const loser = ra.ok ? rb : ra, won = ra.ok ? A : B;
    assert.match(loser.err, /changed/);
    assert.deepStrictEqual(blocksOf(DB, X.l1), won);
    assert.strictEqual(refsOf(DB, X.l1), (ra.ok ? 'PRA1' : 'PRB1') + ':sizes');
    assert.strictEqual(count(DB, 'select count(*) from academy_events') - e0, 1, 'one audit row');
  });
  await t('A save holding its locks: a reader in between sees the OLD screens (no temporary overwrite); a second save waits, then is refused "changed"', async () => {
    const base = blocksOf(DB, X.l1);
    const A = [OBJ, TXT('Slow save'), FACT('PRC1', 'weight_capacity')], B = [OBJ, TXT('Second save')];
    const pa = bg(DB, `begin; ${save(X.l1, base, A)}; select pg_sleep(1.2); commit;`);
    await sleep(300);
    const pb = bg(DB, save(X.l1, base, B));
    await sleep(300);
    assert.deepStrictEqual(blocksOf(DB, X.l1), base, 'a reader during the save sees the committed (old) screens');
    assert.ok(!refsOf(DB, X.l1).includes('PRC1'), 'nor its new links');
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.ok(ra.ok, ra.err); assert.strictEqual(rb.ok, false); assert.match(rb.err, /changed/);
    assert.ok(rb.ms > 600, 'the second save waited for the lock (' + rb.ms + ' ms)');
    assert.deepStrictEqual(blocksOf(DB, X.l1), A); assert.strictEqual(refsOf(DB, X.l1), 'PRC1:weight_capacity');
  });
  await t('Saves of two different lessons of one draft run one after the other (version lock) and both succeed', async () => {
    const b1 = blocksOf(DB, X.l1), b2 = blocksOf(DB, X.l2);
    const [r1, r2] = await Promise.all([bg(DB, save(X.l1, b1, [OBJ, FACT('PRD1', 'sizes')])), bg(DB, save(X.l2, b2, [OBJ, FACT('PRD1', 'sizes')]))]);
    assert.ok(r1.ok && r2.ok, r1.err + r2.err);
    assert.strictEqual(refsOf(DB, X.l1), 'PRD1:sizes'); assert.strictEqual(refsOf(DB, X.l2), 'PRD1:sizes');
  });
  await t('A save killed half way (its session terminated after the write, before commit) leaves screens, links and history exactly as before', async () => {
    const base = blocksOf(DB, X.l1), refs0 = refsOf(DB, X.l1), e0 = count(DB, 'select count(*) from academy_events');
    const pa = bg(DB, `begin; ${save(X.l1, base, [OBJ, TXT('Never committed'), FACT('PRE1', 'sizes')])}; select pg_sleep(5); commit;`, 'm31-victim');
    await sleep(700);
    run(DB, `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'm31-victim'`);
    const ra = await pa; assert.strictEqual(ra.ok, false);
    assert.deepStrictEqual(blocksOf(DB, X.l1), base); assert.strictEqual(refsOf(DB, X.l1), refs0);
    assert.strictEqual(count(DB, 'select count(*) from academy_events'), e0);
    assert.strictEqual(count(DB, `select count(*) from academy_content_refs where model_code = 'PRE1'`), 0);
  });
  await t('The server role cannot fake the operation marker to write fact links or lessons directly', () => {
    const r = tryRun(DB, `begin; select set_config('academy.op', 'save_lesson', true); set local role service_role;
      insert into academy_content_refs (version_id, lesson_id, manufacturer_slug, model_code, field) values ('${X.v}', '${X.l1}', 'golden-technologies', 'FAKE', 'sizes'); commit;`);
    assert.strictEqual(r.ok, false); assert.match(r.err, /audited operations|permission denied/);
  });
  await t('The server role may run the operation; anon and authenticated may not; nobody but the owner runs the helper', () => {
    assert.strictEqual(tryRun(DB, `set role anon; ${save(X.l1, [], [])}`).ok, false);
    assert.strictEqual(tryRun(DB, `set role authenticated; ${save(X.l1, [], [])}`).ok, false);
    assert.strictEqual(tryRun(DB, `set role service_role; select * from academy_save_lesson_links('[]')`).ok, false);
    const base = blocksOf(DB, X.l1);
    assert.ok(tryRun(DB, `set role service_role; ${save(X.l1, base, base)}`).ok);
  });

  /* ---------------- rollback ---------------- */
  await t('Rollback: removes only the two M3.1 functions; screens, links and save_lesson history stay; M3 saves still work; M3.1 installs again', () => {
    const lf = json(file(DB, SUP('academy_a2d_m3_1_preflight.sql')));
    file(DB, SUP('academy_a2d_m3_1_rollback.sql'));
    assert.strictEqual(count(DB, `select count(*) from pg_proc where proname like 'academy\\_save\\_%'`), 0);
    const rb = json(file(DB, SUP('academy_a2d_m3_1_preflight.sql')));
    assert.strictEqual(rb.lessons_fingerprint, lf.lessons_fingerprint); assert.strictEqual(rb.content_refs_fingerprint, lf.content_refs_fingerprint);
    assert.strictEqual(rb.audit_rows, lf.audit_rows); assert.strictEqual(rb.ready_for_m3_1, true);
    assert.ok(count(DB, `select count(*) from academy_events where action = 'save_lesson'`) > 0);
    run(DB, `select academy_author_op_set_blocks(${PRES}, '${X.l2}', ${J([OBJ, TXT('after rollback')])})`);
    file(DB, MIG);
    assert.strictEqual(json(file(DB, SUP('academy_a2d_m3_1_postcheck.sql'))).m3_1_code_fingerprint, FP_LF);
  });

  /* ---------------- the Windows paste ---------------- */
  freshDb(DB2, true);
  await t('Installed as pasted from Windows (CRLF, on top of CRLF-pasted M1/M2/M3, as production): the CRLF fingerprints, and every test passes', () => {
    const p = json(file(DB2, SUP('academy_a2d_m3_1_preflight.sql')));
    assert.strictEqual(p.ready_for_m3_1, true);
    assert.strictEqual(p.m1.code_fingerprint, 'a809004b8fe77dce69cfc555ff984bdb'); assert.strictEqual(p.m3.code_fingerprint, '9f41ee27d9ea6b271b35ea5ec1a25c7e');
    editor(DB2, crlf(fs.readFileSync(MIG, 'utf8')));
    const pc = json(file(DB2, SUP('academy_a2d_m3_1_postcheck.sql')));
    assert.strictEqual(pc.m3_1_code_fingerprint, FP_CRLF);
    allPass(results(editor(DB2, crlf(fs.readFileSync(SUP('academy_a2d_m3_1_acceptance_tests.sql'), 'utf8')))), 17);
  });
} catch (e) { fail++; console.log('  FAIL (setup) ' + (e && e.stack || e)); }
finally {
  for (const d of [DB, DB2]) { try { run('postgres', `drop database if exists ${d} with (force)`); } catch (e) { /* ignore */ } }
  console.log(`\nacademy-m3_1.pg: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
})();
