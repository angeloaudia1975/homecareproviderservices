/* A stand-in for the A2C M2 database functions (supabase/academy_a2c_m2_content_ops.sql) inside the Phase 0 harness,
   so the Command Center's handler can be exercised end to end. It follows the SQL: the acting person must be an active
   HCPS administrator (the President for a course learners have seen), only the listed fields can be set, drafts only,
   positions and version numbers given by the database, and the change and its audit row are applied together or not
   at all. The SQL itself is proven against real Postgres by test/academy-m2.pg.test.js; this fake only lets the
   JavaScript tests see what the server sends and what a successful call leaves behind.
     contentOps(world, { missing: true })      → every call answers 404 PGRST202 (M2 not installed)
     contentOps(world, { auditFails: true })   → every call fails as the database would when the audit row is refused
   world.contentCalls lists every call: { name, args }. */
const { randomUUID } = require('crypto');
const BASE_PREFIX = '/rest/v1/rpc/academy_content_op_';

function contentOps(w, opts) {
  const o = opts || {}; const base = w.fetch; w.contentCalls = [];
  const db = w.db;
  const err = (status, code, message) => ({ status, body: { code, message: 'academy: ' + message } });
  class Refusal extends Error { constructor(r) { super(r.body.message); this.r = r; } }
  const no = (status, code, message) => { throw new Refusal(err(status, code, message)); };
  const t = name => (db[name] = db[name] || []);
  const actorStaff = a => {
    if (typeof a !== 'string' || !/^staff:[^\s@]+@[^\s@]+$/.test(a)) no(403, '42501', 'the acting person must be named as staff:<email>');
    const email = a.slice(6).toLowerCase();
    const s = t('staff_users').find(x => String(x.email).toLowerCase() === email && x.active !== false && ['president', 'admin', 'owner'].includes(String(x.role || '').toLowerCase()));
    if (!s) no(403, '42501', email + ' is not an active HCPS administrator');
    return s;
  };
  const keys = (p, allowed) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) no(400, '22023', 'the change must be an object');
    for (const k of Object.keys(p)) if (!allowed.includes(k)) no(400, '22023', k + ' cannot be set here');
  };
  const lockDraft = id => {
    const v = t('academy_course_versions').find(x => x.id === id);
    if (!v) no(404, 'P0002', 'course version not found');
    if (v.status === 'in_review') no(409, '55000', 'this version is in review; return it to draft before editing');
    if (v.status !== 'draft') no(409, '55000', 'this version is ' + v.status + ' and can no longer change; create a new version instead');
    return v;
  };
  const intIn = (x, lo, hi, what) => {
    const n = typeof x === 'number' ? x : (typeof x === 'string' && /^-?\d+$/.test(x.trim()) ? Number(x) : NaN);
    if (!Number.isInteger(n)) no(400, '22023', what + ' must be a whole number');
    if (n < lo || n > hi) no(400, '22023', what + ' out of range');
    return n;
  };
  const objectives = v => {
    const list = v == null ? [] : v;
    if (!Array.isArray(list) || list.length > 12 || list.some(e => typeof e !== 'string' || !e.trim() || e.trim().length > 300))
      no(400, '22023', 'objectives are up to 12 lines of up to 300 characters');
    return list;
  };
  const title = (v, max, what) => { const s = String(v == null ? '' : v).trim(); if (!s || s.length > max) no(400, '22023', what + ' is required'); return s; };
  const nextPos = (rows, key, id) => rows.filter(r => r[key] === id).reduce((m, r) => Math.max(m, Number(r.position) || 0), 0) + 1;
  const clone = x => JSON.parse(JSON.stringify(x));

  const OPS = {
    create_course(a, audit, apply) {
      actorStaff(a.p_actor); const p = a.p_course; keys(p, ['slug', 'title', 'course_type', 'manufacturer_slug', 'category', 'external_url']);
      const slug = String(p.slug || '').trim().toLowerCase();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 3 || slug.length > 80) no(400, '22023', 'the short name is not valid');
      const ttl = title(p.title, 200, 'the title');
      if (!['hcps_certification', 'manufacturer_program', 'training'].includes(p.course_type)) no(400, '22023', 'the course type is not valid');
      const mfr = p.manufacturer_slug ? String(p.manufacturer_slug).trim() : null;
      if (mfr && !t('manufacturers').some(m => m.slug === mfr)) no(400, '22023', 'that manufacturer is not in the HCPS manufacturer list');
      const url = p.external_url ? String(p.external_url).trim() : null;
      if (p.course_type === 'manufacturer_program') {
        if (!mfr) no(400, '22023', 'a manufacturer program needs its manufacturer');
        if (!url || !/^https:\/\/[^/\s]+\.[^/\s]+/.test(url)) no(400, '22023', 'a manufacturer program needs an https:// training link');
      } else if (url) no(400, '22023', 'only a manufacturer program links to outside training');
      if (t('academy_courses').some(c => c.slug === slug)) no(409, '23505', 'duplicate key value violates unique constraint');
      const row = { id: a.p_id || randomUUID(), slug, manufacturer_slug: mfr, title: ttl, course_type: p.course_type,
                    issuer: { hcps_certification: 'hcps', manufacturer_program: 'manufacturer', training: 'none' }[p.course_type],
                    category: p.category ? String(p.category).trim() : null, external_url: url, status: 'draft', created_at: new Date().toISOString() };
      apply(() => t('academy_courses').push(row)); audit('academy_courses', row.id, 'create_course', null, row); return row;
    },
    update_course(a, audit, apply) {
      const s = actorStaff(a.p_actor); keys(a.p_changes, ['title', 'category', 'external_url']);
      if (!Object.keys(a.p_changes).length) no(400, '22023', 'nothing to change');
      const c = t('academy_courses').find(x => x.id === a.p_id); if (!c) no(404, 'P0002', 'course not found');
      const seen = c.status !== 'draft' || t('academy_course_versions').some(v => v.course_id === c.id && ['published', 'retired'].includes(v.status));
      if (seen && String(s.role).toLowerCase() !== 'president') no(403, '42501', 'only the President may change a course learners have seen');
      const next = Object.assign({}, c);
      if ('title' in a.p_changes) next.title = title(a.p_changes.title, 200, 'the title');
      if ('category' in a.p_changes) next.category = a.p_changes.category ? String(a.p_changes.category).trim() : null;
      if ('external_url' in a.p_changes) {
        if (c.course_type !== 'manufacturer_program') no(400, '22023', 'only a manufacturer program links to outside training');
        if (!/^https:\/\/[^/\s]+\.[^/\s]+/.test(String(a.p_changes.external_url || ''))) no(400, '22023', 'a manufacturer program needs an https:// training link');
        next.external_url = String(a.p_changes.external_url).trim();
      }
      const before = clone(c); apply(() => Object.assign(c, next)); audit('academy_courses', c.id, 'update_course', before, next); return next;
    },
    create_version(a, audit, apply) {
      actorStaff(a.p_actor); const p = a.p_settings == null ? {} : a.p_settings; keys(p, ['pass_mark', 'exam_questions', 'validity_months']);
      const c = t('academy_courses').find(x => x.id === a.p_course_id); if (!c) no(404, 'P0002', 'course not found');
      if (c.course_type === 'manufacturer_program') no(400, '22023', 'a manufacturer program has no HCPS versions');
      if (c.status === 'retired') no(409, '55000', 'this course is retired');
      const row = { id: a.p_id || randomUUID(), course_id: c.id,
                    version: t('academy_course_versions').filter(v => v.course_id === c.id).reduce((m, v) => Math.max(m, Number(v.version)), 0) + 1,
                    status: 'draft', pass_mark: p.pass_mark == null ? 80 : intIn(p.pass_mark, 1, 100, 'the pass mark'),
                    exam_questions: p.exam_questions == null ? 25 : intIn(p.exam_questions, 1, 200, 'exam questions'),
                    validity_months: p.validity_months == null ? null : intIn(p.validity_months, 1, 120, 'validity'),
                    retake_policy: { unlimited: true }, published_at: null, published_by: null, created_at: new Date().toISOString() };
      apply(() => t('academy_course_versions').push(row)); audit('academy_course_versions', row.id, 'create_version', null, row); return row;
    },
    update_version(a, audit, apply) {
      actorStaff(a.p_actor); keys(a.p_changes, ['pass_mark', 'exam_questions', 'validity_months']);
      if (!Object.keys(a.p_changes).length) no(400, '22023', 'nothing to change');
      const v = lockDraft(a.p_id); const next = Object.assign({}, v); const p = a.p_changes;
      if ('pass_mark' in p) next.pass_mark = intIn(p.pass_mark, 1, 100, 'the pass mark');
      if ('exam_questions' in p) next.exam_questions = intIn(p.exam_questions, 1, 200, 'exam questions');
      if ('validity_months' in p) next.validity_months = p.validity_months == null ? null : intIn(p.validity_months, 1, 120, 'validity');
      const before = clone(v); apply(() => Object.assign(v, next)); audit('academy_course_versions', v.id, 'update_version', before, next); return next;
    },
    move_version(a, audit, apply) {
      actorStaff(a.p_actor);
      if (!['in_review', 'draft'].includes(a.p_to)) no(400, '22023', 'a version can only move to review or back to draft');
      const from = a.p_to === 'in_review' ? 'draft' : 'in_review';
      const v = t('academy_course_versions').find(x => x.id === a.p_id); if (!v) no(404, 'P0002', 'course version not found');
      if (v.status !== from) no(409, '55000', 'this version is ' + v.status);
      const before = clone(v); const next = Object.assign({}, v, { status: a.p_to });
      apply(() => { v.status = a.p_to; });
      audit('academy_course_versions', v.id, a.p_to === 'in_review' ? 'submit_for_review' : 'return_to_draft', before, next); return next;
    },
    create_module(a, audit, apply) {
      actorStaff(a.p_actor); keys(a.p_module, ['title', 'objectives']); lockDraft(a.p_version_id);
      const row = { id: a.p_id || randomUUID(), version_id: a.p_version_id, position: nextPos(t('academy_modules'), 'version_id', a.p_version_id),
                    title: title(a.p_module.title, 200, 'the module title'), objectives: objectives(a.p_module.objectives) };
      apply(() => t('academy_modules').push(row)); audit('academy_modules', row.id, 'create_module', null, row); return row;
    },
    update_module(a, audit, apply) {
      actorStaff(a.p_actor); keys(a.p_changes, ['title', 'objectives']);
      if (!Object.keys(a.p_changes).length) no(400, '22023', 'nothing to change');
      const m = t('academy_modules').find(x => x.id === a.p_id); if (!m) no(404, 'P0002', 'module not found');
      lockDraft(m.version_id); const next = Object.assign({}, m);
      if ('title' in a.p_changes) next.title = title(a.p_changes.title, 200, 'the module title');
      if ('objectives' in a.p_changes) next.objectives = objectives(a.p_changes.objectives);
      const before = clone(m); apply(() => Object.assign(m, next)); audit('academy_modules', m.id, 'update_module', before, next); return next;
    },
    delete_module(a, audit, apply) {
      actorStaff(a.p_actor);
      const m = t('academy_modules').find(x => x.id === a.p_id); if (!m) no(404, 'P0002', 'module not found');
      lockDraft(m.version_id);
      if (t('academy_lessons').some(l => l.module_id === m.id)) no(409, '55000', 'remove this module\'s lessons first');
      if (t('academy_questions').some(q => q.module_id === m.id)) no(409, '55000', 'questions are linked to this module');
      const before = clone(m); apply(() => db.academy_modules.splice(db.academy_modules.indexOf(m), 1));
      audit('academy_modules', m.id, 'delete_module', before, null); return { deleted: m.id };
    },
    create_lesson(a, audit, apply) {
      actorStaff(a.p_actor); keys(a.p_lesson, ['title', 'est_minutes']);
      const m = t('academy_modules').find(x => x.id === a.p_module_id); if (!m) no(404, 'P0002', 'module not found');
      lockDraft(m.version_id);
      const row = { id: a.p_id || randomUUID(), module_id: m.id, position: nextPos(t('academy_lessons'), 'module_id', m.id),
                    title: title(a.p_lesson.title, 200, 'the lesson title'),
                    est_minutes: a.p_lesson.est_minutes == null ? 10 : intIn(a.p_lesson.est_minutes, 1, 30, 'minutes'), blocks: [] };
      apply(() => t('academy_lessons').push(row)); audit('academy_lessons', row.id, 'create_lesson', null, row); return row;
    },
    update_lesson(a, audit, apply) {
      actorStaff(a.p_actor); keys(a.p_changes, ['title', 'est_minutes']);
      if (!Object.keys(a.p_changes).length) no(400, '22023', 'nothing to change');
      const l = t('academy_lessons').find(x => x.id === a.p_id); if (!l) no(404, 'P0002', 'lesson not found');
      const m = t('academy_modules').find(x => x.id === l.module_id); lockDraft(m && m.version_id);
      const next = Object.assign({}, l);
      if ('title' in a.p_changes) next.title = title(a.p_changes.title, 200, 'the lesson title');
      if ('est_minutes' in a.p_changes) next.est_minutes = intIn(a.p_changes.est_minutes, 1, 30, 'minutes');
      const before = clone(l); apply(() => Object.assign(l, next)); audit('academy_lessons', l.id, 'update_lesson', before, next); return next;
    },
    delete_lesson(a, audit, apply) {
      actorStaff(a.p_actor);
      const l = t('academy_lessons').find(x => x.id === a.p_id); if (!l) no(404, 'P0002', 'lesson not found');
      const m = t('academy_modules').find(x => x.id === l.module_id); lockDraft(m && m.version_id);
      if (t('academy_content_refs').some(r => r.lesson_id === l.id)) no(409, '55000', 'product facts are linked to this lesson');
      const before = clone(l); apply(() => db.academy_lessons.splice(db.academy_lessons.indexOf(l), 1));
      audit('academy_lessons', l.id, 'delete_lesson', before, null); return { deleted: l.id };
    },
  };

  w.fetch = async (url, init) => {
    const u = String(url); const at = u.indexOf(BASE_PREFIX);
    if (at < 0) return base(url, init);
    const name = u.slice(at + BASE_PREFIX.length).split('?')[0];
    const args = init && init.body ? JSON.parse(init.body) : {};
    w.contentCalls.push({ name, args: clone(args) });
    const reply = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
    if (o.missing || !OPS[name]) return reply(404, { code: 'PGRST202', message: 'Could not find the function public.academy_content_op_' + name });
    // One transaction: collect the change and its audit row; apply both only if nothing failed.
    const changes = [], audits = [];
    const audit = (entity, entity_id, action, before, after) => audits.push({ actor_type: 'staff', actor: args.p_actor, entity, entity_id: String(entity_id), action,
                                                                             before: before && clone(before), after: after && clone(after), at: new Date().toISOString() });
    const apply = fn => changes.push(fn);
    try {
      const out = OPS[name](args, audit, apply);
      if (o.auditFails) return reply(400, { code: 'P0001', message: 'audit store unavailable (test)' });   // the whole call fails: nothing applied
      for (const fn of changes) fn();
      for (const e of audits) t('academy_events').push(e);
      w.writes.push({ kind: 'content_op', fn: 'academy_content_op_' + name, actor: args.p_actor });
      return reply(200, clone(out));
    } catch (e) {
      if (e instanceof Refusal) return reply(e.r.status, e.r.body);
      throw e;
    }
  };
  return w;
}
module.exports = { contentOps };
