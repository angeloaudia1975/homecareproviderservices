/* A2D Stage 2 mutants: each removes ONE protection of the lesson engine, in memory only (test/phase0-mock.js applies it
   as the file loads). academy-lesson.mutants.js runs test/academy-lesson.test.js against each; at least one test must
   fail. CONTROL must survive. Renderer mutants (lesson-player.js) are applied by the browser test's own server: see
   academy-lesson.mutants.js (BROWSER section).
   Left out as EQUIVALENT: removing preview_check's "is this question in this sample?" test — a sample's questions are
   exactly the questions of its own checks, so a foreign id is already "not found" (the test still guards a future
   sample with spare questions). */
const L = '_academy_lesson.js', F = 'academy-admin-api.js', A = '_academy.js';
module.exports = {
  'CONTROL: a comment only':                       { file: L, from: "const TONES = ['tip', 'caution', 'ask_manufacturer'];", to: "const TONES = ['tip', 'caution', 'ask_manufacturer']; /* control */", control: true },
  'answer key in the question payload':            { file: L, from: 'const questionOut = q => ({', to: 'const questionOut = q => ({ answer_key: q.answer_key,' },
  'explanation in the question payload':           { file: L, from: 'const questionOut = q => ({', to: 'const questionOut = q => ({ explanation: q.explanation,' },
  'exam question shown in a lesson check':         { file: L, from: "if (q.use !== 'practice' || q.status !== 'active') { warn(i,", to: "if (false) { warn(i," },
  'grader accepts exam questions':                 { file: L, from: "if (!q || q.use !== 'practice' || q.status !== 'active') return null;", to: 'if (!q) return null;' },
  'multi answer order matters':                    { file: L, from: 'return [...new Set(a)].sort();', to: 'return a;' },
  'links not checked for https':                   { file: L, from: "const httpsOrNull = v => (typeof v === 'string' && HTTPS.test(v.trim()) ? v.trim() : null);", to: "const httpsOrNull = v => (typeof v === 'string' ? v.trim() : null);" },
  'any video host accepted':                       { file: L, from: "if (m && m.kind === 'video' && VIDEO.test(String(m.external_url || '')))", to: "if (m && m.kind === 'video')" },
  'replaced facts shown':                          { file: L, from: 'for (const f of list(I.facts)) if (!f.valid_to) factIdx', to: 'for (const f of list(I.facts)) if (true) factIdx' },
  'awaiting facts shown as verified':              { file: L, from: "status: row.status === 'verified' ? 'verified' : 'awaiting',", to: "status: 'verified'," },
  'missing fact guessed':                          { file: L, from: 'if (!row) { warn(i, `No current product fact', to: 'if (!row) return { text: "0", status: "verified" }; if (!row) { warn(i, `No current product fact' },
  'staff warnings sent to learners':               { file: L, from: "if (mode === 'preview') { out.warnings", to: 'if (true) { out.warnings' },
  'unknown kinds passed through':                  { file: L, from: "if (!b || typeof b !== 'object' || !KINDS.includes(b.kind)) { warn(i, 'A block of an unknown kind was skipped.'); return; }", to: "if (!b || typeof b !== 'object') return;" },
  'preview_check refuses no exam question':        { file: F, from: "if (q.use !== 'practice') A.refuse(403, 'not_practice'", to: "if (false) A.refuse(403, 'not_practice'" },
  'preview_check returns the key':                 { file: F, from: 'return { ok: true, correct: r.correct, explanation: r.explanation };   // never the answer key', to: 'return { ok: true, correct: r.correct, explanation: r.explanation, answer_key: q.answer_key };' },
  'preview_check over GET':                        { file: F, from: "if (!event || event.httpMethod !== 'POST') A.refuse(405, 'method'", to: "if (false) A.refuse(405, 'method'" },
  'preview_check any question of any lesson':      { file: F, from: "if (!LESSON.lessonHasQuestion(l.blocks, qid)) A.refuse(404, 'not_found', 'Question not found.');", to: '' },
  'preview_check another version':                 { file: F, from: '&version_id=eq.${enc(m.version_id)}&select=id,use,status,kind,answer_key,explanation', to: '&select=id,use,status,kind,answer_key,explanation' },
  'preview_check retired question':                { file: F, from: "if (q.status !== 'active') A.refuse(409, 'retired'", to: "if (false) A.refuse(409, 'retired'" },
  'preview reads answer keys':                     { file: F, from: "'id,version_id,use,status,kind,prompt,choices'),", to: "'id,version_id,use,status,kind,prompt,choices,answer_key,explanation')," },
  'preview other-version questions':               { file: F, from: 'questions: questions.filter(q => String(q.version_id) === String(v.id)),', to: 'questions,' },
  'sample lookup through the prototype':           { file: F, from: 'Object.prototype.hasOwnProperty.call(SAMPLES, String(k)) ? SAMPLES[String(k)] : null', to: 'SAMPLES[String(k)] || null' },
  'signing any path':                              { file: A, from: "if (!MEDIA_PATH.test(p) || p.includes('..')) return null;", to: '' },
};
