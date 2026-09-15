/* Dealer Resource Library — render check.

   A single document row with `models: null` stopped Eleventy, which stopped the
   whole Netlify build, which meant seventy-odd serverless functions silently kept
   serving an older deploy for days. Nothing about the site looked broken; the
   admin just quietly stopped receiving new code.

   That is far too much blast radius for one optional field, so it gets a test.
   This renders the REAL rcard macro over EVERY real document in
   src/_data/documents.json, which is the exact step that failed. Run it before a
   push and a malformed record shows up here instead of on Netlify.

   Filters registered by .eleventy.js are stubbed — none of them was the failure,
   and stubbing keeps this runnable without booting Eleventy.

   Usage:  node test/resources-render.test.js
*/
const fs = require('fs');
const path = require('path');

let nunjucks;
try { nunjucks = require('nunjucks'); }
catch(e){
  console.log('nunjucks not installed — run `npm install` first. Skipping.');
  process.exit(0);
}

const SRC = process.env.SRC_DIR || path.join(__dirname, '..', 'src');
const TPL = path.join(SRC, 'resources.njk');
const DOCS = path.join(SRC, '_data', 'documents.json');

const tpl = fs.readFileSync(TPL, 'utf8');
const parsed = JSON.parse(fs.readFileSync(DOCS, 'utf8'));
const docs = parsed.items ? parsed : { items: parsed };
const items = docs.items || [];

/* The macro alone. Rendering the whole page would drag in the layout chain and
   test nothing extra — every failure so far has been inside a card. */
const at = tpl.indexOf('{% macro rcard(');
if(at < 0){ console.error('rcard macro not found in resources.njk'); process.exit(1); }
const end = tpl.indexOf('{% endmacro %}', at) + '{% endmacro %}'.length;
const macro = tpl.slice(at, end);

const env = new nunjucks.Environment(null, { autoescape: true });
['typeColor','typeLabel','typeNeed','manuLabel','catLabel','manuById','resourceCat']
  .forEach(f => env.addFilter(f, v => String(v == null ? '' : v)));

let ok = 0;
const threw = [];
for(const doc of items){
  try { env.renderString(macro + '{{ rcard(doc, docs, mans) }}', { doc, docs, mans: [] }); ok++; }
  catch(e){ threw.push({ id: doc.id || '(no id)', title: doc.title || '',
                         why: String(e.message).split('\n').pop().trim() }); }
}

/* A record that renders but is malformed is tomorrow's build failure, so the
   shape is checked too rather than only the render. */
const shape = [];
for(const doc of items){
  if(!Array.isArray(doc.models))
    shape.push((doc.id || '(no id)') + ' — models is ' + JSON.stringify(doc.models) + ', expected an array');
}

console.log('documents rendered : ' + ok + ' / ' + items.length);
console.log('render failures    : ' + threw.length);
threw.forEach(t => console.log('   ✗ ' + t.id + ' — ' + t.why));
console.log('shape warnings     : ' + shape.length);
shape.forEach(s => console.log('   ! ' + s));

if(threw.length || shape.length){
  console.log('\nThis would fail the Netlify build and block every function deploy.');
  process.exit(1);
}
console.log('\nEvery document renders. The site will build.');
