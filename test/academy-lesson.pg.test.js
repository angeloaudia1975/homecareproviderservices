/* HCPS Academy A2D Stage 2 — Samples A and B against the REAL database rules. In a local Postgres with A1, M1, M2 and M3
   installed exactly as the committed files, each sample is stored the only way a lesson can be stored: a draft course and
   version (M2), its product facts (M1 record_fact), its practice questions and fact links (M3), and finally its blocks
   through academy_author_op_set_blocks — which runs M3's block checker. Then the lesson is read back the way the preview
   reads it (no answer key, no explanation) and drawn by the same payload builder: the result must equal the sample's own
   preview payload. This proves the samples are real lesson data, not a mock-up, and that preview_lesson draws stored
   lessons exactly as it draws the samples. Local database only; skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-lesson.pg.test.js
   PG17 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1. */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const LESSON = require('../netlify/functions/_academy_lesson.js');
const { SAMPLES } = require('../netlify/functions/_academy_samples.js');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const ACT = `'staff:admin@test.example'`;

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 10).join('\n       ')); } }

const DB = 'academy_lesson_' + process.pid;
try {
  run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
  run(DB, fixture());
  file(DB, SUP('academy_a1_foundation.sql'));
  run(DB, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql']) file(DB, SUP(f));

  const course = JSON.parse(run(DB, `select academy_content_op_create_course(${ACT}, null, ${J({ slug: 'golden-lift-chair-sales', title: 'Golden Lift Chair Sales Certification', course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`));
  const version = JSON.parse(run(DB, `select academy_content_op_create_version(${ACT}, null, '${course.id}'::uuid, null)`));
  const modules = {};
  for (let p = 1; p <= 11; p++) modules[p] = JSON.parse(run(DB, `select academy_content_op_create_module(${ACT}, null, '${version.id}'::uuid, ${J({ title: SAMPLES.A.outline[p - 1].title })})`));
  const recorded = new Set();

  for (const k of ['A', 'B']) {
    const S = SAMPLES[k];
    t(`Sample ${k}: stored through the real M1/M2/M3 operations — facts, practice questions, fact links, then the blocks pass M3's block checker unchanged`, () => {
      const mod = modules[S.module.position];
      const lesson = JSON.parse(run(DB, `select academy_content_op_create_lesson(${ACT}, '${S.lesson.id}'::uuid, '${mod.id}'::uuid, ${J({ title: S.lesson.title, est_minutes: S.lesson.est_minutes })})`));
      for (const f of S.facts) {
        const key = `${f.model_code}|${f.field}`; if (recorded.has(key)) continue; recorded.add(key);
        const fact = { manufacturer_slug: f.manufacturer_slug, model_code: f.model_code, field: f.field, value: f.value, field_class: 'display', status: f.status,
                       source_url: f.source_url, source_label: f.source_label, verified_on: f.verified_on, verified_by: 'staff:admin@test.example' };
        if (f.unit) fact.unit = f.unit; if (f.note) fact.note = f.note;
        run(DB, `select academy_op_record_fact(${ACT}, ${J(fact)}, null, null)`);
      }
      for (const q of S.questions) run(DB, `select academy_author_op_create_question(${ACT}, '${q.id}'::uuid, '${version.id}'::uuid, ${J({ kind: q.kind, use: 'practice', prompt: q.prompt, choices: q.choices, answer_key: q.answer_key, explanation: q.explanation, objective_tags: q.objective_tags, module_id: mod.id })})`);
      const links = new Set();
      for (const b of S.lesson.blocks) {
        if (b.kind === 'fact') links.add(`${b.model_code}|${b.field}`);
        if (b.kind === 'comparison') for (const m of b.models) for (const f of b.fields) links.add(`${m}|${f.field}`);
      }
      for (const l of links) { const [model, field] = l.split('|'); run(DB, `select academy_author_op_link_fact(${ACT}, null, ${J({ lesson_id: lesson.id, manufacturer_slug: 'golden-technologies', model_code: model, field })})`); }
      const saved = JSON.parse(run(DB, `select academy_author_op_set_blocks(${ACT}, '${lesson.id}'::uuid, ${J(S.lesson.blocks)})`));
      const stored = JSON.parse(run(DB, `select blocks from academy_lessons where id = '${lesson.id}'`));
      assert.deepStrictEqual(stored, JSON.parse(JSON.stringify(S.lesson.blocks)), 'M3 stored the blocks exactly as written (nothing normalized away)');
      assert.ok(saved && (saved.id || saved.blocks || saved.ok !== false));
      const audit = Number(run(DB, `select count(*) from academy_events where entity_id = '${lesson.id}' and action = 'set_blocks'`));
      assert.strictEqual(audit, 1, 'one audit row for the blocks');
      assert.strictEqual(Number(run(DB, `select count(*) from academy_events where after::text like '%answer_key%' and after::text not like '%answer_key_changed%'`)), 0, 'no answer key in any audit row');
    });
    t(`Sample ${k}: read back as preview_lesson reads it (no answer key, no explanation) and drawn by the payload builder = the sample's own preview payload`, () => {
      const L = JSON.parse(run(DB, `select row_to_json(x) from (select id, module_id, position, title, est_minutes, blocks from academy_lessons where id = '${S.lesson.id}') x`));
      const facts = JSON.parse(run(DB, `select coalesce(json_agg(row_to_json(x)), '[]') from (select manufacturer_slug, model_code, field, value, unit, status, source_url, source_label, verified_on::text, note, valid_to from product_facts where valid_to is null) x`));
      const qs = JSON.parse(run(DB, `select coalesce(json_agg(row_to_json(x)), '[]') from (select id, version_id, use, status, kind, prompt, choices from academy_questions) x`));
      assert.ok(qs.every(q => !('answer_key' in q) && !('explanation' in q)));
      const common = { mode: 'preview', course: S.course, module: S.module, outline: S.outline, manufacturers: { 'golden-technologies': 'Golden' } };
      const fromDb = LESSON.buildLesson(Object.assign({}, common, { lesson: Object.assign({}, S.lesson, { blocks: L.blocks }), facts, questions: qs }));
      const fromSample = LESSON.buildLesson(Object.assign({}, common, { lesson: S.lesson, facts: S.facts, questions: S.questions }));
      assert.deepStrictEqual(fromDb, fromSample);
      assert.deepStrictEqual(fromDb.warnings, []);
    });
  }
  t('the database refuses the samples if an exam question is put in a knowledge check (it would show its answer in a lesson)', () => {
    const exam = JSON.parse(run(DB, `select academy_author_op_create_question(${ACT}, null, '${version.id}'::uuid, ${J({ kind: 'single', use: 'exam', prompt: 'An exam question', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: 'e', objective_tags: ['x'], module_id: modules[4].id })})`));
    const blocks = JSON.parse(JSON.stringify(SAMPLES.A.lesson.blocks));
    blocks.find(b => b.kind === 'check').question_ids[0] = exam.id;
    assert.throws(() => run(DB, `select academy_author_op_set_blocks(${ACT}, '${SAMPLES.A.lesson.id}'::uuid, ${J(blocks)})`), /only active practice questions/);
  });
} finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* best effort */ } }
console.log(`\nacademy-lesson.pg: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
