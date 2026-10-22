/* HCPS Academy A2D Stage 3 — the Course Builder's server actions against the REAL database rules. A local Postgres holds
   A1, M1, M2 and M3 exactly as committed (pg-safeupdate loaded, as Supabase's API sessions do); the real
   academy-admin-api.js handler runs unchanged and its Supabase calls are answered by test/academy-pgrest.js, which calls
   the real database functions and reads the real tables. So every builder write below goes through the audited M2/M3
   operations and every refusal is the database's own. Local database only; skipped when there is no server.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-builder.pg.test.js
   PG17 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1. */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { shim, BASE } = require('./academy-pgrest.js');
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
const G = 'golden-technologies';

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

const DB = 'academy_builder_' + process.pid;
function setup() {
  run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
  run(DB, fixture());
  file(DB, SUP('academy_a1_foundation.sql'));
  run(DB, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql']) file(DB, SUP(f));
  run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true), ('relations@test.example', 'Rel', 'relations', true)");
  run(DB, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
}
setup();

const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example', rep: 'rep@test.example', rel: 'relations@test.example' } });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-admin-api.js');
const B = require('../netlify/functions/_academy_builder.js');
async function call(tok, body, o) {
  o = o || {};
  const headers = Object.assign({ origin: 'https://www.homecareproviderservices.org' }, tok ? { authorization: 'Bearer ' + tok } : {}, o.headers || {});
  const out = await API.handler({ httpMethod: o.method || 'POST', headers, body: o.raw != null ? o.raw : JSON.stringify(body), queryStringParameters: o.query || {} });
  let j = null; try { j = out.body ? JSON.parse(out.body) : null; } catch (e) { j = out.body; }
  return { status: out.statusCode, body: j, raw: out.body };
}
const ok = (r, what) => { assert.strictEqual(r.status, 200, (what || '') + ' ' + JSON.stringify(r.body)); return r.body; };
const events = (where) => JSON.parse(run(DB, `select coalesce(json_agg(row_to_json(e) order by id), '[]') from academy_events e ${where ? 'where ' + where : ''}`));
const one = q => JSON.parse(run(DB, `select coalesce(row_to_json(x), 'null') from (${q}) x`));

(async () => {
  let course, version, mods = [], lessons = {};
  try {
    /* ------------------------------------------------------------- the gate */
    await t('the gate: no sign-in 401; a rep or Relations 403; switch off -> 403 flag_off; the builder actions exist only behind it', async () => {
      assert.strictEqual((await call(null, { action: 'builder', version_id: SAMPLES.A.lesson.id })).status, 401);
      assert.strictEqual((await call('rep', { action: 'builder', version_id: SAMPLES.A.lesson.id })).status, 403);
      assert.strictEqual((await call('rel', { action: 'save_blocks', lesson_id: SAMPLES.A.lesson.id, blocks: [] })).status, 403);
      run(DB, `update app_settings set value = '{"academy_admin": false}' where key = 'phase2_flags'`);
      const r = await call('pres', { action: 'builder', version_id: SAMPLES.A.lesson.id });
      assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'flag_off');
      run(DB, `update app_settings set value = '{"academy_admin": true}' where key = 'phase2_flags'`);
      for (const a of Object.keys(B.READ).concat(Object.keys(B.WRITE))) assert.ok(API._actions[a], a + ' is registered');
      for (const a of Object.keys(B.WRITE)) assert.strictEqual(API._actions[a].write, true, a + ' is a write (POST only)');
      const g = await call('pres', null, { method: 'GET', query: { action: 'save_blocks' } });
      assert.strictEqual(g.status, 405, 'a builder write sent as GET is refused');
    });

    /* ------------------------------------------------------------- course, version, outline through the existing M2 actions */
    await t('a draft course, version, modules and lessons (M2 operations); builder read: editable, President, empty readiness says what is missing', async () => {
      course = ok(await call('pres', { action: 'create_course', slug: 'golden-lift-chair-sales', title: 'Golden Lift Chair Sales Certification', course_type: 'hcps_certification', manufacturer_slug: G })).course;
      version = ok(await call('pres', { action: 'create_version', course_id: course.id, pass_mark: 80, exam_questions: 3 })).version;
      let r = ok(await call('pres', { action: 'builder', version_id: version.id }));
      assert.strictEqual(r.editable, true); assert.strictEqual(r.president, true);
      assert.strictEqual(r.readiness.ready, false); assert.ok(r.readiness.items.some(x => /no modules/.test(x.message)));
      for (const title of ['Welcome', 'Comfort Zones', 'The Cloud family']) mods.push(ok(await call('pres', { action: 'create_module', version_id: version.id, title })).module);
      lessons.A = ok(await call('pres', { action: 'create_lesson', module_id: mods[1].id, title: SAMPLES.A.lesson.title, est_minutes: 14 })).lesson;
      lessons.B = ok(await call('pres', { action: 'create_lesson', module_id: mods[2].id, title: SAMPLES.B.lesson.title, est_minutes: 14 })).lesson;
      lessons.B2 = ok(await call('pres', { action: 'create_lesson', module_id: mods[2].id, title: 'Fitting the chair', est_minutes: 10 })).lesson;
      r = ok(await call('adm', { action: 'builder', version_id: version.id }));
      assert.strictEqual(r.president, false, 'a non-President administrator is told so');
      assert.strictEqual(r.editable, false, 'until M3.1 a non-President administrator opens a draft read only');
      const evN = Number(run(DB, 'select count(*) from academy_events'));
      for (const b of [{ action: 'save_blocks', lesson_id: lessons.A.id, blocks: [], base_hash: B.blocksHash([]) }, { action: 'create_module', version_id: version.id, title: 'Nope' },
                       { action: 'reorder_modules', version_id: version.id, order: mods.map(m => m.id) }, { action: 'set_distribution', version_id: version.id, quotas: null }]) {
        const x = await call('adm', b); assert.strictEqual(x.status, 403, b.action); assert.strictEqual(x.body.error, 'president_only', b.action);
      }
      assert.strictEqual(Number(run(DB, 'select count(*) from academy_events')), evN, 'a refused non-President write records nothing');
      assert.strictEqual(r.modules.length, 3); assert.strictEqual(r.lessons.length, 3);
      assert.ok(r.lessons.every(l => /^[0-9a-f]{32}$/.test(l.hash)));
    });

    /* ------------------------------------------------------------- facts + practice questions (as the Golden course will hold them) */
    const seen = new Set();
    for (const k of ['A', 'B']) for (const f of SAMPLES[k].facts) {
      const key = f.model_code + '|' + f.field; if (seen.has(key)) continue; seen.add(key);
      const fact = { manufacturer_slug: f.manufacturer_slug, model_code: f.model_code, field: f.field, value: f.value, field_class: 'display', status: f.status, source_url: f.source_url, source_label: f.source_label, verified_on: f.verified_on, verified_by: 'staff:admin@test.example' };
      if (f.unit) fact.unit = f.unit; if (f.note) fact.note = f.note;
      run(DB, `select academy_op_record_fact(${ACT}, ${J(fact)}, null, null)`);
    }
    for (const k of ['A', 'B']) for (const q of SAMPLES[k].questions) {
      const mod = k === 'A' ? mods[1] : mods[2];
      run(DB, `select academy_author_op_create_question(${ACT}, '${q.id}'::uuid, '${version.id}'::uuid, ${J({ kind: q.kind, use: 'practice', prompt: q.prompt, choices: q.choices, answer_key: q.answer_key, explanation: q.explanation, objective_tags: q.objective_tags, module_id: mod.id })})`);
    }

    /* ------------------------------------------------------------- screens */
    await t('save_blocks (M3.1): Sample A saved in ONE database operation through the real block checker; its fact and comparison cells linked in the same transaction; ONE audit row; the saved hash is returned', async () => {
      const r0 = ok(await call('pres', { action: 'builder', version_id: version.id }));
      const base = r0.lessons.find(l => l.id === lessons.A.id).hash;
      const r = ok(await call('pres', { action: 'save_blocks', lesson_id: lessons.A.id, blocks: SAMPLES.A.lesson.blocks, base_hash: base }), 'save A');
      assert.deepStrictEqual(r.lesson.blocks, JSON.parse(JSON.stringify(SAMPLES.A.lesson.blocks)));
      assert.strictEqual(r.lesson.hash, B.blocksHash(SAMPLES.A.lesson.blocks));
      const cells = new Set(); for (const b of SAMPLES.A.lesson.blocks) { if (b.kind === 'fact') cells.add(b.model_code + b.field); if (b.kind === 'comparison') for (const m of b.models) for (const f of b.fields) cells.add(m + f.field); }
      assert.strictEqual(r.facts_linked, cells.size);
      assert.strictEqual(Number(run(DB, `select count(*) from academy_content_refs where lesson_id = '${lessons.A.id}'`)), cells.size);
      const sv = events(`entity_id = '${lessons.A.id}' and action = 'save_lesson'`);
      assert.strictEqual(sv.length, 1, 'one audit row for the screens and their links');
      assert.strictEqual(sv[0].after._links.added.length, cells.size, 'the links are listed in that row');
      assert.strictEqual(events(`action in ('set_blocks', 'link_fact')`).length, 0, 'no separate link or set_blocks rows');
      assert.ok(sv.every(e => e.actor === 'staff:admin@test.example'), 'the actor is the signed-in President');
      // saving the same content again links nothing new
      const again = ok(await call('pres', { action: 'save_blocks', lesson_id: lessons.A.id, blocks: SAMPLES.A.lesson.blocks, base_hash: r.lesson.hash }));
      assert.strictEqual(again.facts_linked, 0);
    });
    await t('save_blocks: a save that does not start from the current content is refused 409 "changed" and changes nothing', async () => {
      const before = one(`select blocks from academy_lessons where id = '${lessons.A.id}'`).blocks;
      const r = await call('pres', { action: 'save_blocks', lesson_id: lessons.A.id, blocks: [{ kind: 'objectives', items: ['a b', 'c d'] }], base_hash: B.blocksHash([]) });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'changed');
      assert.deepStrictEqual(one(`select blocks from academy_lessons where id = '${lessons.A.id}'`).blocks, before);
      const r2 = await call('pres', { action: 'save_blocks', lesson_id: lessons.A.id, blocks: [], base_hash: undefined });
      assert.strictEqual(r2.status, 409, 'no base hash = refused');
    });
    await t('save_blocks refused by the database (objectives not first) -> 400 with its message; the fact link it needed was never kept (same transaction); no audit row', async () => {
      const base = B.blocksHash([]);
      const refsBefore = Number(run(DB, `select count(*) from academy_content_refs`));
      const blocks = [{ kind: 'text', heading: 'Intro', body: 'x' }, { kind: 'objectives', items: ['one thing', 'another'] }, { kind: 'fact', manufacturer_slug: G, model_code: 'PR515', field: 'weight_capacity', label: 'Capacity' }];
      const r = await call('pres', { action: 'save_blocks', lesson_id: lessons.B2.id, blocks, base_hash: base });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.message, /objectives come first/);
      assert.strictEqual(Number(run(DB, `select count(*) from academy_content_refs`)), refsBefore, 'the link created for the refused save rolled back with it');
      assert.deepStrictEqual(one(`select blocks from academy_lessons where id = '${lessons.B2.id}'`).blocks, []);
      assert.strictEqual(events(`coalesce(after::text, '') like '%PR515%' or coalesce(before::text, '') like '%PR515%'`).length, 0, 'nothing about the refused save is in the history');
    });
    await t('hostile text: HTML in a screen is refused by the database; nothing stored', async () => {
      const r = await call('pres', { action: 'save_blocks', lesson_id: lessons.B2.id, blocks: [{ kind: 'objectives', items: ['<img src=x onerror=alert(1)>', 'b c'] }, { kind: 'takeaways', items: ['a', 'b', 'c'] }], base_hash: B.blocksHash([]) });
      assert.strictEqual(r.status, 400); assert.match(r.body.message, /HTML/);
      assert.deepStrictEqual(one(`select blocks from academy_lessons where id = '${lessons.B2.id}'`).blocks, []);
    });
    await t('the acting person is the sign-in, never the request: actor / p_actor fields in a request are ignored', async () => {
      const cur = B.blocksHash(one(`select blocks from academy_lessons where id = '${lessons.B.id}'`).blocks);
      ok(await call('pres', { action: 'save_blocks', lesson_id: lessons.B.id, blocks: SAMPLES.B.lesson.blocks, base_hash: cur, actor: 'staff:admin2@test.example', p_actor: 'staff:admin2@test.example' }));
      const ev = events(`entity_id = '${lessons.B.id}' and action = 'save_lesson'`);
      assert.strictEqual(ev[ev.length - 1].actor, 'staff:admin@test.example');
    });

    /* ------------------------------------------------------------- failure injection: the M3.1 atomic save */
    let F;
    const fblocks = (extra) => [{ kind: 'objectives', items: ['Fit the chair', 'Explain the fit'] }].concat(extra || []).concat([{ kind: 'takeaways', items: ['a', 'b', 'c'] }]);
    const capFact = { kind: 'fact', manufacturer_slug: G, model_code: 'PR515', field: 'weight_capacity', label: 'Capacity' };
    const refsOf = id => Number(run(DB, `select count(*) from academy_content_refs where lesson_id = '${id}'`));
    const hashOf = id => B.blocksHash(one(`select blocks from academy_lessons where id = '${id}'`).blocks);
    const blocksAt = id => one(`select blocks from academy_lessons where id = '${id}'`).blocks;
    const saveSql = (id, base, blocks) => S.sql(`select academy_save_op_lesson('staff:admin@test.example', '${id}'::uuid, ${J(base)}, ${J(blocks)})`);
    const once = (name, fn) => { let used = false; S.onRpc = async (f, a) => { if (f !== name || used) return null; used = true; return fn(a); }; };
    await t('failure injection: the screens cannot be written after the links were created (a refusing trigger) -> everything rolls back: no link, no screens, no audit row', async () => {
      F = ok(await call('pres', { action: 'create_lesson', module_id: mods[2].id, title: 'Failure injection', est_minutes: 10 })).lesson;
      const evBefore = events().length;
      run(DB, `create function zz_b_refuse() returns trigger language plpgsql as $f$ begin raise exception 'injected: disk full'; end $f$;
               create trigger zz_b_refuse before update on academy_lessons for each row execute function zz_b_refuse()`);
      let r; try { r = await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks([capFact]), base_hash: B.blocksHash([]) }); }
      finally { run(DB, 'drop trigger zz_b_refuse on academy_lessons; drop function zz_b_refuse()'); }
      assert.strictEqual(r.status, 502, JSON.stringify(r.body)); assert.strictEqual(r.body.error, 'write_failed');
      assert.strictEqual(refsOf(F.id), 0, 'the link created inside the save rolled back');
      assert.deepStrictEqual(blocksAt(F.id), []);
      assert.strictEqual(events().length, evBefore, 'no audit row: nothing happened');
    });
    await t('failure injection: the audit history refuses the row -> the whole save rolls back (screens and links)', async () => {
      const evBefore = events().length;
      run(DB, `create function zz_b_refuse() returns trigger language plpgsql as $f$ begin raise exception 'injected: audit store unavailable'; end $f$;
               create trigger zz_b_refuse before insert on academy_events for each row execute function zz_b_refuse()`);
      let r; try { r = await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks([capFact]), base_hash: B.blocksHash([]) }); }
      finally { run(DB, 'drop trigger zz_b_refuse on academy_events; drop function zz_b_refuse()'); }
      assert.strictEqual(r.status, 502); assert.strictEqual(refsOf(F.id), 0); assert.deepStrictEqual(blocksAt(F.id), []); assert.strictEqual(events().length, evBefore);
    });
    await t('failure injection: someone saves between this request\'s read and the database call -> the database refuses "changed" under its lock; their version stays; ours never written, not even for a moment', async () => {
      const theirs = fblocks([{ kind: 'text', heading: 'Theirs', body: 'Saved at the same moment' }]);
      once('academy_save_op_lesson', () => { saveSql(F.id, [], theirs); return null; });   // their save lands first, then ours runs
      const evBefore = events(`entity_id = '${F.id}'`).length;
      const r = await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks([capFact, { kind: 'text', heading: 'Mine', body: 'x' }]), base_hash: B.blocksHash([]) });
      S.onRpc = null;
      assert.strictEqual(r.status, 409, JSON.stringify(r.body)); assert.strictEqual(r.body.error, 'changed'); assert.match(r.body.message, /saved by someone else/);
      assert.strictEqual(blocksAt(F.id)[1].heading, 'Theirs');
      const ev = events(`entity_id = '${F.id}'`).slice(evBefore);
      assert.deepStrictEqual(ev.map(e => e.action), ['save_lesson'], 'only their save is in the history: no overwrite, no put-back');
      assert.strictEqual(refsOf(F.id), 0, 'our fact link was never kept');
    });
    await t('failure injection: the save succeeds but its answer is lost -> "reload" (not "nothing changed"); the saved screens keep their facts', async () => {
      const base = blocksAt(F.id);
      once('academy_save_op_lesson', a => { saveSql(F.id, base, a.p_blocks); return { status: 502, body: { message: 'injected: answer lost' } }; });
      const r = await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks([capFact]), base_hash: B.blocksHash(base) });
      S.onRpc = null;
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'reload');
      assert.strictEqual(blocksAt(F.id)[1].kind, 'fact'); assert.strictEqual(refsOf(F.id), 1, 'the link the saved fact needs is there');
    });
    await t('failure injection: the database call fails and nothing was saved -> 502 "nothing was changed" (the screens are still the starting point)', async () => {
      const base = blocksAt(F.id);
      once('academy_save_op_lesson', () => ({ status: 502, body: { message: 'injected: connection reset' } }));
      const r = await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks(), base_hash: B.blocksHash(base) });
      S.onRpc = null;
      assert.strictEqual(r.status, 502); assert.strictEqual(r.body.error, 'write_failed'); assert.deepStrictEqual(blocksAt(F.id), base);
    });
    await t('M3.1 not installed -> 503 "not available"; never a fallback to the old multi-step save', async () => {
      once('academy_save_op_lesson', () => ({ status: 404, body: { code: 'PGRST202', message: 'Could not find the function' } }));
      const evBefore = events().length;
      const r = await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks(), base_hash: hashOf(F.id) });
      S.onRpc = null;
      assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error, 'not_installed'); assert.strictEqual(events().length, evBefore);
    });
    await t('a fact removed from the screens has its link removed by the same save (links always match the screens); exam-question links untouched', async () => {
      const q = ok(await call('pres', { action: 'create_question', version_id: version.id, question: { module_id: mods[2].id, kind: 'single', use: 'exam', prompt: 'Which capacity applies here?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'a', explanation: 'Because.', objective_tags: ['fit'] } })).question;
      const ql = ok(await call('pres', { action: 'link_question_fact', question_id: q.id, manufacturer_slug: G, model_code: 'PR515', field: 'weight_capacity' }));
      const r = ok(await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: fblocks(), base_hash: hashOf(F.id) }));
      assert.strictEqual(r.links_removed, 1); assert.strictEqual(refsOf(F.id), 0);
      assert.strictEqual(Number(run(DB, `select count(*) from academy_content_refs where question_id = '${q.id}'`)), 1, 'the question\'s link stays');
      ok(await call('pres', { action: 'unlink_fact', id: (ql.link || ql.result || ql).id }));
      ok(await call('pres', { action: 'question_status', id: q.id, status: 'retired', reason: 'Test question for the save' }));
      ok(await call('pres', { action: 'save_blocks', lesson_id: F.id, blocks: [], base_hash: hashOf(F.id) }));
      ok(await call('pres', { action: 'delete_lesson', id: F.id }));
    });

    /* ------------------------------------------------------------- live preview */
    await t('preview_blocks draws UNSAVED screens with the learner payload builder: no answer key, no explanation, nothing saved', async () => {
      const blocks = SAMPLES.A.lesson.blocks.slice(); blocks.splice(1, 0, { kind: 'text', heading: 'Unsaved', body: 'Only in the editor' });
      const before = one(`select blocks from academy_lessons where id = '${lessons.A.id}'`).blocks;
      const r = ok(await call('adm', { action: 'preview_blocks', lesson_id: lessons.A.id, blocks }));
      assert.strictEqual(r.lesson.blocks[1].heading, 'Unsaved');
      assert.ok(!/answer_key|explanation/.test(JSON.stringify(r)), 'no answer key or explanation in a preview');
      assert.deepStrictEqual(one(`select blocks from academy_lessons where id = '${lessons.A.id}'`).blocks, before);
      const big = await call('adm', { action: 'preview_blocks', lesson_id: lessons.A.id, blocks: new Array(41).fill({ kind: 'text', heading: '', body: 'x' }) });
      assert.strictEqual(big.status, 400);
    });
    await t('preview_check on unsaved screens: a practice question of this version is graded; an exam question is refused; another version\'s question 404', async () => {
      const q = SAMPLES.A.questions[0];
      const blocks = [{ kind: 'check', question_ids: [q.id, SAMPLES.A.questions[1].id] }];
      const r = ok(await call('adm', { action: 'preview_check', lesson_id: lessons.B2.id, question_id: q.id, answer: q.answer_key, blocks }));
      assert.strictEqual(r.correct, true); assert.ok(!('answer_key' in r));
      const exam = ok(await call('pres', { action: 'create_question', version_id: version.id, question: { module_id: mods[1].id, kind: 'single', use: 'exam', prompt: 'Which zone is the headrest?', choices: [{ id: 'a', text: 'Zone 3' }, { id: 'b', text: 'Zone 1' }], answer_key: 'a', explanation: 'Zone 3 is the headrest.', objective_tags: ['comfort-zones'] } })).question;
      const r2 = await call('adm', { action: 'preview_check', lesson_id: lessons.B2.id, question_id: exam.id, answer: 'a', blocks: [{ kind: 'check', question_ids: [exam.id] }] });
      assert.strictEqual(r2.status, 403); assert.strictEqual(r2.body.error, 'not_practice');
      const other = ok(await call('pres', { action: 'create_version', course_id: course.id, exam_questions: 3 })).version;
      const om = ok(await call('pres', { action: 'create_module', version_id: other.id, title: 'Other' })).module;
      const oq = ok(await call('pres', { action: 'create_question', version_id: other.id, question: { module_id: om.id, kind: 'single', use: 'practice', prompt: 'Other version question', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: 'x', objective_tags: ['x'] } })).question;
      const r3 = await call('adm', { action: 'preview_check', lesson_id: lessons.B2.id, question_id: oq.id, answer: 'a', blocks: [{ kind: 'check', question_ids: [oq.id] }] });
      assert.strictEqual(r3.status, 404);
      const r4 = await call('adm', { action: 'preview_check', lesson_id: lessons.B2.id, question_id: q.id, answer: 'a', blocks: [{ kind: 'text', body: 'no check here' }] });
      assert.strictEqual(r4.status, 404, 'a question the shown screens do not hold');
    });

    /* ------------------------------------------------------------- order */
    await t('reorder_modules / reorder_lessons through M3; audited; an incomplete order is refused by the database', async () => {
      const order = [mods[0].id, mods[2].id, mods[1].id];
      ok(await call('pres', { action: 'reorder_modules', version_id: version.id, order }));
      const pos = JSON.parse(run(DB, `select json_agg(id order by position) from academy_modules where version_id = '${version.id}'`));
      assert.deepStrictEqual(pos, order);
      assert.ok(events(`action = 'reorder_modules'`).length >= 1);
      const bad = await call('pres', { action: 'reorder_modules', version_id: version.id, order: [mods[0].id, mods[1].id] });
      assert.strictEqual(bad.status, 400);
      ok(await call('pres', { action: 'reorder_lessons', module_id: mods[2].id, order: [lessons.B2.id, lessons.B.id] }));
      assert.deepStrictEqual(JSON.parse(run(DB, `select json_agg(id order by position) from academy_lessons where module_id = '${mods[2].id}'`)), [lessons.B2.id, lessons.B.id]);
      const cross = await call('pres', { action: 'reorder_lessons', module_id: mods[2].id, order: [lessons.B2.id, lessons.A.id] });
      assert.strictEqual(cross.status, 400, 'a lesson of another module cannot be moved in');
      ok(await call('pres', { action: 'reorder_modules', version_id: version.id, order: mods.map(m => m.id) }));
    });

    /* ------------------------------------------------------------- the question bank */
    await t('question bank: create / update / retire (reason required) / restore through M3; the builder read shows answer keys (staff editor) but the Command Center version view never does', async () => {
      const q = ok(await call('pres', { action: 'create_question', version_id: version.id, question: { module_id: mods[0].id, kind: 'multi', use: 'exam', prompt: 'Which are Golden comfort features?', choices: [{ id: 'a', text: 'Zone 1' }, { id: 'b', text: 'Zone 2' }, { id: 'c', text: 'A cup holder' }], answer_key: ['b', 'a'], explanation: 'Zones 1 and 2.', objective_tags: ['comfort-zones'] } })).question;
      assert.deepStrictEqual(q.answer_key, ['a', 'b'], 'normalized by the database');
      ok(await call('pres', { action: 'update_question', id: q.id, changes: { prompt: 'Which two are Golden comfort zones?' } }));
      const noReason = await call('pres', { action: 'question_status', id: q.id, status: 'retired' });
      assert.strictEqual(noReason.status, 400);
      ok(await call('pres', { action: 'question_status', id: q.id, status: 'retired', reason: 'Reworded below' }));
      assert.strictEqual(one(`select status from academy_questions where id = '${q.id}'`).status, 'retired');
      ok(await call('pres', { action: 'question_status', id: q.id, status: 'active' }));
      const b = ok(await call('adm', { action: 'builder', version_id: version.id }));
      assert.deepStrictEqual(b.questions.find(x => x.id === q.id).answer_key, ['a', 'b']);
      const v = ok(await call('adm', { action: 'get_version', id: version.id }));
      assert.ok(!/answer_key|Zone 1|comfort zones/.test(JSON.stringify(v)), 'the version view carries counts only');
      assert.ok(!JSON.stringify(events()).includes('"answer_key":['), 'no answer key in any audit row');
      const dup = await call('pres', { action: 'create_question', version_id: version.id, question: { module_id: mods[0].id, kind: 'single', use: 'practice', prompt: 'Which two are Golden  comfort zones?', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: 'x', objective_tags: ['x'] } });
      assert.strictEqual(dup.status, 400, 'the same question as practice and exam is refused (its answer would leak)');
    });
    await t('fact links on a question: an exam question on an unverified fact is listed as blocking by readiness and is not usable', async () => {
      const q = ok(await call('pres', { action: 'create_question', version_id: version.id, question: { module_id: mods[2].id, kind: 'single', use: 'exam', prompt: 'What is the PR-515 capacity?', choices: [{ id: 'a', text: '375 lb' }, { id: 'b', text: '500 lb' }], answer_key: 'a', explanation: 'See the sell sheet.', objective_tags: ['capacity'] } })).question;
      const awaiting = SAMPLES.B.facts.find(f => f.status !== 'verified') || SAMPLES.A.facts.find(f => f.status !== 'verified');
      assert.ok(awaiting, 'the samples hold an awaiting fact');
      const link = ok(await call('pres', { action: 'link_question_fact', question_id: q.id, manufacturer_slug: awaiting.manufacturer_slug, model_code: awaiting.model_code, field: awaiting.field })).link;
      const r = ok(await call('adm', { action: 'readiness', version_id: version.id })).readiness;
      assert.ok(r.items.some(x => x.level === 'blocking' && x.question_id === q.id && /not verified/.test(x.message)));
      ok(await call('pres', { action: 'unlink_fact', id: link.id }));
      const r2 = ok(await call('adm', { action: 'readiness', version_id: version.id })).readiness;
      assert.ok(!r2.items.some(x => x.question_id === q.id));
    });

    /* ------------------------------------------------------------- distribution */
    await t('set_distribution: numbers that do not add up are refused by the database; correct numbers saved per module; null = automatic again', async () => {
      const bad = await call('pres', { action: 'set_distribution', version_id: version.id, quotas: { [mods[0].id]: 1, [mods[1].id]: 1, [mods[2].id]: 5 } });
      assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
      ok(await call('pres', { action: 'set_distribution', version_id: version.id, quotas: { [mods[0].id]: 1, [mods[1].id]: 1, [mods[2].id]: 1 } }));
      assert.deepStrictEqual(JSON.parse(run(DB, `select json_agg(exam_quota order by position) from academy_modules where version_id = '${version.id}'`)), [1, 1, 1]);
      const r = ok(await call('adm', { action: 'readiness', version_id: version.id })).readiness;
      assert.strictEqual(r.bank.mode, 'set');
      ok(await call('pres', { action: 'set_distribution', version_id: version.id, quotas: null }));
      assert.strictEqual(run(DB, `select count(*) from academy_modules where version_id = '${version.id}' and exam_quota is not null`), '0');
      const zero = await call('pres', { action: 'set_distribution', version_id: version.id, quotas: { [mods[0].id]: 0 } });
      assert.strictEqual(zero.status, 400);
    });

    /* ------------------------------------------------------------- pictures under the President's control */
    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    let upA, upB;
    await t('upload_media: the President uploads a CANDIDATE (until M3.1 other administrators are refused) (private, hash-named, never overwrites); it is not usable until approved', async () => {
      const r = ok(await call('pres', { action: 'upload_media', file_name: 'PR-446 Side View.JPG', data: jpg.toString('base64'), manufacturer_slug: G }, { headers: { 'x-academy-upload': '1' } }));
      assert.match(r.storage_path, /^media\/golden-technologies\/[0-9a-f]{16}-pr-446-side-view\.jpg$/);
      assert.strictEqual(r.approved, false); assert.ok(S.storage.has(r.storage_path)); upA = r.storage_path;
      const again = ok(await call('pres', { action: 'upload_media', file_name: 'copy.jpg', data: jpg.toString('base64'), manufacturer_slug: G }, { headers: { 'x-academy-upload': '1' } }));
      assert.notStrictEqual(again.storage_path, upA, 'another name is another file');
      const same = ok(await call('pres', { action: 'upload_media', file_name: 'PR-446 Side View.JPG', data: jpg.toString('base64'), manufacturer_slug: G }, { headers: { 'x-academy-upload': '1' } }));
      assert.strictEqual(same.already_stored, true);
      upB = ok(await call('pres', { action: 'upload_media', file_name: 'diagram.png', data: PNG.toString('base64') }, { headers: { 'x-academy-upload': '1' } })).storage_path;
      assert.match(upB, /^media\/hcps\//);
      const lib = ok(await call('adm', { action: 'media_library' }));
      assert.ok(lib.candidates.some(c => c.storage_path === upA) && lib.candidates.some(c => c.storage_path === upB));
      assert.strictEqual(lib.records.length, 0);
      // a picture block cannot use a candidate: it has no media record
      const cur = B.blocksHash(one(`select blocks from academy_lessons where id = '${lessons.B2.id}'`).blocks);
      const r2 = await call('pres', { action: 'save_blocks', lesson_id: lessons.B2.id, base_hash: cur, blocks: [{ kind: 'objectives', items: ['a b', 'c d'] }, { kind: 'image', media_id: '5a3e0000-0000-4000-8000-00000000ffff', caption: '' }, { kind: 'takeaways', items: ['a', 'b', 'c'] }] });
      assert.strictEqual(r2.status, 400);
    });
    await t('upload_media refuses: a file that is not what its name says, a non-picture type, over 3 MB, a big body without the upload header, the header on another action', async () => {
      const fake = await call('pres', { action: 'upload_media', file_name: 'evil.png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') }, { headers: { 'x-academy-upload': '1' } });
      assert.strictEqual(fake.status, 400);
      const svg = await call('pres', { action: 'upload_media', file_name: 'x.svg', data: Buffer.from('<svg/>').toString('base64') }, { headers: { 'x-academy-upload': '1' } });
      assert.strictEqual(svg.status, 400);
      const big = Buffer.concat([jpg, Buffer.alloc(3 * 1024 * 1024)]);
      const r = await call('pres', { action: 'upload_media', file_name: 'big.jpg', data: big.toString('base64') }, { headers: { 'x-academy-upload': '1' } });
      assert.ok(r.status === 413, r.status);
      const noHeader = await call('pres', { action: 'upload_media', file_name: 'mid.jpg', data: Buffer.concat([jpg, Buffer.alloc(400 * 1024)]).toString('base64') });
      assert.strictEqual(noHeader.status, 413, 'the usual 256 KB limit without the header');
      const misuse = await call('adm', { action: 'builder', version_id: version.id }, { headers: { 'x-academy-upload': '1' } });
      assert.strictEqual(misuse.status, 413, 'the larger limit is for the upload only');
      const bad = await call('pres', { action: 'upload_media', file_name: 'x.jpg', data: 'not base64!!' }, { headers: { 'x-academy-upload': '1' } });
      assert.strictEqual(bad.status, 400);
    });
    await t('import_media_url: the President copies a file from the manufacturer\'s own file server (allow-listed, no redirects); anyone else, any other host or path, a fake file and a failed download are refused', async () => {
      const CF = 'https://d3325uqufdmhie.cloudfront.net/wp-content/uploads/2023/01/18121532/1-44.jpg';
      const real = global.fetch; const seen = [];
      global.fetch = async (u, o) => {
        if (String(u).startsWith('https://d3325uqufdmhie.cloudfront.net/') || String(u).startsWith('https://goldentech.com/')) {
          seen.push({ u: String(u), redirect: o && o.redirect });
          if (/missing/.test(u)) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
          const body = /fake/.test(u) ? Buffer.from('<html>not a picture</html>') : jpg;
          return { ok: true, status: 200, headers: new Map([['content-length', String(body.length)]]), arrayBuffer: async () => body };
        }
        return real(u, o);
      };
      try {
        const r = ok(await call('pres', { action: 'import_media_url', url: CF, manufacturer_slug: G }));
        assert.match(r.storage_path, /^media\/golden-technologies\/[0-9a-f]{16}-1-44\.jpg$/); assert.strictEqual(r.source_url, CF); assert.strictEqual(r.approved, false);
        assert.ok(S.storage.has(r.storage_path)); assert.strictEqual(seen[0].redirect, 'error', 'redirects are never followed');
        const adm = await call('adm', { action: 'import_media_url', url: CF, manufacturer_slug: G });
        assert.strictEqual(adm.status, 403);
        for (const bad of ['https://evil.example/wp-content/uploads/x.jpg', 'http://d3325uqufdmhie.cloudfront.net/wp-content/uploads/x.jpg', 'https://d3325uqufdmhie.cloudfront.net/other/x.jpg', 'https://d3325uqufdmhie.cloudfront.net/wp-content/uploads/../x.jpg', 'https://d3325uqufdmhie.cloudfront.net.evil.example/wp-content/uploads/x.jpg']) {
          const x = await call('pres', { action: 'import_media_url', url: bad, manufacturer_slug: G });
          assert.strictEqual(x.status, 400, bad);
        }
        const other = await call('pres', { action: 'import_media_url', url: CF, manufacturer_slug: 'hcps' });
        assert.strictEqual(other.status, 400, 'no host list for other folders');
        const fake = await call('pres', { action: 'import_media_url', url: 'https://goldentech.com/wp-content/uploads/fake.jpg', manufacturer_slug: G });
        assert.strictEqual(fake.status, 400, 'contents must match the type');
        const svg = await call('pres', { action: 'import_media_url', url: 'https://goldentech.com/wp-content/uploads/x.svg', manufacturer_slug: G });
        assert.strictEqual(svg.status, 400);
        const miss = await call('pres', { action: 'import_media_url', url: 'https://goldentech.com/wp-content/uploads/missing.jpg', manufacturer_slug: G });
        assert.strictEqual(miss.status, 502);
        assert.strictEqual(seen.filter(x => /evil|other\/x|\.\./.test(x.u)).length, 0, 'refused links are never fetched');
        S.storage.delete(r.storage_path);   // leave the later candidate counts as they were
      } finally { global.fetch = real; }
    });
    let rec;
    await t('approve_media: the President only (a second administrator gets 403, and the database refuses a stored picture from anyone else too); alt text required unless decorative', async () => {
      const r = await call('adm', { action: 'approve_media', storage_path: upA, rights: 'manufacturer_permitted', alt_text: 'The PR-446 lift chair seen from the side, fully reclined', manufacturer_slug: G, permission_ref: 'Golden confirmation 10 Oct 2026' });
      assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'president_only');
      const direct = await S.fetch(BASE + '/rest/v1/rpc/academy_author_op_create_media', { method: 'POST', body: JSON.stringify({ p_actor: 'staff:admin2@test.example', p_id: null, p_media: { kind: 'image', storage_path: upA, rights: 'hcps_owned', alt_text: 'The PR-446 lift chair seen from the side' } }) });
      assert.ok(direct.status === 403 || direct.status === 400, 'the database refuses a non-President too: ' + direct.status);
      const ghost = await call('pres', { action: 'approve_media', storage_path: 'media/hcps/0000000000000000-not-uploaded.jpg', rights: 'hcps_owned', alt_text: 'A picture that was never uploaded to storage' });
      assert.strictEqual(ghost.status, 404, 'a file that is not in storage is never approved'); assert.strictEqual(+run(DB, `select count(*) from academy_media where storage_path like '%not-uploaded%'`).trim(), 0);
      const empty = await call('pres', { action: 'approve_media', storage_path: upA, rights: 'hcps_owned', alt_text: '' });
      assert.strictEqual(empty.status, 400); assert.match(empty.body.message, /Describe what the picture shows/, 'a missing alt text says what to do');
      const noPerm = await call('pres', { action: 'approve_media', storage_path: upA, rights: 'manufacturer_permitted', alt_text: 'The PR-446 lift chair seen from the side', manufacturer_slug: G });
      assert.strictEqual(noPerm.status, 400); assert.match(noPerm.body.message, /permission/);
      const noMfr = await call('pres', { action: 'approve_media', storage_path: upA, rights: 'manufacturer_permitted', alt_text: 'The PR-446 lift chair seen from the side', permission_ref: 'x' });
      assert.strictEqual(noMfr.status, 400); assert.match(noMfr.body.message, /manufacturer/);
      const short = await call('pres', { action: 'approve_media', storage_path: upA, rights: 'hcps_owned', alt_text: 'chair' });
      assert.strictEqual(short.status, 400, 'alt text 10–300 characters');
      const fileName = await call('pres', { action: 'approve_media', storage_path: upA, rights: 'hcps_owned', alt_text: 'pr-446-side-view.jpg' });
      assert.strictEqual(fileName.status, 400, 'alt text is not a file name');
      rec = ok(await call('pres', { action: 'approve_media', storage_path: upA, rights: 'manufacturer_permitted', alt_text: 'The PR-446 lift chair seen from the side, fully reclined', manufacturer_slug: G, permission_ref: 'Golden confirmation 10 Oct 2026' })).media;
      assert.strictEqual(rec.storage_path, upA);
      const again = await call('pres', { action: 'approve_media', storage_path: upA, rights: 'hcps_owned', alt_text: 'The PR-446 lift chair seen from the side, again' });
      assert.ok(again.status >= 400, 'a file is approved once: a repeated approval is refused (' + again.status + ')');
      const dec = ok(await call('pres', { action: 'approve_media', storage_path: upB, rights: 'hcps_owned', decorative: true })).media;
      assert.strictEqual(dec.alt_text, '');
      const lib = ok(await call('adm', { action: 'media_library' }));
      assert.strictEqual(lib.candidates.length, 1, 'only the copy is still waiting'); assert.strictEqual(lib.records.length, 2);
      assert.ok(events(`action = 'create_media'`).every(e => e.actor === 'staff:admin@test.example'));
    });
    await t('an approved picture is used in a lesson; then it cannot be removed (in use) or discarded; a candidate is discarded by the President only, with a reason, audit first', async () => {
      const cur = B.blocksHash(one(`select blocks from academy_lessons where id = '${lessons.B2.id}'`).blocks);
      ok(await call('pres', { action: 'save_blocks', lesson_id: lessons.B2.id, base_hash: cur, blocks: [{ kind: 'objectives', items: ['Fit the chair', 'Explain the fit'] }, { kind: 'image', media_id: rec.id, caption: 'Side view' }, { kind: 'takeaways', items: ['a', 'b', 'c'] }] }));
      const del = await call('pres', { action: 'delete_media', id: rec.id });
      assert.strictEqual(del.status, 409, JSON.stringify(del.body));
      const disc = await call('pres', { action: 'discard_upload', storage_path: upA, reason: 'x' });
      assert.strictEqual(disc.status, 409, 'an approved file is never discarded');
      const lib = ok(await call('adm', { action: 'media_library' }));
      const cand = lib.candidates[0].storage_path;
      { const d2 = await call('adm', { action: 'discard_upload', storage_path: cand, reason: 'duplicate' }); assert.strictEqual(d2.status, 403); assert.strictEqual(d2.body.error, 'president_only'); }
      assert.strictEqual((await call('pres', { action: 'discard_upload', storage_path: cand })).status, 400, 'a reason is required');
      ok(await call('pres', { action: 'discard_upload', storage_path: cand, reason: 'Duplicate of the side view' }));
      assert.ok(!S.storage.has(cand));
      const ev = events(`action = 'discard_upload'`);
      assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].actor, 'staff:admin@test.example'); assert.match(JSON.stringify(ev[0].after), /Duplicate of the side view/);
      assert.strictEqual((await call('pres', { action: 'discard_upload', storage_path: '../secret', reason: 'x' })).status, 400);
    });
    await t('add_link_media: a YouTube / Vimeo address becomes the privacy-enhanced embed link; another host or plain http is refused', async () => {
      const v = ok(await call('pres', { action: 'add_link_media', kind: 'video', url: 'https://www.youtube-nocookie.com/embed/abcdefgh12', title: 'AutoDrive overview', rights: 'link_only', manufacturer_slug: G })).media;
      assert.strictEqual(v.kind, 'video');
      const w = ok(await call('pres', { action: 'add_link_media', kind: 'video', url: 'https://www.youtube.com/watch?v=abcdefgh13', title: 'watch-page video', rights: 'link_only' })).media;
      assert.strictEqual(w.external_url, 'https://www.youtube-nocookie.com/embed/abcdefgh13', 'a pasted watch page is stored as the no-cookie embed');
      assert.strictEqual(ok(await call('pres', { action: 'add_link_media', kind: 'video', url: 'https://youtu.be/abcdefgh14', title: 'share-link video', rights: 'link_only' })).media.external_url, 'https://www.youtube-nocookie.com/embed/abcdefgh14');
      assert.strictEqual((await call('pres', { action: 'add_link_media', kind: 'video', url: 'https://evil.example/watch?v=abcdefgh12', title: 'x video', rights: 'link_only' })).status, 400);
      assert.strictEqual((await call('pres', { action: 'add_link_media', kind: 'video', url: 'http://www.youtube.com/watch?v=abcdefgh12', title: 'x video', rights: 'link_only' })).status, 400);
      assert.strictEqual((await call('pres', { action: 'add_link_media', kind: 'link', url: 'javascript:alert(1)', title: 'bad link', rights: 'link_only' })).status, 400);
    });

    /* ------------------------------------------------------------- readiness on real data */
    await t('readiness on the real rows: placeholders, awaiting facts and the thin exam bank are blocking; lesson length is advice', async () => {
      const r = ok(await call('adm', { action: 'readiness', version_id: version.id })).readiness;
      assert.strictEqual(r.ready, false);
      assert.ok(r.items.some(x => x.level === 'blocking' && /Picture still missing/.test(x.message) && x.lesson_id === lessons.A.id));
      assert.strictEqual(r.bank.usable, 3); assert.strictEqual(r.bank.needed, 3);
      assert.ok(!r.items.some(x => /usable exam questions; each attempt/.test(x.message)), 'three usable for three per attempt');
      const q = JSON.parse(run(DB, `select json_agg(id) from academy_questions where version_id = '${version.id}' and use = 'exam' and status = 'active'`))[0];
      ok(await call('pres', { action: 'question_status', id: q, status: 'retired', reason: 'readiness test' }));
      const r2 = ok(await call('adm', { action: 'readiness', version_id: version.id })).readiness;
      assert.ok(r2.items.some(x => x.level === 'blocking' && /2 usable exam questions; each attempt draws 3/.test(x.message)));
      ok(await call('pres', { action: 'question_status', id: q, status: 'active' }));
      assert.ok(r.items.some(x => x.level === 'blocking' && /Module 1 has no lessons|no lessons yet/.test(x.where + ' ' + x.message)));
      assert.ok(r.items.every(x => ['blocking', 'advice'].includes(x.level)));
    });

    /* ------------------------------------------------------------- locked versions */
    await t('a version in review is read only: every builder write is refused (409 locked) by the server and the database', async () => {
      ok(await call('pres', { action: 'submit_for_review', id: version.id }));
      const cur = B.blocksHash(one(`select blocks from academy_lessons where id = '${lessons.B2.id}'`).blocks);
      const tries = [
        { action: 'save_blocks', lesson_id: lessons.B2.id, base_hash: cur, blocks: [] },
        { action: 'reorder_modules', version_id: version.id, order: mods.map(m => m.id).reverse() },
        { action: 'set_distribution', version_id: version.id, quotas: null },
        { action: 'create_question', version_id: version.id, question: { module_id: mods[0].id, kind: 'single', use: 'exam', prompt: 'New?', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: 'x', objective_tags: ['x'] } },
      ];
      for (const b of tries) { const r = await call('pres', b); assert.strictEqual(r.status, 409, b.action + ' ' + JSON.stringify(r.body)); }
      const direct = await S.fetch(BASE + '/rest/v1/rpc/academy_author_op_set_blocks', { method: 'POST', body: JSON.stringify({ p_actor: 'staff:admin@test.example', p_lesson_id: lessons.B2.id, p_blocks: [] }) });
      assert.notStrictEqual(direct.status, 200, 'the database refuses it too');
      const b = ok(await call('adm', { action: 'builder', version_id: version.id }));
      assert.strictEqual(b.editable, false);
      ok(await call('pres', { action: 'return_to_draft', id: version.id }));
    });

    /* ------------------------------------------------------------- nothing outside the Academy */
    await t('the builder touched nothing outside the Academy tables and the private bucket; switches unchanged', async () => {
      const writes = S.calls.filter(c => c.method !== 'GET' && c.path.startsWith('/rest/v1/') && !c.path.startsWith('/rest/v1/rpc/'));
      assert.ok(writes.every(c => c.path.startsWith('/rest/v1/academy_events')), JSON.stringify(writes));
      const rpcs = [...new Set(S.calls.filter(c => c.path.startsWith('/rest/v1/rpc/')).map(c => c.path.slice(13)))];
      assert.ok(rpcs.every(f => /^academy_(author_op|content_op|save_op|op)_/.test(f)), rpcs.join(','));
      assert.deepStrictEqual(one(`select value from app_settings where key = 'phase2_flags'`).value, { academy_admin: true });
    });
  } finally {
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* best effort */ }
  }
  console.log(`\nacademy-builder.pg: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
