/* HCPS Academy — Student view (Command Center "View as a student"). Real academy-admin-api handler against a local
   Postgres with A1 and M1–M7 exactly as committed (test/academy-pgrest.js). Proves: administrators only; the lesson comes
   in LEARNER mode (no staff badge or warnings inside it, warnings beside it); drafts can be walked; the sample exam is drawn
   by the real exam's rules (every module, distribution, unverified facts held back), carries no answer key, explanation or
   tags, is graded on the server, and NOTHING is written anywhere.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=localtest node test/academy-student-view.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { shim, BASE } = require('./academy-pgrest.js');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

const DB = 'academy_sv_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, fixture());
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);`);
file(DB, SUP('academy_a1_foundation.sql'));
run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql']) file(DB, SUP(f));
run(DB, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}')`);
run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)");

const op = sql => JSON.parse(run(DB, `select ${sql}`));
const C = op(`academy_content_op_create_course(${PRES}, null, ${J({ slug: 'dealer-sales-basics', title: 'Dealer Sales Basics', course_type: 'hcps_certification' })})`).id;
const V = op(`academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":3}')`).id;
const M1 = op(`academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Module A' })})`).id;
const M2 = op(`academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Module B' })})`).id;
const Q = (mod, use, key, tag) => op(`academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: mod, kind: 'single', use, prompt: use + ' Q ' + tag + '?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: key, explanation: 'SECRET-' + tag, objective_tags: [tag] })})`).id;
const EX = [Q(M1, 'exam', 'a', 'mod-a-1'), Q(M1, 'exam', 'b', 'mod-a-2'), Q(M2, 'exam', 'a', 'mod-b-1'), Q(M2, 'exam', 'b', 'mod-b-2')];
const PQ = Q(M1, 'practice', 'a', 'practice'), PQ2 = Q(M1, 'practice', 'b', 'practice2');
const L1 = op(`academy_content_op_create_lesson(${PRES}, null, '${M1}', ${J({ title: 'Lesson one', est_minutes: 10 })})`).id;
const L2 = op(`academy_content_op_create_lesson(${PRES}, null, '${M2}', ${J({ title: 'Lesson two', est_minutes: 12 })})`).id;
run(DB, `select academy_author_op_set_blocks(${PRES}, '${L1}', ${J([{ kind: 'text', heading: 'Hello', body: 'Welcome.' }, { kind: 'check', question_ids: [PQ, PQ2] }, { kind: 'image', placeholder: 'Chair photo to be added', alt: 'A lift chair in a living room' }])})`);
run(DB, `select academy_author_op_set_blocks(${PRES}, '${L2}', ${J([{ kind: 'text', heading: 'Two', body: 'More.' }])})`);
// a second course's lesson (must not be readable through this version)
const C2 = op(`academy_content_op_create_course(${PRES}, null, ${J({ slug: 'other-course', title: 'Other', course_type: 'hcps_certification' })})`).id;
const V2 = op(`academy_content_op_create_version(${PRES}, null, '${C2}', null)`).id;
const M3 = op(`academy_content_op_create_module(${PRES}, null, '${V2}', ${J({ title: 'X' })})`).id;
const L3 = op(`academy_content_op_create_lesson(${PRES}, null, '${M3}', ${J({ title: 'Other lesson', est_minutes: 5 })})`).id;

const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example', rep: 'rep@test.example', old: 'former@test.example' } });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
global.fetch = S.fetch;
const ADMIN = require('../netlify/functions/academy-admin-api.js');
async function admin(tok, body, method) {
  const out = await ADMIN.handler({ httpMethod: method || 'POST', headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: method === 'GET' ? null : JSON.stringify(body),
    queryStringParameters: method === 'GET' ? body : {} });
  let j = null; try { j = JSON.parse(out.body); } catch (e) { j = out.body; }
  return { status: out.statusCode, body: j };
}
const snapshot = () => run(DB, `select string_agg(t || '=' || n, ',' order by t) from (
  select 'events' t, count(*) n from academy_events union all select 'learners', count(*) from academy_learners
  union all select 'enrollments', count(*) from academy_enrollments union all select 'progress', count(*) from academy_progress
  union all select 'attempts', count(*) from academy_attempts union all select 'certificates', count(*) from academy_certificates
  union all select 'questions', count(*) from academy_questions union all select 'lessons', count(*) from academy_lessons) x`);

(async () => {
  try {
    const before = snapshot();
    await t('administrators only: a rep, a former admin and no sign-in are refused', async () => {
      for (const tok of ['rep', 'old', null]) {
        const r = await admin(tok, { action: 'student_course', version_id: V });
        assert.ok(r.status === 401 || r.status === 403, String(tok) + ' ' + r.status);
      }
      assert.strictEqual((await admin('adm', { action: 'student_course', version_id: V })).status, 200, 'any administrator may review');
    });
    await t('catalog lists every course version (drafts included), no manufacturer programs', async () => {
      const r = await admin('pres', { action: 'student_catalog' }); assert.strictEqual(r.status, 200);
      const c = r.body.courses.find(x => x.id === C); assert.deepStrictEqual(c.versions.map(v => v.status), ['draft']);
    });
    await t('course page: outline in order, exam policy, readiness; a DRAFT can be walked', async () => {
      const r = await admin('pres', { action: 'student_course', version_id: V }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.version.status, 'draft');
      assert.deepStrictEqual(r.body.modules.map(m => m.title + ':' + m.lessons.map(l => l.title).join('|')), ['Module A:Lesson one', 'Module B:Lesson two']);
      assert.strictEqual(r.body.exam.usable, 4); assert.strictEqual(r.body.exam.ready, true);
      assert.strictEqual(r.body.version.time_limit_minutes, 45);
      assert.ok(!JSON.stringify(r.body).includes('SECRET'), 'no explanation leaks');
    });
    await t('lesson in LEARNER mode: no staff badge / warnings inside the player; warnings returned beside it; prev / next', async () => {
      const r = await admin('pres', { action: 'student_lesson', lesson_id: L1, version_id: V }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.lesson.mode, 'learner'); assert.strictEqual(r.body.lesson.warnings, undefined);
      assert.ok(Array.isArray(r.body.staff_warnings), 'staff warnings come beside the lesson');
      assert.strictEqual(r.body.prev_lesson_id, null); assert.strictEqual(r.body.next_lesson_id, L2);
      const txt = JSON.stringify(r.body.lesson); assert.ok(!txt.includes('SECRET') && !txt.includes('answer_key'), 'no key or explanation in the payload');
      const r2 = await admin('pres', { action: 'student_lesson', lesson_id: L2, version_id: V }); assert.strictEqual(r2.body.prev_lesson_id, L1); assert.strictEqual(r2.body.next_lesson_id, null);
      assert.strictEqual((await admin('pres', { action: 'student_lesson', lesson_id: L3, version_id: V })).status, 404, 'a lesson of another version is refused');
      const pc = await admin('pres', { action: 'preview_check', lesson_id: L1, question_id: PQ, answer: 'a' }); assert.strictEqual(pc.body.correct, true);
    });
    await t('sample exam: POST only; every module represented; prompts and choices only — no key, explanation or tags', async () => {
      assert.strictEqual((await admin('pres', { action: 'student_exam_draw', version_id: V }, 'GET')).status, 405);
      for (let k = 0; k < 8; k++) {
        const r = await admin('pres', { action: 'student_exam_draw', version_id: V }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.questions.length, 3);
        const mods = new Set(r.body.questions.map(q => EX.indexOf(q.id) < 2 ? 'A' : 'B')); assert.strictEqual(mods.size, 2, 'both modules every time');
        for (const q of r.body.questions) assert.deepStrictEqual(Object.keys(q).sort(), ['choices', 'id', 'kind', 'prompt']);
        assert.ok(!JSON.stringify(r.body).includes('SECRET') && !JSON.stringify(r.body).includes('objective_tags') && !JSON.stringify(r.body).includes('answer_key'));
      }
    });
    await t('sample exam grading: on the server, pass mark as the real exam, topics, staff review; recorded nowhere', async () => {
      const ids = [EX[0], EX[1], EX[2]];
      const all = await admin('pres', { action: 'student_exam_grade', version_id: V, question_ids: ids, answers: { [EX[0]]: 'a', [EX[1]]: 'b', [EX[2]]: 'a' } });
      assert.strictEqual(all.status, 200, JSON.stringify(all.body)); assert.strictEqual(all.body.score, 100); assert.strictEqual(all.body.passed, true); assert.strictEqual(all.body.recorded, false);
      const some = await admin('pres', { action: 'student_exam_grade', version_id: V, question_ids: ids, answers: { [EX[0]]: 'a', [EX[1]]: 'a' } });
      assert.strictEqual(some.body.score, 33); assert.strictEqual(some.body.passed, false, '1 of 3 is below 80%');
      assert.deepStrictEqual(some.body.study_topics, ['mod-a-2', 'mod-b-1']);
      assert.deepStrictEqual(some.body.staff_review.map(x => (x.correct ? 'y' : 'n') + (x.answered ? '' : '-')), ['y', 'n', 'n-']);
      assert.strictEqual((await admin('pres', { action: 'student_exam_grade', version_id: V, question_ids: [PQ], answers: {} })).status, 400, 'practice questions are not exam questions');
      assert.strictEqual((await admin('pres', { action: 'student_exam_grade', version_id: V2, question_ids: ids, answers: {} })).status, 400, 'another version\'s questions are refused');
      assert.strictEqual((await admin('pres', { action: 'student_exam_grade', version_id: V, question_ids: [EX[0], EX[0]], answers: {} })).status, 400, 'duplicates refused');
    });
    await t('the real exam\'s rules: a distribution that does not add up, or a module with no usable question, is reported — not drawn', async () => {
      run(DB, `select set_config('academy.op','x',true); update academy_modules set exam_quota = 1 where id = '${M1}';`);
      let r = await admin('pres', { action: 'student_course', version_id: V });
      assert.strictEqual(r.body.exam.ready, false); assert.match(r.body.exam.problem, /Module B.*no number of questions/);
      run(DB, `select set_config('academy.op','x',true); update academy_modules set exam_quota = 2 where id = '${M2}';`);
      r = await admin('pres', { action: 'student_exam_draw', version_id: V }); assert.strictEqual(r.body.ok, true);
      assert.deepStrictEqual(r.body.questions.map(q => EX.indexOf(q.id) < 2 ? 'A' : 'B').sort(), ['A', 'B', 'B'], 'exactly the distribution');
      run(DB, `select set_config('academy.op','x',true); update academy_modules set exam_quota = null where id in ('${M1}','${M2}');`);
      run(DB, `select set_config('academy.op','x',true); update academy_questions set status = 'retired' where id in ('${EX[2]}','${EX[3]}');`);
      r = await admin('pres', { action: 'student_exam_draw', version_id: V }); assert.strictEqual(r.body.ok, false); assert.match(r.body.problem, /Module B.*no usable exam question/);
      run(DB, `select set_config('academy.op','x',true); update academy_questions set status = 'active' where id in ('${EX[2]}','${EX[3]}');`);
    });
    await t('a question that uses an UNVERIFIED product fact is held back, exactly as the real exam does', async () => {
      run(DB, `select set_config('academy.op','x',true);
        insert into product_facts (id, manufacturer_slug, model_code, field, value, field_class, status, source_url, source_label, verified_on, verified_by)
        values ('00000000-0000-0000-0000-00000000f001', 'golden-technologies', 'PR511', 'weight_capacity', '375', 'display', 'awaiting_manufacturer', 'https://www.goldentech.com/', 'Golden', current_date, 'staff:admin@test.example');
        insert into academy_content_refs (version_id, question_id, manufacturer_slug, model_code, field, pinned_fact_id)
        values ('${V}', '${EX[3]}', 'golden-technologies', 'PR511', 'weight_capacity', '00000000-0000-0000-0000-00000000f001');`);
      const r = await admin('pres', { action: 'student_course', version_id: V }); assert.strictEqual(r.body.exam.usable, 3); assert.strictEqual(r.body.exam.held_unverified, 1);
      for (let k = 0; k < 6; k++) { const d = await admin('pres', { action: 'student_exam_draw', version_id: V }); assert.ok(!d.body.questions.some(q => q.id === EX[3]), 'never drawn'); }
      const db = run(DB, `select '${EX[3]}' = any (academy_author_exam_draw('${V}', false))`); assert.strictEqual(db, 'f', 'the database draw agrees');
    });
    await t('the database draw agrees: the same eligible questions as academy_author_exam_draw', async () => {
      const db = run(DB, `select array_length(academy_author_exam_draw('${V}', false), 1)`);
      assert.strictEqual(db, '3');
      const r = await admin('pres', { action: 'student_course', version_id: V }); assert.strictEqual(r.body.exam.usable, 3); assert.strictEqual(r.body.exam.ready, true);
    });
    await t('nothing was written: no event, learner, enrollment, progress, attempt or certificate', async () => {
      assert.strictEqual(snapshot(), before, 'every count identical, the audit history included');
    });
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    run('postgres', `drop database if exists ${DB} with (force)`);
    process.exit(fail ? 1 : 0);
  }
})();
