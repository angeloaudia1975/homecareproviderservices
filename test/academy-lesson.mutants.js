/* Runs the A2D Stage 2 suite once clean (must pass) and once per mutant (must fail). CONTROL must survive.
     node test/academy-lesson.mutants.js
   BROWSER section (renderer protections, applied in memory by the browser test's own file server):
     PLAYWRIGHT_MODULE=… AXE=… node test/academy-lesson.mutants.js --browser */
const { spawnSync } = require('child_process');
const path = require('path');
const TABLE = path.join(__dirname, 'academy-lesson.mutants.table.js');
const browser = process.argv.includes('--browser');

/* Renderer mutants: each undoes one protection of lesson-player.js; the browser suite (hostile lesson, video, links,
   placeholders, completion, keyboard) must fail. Only the browser tests that exercise them run, to keep this quick.
   Left out as EQUIVALENT: removing h()'s own https check on `href` — every caller passes a link through safeUrl() or the
   video allow-list first, so that check is a second layer no input can reach (the "source links not checked" mutant
   removes the first layer and is killed). */
const BROWSER = {
  'CONTROL: a comment only':               { from: "var uid = 0;", to: "var uid = 0; /* control */", control: true },
  'text set as HTML':                      { from: "if (props.text != null) el.textContent = String(props.text);", to: "if (props.text != null) el.innerHTML = String(props.text);" },
  'markup text as HTML':                   { from: "out.push(i % 2 ? h('strong', { text: p }) : document.createTextNode(p));", to: "{ var sp = document.createElement('span'); sp.innerHTML = p; out.push(i % 2 ? h('strong', { text: p }) : sp); }" },
  'source links not checked':              { from: "var safeUrl = function (u) { return typeof u === 'string' && HTTPS.test(u) ? u : null; };", to: "var safeUrl = function (u) { return u || null; };" },
  'video loads before the tap':            { from: "box.appendChild(play); fig.appendChild(box);", to: "box.appendChild(play); fig.appendChild(box); setTimeout(function () { play.click(); }, 0);" },
  'broken picture left broken':            { from: "el.addEventListener('error', function () { box.replaceWith(placeholder('This picture could not be loaded just now', 'Picture', img.alt)); }, { once: true });", to: '' },
  'completion without the check':          { from: "if (a === qs.length) pass(i, 'attempted');", to: "pass(i, 'attempted');" },
  'no focus ring':                         { css: true, from: ".hl :focus-visible{outline:3px solid var(--orange);outline-offset:2px;border-radius:6px}", to: ".hl :focus-visible{outline:none}" },
  'tabs without arrow keys':               { from: "if (j != null) { e.preventDefault(); select(j, true, true); }", to: '' },
  'Escape does not close the panel':       { from: "panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });", to: '' },
  'phone layout off':                      { css: true, from: "@container hl (max-width: 899px){", to: "@container hl (max-width: 1px){" },
};

function runNode(file, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 1200000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out)) return { skipped: true };
  const m = out.match(/(\d+) passed, (\d+) failed/); return { failed: m ? +m[2] : 1, out };
}
function report(results, total) {
  let killed = 0; const survived = [], skipped = [], badControl = [];
  for (const [name, r, control] of results) {
    if (r.skipped) { skipped.push(name); console.log('SKIPPED  ' + name); continue; }
    if (control) { if (r.failed > 0) badControl.push(name); console.log((r.failed ? 'CONTROL FAILED ' : 'control survived ') + name); continue; }
    if (r.failed > 0) { killed++; console.log('killed   ' + name + '  (' + r.failed + ')'); } else { survived.push(name); console.log('SURVIVED ' + name); }
  }
  console.log(`\n${killed}/${total} killed, ${survived.length} survived, ${skipped.length} skipped${badControl.length ? ', CONTROL FAILED' : ''}`);
  return survived.length || skipped.length || badControl.length;
}

module.exports = { BROWSER };
if (require.main !== module) { /* loaded for its table only */ }
else if (!browser) {
  const table = require(TABLE);
  const clean = runNode('academy-lesson.test.js', {});
  console.log('clean run:', clean.failed === 0 ? 'all pass' : clean.failed + ' FAILURES');
  const results = Object.entries(table).map(([name, mt]) => [name, runNode('academy-lesson.test.js', { P0_MUTANT: name, P0_MUTANT_TABLE: TABLE }), mt.control]);
  const bad = report(results, Object.values(table).filter(m => !m.control).length);
  process.exitCode = (clean.failed || bad) ? 1 : 0;
} else {
  const clean = runNode('academy-lesson.browser.js', { LESSON_MUTANT_ONLY: '1' });
  console.log('clean run:', clean.failed === 0 ? 'all pass' : clean.failed + ' FAILURES\n' + clean.out);
  const results = Object.entries(BROWSER).map(([name, mt]) => [name, runNode('academy-lesson.browser.js', { LESSON_MUTANT: JSON.stringify(mt), LESSON_MUTANT_ONLY: '1' }), mt.control]);
  const bad = report(results, Object.values(BROWSER).filter(m => !m.control).length);
  process.exitCode = (clean.failed || bad) ? 1 : 0;
}
