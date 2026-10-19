/* Dealer 360 › HCPS Academy (crm-api action academy, switch academy_dealer360): who at this dealer (and its direct
   branches the viewer may open) is in the Academy — progress, exam passed / not passed + attempt count, HCPS certificates
   and expiry. Never a score, an answer, an email or a revocation reason; only to people who may open that Dealer 360.
     node test/academy-d360.test.js */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const DAY = 86400000, iso = ms => new Date(Date.now() + ms).toISOString();
const seed = (o) => standardSeed(Object.assign({
  dealer_tasks: [],
  app_settings: [{ key: 'phase2_flags', value: Object.assign({ academy_dealer360: true }, (o && o.flags) || {}) }],
  academy_learners: [{ id: 'L1', full_name: 'Terry Manager', email: 'tm@glasgow.test', status: 'active' }, { id: 'L2', full_name: 'Pat Learner', email: 'pat@glasgow.test', status: 'active' },
    { id: 'L3', full_name: 'Branch Person', email: 'b@glasgow.test', status: 'active' }, { id: 'L4', full_name: 'Gone Employee', email: 'gone@glasgow.test', status: 'active' },
    { id: 'L9', full_name: 'Other Dealer Person', email: 'x@other.test', status: 'active' }],
  academy_memberships: [
    { id: 'M1', learner_id: 'L1', dealer_id: 'd-greg', role: 'training_manager', access_type: 'training_only', status: 'active', started_at: '2026-10-01' },
    { id: 'M2', learner_id: 'L2', dealer_id: 'd-greg', role: 'learner', access_type: 'training_only', status: 'active', started_at: '2026-10-02' },
    { id: 'M3', learner_id: 'L3', dealer_id: 'd-greg-branch', role: 'learner', access_type: 'training_only', status: 'active', started_at: '2026-10-02' },
    { id: 'M4', learner_id: 'L4', dealer_id: 'd-greg', role: 'learner', access_type: 'training_only', status: 'ended', started_at: '2026-01-01', ended_at: '2026-09-01' },
    { id: 'M9', learner_id: 'L9', dealer_id: 'd-ang', role: 'learner', access_type: 'training_only', status: 'active', started_at: '2026-10-02' }],
  academy_invites: [{ id: 'I1', dealer_id: 'd-greg', email: 'new@glasgow.test', status: 'pending', expires_at: iso(5 * DAY) }, { id: 'I2', dealer_id: 'd-greg', email: 'old@glasgow.test', status: 'pending', expires_at: iso(-DAY) },
    { id: 'I3', dealer_id: 'd-greg', email: 'tm@glasgow.test', status: 'accepted', expires_at: iso(5 * DAY) }],
  academy_courses: [{ id: 'C1', title: 'Golden Lift Chair Sales Certification', slug: 'golden-lift-chair-sales-certification' }, { id: 'CT', title: 'Test course', slug: 'test-course' }],
  academy_course_versions: [{ id: 'V1', course_id: 'C1', version: 1 }, { id: 'VT', course_id: 'CT', version: 1 }],
  academy_modules: [{ id: 'MO1', version_id: 'V1' }, { id: 'MO2', version_id: 'V1' }],
  academy_lessons: [{ id: 'LE1', module_id: 'MO1' }, { id: 'LE2', module_id: 'MO1' }, { id: 'LE3', module_id: 'MO2' }],
  academy_enrollments: [
    { id: 'E1', learner_id: 'L1', version_id: 'V1', membership_id: 'M1', status: 'completed' },
    { id: 'E2', learner_id: 'L2', version_id: 'V1', membership_id: 'M2', status: 'in_progress' },
    { id: 'E3', learner_id: 'L3', version_id: 'V1', membership_id: 'M3', status: 'in_progress' },
    { id: 'E4', learner_id: 'L4', version_id: 'V1', membership_id: 'M4', status: 'completed' },
    { id: 'ET', learner_id: 'L2', version_id: 'VT', membership_id: 'M2', status: 'completed' },
    { id: 'E9', learner_id: 'L9', version_id: 'V1', membership_id: 'M9', status: 'completed' }],
  academy_progress: [{ enrollment_id: 'E1', lesson_id: 'LE1', status: 'completed' }, { enrollment_id: 'E1', lesson_id: 'LE2', status: 'completed' }, { enrollment_id: 'E1', lesson_id: 'LE3', status: 'completed' },
    { enrollment_id: 'E2', lesson_id: 'LE1', status: 'completed' }, { enrollment_id: 'E2', lesson_id: 'LE2', status: 'viewed' }],
  academy_attempts: [{ enrollment_id: 'E1', passed: false, score: 52, submitted_at: '2026-10-05T10:00:00Z' }, { enrollment_id: 'E1', passed: true, score: 92, submitted_at: '2026-10-05T12:00:00Z' },
    { enrollment_id: 'E2', passed: false, score: 40, submitted_at: '2026-10-06T10:00:00Z' }, { enrollment_id: 'E2', passed: null, score: null, submitted_at: null },
    { enrollment_id: 'E4', passed: true, score: 88, submitted_at: '2026-02-01T10:00:00Z' }, { enrollment_id: 'ET', passed: true, score: 100, submitted_at: '2026-10-01T10:00:00Z' }],
  academy_certificates: [{ id: 'X1', enrollment_id: 'E1', cert_number: 'HCPS-AAAA-BBBB', issued_at: '2026-10-05', expires_at: iso(30 * DAY), status: 'valid', revoked_reason: 'SECRET-REASON' },
    { id: 'X4', enrollment_id: 'E4', cert_number: 'HCPS-CCCC-DDDD', issued_at: '2025-02-01', expires_at: iso(-3 * DAY), status: 'valid' }],
}, (o && o.extra) || {}));
const get = (tok, extra) => async (o) => { const w = createWorld(seed(o)); const m = load('crm-api.js', w); return call(m, Object.assign({ action: 'academy', dealer_id: 'd-greg' }, extra || {}), { token: tok }); };
(async () => {
  await t('switch off → {enabled:false}, nothing else (the card stays hidden)', async () => {
    const r = await get('pres')({ flags: { academy_dealer360: false } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { ok: true, enabled: false });
  });
  await t('President: this dealer + its branch; progress, exam passed / attempts, certificates with expiry; TEST course kept out of the figures', async () => {
    const r = await get('pres')(); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const b = r.body; assert.strictEqual(b.enabled, true);
    assert.deepStrictEqual(b.dealers.map(d => [d.id, d.branch]), [['d-greg', false], ['d-greg-branch', true]]);
    const tm = b.people.find(p => p.name === 'Terry Manager');
    assert.strictEqual(tm.role, 'training_manager'); assert.strictEqual(b.people[0].name, 'Terry Manager', 'Training Managers first');
    assert.deepStrictEqual([tm.courses[0].lessons_completed, tm.courses[0].lessons_total], [3, 3]);
    assert.deepStrictEqual(tm.courses[0].exam, { attempts: 2, passed: true, last_at: '2026-10-05T12:00:00Z' });
    assert.strictEqual(tm.courses[0].certificate.cert_number, 'HCPS-AAAA-BBBB'); assert.strictEqual(tm.courses[0].certificate.expiring_soon, true);
    const pat = b.people.find(p => p.name === 'Pat Learner');
    assert.deepStrictEqual(pat.courses.find(c => !c.test_course).exam, { attempts: 1, passed: false, last_at: '2026-10-06T10:00:00Z' }, 'an unsubmitted attempt is not counted');
    assert.strictEqual(pat.courses.find(c => !c.test_course).lessons_completed, 1, 'viewed is not completed');
    const gone = b.people.find(p => p.name === 'Gone Employee');
    assert.strictEqual(gone.access, 'ended'); assert.strictEqual(gone.courses[0].certificate.status, 'expired');
    assert.strictEqual(b.people[b.people.length - 1].name, 'Gone Employee', 'ended access listed last');
    assert.ok(b.people.some(p => p.name === 'Branch Person' && p.dealer === 'Glasgow North'));
    assert.deepStrictEqual(b.summary, { people: 4, training_managers: 1, active: 3, enrolled: 4, passed: 2, certified: 1, expiring_soon: 1, expired: 1, revoked: 0, pending_invites: 1 });
  });
  await t('never a score, an answer, an email or a revocation reason in the answer', async () => {
    const s = JSON.stringify((await get('pres')()).body);
    assert.ok(!/score|answer|@|SECRET-REASON|revoked_reason|"92"|"52"/.test(s), s.slice(0, 400));
  });
  await t('another dealer\'s learners never appear', async () => {
    const s = JSON.stringify((await get('pres')()).body); assert.ok(!/Other Dealer Person/.test(s));
  });
  await t('the rep who owns the dealer sees it (status only); a rep outside the book is refused', async () => {
    const r = await get('greg')(); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.summary.people >= 3, true);
    assert.strictEqual((await get('greg', { dealer_id: 'd-ang' })()).status, 403);
  });
  await t('Customer Relations may read it (status only)', async () => {
    const r = await get('lori')(); assert.strictEqual(r.status, 200); assert.ok(!/score/.test(JSON.stringify(r.body)));
  });
  await t('no sign-in → refused; a malformed dealer id → 400', async () => {
    const r = await get(null)(); assert.ok(r.status === 401 || r.status === 403, String(r.status));
    assert.strictEqual((await get('pres', { dealer_id: 'x;drop' })()).status, 400);
  });
  await t('nobody in training → an empty list with the pending-invitation count', async () => {
    const r = await get('pres')({ extra: { academy_memberships: [] } });
    assert.deepStrictEqual(r.body.people, []); assert.strictEqual(r.body.summary.pending_invites, 1);
  });
  done('academy-d360');
})();
