/* HCPS Academy — Connect 360 admin API: the Academy Command Center (A2A shell + A2C Part C1).
   Staff only: the Connect 360 sign-in (bearer token -> an ACTIVE staff_users row). A learner's Academy session is never
   accepted here.
     POST {action:"whoami"}  -> who you are to the Academy, the switch states, and what you may do (any active staff).
     Every other action      -> refused (403 flag_off) while the academy_admin switch is off; then HCPS administrators
                                only (president / admin / owner); publishing and retiring a version: the President only.
   Security (CLAUDE.md rules 16, 17, 19, 20):
     - WHO acted always comes from the verified sign-in. Any actor / p_actor / verified_by / approved_by / published_by
       field in a request is ignored: the server names the actor itself (A.actorLabel).
     - Security-sensitive changes (publish / retire a version, Training Manager role, Golden credential review, product
       facts) go ONLY through the audited database operations academy_op_* (one transaction with their audit row).
     - Ordinary content writes (draft courses, draft versions, modules, lessons) are checked here first (draft only,
       never a published or retired record) and the database refuses the same edits again (A1 triggers + M1 guard).
       Each is followed by an audit row; a failed audit write is reported (audited:false), never hidden.
     - Reads are strict (unreadable = 503, never "empty"). Exam questions, answer keys and learners' answers are never
       returned here; audit history is scrubbed of answers before it leaves the server. The one place an answer key is
       READ is preview_check (A2D Stage 2): it grades a single PRACTICE answer on the server and returns only right/wrong
       and the explanation; exam questions are refused there. The Student view (student_exam_draw / student_exam_grade)
       shows an administrator a SAMPLE exam drawn like the real one — prompts and choices only — graded here, recorded nowhere.
     - Changes are POST only. Nothing here issues an HCPS certificate (only a passed exam does, through M7), changes a switch,
       or touches ordering. Revoking one (revoke_certificate) is the President's alone, checked here and in the database.
     - A2D Stage 3 (Course Builder, _academy_builder.js) adds its actions to the same maps, behind the same gate. Its
       question-bank editor is the one staff screen that READS answer keys (the staff editor, per the A2D plan); lesson
       previews and audit rows never carry them. Every builder write is an audited M2/M3 database operation. */
const A = require('./_academy.js');
const enc = encodeURIComponent;
const { randomUUID } = require('crypto');

const ENTITIES = ['academy_courses', 'academy_course_versions', 'academy_modules', 'academy_lessons', 'academy_memberships',
                  'academy_external_certs', 'academy_certificates', 'academy_attempts', 'academy_enrollments', 'product_facts',
                  'academy_learners', 'academy_invites'];
const SLUG = /^[a-z0-9-]+$/;
const MODEL = /^[A-Z0-9][A-Z0-9._\/-]{0,39}$/;
const FIELD = /^[a-z0-9_.]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1000, MAX_PAGES = 20;

/* ---------- small helpers ---------- */
const isPresident = s => !!s && s.kind === 'staff' && s.role === 'president';
const requirePresident = s => { if (!isPresident(s)) A.refuse(403, 'president_only', 'Only the President may do this.'); };
const isTest = c => !!c && String(c.slug || '').startsWith('test-');
const opt = (v, max, name) => (v == null || String(v).trim() === '') ? null : A.text(v, max, name);
function int(v, lo, hi, name, dflt) {
  if (v == null || v === '') { if (dflt !== undefined) return dflt; A.refuse(400, 'invalid', `${name} is required.`); }
  const n = typeof v === 'number' ? v : (/^-?\d+$/.test(String(v).trim()) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < lo || n > hi) A.refuse(400, 'invalid', `${name} must be a whole number from ${lo} to ${hi}.`);
  return n;
}
function httpsUrl(v, name) {
  const s = A.text(v, 1000, name); let u;
  try { u = new URL(s); } catch (e) { A.refuse(400, 'invalid', `${name} is not a valid web address.`); }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) A.refuse(400, 'invalid', `${name} must be an https:// address.`);
  return u.toString();
}
function strList(v, maxItems, maxLen, name) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > maxItems) A.refuse(400, 'invalid', `${name} is not valid.`);
  return v.map(x => { if (typeof x !== 'string') A.refuse(400, 'invalid', `${name} is not valid.`); return A.text(x, maxLen, name); });
}
const one = rows => rows[0] || null;
const need = (row, what) => { if (!row) A.refuse(404, 'not_found', `${what || 'Record'} not found.`); return row; };
const tally = (rows, key) => rows.reduce((o, r) => { const k = String(r[key]); o[k] = (o[k] || 0) + 1; return o; }, {});
const idsIn = ids => `in.(${[...new Set(ids.map(String))].map(enc).join(',')})`;

/* Every row of a read, page by page; strict, and refused rather than silently cut short. */
async function all(path, order) {
  const out = []; const sep = path.includes('?') ? '&' : '?';
  for (let p = 0; p < MAX_PAGES; p++) {
    const rows = await A.sbGet(`${path}${sep}order=${order || 'id.asc'}&limit=${PAGE}&offset=${p * PAGE}`);
    out.push(...rows); if (rows.length < PAGE) return out;
  }
  A.refuse(503, 'too_large', 'There is more data than this screen can show at once.');
}
async function byIds(table, ids, select) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 150) out.push(...await A.sbGet(`${table}?id=${idsIn(list.slice(i, i + 150))}&select=${select}`));
  return out;
}

/* Learners' answers and answer keys never leave the server, even inside audit history (exam operations record the
   attempt rows they change). */
const HIDDEN = /^(answers|answer_key|choices|question_ids|token_hash|code_hash)$/i;
function scrub(v, depth) {
  if (depth > 8 || v == null) return v;
  if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1));
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = HIDDEN.test(k) ? '[hidden]' : scrub(x, depth + 1); return A.redact(o, 0); }
  return v;
}
const eventOut = e => ({ id: e.id, at: e.at, actor_type: e.actor_type, actor: e.actor, entity: e.entity, entity_id: e.entity_id,
                         action: e.action, before: scrub(e.before, 0), after: scrub(e.after, 0) });

const CREDENTIAL = {
  hcps: { issuer: 'hcps', label: 'HCPS-issued certification', note: 'Issued and verified by HCPS. Independently developed and administered by HCPS; not issued, sponsored or endorsed by Golden Technologies or any manufacturer.' },
  manufacturer: { issuer: 'manufacturer', label: 'Manufacturer-issued credential', note: 'Issued by the manufacturer. HCPS tracks it and checks the evidence; HCPS does not issue it.' },
  none: { issuer: 'none', label: 'Training only', note: 'No credential is issued.' },
};
const ISSUER_FOR = { hcps_certification: 'hcps', manufacturer_program: 'manufacturer', training: 'none' };
function courseOut(c, versions) {
  const vs = (versions || []).filter(v => String(v.course_id) === String(c.id)).sort((a, b) => a.version - b.version);
  const pub = vs.find(v => v.status === 'published');
  return {
    id: c.id, slug: c.slug, title: c.title, course_type: c.course_type, issuer: c.issuer, credential: CREDENTIAL[c.issuer] || CREDENTIAL.none,
    manufacturer_slug: c.manufacturer_slug, category: c.category, external_url: c.external_url, status: c.status, created_at: c.created_at,
    is_test: isTest(c), versions: vs.length, latest_version: vs.length ? vs[vs.length - 1].version : null,
    published_version: pub ? pub.version : null, open_drafts: vs.filter(v => v.status === 'draft' || v.status === 'in_review').length,
    locked: vs.some(v => v.status === 'published' || v.status === 'retired'),
    // The course RECORD status (academy_courses.status) is not changed by C1 and does not follow the versions (C2 decides
    // the permanent rule). What learners can take is shown from the versions, so a course with a published version never
    // looks like it has no published training.
    version_counts: { draft: vs.filter(v => v.status === 'draft').length, in_review: vs.filter(v => v.status === 'in_review').length,
                      published: vs.filter(v => v.status === 'published').length, retired: vs.filter(v => v.status === 'retired').length },
    training: c.course_type === 'manufacturer_program' ? 'manufacturer_hosted'
      : pub ? 'published' : vs.some(v => v.status === 'in_review') ? 'in_review' : vs.some(v => v.status === 'draft') ? 'draft_only'
      : vs.length ? 'retired' : 'no_versions',
  };
}
const COURSE_COLS = 'id,slug,title,course_type,issuer,manufacturer_slug,category,external_url,status,created_at';
const VERSION_COLS = 'id,course_id,version,status,pass_mark,exam_questions,validity_months,retake_policy,published_at,published_by,created_at';

/* Ordinary content writes (courses, draft versions, modules, lessons) go through the A2C M2 audited content
   operations: ONE database call saves the change and its audit row in one transaction, or neither (Angelo, 11 Oct 2026).
   The checks below are kept for clear messages; the database repeats every one of them (draft-only, President for a
   course learners have seen, allowed fields, the acting person) and refuses plain writes outright. If M2 is not
   installed the answer is 503 — there is no fallback to a plain write. The actor is always the signed-in staff member. */
const actor = staff => A.actorLabel(staff);

/* The version a module / lesson belongs to, refused unless it is still an editable draft. */
async function draftVersion(versionId) {
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(versionId)}&select=${VERSION_COLS}`)), 'Course version');
  if (v.status !== 'draft') A.refuse(409, 'locked', v.status === 'in_review'
    ? 'This version is in review. Return it to draft before editing.'
    : 'This version is ' + v.status + ' and can no longer change. Create a new version instead.');
  return v;
}
async function moduleOf(id) { return need(one(await A.sbGet(`academy_modules?id=eq.${enc(id)}&select=id,version_id,position,title,objectives`)), 'Module'); }
async function lessonOf(id) { return need(one(await A.sbGet(`academy_lessons?id=eq.${enc(id)}&select=id,module_id,position,title,est_minutes`)), 'Lesson'); }
async function manufacturerExists(slug) {
  if (!SLUG.test(String(slug || ''))) A.refuse(400, 'invalid', 'Manufacturer is not valid.');
  if (!one(await A.sbGet(`manufacturers?slug=eq.${enc(slug)}&select=slug`))) A.refuse(400, 'invalid', 'That manufacturer is not in the HCPS manufacturer list.');
  return slug;
}

/* ================================== ACTIONS ================================== */
const READ = {}, WRITE = {};

/* ---------- overview ---------- */
/* TEST pilot data never counts as real dealership activity (CLAUDE.md rule 16 TEST isolation; rule 20):
   a TEST dealer is dealers.is_test = true; a TEST course has a slug starting "test-". A PILOT learner is one whose
   active memberships are all at TEST dealers. Real figures exclude pilot learners, TEST dealers, and enrollments /
   credentials on TEST courses; the excluded amounts are reported beside them, never mixed in. */
async function pilotContext(courses, versions) {
  const testDealers = new Set((await all(`dealers?is_test=eq.true&select=id`)).map(d => String(d.id)));
  const testCourses = new Set(courses.filter(isTest).map(c => String(c.id)));
  const testVersions = new Set(versions.filter(v => testCourses.has(String(v.course_id))).map(v => String(v.id)));
  return { testDealers, testCourses, testVersions };
}
function pilotLearners(members, testDealers) {
  const by = {}; for (const m of members) if (m.status === 'active') (by[String(m.learner_id)] = by[String(m.learner_id)] || []).push(m);
  return new Set(Object.entries(by).filter(([, ms]) => ms.every(m => testDealers.has(String(m.dealer_id)))).map(([k]) => k));
}
READ.overview = async () => {
  const [courses, versions, learners, members, enrolls, certs, ext, facts, events, sw] = await Promise.all([
    all(`academy_courses?select=id,slug,status,course_type,issuer,manufacturer_slug`),
    all(`academy_course_versions?select=id,course_id,status`),
    all(`academy_learners?select=id,status`),
    all(`academy_memberships?status=eq.active&select=id,learner_id,dealer_id,role,status`),
    all(`academy_enrollments?select=id,learner_id,version_id,status`),
    all(`academy_certificates?select=id,learner_id,version_id,status`),
    all(`academy_external_certs?select=id,learner_id,course_id,status`),
    all(`product_facts?valid_to=is.null&select=id,status,field_class`),
    A.sbGet(`academy_events?select=id,at,actor_type,actor,entity,entity_id,action,before,after&order=id.desc&limit=12`),
    A.switches(),
  ]);
  const P = await pilotContext(courses, versions); const pilot = pilotLearners(members, P.testDealers);
  const realL = l => !pilot.has(String(l));
  const split = (rows, isReal) => { const r = rows.filter(isReal); return [r, rows.length - r.length]; };
  const [rLearners, xLearners] = split(learners, l => realL(l.id));
  const [rMembers, xMembers] = split(members, m => !P.testDealers.has(String(m.dealer_id)));
  const [rEnrolls, xEnrolls] = split(enrolls, e => realL(e.learner_id) && !P.testVersions.has(String(e.version_id)));
  const [rCerts, xCerts] = split(certs, c => realL(c.learner_id) && !P.testVersions.has(String(c.version_id)));
  const [rExt, xExt] = split(ext, c => realL(c.learner_id) && !P.testCourses.has(String(c.course_id)));
  return {
    ok: true, switches: sw,
    courses: { total: courses.length, by_status: tally(courses, 'status'), by_type: tally(courses, 'course_type'),
               test: courses.filter(isTest).length, manufacturers: [...new Set(courses.map(c => c.manufacturer_slug).filter(Boolean))].length },
    versions: { total: versions.length, by_status: tally(versions, 'status') },
    learners: { total: rLearners.length, by_status: tally(rLearners, 'status') },
    dealerships: { with_learners: new Set(rMembers.map(m => String(m.dealer_id))).size, training_managers: rMembers.filter(m => m.role === 'training_manager').length },
    enrollments: { total: rEnrolls.length, by_status: tally(rEnrolls, 'status') },
    hcps_certificates: { total: rCerts.length, by_status: tally(rCerts, 'status') },
    manufacturer_credentials: { total: rExt.length, by_status: tally(rExt, 'status') },
    test_pilot: { excluded: true, dealerships: new Set(members.filter(m => P.testDealers.has(String(m.dealer_id))).map(m => String(m.dealer_id))).size,
                  memberships: xMembers, learners: xLearners, enrollments: xEnrolls, hcps_certificates: xCerts, manufacturer_credentials: xExt },
    product_facts: { current: facts.length, by_status: tally(facts, 'status'), approval_required: facts.filter(f => f.field_class === 'approval_required').length },
    recent: events.map(eventOut),
  };
};

/* ---------- manufacturers (read only: the HCPS manufacturer list belongs to ordering and is never changed here) ---------- */
READ.list_manufacturers = async () => {
  const [mfrs, courses] = await Promise.all([all(`manufacturers?select=slug,name`, 'slug.asc'), all(`academy_courses?select=id,manufacturer_slug,status,course_type`)]);
  return { ok: true, manufacturers: mfrs.map(m => {
    const cs = courses.filter(c => c.manufacturer_slug === m.slug);
    return { slug: m.slug, name: m.name || m.slug, courses: cs.length, by_type: tally(cs, 'course_type'), in_academy: cs.length > 0 };
  }).sort((a, b) => (b.courses - a.courses) || String(a.name).localeCompare(String(b.name))) };
};

/* ---------- courses ---------- */
READ.list_courses = async (staff, b) => {
  let q = `academy_courses?select=${COURSE_COLS}`;
  if (b.manufacturer_slug) { if (!SLUG.test(String(b.manufacturer_slug))) A.refuse(400, 'invalid', 'Manufacturer is not valid.'); q += `&manufacturer_slug=eq.${enc(b.manufacturer_slug)}`; }
  if (b.status) q += `&status=eq.${A.oneOf(b.status, ['draft', 'published', 'retired'], 'status')}`;
  const courses = await all(q, 'title.asc');
  const versions = courses.length ? await all(`academy_course_versions?course_id=${idsIn(courses.map(c => c.id))}&select=id,course_id,version,status`) : [];
  return { ok: true, courses: courses.map(c => courseOut(c, versions)) };
};
READ.get_course = async (staff, b) => {
  const id = A.uuid(b.id, 'course');
  const c = need(one(await A.sbGet(`academy_courses?id=eq.${enc(id)}&select=${COURSE_COLS}`)), 'Course');
  const versions = await all(`academy_course_versions?course_id=eq.${enc(id)}&select=${VERSION_COLS}`, 'version.asc');
  return { ok: true, course: courseOut(c, versions), versions };
};
WRITE.create_course = async (staff, b) => {
  const slug = A.text(b.slug, 80, 'Short name (slug)').toLowerCase();
  if (!SLUG.test(slug) || slug.length < 3 || /^-|-$|--/.test(slug)) A.refuse(400, 'invalid', 'Short name may use lowercase letters, numbers and single hyphens (3–80).');
  const course_type = A.oneOf(b.course_type, Object.keys(ISSUER_FOR), 'Course type');
  const row = { id: randomUUID(), slug, title: A.text(b.title, 200, 'Title'), course_type, issuer: ISSUER_FOR[course_type],   // issuer follows the type, never the request
                category: opt(b.category, 80, 'Category'), manufacturer_slug: null, external_url: null, status: 'draft' };
  if (b.manufacturer_slug) row.manufacturer_slug = await manufacturerExists(b.manufacturer_slug);
  if (course_type === 'manufacturer_program') {
    if (!row.manufacturer_slug) A.refuse(400, 'invalid', 'A manufacturer program needs its manufacturer.');
    row.external_url = httpsUrl(b.external_url, 'Manufacturer training link');
  } else if (b.external_url) A.refuse(400, 'invalid', 'Only a manufacturer program links to outside training.');
  const course = { slug: row.slug, title: row.title, course_type: row.course_type };
  for (const k of ['manufacturer_slug', 'category', 'external_url']) if (row[k] != null) course[k] = row[k];
  const made = await A.contentOp('create_course', { p_actor: actor(staff), p_id: row.id, p_course: course });
  return { ok: true, audited: true, course: courseOut(made, []) };
};
WRITE.update_course = async (staff, b) => {
  const id = A.uuid(b.id, 'course');
  const c = need(one(await A.sbGet(`academy_courses?id=eq.${enc(id)}&select=${COURSE_COLS}`)), 'Course');
  const locked = (await A.sbGet(`academy_course_versions?course_id=eq.${enc(id)}&status=in.(published,retired)&select=id&limit=1`)).length > 0;
  if (c.status !== 'draft' || locked) requirePresident(staff);   // a course learners have seen changes only with the President
  const patch = {};
  if ('title' in b) patch.title = A.text(b.title, 200, 'Title');
  if ('category' in b) patch.category = opt(b.category, 80, 'Category');
  if ('external_url' in b) {
    if (c.course_type !== 'manufacturer_program') A.refuse(400, 'invalid', 'Only a manufacturer program links to outside training.');
    patch.external_url = httpsUrl(b.external_url, 'Manufacturer training link');
  }
  if (!Object.keys(patch).length) A.refuse(400, 'invalid', 'Nothing to change.');
  const after = await A.contentOp('update_course', { p_actor: actor(staff), p_id: id, p_changes: patch });
  return { ok: true, audited: true, course: courseOut(after, []) };
};

/* ---------- versions ---------- */
READ.get_version = async (staff, b) => {
  const id = A.uuid(b.id, 'version');
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=${VERSION_COLS}`)), 'Course version');
  const [course, modules, qs] = await Promise.all([
    A.sbGet(`academy_courses?id=eq.${enc(v.course_id)}&select=${COURSE_COLS}`),
    all(`academy_modules?version_id=eq.${enc(id)}&select=id,position,title,objectives`, 'position.asc'),
    all(`academy_questions?version_id=eq.${enc(id)}&select=id,use,status`),   // counts only: never prompts, choices or keys
  ]);
  const lessons = modules.length ? await all(`academy_lessons?module_id=${idsIn(modules.map(m => m.id))}&select=id,module_id,position,title,est_minutes,blocks`, 'position.asc') : [];
  return { ok: true, version: v, course: course[0] ? courseOut(course[0], [v]) : null,
    modules: modules.map(m => ({ id: m.id, position: m.position, title: m.title, objectives: m.objectives || [],
      lessons: lessons.filter(l => String(l.module_id) === String(m.id)).map(l => ({ id: l.id, position: l.position, title: l.title, est_minutes: l.est_minutes, blocks: Array.isArray(l.blocks) ? l.blocks.length : 0 })) })),
    questions: { exam_active: qs.filter(q => q.use === 'exam' && q.status === 'active').length, practice: qs.filter(q => q.use === 'practice').length, needed: v.exam_questions },
    editable: v.status === 'draft', may_publish: isPresident(staff) && (v.status === 'draft' || v.status === 'in_review') };
};
WRITE.create_version = async (staff, b) => {
  const course_id = A.uuid(b.course_id, 'course');
  const c = need(one(await A.sbGet(`academy_courses?id=eq.${enc(course_id)}&select=${COURSE_COLS}`)), 'Course');
  if (c.course_type === 'manufacturer_program') A.refuse(400, 'invalid', 'A manufacturer program is taught and examined by the manufacturer; it has no HCPS versions.');
  if (c.status === 'retired') A.refuse(409, 'locked', 'This course is retired.');
  const settings = { pass_mark: int(b.pass_mark, 1, 100, 'Pass mark', 80), exam_questions: int(b.exam_questions, 1, 200, 'Exam questions', 25) };
  if (!(b.validity_months == null || b.validity_months === '')) settings.validity_months = int(b.validity_months, 1, 120, 'Valid for (months)');
  // the version number is given by the database, under a lock on the course (two at once get 1 and 2, never a clash)
  const made = await A.contentOp('create_version', { p_actor: actor(staff), p_id: randomUUID(), p_course_id: course_id, p_settings: settings });
  return { ok: true, audited: true, version: made };
};
WRITE.update_version = async (staff, b) => {
  const id = A.uuid(b.id, 'version'); await draftVersion(id);
  const patch = {};
  if ('pass_mark' in b) patch.pass_mark = int(b.pass_mark, 1, 100, 'Pass mark');
  if ('exam_questions' in b) patch.exam_questions = int(b.exam_questions, 1, 200, 'Exam questions');
  if ('validity_months' in b) patch.validity_months = (b.validity_months == null || b.validity_months === '') ? null : int(b.validity_months, 1, 120, 'Valid for (months)');
  if (!Object.keys(patch).length) A.refuse(400, 'invalid', 'Nothing to change.');
  const v = await A.contentOp('update_version', { p_actor: actor(staff), p_id: id, p_changes: patch });   // the database re-checks "still a draft" under a lock
  return { ok: true, audited: true, version: v };
};
async function moveVersion(staff, b, from, to) {
  const id = A.uuid(b.id, 'version');
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=${VERSION_COLS}`)), 'Course version');
  if (v.status !== from) A.refuse(409, 'locked', `This version is ${v.status}.`);
  // audited as submit_for_review / return_to_draft; draft <-> in_review only, re-checked under a lock
  return { ok: true, audited: true, version: await A.contentOp('move_version', { p_actor: actor(staff), p_id: id, p_to: to }) };
}
WRITE.submit_for_review = (staff, b) => moveVersion(staff, b, 'draft', 'in_review');
WRITE.return_to_draft = (staff, b) => moveVersion(staff, b, 'in_review', 'draft');
/* Publishing and retiring: the President only, and only through the audited database operations. */
WRITE.publish_version = async (staff, b) => {
  requirePresident(staff);
  // C2 / M4: the version must be in review; a published version of the same course is retired in the same transaction
  const r = await A.publishOp('publish_version', { p_actor: A.actorLabel(staff), p_version_id: A.uuid(b.id, 'version'),
    p_reason: b.reason ? A.text(b.reason, 500, 'Reason') : null });
  return { ok: true, audited: true, version: r && r.version, retired: r && r.retired, course: r && r.course };
};
WRITE.retire_version = async (staff, b) => {
  requirePresident(staff);
  const r = await A.publishOp('retire_version', { p_actor: A.actorLabel(staff), p_version_id: A.uuid(b.id, 'version'), p_reason: A.text(b.reason, 500, 'Reason') });
  return { ok: true, audited: true, version: r && r.version, course: r && r.course };
};
WRITE.retire_course = async (staff, b) => {
  requirePresident(staff);
  const r = await A.publishOp('retire_course', { p_actor: A.actorLabel(staff), p_course_id: A.uuid(b.id, 'course'), p_reason: A.text(b.reason, 500, 'Reason') });
  return { ok: true, audited: true, course: r && r.course, retired_version: r && r.retired_version };
};
WRITE.publish_course = async (staff, b) => {
  requirePresident(staff);
  const r = await A.publishOp('publish_course', { p_actor: A.actorLabel(staff), p_course_id: A.uuid(b.id, 'course') });
  return { ok: true, audited: true, course: r && r.course };
};
/* What publishing this version would do, before anyone presses Publish (read only): its readiness, the version it would
   replace, and whether the database will accept it (in review, nothing blocking). */
READ.publish_preview = async (staff, b) => {
  const id = A.uuid(b.id, 'version');
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=${VERSION_COLS}`)), 'Course version');
  const current = one(await A.sbGet(`academy_course_versions?course_id=eq.${enc(v.course_id)}&status=eq.published&select=id,version,published_at`));
  const rd = await BUILDER.READ.readiness(staff, { version_id: id });
  const r = rd && rd.readiness || {};
  const blocking = (r.items || []).filter(x => x.level === 'blocking');
  return { ok: true, version: v, replaces: current, counts: r.counts, bank: r.bank, blocking: blocking.slice(0, 50),
    can_publish: v.status === 'in_review' && blocking.length === 0,
    reason: v.status !== 'in_review' ? 'Submit the version for review first.' : blocking.length ? `${blocking.length} blocking item(s) must be resolved first.` : null };
};

/* ---------- Edit a published course = a new draft version copied from it (President; 21 Oct 2026) ----------
   A published version never changes (A1/M1/M4). To edit it, the President copies it into a NEW DRAFT version — modules,
   lessons and their screens, the question bank (active questions), question fact links and the exam distribution — edits
   the draft in the Course Builder and publishes it; publishing retires the old version in the same transaction (M4).
   Learners already on the old version keep their enrollment, progress, attempts and certificates.
   Every write goes through the existing audited operations (M2 content, M3 author, M3.1 save). The copy runs in short
   steps so no request outlasts the function time limit: copy_version_start makes the empty draft, copy_version_continue
   fills in whatever is still missing (matched by position / question text) and answers done:false until finished — so an
   interrupted copy is simply continued, never duplicated. */
const COPY_BUDGET_MS = () => Number(process.env.ACADEMY_COPY_BUDGET_MS) || 6500;   // tests shorten it to prove a copy resumes
async function copySource(id) {
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=${VERSION_COLS}`)), 'Course version');
  const c = need(one(await A.sbGet(`academy_courses?id=eq.${enc(v.course_id)}&select=${COURSE_COLS}`)), 'Course');
  if (c.course_type === 'manufacturer_program') A.refuse(400, 'invalid', 'A manufacturer program has no HCPS versions.');
  if (c.status === 'retired') A.refuse(409, 'locked', 'This course is retired.');
  return { v, c };
}
async function versionTree(vid) {
  const mods = await all(`academy_modules?version_id=eq.${enc(vid)}&select=id,position,title,objectives,exam_quota`, 'position.asc');
  const lessons = mods.length ? await all(`academy_lessons?module_id=${idsIn(mods.map(m => m.id))}&select=id,module_id,position,title,est_minutes,blocks`, 'position.asc') : [];
  const qs = await all(`academy_questions?version_id=eq.${enc(vid)}&select=id,module_id,kind,use,prompt,choices,answer_key,explanation,objective_tags,status`);
  const refs = await all(`academy_content_refs?version_id=eq.${enc(vid)}&question_id=not.is.null&select=question_id,manufacturer_slug,model_code,field`);
  return { mods, lessons, qs, refs };
}
WRITE.copy_version_start = async (staff, b) => {
  requirePresident(staff);
  const { v, c } = await copySource(A.uuid(b.from_version_id, 'version'));
  const open = await A.sbGet(`academy_course_versions?course_id=eq.${enc(c.id)}&status=in.(draft,in_review)&select=id,version,status`);
  if (open.length) return { ok: false, error: 'draft_exists', draft_id: open[0].id, draft_version: open[0].version, draft_status: open[0].status,
    message: `Version ${open[0].version} of this course is already a ${open[0].status.replace('_', ' ')}. Open it and edit it there, or finish it, before starting another.` };
  const settings = { pass_mark: v.pass_mark, exam_questions: v.exam_questions };
  if (v.validity_months) settings.validity_months = v.validity_months;
  const made = await A.contentOp('create_version', { p_actor: actor(staff), p_id: randomUUID(), p_course_id: c.id, p_settings: settings });
  return { ok: true, audited: true, version: made, from_version: v.version };
};
WRITE.copy_version_continue = async (staff, b) => {
  requirePresident(staff);
  const t0 = Date.now();
  const { v: src } = await copySource(A.uuid(b.from_version_id, 'version'));
  const dst = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(A.uuid(b.to_version_id, 'version'))}&select=${VERSION_COLS}`)), 'Course version');
  if (String(dst.course_id) !== String(src.course_id) || dst.status !== 'draft' || dst.version <= src.version) A.refuse(409, 'locked', 'The copy target must be a newer draft version of the same course.');
  const S = await versionTree(src.id);
  let T = await versionTree(dst.id);
  const done = { modules: 0, lessons: 0, questions: 0, screens: 0, fact_links: 0 };
  // every call makes progress (at least one write) before it may stop for time
  const late = () => Object.values(done).some(n => n > 0) && Date.now() - t0 > COPY_BUDGET_MS();
  const progress = finished => ({ ok: true, audited: true, done: finished, to_version_id: dst.id, made: done,
    totals: { modules: S.mods.length, lessons: S.lessons.length, questions: S.qs.filter(q => q.status === 'active').length } });
  // 1. modules, in order (the database gives the next position, so creating in order keeps positions equal)
  for (const m of S.mods) {
    if (T.mods.some(x => x.position === m.position)) continue;
    if (late()) return progress(false);
    await A.contentOp('create_module', { p_actor: actor(staff), p_id: randomUUID(), p_version_id: dst.id, p_module: { title: m.title, objectives: Array.isArray(m.objectives) ? m.objectives : [] } });
    done.modules++;
  }
  if (done.modules) T = await versionTree(dst.id);
  const modByPos = Object.fromEntries(T.mods.map(m => [m.position, m]));
  const srcModPos = Object.fromEntries(S.mods.map(m => [String(m.id), m.position]));
  // 2. lessons (empty), in order within each module; modules in parallel
  await Promise.all(S.mods.map(async m => {
    const tm = modByPos[m.position];
    for (const l of S.lessons.filter(x => String(x.module_id) === String(m.id))) {
      if (T.lessons.some(x => String(x.module_id) === String(tm.id) && x.position === l.position)) continue;
      if (late()) return;
      await A.contentOp('create_lesson', { p_actor: actor(staff), p_id: randomUUID(), p_module_id: tm.id, p_lesson: { title: l.title, est_minutes: l.est_minutes } });
      done.lessons++;
    }
  }));
  if (late()) return progress(false);
  if (done.lessons) T = await versionTree(dst.id);
  // 3. questions (active only), matched by module position + use + kind + prompt
  const qKey = (q, posOf) => [posOf(q), q.use, q.kind, q.prompt].join('\u0001');
  const srcPos = q => (q.module_id ? srcModPos[String(q.module_id)] : 0);
  const dstModPos = Object.fromEntries(T.mods.map(m => [String(m.id), m.position]));
  const dstPos = q => (q.module_id ? dstModPos[String(q.module_id)] : 0);
  const have = {}; for (const q of T.qs) (have[qKey(q, dstPos)] = have[qKey(q, dstPos)] || []).push(q);
  const missing = [];
  const seen = {};
  for (const q of S.qs.filter(x => x.status === 'active')) {
    const k = qKey(q, srcPos); seen[k] = (seen[k] || 0) + 1;
    if ((have[k] || []).length < seen[k]) missing.push(q);
  }
  for (let i = 0; i < missing.length; i += 8) {
    if (late()) return progress(false);
    await Promise.all(missing.slice(i, i + 8).map(q => A.authorOp('create_question', { p_actor: actor(staff), p_id: randomUUID(), p_version_id: dst.id,
      p_question: { module_id: q.module_id ? modByPos[srcPos(q)].id : null, kind: q.kind, use: q.use, prompt: q.prompt, choices: q.choices, answer_key: q.answer_key,
        explanation: q.explanation, objective_tags: q.objective_tags || [] } })));
    done.questions += Math.min(8, missing.length - i);
  }
  if (done.questions) T = await versionTree(dst.id);
  // source question id -> target question id (in order, so identical prompts pair up one to one)
  const pool = {}; for (const q of T.qs) (pool[qKey(q, dstPos)] = pool[qKey(q, dstPos)] || []).push(q.id);
  const qmap = {}; const used = {};
  for (const q of S.qs.filter(x => x.status === 'active')) { const k = qKey(q, srcPos); const n = used[k] = (used[k] || 0); qmap[String(q.id)] = (pool[k] || [])[n] || null; used[k]++; }
  // 4. lesson screens (question ids re-pointed to the copies; fact links follow from the screens, M3.1)
  const jobs = [];
  for (const l of S.lessons) {
    const tm = modByPos[srcModPos[String(l.module_id)]];
    const tl = T.lessons.find(x => String(x.module_id) === String(tm.id) && x.position === l.position);
    const blocks = Array.isArray(l.blocks) ? l.blocks : [];
    if (!tl || !blocks.length || (Array.isArray(tl.blocks) && tl.blocks.length)) continue;
    const remapped = JSON.parse(JSON.stringify(blocks));
    for (const bl of remapped) if (Array.isArray(bl.question_ids)) bl.question_ids = bl.question_ids.map(id => qmap[String(id)]).filter(Boolean);
    jobs.push({ id: tl.id, blocks: remapped });
  }
  for (let i = 0; i < jobs.length; i += 5) {
    if (late()) return progress(false);
    await Promise.all(jobs.slice(i, i + 5).map(j => A.saveOp('lesson', { p_actor: actor(staff), p_lesson_id: j.id, p_base_blocks: [], p_blocks: j.blocks })));
    done.screens += Math.min(5, jobs.length - i);
  }
  // 5. question fact links
  const dstRefs = new Set(T.refs.map(r => [r.question_id, r.manufacturer_slug, r.model_code, r.field || ''].join('|')));
  const links = S.refs.map(r => ({ question_id: qmap[String(r.question_id)], manufacturer_slug: r.manufacturer_slug, model_code: r.model_code, field: r.field }))
    .filter(r => r.question_id && !dstRefs.has([r.question_id, r.manufacturer_slug, r.model_code, r.field || ''].join('|')));
  for (let i = 0; i < links.length; i += 8) {
    if (late()) return progress(false);
    await Promise.all(links.slice(i, i + 8).map(r => { const link = { question_id: r.question_id, manufacturer_slug: r.manufacturer_slug, model_code: r.model_code };
      if (r.field) link.field = r.field; return A.authorOp('link_fact', { p_actor: actor(staff), p_id: null, p_link: link }); }));
    done.fact_links += Math.min(8, links.length - i);
  }
  // 6. exam distribution, if the source had one
  if (S.mods.some(m => m.exam_quota != null) && !T.mods.some(m => m.exam_quota != null)) {
    const q = {}; for (const m of S.mods) if (m.exam_quota != null) q[String(modByPos[m.position].id)] = m.exam_quota;
    await A.authorOp('set_exam_distribution', { p_actor: actor(staff), p_version_id: dst.id, p_quotas: q });
  }
  return progress(true);
};

/* ---------- modules and lessons (draft versions only) ---------- */
WRITE.create_module = async (staff, b) => {
  const version_id = A.uuid(b.version_id, 'version'); await draftVersion(version_id);
  const module = { title: A.text(b.title, 200, 'Module title'), objectives: strList(b.objectives, 12, 300, 'Objectives') };
  const made = await A.contentOp('create_module', { p_actor: actor(staff), p_id: randomUUID(), p_version_id: version_id, p_module: module });
  return { ok: true, audited: true, module: made };
};
WRITE.update_module = async (staff, b) => {
  const m = await moduleOf(A.uuid(b.id, 'module')); await draftVersion(m.version_id);
  const patch = {};
  if ('title' in b) patch.title = A.text(b.title, 200, 'Module title');
  if ('objectives' in b) patch.objectives = strList(b.objectives, 12, 300, 'Objectives');
  if (!Object.keys(patch).length) A.refuse(400, 'invalid', 'Nothing to change.');
  const after = await A.contentOp('update_module', { p_actor: actor(staff), p_id: m.id, p_changes: patch });
  return { ok: true, audited: true, module: after };
};
WRITE.delete_module = async (staff, b) => {
  const m = await moduleOf(A.uuid(b.id, 'module')); await draftVersion(m.version_id);
  if ((await A.sbGet(`academy_lessons?module_id=eq.${enc(m.id)}&select=id&limit=1`)).length) A.refuse(409, 'not_empty', 'Remove this module\'s lessons first.');
  if ((await A.sbGet(`academy_questions?module_id=eq.${enc(m.id)}&select=id&limit=1`)).length) A.refuse(409, 'not_empty', 'Questions are linked to this module.');
  await A.contentOp('delete_module', { p_actor: actor(staff), p_id: m.id });
  return { ok: true, audited: true };
};
WRITE.create_lesson = async (staff, b) => {
  const m = await moduleOf(A.uuid(b.module_id, 'module')); await draftVersion(m.version_id);
  const lesson = { title: A.text(b.title, 200, 'Lesson title'), est_minutes: int(b.est_minutes, 1, 30, 'Minutes', 10) };
  const made = await A.contentOp('create_lesson', { p_actor: actor(staff), p_id: randomUUID(), p_module_id: m.id, p_lesson: lesson });
  return { ok: true, audited: true, lesson: made };
};
WRITE.update_lesson = async (staff, b) => {
  const l = await lessonOf(A.uuid(b.id, 'lesson')); const m = await moduleOf(l.module_id); await draftVersion(m.version_id);
  const patch = {};
  if ('title' in b) patch.title = A.text(b.title, 200, 'Lesson title');
  if ('est_minutes' in b) patch.est_minutes = int(b.est_minutes, 1, 30, 'Minutes');
  if (!Object.keys(patch).length) A.refuse(400, 'invalid', 'Nothing to change.');
  const after = await A.contentOp('update_lesson', { p_actor: actor(staff), p_id: l.id, p_changes: patch });
  return { ok: true, audited: true, lesson: after };
};
WRITE.delete_lesson = async (staff, b) => {
  const l = await lessonOf(A.uuid(b.id, 'lesson')); const m = await moduleOf(l.module_id); await draftVersion(m.version_id);
  await A.contentOp('delete_lesson', { p_actor: actor(staff), p_id: l.id });
  return { ok: true, audited: true };
};

/* ---------- learners and dealerships (summaries; no exam answers, no scores in C1) ---------- */
async function people() {
  const [learners, members, enrolls, courses, versions] = await Promise.all([
    all(`academy_learners?select=id,full_name,email,status,created_at`),
    all(`academy_memberships?select=id,learner_id,dealer_id,${(await m8Installed()) ? 'organization_id,' : ''}role,access_type,status,started_at,ended_at`),
    all(`academy_enrollments?select=id,learner_id,version_id,status`),
    all(`academy_courses?select=id,slug`),
    all(`academy_course_versions?select=id,course_id`),
  ]);
  const dealers = await byIds('dealers', members.map(m => m.dealer_id), 'id,business_name,parent_id,is_test');
  const dname = Object.fromEntries(dealers.map(d => [String(d.id), d]));
  const orgs = await orgNames(members.map(m => m.organization_id));
  const P = await pilotContext(courses, versions);
  return { learners, members, enrolls, dname, orgs, P, pilot: pilotLearners(members.filter(m => m.dealer_id), P.testDealers) };
}
READ.list_learners = async () => {
  const { learners, members, enrolls, dname, orgs, P, pilot } = await people();
  return { ok: true, learners: learners.map(l => ({
    id: l.id, full_name: l.full_name, email: l.email, status: l.status, created_at: l.created_at, pilot: pilot.has(String(l.id)),
    memberships: members.filter(m => String(m.learner_id) === String(l.id)).map(m => ({
      id: m.id, dealer_id: m.dealer_id, organization_id: m.organization_id || null, outside: !!m.organization_id,
      dealer: m.organization_id ? (orgs[String(m.organization_id)] || 'Outside dealership') + ' (outside)' : (dname[String(m.dealer_id)] || {}).business_name || null, role: m.role,
      access_type: m.access_type, status: m.status, test_dealer: P.testDealers.has(String(m.dealer_id)) })),
    enrollments: tally(enrolls.filter(e => String(e.learner_id) === String(l.id) && !P.testVersions.has(String(e.version_id))), 'status'),
    test_enrollments: enrolls.filter(e => String(e.learner_id) === String(l.id) && P.testVersions.has(String(e.version_id))).length,
  })).sort((a, b) => (a.pilot - b.pilot) || String(a.full_name).localeCompare(String(b.full_name))) };
};
READ.dealer_summary = async () => {
  const { learners, members, enrolls, dname, P } = await people();
  const [certs, ext] = await Promise.all([all(`academy_certificates?select=id,learner_id,version_id,status`), all(`academy_external_certs?select=id,learner_id,course_id,status`)]);
  const active = members.filter(m => m.status === 'active' && m.dealer_id);   // outside organizations are not HCPS dealerships
  const lstatus = Object.fromEntries(learners.map(l => [String(l.id), l.status]));
  const out = {};
  for (const m of active) {
    const k = String(m.dealer_id), d = dname[k] || {};
    const o = out[k] || (out[k] = { dealer_id: m.dealer_id, dealer: d.business_name || null, parent_id: d.parent_id || null, is_test: P.testDealers.has(k),
                                    learners: 0, training_managers: 0, training_only: 0, inactive_learners: 0, enrollments: {}, test_course_enrollments: 0,
                                    hcps_certificates_valid: 0, manufacturer_credentials_verified: 0 });
    o.learners++; if (m.role === 'training_manager') o.training_managers++; if (m.access_type === 'training_only') o.training_only++;
    if (lstatus[String(m.learner_id)] !== 'active') o.inactive_learners++;
    for (const e of enrolls.filter(x => String(x.learner_id) === String(m.learner_id))) {
      if (P.testVersions.has(String(e.version_id))) { o.test_course_enrollments++; continue; }   // TEST courses never count as training
      o.enrollments[e.status] = (o.enrollments[e.status] || 0) + 1;
    }
    o.hcps_certificates_valid += certs.filter(c => String(c.learner_id) === String(m.learner_id) && c.status === 'valid' && !P.testVersions.has(String(c.version_id))).length;
    o.manufacturer_credentials_verified += ext.filter(c => String(c.learner_id) === String(m.learner_id) && c.status === 'verified' && !P.testCourses.has(String(c.course_id))).length;
  }
  for (const o of Object.values(out)) o.parent = o.parent_id ? ((dname[String(o.parent_id)] || {}).business_name || null) : null;
  return { ok: true, dealerships: Object.values(out).sort((a, b) => (a.is_test - b.is_test) || String(a.dealer).localeCompare(String(b.dealer))) };
};
WRITE.set_training_manager = async (staff, b) => {
  const make = b.make === true ? true : b.make === false ? false : A.refuse(400, 'invalid', 'Say whether to grant or remove the role.');
  const why = A.text(b.reason, 500, 'Reason'), mid = A.uuid(b.membership_id, 'membership');
  if (make && await A.pilotMode()) {   // pilot gate: a Training Manager is appointed only at a TEST dealership until academy_open
    const mm = one(await A.sbGet(`academy_memberships?id=eq.${enc(mid)}&select=dealer_id`));
    if (!mm) A.refuse(404, 'not_found', 'Not found.');
    await A.pilotDealer(mm.dealer_id);
  }
  const m = await A.op('set_training_manager', { p_actor: A.actorLabel(staff), p_membership_id: mid, p_make: make, p_reason: why });
  return { ok: true, audited: true, membership: m };
};

/* ---------- A2B / M5: HCPS manages learners' access (one audited M5 operation each; actor = the signed-in staff) ----------
   HCPS invites anyone for any dealership and is the only one who invites a Training Manager (decision F). Suspending a
   learner or ending their last membership ends their sessions at once. Invitation emails go out only once the
   Academy sender is configured (ACADEMY_MAIL_FROM, Angelo's approval). Not installed (M5 not run) = 503. */
const MAIL = require('./_academy_mail.js');
const accessText = (v, n, w) => (v == null || v === '' ? null : A.text(v, n, w));
READ.find_dealers = async (staff, b) => {
  const q = String(b.q || '').trim();
  if (q.length < 2 || q.length > 80) A.refuse(400, 'invalid', 'Type at least 2 letters of the dealership name.');
  const term = q.replace(/[%_*(),."\\]/g, ' ').trim();
  const rows = await A.sbGet(`dealers?business_name=ilike.*${enc(term)}*&select=id,business_name,city,state,parent_id,is_test&order=business_name.asc&limit=25`);
  return { ok: true, dealers: rows };
};
READ.list_invites = async () => {
  const rows = await all(`academy_invites?status=eq.pending&select=id,dealer_id,email,full_name,role,expires_at,created_at,invited_by_staff,invited_by_learner`, 'created_at.desc');
  const d = await byIds('dealers', rows.map(r => r.dealer_id), 'id,business_name,is_test');
  const dn = Object.fromEntries(d.map(x => [String(x.id), x]));
  return { ok: true, invites: rows.map(r => Object.assign({}, r, { dealer: (dn[String(r.dealer_id)] || {}).business_name || null, test_dealer: !!(dn[String(r.dealer_id)] || {}).is_test })) };
};
WRITE.invite_learner = async (staff, b) => {
  if (!(await A.switchOn('academy_invites'))) A.refuse(403, 'flag_off', 'Invitations are switched off (academy_invites).');
  const role = A.oneOf(b.role || 'learner', ['learner', 'training_manager'], 'Role');
  await A.pilotDealer(A.uuid(b.dealer_id, 'dealership'));   // pilot gate: TEST dealerships only until academy_open
  const inv = await A.accessOp('access_op_invite', { p_actor: A.actorLabel(staff), p_dealer_id: A.uuid(b.dealer_id, 'dealership'),
    p_email: String(b.email || ''), p_full_name: accessText(b.full_name, 200, 'Name'), p_role: role });
  const d = one(await A.sbGet(`dealers?id=eq.${enc(inv.dealer_id)}&select=business_name`)) || {};
  const sent = await MAIL.send(inv.email, MAIL.inviteMessage({ dealerName: d.business_name || 'your dealership', inviterName: 'HCPS' }));
  return { ok: true, audited: true, invite: inv, email_sent: sent.sent, email_note: sent.sent ? null : 'The invitation is recorded; no email was sent (the Academy sender is not configured yet).' };
};
WRITE.revoke_invite = async (staff, b) => ({ ok: true, audited: true,
  result: await A.accessOp('access_op_revoke_invite', { p_actor: A.actorLabel(staff), p_invite_id: A.uuid(b.id, 'invitation'), p_reason: A.text(b.reason, 500, 'Reason') }) });
WRITE.end_membership = async (staff, b) => ({ ok: true, audited: true,
  result: await A.accessOp('access_op_deactivate', { p_actor: A.actorLabel(staff), p_membership_id: A.uuid(b.membership_id, 'membership'), p_reason: A.text(b.reason, 500, 'Reason') }) });
WRITE.restore_membership = async (staff, b) => (await A.pilotDealer(A.uuid(b.dealer_id, 'dealership')), { ok: true, audited: true,
  result: await A.accessOp('access_op_reactivate', { p_actor: A.actorLabel(staff), p_learner_id: A.uuid(b.learner_id, 'learner'), p_dealer_id: A.uuid(b.dealer_id, 'dealership') }) });
WRITE.set_learner_status = async (staff, b) => ({ ok: true, audited: true,
  result: await A.accessOp('access_op_set_learner_status', { p_actor: A.actorLabel(staff), p_learner_id: A.uuid(b.learner_id, 'learner'),
    p_status: A.oneOf(b.status, ['active', 'suspended'], 'Status'), p_reason: A.text(b.reason, 500, 'Reason') }) });
WRITE.enroll_learner = async (staff, b) => {
  const due = b.due_on == null || b.due_on === '' ? null : String(b.due_on);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) A.refuse(400, 'invalid', 'The due date is not valid.');
  if (await A.pilotMode()) {   // pilot gate: only a learner with an active TEST-dealership membership is enrolled
    const ms = await A.sbGet(`academy_memberships?learner_id=eq.${enc(A.uuid(b.learner_id, 'learner'))}&status=eq.active&select=dealer_id`);
    if (!(await A.testDealerIds(ms.map(m => m.dealer_id))).size) A.refuse(403, 'pilot_only', 'The HCPS Academy is in its pilot. It is not open for this dealership yet.');
  }
  return { ok: true, audited: true, enrollment: await A.accessOp('enroll_op_enroll', { p_actor: A.actorLabel(staff),
    p_learner_id: A.uuid(b.learner_id, 'learner'), p_version_id: A.uuid(b.version_id, 'course version'), p_due_on: due }) };
};
WRITE.withdraw_enrollment = async (staff, b) => ({ ok: true, audited: true,
  result: await A.accessOp('enroll_op_withdraw', { p_actor: A.actorLabel(staff), p_enrollment_id: A.uuid(b.enrollment_id, 'enrollment'), p_reason: A.text(b.reason, 500, 'Reason') }) });
/* A2E reasonable accommodation: extra exam time for ONE enrollment (0 removes it). President only here, and the database
   (academy_exam_op_accommodate, M6) checks again that the actor is the ACTIVE HCPS President (role read from staff_users
   at the moment of the change), requires a reason, audits it, and applies it only to attempts started afterwards.
   Reading it needs M6 (the column does not exist before). */
READ.exam_accommodations = async (staff, b) => {
  const lid = A.uuid(b.learner_id, 'learner');
  const rows = await all(`academy_enrollments?select=id,version_id,status,exam_extra_minutes&learner_id=eq.${enc(lid)}`);
  const vers = await byIds('academy_course_versions', rows.map(r => r.version_id), 'id,course_id,version,exam_time_limit_minutes');
  const courses = await byIds('academy_courses', vers.map(v => v.course_id), 'id,title');
  const V = Object.fromEntries(vers.map(v => [String(v.id), v])), C = Object.fromEntries(courses.map(c => [String(c.id), c]));
  return { ok: true, enrollments: rows.map(r => { const v = V[String(r.version_id)] || {}; return { enrollment_id: r.id, status: r.status,
    course: (C[String(v.course_id)] || {}).title || null, version: v.version || null, time_limit_minutes: v.exam_time_limit_minutes,
    extra_minutes: r.exam_extra_minutes }; }) };
};
WRITE.exam_accommodation = async (staff, b) => {
  requirePresident(staff);
  const m = Number(b.extra_minutes);
  if (!Number.isInteger(m) || m < 0 || m > 240) A.refuse(400, 'invalid', 'Extra time is a whole number of minutes from 0 to 240.');
  return { ok: true, audited: true, result: await A.accessOp('exam_op_accommodate', { p_actor: A.actorLabel(staff),
    p_enrollment_id: A.uuid(b.enrollment_id, 'enrollment'), p_extra_minutes: m, p_reason: A.text(b.reason, 500, 'Reason') }) };
};

/* ---------- product facts and their sources ---------- */
const FACT_COLS = 'id,manufacturer_slug,model_code,field,value,unit,field_class,status,source_url,source_label,verified_on,verified_by,note,valid_from,valid_to,replaced_by,content_page_key';
READ.list_facts = async (staff, b) => {
  let q = `product_facts?select=${FACT_COLS}`;
  if (b.manufacturer_slug) { if (!SLUG.test(String(b.manufacturer_slug))) A.refuse(400, 'invalid', 'Manufacturer is not valid.'); q += `&manufacturer_slug=eq.${enc(b.manufacturer_slug)}`; }
  if (b.model_code) { const mc = String(b.model_code).trim().toUpperCase(); if (!MODEL.test(mc)) A.refuse(400, 'invalid', 'Model is not valid.'); q += `&model_code=eq.${enc(mc)}`; }
  if (b.field) { if (!FIELD.test(String(b.field))) A.refuse(400, 'invalid', 'Field is not valid.'); q += `&field=eq.${enc(b.field)}`; }
  if (b.history !== true) q += `&valid_to=is.null`;
  const rows = await all(q, 'valid_from.desc');
  return { ok: true, history: b.history === true, facts: rows.map(f => Object.assign({}, f, { current: f.valid_to == null })) };
};
WRITE.record_fact = async (staff, b) => {
  const field_class = A.oneOf(b.field_class, ['display', 'approval_required'], 'Field class');
  if (field_class === 'approval_required') requirePresident(staff);   // the approver is the signed-in President, never a name typed in
  const verified_on = String(b.verified_on || '').trim();
  if (!DATE.test(verified_on) || isNaN(Date.parse(verified_on + 'T00:00:00Z'))) A.refuse(400, 'invalid', 'Verified on must be a date (YYYY-MM-DD).');
  if (verified_on > new Date().toISOString().slice(0, 10)) A.refuse(400, 'invalid', 'Verified on cannot be in the future.');
  const model_code = String(b.model_code || '').trim().toUpperCase();
  if (!MODEL.test(model_code)) A.refuse(400, 'invalid', 'Model code is not valid.');
  const field = String(b.field || '').trim();
  if (!FIELD.test(field) || field.length > 60) A.refuse(400, 'invalid', 'Field may use lowercase letters, numbers, dots and underscores.');
  if (b.value === undefined || b.value === null || (typeof b.value === 'string' && !b.value.trim())) A.refuse(400, 'invalid', 'A value is required (use Withdraw to remove a fact).');
  if (JSON.stringify(b.value).length > 4000) A.refuse(400, 'invalid', 'The value is too long.');
  const fact = {
    manufacturer_slug: await manufacturerExists(b.manufacturer_slug), model_code, field, value: b.value,
    unit: opt(b.unit, 20, 'Unit'), field_class, status: A.oneOf(b.status, ['verified', 'awaiting_manufacturer'], 'Status'),
    source_url: httpsUrl(b.source_url, 'Source link'), source_label: A.text(b.source_label, 200, 'Source name'),
    verified_on, verified_by: A.actorLabel(staff), note: opt(b.note, 1000, 'Note'), content_page_key: opt(b.content_page_key, 120, 'Content page'),
  };
  const row = await A.op('record_fact', { p_actor: A.actorLabel(staff), p_fact: fact,
    p_supersedes: b.supersedes ? A.uuid(b.supersedes, 'fact to replace') : null,
    p_approved_by: field_class === 'approval_required' ? A.actorLabel(staff) : null });
  return { ok: true, audited: true, fact: row };
};
WRITE.withdraw_fact = async (staff, b) => {
  const row = await A.op('withdraw_fact', { p_actor: A.actorLabel(staff), p_fact_id: A.uuid(b.id, 'fact'), p_reason: A.text(b.reason, 500, 'Reason') });
  return { ok: true, audited: true, fact: row };
};

/* ---------- credentials: HCPS-issued and manufacturer-issued, always kept apart ---------- */
READ.list_certificates = async () => {
  const rows = await all(`academy_certificates?select=id,cert_number,learner_id,learner_name,dealer_name,version_id,issued_at,expires_at,status,revoked_at,revoked_by,revoked_reason`, 'issued_at.desc');
  const vs = await byIds('academy_course_versions', rows.map(r => r.version_id), 'id,course_id,version');
  const cs = await byIds('academy_courses', vs.map(v => v.course_id), 'id,title,slug');
  const vmap = Object.fromEntries(vs.map(v => [String(v.id), v])), cmap = Object.fromEntries(cs.map(c => [String(c.id), c]));
  const now = Date.now();
  return { ok: true, issuer: CREDENTIAL.hcps, certificates: rows.map(r => {
    const v = vmap[String(r.version_id)] || {}, c = cmap[String(v.course_id)] || {};
    const st = r.status === 'revoked' ? 'revoked' : (r.expires_at && new Date(r.expires_at).getTime() <= now ? 'expired' : 'valid');
    const left = r.expires_at ? Math.floor((new Date(r.expires_at).getTime() - now) / 86400000) : null;
    return Object.assign({}, r, { issuer: 'hcps', course: c.title || null, version: v.version || null, test: isTest(c),
      display_status: st, expiring_soon: st === 'valid' && left != null && left <= 60, days_left: st === 'valid' ? left : null });
  }), summary: (() => { const t = { valid: 0, expiring_soon: 0, expired: 0, revoked: 0 };
    for (const r of rows) { const v = vmap[String(r.version_id)] || {}; if (isTest(cmap[String(v.course_id)])) continue;
      const st = r.status === 'revoked' ? 'revoked' : (r.expires_at && new Date(r.expires_at).getTime() <= now ? 'expired' : 'valid');
      t[st]++; if (st === 'valid' && r.expires_at && new Date(r.expires_at).getTime() - now <= 60 * 86400000) t.expiring_soon++; }
    return t; })() };
};
/* Revoking an HCPS certificate (A2F / M7): the active President only — checked here AND in the database at the moment of
   the change (academy_cert_op_revoke); a reason of 5–500 characters; audited with before/after. The certificate stays on
   record and verifies as "revoked"; the reason is never shown publicly. */
WRITE.revoke_certificate = async (staff, b) => {
  requirePresident(staff);
  const reason = A.text(b.reason, 500, 'Reason');
  if (reason.trim().length < 5) A.refuse(400, 'invalid', 'Give a reason of at least 5 characters.');
  const r = await A.accessOp('cert_op_revoke', { p_actor: A.actorLabel(staff), p_certificate_id: A.uuid(b.id, 'certificate'), p_reason: reason });
  return { ok: true, audited: true, certificate: r.certificate };
};
READ.list_external_certs = async (staff, b) => {
  let q = `academy_external_certs?select=id,learner_id,course_id,manufacturer_slug,status,training_started_at,training_completed_at,exam_opened_at,exam_reported_at,certificate_uploaded_at,upload_media_id,evidence_type,evidence_ref,verified_by,verified_at,certificate_ref,expires_at,note,created_at`;
  if (b.status) q += `&status=eq.${A.oneOf(b.status, ['training_started', 'training_completed', 'exam_opened', 'exam_reported', 'awaiting_certificate', 'certificate_uploaded', 'verified', 'rejected'], 'status')}`;
  const rows = await all(q, 'created_at.desc');
  const [ls, cs, ms] = await Promise.all([
    byIds('academy_learners', rows.map(r => r.learner_id), 'id,full_name,email'),
    byIds('academy_courses', rows.map(r => r.course_id), 'id,title'),
    all(`manufacturers?select=slug,name`, 'slug.asc'),
  ]);
  const L = Object.fromEntries(ls.map(x => [String(x.id), x])), C = Object.fromEntries(cs.map(x => [String(x.id), x])), M = Object.fromEntries(ms.map(x => [x.slug, x.name]));
  return { ok: true, issuer: CREDENTIAL.manufacturer, credentials: rows.map(r => Object.assign({}, r, {
    issuer: 'manufacturer', issued_by: M[r.manufacturer_slug] || r.manufacturer_slug, upload_media_id: undefined, has_upload: !!r.upload_media_id,
    learner: (L[String(r.learner_id)] || {}).full_name || null, learner_email: (L[String(r.learner_id)] || {}).email || null,
    course: (C[String(r.course_id)] || {}).title || null, awaiting_review: ['exam_reported', 'awaiting_certificate', 'certificate_uploaded'].includes(r.status) })) };
};
WRITE.review_external_cert = async (staff, b) => {
  const decision = A.oneOf(b.decision, ['verified', 'rejected'], 'Decision');
  const evidence_type = decision === 'verified' ? A.oneOf(b.evidence_type, ['golden_certificate', 'manufacturer_confirmation'], 'Evidence') : null;
  const row = await A.op('review_external_cert', { p_actor: A.actorLabel(staff), p_id: A.uuid(b.id, 'credential'), p_decision: decision,
    p_evidence_type: evidence_type, p_evidence_ref: decision === 'verified' ? opt(b.evidence_ref, 300, 'Evidence reference') : null,
    p_note: decision === 'rejected' ? A.text(b.note, 1000, 'Note') : opt(b.note, 1000, 'Note') });
  return { ok: true, audited: true, credential: row };
};

/* ---------- activity and audit history ---------- */
READ.list_events = async (staff, b) => {
  let q = `academy_events?select=id,at,actor_type,actor,entity,entity_id,action,before,after`;
  if (b.entity) q += `&entity=eq.${A.oneOf(b.entity, ENTITIES, 'entity')}`;
  if (b.entity_id) q += `&entity_id=eq.${enc(A.text(b.entity_id, 80, 'record'))}`;
  if (b.actor) q += `&actor=eq.${enc(A.text(b.actor, 200, 'actor'))}`;
  if (b.event_action) { const a = A.text(b.event_action, 60, 'action'); if (!/^[a-z_]+$/.test(a)) A.refuse(400, 'invalid', 'action is not valid.'); q += `&action=eq.${a}`; }
  if (b.before_id != null && b.before_id !== '') q += `&id=lt.${int(b.before_id, 1, Number.MAX_SAFE_INTEGER, 'before_id')}`;
  const limit = int(b.limit, 1, 100, 'limit', 50);
  const rows = await A.sbGet(`${q}&order=id.desc&limit=${limit}`);
  return { ok: true, events: rows.map(eventOut), next_before_id: rows.length === limit ? rows[rows.length - 1].id : null };
};

/* ---------- records check (reconciliation of ordinary writes) ----------
   Every course, version, module and lesson row is compared with its latest EFFECTIVE audit row (an action whose _ref
   has a matching "_failed" row did not happen). Reports: rows with no audit row at all (unrecorded), rows whose current
   values differ from what the history says (drift — a change made outside the Command Center, or a failure whose
   failure record could not be written), and recorded rows that no longer exist (missing). Read only. */
const TRACKED = {
  academy_courses: ['slug', 'title', 'course_type', 'issuer', 'manufacturer_slug', 'category', 'external_url', 'status'],
  academy_course_versions: ['course_id', 'version', 'status', 'pass_mark', 'exam_questions', 'validity_months'],
  academy_modules: ['version_id', 'position', 'title', 'objectives'],
  academy_lessons: ['module_id', 'position', 'title', 'est_minutes'],
};
const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
READ.audit_check = async () => {
  const tables = Object.keys(TRACKED);
  const [events, ...rows] = await Promise.all([
    all(`academy_events?entity=in.(${tables.join(',')})&select=id,entity,entity_id,action,after`, 'id.asc'),
    ...tables.map(t => all(`${t}?select=id,${TRACKED[t].join(',')}`)),
  ]);
  const failed = new Set(events.filter(e => /_failed$/.test(e.action) && e.after && e.after._ref).map(e => e.after._ref));
  const latest = {};
  for (const e of events) {
    if (/_failed$/.test(e.action) || (e.after && e.after._ref && failed.has(e.after._ref)) || !e.entity_id) continue;
    latest[e.entity + '/' + e.entity_id] = e;                         // events arrive oldest first
  }
  const out = { unrecorded: [], drift: [], missing: [] }; const seen = new Set();
  tables.forEach((t, i) => {
    for (const r of rows[i]) {
      const k = t + '/' + r.id; seen.add(k); const e = latest[k];
      if (!e) { out.unrecorded.push({ entity: t, id: r.id }); continue; }
      if (/^delete_/.test(e.action)) { out.drift.push({ entity: t, id: r.id, event_id: e.id, fields: ['(recorded as removed)'] }); continue; }
      const fields = TRACKED[t].filter(f => e.after && Object.prototype.hasOwnProperty.call(e.after, f) && !same(e.after[f], r[f]));
      if (fields.length) out.drift.push({ entity: t, id: r.id, event_id: e.id, fields });
    }
  });
  for (const [k, e] of Object.entries(latest)) if (!seen.has(k) && !/^delete_/.test(e.action)) out.missing.push({ entity: e.entity, id: e.entity_id, event_id: e.id, action: e.action });
  const cap = l => l.slice(0, 200);
  // C2 / M4: every course's status must agree with its versions (null = M4 not installed yet, nothing to compare)
  let courses = null;
  try { courses = await A.publishConsistency(); } catch (e) { if (!(e && e.status === 503)) throw e; }
  return { ok: true, checked: rows.reduce((a, r) => a + r.length, 0), events: events.length, failed_actions: failed.size,
           clean: !out.unrecorded.length && !out.drift.length && !out.missing.length && !(courses && courses.length),
           course_status: courses === null ? 'not_checked' : (courses.length ? cap(courses) : 'consistent'),
           counts: { unrecorded: out.unrecorded.length, drift: out.drift.length, missing: out.missing.length },
           unrecorded: cap(out.unrecorded), drift: cap(out.drift), missing: cap(out.missing) };
};

/* ---------- lesson preview (A2D Stage 2) — READ ONLY ----------
   The staff preview draws a lesson with the SAME payload builder (_academy_lesson.js) and the SAME renderer
   (/assets/academy/lesson-player.js) the learner player will use. Nothing here writes: no progress is saved, no
   record is created. Answer keys and explanations are never part of a preview payload; preview_check grades ONE
   practice answer on the server and only then returns its explanation. Exam questions are never graded or explained. */
const LESSON = require('./_academy_lesson.js');
const { SAMPLES, MANUFACTURERS } = require('./_academy_samples.js');
const sampleOf = k => { const s = Object.prototype.hasOwnProperty.call(SAMPLES, String(k)) ? SAMPLES[String(k)] : null; return need(s, 'Sample lesson'); };
READ.preview_sample = async (staff, b) => {
  const s = sampleOf(b.sample);
  return { ok: true, samples: Object.values(SAMPLES).map(x => ({ key: x.key, label: x.label })),
    lesson: LESSON.buildLesson({ mode: 'preview', sample: s.key, course: s.course, module: s.module, lesson: s.lesson, outline: s.outline,
      facts: s.facts, media: [], questions: s.questions, manufacturers: MANUFACTURERS, version: { status: 'sample' } }) };
};
async function lessonContext(lessonId) {
  const l = need(one(await A.sbGet(`academy_lessons?id=eq.${enc(lessonId)}&select=id,module_id,position,title,est_minutes,blocks`)), 'Lesson');
  const m = need(one(await A.sbGet(`academy_modules?id=eq.${enc(l.module_id)}&select=id,version_id,position,title`)), 'Module');
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(m.version_id)}&select=${VERSION_COLS}`)), 'Course version');
  return { l, m, v };
}
READ.preview_lesson = async (staff, b) => ({ ok: true, lesson: (await lessonPayload(A.uuid(b.lesson_id, 'lesson')))('preview') });
async function lessonPayload(lessonId) {
  const { l, m, v } = await lessonContext(lessonId);
  const blocks = Array.isArray(l.blocks) ? l.blocks : [];
  const refs = LESSON.references(blocks);
  const models = [...new Set(refs.facts.map(f => f.model).filter(x => MODEL.test(x)))], mfrs = [...new Set(refs.facts.map(f => f.mfr).filter(x => SLUG.test(String(x || ''))))];
  const [course, mods, mfrRows, facts, media, questions] = await Promise.all([
    A.sbGet(`academy_courses?id=eq.${enc(v.course_id)}&select=${COURSE_COLS}`),
    all(`academy_modules?version_id=eq.${enc(v.id)}&select=id,position,title`, 'position.asc'),
    all(`manufacturers?select=slug,name`, 'slug.asc'),
    models.length && mfrs.length ? all(`product_facts?valid_to=is.null&manufacturer_slug=${idsIn(mfrs)}&model_code=${idsIn(models)}&select=${FACT_COLS}`) : [],
    byIds('academy_media', refs.media.filter(x => A_UUID.test(x)), 'id,kind,storage_path,external_url,alt_text'),
    // never the answer key or the explanation: the preview payload is built without them
    byIds('academy_questions', refs.questions.filter(x => A_UUID.test(x)), 'id,version_id,use,status,kind,prompt,choices'),
  ]);
  const lessons = mods.length ? await all(`academy_lessons?module_id=${idsIn(mods.map(x => x.id))}&select=id,module_id,position,title`, 'position.asc') : [];
  for (const md of media) md.signed_url = md.storage_path ? await A.signPrivate(md.storage_path, 900) : null;
  const ordered = mods.flatMap(x => lessons.filter(y => String(y.module_id) === String(x.id)).map(y => String(y.id)));
  const at = ordered.indexOf(String(l.id));
  const build = mode => LESSON.buildLesson({ mode, course: course[0] || {}, version: v, module: m, lesson: l,
    outline: mods.map(x => ({ position: x.position, title: x.title, lessons: lessons.filter(y => String(y.module_id) === String(x.id)) })),
    facts, media, questions: questions.filter(q => String(q.version_id) === String(v.id)),
    manufacturers: Object.fromEntries(mfrRows.map(r => [r.slug, r.name || r.slug])) });
  build.version_id = v.id; build.prev = at > 0 ? ordered[at - 1] : null; build.next = at >= 0 && at < ordered.length - 1 ? ordered[at + 1] : null;
  return build;
}
const A_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
READ.preview_check = async (staff, b, event) => {
  if (!event || event.httpMethod !== 'POST') A.refuse(405, 'method', 'Send answers as POST.');   // an answer never travels in a web address
  const qid = A.uuid(b.question_id, 'question');
  let q;
  if (b.sample != null) {
    const s = sampleOf(b.sample);
    if (!LESSON.lessonHasQuestion(s.lesson.blocks, qid)) A.refuse(404, 'not_found', 'Question not found.');
    q = s.questions.find(x => String(x.id) === qid);
  } else {
    const { l, m } = await lessonContext(A.uuid(b.lesson_id, 'lesson'));
    // the Course Builder's live preview checks a question of the lesson's UNSAVED screens; still the same lesson's version,
    // still practice only (below) — never more than the staff question bank of that version already shows
    const shown = Array.isArray(b.blocks) && b.blocks.length <= 40 ? b.blocks : l.blocks;
    if (!LESSON.lessonHasQuestion(shown, qid)) A.refuse(404, 'not_found', 'Question not found.');
    q = one(await A.sbGet(`academy_questions?id=eq.${enc(qid)}&version_id=eq.${enc(m.version_id)}&select=id,use,status,kind,answer_key,explanation`));
  }
  if (!q) A.refuse(404, 'not_found', 'Question not found.');
  if (q.use !== 'practice') A.refuse(403, 'not_practice', 'Exam questions are never checked or explained in a lesson.');
  if (q.status !== 'active') A.refuse(409, 'retired', 'This practice question has been retired.');
  const r = LESSON.checkPractice(q, b.answer);
  if (!r || r.invalid) A.refuse(400, 'invalid', 'Choose an answer first.');
  return { ok: true, correct: r.correct, explanation: r.explanation };   // never the answer key
};

/* ---------- Student view (administrators; 20 Oct 2026) ----------
   "View as a student": walk a course version (draft, in review, published or retired) exactly as a learner sees it —
   course page, lessons in order in the learner lesson player, practice checks, and a SAMPLE final exam drawn by the
   same rules as the real one. Nothing is written: no learner, enrollment, progress, attempt or certificate is created.
   The exam sample never sends an answer key to the browser; it is graded here, and only then does the reviewer see
   which questions were right (staff only, like the question bank). */
async function studentVersion(id) {
  const v = need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=${VERSION_COLS}`)), 'Course version');
  let limits = {};
  try { limits = one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=exam_time_limit_minutes,exam_cooldown_minutes,exam_daily_limit`)) || {}; }
  catch (e) { if (!(e && e.code === 'unreadable')) throw e; }
  return Object.assign({}, v, limits);
}
async function examPool(versionId) {
  const [qs, refs] = await Promise.all([
    all(`academy_questions?version_id=eq.${enc(versionId)}&use=eq.exam&status=eq.active&select=id,module_id,kind,prompt,choices,objective_tags`),
    all(`academy_content_refs?version_id=eq.${enc(versionId)}&question_id=not.is.null&field=not.is.null&select=question_id,pinned_fact_id`)]);
  const facts = await byIds('product_facts', refs.map(r => r.pinned_fact_id), 'id,valid_to,status');
  const okFact = Object.fromEntries(facts.map(f => [String(f.id), !f.valid_to && f.status === 'verified']));
  const blocked = new Set(refs.filter(r => !r.pinned_fact_id || !okFact[String(r.pinned_fact_id)]).map(r => String(r.question_id)));
  return { eligible: qs.filter(q => !blocked.has(String(q.id))), held: qs.filter(q => blocked.has(String(q.id))).length };
}
const shuffle = a => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = require('crypto').randomInt(0, i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; };
/* The same rules as the database draw (academy_author_exam_draw): only active exam questions whose facts are current and
   verified; with a per-module distribution, exactly that many from each module; without one, every module represented
   and the rest at random. A version the real exam could not draw for says why instead of drawing. */
function drawExam(v, modules, pool) {
  const want = Number(v.exam_questions) || 0, el = pool.eligible;
  const byMod = id => el.filter(q => String(q.module_id) === String(id));
  if (modules.some(m => m.exam_quota != null)) {
    const missing = modules.find(m => m.exam_quota == null);
    if (missing) return { problem: `The exam distribution is incomplete: module "${missing.title}" has no number of questions.` };
    const sum = modules.reduce((a, m) => a + Number(m.exam_quota), 0);
    if (sum !== want) return { problem: `The exam distribution adds up to ${sum} questions; this version draws ${want}.` };
    let out = [];
    for (const m of modules) {
      const have = byMod(m.id);
      if (have.length < m.exam_quota) return { problem: `Module "${m.title}" has ${have.length} usable exam question(s); the exam draws ${m.exam_quota} from it.` };
      out = out.concat(shuffle(have).slice(0, m.exam_quota));
    }
    return { questions: shuffle(out) };
  }
  const empty = modules.find(m => !byMod(m.id).length);
  if (empty) return { problem: `Module "${empty.title}" has no usable exam question; every module must be represented in the exam.` };
  if (el.length < want) return { problem: `Only ${el.length} usable exam question(s); the exam draws ${want}.` };
  const first = modules.map(m => shuffle(byMod(m.id))[0]);
  const ids = new Set(first.map(q => String(q.id)));
  return { questions: shuffle(first.concat(shuffle(el.filter(q => !ids.has(String(q.id)))).slice(0, Math.max(0, want - first.length)))) };
}
READ.student_catalog = async () => {
  const courses = (await all(`academy_courses?select=${COURSE_COLS}`, 'title.asc')).filter(c => c.course_type !== 'manufacturer_program');
  const versions = courses.length ? await all(`academy_course_versions?course_id=${idsIn(courses.map(c => c.id))}&select=id,course_id,version,status`, 'version.desc') : [];
  return { ok: true, courses: courses.map(c => ({ id: c.id, title: c.title, is_test: isTest(c),
    versions: versions.filter(v => String(v.course_id) === String(c.id)).map(v => ({ id: v.id, version: v.version, status: v.status })) })) };
};
READ.student_course = async (staff, b) => {
  const v = await studentVersion(A.uuid(b.version_id, 'version'));
  const [course, modules] = await Promise.all([
    A.sbGet(`academy_courses?id=eq.${enc(v.course_id)}&select=${COURSE_COLS}`),
    all(`academy_modules?version_id=eq.${enc(v.id)}&select=id,position,title,objectives,exam_quota`, 'position.asc')]);
  const c = need(one(course), 'Course');
  const lessons = modules.length ? await all(`academy_lessons?module_id=${idsIn(modules.map(m => m.id))}&select=id,module_id,position,title,est_minutes`, 'position.asc') : [];
  const pool = await examPool(v.id);
  const draw = drawExam(v, modules, pool);
  return { ok: true, course: { id: c.id, slug: c.slug, title: c.title, course_type: c.course_type, issuer: c.issuer, manufacturer_slug: c.manufacturer_slug || null, status: c.status, is_test: /^test-/.test(c.slug) },
    version: { id: v.id, version: v.version, status: v.status, pass_mark: v.pass_mark, exam_questions: v.exam_questions, validity_months: v.validity_months,
      time_limit_minutes: v.exam_time_limit_minutes || null, cooldown_minutes: v.exam_cooldown_minutes || null, daily_limit: v.exam_daily_limit || null },
    modules: modules.map(m => ({ id: m.id, position: m.position, title: m.title, objectives: m.objectives || [],
      lessons: lessons.filter(l => String(l.module_id) === String(m.id)).map(l => ({ id: l.id, position: l.position, title: l.title, est_minutes: l.est_minutes })) })),
    exam: { usable: pool.eligible.length, held_unverified: pool.held, ready: !draw.problem, problem: draw.problem || null },
    disclosure: c.issuer === 'hcps' || c.course_type === 'hcps_certification'
      ? 'Issued by Home Care Provider Services (HCPS). This course is independently developed and administered by HCPS; it is not issued, sponsored or endorsed by Golden Technologies.' : null };
};
/* One lesson exactly as a learner's player receives it (learner mode: no staff badge, no staff warnings inside the
   player); the preview warnings come back beside it, for the staff ribbon only. */
READ.student_lesson = async (staff, b) => {
  const build = await lessonPayload(A.uuid(b.lesson_id, 'lesson'));
  if (b.version_id != null && String(A.uuid(b.version_id, 'version')) !== String(build.version_id)) A.refuse(404, 'not_found', 'Lesson not found in this version.');
  return { ok: true, lesson: build('learner'), staff_warnings: build('preview').warnings || [], prev_lesson_id: build.prev, next_lesson_id: build.next };
};
READ.student_exam_draw = async (staff, b, event) => {
  if (!event || event.httpMethod !== 'POST') A.refuse(405, 'method', 'Use POST.');
  const v = await studentVersion(A.uuid(b.version_id, 'version'));
  const modules = await all(`academy_modules?version_id=eq.${enc(v.id)}&select=id,position,title,exam_quota`, 'position.asc');
  const d = drawExam(v, modules, await examPool(v.id));
  if (d.problem) return { ok: false, problem: d.problem };
  // what a learner gets: prompt and choices only — never the answer key, the explanation or the topic tags
  return { ok: true, pass_mark: v.pass_mark, time_limit_minutes: v.exam_time_limit_minutes || null,
    questions: d.questions.map(q => ({ id: q.id, kind: q.kind, prompt: q.prompt, choices: (q.choices || []).map(c => ({ id: c.id, text: c.text })) })) };
};
READ.student_exam_grade = async (staff, b, event) => {
  if (!event || event.httpMethod !== 'POST') A.refuse(405, 'method', 'Send answers as POST.');
  const v = await studentVersion(A.uuid(b.version_id, 'version'));
  const ids = Array.isArray(b.question_ids) ? b.question_ids.map(x => A.uuid(x, 'question')) : [];
  if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length) A.refuse(400, 'invalid', 'The sample exam could not be read.');
  const qs = await byIds('academy_questions', ids, 'id,version_id,use,status,kind,prompt,answer_key,explanation,objective_tags');
  if (qs.length !== ids.length || qs.some(q => String(q.version_id) !== String(v.id) || q.use !== 'exam')) A.refuse(400, 'invalid', 'These are not this version\'s exam questions.');
  const answers = b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : {};
  const byId = Object.fromEntries(qs.map(q => [String(q.id), q]));
  let right = 0; const topics = new Set(), review = [];
  for (const id of ids) {
    const q = byId[id], given = LESSON.normAnswer(q.kind, answers[id]);
    const keyv = q.kind === 'multi' ? [...new Set(Array.isArray(q.answer_key) ? q.answer_key : [])].sort() : q.answer_key;
    const ok = given !== null && JSON.stringify(given) === JSON.stringify(keyv);
    if (ok) right++; else (q.objective_tags || []).forEach(t => topics.add(t));
    review.push({ id, prompt: q.prompt, answered: given !== null, correct: ok, explanation: String(q.explanation || '').slice(0, 2000) });
  }
  const total = ids.length;
  return { ok: true, recorded: false, score: Math.floor(right * 100 / total), passed: right * 100 >= Number(v.pass_mark) * total,
    pass_mark: v.pass_mark, right, total, study_topics: [...topics].sort(), staff_review: review };
};

/* ---------- Paid access (Phase 2 / M8 sandbox, M9 live) ----------
   Reads: administrators. Writes (prices, eligibility overrides): the President only, here AND in the database.
   Nothing here charges, refunds or grants access: access comes only from the signature-verified Stripe webhook and a
   refund is issued in the Stripe Dashboard (its webhook withdraws the enrollment). No secret value is ever returned. */
const STRIPE = require('./_stripe.js');
/* Until Angelo installs M8 the membership table has no organization_id: older reads must keep working unchanged. */
async function m8Installed() {
  try { await A.sbGet('academy_organizations?select=id&limit=1'); return true; }
  catch (e) { if (e && e.code === 'unreadable') return false; throw e; }
}
async function orgNames(ids) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return {};
  let rows = [];
  try { rows = await byIds('academy_organizations', list, 'id,name'); } catch (e) { if (e && e.code === 'unreadable') return {}; throw e; }
  return Object.fromEntries(rows.map(o => [String(o.id), o.name]));
}
/* M9 adds academy_purchases.amount_tax_cents; until it is installed the list is read without it (m9: false). */
async function m9Installed() {
  try { await A.sbGet('academy_purchases?select=amount_tax_cents&limit=1'); return true; }
  catch (e) { if (e && e.code === 'unreadable') return false; throw e; }
}
READ.payments = async () => {
  const sw = await A.switches();
  let installed = true, prices = [], purchases = [], overrides = [], m9 = false;
  try {
    m9 = await m9Installed();
    [prices, purchases, overrides] = await Promise.all([
      all(`academy_prices?select=course_id,price_outside_cents,currency,network_included,outside_sale_allowed,commercial_rights_confirmed,rights_note,updated_at,updated_by`, 'course_id.asc'),
      A.sbGet(`academy_purchases?select=id,course_id,email,full_name,company,amount_cents,currency,status,livemode,${m9 ? 'amount_tax_cents,' : ''}created_at,paid_at,refunded_at,amount_refunded_cents,review_reason,enrollment_id&order=created_at.desc&limit=200`),
      all(`academy_dealer_eligibility?select=dealer_id,eligible,reason,set_by,set_at`, 'dealer_id.asc'),
    ]);
  } catch (e) { if (e && e.code === 'unreadable') installed = false; else throw e; }
  const courses = await all(`academy_courses?select=id,slug,title,course_type,manufacturer_slug,status`);
  // F1 (free launch): each course's access policy, independent of its price. Before F1 is installed: none.
  let accessInstalled = true, access = [], freeCounts = {};
  try {
    access = await all(`academy_course_access?select=course_id,mode,note,reason,set_by,set_at`, 'course_id.asc');
    const fe = await all(`academy_enrollments?select=id,version_id,access_source&access_source=eq.free`);
    const vc = Object.fromEntries((await byIds('academy_course_versions', fe.map(e => e.version_id), 'id,course_id')).map(v => [String(v.id), String(v.course_id)]));
    for (const e of fe) { const c = vc[String(e.version_id)]; if (c) freeCounts[c] = (freeCounts[c] || 0) + 1; }
  } catch (e) { if (e && e.code === 'unreadable') accessInstalled = false; else throw e; }
  const ac = Object.fromEntries(access.map(a => [String(a.course_id), a]));
  const pr = Object.fromEntries(prices.map(p => [String(p.course_id), p]));
  const dn = Object.fromEntries((await byIds('dealers', overrides.map(o => o.dealer_id), 'id,business_name')).map(d => [String(d.id), d.business_name]));
  const title = Object.fromEntries(courses.map(c => [String(c.id), c.title]));
  const live = { tax_switch_on: sw.academy_payments_tax === true, switch_on: sw.academy_payments_live === true, key_mode: STRIPE.liveKeyMode(), webhook_configured: STRIPE.webhookConfigured(true) };
  live.ready = live.key_mode === 'live' && live.webhook_configured;
  return { ok: true, installed, access_installed: accessInstalled, m9_installed: m9, switch_on: sw.academy_payments === true, stripe_mode: STRIPE.keyMode(), webhook_configured: STRIPE.webhookConfigured(false),
    live, mode: live.switch_on ? 'live' : 'sandbox',
    courses: courses.filter(c => !isTest(c)).map(c => ({ id: c.id, slug: c.slug, title: c.title, status: c.status, course_type: c.course_type,
      manufacturer_slug: c.manufacturer_slug || null, needs_rights: !!c.manufacturer_slug, price: pr[String(c.id)] || null,
      access: ac[String(c.id)] || null, free_enrollments: freeCounts[String(c.id)] || 0 })),
    purchases: purchases.map(p => Object.assign({}, p, { course: title[String(p.course_id)] || null })),
    totals: tally(purchases.filter(p => p.livemode !== true), 'status'),
    live_totals: tally(purchases.filter(p => p.livemode === true), 'status'),
    eligibility_overrides: overrides.map(o => Object.assign({}, o, { dealer: dn[String(o.dealer_id)] || null })) };
};
WRITE.set_price = async (staff, b) => {
  requirePresident(staff);
  const spec = {};
  if (Object.prototype.hasOwnProperty.call(b, 'price_outside_cents')) spec.price_outside_cents = b.price_outside_cents == null || b.price_outside_cents === '' ? null : int(b.price_outside_cents, 99, 100000, 'Price (cents)');
  for (const k of ['network_included', 'outside_sale_allowed', 'commercial_rights_confirmed']) if (b[k] != null) {
    if (typeof b[k] !== 'boolean') A.refuse(400, 'invalid', `${k} must be true or false.`); spec[k] = b[k];
  }
  if (Object.prototype.hasOwnProperty.call(b, 'rights_note')) spec.rights_note = opt(b.rights_note, 500, 'Rights note');
  const price = await A.purchaseOp('set_price', { p_actor: A.actorLabel(staff), p_course_id: A.uuid(b.course_id, 'course'), p_spec: spec });
  const expired = await require('./_academy_stripe_ops.js').expireStale(50);   // open checkouts at the old price are closed at Stripe too
  return { ok: true, audited: true, price, stripe_checkouts_closed: expired };
};
/* Money taken in Stripe without the matching HCPS record (read-only; sandbox and live; never a secret). */
READ.payments_reconcile = async (staff, b) => {
  const days = b && b.days != null ? int(b.days, 1, 90, 'Days') : 14;
  return Object.assign({ ok: true }, await require('./_academy_stripe_ops.js').reconcile(days));
};
WRITE.set_eligibility = async (staff, b) => {
  requirePresident(staff);
  const e = b.eligible === true || b.eligible === false ? b.eligible : (b.eligible == null ? null : A.refuse(400, 'invalid', 'eligible must be true, false or empty.'));
  return { ok: true, audited: true, result: await A.purchaseOp('set_eligibility', { p_actor: A.actorLabel(staff), p_dealer_id: A.uuid(b.dealer_id, 'dealership'), p_eligible: e, p_reason: A.text(b.reason, 500, 'Reason') }) };
};
/* F1 (free launch): the President sets a course's access policy — off / free / paid — with a reason (audited). It never
   changes the price; switching a course to paid later keeps every free learner's enrollment, progress and certificate. */
WRITE.set_course_access = async (staff, b) => {
  requirePresident(staff);
  const mode = A.oneOf(b.mode, ['off', 'free', 'paid'], 'Access');
  const note = b.note == null || String(b.note).trim() === '' ? null : A.text(b.note, 300, 'Note');
  return { ok: true, audited: true, access: await A.freeOp('set_access', { p_actor: A.actorLabel(staff), p_course_id: A.uuid(b.course_id, 'course'),
    p_mode: mode, p_note: note, p_reason: A.text(b.reason, 500, 'Reason') }) };
};

/* ---------- Course Builder (A2D Stage 3) ---------- */
const BUILDER = require('./_academy_builder.js');
for (const [k, fn] of Object.entries(BUILDER.READ)) { if (READ[k] || WRITE[k]) throw new Error('duplicate action ' + k); READ[k] = fn; }
for (const [k, fn] of Object.entries(BUILDER.WRITE)) { if (READ[k] || WRITE[k]) throw new Error('duplicate action ' + k); WRITE[k] = fn; }

/* ================================== HANDLER ================================== */
const ACTIONS = {};
for (const [k, fn] of Object.entries(READ)) ACTIONS[k] = { fn, write: false };
for (const [k, fn] of Object.entries(WRITE)) ACTIONS[k] = { fn, write: true };

exports.handler = A.handler(async event => {
  const staff = await A.staffActor(event);
  if (!staff) return A.respond(event, 401, { error: 'unauthorized', message: 'Please sign in to Connect 360.' });
  // the builder's file upload is the one request allowed above the usual size, and only when it says so up front
  const upload = event.httpMethod === 'POST' && String((event.headers || {})['x-academy-upload'] || '') === '1';
  const b = event.httpMethod === 'GET' ? Object.assign({}, event.queryStringParameters || {}) : A.body(event, upload ? BUILDER.UPLOAD_BODY : undefined);
  const action = String(b.action || 'whoami');
  if (upload && action !== 'upload_media') return A.respond(event, 413, { error: 'too_large', message: 'That request is too large.' });
  if (action === 'whoami') {
    const sw = await A.switches();
    return A.respond(event, 200, {
      ok: true, email: staff.email, role: staff.role, enabled: sw.academy_admin, switches: sw,
      may: { administer: A.isAdmin(staff), publish: A.isAdmin(staff) && isPresident(staff), see_scores: A.isAdmin(staff),
             dealer_scope: A.isAdmin(staff) || A.isRelations(staff) ? 'all' : 'own_book' },
    });
  }
  if (!(await A.switchOn('academy_admin'))) return A.respond(event, 403, { error: 'flag_off', message: 'The Academy Command Center is switched off.' });
  A.requireAdmin(staff);                                                     // HCPS administrators only; everyone else: 403
  const a = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!a) return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });
  if (a.write && event.httpMethod !== 'POST') return A.respond(event, 405, { error: 'method', message: 'Changes must be sent as POST.' });
  // Until M3.1 is installed, only the President edits course content (Angelo, 12 Oct 2026).
  if (BUILDER.PRESIDENT_ONLY_EDITING.includes(action) && !isPresident(staff)) return A.respond(event, 403, { error: 'president_only', message: 'Until the M3.1 save upgrade is installed, only the President edits course content.' });
  return A.respond(event, 200, await a.fn(staff, b, event));
});
exports._actions = ACTIONS;
exports._scrub = scrub;
