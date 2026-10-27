/* Mutation check for the private price-list comparison and the importer's offline rule: every mutant must be killed
   by its test; the control must survive. */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const F = path.join(__dirname, '..', 'netlify', 'functions', '_source_compare.js');
const I = path.join(__dirname, '..', 'netlify', 'functions', '_catalog_import.js');
const API = path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');
const T = 'source-compare.test.js', TI = 'catalog-import.test.js';
const M = [
  ['control', F, 'Pure: no database, no network.', 'Pure: no database,  no network.', true, T],
  ['unstated fields compared', F, 'if (s[f] == null) continue;', '', false, T],
  ['derived MSRP treated as stated', F, 'if (f === "msrp" && c.msrp_derived) {', 'if (false) {', false, T],
  ['equal derived MSRP reported as a change', F, 'if (same(s[f], c[f])) notes.push(', 'if (false) notes.push(', false, T],
  ['named-account price treated as general', F, 'const scoped = rs.some(r => r.dealer_price_scope && !/^general$/i.test(String(r.dealer_price_scope)));', 'const scoped = false;', false, T],
  ['source ambiguity ignored', F, 'if (new Set(forms.map(f => JSON.stringify(f))).size > 1) {', 'if (false) {', false, T],
  ['catalog ambiguity ignored', F, 'if (new Set(cforms.map(f => JSON.stringify(f))).size > 1) {', 'if (false) {', false, T],
  ['no SHA-256 accepted', F, 'if (!src.sha256 || !/^[0-9a-f]{64}$/i.test(String(src.sha256))) return refuse(', 'if (false) return refuse(', false, T],
  ['unknown catalog version accepted', F, 'if (!i.identity) return refuse(', 'if (false) return refuse(', false, T],
  ['another line accepted', F, "if (!line.manufacturer || (line.manufacturer !== i.slug && !(i.aliases || []).includes(line.manufacturer)))", 'if (false)', false, T],
  ['removed rows dropped', F, "for (const [k, cs] of C) if (!S.has(k)) out.push(", "for (const [k, cs] of C) if (false) out.push(", false, T],
  ['figures in the answer', F, 'Object.assign({ code, state: "changed", fields, locators }, note)', 'Object.assign({ code, state: "changed", fields, locators, s, c }, note)', false, T],
  ['switched-off product compared', F, '&& p.active !== false)', ')', false, T],
  ['rule-derived MSRP compared', F, 'const stated = (v, how) => (how == null || how === "stated") ? cents(v) : null;', 'const stated = (v, how) => cents(v);', false, T],
  ['no-op rungs compared', F, '.filter(r => r[1] != null && r[0] > 1 && r[1] !== b)', '.filter(r => r[1] != null)', false, T],
  ['discounted base compared instead of the list price', F, 'const raw = p.dealer_price != null && p.dealer_price !== "" ? p.dealer_price : p.base_price', 'const raw = p.base_price != null && p.base_price !== "" ? p.base_price : p.dealer_price', false, T],
  ['a pack of 1 read as a pack', F, 'const packN = v => { const n = parseInt(v, 10); return n > 1 ? n : null; };', 'const packN = v => { const n = parseInt(v, 10); return n > 0 ? n : null; };', false, T],
  ['qty_per_pack ignored', F, 'packN(p.case_qty) || packN(p.qty_per_pack)', 'packN(p.case_qty)', false, T],
  ['unit wording ignored', F, 'worded = numeric ? null : countInWords(p.uom)', 'worded = null', false, T],
  ['wording-only pack not noted', F, 'else if (f === "case_qty" && c.case_from_words) notes.push(', 'else if (false) notes.push(', false, T],
  ['any role compares', API, 'if(me.role!=="president") return json(403,{error:"President only"});', '', false, T],
  ['unreadable catalog guessed', API, 'catch(err){ return json(409,{error:"catalog_unreadable"', 'catch(err){ L={products:[],identity:"x",source:"layers"}; } if(false){ return json(409,{error:"catalog_unreadable"', false, T],
  ['offline prices read as changes', I, 'else if (offline && b && COMMERCIAL_BA.includes(f) && was == null)', 'else if (false)', false, TI],
];
let bad = 0;
for (const [name, file, from, to, survive, test] of M) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.log('ANCHOR MISSING  ' + name); bad++; continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  let killed = false;
  try { execFileSync('node', [path.join(__dirname, test)], { stdio: 'ignore', timeout: 60000 }); } catch (e) { killed = true; }
  fs.writeFileSync(file, orig);
  const okk = survive ? !killed : killed; if (!okk) bad++;
  console.log((killed ? 'killed   ' : 'survived ') + name + (okk ? '' : '   <-- NOT AS REQUIRED'));
}
console.log(bad ? `\n${bad} mutant(s) did not behave as required.` : '\nall mutants behaved as required (control survived, every real mutant killed)');
process.exit(bad ? 1 : 0);
