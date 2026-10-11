/* HCPS Academy A2C Part C1 — the Academy Command Center (academy-admin-api.js + /admin/academy.html).
   The real function, loaded unmodified in the Phase 0 harness (in-memory PostgREST + Supabase Auth). The audited database
   operations (academy_op_*) are represented by a recorder that captures exactly what the server sends them; the A2C M2
   content operations (academy_content_op_*) by test/academy-content-ops.fake.js, which follows the SQL. What the
   operations themselves do is proven against real Postgres by the M1 and M2 suites (test/academy*.pg.test.js).
   Run: node test/academy-c1.test.js
   Covers: the switch, who may do what (administrators; President-only publishing), identity taken from the sign-in and
   never from the request, draft-only editing, published/certified records untouched, HCPS vs manufacturer credentials,
   no exam answers anywhere, strict reads, audit rows, POST-only changes, no ordering/switch/manufacturer writes, the page. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, load, call, t, done, BASE, adminSrc } = require('./phase0-mock.js');
const { contentOps } = require('./academy-content-ops.fake.js');

const HQ = '10000000-0000-4000-8000-0000000000a1', BR = '10000000-0000-4000-8000-0000000000a2', OTHER = '10000000-0000-4000-8000-0000000000b1';
const id = (p, n) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C_CERT = id(4, 1), C_PUB = id(4, 2), C_GOLD = id(4, 3), C_TEST = id(4, 4);
const V_DRAFT = id(5, 1), V_PUB = id(5, 2), V_REVIEW = id(5, 3), V_TEST = id(5, 4);
const M_DRAFT = id(6, 1), M_PUB = id(6, 2), M_REVIEW = id(6, 3), M_EMPTY = id(6, 4);
const LS_DRAFT = id(7, 1), LS_PUB = id(7, 2), LS_REVIEW = id(7, 3);
const L1 = id(2, 1), L2 = id(2, 2), L3 = id(2, 3);
const MEM1 = id(8, 1), MEM2 = id(8, 2), MEM3 = id(8, 3);
const F1 = id(9, 1), F_OLD = id(9, 2), X1 = id(3, 1), X2 = id(3, 2), CERT1 = id(3, 9);
const KEY_SENTINEL = 'ANSWER-KEY-SENTINEL-7Q', ANSWER_SENTINEL = 'LEARNER-ANSWER-SENTINEL-4Z', PROMPT_SENTINEL = 'PROMPT-SENTINEL-9P';

function seed(extra) {
  const s = {
    tokens: { pres: 'angelo@hcps.us', admin: 'ann@hcps.us', owner: 'olive@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', old: 'former@hcps.us', stranger: 'x@else.com' },
    tables: {
      staff_users: [
        { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', active: true },
        { email: 'ann@hcps.us', name: 'Ann Admin', role: 'admin', active: true },
        { email: 'olive@hcps.us', name: 'Olive Owner', role: 'owner', active: true },
        { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', active: true },
        { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', active: true },
        { email: 'former@hcps.us', name: 'Former', role: 'president', active: false },
      ],
      dealers: [
        { id: HQ, business_name: 'HQ Medical', parent_id: null, rep_name: 'Greg Campbell' },
        { id: BR, business_name: 'HQ Medical North', parent_id: HQ, rep_name: null },
        { id: OTHER, business_name: 'Other Dealer', parent_id: null, rep_name: 'Angelo Audia' },
      ],
      dealer_directory: [],
      manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'pride-mobility', name: 'Pride Mobility' }],
      app_settings: [{ key: 'phase2_flags', value: { academy_admin: true } }],
      academy_courses: [
        { id: C_CERT, slug: 'golden-lift-chair-specialist', title: 'Lift Chair Specialist', course_type: 'hcps_certification', issuer: 'hcps', manufacturer_slug: 'golden-technologies', category: 'Lift chairs', external_url: null, status: 'draft' },
        { id: C_PUB, slug: 'golden-basics', title: 'Golden Basics', course_type: 'hcps_certification', issuer: 'hcps', manufacturer_slug: 'golden-technologies', category: null, external_url: null, status: 'draft' },
        { id: C_GOLD, slug: 'golden-certified-pro', title: 'Golden Certified Pro', course_type: 'manufacturer_program', issuer: 'manufacturer', manufacturer_slug: 'golden-technologies', category: null, external_url: 'https://golden.example/training', status: 'draft' },
        { id: C_TEST, slug: 'test-sandbox', title: 'Sandbox', course_type: 'training', issuer: 'none', manufacturer_slug: null, category: null, external_url: null, status: 'draft' },
      ],
      academy_course_versions: [
        { id: V_DRAFT, course_id: C_CERT, version: 1, status: 'draft', pass_mark: 80, exam_questions: 3, validity_months: 12, retake_policy: { unlimited: true }, published_at: null, published_by: null },
        { id: V_PUB, course_id: C_PUB, version: 1, status: 'published', pass_mark: 80, exam_questions: 2, validity_months: null, retake_policy: { unlimited: true }, published_at: '2026-10-01T00:00:00Z', published_by: 'staff:angelo@hcps.us' },
        { id: V_REVIEW, course_id: C_PUB, version: 2, status: 'in_review', pass_mark: 80, exam_questions: 2, validity_months: null, retake_policy: { unlimited: true }, published_at: null, published_by: null },
        { id: V_TEST, course_id: C_TEST, version: 1, status: 'draft', pass_mark: 70, exam_questions: 1, validity_months: null, retake_policy: { unlimited: true }, published_at: null, published_by: null },
      ],
      academy_modules: [
        { id: M_DRAFT, version_id: V_DRAFT, position: 1, title: 'Lift chair anatomy', objectives: ['Name the parts'] },
        { id: M_EMPTY, version_id: V_DRAFT, position: 2, title: 'Empty module', objectives: [] },
        { id: M_PUB, version_id: V_PUB, position: 1, title: 'Published module', objectives: [] },
        { id: M_REVIEW, version_id: V_REVIEW, position: 1, title: 'In-review module', objectives: [] },
      ],
      academy_lessons: [
        { id: LS_DRAFT, module_id: M_DRAFT, position: 1, title: 'Motors', est_minutes: 8, blocks: [{ type: 'text' }] },
        { id: LS_PUB, module_id: M_PUB, position: 1, title: 'Published lesson', est_minutes: 5, blocks: [] },
        { id: LS_REVIEW, module_id: M_REVIEW, position: 1, title: 'In-review lesson', est_minutes: 5, blocks: [] },
      ],
      academy_questions: [
        { id: id(1, 1), version_id: V_DRAFT, module_id: M_DRAFT, kind: 'single', use: 'exam', prompt: PROMPT_SENTINEL, choices: ['a', 'b'], answer_key: KEY_SENTINEL, explanation: 'x', status: 'active' },
        { id: id(1, 2), version_id: V_DRAFT, module_id: null, kind: 'single', use: 'practice', prompt: PROMPT_SENTINEL, choices: ['a', 'b'], answer_key: KEY_SENTINEL, explanation: 'x', status: 'active' },
      ],
      academy_learners: [
        { id: L1, auth_user_id: id(3, 5), full_name: 'Tina Manager', email: 'tm@hqmed.test', status: 'active' },
        { id: L2, auth_user_id: id(3, 6), full_name: 'Bob Branch', email: 'bob@north.test', status: 'active' },
        { id: L3, auth_user_id: id(3, 7), full_name: 'Sam Suspended', email: 'sam@hqmed.test', status: 'suspended' },
      ],
      academy_memberships: [
        { id: MEM1, learner_id: L1, dealer_id: HQ, role: 'training_manager', access_type: 'dealer_user', status: 'active' },
        { id: MEM2, learner_id: L2, dealer_id: BR, role: 'learner', access_type: 'training_only', status: 'active' },
        { id: MEM3, learner_id: L3, dealer_id: HQ, role: 'learner', access_type: 'training_only', status: 'active' },
      ],
      academy_enrollments: [
        { id: id(3, 3), learner_id: L1, version_id: V_PUB, status: 'completed' },
        { id: id(3, 4), learner_id: L2, version_id: V_PUB, status: 'in_progress' },
      ],
      academy_attempts: [{ id: id(3, 8), enrollment_id: id(3, 3), question_ids: [id(1, 1)], answers: { q: ANSWER_SENTINEL }, score: 90, passed: true }],
      academy_certificates: [
        { id: CERT1, cert_number: 'HCPS-AB12-CD34', learner_id: L1, enrollment_id: id(3, 3), version_id: V_PUB, attempt_id: id(3, 8), learner_name: 'Tina Manager', dealer_name: 'HQ Medical', issued_at: '2026-10-02T00:00:00Z', status: 'valid' },
      ],
      academy_external_certs: [
        { id: X1, learner_id: L2, course_id: C_GOLD, manufacturer_slug: 'golden-technologies', status: 'certificate_uploaded', upload_media_id: id(3, 10), created_at: '2026-10-03T00:00:00Z' },
        { id: X2, learner_id: L1, course_id: C_GOLD, manufacturer_slug: 'golden-technologies', status: 'verified', evidence_type: 'manufacturer_confirmation', evidence_ref: 'email 3 Oct', verified_by: 'staff:ann@hcps.us', verified_at: '2026-10-04T00:00:00Z', created_at: '2026-10-02T00:00:00Z' },
      ],
      product_facts: [
        { id: F1, manufacturer_slug: 'golden-technologies', model_code: 'PR-401', field: 'weight_capacity', value: 375, unit: 'lb', field_class: 'approval_required', status: 'verified', source_url: 'https://golden.example/pr401.pdf', source_label: 'Golden sell sheet', verified_on: '2026-09-01', verified_by: 'staff:angelo@hcps.us', valid_from: '2026-09-01T00:00:00Z', valid_to: null, replaced_by: null },
        { id: F_OLD, manufacturer_slug: 'golden-technologies', model_code: 'PR-401', field: 'weight_capacity', value: 350, unit: 'lb', field_class: 'approval_required', status: 'verified', source_url: 'https://golden.example/old.pdf', source_label: 'Old sheet', verified_on: '2025-01-01', verified_by: 'staff:angelo@hcps.us', valid_from: '2025-01-01T00:00:00Z', valid_to: '2026-09-01T00:00:00Z', replaced_by: F1 },
      ],
      academy_events: [
        { id: 1, at: '2026-10-05T00:00:00Z', actor_type: 'learner', actor: 'learner:' + L1, entity: 'academy_attempts', entity_id: id(3, 8), action: 'submit_attempt', before: { answers: null }, after: { answers: { q: ANSWER_SENTINEL }, score: 90 } },
        { id: 2, at: '2026-10-06T00:00:00Z', actor_type: 'staff', actor: 'staff:ann@hcps.us', entity: 'academy_questions', entity_id: id(1, 1), action: 'x', before: null, after: { answer_key: KEY_SENTINEL, nested: { choices: [PROMPT_SENTINEL] } } },
        { id: 3, at: '2026-10-07T00:00:00Z', actor_type: 'staff', actor: 'staff:angelo@hcps.us', entity: 'academy_courses', entity_id: C_CERT, action: 'create_course', before: null, after: { title: 'Lift Chair Specialist' } },
      ],
    },
  };
  return Object.assign(s, extra || {});
}

/* The audited operations: record exactly what the server sends; answer like the database would (a row, or an error). */
function withOps(w, answers) {
  const base = global.fetch; const sent = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(BASE + '/rest/v1/rpc/academy_op_')) {
      const name = u.slice((BASE + '/rest/v1/rpc/academy_op_').length); const args = JSON.parse(opts.body); sent.push({ name, args });
      const a = (answers || {})[name]; const out = typeof a === 'function' ? a(args) : (a || { status: 200, body: { id: 'row', ok: true } });
      return { ok: out.status < 300, status: out.status, text: async () => JSON.stringify(out.body) };
    }
    return base(url, opts);
  };
  return sent;
}
// The real academy_events.id is an identity column; the harness would give new rows text ids, so number them in order.
function numberEvents(w) {
  const base = w.fetch; let next = 1000;
  w.fetch = async (u, o) => { const r = await base(u, o); for (const e of w.db.academy_events || []) { if (typeof e.id !== 'number') e.id = ++next; if (!e.at) e.at = new Date().toISOString(); } return r; };
  return w;
}
const world = (extra, opsOpts) => numberEvents(contentOps(createWorld(seed(extra)), opsOpts));
const mod = w => load('academy-admin-api.js', w, {});
const as = tok => ({ token: tok });
const FORBIDDEN_WRITE_TABLES = ['app_settings', 'manufacturers', 'dealers', 'staff_users', 'academy_certificates', 'academy_external_certs',
                                'product_facts', 'academy_memberships', 'academy_attempts', 'academy_questions', 'academy_enrollments', 'orders', 'dealer_users'];
const C1_READS = ['overview', 'list_manufacturers', 'list_courses', 'get_course', 'get_version', 'list_learners', 'dealer_summary', 'list_facts', 'list_certificates', 'list_external_certs', 'list_events', 'audit_check'];
const C1_WRITES = ['create_course', 'update_course', 'create_version', 'update_version', 'submit_for_review', 'return_to_draft', 'publish_version', 'retire_version',
                   'create_module', 'update_module', 'delete_module', 'create_lesson', 'update_lesson', 'delete_lesson', 'set_training_manager', 'record_fact', 'withdraw_fact', 'review_external_cert'];
const IDENTITY_SPOOF = { actor: 'staff:evil@else.com', p_actor: 'staff:evil@else.com', verified_by: 'staff:evil@else.com', approved_by: 'staff:evil@else.com',
                         p_approved_by: 'staff:evil@else.com', published_by: 'staff:evil@else.com', email: 'evil@else.com', role: 'president', staff: { email: 'evil@else.com', role: 'president' } };
const noForbiddenWrites = w => { const bad = w.writes.filter(x => FORBIDDEN_WRITE_TABLES.includes(x.table)); assert.deepStrictEqual(bad, [], JSON.stringify(bad)); };

(async () => {
  // ---------- 1. the switch ----------
  await t('switch OFF: every Command Center action is refused (403 flag_off), even for the President; whoami still answers', async () => {
    const w = world(); w.db.app_settings[0].value = {}; const m = mod(w); const ops = withOps(w);
    for (const action of [...C1_READS, ...C1_WRITES]) {
      const r = await call(m, { action, id: V_DRAFT }, as('pres'));
      assert.strictEqual(r.status, 403, action); assert.strictEqual(r.body.error, 'flag_off', action);
    }
    const who = await call(m, { action: 'whoami' }, as('pres'));
    assert.strictEqual(who.status, 200); assert.strictEqual(who.body.enabled, false); assert.strictEqual(who.body.may.publish, true);
    assert.strictEqual(ops.length, 0); assert.strictEqual(w.writes.length, 0);
  });
  await t('switch "true" (a string), 1, or an unreadable settings row all count as OFF (fail closed)', async () => {
    for (const v of [{ academy_admin: 'true' }, { academy_admin: 1 }]) {
      const w = world(); w.db.app_settings[0].value = v; assert.strictEqual((await call(mod(w), { action: 'overview' }, as('pres'))).status, 403);
    }
    const w = world({ failRead: table => table === 'app_settings' ? 500 : 0 });
    assert.strictEqual((await call(mod(w), { action: 'overview' }, as('pres'))).status, 403);
  });

  // ---------- 2. who may do what ----------
  await t('reps and Relations are refused EVERY Command Center action (403) and nothing is read into a response or written', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    for (const tok of ['greg', 'lori']) for (const action of [...C1_READS, ...C1_WRITES, 'no_such_action']) {
      const r = await call(m, Object.assign({ action, id: V_DRAFT, course_id: C_CERT, version_id: V_DRAFT, module_id: M_DRAFT }, IDENTITY_SPOOF), as(tok));
      assert.strictEqual(r.status, 403, tok + ' ' + action); assert.strictEqual(r.body.error, 'forbidden');
    }
    assert.strictEqual(ops.length, 0); assert.strictEqual(w.writes.length, 0);
  });
  await t('no sign-in, an inactive account, an unknown login, or a learner session cookie: 401 for every action', async () => {
    const w = world(); const m = mod(w);
    for (const opts of [{}, as('old'), as('stranger'), { headers: { cookie: '__Host-hcps_academy=abc' } }])
      for (const action of ['whoami', 'overview', 'create_course', 'publish_version']) assert.strictEqual((await call(m, { action }, opts)).status, 401, action);
    assert.strictEqual(w.writes.length, 0);
  });
  await t('administrators (president, admin, owner) can open every read', async () => {
    const w = world(); const m = mod(w);
    for (const tok of ['pres', 'admin', 'owner']) for (const action of C1_READS) {
      const r = await call(m, { action, id: action === 'get_course' ? C_CERT : V_DRAFT }, as(tok));
      assert.strictEqual(r.status, 200, tok + ' ' + action + ' ' + JSON.stringify(r.body)); assert.strictEqual(r.body.ok, true);
    }
    assert.strictEqual(w.writes.length, 0);
  });
  await t('an unknown action is 404 for an administrator', async () => {
    const w = world(); assert.strictEqual((await call(mod(w), { action: 'drop_everything' }, as('admin'))).status, 404);
  });
  await t('nothing in C1 can issue or revoke a certificate, start/submit/correct an exam, or change a switch', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    for (const action of ['issue_certificate', 'revoke_certificate', 'start_attempt', 'submit_attempt', 'correct_attempt', 'set_switch', 'set_flag', 'publish_course', 'delete_course', 'list_questions', 'get_question'])
      assert.strictEqual((await call(m, { action, id: CERT1 }, as('pres'))).status, 404, action);
    assert.strictEqual(ops.length, 0); assert.strictEqual(w.writes.length, 0);
  });
  await t('changes must be POST: a GET naming a write is refused (405) and changes nothing', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    for (const action of C1_WRITES) {
      const r = await m.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer pres' }, queryStringParameters: { action, id: V_DRAFT, title: 'x' } });
      assert.strictEqual(r.statusCode, 405, action);
    }
    const ok = await m.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer pres' }, queryStringParameters: { action: 'overview' } });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ops.length, 0); assert.strictEqual(w.writes.length, 0);
  });

  // ---------- 3. publishing: the President only, through the audited operation ----------
  await t('publish/retire: an admin or owner is refused (403 president_only) and the operation is never called', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    for (const tok of ['admin', 'owner']) {
      for (const [action, b] of [['publish_version', { id: V_DRAFT }], ['retire_version', { id: V_PUB, reason: 'old' }]]) {
        const r = await call(m, Object.assign({ action }, b, IDENTITY_SPOOF), as(tok));
        assert.strictEqual(r.status, 403, tok + action); assert.strictEqual(r.body.error, 'president_only');
      }
    }
    assert.strictEqual(ops.length, 0); assert.strictEqual(w.writes.length, 0);
  });
  await t('publish/retire by the President go ONLY through academy_op_* with the signed-in President as actor (request fields ignored)', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    const p = await call(m, Object.assign({ action: 'publish_version', id: V_DRAFT }, IDENTITY_SPOOF), as('pres'));
    assert.strictEqual(p.status, 200); assert.strictEqual(p.body.audited, true);
    const r = await call(m, Object.assign({ action: 'retire_version', id: V_PUB, reason: 'Superseded by v2' }, IDENTITY_SPOOF), as('pres'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(ops, [{ name: 'publish_version', args: { p_actor: 'staff:angelo@hcps.us', p_version_id: V_DRAFT } },
                                 { name: 'retire_version', args: { p_actor: 'staff:angelo@hcps.us', p_version_id: V_PUB, p_reason: 'Superseded by v2' } }]);
    assert.strictEqual(w.writes.length, 0);   // no plain table write: the database operation is the only road
  });
  await t('retire needs a reason; a bad version id is refused before the database is asked', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    assert.strictEqual((await call(m, { action: 'retire_version', id: V_PUB }, as('pres'))).status, 400);
    assert.strictEqual((await call(m, { action: 'publish_version', id: "x' or 1=1" }, as('pres'))).status, 400);
    assert.strictEqual(ops.length, 0);
  });
  await t('the database refusing a publish (too few exam questions / unverified facts) comes back as a plain 400 with its reason', async () => {
    const w = world(); const m = mod(w);
    withOps(w, { publish_version: { status: 400, body: { code: '22023', message: 'academy: 1 active exam questions; at least 3 are needed to publish' } } });
    const r = await call(m, { action: 'publish_version', id: V_DRAFT }, as('pres'));
    assert.strictEqual(r.status, 400); assert.ok(/at least 3/.test(r.body.message), r.body.message);
  });
  await t('if the audited operations are missing, publishing says "not available" (503) — it never falls back to a plain write', async () => {
    const w = world(); const m = mod(w);
    withOps(w, { publish_version: { status: 404, body: { code: 'PGRST202', message: 'Could not find the function' } } });
    assert.strictEqual((await call(m, { action: 'publish_version', id: V_DRAFT }, as('pres'))).status, 503);
    assert.strictEqual(w.writes.length, 0);
  });
  await t('version workflow: draft -> in review -> draft by an admin (audited content operation; never to published/retired)', async () => {
    const w = world(); const m = mod(w);
    const a = await call(m, { action: 'submit_for_review', id: V_DRAFT }, as('admin'));
    assert.strictEqual(a.status, 200); assert.strictEqual(w.db.academy_course_versions.find(v => v.id === V_DRAFT).status, 'in_review');
    const b = await call(m, { action: 'return_to_draft', id: V_DRAFT }, as('admin'));
    assert.strictEqual(b.status, 200); assert.strictEqual(w.db.academy_course_versions.find(v => v.id === V_DRAFT).status, 'draft');
    assert.strictEqual((await call(m, { action: 'submit_for_review', id: V_PUB }, as('pres'))).status, 409);
    assert.strictEqual((await call(m, { action: 'return_to_draft', id: V_PUB }, as('pres'))).status, 409);
    const ev = w.db.academy_events.filter(e => e.entity === 'academy_course_versions');
    assert.deepStrictEqual(ev.map(e => [e.action, e.actor]), [['submit_for_review', 'staff:ann@hcps.us'], ['return_to_draft', 'staff:ann@hcps.us']]);
    assert.deepStrictEqual(w.contentCalls.map(c => [c.name, c.args.p_to]), [['move_version', 'in_review'], ['move_version', 'draft']]);
    assert.deepStrictEqual(w.writes.filter(x => x.table), []);   // no plain table write
  });

  // ---------- 4. published and in-review content cannot be edited ----------
  await t('a published or in-review version: its settings, modules and lessons cannot be changed or added to (409, nothing written)', async () => {
    const w = world(); const m = mod(w);
    const tries = [
      { action: 'update_version', id: V_PUB, pass_mark: 50 }, { action: 'update_version', id: V_REVIEW, pass_mark: 50 },
      { action: 'create_module', version_id: V_PUB, title: 'Sneak' }, { action: 'create_module', version_id: V_REVIEW, title: 'Sneak' },
      { action: 'update_module', id: M_PUB, title: 'Changed' }, { action: 'delete_module', id: M_PUB },
      { action: 'create_lesson', module_id: M_PUB, title: 'Sneak' }, { action: 'update_lesson', id: LS_PUB, title: 'Changed' },
      { action: 'delete_lesson', id: LS_PUB }, { action: 'update_lesson', id: LS_REVIEW, est_minutes: 3 }, { action: 'delete_lesson', id: LS_REVIEW },
    ];
    for (const b of tries) { const r = await call(m, b, as('pres')); assert.strictEqual(r.status, 409, JSON.stringify(b) + ' ' + JSON.stringify(r.body)); }
    assert.strictEqual(w.writes.length, 0);
    assert.strictEqual(w.contentCalls.length, 0, 'refused by the server before the database is asked (the database refuses again)');
  });
  await t('a version that turns published while being edited is not changed (the database re-checks under a lock: 409 locked)', async () => {
    const w = world(); const m = mod(w);
    // The status read says draft; by the time the operation runs it is published.
    const base = global.fetch; global.fetch = async (url, opts) => {
      if (String(url).includes('/rpc/academy_content_op_')) w.db.academy_course_versions.find(v => v.id === V_DRAFT).status = 'published';
      return base(url, opts);
    };
    const r = await call(m, { action: 'update_version', id: V_DRAFT, pass_mark: 60 }, as('pres'));
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'locked'); assert.ok(/published/.test(r.body.message), r.body.message);
    assert.strictEqual(w.db.academy_course_versions.find(v => v.id === V_DRAFT).pass_mark, 80);
    assert.strictEqual(w.db.academy_events.filter(e => e.action === 'update_version').length, 0);
  });
  await t('a course learners have seen (a published/retired version) changes only with the President; a draft course by any admin', async () => {
    const w = world(); const m = mod(w);
    const r1 = await call(m, { action: 'update_course', id: C_PUB, title: 'Renamed' }, as('admin'));
    assert.strictEqual(r1.status, 403); assert.strictEqual(w.db.academy_courses.find(c => c.id === C_PUB).title, 'Golden Basics');
    assert.strictEqual(w.contentCalls.length, 0);
    const r2 = await call(m, { action: 'update_course', id: C_PUB, title: 'Golden Basics (2026)' }, as('pres'));
    assert.strictEqual(r2.status, 200); assert.strictEqual(w.db.academy_courses.find(c => c.id === C_PUB).title, 'Golden Basics (2026)');
    const r3 = await call(m, { action: 'update_course', id: C_CERT, title: 'Lift Chair Specialist I', category: 'Seating' }, as('admin'));
    assert.strictEqual(r3.status, 200);
    const ev = w.db.academy_events.filter(e => e.action === 'update_course');
    assert.deepStrictEqual(ev.map(e => e.actor), ['staff:angelo@hcps.us', 'staff:ann@hcps.us']);
    assert.strictEqual(ev[1].before.title, 'Lift Chair Specialist'); assert.strictEqual(ev[1].after.title, 'Lift Chair Specialist I');
  });
  await t('a course\'s slug, type, issuer and status cannot be changed through update_course', async () => {
    const w = world(); const m = mod(w);
    const r = await call(m, { action: 'update_course', id: C_CERT, slug: 'hacked', course_type: 'training', issuer: 'manufacturer', status: 'published', title: 'T' }, as('pres'));
    assert.strictEqual(r.status, 200);
    const c = w.db.academy_courses.find(x => x.id === C_CERT);
    assert.deepStrictEqual([c.slug, c.course_type, c.issuer, c.status], ['golden-lift-chair-specialist', 'hcps_certification', 'hcps', 'draft']);
  });

  // ---------- 5. building content ----------
  await t('create course: issuer follows the type (never the request), status is always draft, the manufacturer must exist', async () => {
    const w = world(); const m = mod(w);
    const r = await call(m, { action: 'create_course', slug: 'pride-scooter-basics', title: 'Scooter Basics', course_type: 'training', issuer: 'hcps', status: 'published', manufacturer_slug: 'pride-mobility' }, as('admin'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const c = w.db.academy_courses.find(x => x.slug === 'pride-scooter-basics');
    assert.deepStrictEqual([c.issuer, c.status, c.manufacturer_slug], ['none', 'draft', 'pride-mobility']);
    assert.strictEqual(r.body.course.credential.label, 'Training only');
    const h = await call(m, { action: 'create_course', slug: 'hcps-seating', title: 'Seating', course_type: 'hcps_certification', issuer: 'manufacturer' }, as('admin'));
    assert.strictEqual(h.status, 200); assert.strictEqual(w.db.academy_courses.find(x => x.slug === 'hcps-seating').issuer, 'hcps');
    assert.strictEqual((await call(m, { action: 'create_course', slug: 'x-course', title: 'X', course_type: 'training', manufacturer_slug: 'not-a-maker' }, as('admin'))).status, 400);
    const ev = w.db.academy_events.filter(e => e.action === 'create_course' && e.actor === 'staff:ann@hcps.us');
    assert.strictEqual(ev.length, 2);
    noForbiddenWrites(w);
  });
  await t('create course: a manufacturer program needs its manufacturer and an https training link; others may not link out', async () => {
    const w = world(); const m = mod(w);
    const bad = [
      { slug: 'gp1', title: 'G', course_type: 'manufacturer_program', external_url: 'https://golden.example/x' },
      { slug: 'gp2', title: 'G', course_type: 'manufacturer_program', manufacturer_slug: 'golden-technologies', external_url: 'http://golden.example/x' },
      { slug: 'gp3', title: 'G', course_type: 'manufacturer_program', manufacturer_slug: 'golden-technologies', external_url: 'javascript:alert(1)' },
      { slug: 'gp4', title: 'G', course_type: 'manufacturer_program', manufacturer_slug: 'golden-technologies' },
      { slug: 'gp5', title: 'G', course_type: 'training', external_url: 'https://elsewhere.example' },
      { slug: 'Bad Slug', title: 'G', course_type: 'training' }, { slug: 'ok-slug', title: '', course_type: 'training' },
      { slug: 'ok-slug', title: 'G', course_type: 'golden_certificate' }, { slug: '-lead', title: 'G', course_type: 'training' },
    ];
    for (const b of bad) assert.strictEqual((await call(m, Object.assign({ action: 'create_course' }, b), as('admin'))).status, 400, JSON.stringify(b));
    const ok = await call(m, { action: 'create_course', slug: 'golden-elite', title: 'Golden Elite', course_type: 'manufacturer_program', manufacturer_slug: 'golden-technologies', external_url: 'https://golden.example/elite' }, as('admin'));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.course.credential.label, 'Manufacturer-issued credential');
    assert.strictEqual(w.db.academy_courses.filter(c => /^gp|^ok-slug|^-lead|bad/i.test(c.slug)).length, 0);
  });
  await t('a duplicate slug is a plain 409', async () => {
    const w = world({ unique: { academy_courses: [['slug']] } }); const m = mod(w);
    assert.strictEqual((await call(m, { action: 'create_course', slug: 'golden-basics', title: 'Again', course_type: 'training' }, as('admin'))).status, 409);
  });
  await t('versions: numbered in order, draft only, bounded settings; manufacturer programs have none', async () => {
    const w = world(); const m = mod(w);
    const r = await call(m, { action: 'create_version', course_id: C_PUB, status: 'published', published_at: '2026-01-01', pass_mark: 85 }, as('admin'));
    assert.strictEqual(r.status, 200); const v = w.db.academy_course_versions.find(x => x.course_id === C_PUB && x.version === 3);
    assert.ok(v); assert.deepStrictEqual([v.status, v.pass_mark, v.exam_questions, v.published_at], ['draft', 85, 25, null]);
    assert.strictEqual((await call(m, { action: 'create_version', course_id: C_GOLD }, as('admin'))).status, 400);
    for (const b of [{ pass_mark: 0 }, { pass_mark: 101 }, { exam_questions: 0 }, { pass_mark: '80; drop' }, { validity_months: -1 }, { pass_mark: 79.5 }])
      assert.strictEqual((await call(m, Object.assign({ action: 'update_version', id: V_DRAFT }, b), as('admin'))).status, 400, JSON.stringify(b));
    const u = await call(m, { action: 'update_version', id: V_DRAFT, pass_mark: 75, validity_months: '', status: 'published' }, as('admin'));
    assert.strictEqual(u.status, 200); const d = w.db.academy_course_versions.find(x => x.id === V_DRAFT);
    assert.deepStrictEqual([d.pass_mark, d.validity_months, d.status], [75, null, 'draft']);
  });
  await t('modules and lessons on a draft: add (next position), edit, remove; a module with lessons is not removed', async () => {
    const w = world(); const m = mod(w);
    const a = await call(m, { action: 'create_module', version_id: V_DRAFT, title: 'Controls', objectives: ['Use the hand control'] }, as('admin'));
    assert.strictEqual(a.status, 200); assert.strictEqual(a.body.module.position, 3);
    const l = await call(m, { action: 'create_lesson', module_id: a.body.module.id, title: 'Hand controls', est_minutes: 12 }, as('admin'));
    assert.strictEqual(l.status, 200); assert.strictEqual(l.body.lesson.position, 1);
    assert.strictEqual((await call(m, { action: 'create_lesson', module_id: M_DRAFT, title: 'Too long', est_minutes: 45 }, as('admin'))).status, 400);
    assert.strictEqual((await call(m, { action: 'update_lesson', id: LS_DRAFT, title: 'Motors & actuators', blocks: [{ type: 'html', html: '<script>' }] }, as('admin'))).status, 200);
    assert.deepStrictEqual(w.db.academy_lessons.find(x => x.id === LS_DRAFT).blocks, [{ type: 'text' }]);   // blocks are not edited in C1
    assert.strictEqual((await call(m, { action: 'delete_module', id: M_DRAFT }, as('admin'))).status, 409);
    assert.strictEqual((await call(m, { action: 'delete_module', id: M_EMPTY }, as('admin'))).status, 200);
    assert.strictEqual((await call(m, { action: 'delete_lesson', id: l.body.lesson.id }, as('admin'))).status, 200);
    const acts = w.db.academy_events.slice(3).filter(e => e.actor === 'staff:ann@hcps.us').map(e => e.action);
    assert.deepStrictEqual(acts, ['create_module', 'create_lesson', 'update_lesson', 'delete_module', 'delete_lesson']);
    noForbiddenWrites(w);
  });
  await t('objectives: at most 12 short lines; anything else is refused', async () => {
    const w = world(); const m = mod(w);
    for (const objectives of ['one string', Array(13).fill('x'), ['x'.repeat(301)], [''], [{}]])
      assert.strictEqual((await call(m, { action: 'create_module', version_id: V_DRAFT, title: 'M', objectives }, as('admin'))).status, 400, JSON.stringify(objectives).slice(0, 40));
  });

  // ---------- 6. identity always from the sign-in ----------
  await t('Training Manager role: through academy_op_set_training_manager, actor = the signed-in admin, reason required', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    assert.strictEqual((await call(m, Object.assign({ action: 'set_training_manager', membership_id: MEM2, make: true }, IDENTITY_SPOOF), as('admin'))).status, 400);
    assert.strictEqual((await call(m, { action: 'set_training_manager', membership_id: MEM2, make: 'yes', reason: 'r' }, as('admin'))).status, 400);
    const r = await call(m, Object.assign({ action: 'set_training_manager', membership_id: MEM2, make: true, reason: 'Store lead' }, IDENTITY_SPOOF), as('admin'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(ops, [{ name: 'set_training_manager', args: { p_actor: 'staff:ann@hcps.us', p_membership_id: MEM2, p_make: true, p_reason: 'Store lead' } }]);
    assert.strictEqual(w.writes.length, 0);
  });
  await t('Golden credential review: through academy_op_review_external_cert; actor from the sign-in; evidence required to verify; note to reject', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    assert.strictEqual((await call(m, { action: 'review_external_cert', id: X1, decision: 'verified' }, as('admin'))).status, 400);
    assert.strictEqual((await call(m, { action: 'review_external_cert', id: X1, decision: 'rejected' }, as('admin'))).status, 400);
    assert.strictEqual((await call(m, { action: 'review_external_cert', id: X1, decision: 'passed', evidence_type: 'golden_certificate' }, as('admin'))).status, 400);
    const r = await call(m, Object.assign({ action: 'review_external_cert', id: X1, decision: 'verified', evidence_type: 'golden_certificate', evidence_ref: 'upload' }, IDENTITY_SPOOF), as('admin'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(ops[0], { name: 'review_external_cert', args: { p_actor: 'staff:ann@hcps.us', p_id: X1, p_decision: 'verified', p_evidence_type: 'golden_certificate', p_evidence_ref: 'upload', p_note: null } });
    assert.strictEqual(w.writes.length, 0);
  });
  await t('product facts: verified_by and approved_by are the signed-in person, never the request; approval-required facts need the President', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    const fact = { manufacturer_slug: 'golden-technologies', model_code: 'pr-401', field: 'weight_capacity', value: 400, unit: 'lb', status: 'verified',
                   source_url: 'https://golden.example/pr401-2026.pdf', source_label: 'Golden sell sheet 2026', verified_on: '2026-10-01', supersedes: F1 };
    const r1 = await call(m, Object.assign({ action: 'record_fact', field_class: 'approval_required' }, fact, IDENTITY_SPOOF), as('admin'));
    assert.strictEqual(r1.status, 403); assert.strictEqual(ops.length, 0);
    const r2 = await call(m, Object.assign({ action: 'record_fact', field_class: 'approval_required' }, fact, IDENTITY_SPOOF), as('pres'));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    const a = ops[0].args;
    assert.strictEqual(ops[0].name, 'record_fact'); assert.strictEqual(a.p_actor, 'staff:angelo@hcps.us'); assert.strictEqual(a.p_approved_by, 'staff:angelo@hcps.us');
    assert.strictEqual(a.p_fact.verified_by, 'staff:angelo@hcps.us'); assert.strictEqual(a.p_fact.model_code, 'PR-401'); assert.strictEqual(a.p_supersedes, F1);
    const r3 = await call(m, Object.assign({ action: 'record_fact', field_class: 'display' }, fact, { field: 'color', value: 'Burgundy', supersedes: null }, IDENTITY_SPOOF), as('admin'));
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(ops[1].args.p_approved_by, null); assert.strictEqual(ops[1].args.p_fact.verified_by, 'staff:ann@hcps.us'); assert.strictEqual(ops[1].args.p_supersedes, null);
    assert.strictEqual(w.writes.length, 0);
  });
  await t('product facts: a source link (https), a source name, a real past date, a value and a known manufacturer are all required', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    const good = { action: 'record_fact', manufacturer_slug: 'golden-technologies', model_code: 'PR-401', field: 'color', value: 'Red', field_class: 'display', status: 'verified',
                   source_url: 'https://golden.example/a.pdf', source_label: 'Sheet', verified_on: '2026-10-01' };
    const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    for (const bad of [{ source_url: 'http://golden.example/a.pdf' }, { source_url: '' }, { source_label: '' }, { verified_on: future }, { verified_on: '2026-13-45' },
                       { value: '' }, { value: null }, { manufacturer_slug: 'nobody' }, { field: 'Bad Field' }, { model_code: '' }, { status: 'approved' }, { field_class: 'auto' }])
      assert.strictEqual((await call(m, Object.assign({}, good, bad), as('admin'))).status, 400, JSON.stringify(bad));
    assert.strictEqual(ops.length, 0);
    assert.strictEqual((await call(m, good, as('admin'))).status, 200);
  });
  await t('withdrawing a fact goes through academy_op_withdraw_fact with a reason; the actor is the signed-in admin', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    assert.strictEqual((await call(m, { action: 'withdraw_fact', id: F1 }, as('admin'))).status, 400);
    assert.strictEqual((await call(m, Object.assign({ action: 'withdraw_fact', id: F1, reason: 'Manufacturer disputes the figure' }, IDENTITY_SPOOF), as('admin'))).status, 200);
    assert.deepStrictEqual(ops, [{ name: 'withdraw_fact', args: { p_actor: 'staff:ann@hcps.us', p_fact_id: F1, p_reason: 'Manufacturer disputes the figure' } }]);
  });
  await t('ordinary writes record the signed-in admin in the audit row even when the request names someone else', async () => {
    const w = world(); const m = mod(w);
    await call(m, Object.assign({ action: 'create_module', version_id: V_DRAFT, title: 'Spoofed?' }, IDENTITY_SPOOF), as('admin'));
    const e = w.db.academy_events[w.db.academy_events.length - 1];
    assert.strictEqual(e.actor, 'staff:ann@hcps.us'); assert.strictEqual(e.actor_type, 'staff');
    assert.ok(!JSON.stringify(w.db.academy_events).includes('evil@else.com'));
  });
  const ORDINARY = [
    { action: 'create_course', slug: 'blocked-course', title: 'B', course_type: 'training' }, { action: 'update_course', id: C_CERT, title: 'B' },
    { action: 'create_version', course_id: C_CERT }, { action: 'update_version', id: V_DRAFT, pass_mark: 61 }, { action: 'submit_for_review', id: V_DRAFT },
    { action: 'return_to_draft', id: V_REVIEW }, { action: 'create_module', version_id: V_DRAFT, title: 'B' }, { action: 'update_module', id: M_DRAFT, title: 'B' },
    { action: 'delete_module', id: M_EMPTY }, { action: 'create_lesson', module_id: M_DRAFT, title: 'B' }, { action: 'update_lesson', id: LS_DRAFT, title: 'B' },
    { action: 'delete_lesson', id: LS_DRAFT },
  ];
  const CONTENT = ['academy_courses', 'academy_course_versions', 'academy_modules', 'academy_lessons', 'academy_events'];
  const snapshot = w => JSON.stringify(CONTENT.map(k => w.db[k]));
  await t('M2: every ordinary write is ONE call to its academy_content_op_* operation, with the signed-in person as actor — never a plain table write', async () => {
    const w = world(); const m = mod(w);
    const seq = ORDINARY.filter(b => !/review|draft$/.test(b.action)).concat([{ action: 'submit_for_review', id: V_DRAFT }, { action: 'return_to_draft', id: V_DRAFT }]);
    for (const b of seq) { const r = await call(m, Object.assign({}, b, IDENTITY_SPOOF), as('admin')); assert.strictEqual(r.status, 200, b.action + ' ' + JSON.stringify(r.body)); }
    assert.deepStrictEqual(w.contentCalls.map(c => c.name), ['create_course', 'update_course', 'create_version', 'update_version',
      'create_module', 'update_module', 'delete_module', 'create_lesson', 'update_lesson', 'delete_lesson', 'move_version', 'move_version']);
    assert.ok(w.contentCalls.every(c => c.args.p_actor === 'staff:ann@hcps.us'), JSON.stringify(w.contentCalls.map(c => c.args.p_actor)));
    assert.deepStrictEqual(w.writes.filter(x => x.table), [], 'a plain table write was made');
    assert.strictEqual(w.writes.filter(x => x.kind === 'content_op').length, ORDINARY.length);
    // each call carried only the fields the operation accepts (no status, issuer, position, version number or id smuggled in)
    const sent = w.contentCalls.map(c => Object.keys(c.args.p_course || c.args.p_changes || c.args.p_settings || c.args.p_module || c.args.p_lesson || {}).sort().join(','));
    assert.deepStrictEqual(sent, ['course_type,slug,title', 'title', 'exam_questions,pass_mark', 'pass_mark', 'objectives,title', 'title', '', 'est_minutes,title', 'title', '', '', '']);
  });
  await t('M2: if the audit row cannot be written the database refuses the whole change — 502, nothing changed, nothing recorded', async () => {
    const w = world(null, { auditFails: true }); const m = mod(w); const before = snapshot(w);
    for (const b of ORDINARY) { const r = await call(m, b, as('admin')); assert.strictEqual(r.status, 502, b.action); assert.strictEqual(r.body.error, 'write_failed'); }
    assert.strictEqual(snapshot(w), before); assert.deepStrictEqual(w.writes, []);
  });
  await t('M2 not installed: every ordinary write answers 503 "not available" and nothing is written (no fallback to a plain write)', async () => {
    const w = world(null, { missing: true }); const m = mod(w); const before = snapshot(w);
    for (const b of ORDINARY) { const r = await call(m, b, as('admin')); assert.strictEqual(r.status, 503, b.action); assert.strictEqual(r.body.error, 'not_installed'); }
    assert.strictEqual(snapshot(w), before); assert.deepStrictEqual(w.writes, []);
  });
  await t('M2: the database\'s own refusals come back plainly — 403 with its reason, 404, 409 conflict / locked, 400 with its reason', async () => {
    const w = world(); const m = mod(w); const base = global.fetch; let answer = null;
    global.fetch = async (url, opts) => String(url).includes('/rpc/academy_content_op_') && answer
      ? { ok: false, status: answer[0], text: async () => JSON.stringify({ code: answer[1], message: answer[2] }) } : base(url, opts);
    const cases = [[403, '42501', 'academy: only the President may change a course learners have seen', 403, 'forbidden', /only the President/],
                   [404, 'P0002', 'academy: lesson not found', 404, 'not_found', /Not found/], [409, '23505', 'duplicate key', 409, 'conflict', /already exists/],
                   [409, '55000', 'academy: this version is in review; return it to draft before editing', 409, 'locked', /in review/],
                   [400, '22023', 'academy: objectives are up to 12 lines of up to 300 characters', 400, 'refused', /objectives/],
                   [500, 'XX000', 'internal: secret detail', 502, 'write_failed', /nothing was changed/]];
    for (const [st, code, msg, want, err, re] of cases) {
      answer = [st, code, msg];
      const r = await call(m, { action: 'update_lesson', id: LS_DRAFT, title: 'x' }, as('admin'));
      assert.strictEqual(r.status, want, code); assert.strictEqual(r.body.error, err, code); assert.ok(re.test(r.body.message), r.body.message);
      assert.ok(!/secret detail|academy:/.test(r.body.message), r.body.message);
    }
  });
  await t('records check: clean after Command Center changes; finds outside edits, unrecorded rows and recorded-but-missing rows', async () => {
    const w = world(); const m = mod(w);
    // seed rows have no history yet: all unrecorded
    const first = (await call(m, { action: 'audit_check' }, as('admin'))).body;
    assert.strictEqual(first.clean, false); assert.ok(first.counts.unrecorded >= 10);
    // a fresh world where every row was made through the Command Center
    const w2 = world({ tables: Object.assign(seed().tables, { academy_courses: [], academy_course_versions: [], academy_modules: [], academy_lessons: [], academy_questions: [], academy_events: [] }) });
    const m2 = mod(w2);
    const c = (await call(m2, { action: 'create_course', slug: 'clean-course', title: 'Clean', course_type: 'hcps_certification' }, as('admin'))).body.course;
    const v = (await call(m2, { action: 'create_version', course_id: c.id }, as('admin'))).body.version;
    const mo = (await call(m2, { action: 'create_module', version_id: v.id, title: 'M1', objectives: ['a'] }, as('admin'))).body.module;
    const le = (await call(m2, { action: 'create_lesson', module_id: mo.id, title: 'L1', est_minutes: 5 }, as('admin'))).body.lesson;
    await call(m2, { action: 'update_lesson', id: le.id, title: 'L1b' }, as('admin')); await call(m2, { action: 'update_version', id: v.id, pass_mark: 70 }, as('admin'));
    const ok = (await call(m2, { action: 'audit_check' }, as('admin'))).body;
    assert.strictEqual(ok.clean, true, JSON.stringify(ok)); assert.strictEqual(ok.checked, 4);
    // an edit made outside the Command Center
    w2.db.academy_lessons[0].title = 'Edited by hand';
    // a recorded create whose write failed and whose failure record was lost
    w2.db.academy_events.push({ id: 5000, actor_type: 'staff', actor: 'staff:ann@hcps.us', entity: 'academy_modules', entity_id: id(6, 99), action: 'create_module', after: { title: 'ghost', _ref: 'r-ghost' } });
    // a failed action with its failure record is NOT reported
    w2.db.academy_events.push({ id: 5001, actor_type: 'staff', actor: 'staff:ann@hcps.us', entity: 'academy_modules', entity_id: id(6, 98), action: 'create_module', after: { title: 'x', _ref: 'r-ok' } },
                              { id: 5002, actor_type: 'staff', actor: 'staff:ann@hcps.us', entity: 'academy_modules', entity_id: id(6, 98), action: 'create_module_failed', after: { _ref: 'r-ok' } });
    const bad = (await call(m2, { action: 'audit_check' }, as('admin'))).body;
    assert.deepStrictEqual(bad.counts, { unrecorded: 0, drift: 1, missing: 1 });
    assert.deepStrictEqual(bad.drift[0].fields, ['title']); assert.strictEqual(bad.missing[0].id, id(6, 99)); assert.strictEqual(bad.failed_actions, 1);
    assert.strictEqual((await call(m2, { action: 'audit_check' }, as('greg'))).status, 403);
  });

  // ---------- 7. no exam answers, strict reads, separation of credentials ----------
  await t('no read ever returns an answer key, a question prompt or choices, or a learner\'s answers (audit history included)', async () => {
    const w = world(); const m = mod(w);
    let all = '';
    for (const action of C1_READS) for (const extra of [{}, { history: true }]) {
      const r = await call(m, Object.assign({ action, id: action === 'get_course' ? C_CERT : V_DRAFT }, extra), as('pres'));
      assert.strictEqual(r.status, 200, action); all += JSON.stringify(r.body);
    }
    for (const s of [KEY_SENTINEL, ANSWER_SENTINEL, PROMPT_SENTINEL]) assert.ok(!all.includes(s), s);
    const ver = (await call(m, { action: 'get_version', id: V_DRAFT }, as('pres'))).body;
    assert.deepStrictEqual(ver.questions, { exam_active: 1, practice: 1, needed: 3 });
    const qreads = w.calls.filter(c => String(c.url).includes('/academy_questions?'));
    assert.ok(qreads.length > 0); for (const c of qreads) assert.ok(/select=id,use,status(&|$)/.test(c.url), c.url);
    assert.ok(!w.calls.some(c => String(c.url).includes('/academy_attempts')), 'attempts are never read');
  });
  await t('strict reads: an unreadable table is a 503, never an empty answer', async () => {
    for (const [table, action] of [['academy_courses', 'overview'], ['academy_courses', 'list_courses'], ['academy_events', 'list_events'], ['product_facts', 'list_facts'],
                                   ['academy_memberships', 'dealer_summary'], ['academy_external_certs', 'list_external_certs'], ['academy_certificates', 'list_certificates'], ['manufacturers', 'list_manufacturers']]) {
      const w = world({ failRead: tb => tb === table ? 500 : 0 }); const r = await call(mod(w), { action }, as('pres'));
      assert.strictEqual(r.status, 503, table + ' ' + action); assert.ok(!r.body.ok);
    }
    const w = world({ failRead: tb => tb === 'academy_course_versions' ? 500 : 0 });
    assert.strictEqual((await call(mod(w), { action: 'update_version', id: V_DRAFT, pass_mark: 60 }, as('pres'))).status, 503);
    assert.strictEqual(w.writes.length, 0);
  });
  await t('HCPS-issued and manufacturer-issued credentials are listed apart and labelled by issuer', async () => {
    const w = world(); const m = mod(w);
    const h = (await call(m, { action: 'list_certificates' }, as('admin'))).body;
    assert.strictEqual(h.issuer.issuer, 'hcps'); assert.deepStrictEqual(h.certificates.map(c => [c.cert_number, c.issuer, c.course]), [['HCPS-AB12-CD34', 'hcps', 'Golden Basics']]);
    const x = (await call(m, { action: 'list_external_certs' }, as('admin'))).body;
    assert.strictEqual(x.issuer.issuer, 'manufacturer');
    assert.deepStrictEqual(x.credentials.map(c => [c.id, c.issuer, c.issued_by, c.awaiting_review]).sort(), [[X1, 'manufacturer', 'Golden Technologies', true], [X2, 'manufacturer', 'Golden Technologies', false]].sort());
    assert.ok(!JSON.stringify(h).includes(X1) && !JSON.stringify(x).includes('HCPS-AB12'));
    const c = (await call(m, { action: 'list_courses' }, as('admin'))).body.courses;
    assert.strictEqual(c.find(k => k.id === C_GOLD).credential.label, 'Manufacturer-issued credential');
    assert.strictEqual(c.find(k => k.id === C_CERT).credential.label, 'HCPS-issued certification');
    assert.strictEqual(c.find(k => k.id === C_TEST).is_test, true);
  });
  await t('overview, learners and dealership summaries count correctly (branch shown under its parent; suspended learners flagged)', async () => {
    const w = world(); const m = mod(w);
    const o = (await call(m, { action: 'overview' }, as('admin'))).body;
    assert.strictEqual(o.courses.total, 4); assert.strictEqual(o.courses.test, 1); assert.deepStrictEqual(o.versions.by_status, { draft: 2, published: 1, in_review: 1 });
    assert.strictEqual(o.dealerships.with_learners, 2); assert.strictEqual(o.dealerships.training_managers, 1);
    assert.strictEqual(o.product_facts.current, 1); assert.deepStrictEqual(o.hcps_certificates.by_status, { valid: 1 }); assert.strictEqual(o.manufacturer_credentials.total, 2);
    assert.strictEqual(o.switches.academy_admin, true); assert.strictEqual(o.switches.academy_certificates, false);
    const d = (await call(m, { action: 'dealer_summary' }, as('admin'))).body.dealerships;
    const hq = d.find(x => x.dealer_id === HQ), br = d.find(x => x.dealer_id === BR);
    assert.deepStrictEqual([hq.learners, hq.training_managers, hq.inactive_learners, hq.hcps_certificates_valid, hq.manufacturer_credentials_verified], [2, 1, 1, 1, 1]);
    assert.deepStrictEqual([br.parent, br.learners, br.enrollments.in_progress], ['HQ Medical', 1, 1]);
    const l = (await call(m, { action: 'list_learners' }, as('admin'))).body.learners;
    assert.deepStrictEqual(l.map(x => x.full_name), ['Bob Branch', 'Sam Suspended', 'Tina Manager']);
    assert.strictEqual(l[2].memberships[0].dealer, 'HQ Medical'); assert.strictEqual(l[2].memberships[0].role, 'training_manager');
  });
  await t('facts: current only by default; history shows replaced rows; filters are validated', async () => {
    const w = world(); const m = mod(w);
    const cur = (await call(m, { action: 'list_facts', manufacturer_slug: 'golden-technologies' }, as('admin'))).body.facts;
    assert.deepStrictEqual(cur.map(f => f.id), [F1]);
    const hist = (await call(m, { action: 'list_facts', model_code: 'pr-401', field: 'weight_capacity', history: true }, as('admin'))).body.facts;
    assert.deepStrictEqual(hist.map(f => [f.id, f.current]), [[F1, true], [F_OLD, false]]);
    for (const b of [{ manufacturer_slug: 'x;drop' }, { model_code: 'a b' }, { field: 'A-B' }]) assert.strictEqual((await call(m, Object.assign({ action: 'list_facts' }, b), as('admin'))).status, 400);
  });
  await t('activity: newest first, filtered, paged, and scrubbed; filters are validated', async () => {
    const w = world(); const m = mod(w);
    const a = (await call(m, { action: 'list_events', limit: 2 }, as('admin'))).body;
    assert.deepStrictEqual(a.events.map(e => e.id), [3, 2]); assert.strictEqual(a.next_before_id, 2);
    const b = (await call(m, { action: 'list_events', limit: 2, before_id: 2 }, as('admin'))).body;
    assert.deepStrictEqual(b.events.map(e => e.id), [1]); assert.strictEqual(b.events[0].after.answers, '[hidden]'); assert.strictEqual(b.events[0].after.score, 90);
    const c = (await call(m, { action: 'list_events', entity: 'academy_courses' }, as('admin'))).body;
    assert.deepStrictEqual(c.events.map(e => e.id), [3]);
    for (const x of [{ entity: 'orders' }, { event_action: 'x;drop' }, { limit: 1000 }, { before_id: 'abc' }]) assert.strictEqual((await call(m, Object.assign({ action: 'list_events' }, x), as('admin'))).status, 400, JSON.stringify(x));
  });

  await t('course status: a course with a published version shows "Published training" while its record status stays draft', async () => {
    const w = world(); const m = mod(w);
    const cs = (await call(m, { action: 'list_courses' }, as('admin'))).body.courses; const by = x => cs.find(c => c.id === x);
    assert.deepStrictEqual([by(C_PUB).status, by(C_PUB).training, by(C_PUB).published_version], ['draft', 'published', 1]);
    assert.deepStrictEqual(by(C_PUB).version_counts, { draft: 0, in_review: 1, published: 1, retired: 0 });
    assert.strictEqual(by(C_CERT).training, 'draft_only'); assert.strictEqual(by(C_GOLD).training, 'manufacturer_hosted');
    const w2 = world(); w2.db.academy_course_versions.find(v => v.id === V_PUB).status = 'retired'; w2.db.academy_course_versions.find(v => v.id === V_REVIEW).status = 'retired';
    assert.strictEqual((await call(mod(w2), { action: 'get_course', id: C_PUB }, as('admin'))).body.course.training, 'retired');
    const w3 = world(); w3.db.academy_course_versions.find(v => v.id === V_PUB).status = 'retired';
    assert.strictEqual((await call(mod(w3), { action: 'get_course', id: C_PUB }, as('admin'))).body.course.training, 'in_review');
    assert.strictEqual(w.writes.length, 0, 'C1 never changes a course record status');
  });
  await t('TEST pilot data: TEST dealers, pilot learners and TEST-course enrollments/credentials are left out of real figures', async () => {
    const TD = '10000000-0000-4000-8000-0000000000f1', LP = id(2, 9), LMIX = L1;
    const w = world(); const T = w.db;
    T.dealers.push({ id: TD, business_name: 'TEST Sandbox Dealer', parent_id: null, is_test: true });
    T.academy_learners.push({ id: LP, auth_user_id: id(3, 19), full_name: 'Pilot Person', email: 'pilot@test.example', status: 'active' });
    T.academy_memberships.push({ id: id(8, 9), learner_id: LP, dealer_id: TD, role: 'learner', access_type: 'training_only', status: 'active' },
                               { id: id(8, 10), learner_id: LMIX, dealer_id: TD, role: 'learner', access_type: 'training_only', status: 'active' });
    T.academy_enrollments.push({ id: id(3, 21), learner_id: LP, version_id: V_PUB, status: 'completed' },
                               { id: id(3, 22), learner_id: L2, version_id: V_TEST, status: 'completed' });
    T.academy_certificates.push({ id: id(3, 23), cert_number: 'HCPS-TEST-0001', learner_id: LP, enrollment_id: id(3, 21), version_id: V_PUB, attempt_id: id(3, 24), learner_name: 'Pilot Person', status: 'valid' });
    T.academy_external_certs.push({ id: id(3, 25), learner_id: LP, course_id: C_GOLD, manufacturer_slug: 'golden-technologies', status: 'verified' });
    const m = mod(w);
    const o = (await call(m, { action: 'overview' }, as('admin'))).body;
    assert.deepStrictEqual([o.learners.total, o.enrollments.total, o.hcps_certificates.total, o.manufacturer_credentials.total, o.dealerships.with_learners], [3, 2, 1, 2, 2]);
    assert.deepStrictEqual([o.test_pilot.dealerships, o.test_pilot.learners, o.test_pilot.enrollments, o.test_pilot.hcps_certificates, o.test_pilot.manufacturer_credentials], [1, 1, 2, 1, 1]);
    const d = (await call(m, { action: 'dealer_summary' }, as('admin'))).body.dealerships;
    assert.strictEqual(d[d.length - 1].dealer_id, TD); assert.strictEqual(d[d.length - 1].is_test, true);
    const br = d.find(x => x.dealer_id === BR); assert.strictEqual(br.test_course_enrollments, 1); assert.deepStrictEqual(br.enrollments, { in_progress: 1 });
    const l = (await call(m, { action: 'list_learners' }, as('admin'))).body.learners;
    assert.strictEqual(l.find(x => x.id === LP).pilot, true); assert.strictEqual(l.find(x => x.id === LMIX).pilot, false, 'a learner with a real dealership is real');
    assert.strictEqual(l[l.length - 1].id, LP, 'pilot learners are listed last');
    // unreadable TEST list = error, never "no TEST data"
    const w2 = world({ failRead: (tb, qs) => tb === 'dealers' && /is_test/.test(qs) ? 500 : 0 });
    assert.strictEqual((await call(mod(w2), { action: 'overview' }, as('admin'))).status, 503);
  });
  await t('manufacturer credentials: the internal upload id is never returned (only whether a file was uploaded)', async () => {
    const w = world(); const x = (await call(mod(w), { action: 'list_external_certs' }, as('admin'))).body.credentials;
    assert.ok(!JSON.stringify(x).includes('upload_media_id') && !JSON.stringify(x).includes(id(3, 10)));
    assert.strictEqual(x.find(c => c.id === X1).has_upload, true); assert.strictEqual(x.find(c => c.id === X2).has_upload, false);
  });

  // ---------- 8. nothing outside the Academy is touched ----------
  await t('a full session of every C1 change by the President goes only through the audited operations (M2 content, M1 the rest)', async () => {
    const w = world(); const m = mod(w); const ops = withOps(w);
    const seq = [
      { action: 'create_course', slug: 'new-course', title: 'New', course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' },
      { action: 'update_course', id: C_CERT, title: 'Renamed' }, { action: 'create_version', course_id: C_CERT }, { action: 'update_version', id: V_DRAFT, pass_mark: 85 },
      { action: 'create_module', version_id: V_DRAFT, title: 'M' }, { action: 'update_module', id: M_DRAFT, title: 'M2' },
      { action: 'create_lesson', module_id: M_DRAFT, title: 'L' }, { action: 'update_lesson', id: LS_DRAFT, est_minutes: 9 },
      { action: 'submit_for_review', id: V_TEST }, { action: 'return_to_draft', id: V_TEST }, { action: 'publish_version', id: V_DRAFT },
      { action: 'set_training_manager', membership_id: MEM2, make: false, reason: 'r' }, { action: 'withdraw_fact', id: F1, reason: 'r' },
      { action: 'review_external_cert', id: X1, decision: 'rejected', note: 'Blurry upload' },
    ];
    for (const b of seq) assert.strictEqual((await call(m, b, as('pres'))).status, 200, JSON.stringify(b));
    assert.deepStrictEqual(w.writes.filter(x => x.table), [], 'no plain table write at all');   // content: M2 operations; the rest: M1 operations
    assert.deepStrictEqual([...new Set(w.writes.map(x => x.fn))].sort(), ['academy_content_op_create_course', 'academy_content_op_create_lesson', 'academy_content_op_create_module',
      'academy_content_op_create_version', 'academy_content_op_move_version', 'academy_content_op_update_course', 'academy_content_op_update_lesson',
      'academy_content_op_update_module', 'academy_content_op_update_version']);
    noForbiddenWrites(w);
    assert.deepStrictEqual(ops.map(o => o.name), ['publish_version', 'set_training_manager', 'withdraw_fact', 'review_external_cert']);
    assert.ok(ops.every(o => o.args.p_actor === 'staff:angelo@hcps.us'));
    assert.deepStrictEqual(w.db.app_settings[0].value, { academy_admin: true });
  });

  // ---------- 9. the page and the navigation ----------
  const page = adminSrc('academy.html');
  await t('page: Connect 360 shell (staff session, admin chrome, sign-in gate) and only the admin API', async () => {
    for (const s of ['/admin/admin-shell.css', '/admin/staff-session.js', '/admin/admin-chrome.js', 'id="ac-head"', 'id="gate"', 'name="viewport"', '/.netlify/functions/staff-auth'])
      assert.ok(page.includes(s), s);
    const fns = [...page.matchAll(/\/\.netlify\/functions\/([a-z0-9-]+)/g)].map(x => x[1]);
    assert.deepStrictEqual([...new Set(fns)].sort(), ['academy-admin-api', 'staff-auth']);
    assert.ok(!/service_role|SUPABASE_SERVICE|supabase\.co/i.test(page));
  });
  await t('page: never sends an actor, approver, verifier or publisher; shows the switched-off state; escapes what it shows', async () => {
    assert.ok(!/p_actor|approved_by\s*:|verified_by\s*:|published_by\s*:|["']actor["']\s*:/.test(page));
    assert.ok(/enabled/.test(page) && /switched off/i.test(page));
    assert.ok(/const esc=/.test(page));
    // A value from the server is never interpolated raw into HTML: \${x.title} (or x.title||"…") must go through esc()/day()/etc.
    // (The browser test, academy-c1.browser.js, also renders every screen with hostile values and checks nothing runs.)
    const TEXT = 'title|name|full_name|email|note|reason|source_label|actor|dealer|parent|course|learner|learner_name|dealer_name|slug|field|model_code|category|value|evidence_ref|evidence_type|cert_number|external_url|source_url|message|issued_by|unit|role|status|action|entity|entity_id|version|position|pass_mark|exam_questions|learner_email|verified_by|published_by|revoked_reason|access_type|id';
    const raw = [...page.matchAll(/\$\{([^{}`]*)\}/g)].map(x => x[1].trim()).filter(e => new RegExp('^\\w+\\.(' + TEXT + ')(\\s*\\|\\|[^?]*)?$').test(e));
    assert.deepStrictEqual(raw, [], 'raw interpolations: ' + raw.join(' ; '));
    assert.ok(/const esc=s=>String\(s==null\?"":s\)\.replace\(\/\[&<>"'\]\/g/.test(page), 'esc covers & < > " \'');
    assert.ok(/const safeUrl=u=>\/\^https:/.test(page), 'links are https only');
    assert.ok(/@media\s*\(max-width/.test(page), 'mobile layout');
  });
  await t('page: HCPS-issued vs manufacturer-issued wording is explicit, and publishing is offered to the President only', async () => {
    assert.ok(/HCPS-issued/.test(page) && /Manufacturer-issued/.test(page));
    assert.ok(/may\.publish|may_publish/.test(page));
  });
  await t('navigation: one Sales & Marketing entry, ranked, with a hub guide entry', async () => {
    const chrome = adminSrc('admin-chrome.js'); const guide = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'hub-guide.js'), 'utf8');
    const sales = chrome.slice(chrome.indexOf('id:"sales"'), chrome.indexOf(']}', chrome.indexOf('id:"sales"')));
    assert.strictEqual((sales.match(/\/admin\/academy\.html/g) || []).length, 1);
    assert.strictEqual((chrome.match(/\/admin\/academy\.html/g) || []).length, 1, 'listed once in the whole navigation');
    assert.ok(/"Academy Command Center"/.test(chrome.slice(chrome.indexOf('var ORDER'), chrome.indexOf('analytics:', chrome.indexOf('var ORDER')))));
    assert.ok(/"Academy Command Center":\s*\{/.test(guide));
  });

  done('academy-c1');
})();
