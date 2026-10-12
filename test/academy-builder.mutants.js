/* HCPS Academy A2D Stage 3 — mutation testing of the Course Builder's server code. Each mutant undoes ONE protection or
   rule in a scratch copy of the committed tree (git archive HEAD); the unit test and the Postgres-backed API test must
   then fail. A clean control run first must pass. Mutants marked `db` are protections repeated by a second layer (the M3 database rules, or the Stage 2 payload builder): with the
   server check removed the database still refuses, so they are expected to survive — they show the second line of
   defence holds — and are reported separately, never counted as killed.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-builder.mutants.js [from] [to] */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BLD = 'netlify/functions/_academy_builder.js', API = 'netlify/functions/academy-admin-api.js';
const MUTANTS = [
  { f: API, from: "WRITE[k] = fn; }", to: "READ[k] = fn; }", why: 'builder writes accepted as GET' },
  { f: API, from: "if (upload && action !== 'upload_media') return", to: "if (false) return", why: 'the large-body allowance usable by any action' },
  { f: API, from: "A.body(event, upload ? BUILDER.UPLOAD_BODY : undefined)", to: "A.body(event, BUILDER.UPLOAD_BODY)", why: 'every request may be 4 MB' },
  { f: API, from: "const shown = Array.isArray(b.blocks) && b.blocks.length <= 40 ? b.blocks : l.blocks;\n    if (!LESSON.lessonHasQuestion(shown, qid))", to: "const shown = Array.isArray(b.blocks) && b.blocks.length <= 40 ? b.blocks : l.blocks;\n    if (false)", why: 'preview_check grades a question the screens do not hold' },
  { f: BLD, from: "if (typeof b.base_hash !== 'string' || b.base_hash !== blocksHash(l.blocks))", to: "if (false)", why: 'first starting-point check removed (the re-check before the write still refuses)', db: true },
  { f: BLD, from: "if (typeof b.base_hash !== 'string' || b.base_hash", to: "if (typeof b.base_hash === 'string' && b.base_hash", why: 'a missing base hash passes the first check (the re-check before the write still refuses)', db: true },
  { f: BLD, from: "try { await A.authorOp('unlink_fact', { p_actor: actor(staff), p_id: id }); }", to: "try { }", why: 'links made for a refused save are left behind' },
  { f: BLD, from: "      if (have.has(k)) continue;\n      const [mfr", to: "      continue;\n      const [mfr", why: 'facts on a screen not linked (the save fails)' },
  { f: BLD, from: "if (link && link.id) made.push(link.id);", to: "", why: 'facts_linked miscounted / links never undone' },
  { f: BLD, from: "kind: q.kind, prompt: q.prompt, choices: q.choices })),", to: "kind: q.kind, prompt: q.prompt, choices: q.choices, answer_key: q.answer_key, explanation: q.explanation })),", why: 'the live preview asks for answer keys (the payload builder still strips them)', db: true },
  { f: BLD, from: "if (!Array.isArray(b.blocks) || b.blocks.length > 40) A.refuse(400, 'invalid', 'A lesson has at most 40 screens.');", to: "", why: 'preview of an oversize lesson' },
  { f: BLD, from: "    if (blocksHash((await currentLesson(l.id)).blocks) !== b.base_hash) A.refuse(409, 'changed', CHANGED);\n    saved", to: "    saved", why: 'no second check just before the blocks are written' },
  { f: BLD, from: "else if (blocksHash(mine.before && mine.before.blocks) !== b.base_hash) {", to: "else if (false) {", why: 'an overwrite of a concurrent save goes unnoticed' },
  { f: BLD, from: "      await A.authorOp('set_blocks', { p_actor: actor(staff), p_lesson_id: l.id, p_blocks: theirs });\n      restored = true;", to: "      restored = true;", why: 'the overwritten version is not put back' },
  { f: BLD, from: "    try { await A.authorOp('unlink_fact', { p_actor: actor(staff), p_id: r.id }); pruned++; }", to: "    try { }", why: 'leftover links never removed' },
  { f: BLD, from: "    if (now !== null && now !== b.base_hash) {", to: "    if (false) {", why: 'a lost answer is treated as a failure (links undone under saved screens)' },
  { f: BLD, from: "    if (left.length) e.message = ", to: "    if (false) e.message = ", why: 'a link left behind is not reported' },
  { f: BLD, from: "save_blocks = async (staff, b) => {\n  const { l, m } = await lessonCtx(A.uuid(b.lesson_id, 'lesson'));\n  await draft(m.version_id);", to: "save_blocks = async (staff, b) => {\n  const { l, m } = await lessonCtx(A.uuid(b.lesson_id, 'lesson'));", why: 'save_blocks on a locked version (server check)', db: true },
  { f: BLD, from: "saved = await A.authorOp('set_blocks', { p_actor: actor(staff),", to: "saved = await A.authorOp('set_blocks', { p_actor: b.p_actor || actor(staff),", why: 'the actor taken from the request' },
  { f: BLD, from: "if (!isPresident(staff)) A.refuse(403, 'president_only', 'Only the President approves", to: "if (false) A.refuse(403, 'president_only', 'Only the President approves", why: 'a non-President approves a stored picture (server check)', db: true },
  { f: BLD, from: "if (!isPresident(staff)) A.refuse(403, 'president_only', 'Only the President discards", to: "if (false) A.refuse(403, 'president_only', 'Only the President discards", why: 'a non-President discards an upload' },
  { f: BLD, from: "if (one(await A.sbGet(`academy_media?storage_path=eq.${enc(path)}&select=id`))) A.refuse(409, 'in_use'", to: "if (false) A.refuse(409, 'in_use'", why: 'an approved file is discarded' },
  { f: BLD, from: "const reason = A.text(b.reason, 300, 'Reason');", to: "const reason = String(b.reason || '');", why: 'a discard without a reason' },
  { f: BLD, from: "if (!(await A.audit(staff, 'academy_media', null, 'discard_upload', { storage_path: path }, { reason })))", to: "if (false)", why: 'a discard without its audit row' },
  { f: BLD, from: "if (!T.magic(bytes)) A.refuse(", to: "if (false) A.refuse(", why: 'a file whose contents do not match its name' },
  { f: BLD, from: "if (bytes.length > MAX_UPLOAD) A.refuse(", to: "if (false) A.refuse(", why: 'over 3 MB stored' },
  { f: BLD, from: "const path = `media/${folder}/${sha.slice(0, 16)}-${base}.${key}`;", to: "const path = `media/${folder}/${base}.${key}`;", why: 'upload name without its hash (a different file could replace another)' },
  { f: BLD, from: "if (named.has(path) || !A.MEDIA_PATH.test(path)) continue;", to: "if (!A.MEDIA_PATH.test(path)) continue;", why: 'approved files listed again as waiting' },
  { f: BLD, from: "if (kind === 'video' && !LESSON.VIDEO.test(media.external_url))", to: "if (false)", why: 'a non-embed video link (server check)', db: true },
  { f: BLD, from: "const reason = status === 'retired' ? A.text(b.reason, 500, 'Reason')", to: "const reason = status === 'retired' ? (b.reason || null)", why: 'retiring a question without a reason (server check)', db: true },
  { f: BLD, from: "president: isPresident(staff),", to: "president: true,", why: 'every administrator told they are the President' },
  { f: BLD, from: "if (b.kind === 'image' && !b.media_id) add('blocking'", to: "if (b.kind === 'image' && !b.media_id) add('advice'", why: 'a missing picture not blocking' },
  { f: BLD, from: "else if (f.status !== 'verified') add('blocking', at", to: "else if (f.status !== 'verified') add('advice', at", why: 'an unconfirmed fact on a screen not blocking' },
  { f: BLD, from: "return f && f.status === 'verified'; });", to: "return !!f; });", why: 'an exam question on an unverified fact counted as usable' },
  { f: BLD, from: "if (sum !== need) add('blocking'", to: "if (false) add('blocking'", why: 'a distribution that does not add up' },
  { f: BLD, from: "if (usable.length < need) add('blocking'", to: "if (false) add('blocking'", why: 'too few exam questions not blocking' },
  { f: BLD, from: "if (blocks[0].kind !== 'objectives') add('blocking'", to: "if (false) add('blocking'", why: 'objectives not first not reported' },
  { f: BLD, from: "if (!ls.length) add('blocking'", to: "if (false) add('blocking'", why: 'an empty module not reported' },
  { f: BLD, from: "if (mods.some(m => m.exam_quota == null)) add('blocking'", to: "if (false) add('blocking'", why: 'a module without a number not reported' },
  { f: BLD, from: "else if (q.use !== 'practice' || q.status !== 'active') add('blocking'", to: "else if (false) add('blocking'", why: 'an exam question in a lesson check not reported' },
];

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmut-'));
  execSync(`git -C ${ROOT} archive HEAD | tar -x -C ${dir}`);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
function tests(dir) {
  const out = [];
  for (const f of ['test/academy-builder.test.js', 'test/academy-builder.pg.test.js']) {
    const r = spawnSync(process.execPath, [f], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 240000 });
    out.push({ f, ok: r.status === 0, tail: (r.stdout || '').trim().split('\n').slice(-1)[0] });
  }
  return out;
}
const [from, to] = process.argv.slice(2).map(Number);
const list = MUTANTS.slice(from || 0, to || MUTANTS.length);
const dir = tree();
let killed = 0, survived = [], dbHeld = [], dbKilled = 0;
try {
  if (!from) {
    const ctl = tests(dir);
    if (!ctl.every(x => x.ok)) { console.log('CONTROL FAILED — results would be meaningless:', ctl); process.exit(1); }
    console.log('control: clean (' + ctl.map(x => x.tail).join(' · ') + ')');
  }
  for (const [i, m] of list.entries()) {
    const p = path.join(dir, m.f), orig = fs.readFileSync(p, 'utf8');
    if (!orig.includes(m.from)) { console.log(`  ANCHOR NOT FOUND #${(from || 0) + i}: ${m.why}`); survived.push(m.why + ' (anchor)'); continue; }
    fs.writeFileSync(p, orig.split(m.from).join(m.to));
    const r = tests(dir); fs.writeFileSync(p, orig);
    const dead = r.some(x => !x.ok);
    if (m.db) { if (dead) dbKilled++; else dbHeld.push(m.why); console.log(`  ${dead ? 'killed ' : 'held by the database'}  #${(from || 0) + i} ${m.why}`); continue; }
    if (dead) killed++; else survived.push(m.why);
    console.log(`  ${dead ? 'killed  ' : 'SURVIVED'} #${(from || 0) + i} ${m.why}`);
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
const n = list.filter(m => !m.db).length;
console.log(`\nacademy builder mutants: ${killed}/${n} killed` + (dbHeld.length + dbKilled ? `; database-repeated checks: ${dbKilled} killed by the tests, ${dbHeld.length} held by the database (${dbHeld.join('; ')})` : ''));
if (survived.length) { console.log('survivors: ' + survived.join(' | ')); process.exitCode = 1; }
