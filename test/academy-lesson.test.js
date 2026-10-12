/* HCPS Academy A2D Stage 2 — the lesson engine: payload builder (_academy_lesson.js), Samples A and B
   (_academy_samples.js), the preview actions of academy-admin-api.js, and static checks of the shared renderer
   (src/assets/academy/lesson-player.js). The real function runs in the Phase 0 harness (in-memory PostgREST); nothing
   touches Supabase. Rendering, keyboard, accessibility and phone/desktop layout are tested in a real browser by
   test/academy-lesson.browser.js; the samples' validity against the real M3 database rules by test/academy-lesson.pg.test.js.
   Run: node test/academy-lesson.test.js
   Covers: who may preview (administrators, switch on), answer keys and explanations never in a payload, exam questions
   never shown or graded, practice grading on the server only, nothing written, strict reads, safe links and videos,
   facts with source and date, labelled placeholders, every block kind, and a renderer with no HTML injection path. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, load, call, t, done, BASE } = require('./phase0-mock.js');
let LESSON = null;   // loaded through the harness (below), so a mutant of _academy_lesson.js is the copy these tests use
const { SAMPLES, MANUFACTURERS } = require('../netlify/functions/_academy_samples.js');

const id = (p, n) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C1 = id(4, 1), V1 = id(5, 1), V_OTHER = id(5, 2), M1 = id(6, 1), L1 = id(7, 1), L2 = id(7, 2);
const QP1 = id(3, 1), QP2 = id(3, 2), QX = id(3, 3), QR = id(3, 4), QO = id(3, 5), QM = id(3, 6);
const IMG = id(8, 1), VID = id(8, 2), PDF = id(8, 3), BADVID = id(8, 4), LINK = id(8, 5);
const KEY = 'ANSWER-KEY-SENTINEL', EXPL = 'EXPLANATION-SENTINEL', XPROMPT = 'EXAM-PROMPT-SENTINEL';
const SECRETS = [KEY, EXPL, XPROMPT, 'storage_path', 'answer_key', 'permission_ref'];   // a signed link names its file; the raw path field never leaves
const G = 'golden-technologies';
const fact = (model, field, value, extra) => Object.assign({ id: id(9, Math.floor(Math.random() * 1e9)), manufacturer_slug: G, model_code: model, field, value, unit: null,
  field_class: 'display', status: 'verified', source_url: 'https://goldentech.com/x', source_label: 'Golden page', verified_on: '2026-10-10', verified_by: 'staff:a',
  note: null, valid_from: '2026-10-10T00:00:00Z', valid_to: null, replaced_by: null }, extra || {});

const BLOCKS = [
  { kind: 'objectives', items: ['Explain zones', 'Pick a chair'] },
  { kind: 'text', heading: 'Zones', body: 'One **two** three.\n\n- a\n- b' },
  { kind: 'image', media_id: IMG, caption: 'A diagram' },
  { kind: 'video', media_id: VID, caption: 'Watch' },
  { kind: 'video', media_id: BADVID },
  { kind: 'document', media_id: PDF, title: 'Sell sheet' },
  { kind: 'document', media_id: LINK, title: 'Golden page' },
  { kind: 'fact', manufacturer_slug: G, model_code: 'PR511', field: 'weight_capacity', label: 'Capacity' },
  { kind: 'fact', manufacturer_slug: G, model_code: 'PR999', field: 'weight_capacity', label: 'Missing' },
  { kind: 'comparison', title: 'Compare', manufacturer_slug: G, models: ['PR511', 'PR519'], fields: [{ field: 'zones', label: 'Zones' }] },
  { kind: 'check', question_ids: [QP1, QP2, QX] },
  { kind: 'check', question_ids: [QM, QR] },
  { kind: 'takeaways', items: ['one', 'two', 'three'] },
];
function seed(extra) {
  const s = {
    tokens: { pres: 'angelo@hcps.us', admin: 'ann@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', old: 'former@hcps.us' },
    tables: {
      staff_users: [
        { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', active: true },
        { email: 'ann@hcps.us', name: 'Ann Admin', role: 'admin', active: true },
        { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', active: true },
        { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', active: true },
        { email: 'former@hcps.us', name: 'Former', role: 'president', active: false },
      ],
      dealers: [], dealer_directory: [],
      manufacturers: [{ slug: G, name: 'Golden Technologies' }],
      app_settings: [{ key: 'phase2_flags', value: { academy_admin: true } }],
      academy_courses: [{ id: C1, slug: 'golden-lift-chairs', title: 'Golden Lift Chair Sales Certification', course_type: 'hcps_certification', issuer: 'hcps', manufacturer_slug: G, category: null, external_url: null, status: 'draft', created_at: '2026-10-01T00:00:00Z' }],
      academy_course_versions: [
        { id: V1, course_id: C1, version: 1, status: 'draft', pass_mark: 80, exam_questions: 25, validity_months: 12, retake_policy: {}, published_at: null, published_by: null, created_at: '2026-10-01T00:00:00Z' },
        { id: V_OTHER, course_id: C1, version: 2, status: 'draft', pass_mark: 80, exam_questions: 25, validity_months: 12, retake_policy: {}, published_at: null, published_by: null, created_at: '2026-10-01T00:00:00Z' }],
      academy_modules: [{ id: M1, version_id: V1, position: 4, title: 'Comfort Zones', objectives: [] }],
      academy_lessons: [
        { id: L1, module_id: M1, position: 1, title: 'Zones lesson', est_minutes: 12, blocks: BLOCKS },
        { id: L2, module_id: M1, position: 2, title: 'Other lesson', est_minutes: 10, blocks: [{ kind: 'check', question_ids: [QO, QP1] }] }],
      academy_questions: [
        { id: QP1, version_id: V1, module_id: M1, kind: 'single', use: 'practice', status: 'active', prompt: 'Which zone tilts?', choices: [{ id: 'a', text: 'Zone 2' }, { id: 'b', text: 'Zone 5' }], answer_key: 'b', explanation: EXPL + ' 1', objective_tags: ['z'] },
        { id: QP2, version_id: V1, module_id: M1, kind: 'multi', use: 'practice', status: 'active', prompt: 'Which have a headrest?', choices: [{ id: 'a', text: '1' }, { id: 'b', text: '4' }, { id: 'c', text: '5' }], answer_key: ['b', 'c'], explanation: EXPL + ' 2', objective_tags: ['z'] },
        { id: QX, version_id: V1, module_id: M1, kind: 'single', use: 'exam', status: 'active', prompt: XPROMPT, choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: EXPL + ' exam', objective_tags: ['z'] },
        { id: QR, version_id: V1, module_id: M1, kind: 'single', use: 'practice', status: 'retired', prompt: 'Retired one', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: EXPL + ' retired', objective_tags: ['z'] },
        { id: QO, version_id: V_OTHER, module_id: null, kind: 'single', use: 'practice', status: 'active', prompt: 'Another version', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: EXPL + ' other', objective_tags: ['z'] },
        { id: QM, version_id: V1, module_id: M1, kind: 'single', use: 'practice', status: 'active', prompt: 'Second check question', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: EXPL + ' m', objective_tags: ['z'] },
      ],
      academy_media: [
        { id: IMG, kind: 'image', storage_path: 'media/academy/secret-path.jpg', external_url: null, rights: 'hcps_owned', manufacturer_slug: null, permission_ref: null, alt_text: 'A Golden lift chair diagram with five zones' },
        { id: VID, kind: 'video', storage_path: null, external_url: 'https://www.youtube-nocookie.com/embed/abcdefgh12', rights: 'link_only', manufacturer_slug: G, permission_ref: null, alt_text: 'AutoDrive video' },
        { id: BADVID, kind: 'video', storage_path: null, external_url: 'https://www.youtube.com/watch?v=abcdefgh12', rights: 'link_only', manufacturer_slug: G, permission_ref: null, alt_text: 'Not allowed host' },
        { id: PDF, kind: 'pdf', storage_path: 'media/academy/sheet.pdf', external_url: null, rights: 'hcps_owned', manufacturer_slug: null, permission_ref: null, alt_text: 'Sell sheet' },
        { id: LINK, kind: 'link', storage_path: null, external_url: 'https://goldentech.com/product/x', rights: 'link_only', manufacturer_slug: G, permission_ref: null, alt_text: 'Golden page' },
      ],
      product_facts: [
        fact('PR511', 'weight_capacity', 400, { unit: 'lb' }),
        fact('PR511', 'weight_capacity', 350, { unit: 'lb', valid_to: '2026-10-09T00:00:00Z', replaced_by: id(9, 1) }),   // history row: never shown
        fact('PR511', 'name', 'Cloud+'), fact('PR519', 'name', 'Cloud Supreme'),
        fact('PR511', 'zones', 4), fact('PR519', 'zones', '5', { status: 'awaiting_manufacturer', note: 'Page lists 4 and 5' }),
      ],
      academy_events: [],
    },
  };
  if (extra) extra(s);
  return s;
}
/* The real function, with Supabase Storage signing answered here (a 5-minute link, as Storage returns it). */
function api(world, opts) {
  opts = opts || {};
  const mod = load('academy-admin-api.js', world, {});
  const base = global.fetch;
  global.fetch = async (url, o) => {
    const s = String(url);
    if (s.startsWith(BASE + '/storage/v1/object/sign/')) {
      world.calls.push({ url: s, method: 'POST' });
      if (opts.signFails) return { ok: false, status: 500, json: async () => ({}), text: async () => '{}' };
      const p = s.slice((BASE + '/storage/v1/object/sign/').length);
      return { ok: true, status: 200, json: async () => ({ signedURL: '/object/sign/' + p + '?token=signed' }), text: async () => '' };
    }
    return base(url, o);
  };
  return mod;
}
const deepKeys = (v, out) => { out = out || []; if (Array.isArray(v)) v.forEach(x => deepKeys(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); } return out; };
const noSecrets = (body, extra) => { const s = JSON.stringify(body); for (const x of SECRETS.concat(extra || [])) assert.ok(!s.includes(x), 'leaked: ' + x); };
const writes = w => w.calls.filter(c => c.method !== 'GET' && !/\/auth\/v1\/user/.test(c.url) && !/\/storage\/v1\/object\/sign\//.test(c.url));

(async () => {
  load('academy-admin-api.js', createWorld(seed()), {});
  LESSON = require('../netlify/functions/_academy_lesson.js');
  /* ======================= payload builder ======================= */
  await t('samples: both build with no warnings, 15 blocks each, and together use all 14 block kinds', async () => {
    const kinds = new Set();
    for (const k of ['A', 'B']) {
      const s = SAMPLES[k];
      const p = LESSON.buildLesson({ mode: 'preview', sample: k, course: s.course, module: s.module, lesson: s.lesson, outline: s.outline, facts: s.facts, media: [], questions: s.questions, manufacturers: MANUFACTURERS });
      assert.deepStrictEqual(p.warnings, [], k);
      assert.strictEqual(p.blocks.length, 15, k);
      p.blocks.forEach(b => kinds.add(b.kind));
      assert.strictEqual(p.blocks[0].kind, 'objectives');
      assert.strictEqual(p.blocks[p.blocks.length - 1].kind, 'takeaways');
      assert.strictEqual(p.outline.length, 11); assert.ok(p.outline.some(m => m.lessons.some(l => l.current)));
      assert.ok(p.open_items.length >= 2, k + ' has amber "awaiting Golden" items');
      for (const b of p.blocks) if (b.kind === 'image') assert.ok(b.placeholder && /HCPS-hosted file to be added/.test(b.placeholder) && b.alt.length >= 10, 'no Golden photography: labelled placeholder');
    }
    assert.deepStrictEqual([...kinds].sort(), LESSON.KINDS.slice().sort());
  });
  await t('samples: no answer key, explanation or answer in any payload, and questions carry only id, kind, prompt and choices', async () => {
    for (const k of ['A', 'B']) {
      const s = SAMPLES[k];
      const p = LESSON.buildLesson({ mode: 'preview', course: s.course, module: s.module, lesson: s.lesson, outline: s.outline, facts: s.facts, questions: s.questions, manufacturers: MANUFACTURERS });
      const keys = new Set(deepKeys(p));
      for (const bad of ['answer_key', 'explanation', 'objective_tags', 'use', 'status_raw']) assert.ok(!keys.has(bad), k + ' ' + bad);
      const txt = JSON.stringify(p);
      for (const q of s.questions) assert.ok(!txt.includes(q.explanation), 'explanation leaked');
      const check = p.blocks.find(b => b.kind === 'check');
      for (const q of check.questions) assert.deepStrictEqual(Object.keys(q).sort(), ['choices', 'id', 'kind', 'prompt']);
    }
  });
  await t('payload: an exam question in a knowledge check is left out (never shown) and the staff are warned; a retired one too', async () => {
    const w = createWorld(seed());
    const p = LESSON.buildLesson({ mode: 'preview', lesson: { id: L1, blocks: BLOCKS }, facts: w.db.product_facts, media: [], questions: w.db.academy_questions });
    const checks = p.blocks.filter(b => b.kind === 'check');
    assert.deepStrictEqual(checks[0].questions.map(q => q.id), [QP1, QP2]);
    assert.deepStrictEqual(checks[1].questions.map(q => q.id), [QM]);
    assert.ok(p.warnings.some(x => /exam questions are never shown/.test(x.message)));
    noSecrets(p);
  });
  await t('payload: facts show value, unit, source and date; history rows are ignored; awaiting is flagged with its note; a missing fact is never guessed', async () => {
    const w = createWorld(seed());
    const p = LESSON.buildLesson({ mode: 'preview', lesson: { id: L1, blocks: BLOCKS }, facts: w.db.product_facts, manufacturers: { [G]: 'Golden' } });
    const f = p.blocks.filter(b => b.kind === 'fact');
    assert.deepStrictEqual(f[0].fact, { text: '400 lb', status: 'verified', source_label: 'Golden page', source_url: 'https://goldentech.com/x', verified_on: '2026-10-10', note: null, manufacturer: 'Golden' });
    assert.strictEqual(f[1].fact, null);
    assert.ok(p.warnings.some(x => /PR999 weight_capacity/.test(x.message)));
    const cmp = p.blocks.find(b => b.kind === 'comparison');
    assert.deepStrictEqual(cmp.models, [{ code: 'PR511', name: 'Cloud+' }, { code: 'PR519', name: 'Cloud Supreme' }]);
    assert.deepStrictEqual(cmp.rows[0].cells, [{ text: '4', status: 'verified', note: null }, { text: '5', status: 'awaiting', note: 'Page lists 4 and 5' }]);
    assert.ok(p.open_items.some(x => /PR519/.test(x) && /Page lists 4 and 5/.test(x)));
    assert.deepStrictEqual(p.sources.map(s => s.label), ['Golden page']);
    assert.strictEqual(LESSON.factText({ value: true }), 'Yes'); assert.strictEqual(LESSON.factText({ value: ['A', 'B'] }), 'A, B');
    assert.strictEqual(LESSON.factText({ value: { x: 1 } }), 'See source'); assert.strictEqual(LESSON.factText({ value: null }), null);
  });
  await t('payload: links are https only; videos only youtube-nocookie / player.vimeo; anything else becomes a labelled placeholder', async () => {
    const p = LESSON.buildLesson({ mode: 'preview', lesson: { blocks: [
      { kind: 'quote', text: 'q', manufacturer_slug: G, source_label: 's', source_url: 'javascript:alert(1)', source_date: '2026-10-10' },
      { kind: 'quote', text: 'q', manufacturer_slug: G, source_label: 's', source_url: 'http://plain.example.com/', source_date: '2026-10-10' },
      { kind: 'video', media_id: VID }, { kind: 'video', media_id: BADVID }, { kind: 'document', media_id: LINK, title: 'x' }] },
      media: [{ id: VID, kind: 'video', external_url: 'https://player.vimeo.com/video/123456' }, { id: BADVID, kind: 'video', external_url: 'https://evil.example.com/embed/abcdefgh' },
              { id: LINK, kind: 'link', external_url: 'javascript:alert(1)' }] });
    assert.strictEqual(p.blocks[0].source_url, null); assert.strictEqual(p.blocks[1].source_url, null);
    assert.strictEqual(p.blocks[2].video.embed, 'https://player.vimeo.com/video/123456');
    assert.ok(!p.blocks[3].video && p.blocks[3].placeholder);
    assert.ok(!p.blocks[4].document && p.blocks[4].placeholder);
    assert.strictEqual(p.warnings.length, 2);
  });
  await t('payload: unknown kinds are skipped with a warning; a learner payload carries no staff warnings', async () => {
    const p = LESSON.buildLesson({ mode: 'preview', lesson: { blocks: [{ kind: 'html', body: '<script>' }, null, { kind: 'text', body: 'ok' }] } });
    assert.deepStrictEqual(p.blocks.map(b => b.kind), ['text']); assert.strictEqual(p.warnings.length, 2);
    const q = LESSON.buildLesson({ mode: 'learner', lesson: { blocks: [{ kind: 'html' }] } });
    assert.ok(!('warnings' in q) && !('sample' in q));
  });
  await t('grading: practice only, active only; multi-answer order does not matter; bad answers refused; the key is never returned', async () => {
    const q = { use: 'practice', status: 'active', kind: 'multi', answer_key: ['c', 'b'], explanation: 'why' };
    assert.deepStrictEqual(LESSON.checkPractice(q, ['b', 'c']), { correct: true, explanation: 'why' });
    assert.deepStrictEqual(LESSON.checkPractice(q, ['c', 'b', 'b']), { correct: true, explanation: 'why' });
    assert.deepStrictEqual(LESSON.checkPractice(q, ['b']), { correct: false, explanation: 'why' });
    assert.deepStrictEqual(LESSON.checkPractice(q, 'b'), { invalid: true });
    assert.deepStrictEqual(LESSON.checkPractice({ use: 'practice', status: 'active', kind: 'single', answer_key: 'a', explanation: 'e' }, 'z'), { invalid: true });
    assert.strictEqual(LESSON.checkPractice({ use: 'exam', status: 'active', kind: 'single', answer_key: 'a' }, 'a'), null);
    assert.strictEqual(LESSON.checkPractice({ use: 'practice', status: 'retired', kind: 'single', answer_key: 'a' }, 'a'), null);
  });

  /* ======================= preview actions ======================= */
  await t('who may preview: President and administrators yes; rep, Relations, inactive staff, no token and a forged token no', async () => {
    const w = createWorld(seed()); const m = api(w);
    for (const tok of ['pres', 'admin']) assert.strictEqual((await call(m, { action: 'preview_sample', sample: 'A' }, { token: tok })).status, 200, tok);
    for (const tok of ['greg', 'lori']) assert.strictEqual((await call(m, { action: 'preview_sample', sample: 'A' }, { token: tok })).status, 403, tok);
    for (const tok of ['old', null, 'forged.jwt.value']) assert.strictEqual((await call(m, { action: 'preview_lesson', lesson_id: L1 }, { token: tok })).status, 401, String(tok));
    for (const tok of ['greg', 'lori']) {
      const r = await call(m, { action: 'preview_check', sample: 'A', question_id: SAMPLES.A.questions[0].id, answer: 'c' }, { token: tok });
      assert.strictEqual(r.status, 403); assert.ok(!('correct' in r.body));
    }
  });
  await t('switch off: every preview action is refused (403 flag_off), nothing read', async () => {
    const w = createWorld(seed(s => { s.tables.app_settings = [{ key: 'phase2_flags', value: { academy_admin: false } }]; })); const m = api(w);
    for (const body of [{ action: 'preview_sample', sample: 'A' }, { action: 'preview_lesson', lesson_id: L1 }, { action: 'preview_check', sample: 'A', question_id: SAMPLES.A.questions[0].id, answer: 'c' }]) {
      const r = await call(m, body, { token: 'pres' }); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'flag_off');
    }
    assert.ok(!w.calls.some(c => /academy_lessons|academy_questions/.test(c.url)));
  });
  await t('preview_sample: the payload the page draws; no key or explanation; unknown sample 404', async () => {
    const w = createWorld(seed()); const m = api(w);
    const r = await call(m, { action: 'preview_sample', sample: 'B' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.lesson.sample, 'B'); assert.strictEqual(r.body.lesson.mode, 'preview');
    assert.deepStrictEqual(r.body.samples.map(s => s.key), ['A', 'B']);
    for (const q of SAMPLES.B.questions) { assert.ok(!JSON.stringify(r.body).includes(q.explanation)); }
    assert.ok(!deepKeys(r.body).includes('answer_key'));
    assert.strictEqual((await call(m, { action: 'preview_sample', sample: 'constructor' }, { token: 'pres' })).status, 404);
    assert.strictEqual((await call(m, { action: 'preview_sample', sample: 'C' }, { token: 'pres' })).status, 404);
    assert.deepStrictEqual(writes(w), []);
  });
  await t('preview_check (sample): right and wrong answers graded on the server with the explanation; never the key; POST only; foreign question 404', async () => {
    const w = createWorld(seed()); const m = api(w); const q = SAMPLES.A.questions[0];
    let r = await call(m, { action: 'preview_check', sample: 'A', question_id: q.id, answer: 'c' }, { token: 'admin' });
    assert.deepStrictEqual(r.body, { ok: true, correct: true, explanation: q.explanation });
    r = await call(m, { action: 'preview_check', sample: 'A', question_id: q.id, answer: 'a' }, { token: 'admin' });
    assert.strictEqual(r.body.correct, false); assert.ok(!JSON.stringify(r.body).includes('"c"'));
    r = await call(m, { action: 'preview_check', sample: 'A', question_id: q.id, answer: 'c' }, { token: 'admin', method: 'GET', qs: { action: 'preview_check', sample: 'A', question_id: q.id, answer: 'c' } });
    assert.strictEqual(r.status, 405);
    r = await call(m, { action: 'preview_check', sample: 'A', question_id: SAMPLES.B.questions[0].id, answer: 'd' }, { token: 'admin' });
    assert.strictEqual(r.status, 404);
    r = await call(m, { action: 'preview_check', sample: 'A', question_id: q.id, answer: ['c'] }, { token: 'admin' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(writes(w), []);
  });
  await t('preview_lesson: built from the saved blocks; questions read WITHOUT answer key or explanation; exam question left out; nothing written', async () => {
    const w = createWorld(seed()); const m = api(w);
    const r = await call(m, { action: 'preview_lesson', lesson_id: L1 }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const L = r.body.lesson;
    assert.strictEqual(L.lesson.title, 'Zones lesson'); assert.strictEqual(L.module.position, 4); assert.strictEqual(L.course.title, 'Golden Lift Chair Sales Certification');
    assert.strictEqual(L.version_status, 'draft');
    assert.deepStrictEqual(L.blocks.find(b => b.kind === 'check').questions.map(q => q.id), [QP1, QP2]);
    noSecrets(r.body);
    const qreads = w.calls.filter(c => /\/rest\/v1\/academy_questions/.test(c.url));
    assert.ok(qreads.length >= 1); for (const c of qreads) assert.ok(!/answer_key|explanation|select=\*/.test(decodeURIComponent(c.url)), c.url);
    assert.ok(!w.calls.some(c => /select=\*/.test(c.url)));
    assert.deepStrictEqual(writes(w), []);
  });
  await t('preview_lesson: a question of another course version is never shown, even if a check names it', async () => {
    const w = createWorld(seed()); const m = api(w);
    const L = (await call(m, { action: 'preview_lesson', lesson_id: L2 }, { token: 'pres' })).body.lesson;
    assert.deepStrictEqual(L.blocks[0].questions.map(q => q.id), [QP1]);
    assert.ok(!JSON.stringify(L).includes('Another version'));
  });
  await t('preview_lesson media: a stored picture through a short-lived private link (never its path); approved video; HCPS PDF signed; Golden link as is; a refused host is a placeholder', async () => {
    const w = createWorld(seed()); const m = api(w);
    const L = (await call(m, { action: 'preview_lesson', lesson_id: L1 }, { token: 'pres' })).body.lesson;
    const img = L.blocks.find(b => b.kind === 'image').image;
    assert.ok(img.src.startsWith(BASE + '/storage/v1/object/sign/academy-private/media/academy/') && img.src.endsWith('?token=signed'));
    assert.strictEqual(img.alt, 'A Golden lift chair diagram with five zones');
    const vids = L.blocks.filter(b => b.kind === 'video');
    assert.strictEqual(vids[0].video.embed, 'https://www.youtube-nocookie.com/embed/abcdefgh12'); assert.ok(vids[1].placeholder && !vids[1].video);
    const docs = L.blocks.filter(b => b.kind === 'document');
    assert.ok(docs[0].document.href.includes('/object/sign/academy-private/media/academy/sheet.pdf')); assert.strictEqual(docs[0].document.hosted_by, 'hcps');
    assert.deepStrictEqual(docs[1].document, { href: 'https://goldentech.com/product/x', hosted_by: 'source', kind: 'link' });
    assert.ok(!JSON.stringify(L).includes('"media/academy/secret-path.jpg"'));
  });
  await t('preview_lesson: a failed private link gives a labelled placeholder and a staff warning, never a broken picture', async () => {
    const w = createWorld(seed()); const m = api(w, { signFails: true });
    const L = (await call(m, { action: 'preview_lesson', lesson_id: L1 }, { token: 'pres' })).body.lesson;
    const img = L.blocks.find(b => b.kind === 'image').image;
    assert.strictEqual(img.src, null); assert.strictEqual(img.missing, true);
    assert.ok(L.warnings.some(x => /could not be opened/.test(x.message)));
  });
  await t('preview_check (lesson): practice graded; EXAM question refused (403) with nothing about it returned; retired 409; another lesson\'s or version\'s question 404', async () => {
    const w = createWorld(seed()); const m = api(w);
    let r = await call(m, { action: 'preview_check', lesson_id: L1, question_id: QP1, answer: 'b' }, { token: 'pres' });
    assert.deepStrictEqual(r.body, { ok: true, correct: true, explanation: EXPL + ' 1' });
    r = await call(m, { action: 'preview_check', lesson_id: L1, question_id: QP2, answer: ['c', 'b'] }, { token: 'pres' });
    assert.strictEqual(r.body.correct, true);
    r = await call(m, { action: 'preview_check', lesson_id: L1, question_id: QX, answer: 'a' }, { token: 'pres' });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'not_practice'); noSecrets(r.body); assert.ok(!('correct' in r.body));
    r = await call(m, { action: 'preview_check', lesson_id: L1, question_id: QR, answer: 'a' }, { token: 'pres' });
    assert.strictEqual(r.status, 409); noSecrets(r.body);
    r = await call(m, { action: 'preview_check', lesson_id: L1, question_id: QO, answer: 'a' }, { token: 'pres' });
    assert.strictEqual(r.status, 404);
    r = await call(m, { action: 'preview_check', lesson_id: L2, question_id: QO, answer: 'a' }, { token: 'pres' });   // in L2's check, but another version
    assert.strictEqual(r.status, 404);
    r = await call(m, { action: 'preview_check', lesson_id: L2, question_id: QP2, answer: ['b', 'c'] }, { token: 'pres' });   // this version, but not in L2's checks
    assert.strictEqual(r.status, 404); assert.ok(!('correct' in r.body));
    assert.deepStrictEqual(writes(w), []);
  });
  await t('strict reads: an unreadable lesson table is a 503, never an empty lesson; an unknown lesson is a plain 404', async () => {
    let w = createWorld(seed(s => { s.missingTables = ['academy_lessons']; })); let m = api(w);
    assert.strictEqual((await call(m, { action: 'preview_lesson', lesson_id: L1 }, { token: 'pres' })).status, 503);
    w = createWorld(seed()); m = api(w);
    const r = await call(m, { action: 'preview_lesson', lesson_id: id(7, 99) }, { token: 'pres' });
    assert.strictEqual(r.status, 404); assert.strictEqual((await call(m, { action: 'preview_lesson', lesson_id: 'not-a-uuid' }, { token: 'pres' })).status, 400);
  });
  await t('the preview never changes anything: no database write, no audit row, no operation, no switch', async () => {
    const w = createWorld(seed()); const m = api(w);
    await call(m, { action: 'preview_sample', sample: 'A' }, { token: 'pres' });
    await call(m, { action: 'preview_lesson', lesson_id: L1 }, { token: 'pres' });
    await call(m, { action: 'preview_check', lesson_id: L1, question_id: QP1, answer: 'a' }, { token: 'pres' });
    await call(m, { action: 'preview_check', sample: 'B', question_id: SAMPLES.B.questions[1].id, answer: 'b' }, { token: 'pres' });
    assert.deepStrictEqual(writes(w), []); assert.deepStrictEqual(w.db.academy_events, []);
    assert.deepStrictEqual(w.db.app_settings, [{ key: 'phase2_flags', value: { academy_admin: true } }]);
  });

  await t('private links: only server-chosen media paths are ever signed (never "..", another bucket\'s path or a learner upload path)', async () => {
    const w = createWorld(seed()); api(w);
    const A = require('../netlify/functions/_academy.js');
    for (const bad of ['../secrets/x.png', 'media/../x.png', 'uploads/learner/x.pdf', 'media/a/b/c.png', '/media/a/x.png', 'media/A/x.png', '']) {
      const before = w.calls.length; assert.strictEqual(await A.signPrivate(bad, 900), null, bad);
      assert.strictEqual(w.calls.length, before, 'nothing was asked of Storage for ' + bad);
    }
    assert.ok((await A.signPrivate('media/academy/x.png', 900)).endsWith('?token=signed'));
  });

  /* ======================= the renderer (static) ======================= */
  const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'academy', 'lesson-player.js'), 'utf8');
  const PREVIEW = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'academy-preview.html'), 'utf8');
  const code = PLAYER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  await t('renderer: no HTML injection path (no innerHTML, insertAdjacentHTML, outerHTML, document.write, eval, new Function, setAttribute("style"/"on…"))', async () => {
    for (const bad of [/innerHTML/, /insertAdjacentHTML/, /outerHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function/, /setAttribute\(\s*['"](style|on\w+)['"]/]) assert.ok(!bad.test(code), String(bad));
    assert.strictEqual((code.match(/setAttribute\('href'/g) || []).length, 1, 'one place sets a link');
    assert.ok(/if \(!HTTPS\.test\(String\(props\.href\)\)\) throw new Error\('link not allowed'\); el\.setAttribute\('href', props\.href\);/.test(code), 'and it checks https first');
    const pageCode = PREVIEW.split('<script>').slice(1).join('');
    for (const bad of [/innerHTML/, /insertAdjacentHTML/, /outerHTML/, /document\.write/]) assert.ok(!bad.test(pageCode), 'preview page: ' + bad);
  });
  await t('renderer and server use the SAME link and video allow-lists; the M3 database uses the same video rule', async () => {
    const hs = /var HTTPS = (\/.*\/);/.exec(PLAYER)[1], vs = /var VIDEO = (\/.*\/);/.exec(PLAYER)[1];
    const SRV = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_academy_lesson.js'), 'utf8');
    assert.strictEqual(/const HTTPS = (\/.*\/);/.exec(SRV)[1], hs); assert.strictEqual(String(LESSON.VIDEO), vs);
    const M3 = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'academy_a2d_m3_author_ops.sql'), 'utf8');
    assert.ok(M3.includes("'^https://(www\\.youtube-nocookie\\.com/embed/[A-Za-z0-9_-]{6,20}|player\\.vimeo\\.com/video/[0-9]{3,12})(\\?[A-Za-z0-9=&_.-]*)?$'"));
    assert.strictEqual(vs, '/^https:\\/\\/(www\\.youtube-nocookie\\.com\\/embed\\/[A-Za-z0-9_-]{6,20}|player\\.vimeo\\.com\\/video\\/[0-9]{3,12})(\\?[A-Za-z0-9=&_.-]*)?$/');
  });
  await t('renderer: one player for preview and learners; it draws all 14 kinds and saves nothing itself', async () => {
    for (const k of LESSON.KINDS) assert.ok(new RegExp('\\b' + k + ': function').test(PLAYER), 'renderer for ' + k);
    assert.ok(!/fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|sendBeacon/.test(code), 'the player itself never talks to the network or stores anything');
    assert.ok(PREVIEW.includes('/assets/academy/lesson-player.js') && PREVIEW.includes('/assets/academy/lesson-player.css'));
    const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'academy.html'), 'utf8');
    assert.ok(PAGE.includes('/admin/academy-preview.html?lesson=') && PAGE.includes('/admin/academy-preview.html?sample=A'));
  });
  await t('/academy/* policy: the player needs nothing it forbids (own scripts only, the allowed frame hosts, no inline script)', async () => {
    const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
    const csp = /for = "\/academy\/\*"[\s\S]*?Content-Security-Policy = "([^"]+)"/.exec(toml)[1];
    assert.ok(/script-src 'self';/.test(csp) && /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com;/.test(csp) && /img-src 'self' data: https:\/\/\*\.supabase\.co;/.test(csp));
    assert.ok(!/<script/.test(code));
  });
  done('academy lesson engine');
})();
