/* HCPS Academy A2D Stage 3 — Course Builder: the pure parts and the static safety rules (no database, no browser).
     node test/academy-builder.test.js
   - readiness(): every warning Angelo asked for (missing pictures, unverified or missing facts, incomplete content, a thin
     or badly distributed exam bank) is BLOCKING; lesson length and scenario share are advice; a complete course is ready.
   - blocksHash(): key order does not matter; any content change does.
   - the builder page script places text as text only, never builds HTML, never names an actor, and sends only the
     builder's own actions. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://unit.test';
const B = require('../netlify/functions/_academy_builder.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); } }
const u = n => `5b3e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G = 'golden-technologies';

function course(over) {
  const M = [u(1), u(2)];
  const words = n => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
  const lesson = (id, mod, pos, extra) => ({ id, module_id: mod, position: pos, title: 'L' + pos, est_minutes: 12, blocks: [
    { kind: 'objectives', items: ['Do one thing', 'Do another'] },
    { kind: 'text', heading: 'H', body: words(1800) },
    { kind: 'fact', manufacturer_slug: G, model_code: 'PR446', field: 'weight_capacity', label: 'Capacity' },
    { kind: 'scenario', prompt: 'p', choices: [{ id: 'a', text: 'x', feedback: 'f', best: true }, { id: 'b', text: 'y', feedback: 'f', best: false }, { id: 'c', text: 'z', feedback: 'f', best: false }] },
    { kind: 'check', question_ids: [u(91), u(92)] },
    { kind: 'takeaways', items: ['a', 'b', 'c'] }].concat(extra || []) });
  const q = (id, mod, use, kind) => ({ id, version_id: u(9), module_id: mod, use, kind: kind || 'single', status: 'active', prompt: 'Question ' + id, choices: [], answer_key: 'a', explanation: 'e', objective_tags: ['x'] });
  const base = {
    version: { id: u(9), exam_questions: 4 },
    modules: [{ id: M[0], position: 1, title: 'Welcome', exam_quota: null }, { id: M[1], position: 2, title: 'Zones', exam_quota: null }],
    lessons: [lesson(u(11), M[0], 1), lesson(u(12), M[1], 1)],
    questions: [q(u(91), M[0], 'practice'), q(u(92), M[0], 'practice'), q(u(81), M[0], 'exam', 'scenario'), q(u(82), M[0], 'exam', 'scenario'), q(u(83), M[1], 'exam', 'scenario'), q(u(84), M[1], 'exam')],
    refs: [], media: [],
    facts: [{ manufacturer_slug: G, model_code: 'PR446', field: 'weight_capacity', status: 'verified', value: 375, unit: 'lb', valid_to: null }],
  };
  return Object.assign(base, over ? over(base) : {});
}
const blocking = r => r.items.filter(x => x.level === 'blocking').map(x => x.message);

t('a complete small course is ready (only advice about the 60-question target)', () => {
  const r = B.readiness(course());
  assert.deepStrictEqual(blocking(r), []); assert.strictEqual(r.ready, true);
  assert.ok(r.items.some(x => x.level === 'advice' && /60 exam questions/.test(x.message)));
  assert.strictEqual(r.bank.usable, 4); assert.strictEqual(r.bank.mode, 'automatic');
});
t('missing pictures, videos, documents and a hotspot explorer without its picture are blocking, with the lesson to open', () => {
  const r = B.readiness(course(b => { b.lessons[1].blocks.splice(1, 0, { kind: 'image', placeholder: 'PR-446 side view', alt: 'x', caption: '' }, { kind: 'video', placeholder: 'AutoDrive video', caption: '' },
    { kind: 'document', placeholder: 'Owner manual', title: 'Manual' }, { kind: 'explorer', style: 'hotspots', title: '', items: [] }, { kind: 'image', media_id: u(70), caption: '' }); return {}; }));
  const m = blocking(r).join(' | ');
  assert.match(m, /Picture still missing: "PR-446 side view"/); assert.match(m, /Video still missing/); assert.match(m, /Document still missing/);
  assert.match(m, /hotspot explorer has no picture/); assert.match(m, /picture record this screen uses is gone/);
  assert.ok(r.items.filter(x => x.level === 'blocking').every(x => x.lesson_id === u(12)));
});
t('a fact or comparison cell that is not recorded, or awaits manufacturer confirmation, is blocking', () => {
  const r = B.readiness(course(b => { b.lessons[0].blocks.splice(2, 0, { kind: 'comparison', title: '', manufacturer_slug: G, models: ['PR446', 'PR515'], fields: [{ field: 'weight_capacity', label: 'Capacity' }, { field: 'zones', label: 'Zones' }] });
    b.facts.push({ manufacturer_slug: G, model_code: 'PR515', field: 'weight_capacity', status: 'awaiting_manufacturer', valid_to: null }); return {}; }));
  const m = blocking(r).join(' | ');
  assert.match(m, /PR515 · Capacity is awaiting manufacturer confirmation/);
  assert.match(m, /No product fact recorded for PR446 · Zones/); assert.match(m, /No product fact recorded for PR515 · Zones/);
});
t('incomplete content: no modules, an empty module, an empty lesson, objectives not first, no takeaways', () => {
  assert.match(blocking(B.readiness(course(b => ({ modules: [], lessons: [] })))).join(), /no modules/);
  const r = B.readiness(course(b => { b.modules.push({ id: u(3), position: 3, title: 'Empty', exam_quota: null }); b.lessons.push({ id: u(13), module_id: u(2), position: 2, title: 'Blank', est_minutes: 10, blocks: [] });
    b.lessons[0].blocks = b.lessons[0].blocks.slice(1, -1); return {}; }));
  const m = blocking(r).join(' | ');
  assert.match(m, /This module has no lessons yet/); assert.match(m, /This lesson has no content yet/);
  assert.match(m, /starts with its objectives/); assert.match(m, /key takeaways/);
});
t('a knowledge check that points at a missing, exam or retired question is blocking', () => {
  const r = B.readiness(course(b => { b.lessons[0].blocks[4].question_ids = [u(91), u(81), u(99)]; b.questions[1].status = 'retired'; b.lessons[1].blocks[4].question_ids = [u(92), u(91)]; return {}; }));
  const m = blocking(r).join(' | ');
  assert.match(m, /question is missing/); assert.match(m, /not an active practice question/);
});
t('the exam bank: unverified or missing facts make a question unusable; no module; too few for an attempt', () => {
  const r = B.readiness(course(b => { b.refs = [{ question_id: u(84), manufacturer_slug: G, model_code: 'PR515', field: 'weight_capacity' }]; b.questions[2].module_id = null; return {}; }));
  const m = blocking(r).join(' | ');
  assert.match(m, /relies on a product fact that is missing or not verified/); assert.match(m, /not assigned to a module/);
  assert.match(m, /2 usable exam questions; each attempt draws 4/); assert.strictEqual(r.bank.usable, 2);
});
t('automatic distribution: every module needs a usable exam question, and there must be at least as many questions per attempt as modules', () => {
  const r = B.readiness(course(b => { b.questions[4].module_id = u(1); b.questions[5].module_id = u(1); return {}; }));
  assert.match(blocking(r).join(), /Module 2 has no usable exam question/);
  const r2 = B.readiness(course(b => ({ version: { id: u(9), exam_questions: 1 } })));
  assert.match(blocking(r2).join(), /2 modules but only 1 questions per attempt/);
});
t('a set distribution: every module needs a number, the numbers add up, and each module has enough usable questions', () => {
  const set = q => course(b => { b.modules[0].exam_quota = q[0]; b.modules[1].exam_quota = q[1]; return {}; });
  assert.deepStrictEqual(blocking(B.readiness(set([2, 2]))), []);
  assert.match(blocking(B.readiness(set([2, null]))).join(), /Every module needs a number/);
  assert.match(blocking(B.readiness(set([1, 2]))).join(), /add up to 3; each attempt draws 4/);
  assert.match(blocking(B.readiness(set([1, 3]))).join(), /Module 2 gives 3 questions but has 2 usable/);
  assert.strictEqual(B.readiness(set([2, 2])).bank.mode, 'set');
});
t('advice only (never blocking): lesson length outside 10–15 minutes, stated minutes far from the content, no scenario or check, few scenarios', () => {
  const r = B.readiness(course(b => { b.lessons[1].blocks = [b.lessons[1].blocks[0], { kind: 'text', heading: '', body: 'short' }, b.lessons[1].blocks[5]]; b.questions.forEach(q => { q.kind = 'single'; }); return {}; }));
  const adv = r.items.filter(x => x.level === 'advice').map(x => x.message).join(' | ');
  assert.match(adv, /lessons run 10–15 minutes/); assert.match(adv, /says about 12 minutes/); assert.match(adv, /No customer scenario/); assert.match(adv, /No knowledge check/);
  assert.match(adv, /customer scenarios; the target is about half/);
  assert.deepStrictEqual(blocking(r), []);
  // the Welcome lesson (1.1) is exempt from the 10–15 minute advice
  const w = B.readiness(course(b => { b.lessons[0].blocks[1].body = 'short'; b.lessons[0].est_minutes = 8; return {}; }));
  assert.ok(!w.items.some(x => x.lesson_id === u(11) && /10–15/.test(x.message)));
});
t('estimateMinutes: about 200 words a minute plus time for interactive screens; never below 1', () => {
  assert.strictEqual(B.estimateMinutes([]), 1);
  assert.strictEqual(B.estimateMinutes([{ kind: 'text', body: Array(2000).fill('w').join(' ') }]), 10);
  assert.ok(B.estimateMinutes([{ kind: 'text', body: 'x' }, { kind: 'scenario', prompt: 'p', choices: [] }, { kind: 'check', question_ids: [1, 2, 3, 4] }]) >= 4);
});
t('blocksHash: key order does not matter; any content change does; 32 hex characters', () => {
  const a = [{ kind: 'text', heading: 'H', body: 'B' }], b = [{ body: 'B', kind: 'text', heading: 'H' }];
  assert.strictEqual(B.blocksHash(a), B.blocksHash(b)); assert.match(B.blocksHash(a), /^[0-9a-f]{32}$/);
  assert.notStrictEqual(B.blocksHash(a), B.blocksHash([{ kind: 'text', heading: 'H', body: 'b' }]));
  assert.notStrictEqual(B.blocksHash([]), B.blocksHash(null) === B.blocksHash([]) ? '' : 'x');
});
t('upload types: only JPEG / PNG / WebP / PDF, each recognised by its contents; 3 MB limit; the upload body allowance matches', () => {
  assert.deepStrictEqual(Object.keys(B.TYPES).sort(), ['jpg', 'pdf', 'png', 'webp']);
  assert.ok(B.TYPES.jpg.magic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))); assert.ok(!B.TYPES.jpg.magic(Buffer.from('<svg')));
  assert.ok(B.TYPES.pdf.magic(Buffer.from('%PDF-1.7'))); assert.ok(!B.TYPES.png.magic(Buffer.from('GIF89a..')));
  assert.ok(B.TYPES.webp.magic(Buffer.from('RIFF....WEBPVP8 '))); assert.strictEqual(B.MAX_UPLOAD, 3 * 1024 * 1024);
  assert.ok(B.UPLOAD_BODY > B.MAX_UPLOAD * 4 / 3 && B.UPLOAD_BODY < 6 * 1024 * 1024, 'fits in a Netlify request');
});

/* ------------------------------------------------------------- the page script, read as text */
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'academy-builder.js'), 'utf8');
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'academy-builder.html'), 'utf8');
t('the builder page never builds HTML from text: no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval', () => {
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!CODE.includes(bad), bad);
  assert.ok(!/<script>[\s\S]*\S[\s\S]*<\/script>/.test(HTML.replace(/<script src=[^>]+><\/script>/g, '')), 'no inline script in the page');
});
t('the builder page never names who acted, and only calls the Academy admin API with the builder / Command Center actions', () => {
  assert.ok(!/p_actor|["']actor["']\s*:/.test(CODE), 'no actor in any request');
  const fns = [...CODE.matchAll(/\/\.netlify\/functions\/([a-z0-9-]+)/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(fns)].sort(), ['academy-admin-api', 'staff-auth']);
  const actions = [...new Set([...CODE.matchAll(/action:\s*'([a-z_]+)'/g)].map(m => m[1]))].sort();
  const allowed = Object.keys(B.READ).concat(Object.keys(B.WRITE), ['whoami', 'login', 'create_module', 'update_module', 'create_lesson', 'update_lesson', 'delete_lesson', 'preview_check']);
  assert.deepStrictEqual(actions.filter(a => !allowed.includes(a)), [], 'unexpected actions');
  assert.ok(!/publish_version|retire_version|record_fact|withdraw_fact|issue|certificate/i.test(actions.join(' ')), 'publishing, facts and certificates are not touched here');
});
t('the page asks before losing unsaved screens and never uses browser dialogs (alert / confirm / prompt)', () => {
  assert.ok(/beforeunload/.test(CODE)); assert.ok(/function guard\(/.test(CODE));
  assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(CODE.replace(/role: 'alertdialog'/g, '')));
});
t('links the page builds point only to its own pages or https files it was given', () => {
  const hrefs = [...CODE.matchAll(/href:\s*([^,}]+)/g)].map(m => m[1].trim());
  assert.ok(hrefs.every(h => /preview_url|signed_url/.test(h)), hrefs.join(' | '));
});

console.log(`\nacademy-builder: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
