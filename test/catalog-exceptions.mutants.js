/* Mutation check for the catalog exceptions queue: each mutant weakens one rule and MUST be killed by
   test/catalog-exceptions.test.js; the control changes nothing that matters and must survive. */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const F = path.join(__dirname, '..', 'netlify', 'functions', '_catalog_exceptions.js');
const API = path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');
const M = [
  ['control', F, 'Pure: no database, no', 'Pure: no database,  no', true],
  ['unpriced SKUs counted ready', F, 's.priced === true && onVisible', 'onVisible', false],
  ['pack without case qty counted ready', F, '&& !packGap.has(s.code)', '', false],
  ['retired SKU offered not flagged', F, 'OFF.has(String(s.status || "")) && offeredOn.has', 'false && offeredOn.has', false],
  ['draft pages count as visible', F, 'const visiblePages = (pages || []).filter(p => p && VISIBLE.has(String(p.status || "")) && p.disabled !== true);', 'const visiblePages = (pages || []).filter(p => p);', false],
  ['missing unit not flagged', F, 'if (noUom.length) add(', 'if (false) add(', false],
  ['no-source line not flagged', F, 'if (!src) add(', 'if (false) add(', false],
  ['frozen not reported', F, 'frozen: !!(meta[l.slug] && meta[l.slug].frozen)', 'frozen: false', false],
  ['response carries the raw master rows', API, 'return json(200,Object.assign({ok:true, generated:new Date().toISOString()}, q));', 'return json(200,Object.assign({ok:true, generated:new Date().toISOString(), skuRows}, q));', false],
  ['response carries the catalog files', API, 'return json(200,Object.assign({ok:true, generated:new Date().toISOString()}, q));', 'return json(200,Object.assign({ok:true, generated:new Date().toISOString(), raw:(skuRows||[]).map(s=>s.base_price)}, q));', false],
  ['unreadable layer swallowed', API, '}catch(e){ return json(503,{error:"exceptions_unreadable"', '}catch(e){ mfrs=mfrs||[]; } if(false){ return json(503,{error:"exceptions_unreadable"', false],
  ['notes counted as work', F, '(c === "ready" || x.severity !== "info")', 'true', false],
  ['a code counted once per check, not per category', F, 'x.codes.forEach(code => keys.add(norm(code))); n += hidden;', 'n += x.codes.length + hidden;', false],
  ['card image not a page photo', F, 'if (p.card_image && String(p.card_image).trim() && p.card_image !== "none") return true;', '', false],
  ['page photo does not cover catalog rows', F, 'const left = e.codes.filter(c => !pagePhotoCodes.has(norm(c)));', 'const left = e.codes.slice();', false],
  ['legacy layers ignored', API, 'for(const c of customRows||[]){', 'for(const c of []){', false],
  ['legacy layer read with its prices', API, 'custom_products?manufacturer=neq.golden&select=manufacturer,code,image,active', 'custom_products?manufacturer=neq.golden&select=manufacturer,code,image,active,base_price,tiers', false],
  ['any staff role allowed', API, 'if(me.role!=="president") return json(403,{error:"President only"});', '', false],
];
let bad = 0;
for (const [name, file, from, to, survive] of M) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.log('ANCHOR MISSING  ' + name); bad++; continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  let killed = false;
  try { execFileSync('node', [path.join(__dirname, 'catalog-exceptions.test.js')], { stdio: 'ignore' }); } catch (e) { killed = true; }
  fs.writeFileSync(file, orig);
  const okk = survive ? !killed : killed;
  if (!okk) bad++;
  console.log((killed ? 'killed   ' : 'survived ') + name + (okk ? '' : '   <-- NOT AS REQUIRED'));
}
console.log(bad ? `\n${bad} mutant(s) did not behave as required.` : '\nall mutants behaved as required (control survived, every real mutant killed)');
process.exit(bad ? 1 : 0);
