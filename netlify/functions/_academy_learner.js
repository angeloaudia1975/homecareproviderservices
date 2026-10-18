/* HCPS Academy — learner and Training Manager actions (A2B). Registered in academy-api.js.
   Who is acting always comes from the Academy session (or, for the three sign-in actions, from the code itself),
   never from the request. Every change is one M5 operation (the change and its audit row, or neither).
     PUBLIC (no session; POST only):  request_code {email} · verify_code {email, code} · handoff_redeem {code}
     LEARNER:   me · sign_out · my_courses · lesson {enrollment_id, lesson_id} · practice_check {..., question_id, answer}
                save_progress {enrollment_id, lesson_id, status, resume_block}
     TRAINING MANAGER (their own dealership = the dealer and its direct branches):
                team · courses · invite {dealer_id, email, full_name} · revoke_invite {id, reason}
                deactivate {membership_id, reason} · reactivate {learner_id, dealer_id}
                enroll {learner_id, version_id, due_on} · withdraw {enrollment_id, reason}
   Learner answers to practice questions are graded on the server; answer keys, explanations of exam questions and
   scores never reach a learner page. Nothing here can order, price or reach Connect 360: the session is accepted only
   by academy-api. */
const crypto = require('crypto');
const A = require('./_academy.js');
const LESSON = require('./_academy_lesson.js');
const MAIL = require('./_academy_mail.js');

const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Z0-9][A-Z0-9._\/-]{0,39}$/, SLUG = /^[a-z0-9-]+$/;
const one = rows => rows[0] || null;
const idsIn = ids => `in.(${[...new Set(ids.map(String))].map(enc).join(',')})`;
async function byIds(table, ids, select) {
  const list = [...new Set((ids || []).filter(x => UUID.test(String(x))).map(String))];
  const out = []; for (let i = 0; i < list.length; i += 150) out.push(...await A.sbGet(`${table}?id=${idsIn(list.slice(i, i + 150))}&select=${select}`));
  return out;
}
const email = v => { const s = String(v == null ? '' : v).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 254) A.refuse(400, 'invalid', 'Enter a valid email address.'); return s; };
/* The caller's network address for rate limits (A2B security review S2): ONLY Netlify's own x-nf-client-connection-ip,
   which its edge sets for every request. X-Forwarded-For, Client-IP and the like can be written by the caller and are
   never read. Without the Netlify header every such request shares one bucket (fail closed, never one bucket each). */
const clientIp = event => {
  const h = (event && event.headers) || {};
  const v = String(h['x-nf-client-connection-ip'] || '').trim();
  return /^[0-9A-Fa-f:.]{2,45}$/.test(v) ? v.toLowerCase() : 'unknown';
};
const ipHash = event => A.SESSION.keyedHash('ip', clientIp(event));
const reason = v => A.text(v, 500, 'Reason');
const actorOf = learner => 'learner:' + learner.learner_id;
function needSecret() { if (!A.SESSION.configured()) A.refuse(503, 'session_unavailable', 'Academy sign-in is not available just now.'); }
function signedIn(event, learnerId, sessionId, payload) {
  const v = A.SESSION.issue(learnerId, sessionId);
  if (!v) A.refuse(503, 'session_unavailable', 'Academy sign-in is not available just now.');
  return A.respond(event, 200, payload, { cookie: A.SESSION.setCookie(v) });
}

/* ================================ PUBLIC: signing in ================================ */
const PUBLIC = {};
const SENT = 'If this address can use the HCPS Academy, a 6-digit code is on its way. It works once, for 10 minutes.';
/* A2B security review S1: the answer must not reveal — by its words OR its timing — whether an address can use the
   Academy. So (1) every request, known or unknown, hands exactly one sealed job of the same size to the mail worker and
   never waits for the email provider; (2) the answer is held to a fixed minimum time, so the database work for a known
   address (an audit row) cannot be timed either. */
const FLOOR_MS = () => { const n = Number(process.env.ACADEMY_SIGNIN_FLOOR_MS); return Number.isFinite(n) && n >= 0 ? n : 900; };
const holdUntil = async t0 => { const wait = FLOOR_MS() - (Date.now() - t0); if (wait > 0) await new Promise(r => setTimeout(r, wait)); };
PUBLIC.request_code = async (event, b) => {
  const t0 = Date.now();
  needSecret();
  const addr = email(b.email);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = A.SESSION.keyedHash('code', addr + ':' + code);
  const r = await A.accessOp('access_op_request_code', { p_email: addr, p_code_hash: codeHash, p_ip_hash: ipHash(event) });
  if (r && r.limited) { await holdUntil(t0); return A.respond(event, 429, { error: 'too_many', message: 'Too many codes were asked for. Wait 15 minutes and try again.' }); }
  const real = !!(r && r.send);
  // a decoy carries a dummy code of the same shape and a random id, so the two envelopes cannot be told apart
  const job = real ? { k: 'code', to: addr, code, id: String(r.code_id), h: codeHash }
                   : { k: 'none', to: 'x'.repeat(addr.length) + '@decoy', code: '000000', id: crypto.randomUUID(), h: '0'.repeat(64) };
  const accepted = await MAIL.dispatch(A.SESSION.sealJob(job));
  if (real && !accepted) {   // the worker could not take it: burn the code and stop it counting, so asking again works
    try { await A.accessOp('access_op_code_undelivered', { p_code_id: String(r.code_id), p_code_hash: codeHash }); } catch (e) { /* logged below */ }
    console.warn('[academy] sign-in code could not be handed to the mail worker');   // never the code, never the address
  }
  await holdUntil(t0);
  return A.respond(event, 200, { ok: true, message: SENT });   // the same answer whether or not the address is known
};
PUBLIC.verify_code = async (event, b) => {
  needSecret();
  const addr = email(b.email), code = String(b.code == null ? '' : b.code).trim();
  if (!/^\d{6}$/.test(code)) return A.respond(event, 400, { error: 'invalid', message: 'Enter the 6-digit code from the email.' });
  const r = await A.accessOp('access_op_verify_code', { p_email: addr, p_code_hash: A.SESSION.keyedHash('code', addr + ':' + code), p_ip_hash: ipHash(event) });
  if (!r || !r.ok) {
    const why = r && r.reason;
    if (why === 'limited') return A.respond(event, 429, { error: 'too_many', message: 'Too many tries. Wait 15 minutes and try again.' });
    if (why === 'wrong') return A.respond(event, 400, { error: 'wrong_code', message: 'That code is not right. Check the email and try again.' });
    if (why === 'not_allowed') return A.respond(event, 403, { error: 'no_access', message: 'This address does not have HCPS Academy access. Ask your Training Manager to invite you.' });
    return A.respond(event, 400, { error: 'expired', message: 'That code has expired or was already used. Ask for a new one.' });
  }
  return signedIn(event, r.learner_id, r.session_id, { ok: true });
};
PUBLIC.handoff_redeem = async (event, b) => {
  needSecret();
  if (!(await A.switchOn('academy_handoff'))) return A.respond(event, 403, { error: 'flag_off', message: 'Academy entry from Partner 360 is not available yet.' });
  const code = String(b.code == null ? '' : b.code);
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return A.respond(event, 400, { error: 'expired', message: 'This Training link has expired. Open Training again from Partner 360.' });
  const r = await A.accessOp('access_op_handoff_redeem', { p_code_hash: A.SESSION.keyedHash('handoff', code), p_ip_hash: ipHash(event) });
  if (!r || !r.ok) {
    if (r && r.reason === 'not_allowed') return A.respond(event, 403, { error: 'no_access', message: 'Your Partner 360 login does not have HCPS Academy access. Ask HCPS.' });
    return A.respond(event, 400, { error: 'expired', message: 'This Training link has expired or was already used. Open Training again from Partner 360.' });
  }
  return signedIn(event, r.learner_id, r.session_id, { ok: true });
};

/* ================================ LEARNER ================================ */
const LEARNER = {};
const dealerNames = async ids => Object.fromEntries((await byIds('dealers', ids, 'id,business_name')).map(d => [String(d.id), d.business_name || 'Dealership']));
const isTM = learner => learner.memberships.some(m => m.role === 'training_manager');

LEARNER.me = async (event, learner) => {
  const names = await dealerNames(learner.memberships.map(m => m.dealer_id));
  return { ok: true, learner: { id: learner.learner_id, full_name: learner.full_name, email: learner.email },
    memberships: learner.memberships.map(m => ({ id: m.id, dealer_id: m.dealer_id, dealer: names[String(m.dealer_id)] || 'Dealership', role: m.role, access_type: m.access_type })),
    training_manager: isTM(learner) };
};
LEARNER.sign_out = async (event, learner) => {
  await A.accessOp('access_op_end_session', { p_actor: actorOf(learner), p_session_id: learner.session_id });
  return A.respond(event, 200, { ok: true }, { cookie: A.SESSION.clearCookie() });
};

/* The learner's own enrollments: the version they were enrolled in (decision B — published or since retired), its
   lessons in order and their own progress. Enrollments of an ended membership are not shown. */
async function myEnrollments(learner) {
  const active = new Set(learner.memberships.map(m => String(m.id)));
  const rows = (await A.sbGet(`academy_enrollments?learner_id=eq.${enc(learner.learner_id)}&status=neq.withdrawn&select=id,version_id,membership_id,status,due_on,created_at`))
    .filter(e => active.has(String(e.membership_id)));
  return rows;
}
async function versionOutline(versionIds) {
  const vers = await byIds('academy_course_versions', versionIds, 'id,course_id,version,status');
  const courses = await byIds('academy_courses', vers.map(v => v.course_id), 'id,title,manufacturer_slug');
  const mods = vers.length ? await A.sbGet(`academy_modules?version_id=${idsIn(vers.map(v => v.id))}&select=id,version_id,position,title&order=position.asc`) : [];
  const lessons = mods.length ? await A.sbGet(`academy_lessons?module_id=${idsIn(mods.map(m => m.id))}&select=id,module_id,position,title,est_minutes&order=position.asc`) : [];
  return { vers, courses, mods, lessons };
}
LEARNER.my_courses = async (event, learner) => {
  const enr = await myEnrollments(learner);
  const examsOpen = await A.switchOn('academy_exams');
  const { vers, courses, mods, lessons } = await versionOutline(enr.map(e => e.version_id));
  const prog = enr.length ? await A.sbGet(`academy_progress?enrollment_id=${idsIn(enr.map(e => e.id))}&select=enrollment_id,lesson_id,status,resume_block`) : [];
  const out = enr.map(e => {
    const v = vers.find(x => String(x.id) === String(e.version_id)) || {};
    if (!['published', 'retired'].includes(v.status)) return null;
    const c = courses.find(x => String(x.id) === String(v.course_id)) || {};
    const ms = mods.filter(m => String(m.version_id) === String(v.id));
    const p = prog.filter(x => String(x.enrollment_id) === String(e.id));
    const outline = ms.map(m => ({ position: m.position, title: m.title, lessons: lessons.filter(l => String(l.module_id) === String(m.id)).map(l => {
      const pr = p.find(x => String(x.lesson_id) === String(l.id));
      return { id: l.id, position: l.position, title: l.title, est_minutes: l.est_minutes, status: pr ? pr.status : 'not_started' };
    }) }));
    const all = outline.flatMap(m => m.lessons), done = all.filter(l => l.status === 'completed').length;
    const next = all.find(l => l.status !== 'completed') || null;
    return { enrollment_id: e.id, status: e.status, due_on: e.due_on, course: c.title || 'Course', version: v.version, version_status: v.status,
      lessons_total: all.length, lessons_completed: done, next_lesson_id: next ? next.id : null, outline };
  }).filter(Boolean);
  return { ok: true, courses: out, exams_open: examsOpen };
};

/* One lesson of one of the learner's own enrollments, drawn by the SAME payload builder and renderer as the staff
   preview, in learner mode. Never an answer key or an explanation. */
async function ownLesson(learner, enrollmentId, lessonId) {
  const eid = A.uuid(enrollmentId, 'enrollment'), lid = A.uuid(lessonId, 'lesson');
  const e = (await myEnrollments(learner)).find(x => String(x.id) === eid);
  if (!e) A.refuse(404, 'not_found', 'Course not found.');
  const v = one(await A.sbGet(`academy_course_versions?id=eq.${enc(e.version_id)}&select=id,course_id,version,status,pass_mark,exam_questions,validity_months`));
  if (!v || !['published', 'retired'].includes(v.status)) A.refuse(404, 'not_found', 'Course not found.');
  const l = one(await A.sbGet(`academy_lessons?id=eq.${enc(lid)}&select=id,module_id,position,title,est_minutes,blocks`));
  const m = l && one(await A.sbGet(`academy_modules?id=eq.${enc(l.module_id)}&select=id,version_id,position,title`));
  if (!l || !m || String(m.version_id) !== String(v.id)) A.refuse(404, 'not_found', 'Lesson not found.');
  return { e, v, l, m };
}
LEARNER.lesson = async (event, learner, b) => {
  const { e, v, l, m } = await ownLesson(learner, b.enrollment_id, b.lesson_id);
  const blocks = Array.isArray(l.blocks) ? l.blocks : [];
  const refs = LESSON.references(blocks);
  const models = [...new Set(refs.facts.map(f => f.model).filter(x => MODEL.test(x)))], mfrs = [...new Set(refs.facts.map(f => f.mfr).filter(x => SLUG.test(String(x || ''))))];
  const [course, mods, mfrRows, facts, media, questions, prog] = await Promise.all([
    A.sbGet(`academy_courses?id=eq.${enc(v.course_id)}&select=id,slug,title,course_type,issuer,manufacturer_slug`),
    A.sbGet(`academy_modules?version_id=eq.${enc(v.id)}&select=id,position,title&order=position.asc`),
    A.sbGet(`manufacturers?select=slug,name&order=slug.asc`),
    models.length && mfrs.length ? A.sbGet(`product_facts?valid_to=is.null&manufacturer_slug=${idsIn(mfrs)}&model_code=${idsIn(models)}&select=id,manufacturer_slug,model_code,field,value,unit,field_class,status,source_url,source_label,verified_on,note,valid_from,valid_to`) : [],
    byIds('academy_media', refs.media, 'id,kind,storage_path,external_url,alt_text'),
    byIds('academy_questions', refs.questions, 'id,version_id,use,status,kind,prompt,choices'),   // never answer_key / explanation
    A.sbGet(`academy_progress?enrollment_id=eq.${enc(e.id)}&lesson_id=eq.${enc(l.id)}&select=status,resume_block`),
  ]);
  const lessons = mods.length ? await A.sbGet(`academy_lessons?module_id=${idsIn(mods.map(x => x.id))}&select=id,module_id,position,title&order=position.asc`) : [];
  for (const md of media) md.signed_url = md.storage_path ? await A.signPrivate(md.storage_path, 900) : null;
  const ordered = mods.flatMap(md => lessons.filter(x => String(x.module_id) === String(md.id)));
  const i = ordered.findIndex(x => String(x.id) === String(l.id));
  const payload = LESSON.buildLesson({ mode: 'learner', course: course[0] || {}, version: v, module: m, lesson: l,
    outline: mods.map(x => ({ position: x.position, title: x.title, lessons: lessons.filter(y => String(y.module_id) === String(x.id)) })),
    facts, media, questions: questions.filter(q => String(q.version_id) === String(v.id) && q.use === 'practice'),
    manufacturers: Object.fromEntries(mfrRows.map(r => [r.slug, r.name || r.slug])) });
  delete payload.warnings;   // staff-only authoring notes
  const p = prog[0] || null;
  return { ok: true, enrollment_id: e.id, lesson: payload, progress: p ? { status: p.status, resume_block: p.resume_block } : { status: 'not_started', resume_block: 0 },
    prev_lesson_id: i > 0 ? ordered[i - 1].id : null, next_lesson_id: i >= 0 && i < ordered.length - 1 ? ordered[i + 1].id : null };
};
LEARNER.practice_check = async (event, learner, b) => {
  const { v, l } = await ownLesson(learner, b.enrollment_id, b.lesson_id);
  const qid = A.uuid(b.question_id, 'question');
  if (!LESSON.lessonHasQuestion(l.blocks, qid)) A.refuse(404, 'not_found', 'Question not found.');
  const q = one(await A.sbGet(`academy_questions?id=eq.${enc(qid)}&version_id=eq.${enc(v.id)}&select=id,use,status,kind,answer_key,explanation`));
  if (!q) A.refuse(404, 'not_found', 'Question not found.');
  if (q.use !== 'practice') A.refuse(403, 'not_practice', 'Exam questions are never checked in a lesson.');
  if (q.status !== 'active') A.refuse(409, 'retired', 'This practice question has been retired.');
  const r = LESSON.checkPractice(q, b.answer);
  if (!r || r.invalid) A.refuse(400, 'invalid', 'Choose an answer first.');
  return { ok: true, correct: r.correct, explanation: r.explanation };   // never the answer key
};
/* ---------------- the final exam (A2E / M6). The limits (one open attempt, cooldown, daily limit, time limit and expiry)
   are enforced by the database operations academy_exam_op_*; answer keys and explanations never leave the database.
   Switch academy_exams (off until Angelo approves the pilot). Every exam action is POST. */
async function examsOn() { if (!(await A.switchOn('academy_exams'))) A.refuse(403, 'flag_off', 'The final exam is not open yet.'); }
const ownEnrollment = async (learner, id) => {
  const eid = A.uuid(id, 'enrollment');
  if (!(await myEnrollments(learner)).some(e => String(e.id) === eid)) A.refuse(404, 'not_found', 'Course not found.');
  return eid;
};
// answers: {question id: "a" | ["a","c"]}; the database checks each one against the attempt's own questions
const answersOf = v => { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) A.refuse(400, 'invalid', 'Those answers are not valid.'); return v; };
LEARNER.exam_status = async (event, learner, b) => {
  await examsOn();
  const eid = await ownEnrollment(learner, b.enrollment_id);
  return Object.assign({ ok: true }, await A.accessOp('exam_op_status', { p_actor: actorOf(learner), p_enrollment_id: eid }));
};
LEARNER.exam_start = async (event, learner, b) => {
  await examsOn();
  const eid = await ownEnrollment(learner, b.enrollment_id);
  const r = await A.accessOp('exam_op_start', { p_actor: actorOf(learner), p_enrollment_id: eid });
  if (!r.ok) return A.respond(event, 409, Object.assign({ error: r.reason, message: EXAM_WAIT[r.reason] || 'You cannot start the exam just now.' }, r));
  return r;
};
const EXAM_WAIT = {
  open_attempt: 'You already have an exam in progress. Finish it first.',
  cooldown: 'You can take the exam again after a short break.',
  daily_limit: 'You have used today’s exam attempts. You can try again tomorrow.',
  grading_pending: 'Your last attempt is still being graded. Your saved answers are kept. Please contact HCPS if this does not clear.',
};
// A grade the database could not write (recorded there): never answered as a result.
const EXAM_UNGRADED = {
  grading_failed: 'Your answers are saved, but they could not be graded just now. Try submitting again in a moment; if it keeps happening, contact HCPS.',
  grading_pending: 'Time ran out. Your saved answers are kept, but they could not be graded yet. They will be graded with the answers you saved — please contact HCPS if this does not clear.',
};
LEARNER.exam_view = async (event, learner, b) => {
  await examsOn();
  return Object.assign({ ok: true }, await A.accessOp('exam_op_view', { p_actor: actorOf(learner), p_attempt_id: A.uuid(b.attempt_id, 'attempt') }));
};
LEARNER.exam_save = async (event, learner, b) => {
  await examsOn();
  return await A.accessOp('exam_op_save', { p_actor: actorOf(learner), p_attempt_id: A.uuid(b.attempt_id, 'attempt'), p_answers: answersOf(b.answers) });
};
LEARNER.exam_submit = async (event, learner, b) => {
  await examsOn();
  const r = await A.accessOp('exam_op_submit', { p_actor: actorOf(learner), p_attempt_id: A.uuid(b.attempt_id, 'attempt'), p_answers: answersOf(b.answers) });
  if (r && r.ok === false) {
    console.error('[academy] exam not graded', JSON.stringify({ attempt: r.attempt_id, reason: r.reason, recorded: r.recorded }));
    return A.respond(event, 409, { error: r.reason || 'grading_failed', message: EXAM_UNGRADED[r.reason] || EXAM_UNGRADED.grading_failed,
      attempt_id: r.attempt_id, expired: r.expired === true });
  }
  return r;
};

LEARNER.save_progress = async (event, learner, b) => {
  const status = A.oneOf(b.status, ['viewed', 'completed'], 'Progress');
  const rb = Number(b.resume_block); if (!Number.isInteger(rb) || rb < 0 || rb > 500) A.refuse(400, 'invalid', 'That screen is not valid.');
  const row = await A.accessOp('progress_op_save', { p_actor: actorOf(learner), p_enrollment_id: A.uuid(b.enrollment_id, 'enrollment'),
    p_lesson_id: A.uuid(b.lesson_id, 'lesson'), p_status: status, p_resume_block: rb });
  return { ok: true, progress: { status: row.status, resume_block: row.resume_block } };
};

/* ================================ TRAINING MANAGER ================================ */
const TM = {};
/* The dealerships a Training Manager manages: each Training Manager membership's dealer and its direct branches. */
async function managedDealers(learner) {
  const tms = learner.memberships.filter(m => m.role === 'training_manager');
  if (!tms.length) A.refuse(403, 'forbidden', 'Only a Training Manager can do that.');
  const ids = new Set();
  for (const m of tms) for (const d of await A.family(m.dealer_id)) ids.add(String(d));
  return ids;
}
const inScope = (scope, dealerId) => { if (!scope.has(String(dealerId))) A.refuse(403, 'forbidden', 'That person is not in your dealership.'); };

TM.team = async (event, learner) => {
  const scope = await managedDealers(learner); const ids = [...scope];
  const [names, mems, invites] = await Promise.all([
    dealerNames(ids),
    A.sbGet(`academy_memberships?dealer_id=${idsIn(ids)}&select=id,learner_id,dealer_id,role,access_type,status,started_at,ended_at&order=started_at.asc`),
    A.sbGet(`academy_invites?dealer_id=${idsIn(ids)}&status=eq.pending&select=id,dealer_id,email,full_name,role,expires_at,created_at&order=created_at.desc`),
  ]);
  const people = await byIds('academy_learners', mems.map(m => m.learner_id), 'id,full_name,email,status');
  const memIds = mems.map(m => m.id);
  const enr = memIds.length ? await A.sbGet(`academy_enrollments?membership_id=${idsIn(memIds)}&select=id,learner_id,version_id,membership_id,status,due_on`) : [];
  const { vers, courses, mods, lessons } = await versionOutline(enr.map(e => e.version_id));
  const prog = enr.length ? await A.sbGet(`academy_progress?enrollment_id=${idsIn(enr.map(e => e.id))}&status=eq.completed&select=enrollment_id`) : [];
  // exam results for a Training Manager: passed or not and how many attempts — never a score (A2E plan)
  const atts = enr.length ? await A.sbGet(`academy_attempts?enrollment_id=${idsIn(enr.map(e => e.id))}&select=enrollment_id,passed,submitted_at`) : [];
  const examOf = id => { const a = atts.filter(x => String(x.enrollment_id) === String(id)), done = a.filter(x => x.submitted_at);
    return { attempts: done.length, passed: done.some(x => x.passed === true), last_at: done.map(x => x.submitted_at).sort().pop() || null }; };
  const lessonCount = vid => { const ms = mods.filter(m => String(m.version_id) === String(vid)).map(m => String(m.id)); return lessons.filter(l => ms.includes(String(l.module_id))).length; };
  const roster = mems.map(m => {
    const p = people.find(x => String(x.id) === String(m.learner_id)) || {};
    return { membership_id: m.id, learner_id: m.learner_id, name: p.full_name || '', email: p.email || '', dealer_id: m.dealer_id,
      dealer: names[String(m.dealer_id)] || 'Dealership', role: m.role, access_type: m.access_type, status: m.status, started_at: m.started_at, ended_at: m.ended_at,
      account: p.status || 'active', you: String(m.learner_id) === String(learner.learner_id),
      courses: enr.filter(e => String(e.membership_id) === String(m.id)).map(e => {
        const v = vers.find(x => String(x.id) === String(e.version_id)) || {}; const c = courses.find(x => String(x.id) === String(v.course_id)) || {};
        return { enrollment_id: e.id, course: c.title || 'Course', version: v.version, status: e.status, due_on: e.due_on,
          lessons_total: lessonCount(e.version_id), lessons_completed: prog.filter(x => String(x.enrollment_id) === String(e.id)).length, exam: examOf(e.id) };
      }) };
  });
  return { ok: true, dealers: ids.map(id => ({ id, name: names[id] || 'Dealership' })), roster,
    invites: invites.map(i => Object.assign({}, i, { dealer: names[String(i.dealer_id)] || 'Dealership' })) };
};
TM.courses = async () => {
  const vers = await A.sbGet(`academy_course_versions?status=eq.published&select=id,course_id,version`);
  const courses = await byIds('academy_courses', vers.map(v => v.course_id), 'id,title,slug,course_type');
  return { ok: true, courses: vers.map(v => { const c = courses.find(x => String(x.id) === String(v.course_id)) || {};
    return c.course_type === 'manufacturer_program' ? null : { version_id: v.id, title: c.title || 'Course', version: v.version, test: /^test-/.test(String(c.slug || '')) }; }).filter(Boolean) };
};
TM.invite = async (event, learner, b) => {
  if (!(await A.switchOn('academy_invites'))) A.refuse(403, 'flag_off', 'Invitations are not open yet.');
  const scope = await managedDealers(learner); const dealer = A.uuid(b.dealer_id, 'dealership'); inScope(scope, dealer);
  const name = b.full_name == null || b.full_name === '' ? null : A.text(b.full_name, 200, 'Name');
  const inv = await A.accessOp('access_op_invite', { p_actor: actorOf(learner), p_dealer_id: dealer, p_email: email(b.email), p_full_name: name, p_role: 'learner' });
  const names = await dealerNames([dealer]);
  const sent = await MAIL.send(inv.email, MAIL.inviteMessage({ dealerName: names[dealer] || 'your dealership', inviterName: learner.full_name }));
  return { ok: true, invite: inv, email_sent: sent.sent };
};
TM.revoke_invite = async (event, learner, b) => {
  await managedDealers(learner);
  return { ok: true, result: await A.accessOp('access_op_revoke_invite', { p_actor: actorOf(learner), p_invite_id: A.uuid(b.id, 'invitation'), p_reason: reason(b.reason) }) };
};
TM.deactivate = async (event, learner, b) => {
  await managedDealers(learner);
  return { ok: true, result: await A.accessOp('access_op_deactivate', { p_actor: actorOf(learner), p_membership_id: A.uuid(b.membership_id, 'membership'), p_reason: reason(b.reason) }) };
};
TM.reactivate = async (event, learner, b) => {
  const scope = await managedDealers(learner); const dealer = A.uuid(b.dealer_id, 'dealership'); inScope(scope, dealer);
  return { ok: true, result: await A.accessOp('access_op_reactivate', { p_actor: actorOf(learner), p_learner_id: A.uuid(b.learner_id, 'learner'), p_dealer_id: dealer }) };
};
TM.enroll = async (event, learner, b) => {
  await managedDealers(learner);
  const due = b.due_on == null || b.due_on === '' ? null : String(b.due_on);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) A.refuse(400, 'invalid', 'The due date is not valid.');
  return { ok: true, enrollment: await A.accessOp('enroll_op_enroll', { p_actor: actorOf(learner), p_learner_id: A.uuid(b.learner_id, 'learner'),
    p_version_id: A.uuid(b.version_id, 'course version'), p_due_on: due }) };
};
TM.withdraw = async (event, learner, b) => {
  await managedDealers(learner);
  return { ok: true, result: await A.accessOp('enroll_op_withdraw', { p_actor: actorOf(learner), p_enrollment_id: A.uuid(b.enrollment_id, 'enrollment'), p_reason: reason(b.reason) }) };
};

module.exports = { PUBLIC, LEARNER, TM, SENT, clientIp };
