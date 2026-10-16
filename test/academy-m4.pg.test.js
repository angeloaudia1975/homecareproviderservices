/* HCPS Academy C2 / M4 — course publication controls, run in a REAL Postgres (pg-safeupdate loaded, as Supabase's API
   sessions do) on top of A1, M1, M2, M3 and M3.1 exactly as committed. What is tested is what Angelo would run:
   supabase/academy_c2_m4_publish_ops.sql and its rollback. Skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-m4.pg.test.js
   PG17.6 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1. */
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
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixtureText = () => { let s = fs.readFileSync(LOCAL('fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }
const json = s => JSON.parse(s);
const PRES = `'staff:admin@test.example'`, ADM = `'staff:admin2@test.example'`;
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const SR = 'set role service_role; ';
const MIG = SUP('academy_c2_m4_publish_ops.sql'), RB = SUP('academy_c2_m4_publish_ops_rollback.sql');

function freshDb(name) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  run(name, fixtureText());
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql']) file(name, SUP(f));
  run(name, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
  run(name, `insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)`);
}
// A version with two modules and one exam question each (exam of 2): publishable once in review.
function version(db, course) {
  const v = json(run(db, `select academy_content_op_create_version(${PRES}, null, '${course}', '{"exam_questions":2}')`)).id;
  for (const t of ['A', 'B']) {
    const m = json(run(db, `select academy_content_op_create_module(${PRES}, null, '${v}', ${J({ title: 'Module ' + t })})`)).id;
    run(db, `select academy_author_op_create_question(${PRES}, null, '${v}', ${J({ module_id: m, kind: 'single', prompt: 'Q ' + t + ' ' + v.slice(0, 6) + '?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'a', explanation: 'x', objective_tags: ['t'] })})`);
  }
  return v;
}
const review = (db, v) => run(db, `select academy_content_op_move_version(${PRES}, '${v}', 'in_review')`);
const status = (db, table, id) => run(db, `select status from ${table} where id = '${id}'`);
const events = (db, where) => Number(run(db, `select count(*) from academy_events where ${where}`));
const course = (db, slug, extra) => json(run(db, `select academy_content_op_create_course(${PRES}, null, ${J(Object.assign({ slug, title: slug, course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' }, extra || {}))})`)).id;
const pub = (actor, v, reason) => `select academy_publish_op_publish_version(${actor}, '${v}', ${reason ? `'${reason}'` : 'null'})`;
function bg(db, sql) {
  return new Promise(res => {
    const t0 = Date.now(); const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ ms: Date.now() - t0, ok: code === 0, out: out.trim(), err }));
  });
}

const DB = 'academy_m4_' + process.pid, DB2 = 'academy_m4rb_' + process.pid;
(async () => {
try {
  freshDb(DB);
  const C = course(DB, 'm4-golden-like');
  const V1 = version(DB, C);

  await t('Static: every UPDATE / DELETE in the M4 files carries a WHERE clause (pg-safeupdate)', () => {
    for (const f of [MIG, RB]) {
      const s = fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '');
      for (const m of s.matchAll(/\b(update|delete\s+from)\s+[a-z_.]+\s[\s\S]*?;/gim)) assert.ok(/\bwhere\b/i.test(m[0]), path.basename(f) + ': ' + m[0].slice(0, 80));
    }
  });
  await t('Migration installs in one transaction; every install check reads true; a second run is refused and changes nothing', () => {
    const out = file(DB, MIG);
    const rows = out.split('\n').filter(l => l.includes('|'));
    assert.strictEqual(rows.length, 5, out); assert.ok(rows.every(r => r.endsWith('|t')), out);
    const again = tryRun(DB, fs.readFileSync(MIG, 'utf8'));
    assert.strictEqual(again.ok, false); assert.match(again.err, /already installed/);
  });
  await t('The server role cannot publish or retire through M1 any more; anon / authenticated cannot call M4', () => {
    let r = tryRun(DB, `${SR} select academy_op_publish_version(${PRES}, '${V1}')`); assert.ok(!r.ok && /permission denied/.test(r.err), r.err);
    r = tryRun(DB, `${SR} select academy_op_retire_version(${PRES}, '${V1}', 'x')`); assert.ok(!r.ok && /permission denied/.test(r.err), r.err);
    for (const role of ['anon', 'authenticated']) {
      r = tryRun(DB, `set role ${role}; select academy_publish_op_publish_version(${PRES}, '${V1}', null)`); assert.ok(!r.ok && /permission denied/.test(r.err), role);
    }
    r = tryRun(DB, `${SR} select academy_publish_set_course(${PRES}, '${C}', 'published', 'x')`); assert.ok(!r.ok && /permission denied/.test(r.err), 'the helper is owner-only');
  });
  await t('A draft version is refused (decision A: review first); nothing changes', () => {
    const r = tryRun(DB, `${SR} ${pub(PRES, V1)}`); assert.ok(!r.ok && /in review/.test(r.err), r.err);
    assert.strictEqual(status(DB, 'academy_course_versions', V1), 'draft'); assert.strictEqual(status(DB, 'academy_courses', C), 'draft');
  });
  review(DB, V1);
  await t('Only the President publishes: an active administrator is refused by the database', () => {
    const r = tryRun(DB, `${SR} ${pub(ADM, V1)}`); assert.ok(!r.ok && /only the President/.test(r.err), r.err);
    assert.strictEqual(status(DB, 'academy_course_versions', V1), 'in_review');
  });
  await t('The President publishes: the version is published (M1 checks and pinning ran), the course is marked published, both audited', () => {
    const r = json(run(DB, `${SR} ${pub(PRES, V1)}`));
    assert.strictEqual(r.version.status, 'published'); assert.strictEqual(r.retired, null); assert.strictEqual(r.course.status, 'published');
    assert.strictEqual(events(DB, `action = 'publish_version' and entity_id = '${V1}'`), 1);
    assert.strictEqual(events(DB, `action = 'set_course_status' and entity_id = '${C}' and after->>'status' = 'published'`), 1);
  });
  const V2 = version(DB, C); review(DB, V2);
  await t('A replacement retires the old version and publishes the new one in ONE transaction; learners and certificates untouched', () => {
    const before = run(DB, `select count(*) || '/' || (select count(*) from academy_certificates) from academy_enrollments`);
    const r = json(run(DB, `${SR} ${pub(PRES, V2, 'Updated Golden lineup')}`));
    assert.strictEqual(r.retired.status, 'retired'); assert.strictEqual(r.version.status, 'published');
    assert.strictEqual(status(DB, 'academy_course_versions', V1), 'retired'); assert.strictEqual(status(DB, 'academy_course_versions', V2), 'published');
    assert.strictEqual(run(DB, `select count(*) from academy_course_versions where course_id = '${C}' and status = 'published'`), '1');
    assert.strictEqual(events(DB, `action = 'retire_version' and entity_id = '${V1}' and after->>'reason' = 'Updated Golden lineup'`), 1);
    assert.strictEqual(run(DB, `select count(*) || '/' || (select count(*) from academy_certificates) from academy_enrollments`), before);
  });
  await t('A replacement that fails a publish check changes NOTHING: the current version stays published (no half-retire)', () => {
    const V3 = json(run(DB, `select academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":2}')`)).id;
    review(DB, V3);   // no questions: M1 refuses the publish
    const r = tryRun(DB, `${SR} ${pub(PRES, V3)}`); assert.ok(!r.ok && /exam questions/.test(r.err), r.err);
    assert.strictEqual(status(DB, 'academy_course_versions', V2), 'published'); assert.strictEqual(status(DB, 'academy_course_versions', V3), 'in_review');
    assert.strictEqual(events(DB, `action = 'retire_version' and entity_id = '${V2}'`), 0);
    run(DB, `select academy_content_op_move_version(${PRES}, '${V3}', 'draft')`);
  });
  await t('Concurrency: two simultaneous publishes of the same course queue on the course lock; exactly one version ends published', async () => {
    const A = version(DB, C), B = version(DB, C); review(DB, A); review(DB, B);
    const [ra, rb] = await Promise.all([bg(DB, `${SR} begin; ${pub(PRES, A)}; select pg_sleep(1); commit;`), (async () => { await new Promise(r => setTimeout(r, 300)); return bg(DB, `${SR} ${pub(PRES, B)}`); })()]);
    assert.ok(ra.ok, ra.err); assert.ok(rb.ok, rb.err); assert.ok(rb.ms > 500, 'the second publish waited ' + rb.ms + ' ms');
    assert.strictEqual(run(DB, `select count(*) from academy_course_versions where course_id = '${C}' and status = 'published'`), '1');
    assert.strictEqual(status(DB, 'academy_course_versions', B), 'published'); assert.strictEqual(status(DB, 'academy_course_versions', A), 'retired');
  });
  await t('Retiring a version: a reason is required; the course goes back to draft; an administrator is refused', () => {
    const P = run(DB, `select id from academy_course_versions where course_id = '${C}' and status = 'published'`);
    let r = tryRun(DB, `${SR} select academy_publish_op_retire_version(${PRES}, '${P}', '  ')`); assert.ok(!r.ok && /reason/.test(r.err));
    r = tryRun(DB, `${SR} select academy_publish_op_retire_version(${ADM}, '${P}', 'x')`); assert.ok(!r.ok && /only the President/.test(r.err));
    const x = json(run(DB, `${SR} select academy_publish_op_retire_version(${PRES}, '${P}', 'Paused for corrections')`));
    assert.strictEqual(x.version.status, 'retired'); assert.strictEqual(x.course.status, 'draft');
    assert.strictEqual(run(DB, `select count(*) from academy_publish_consistency()`), '0');
  });
  await t('Retiring a course: reason required, President only; the course is retired and cannot publish again', () => {
    const V9 = version(DB, C); review(DB, V9); run(DB, `${SR} ${pub(PRES, V9)}`);
    const V10 = version(DB, C); review(DB, V10);   // waiting in review when the course is retired
    let r = tryRun(DB, `${SR} select academy_publish_op_retire_course(${ADM}, '${C}', 'x')`); assert.ok(!r.ok && /only the President/.test(r.err));
    const x = json(run(DB, `${SR} select academy_publish_op_retire_course(${PRES}, '${C}', 'Course withdrawn')`));
    assert.strictEqual(x.course.status, 'retired'); assert.strictEqual(x.retired_version.status, 'retired');
    r = tryRun(DB, `${SR} ${pub(PRES, V10)}`); assert.ok(!r.ok && /retired/.test(r.err), r.err);
    r = tryRun(DB, `${SR} select academy_publish_op_retire_course(${PRES}, '${C}', 'again')`); assert.ok(!r.ok && /already retired/.test(r.err));
  });
  await t('Manufacturer programs: published with publish_course (President only, https link, listed manufacturer); never by version', () => {
    const P = course(DB, 'm4-program', { course_type: 'manufacturer_program', external_url: 'https://goldentech.com/training/' });
    let r = tryRun(DB, `${SR} select academy_publish_op_publish_course(${ADM}, '${P}')`); assert.ok(!r.ok && /only the President/.test(r.err));
    const x = json(run(DB, `${SR} select academy_publish_op_publish_course(${PRES}, '${P}')`)); assert.strictEqual(x.course.status, 'published');
    r = tryRun(DB, `${SR} select academy_publish_op_publish_course(${PRES}, '${P}')`); assert.ok(!r.ok && /already published/.test(r.err));
    const H = course(DB, 'm4-hcps-two');
    r = tryRun(DB, `${SR} select academy_publish_op_publish_course(${PRES}, '${H}')`); assert.ok(!r.ok && /publishing a version/.test(r.err));
    assert.strictEqual(events(DB, `action = 'set_course_status' and entity_id = '${P}'`), 1);
  });
  await t('Plain writes to course or version status are still refused (M2 guard): only the operations change them', () => {
    let r = tryRun(DB, `update academy_courses set status = 'published' where id = '${C}'`); assert.ok(!r.ok && /audited operations/.test(r.err), r.err);
    r = tryRun(DB, `${SR} update academy_course_versions set status = 'published' where course_id = '${C}'`); assert.ok(!r.ok, 'server role plain write');
  });
  await t('The records check finds nothing inconsistent after all of the above', () => {
    assert.strictEqual(run(DB, `select count(*) from academy_publish_consistency()`), '0');
  });
  await t('Rollback is refused while a retired course or a published program exists (decisions need a person first)', () => {
    const r = tryRun(DB, fs.readFileSync(RB, 'utf8')); assert.ok(!r.ok && /rollback refused/.test(r.err), r.err);
    assert.ok(run(DB, `select to_regprocedure('public.academy_publish_op_publish_version(text,uuid,text)') is not null`) === 't');
  });
  await t('Rollback on a clean database removes M4 and gives the server role M1 publish / retire back', () => {
    freshDb(DB2); file(DB2, MIG);
    const out = file(DB2, RB); assert.match(out, /M4 removed\|t/);
    assert.strictEqual(run(DB2, `select has_function_privilege('service_role', 'public.academy_op_publish_version(text,uuid)', 'execute')`), 't');
    file(DB2, MIG);   // and installs again
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); run('postgres', `drop database if exists ${DB2}`); } catch (e) {}
  console.log(`\nacademy-m4.pg: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
})();
