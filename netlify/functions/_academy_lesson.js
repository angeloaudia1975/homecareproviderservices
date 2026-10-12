/* HCPS Academy — A2D Stage 2: the lesson PAYLOAD (server side). Pure functions, no database access.
   One shape for every place a lesson is shown: the staff preview in the Command Center today, and the learner player
   at /academy/ later (A2E) — both call buildLesson(), and both pages draw it with the same renderer
   (/assets/academy/lesson-player.js). There is never a second lesson implementation.

   Safety rules (CLAUDE.md rule 20, A2D plan "Security requirements"):
     - Every field of the payload is built here, field by field, from a known block kind. Nothing from the database is
       passed through as-is, so an unexpected column (an answer key, a learner's answer, a storage path) cannot leak.
     - Practice questions leave the server as { id, kind, prompt, choices[{id,text}] } only. The answer key and the
       explanation stay here; checkPractice() grades one answer at a time and returns the explanation only then.
     - A knowledge check may only show ACTIVE PRACTICE questions (the database enforces this too, M3). An exam question
       that somehow appears is never included: the block is shown as unavailable and a staff warning is raised.
     - Text stays text: the renderer never uses HTML. Links are https only; videos only youtube-nocookie.com/embed or
       player.vimeo.com/video (the same allow-list as M3 and the /academy/* Content Security Policy).
     - A missing picture, video, document or fact becomes a LABELLED placeholder, never a broken image. */

const KINDS = ['objectives', 'text', 'callout', 'quote', 'image', 'video', 'document', 'fact', 'comparison',
               'explorer', 'steps', 'scenario', 'check', 'takeaways'];
const VIDEO = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{6,20}|player\.vimeo\.com\/video\/[0-9]{3,12})(\?[A-Za-z0-9=&_.-]*)?$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{2,5})?(\/[^\s<>"]*)?$/;
const TONES = ['tip', 'caution', 'ask_manufacturer'];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 4000) : '');
const list = v => (Array.isArray(v) ? v : []);
const httpsOrNull = v => (typeof v === 'string' && HTTPS.test(v.trim()) ? v.trim() : null);
const key = (mfr, model, field) => `${mfr}|${String(model || '').toUpperCase()}|${field}`;

/* A fact value as one line of text. Never invents a value: anything it cannot show becomes "see source". */
function factText(row) {
  if (!row) return null;
  const v = row.value, unit = str(row.unit, 20);
  if (v === null || v === undefined) return null;
  let t;
  if (typeof v === 'string') t = v.trim();
  else if (typeof v === 'number') t = String(v);
  else if (typeof v === 'boolean') t = v ? 'Yes' : 'No';
  else if (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number')) t = v.join(', ');
  else t = 'See source';
  if (unit && (typeof v === 'number' || (typeof v === 'string' && /^[0-9.]+$/.test(v.trim())))) t += ' ' + unit;
  return t.slice(0, 300);
}
function factOut(row, mfrName) {
  if (!row) return null;
  return {
    text: factText(row),
    status: row.status === 'verified' ? 'verified' : 'awaiting',
    source_label: str(row.source_label, 200),
    source_url: httpsOrNull(row.source_url),
    verified_on: /^\d{4}-\d{2}-\d{2}$/.test(String(row.verified_on || '')) ? String(row.verified_on) : null,
    note: row.status === 'verified' ? null : (str(row.note, 300) || null),
    manufacturer: mfrName || null,
  };
}

/* The answer a learner gives, in the form the answer key is stored (M1 academy_op_norm_answer): one choice id, or a
   sorted list of distinct choice ids for a multi-answer question. */
function normAnswer(kind, a) {
  if (kind === 'multi') {
    if (!Array.isArray(a) || !a.length || a.length > 6 || a.some(x => typeof x !== 'string' || !/^[a-f]$/.test(x))) return null;
    return [...new Set(a)].sort();
  }
  return typeof a === 'string' && /^[a-f]$/.test(a) ? a : null;
}
/* Grades ONE practice answer. Exam questions are never graded or explained here (refused by the caller first; this
   repeats it). Returns { correct, explanation }; the answer key itself is never returned. */
function checkPractice(q, answer) {
  if (!q || q.use !== 'practice' || q.status !== 'active') return null;
  const given = normAnswer(q.kind, answer);
  if (given === null) return { invalid: true };
  const keyv = q.kind === 'multi' ? [...new Set(list(q.answer_key))].sort() : q.answer_key;
  const correct = JSON.stringify(given) === JSON.stringify(keyv);
  return { correct, explanation: str(q.explanation, 2000) };
}

/* The public face of a practice question: never the key, never the explanation. */
const questionOut = q => ({
  id: String(q.id), kind: q.kind === 'multi' ? 'multi' : 'single', prompt: str(q.prompt, 2000),
  choices: list(q.choices).filter(c => c && /^[a-f]$/.test(String(c.id))).map(c => ({ id: String(c.id), text: str(c.text, 500) })),
});

/* Builds the lesson payload.
   input = { course, version, module, lesson, outline:[{position,title,lessons:[{id,position,title}]}],
             facts:[product_facts rows, current], media:[academy_media rows + signed_url], questions:[academy_questions rows],
             manufacturers:{slug:name}, mode:'preview'|'learner' }
   Returns { lesson payload } — see the renderer for how each block is drawn. */
function buildLesson(input) {
  const I = input || {};
  const mode = I.mode === 'learner' ? 'learner' : 'preview';
  const M = I.manufacturers || {};
  const mfrName = slug => M[slug] || (slug ? String(slug).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null);
  const factIdx = {};
  for (const f of list(I.facts)) if (!f.valid_to) factIdx[key(f.manufacturer_slug, f.model_code, f.field)] = f;
  const mediaIdx = {}; for (const m of list(I.media)) mediaIdx[String(m.id)] = m;
  const qIdx = {}; for (const q of list(I.questions)) qIdx[String(q.id)] = q;
  const warnings = [], sources = new Map(), openItems = new Map();
  const warn = (i, msg) => warnings.push({ block: i + 1, message: msg });
  const addSource = (label, url, date) => {
    label = str(label, 200); if (!label) return;
    const k = label + '|' + (url || '');
    const s = sources.get(k) || { label, url: httpsOrNull(url), dates: new Set() };
    if (date) s.dates.add(date); sources.set(k, s);
  };
  const useFact = (mfr, model, field, label, i) => {
    const row = factIdx[key(mfr, model, field)];
    if (!row) { warn(i, `No current product fact for ${String(model).toUpperCase()} ${field}. It shows as "not available".`); return null; }
    const out = factOut(row, mfrName(mfr));
    addSource(out.source_label, out.source_url, out.verified_on);
    if (out.status === 'awaiting') openItems.set(key(mfr, model, field), `${String(model).toUpperCase()} · ${label || field.replace(/[._]/g, ' ')}: ${out.note || 'awaiting confirmation'}`);
    return out;
  };
  const image = (mediaId, i, what) => {
    const m = mediaIdx[String(mediaId)];
    if (!m || m.kind !== 'image') { warn(i, `${what}: the picture record is missing. A labelled placeholder is shown.`); return { missing: true, alt: '' }; }
    if (!m.signed_url) warn(i, `${what}: the picture file could not be opened just now. A labelled placeholder is shown.`);
    return { src: httpsOrNull(m.signed_url), alt: typeof m.alt_text === 'string' ? m.alt_text : '', decorative: m.alt_text === '', missing: !m.signed_url };
  };

  const blocks = [];
  list(I.lesson && I.lesson.blocks).slice(0, 40).forEach((b, i) => {
    if (!b || typeof b !== 'object' || !KINDS.includes(b.kind)) { warn(i, 'A block of an unknown kind was skipped.'); return; }
    let o = null;
    switch (b.kind) {
      case 'objectives': o = { items: list(b.items).map(x => str(x, 200)).filter(Boolean).slice(0, 4) }; break;
      case 'text': o = { heading: str(b.heading, 120) || null, body: str(b.body, 4000) }; break;
      case 'callout': o = { tone: TONES.includes(b.tone) ? b.tone : 'tip', body: str(b.body, 600) }; break;
      case 'quote': {
        o = { text: str(b.text, 1000), manufacturer: mfrName(b.manufacturer_slug), source_label: str(b.source_label, 200),
              source_url: httpsOrNull(b.source_url), source_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.source_date || '')) ? String(b.source_date) : null };
        addSource(o.source_label, o.source_url, o.source_date); break;
      }
      case 'image': {
        if (b.media_id) { const im = image(b.media_id, i, 'Picture'); o = { image: im, caption: str(b.caption, 300) || null }; }
        else o = { placeholder: str(b.placeholder, 200) || 'Picture to be added', alt: str(b.alt, 300), caption: str(b.caption, 300) || null };
        break;
      }
      case 'video': {
        o = { caption: str(b.caption, 300) || null };
        if (b.media_id) {
          const m = mediaIdx[String(b.media_id)];
          if (m && m.kind === 'video' && VIDEO.test(String(m.external_url || ''))) o.video = { embed: m.external_url, title: str(m.alt_text, 300) || 'Video' };
          else { warn(i, 'Video: the video record is missing or not an approved YouTube (no-cookie) or Vimeo link. A labelled placeholder is shown.'); o.placeholder = 'Video to be added'; }
        } else o.placeholder = str(b.placeholder, 200) || 'Video to be added';
        break;
      }
      case 'document': {
        o = { title: str(b.title, 200) };
        if (b.media_id) {
          const m = mediaIdx[String(b.media_id)];
          const href = m ? (m.storage_path ? httpsOrNull(m.signed_url) : httpsOrNull(m.external_url)) : null;
          if (m && (m.kind === 'pdf' || m.kind === 'link') && href) o.document = { href, hosted_by: m.storage_path ? 'hcps' : 'source', kind: m.kind };
          else { warn(i, 'Document: the document record or its link is missing. A labelled placeholder is shown.'); o.placeholder = 'Document to be added'; }
        } else o.placeholder = str(b.placeholder, 200) || 'Document to be added';
        break;
      }
      case 'fact': {
        const model = String(b.model_code || '').toUpperCase(), field = str(b.field, 60);
        o = { manufacturer: mfrName(b.manufacturer_slug), model_code: model, field, label: str(b.label, 120) || field.replace(/[._]/g, ' '),
              fact: useFact(b.manufacturer_slug, model, field, str(b.label, 120), i) };
        break;
      }
      case 'comparison': {
        const models = list(b.models).map(m => String(m || '').toUpperCase()).slice(0, 6);
        o = { title: str(b.title, 120) || null, manufacturer: mfrName(b.manufacturer_slug),
              models: models.map(code => { const n = factIdx[key(b.manufacturer_slug, code, 'name')]; return { code, name: n && typeof n.value === 'string' ? str(n.value, 120) : null }; }),
              rows: list(b.fields).slice(0, 12).map(f => {
                const field = str(f && f.field, 60), label = str(f && f.label, 80);
                return { field, label, cells: models.map(code => {
                  const fo = useFact(b.manufacturer_slug, code, field, label, i);
                  return fo ? { text: fo.text, status: fo.status, note: fo.note } : { text: null, status: 'missing', note: null };
                }) };
              }) };
        break;
      }
      case 'explorer': {
        const style = ['tabs', 'hotspots', 'cards'].includes(b.style) ? b.style : 'tabs';
        o = { style, title: str(b.title, 120) || null,
              items: list(b.items).slice(0, 12).map(it => {
                const x = { title: str(it && it.title, 80), body: str(it && it.body, 600) };
                if (it && it.media_id) x.image = image(it.media_id, i, 'Explorer picture');
                if (style === 'hotspots') { x.x = Math.max(0, Math.min(100, Number(it.x) || 0)); x.y = Math.max(0, Math.min(100, Number(it.y) || 0)); }
                return x;
              }) };
        if (b.media_id) o.image = image(b.media_id, i, 'Explorer picture');
        else if (style === 'hotspots') { warn(i, 'A hotspot explorer has no picture; its items are shown as a list.'); o.image = { missing: true, alt: '' }; }
        break;
      }
      case 'steps': {
        o = { title: str(b.title, 120) || null, items: list(b.items).map(x => str(x, 400)).filter(Boolean).slice(0, 20), source_label: str(b.source_label, 200) };
        addSource(o.source_label, null, null);
        if (b.media_id) {
          const m = mediaIdx[String(b.media_id)];
          const href = m ? (m.storage_path ? httpsOrNull(m.signed_url) : httpsOrNull(m.external_url)) : null;
          if (href) o.document = { href, hosted_by: m.storage_path ? 'hcps' : 'source', kind: m.kind };
        }
        break;
      }
      case 'scenario': {
        o = { prompt: str(b.prompt, 1000), choices: list(b.choices).slice(0, 4).map(c => ({ id: String(c && c.id), text: str(c && c.text, 300),
              feedback: str(c && c.feedback, 500), best: !!(c && c.best === true) })) };
        break;
      }
      case 'check': {
        const qs = [];
        for (const id of list(b.question_ids).slice(0, 5)) {
          const q = qIdx[String(id)];
          if (!q) { warn(i, 'Knowledge check: a question is missing.'); continue; }
          if (q.use !== 'practice' || q.status !== 'active') { warn(i, 'Knowledge check: a question that is not an active practice question was left out (exam questions are never shown in lessons).'); continue; }
          qs.push(questionOut(q));
        }
        o = { questions: qs, unavailable: qs.length === 0 };
        break;
      }
      case 'takeaways': o = { items: list(b.items).map(x => str(x, 300)).filter(Boolean).slice(0, 5) }; break;
    }
    blocks.push(Object.assign({ kind: b.kind }, o));
  });

  const L = I.lesson || {}, Mo = I.module || {}, C = I.course || {};
  const outline = list(I.outline).map(m => ({ position: m.position, title: str(m.title, 200),
    lessons: list(m.lessons).map(l => ({ position: l.position, title: str(l.title, 200), current: String(l.id) === String(L.id) })) }));
  const out = {
    mode,
    course: { title: str(C.title, 200), manufacturer: mfrName(C.manufacturer_slug), issuer: C.issuer || null },
    module: { position: Mo.position || null, title: str(Mo.title, 200), count: outline.length || null },
    lesson: { id: L.id ? String(L.id) : null, position: L.position || null, title: str(L.title, 200), est_minutes: Number(L.est_minutes) || null },
    outline, blocks,
    sources: [...sources.values()].map(s => ({ label: s.label, url: s.url, dates: [...s.dates].sort() })),
    open_items: [...openItems.values()],
  };
  if (mode === 'preview') { out.warnings = warnings; out.sample = I.sample || null; out.version_status = (I.version && I.version.status) || null; }
  return out;
}

/* Every id a lesson's blocks point to — what the server must read to build it. */
function references(blocks) {
  const media = new Set(), questions = new Set(), facts = [];
  for (const b of list(blocks)) {
    if (!b || typeof b !== 'object') continue;
    if (b.media_id) media.add(String(b.media_id));
    for (const it of list(b.items)) if (it && typeof it === 'object' && it.media_id) media.add(String(it.media_id));
    for (const q of list(b.question_ids)) questions.add(String(q));
    if (b.kind === 'fact') facts.push({ mfr: b.manufacturer_slug, model: String(b.model_code || '').toUpperCase(), field: b.field });
    if (b.kind === 'comparison') {
      for (const m of list(b.models)) { facts.push({ mfr: b.manufacturer_slug, model: String(m || '').toUpperCase(), field: 'name' });
        for (const f of list(b.fields)) facts.push({ mfr: b.manufacturer_slug, model: String(m || '').toUpperCase(), field: f && f.field }); }
    }
  }
  return { media: [...media], questions: [...questions], facts };
}

/* Is this question in one of this lesson's knowledge checks? (A practice check may only grade its own questions.) */
function lessonHasQuestion(blocks, questionId) {
  return list(blocks).some(b => b && b.kind === 'check' && list(b.question_ids).map(String).includes(String(questionId)));
}

module.exports = { KINDS, VIDEO, buildLesson, checkPractice, normAnswer, questionOut, references, lessonHasQuestion, factText };
