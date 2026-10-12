/* HCPS Academy — A2D Stage 3: the Course Builder (server side). Registered into academy-admin-api.js, so every action
   here is behind the same gate as the rest of the Command Center: the Connect 360 sign-in, an ACTIVE president / admin /
   owner, and academy_admin exactly true. Nothing here is reachable by a learner.

   Every write goes through the audited database operations (one transaction with its audit row, or nothing):
     modules and lessons  -> M2  academy_content_op_*   (already used by the Command Center)
     blocks, order, exam distribution, questions, media records, fact links -> M3  academy_author_op_*
   The database repeats every rule (draft only, block checks, President-only stored photos, practice-only checks), so
   the checks here exist for clear messages, never as the only line of defence. The acting person is ALWAYS the signed-in
   staff member (A.actorLabel); any actor field in a request is ignored.

   Answer keys: the question-bank editor is the one staff screen that shows them (A2D plan: "Answer keys appear only in this
   staff editor"). Lesson previews never carry them (_academy_lesson.js). Audit rows never hold them (M3).

   Pictures under Angelo's control: any administrator may UPLOAD a candidate file into the private bucket; it is not usable
   in a lesson until the PRESIDENT approves it (creates its media record with alt text, rights and the permission). The
   database enforces that a stored picture or manufacturer file is recorded by the President only (M3 check_media). Only
   the President may discard a candidate, and only one no media record names. No file is ever fetched from outside. */
const crypto = require('crypto');
const A = require('./_academy.js');
const LESSON = require('./_academy_lesson.js');
const enc = encodeURIComponent;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]+$/;
const MAX_UPLOAD = 3 * 1024 * 1024;   // the file travels through the function as base64 (Netlify limits a request to 6 MB),
                                      // so 3 MB rather than the plan's 5 MB; a lesson picture at 1600 px is about 300 KB
const UPLOAD_BODY = Math.ceil(MAX_UPLOAD * 4 / 3) + 16 * 1024;   // the one request allowed above the usual 256 KB
const TYPES = {
  jpg: { mime: 'image/jpeg', kind: 'image', magic: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', kind: 'image', magic: b => b.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  webp: { mime: 'image/webp', kind: 'image', magic: b => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  pdf: { mime: 'application/pdf', kind: 'pdf', magic: b => b.slice(0, 5).toString('latin1') === '%PDF-' },
};
const isPresident = s => !!s && s.kind === 'staff' && s.role === 'president';
const one = rows => rows[0] || null;
const need = (row, what) => { if (!row) A.refuse(404, 'not_found', `${what || 'Record'} not found.`); return row; };
const idsIn = ids => `in.(${[...new Set(ids.map(String))].map(enc).join(',')})`;
const actor = staff => A.actorLabel(staff);

/* A stable fingerprint of a lesson's blocks (key order does not matter), so two people editing the same lesson never
   silently overwrite each other: a save names the version it started from. */
function canon(v) { return Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v); }
const blocksHash = blocks => crypto.createHash('sha256').update(canon(Array.isArray(blocks) ? blocks : [])).digest('hex').slice(0, 32);

async function all(path, order) {
  const out = []; const sep = path.includes('?') ? '&' : '?';
  for (let p = 0; p < 20; p++) { const rows = await A.sbGet(`${path}${sep}order=${order || 'id.asc'}&limit=1000&offset=${p * 1000}`); out.push(...rows); if (rows.length < 1000) return out; }
  A.refuse(503, 'too_large', 'There is more data than this screen can show at once.');
}
async function byIds(table, ids, select) {
  const list = [...new Set((ids || []).filter(x => UUID.test(String(x))).map(String))]; if (!list.length) return [];
  const out = []; for (let i = 0; i < list.length; i += 150) out.push(...await A.sbGet(`${table}?id=${idsIn(list.slice(i, i + 150))}&select=${select}`)); return out;
}
const VERSION_COLS = 'id,course_id,version,status,pass_mark,exam_questions,validity_months';
async function versionOf(id) { return need(one(await A.sbGet(`academy_course_versions?id=eq.${enc(id)}&select=${VERSION_COLS}`)), 'Course version'); }
async function draft(id) {
  const v = await versionOf(id);
  if (v.status !== 'draft') A.refuse(409, 'locked', v.status === 'in_review' ? 'This version is in review. Return it to draft before editing.' : `This version is ${v.status} and can no longer change. Create a new version instead.`);
  return v;
}
async function lessonCtx(lessonId) {
  const l = need(one(await A.sbGet(`academy_lessons?id=eq.${enc(lessonId)}&select=id,module_id,position,title,est_minutes,blocks`)), 'Lesson');
  const m = need(one(await A.sbGet(`academy_modules?id=eq.${enc(l.module_id)}&select=id,version_id,position,title`)), 'Module');
  return { l, m };
}
const MEDIA_COLS = 'id,kind,storage_path,external_url,rights,manufacturer_slug,permission_ref,alt_text,created_at';
async function signed(media) { for (const m of media) m.signed_url = m.storage_path ? await A.signPrivate(m.storage_path, 900) : null; return media; }

/* ---------------------------------------------------------------------------------------------------------------
   READINESS — what still stands between this draft and a publishable course. Pure: given the version's rows, it lists
   every warning; "blocking" ones (missing pictures, unverified or missing facts, too few exam questions, a distribution
   that does not add up …) must be fixed before publishing; "advice" ones (lesson length, scenario share) are reminders.
   M1 and M3 refuse a publish that breaks the hard rules anyway; this check says so BEFORE anyone presses Publish.
   --------------------------------------------------------------------------------------------------------------- */
const WPM = 200, INTERACTIVE = { explorer: 1, scenario: 1.5, comparison: 1.5, video: 2, document: 1, check: 0, fact: 0.25, image: 0.25 };
function words(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }
function estimateMinutes(blocks) {
  let w = 0, extra = 0;
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    for (const k of ['body', 'heading', 'text', 'prompt', 'caption', 'title']) if (typeof b[k] === 'string') w += words(b[k]);
    for (const it of b.items || []) w += typeof it === 'string' ? words(it) : words(it && it.title) + words(it && it.body);
    for (const c of b.choices || []) w += words(c && c.text) + words(c && c.feedback);
    extra += INTERACTIVE[b.kind] || 0;
    if (b.kind === 'check') extra += 0.75 * (b.question_ids || []).length;
  }
  return Math.max(1, Math.round(w / WPM + extra));
}
function readiness(input) {
  const { version, modules, lessons, questions, refs, facts, media } = input;
  const out = [];
  const add = (level, where, message, link) => out.push(Object.assign({ level, where, message }, link || {}));
  const factKey = (mfr, model, field) => `${mfr}|${String(model || '').toUpperCase()}|${field}`;
  const cur = {}; for (const f of facts || []) if (!f.valid_to) cur[factKey(f.manufacturer_slug, f.model_code, f.field)] = f;
  const mediaById = {}; for (const m of media || []) mediaById[String(m.id)] = m;
  const qById = {}; for (const q of questions || []) qById[String(q.id)] = q;
  const mods = (modules || []).slice().sort((a, b) => a.position - b.position);
  if (!mods.length) add('blocking', 'Course', 'This version has no modules yet.');
  for (const m of mods) {
    const ls = (lessons || []).filter(l => String(l.module_id) === String(m.id)).sort((a, b) => a.position - b.position);
    if (!ls.length) add('blocking', `Module ${m.position}`, 'This module has no lessons yet.', { module_id: m.id });
    for (const l of ls) {
      const where = `Lesson ${m.position}.${l.position} ${l.title}`, link = { lesson_id: l.id };
      const blocks = Array.isArray(l.blocks) ? l.blocks : [];
      if (!blocks.length) { add('blocking', where, 'This lesson has no content yet.', link); continue; }
      if (blocks[0].kind !== 'objectives') add('blocking', where, 'A lesson starts with its objectives.', link);
      if (!blocks.some(b => b.kind === 'takeaways')) add('blocking', where, 'Add the key takeaways at the end.', link);
      blocks.forEach((b, i) => {
        const at = `${where}, screen ${i + 1}`;
        if (b.kind === 'image' && !b.media_id) add('blocking', at, `Picture still missing: "${b.placeholder}". Add the approved file.`, link);
        if (b.kind === 'image' && b.media_id && !mediaById[String(b.media_id)]) add('blocking', at, 'The picture record this screen uses is gone.', link);
        if (b.kind === 'video' && !b.media_id) add('blocking', at, `Video still missing: "${b.placeholder}".`, link);
        if (b.kind === 'document' && !b.media_id) add('blocking', at, `Document still missing: "${b.placeholder}".`, link);
        if (b.kind === 'explorer' && b.style === 'hotspots' && !b.media_id) add('blocking', at, 'This hotspot explorer has no picture.', link);
        const factsOf = b.kind === 'fact' ? [[b.model_code, b.field, b.label]] : b.kind === 'comparison' ? [].concat(...(b.models || []).map(mc => (b.fields || []).map(f => [mc, f.field, f.label]))) : [];
        for (const [mc, field, label] of factsOf) {
          const f = cur[factKey(b.manufacturer_slug, mc, field)];
          if (!f) add('blocking', at, `No product fact recorded for ${String(mc).toUpperCase()} · ${label || field}. Record it in Product Facts.`, link);
          else if (f.status !== 'verified') add('blocking', at, `${String(mc).toUpperCase()} · ${label || field} is awaiting manufacturer confirmation.`, link);
        }
        if (b.kind === 'check') for (const qid of b.question_ids || []) {
          const q = qById[String(qid)];
          if (!q) add('blocking', at, 'A knowledge-check question is missing.', link);
          else if (q.use !== 'practice' || q.status !== 'active') add('blocking', at, 'A knowledge-check question is not an active practice question.', link);
        }
      });
      if (!blocks.some(b => b.kind === 'scenario')) add('advice', where, 'No customer scenario yet (most lessons have one).', link);
      if (!blocks.some(b => b.kind === 'check')) add('advice', where, 'No knowledge check yet.', link);
      const est = estimateMinutes(blocks);
      const welcome = m.position === 1 && l.position === 1;
      if (!welcome && (est < 10 || est > 15)) add('advice', where, `Estimated ${est} minutes; lessons run 10–15 minutes.`, link);
      if (Math.abs(est - (l.est_minutes || 0)) > 3) add('advice', where, `The lesson says about ${l.est_minutes} minutes; the content reads as about ${est}.`, link);
    }
  }
  // the exam bank
  const exam = (questions || []).filter(q => q.use === 'exam' && q.status === 'active');
  const qRefs = {}; for (const r of refs || []) if (r.question_id) (qRefs[String(r.question_id)] = qRefs[String(r.question_id)] || []).push(r);
  const eligible = q => (qRefs[String(q.id)] || []).every(r => { const f = cur[factKey(r.manufacturer_slug, r.model_code, r.field)]; return f && f.status === 'verified'; });
  for (const q of exam) if (!eligible(q)) add('blocking', 'Question bank', `"${String(q.prompt).slice(0, 60)}…" relies on a product fact that is missing or not verified; it will not be drawn.`, { question_id: q.id });
  for (const q of exam) if (!q.module_id) add('blocking', 'Question bank', `"${String(q.prompt).slice(0, 60)}…" is not assigned to a module.`, { question_id: q.id });
  const usable = exam.filter(q => eligible(q) && q.module_id);
  const need = (version && version.exam_questions) || 0;
  if (usable.length < need) add('blocking', 'Question bank', `${usable.length} usable exam questions; each attempt draws ${need}.`);
  if (usable.length < 60) add('advice', 'Question bank', `The approved target is about 60 exam questions (${usable.length} so far).`);
  const scen = usable.filter(q => q.kind === 'scenario').length;   // the approved target is about half; a reminder below 40 %
  if (usable.length && scen < Math.round(usable.length * 0.4)) add('advice', 'Question bank', `${scen} of ${usable.length} exam questions are customer scenarios; the target is about half.`);
  const quotaSet = mods.some(m => m.exam_quota != null);
  const per = {}; for (const q of usable) per[String(q.module_id)] = (per[String(q.module_id)] || 0) + 1;
  if (quotaSet) {
    const sum = mods.reduce((a, m) => a + (m.exam_quota || 0), 0);
    if (mods.some(m => m.exam_quota == null)) add('blocking', 'Exam distribution', 'Every module needs a number of questions (or switch back to automatic).');
    if (sum !== need) add('blocking', 'Exam distribution', `The module numbers add up to ${sum}; each attempt draws ${need}.`);
    for (const m of mods) if (m.exam_quota != null && (per[String(m.id)] || 0) < m.exam_quota) add('blocking', 'Exam distribution', `Module ${m.position} gives ${m.exam_quota} questions but has ${per[String(m.id)] || 0} usable.`, { module_id: m.id });
  } else {
    for (const m of mods) if (!per[String(m.id)]) add('blocking', 'Exam distribution', `Module ${m.position} has no usable exam question (every module is represented in each attempt).`, { module_id: m.id });
    if (mods.length > need && need) add('blocking', 'Exam distribution', `There are ${mods.length} modules but only ${need} questions per attempt; every module needs at least one.`);
  }
  const counts = { blocking: out.filter(x => x.level === 'blocking').length, advice: out.filter(x => x.level === 'advice').length };
  return { ready: counts.blocking === 0, counts, items: out, bank: { exam_active: exam.length, usable: usable.length, scenarios: scen, per_module: per, needed: need, mode: quotaSet ? 'set' : 'automatic' } };
}

/* ---------------------------------------------------------------------------------------------------------------
   ACTIONS
   --------------------------------------------------------------------------------------------------------------- */
const READ = {}, WRITE = {};
const FACT_COLS = 'id,manufacturer_slug,model_code,field,value,unit,field_class,status,source_url,source_label,verified_on,note,valid_from,valid_to';
const Q_COLS = 'id,version_id,module_id,kind,use,status,prompt,choices,answer_key,explanation,objective_tags';
async function versionData(versionId) {
  const v = await versionOf(versionId);
  const [course, modules, questions, refs] = await Promise.all([
    A.sbGet(`academy_courses?id=eq.${enc(v.course_id)}&select=id,slug,title,course_type,issuer,manufacturer_slug`),
    all(`academy_modules?version_id=eq.${enc(v.id)}&select=id,version_id,position,title,objectives,exam_quota`, 'position.asc'),
    all(`academy_questions?version_id=eq.${enc(v.id)}&select=${Q_COLS}`),
    all(`academy_content_refs?version_id=eq.${enc(v.id)}&select=id,lesson_id,question_id,manufacturer_slug,model_code,field`),
  ]);
  const lessons = modules.length ? await all(`academy_lessons?module_id=${idsIn(modules.map(m => m.id))}&select=id,module_id,position,title,est_minutes,blocks`, 'position.asc') : [];
  const mediaIds = new Set(); for (const l of lessons) LESSON.references(l.blocks).media.forEach(x => mediaIds.add(x));
  const c = course[0] || {};
  const mfrs = [...new Set([c.manufacturer_slug].concat(refs.map(r => r.manufacturer_slug)).filter(x => SLUG.test(String(x || ''))))];
  const facts = mfrs.length ? await all(`product_facts?valid_to=is.null&manufacturer_slug=${idsIn(mfrs)}&select=${FACT_COLS}`) : [];
  const media = await byIds('academy_media', [...mediaIds], MEDIA_COLS);
  return { v, course: c, modules, lessons, questions, refs, facts, media };
}

/* Everything the builder screen needs for one version. The question bank comes WITH answer keys: this is the staff editor. */
READ.builder = async (staff, b) => {
  const d = await versionData(A.uuid(b.version_id, 'version'));
  const [library, mfrs] = await Promise.all([all(`academy_media?select=${MEDIA_COLS}`, 'created_at.desc'), all(`manufacturers?select=slug,name`, 'slug.asc')]);
  await signed(library.filter(m => m.kind === 'image'));
  return { ok: true, version: d.v, course: d.course, editable: d.v.status === 'draft' && isPresident(staff), president: isPresident(staff), president_only: true,
    modules: d.modules, lessons: d.lessons.map(l => Object.assign({}, l, { hash: blocksHash(l.blocks), est_content_minutes: estimateMinutes(l.blocks) })),
    questions: d.questions, refs: d.refs, facts: d.facts, media: library, manufacturers: mfrs,
    readiness: readiness({ version: d.v, modules: d.modules, lessons: d.lessons, questions: d.questions, refs: d.refs, facts: d.facts, media: library }) };
};
READ.readiness = async (staff, b) => {
  const d = await versionData(A.uuid(b.version_id, 'version'));
  return { ok: true, readiness: readiness({ version: d.v, modules: d.modules, lessons: d.lessons, questions: d.questions, refs: d.refs, facts: d.facts, media: d.media }) };
};
/* Live preview of UNSAVED blocks, drawn exactly as learners will see them. Saves nothing. Practice questions travel
   without keys (the payload builder strips them). */
READ.preview_blocks = async (staff, b) => {
  const { l, m } = await lessonCtx(A.uuid(b.lesson_id, 'lesson'));
  if (!Array.isArray(b.blocks) || b.blocks.length > 40) A.refuse(400, 'invalid', 'A lesson has at most 40 screens.');
  if (JSON.stringify(b.blocks).length > 65536) A.refuse(400, 'invalid', 'The lesson is too large (64 KB at most).');
  const d = await versionData(m.version_id);
  const refs = LESSON.references(b.blocks);
  const extraMedia = await byIds('academy_media', refs.media.filter(x => !d.media.some(y => String(y.id) === x)), MEDIA_COLS);
  const mfrs = [...new Set(refs.facts.map(f => f.mfr).filter(x => SLUG.test(String(x || ''))))].filter(x => !d.facts.some(f => f.manufacturer_slug === x));
  const extraFacts = mfrs.length ? await all(`product_facts?valid_to=is.null&manufacturer_slug=${idsIn(mfrs)}&select=${FACT_COLS}`) : [];
  const media = await signed(d.media.concat(extraMedia));
  const mods = d.modules.map(x => ({ position: x.position, title: x.title, lessons: d.lessons.filter(y => String(y.module_id) === String(x.id)) }));
  const mfrRows = await all(`manufacturers?select=slug,name`, 'slug.asc');
  return { ok: true, lesson: LESSON.buildLesson({ mode: 'preview', course: d.course, version: d.v, module: m, lesson: Object.assign({}, l, { blocks: b.blocks }),
    outline: mods, facts: d.facts.concat(extraFacts), media, questions: d.questions.map(q => ({ id: q.id, version_id: q.version_id, use: q.use, status: q.status, kind: q.kind, prompt: q.prompt, choices: q.choices })),
    manufacturers: Object.fromEntries(mfrRows.map(r => [r.slug, r.name || r.slug])) }) };
};

/* Saves a lesson's screens (Stage 3 review, Angelo 12 Oct 2026: "atomic save review").
   M3 offers no single operation that links facts AND saves blocks AND compares the starting point, and no new SQL is
   allowed without separate approval, so the save is a short sequence of audited operations, each one atomic with its
   own audit row, arranged so that no failure between them leaves a silent partial change:
     1. the save must start from the lesson's current content (409 "changed" otherwise);
     2. the facts the screens show are linked (M3 shows a fact only when it is linked) — each link audited;
     3. the starting point is checked AGAIN just before the blocks are written (narrows the window to one round trip);
     4. the blocks are written through academy_author_op_set_blocks (the database's own block checker);
     5. that operation's audit row records the content it REPLACED: if that is not the content this save started
        from, someone saved in between — their version is put back (audited) and the answer is 409, never a silent
        overwrite;
     6. fact links the saved screens no longer use are removed (audited), so leftovers from an interrupted save never
        accumulate: links always end up matching the screens.
   If the blocks are refused, the links made in step 2 are undone (audited). If an undo itself fails, the answer says
   so (links_left) — and step 6 of the next successful save removes them. The truly atomic version (one database
   operation with a compare-and-set on the starting point) is proposed as M3.1 in the runbook, for separate approval. */
const linkKey = (mfr, model, field) => [mfr, String(model || '').toUpperCase(), field].join('|');
function wantedLinks(blocks) {
  const want = new Set();
  for (const blk of Array.isArray(blocks) ? blocks : []) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.kind === 'fact') want.add(linkKey(blk.manufacturer_slug, blk.model_code, blk.field));
    if (blk.kind === 'comparison') for (const mc of blk.models || []) for (const f of blk.fields || []) want.add(linkKey(blk.manufacturer_slug, mc, f && f.field));
  }
  return want;
}
const currentLesson = async id => need(one(await A.sbGet(`academy_lessons?id=eq.${enc(id)}&select=id,blocks`)), 'Lesson');
const lessonLinks = async id => A.sbGet(`academy_content_refs?lesson_id=eq.${enc(id)}&select=id,manufacturer_slug,model_code,field`);
const lastEventId = async id => { const r = await A.sbGet(`academy_events?entity=eq.academy_lessons&entity_id=eq.${enc(id)}&select=id&order=id.desc&limit=1`); return r[0] ? Number(r[0].id) : 0; };
const CHANGED = 'This lesson was changed since you opened it. Reload it to see the latest version, then make your change again.';
async function undoLinks(staff, ids) {
  const left = [];
  for (const id of ids.slice().reverse()) { try { await A.authorOp('unlink_fact', { p_actor: actor(staff), p_id: id }); } catch (_) { left.push(id); console.error('academy builder: a fact link could not be undone', id); } }
  return left;
}
WRITE.save_blocks = async (staff, b) => {
  const { l, m } = await lessonCtx(A.uuid(b.lesson_id, 'lesson'));
  await draft(m.version_id);
  if (!Array.isArray(b.blocks)) A.refuse(400, 'invalid', 'The lesson content could not be read.');
  if (typeof b.base_hash !== 'string' || b.base_hash !== blocksHash(l.blocks)) A.refuse(409, 'changed', CHANGED);
  const want = wantedLinks(b.blocks);
  const have = new Set((await lessonLinks(l.id)).map(r => linkKey(r.manufacturer_slug, r.model_code, r.field)));
  const made = [];
  let saved, mark;
  try {
    for (const k of want) {
      if (have.has(k)) continue;
      const [mfr, model, field] = k.split('|');
      if (!SLUG.test(mfr || '') || !/^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(model || '') || !/^[a-z0-9_.]{1,60}$/.test(field || '')) continue;   // the block checker reports it
      const link = await A.authorOp('link_fact', { p_actor: actor(staff), p_id: null, p_link: { lesson_id: l.id, manufacturer_slug: mfr, model_code: model, field } });
      if (link && link.id) made.push(link.id);
    }
    mark = await lastEventId(l.id);
    if (blocksHash((await currentLesson(l.id)).blocks) !== b.base_hash) A.refuse(409, 'changed', CHANGED);
    saved = await A.authorOp('set_blocks', { p_actor: actor(staff), p_lesson_id: l.id, p_blocks: b.blocks });
  } catch (e) {
    // Did the blocks change anyway (the response was lost after the database saved them, or someone else saved)?
    // Then the links may be in use: leave them (the next save tidies), and tell the person to reload.
    let now = null; try { now = blocksHash((await currentLesson(l.id)).blocks); } catch (_) { /* unreadable: undo what we can */ }
    if (now !== null && now !== b.base_hash) {
      if (e instanceof A.AcademyError && e.code === 'changed') { const left = await undoLinks(staff, made); A.refuse(409, 'changed', CHANGED + (left.length ? ' (Some fact links from this attempt are tidied up at the next save.)' : '')); }
      A.refuse(409, 'reload', 'The lesson changed while it was being saved. Reload it to see the version that was kept before changing anything else.');
    }
    const left = await undoLinks(staff, made);
    if (left.length) e.message = e.message + ` (${left.length} fact link${left.length > 1 ? 's' : ''} made for this attempt could not be removed yet; the next save removes ${left.length > 1 ? 'them' : 'it'}.)`;
    throw e;
  }
  // 5. Did this save replace exactly the content it started from? The database recorded what it replaced.
  const evs = await A.sbGet(`academy_events?entity=eq.academy_lessons&entity_id=eq.${enc(l.id)}&action=eq.set_blocks&id=gt.${mark}&select=id,actor,before,after&order=id.asc&limit=50`);
  const mine = evs.find(e => e.actor === actor(staff) && canon(e.after) === canon(saved));
  if (!mine) console.error('academy builder: the saved lesson could not be matched to its audit row', l.id);
  else if (blocksHash(mine.before && mine.before.blocks) !== b.base_hash) {
    // Someone saved between the check and this save. Put their version back — only if nothing changed since.
    const theirs = mine.before.blocks;
    let restored = false;
    if (blocksHash((await currentLesson(l.id)).blocks) === blocksHash(saved.blocks)) {
      await A.authorOp('set_blocks', { p_actor: actor(staff), p_lesson_id: l.id, p_blocks: theirs });
      restored = true;
    }
    A.refuse(409, 'changed', restored
      ? 'Someone else saved this lesson at the same moment. Their version was kept and yours was not applied. Reload the lesson, then make your change again.'
      : 'Several people saved this lesson at the same moment. Reload it and check the content before changing anything else.');
  }
  // 6. Links no longer used by the saved screens (an earlier interrupted save, or a removed fact) are removed.
  const used = wantedLinks(saved.blocks);
  let pruned = 0;
  for (const r of await lessonLinks(l.id)) {
    if (used.has(linkKey(r.manufacturer_slug, r.model_code, r.field))) continue;
    try { await A.authorOp('unlink_fact', { p_actor: actor(staff), p_id: r.id }); pruned++; } catch (_) { /* in use by a newer save: kept */ }
  }
  return { ok: true, audited: true, lesson: { id: saved.id, blocks: saved.blocks, hash: blocksHash(saved.blocks) }, facts_linked: made.length, links_removed: pruned };
};
const uuidList = (v, name) => { if (!Array.isArray(v) || !v.length || v.length > 200) A.refuse(400, 'invalid', `${name} is not valid.`); return v.map(x => A.uuid(x, name)); };
WRITE.reorder_modules = async (staff, b) => {
  const v = await draft(A.uuid(b.version_id, 'version'));
  return { ok: true, audited: true, order: await A.authorOp('reorder_modules', { p_actor: actor(staff), p_version_id: v.id, p_order: uuidList(b.order, 'Module order') }) };
};
WRITE.reorder_lessons = async (staff, b) => {
  const mo = need(one(await A.sbGet(`academy_modules?id=eq.${enc(A.uuid(b.module_id, 'module'))}&select=id,version_id`)), 'Module');
  await draft(mo.version_id);
  return { ok: true, audited: true, order: await A.authorOp('reorder_lessons', { p_actor: actor(staff), p_module_id: mo.id, p_order: uuidList(b.order, 'Lesson order') }) };
};
WRITE.set_distribution = async (staff, b) => {
  const v = await draft(A.uuid(b.version_id, 'version'));
  let q = null;
  if (b.quotas != null && !(typeof b.quotas === 'object' && !Array.isArray(b.quotas) && !Object.keys(b.quotas).length)) {
    if (typeof b.quotas !== 'object' || Array.isArray(b.quotas)) A.refuse(400, 'invalid', 'The distribution is a list of modules and numbers.');
    q = {}; for (const [k, n] of Object.entries(b.quotas)) { A.uuid(k, 'module'); if (!Number.isInteger(n) || n < 1 || n > 200) A.refuse(400, 'invalid', 'Every module gives 1–200 questions.'); q[k.toLowerCase()] = n; }
  }
  return { ok: true, audited: true, distribution: await A.authorOp('set_exam_distribution', { p_actor: actor(staff), p_version_id: v.id, p_quotas: q }) };
};

/* ---------- question bank ---------- */
const Q_KEYS = ['module_id', 'kind', 'use', 'prompt', 'choices', 'answer_key', 'explanation', 'objective_tags'];
function questionIn(src, partial) {
  const q = {};
  for (const k of Q_KEYS) if (Object.prototype.hasOwnProperty.call(src || {}, k)) q[k] = src[k];
  if (!partial) for (const k of ['kind', 'prompt', 'choices', 'answer_key', 'explanation', 'objective_tags']) if (!(k in q)) A.refuse(400, 'invalid', `The question needs its ${k.replace('_', ' ')}.`);
  if ('module_id' in q && q.module_id != null && q.module_id !== '') q.module_id = A.uuid(q.module_id, 'module'); else if ('module_id' in q) q.module_id = null;
  if ('use' in q) A.oneOf(q.use, ['exam', 'practice'], 'Use');
  if ('kind' in q) A.oneOf(q.kind, ['single', 'multi', 'scenario'], 'Kind');
  return q;
}
WRITE.create_question = async (staff, b) => {
  const v = await draft(A.uuid(b.version_id, 'version'));
  const q = await A.authorOp('create_question', { p_actor: actor(staff), p_id: crypto.randomUUID(), p_version_id: v.id, p_question: questionIn(b.question, false) });
  return { ok: true, audited: true, question: q };
};
WRITE.update_question = async (staff, b) => {
  const id = A.uuid(b.id, 'question');
  const row = need(one(await A.sbGet(`academy_questions?id=eq.${enc(id)}&select=id,version_id`)), 'Question'); await draft(row.version_id);
  const changes = questionIn(b.changes, true); if (!Object.keys(changes).length) A.refuse(400, 'invalid', 'Nothing to change.');
  return { ok: true, audited: true, question: await A.authorOp('update_question', { p_actor: actor(staff), p_id: id, p_changes: changes }) };
};
WRITE.question_status = async (staff, b) => {
  const id = A.uuid(b.id, 'question');
  const row = need(one(await A.sbGet(`academy_questions?id=eq.${enc(id)}&select=id,version_id`)), 'Question'); await draft(row.version_id);
  const status = A.oneOf(b.status, ['active', 'retired'], 'Status');
  const reason = status === 'retired' ? A.text(b.reason, 500, 'Reason') : (b.reason ? A.text(b.reason, 500, 'Reason') : null);
  return { ok: true, audited: true, question: await A.authorOp('set_question_status', { p_actor: actor(staff), p_id: id, p_status: status, p_reason: reason }) };
};
WRITE.link_question_fact = async (staff, b) => {
  const id = A.uuid(b.question_id, 'question');
  const row = need(one(await A.sbGet(`academy_questions?id=eq.${enc(id)}&select=id,version_id`)), 'Question'); await draft(row.version_id);
  const link = { question_id: id, manufacturer_slug: A.text(b.manufacturer_slug, 80, 'Manufacturer'), model_code: A.text(b.model_code, 40, 'Model').toUpperCase() };
  if (b.field) link.field = A.text(b.field, 60, 'Field');
  return { ok: true, audited: true, link: await A.authorOp('link_fact', { p_actor: actor(staff), p_id: null, p_link: link }) };
};
WRITE.unlink_fact = async (staff, b) => ({ ok: true, audited: true, result: await A.authorOp('unlink_fact', { p_actor: actor(staff), p_id: A.uuid(b.id, 'fact link') }) });

/* ---------- pictures, videos and documents ---------- */
/* Upload a CANDIDATE file (any administrator). It is stored privately under a server-chosen name that carries its own
   SHA-256, never overwrites anything, and is not usable in a lesson until the President approves it. */
WRITE.upload_media = async (staff, b) => {
  const name = A.text(b.file_name, 200, 'File name');
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(name) || [])[1]; const key = ext && ext.toLowerCase() === 'jpeg' ? 'jpg' : ext && ext.toLowerCase();
  const T = TYPES[key]; if (!T) A.refuse(400, 'invalid', 'Upload a JPEG, PNG or WebP picture, or a PDF.');
  if (typeof b.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b.data)) A.refuse(400, 'invalid', 'The file could not be read.');
  const bytes = Buffer.from(b.data, 'base64');
  if (!bytes.length) A.refuse(400, 'invalid', 'The file is empty.');
  if (bytes.length > MAX_UPLOAD) A.refuse(413, 'too_large', 'Files are limited to 3 MB here. Export a smaller version and try again.');
  if (!T.magic(bytes)) A.refuse(400, 'invalid', `That file is not really a ${key.toUpperCase()} (its contents do not match its name).`);
  const folder = b.manufacturer_slug ? A.text(b.manufacturer_slug, 60, 'Manufacturer') : 'hcps';
  if (!/^[a-z0-9-]{1,60}$/.test(folder)) A.refuse(400, 'invalid', 'Manufacturer is not valid.');
  if (folder !== 'hcps' && !one(await A.sbGet(`manufacturers?slug=eq.${enc(folder)}&select=slug`))) A.refuse(400, 'invalid', 'That manufacturer is not in the HCPS manufacturer list.');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const base = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  const path = `media/${folder}/${sha.slice(0, 16)}-${base}.${key}`;
  const res = await A.putPrivate(path, bytes, T.mime);
  const rec = one(await A.sbGet(`academy_media?storage_path=eq.${enc(path)}&select=${MEDIA_COLS}`));
  return { ok: true, storage_path: path, kind: T.kind, sha256: sha, size: bytes.length, already_stored: !!res.existed, record: rec,
    preview_url: await A.signPrivate(path, 600), approved: !!rec, note: rec ? 'This exact file is already approved.' : 'Stored privately. It cannot be used in a lesson until the President approves it.' };
};
/* Candidates waiting for the President, and every approved record. */
READ.media_library = async () => {
  const [records, folders] = await Promise.all([all(`academy_media?select=${MEDIA_COLS}`, 'created_at.desc'), A.listPrivate('media/')]);
  const named = new Set(records.map(r => r.storage_path).filter(Boolean)), files = [];
  for (const f of folders.filter(x => !x.id && /^[a-z0-9-]{1,60}$/.test(x.name))) for (const x of (await A.listPrivate(`media/${f.name}/`)).filter(y => y.id)) {
    const path = `media/${f.name}/${x.name}`; if (named.has(path) || !A.MEDIA_PATH.test(path)) continue;
    files.push({ storage_path: path, folder: f.name, size: x.metadata && x.metadata.size, created_at: x.created_at, kind: /\.pdf$/.test(path) ? 'pdf' : 'image' });
  }
  await signed(records.filter(m => m.kind === 'image'));
  for (const f of files) f.preview_url = await A.signPrivate(f.storage_path, 600);
  return { ok: true, records, candidates: files };
};
/* The President's approval of ONE stored file: alt text, rights and (for a manufacturer's file) the permission. */
WRITE.approve_media = async (staff, b) => {
  if (!isPresident(staff)) A.refuse(403, 'president_only', 'Only the President approves a stored picture or manufacturer file.');
  const path = A.text(b.storage_path, 200, 'File'); if (!A.MEDIA_PATH.test(path)) A.refuse(400, 'invalid', 'That file is not an Academy upload.');
  const kind = /\.pdf$/.test(path) ? 'pdf' : 'image';
  const rights = A.oneOf(b.rights, ['hcps_owned', 'manufacturer_permitted'], 'Rights');
  const media = { kind, storage_path: path, rights };
  if (kind === 'image') media.alt_text = b.decorative === true ? '' : A.text(b.alt_text, 300, 'Alt text');
  else media.alt_text = b.alt_text ? A.text(b.alt_text, 300, 'Document title') : '';
  if (rights === 'manufacturer_permitted') { media.manufacturer_slug = A.text(b.manufacturer_slug, 80, 'Manufacturer'); media.permission_ref = A.text(b.permission_ref, 300, 'Permission'); }
  return { ok: true, audited: true, media: await A.authorOp('create_media', { p_actor: actor(staff), p_id: crypto.randomUUID(), p_media: media }) };
};
/* A video (YouTube no-cookie / Vimeo) or a document link: never stored by HCPS, so any administrator may add it. */
WRITE.add_link_media = async (staff, b) => {
  const kind = A.oneOf(b.kind, ['video', 'link', 'pdf'], 'Kind');
  const media = { kind, external_url: A.text(b.url, 1000, 'Link'), rights: A.oneOf(b.rights || 'link_only', ['link_only', 'manufacturer_permitted'], 'Rights'), alt_text: A.text(b.title, 300, 'Title') };
  if (kind === 'video' && !LESSON.VIDEO.test(media.external_url)) A.refuse(400, 'invalid', 'Videos are youtube-nocookie.com/embed/… or player.vimeo.com/video/… links (use the embed link, not the watch page).');
  if (b.manufacturer_slug) media.manufacturer_slug = A.text(b.manufacturer_slug, 80, 'Manufacturer');
  if (media.rights === 'manufacturer_permitted') media.permission_ref = A.text(b.permission_ref, 300, 'Permission');
  return { ok: true, audited: true, media: await A.authorOp('create_media', { p_actor: actor(staff), p_id: crypto.randomUUID(), p_media: media }) };
};
WRITE.update_media = async (staff, b) => {
  const changes = {};
  for (const k of ['rights', 'manufacturer_slug', 'permission_ref', 'alt_text']) if (Object.prototype.hasOwnProperty.call(b, k)) changes[k] = b[k] == null ? null : String(b[k]).slice(0, 300);
  if (!Object.keys(changes).length) A.refuse(400, 'invalid', 'Nothing to change.');
  return { ok: true, audited: true, media: await A.authorOp('update_media', { p_actor: actor(staff), p_id: A.uuid(b.id, 'media'), p_changes: changes }) };
};
WRITE.delete_media = async (staff, b) => ({ ok: true, audited: true, result: await A.authorOp('delete_media', { p_actor: actor(staff), p_id: A.uuid(b.id, 'media') }) });
/* The President may discard a CANDIDATE: a stored upload that no media record names (an approved file is never removed). */
WRITE.discard_upload = async (staff, b) => {
  if (!isPresident(staff)) A.refuse(403, 'president_only', 'Only the President discards an uploaded file.');
  const path = A.text(b.storage_path, 200, 'File'); if (!A.MEDIA_PATH.test(path)) A.refuse(400, 'invalid', 'That file is not an Academy upload.');
  if (one(await A.sbGet(`academy_media?storage_path=eq.${enc(path)}&select=id`))) A.refuse(409, 'in_use', 'This file is approved; remove its media record first (only possible when no lesson uses it).');
  // the audit row is written FIRST: a file is never removed without its record of who removed it and why
  const reason = A.text(b.reason, 300, 'Reason');
  if (!(await A.audit(staff, 'academy_media', null, 'discard_upload', { storage_path: path }, { reason }))) A.refuse(502, 'audit_failed', 'The removal could not be recorded, so the file was kept.');
  await A.removePrivate(path);
  return { ok: true, audited: true, discarded: path };
};

/* Until M3.1 (one atomic save operation) is approved and installed, course content is edited by the President only
   (Angelo, 12 Oct 2026). academy-admin-api refuses these actions for every other administrator; reads stay open to them. */
const PRESIDENT_ONLY_EDITING = ['create_course', 'update_course', 'create_version', 'update_version', 'submit_for_review', 'return_to_draft',
  'create_module', 'update_module', 'delete_module', 'create_lesson', 'update_lesson', 'delete_lesson'].concat(Object.keys(WRITE));
module.exports = { PRESIDENT_ONLY_EDITING, READ, WRITE, readiness, estimateMinutes, blocksHash, canon, TYPES, MAX_UPLOAD, UPLOAD_BODY };
