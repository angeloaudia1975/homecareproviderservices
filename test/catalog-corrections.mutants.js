/* Mutation check for bulk catalog corrections: each mutant weakens one rule and MUST be killed by
   test/catalog-corrections.test.js; the control changes nothing that matters and must survive. */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const F = path.join(__dirname, '..', 'netlify', 'functions', '_catalog_corrections.js');
const E = path.join(__dirname, '..', 'netlify', 'functions', '_catalog_exceptions.js');
const API = path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');
const M = [
  ['control', F, 'Pure: no database, no network.', 'Pure: no database,  no network.', true],
  ['conflict recordable', F, 'supported: c.classification !== "conflict" && !settled,', 'supported: !settled,', false],
  ['conflict accepted by decisionFor', F, 'if (!ACCEPTED.has(p.classification)) throw new Error("owner_decision");', '', false],
  ['unit difference ignored', F, 'const IDENTITY = ["name", "category", "subcategory", "family", "uom",', 'const IDENTITY = ["name", "category", "subcategory", "family",', false],
  ['any name difference is a shared part', F, 'return own.every(w => sec.has(w));', 'return true;', false],
  ['frozen line applicable', F, 'supported: false, blocked: "frozen"', 'supported: true, blocked: "frozen"', false],
  ['hand-offs applicable', F, 'supported: false, blocked: "owning_tool"', 'supported: true, blocked: "owning_tool"', false],
  ['no reason needed', F, 'if (!reason || String(reason).trim().length < 5) throw new Error("reason_required");\n  const base', 'const base', false],
  ['reopen does not reopen', F, 'return !!(d && ACCEPTED.has(reviewStatus(d)));', 'return !!d;', false],
  ['hash ignores the recorded review', F, 'p.current ? p.current.decision_id : 0]', '0]', false],
  ['queue ignores reviews', E, 'const settled = e.codes.filter(c => CC.duplicateSettled(reviews, l.slug, c));', 'const settled = [];', false],
  ['queue settles any line', E, 'CC.duplicateSettled(reviews, l.slug, c)', 'CC.duplicateSettled(reviews, "other", c) || CC.duplicateSettled(reviews, l.slug, c) || true', false],
  ['stale plan accepted', API, 'if(!b.plan_hash || b.plan_hash!==plan.plan_hash) return json(409,{error:"plan_changed"', 'if(false) return json(409,{error:"plan_changed"', false],
  ['frozen apply not refused', API, 'if(frozen.has(p.manufacturer)) return json(423,{error:"line_frozen", id,', 'if(false) return json(423,{error:"line_frozen", id,', false],
  ['dry run writes', API, 'if(b.dry_run===true) return json(200,{ok:true, dry_run:true, decisions:rows});', '', false],
  ['undo of an old decision', API, 'if(!latest || latest.id!==dec.id || CC.reviewStatus(dec)==="reopened")', 'if(false)', false],
  ['undo on frozen line', API, 'if(frozen.has(dec.manufacturer)) return json(423,', 'if(false) return json(423,', false],
  ['any role', API, 'if(me.role!=="president") return json(403,{error:"President only"});', '', false],
];
let bad = 0;
for (const [name, file, from, to, survive] of M) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.log('ANCHOR MISSING  ' + name); bad++; continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  let killed = false;
  try { execFileSync('node', [path.join(__dirname, 'catalog-corrections.test.js')], { stdio: 'ignore', timeout: 60000 }); } catch (e) { killed = true; }
  fs.writeFileSync(file, orig);
  const okk = survive ? !killed : killed; if (!okk) bad++;
  console.log((killed ? 'killed   ' : 'survived ') + name + (okk ? '' : '   <-- NOT AS REQUIRED'));
}
console.log(bad ? `\n${bad} mutant(s) did not behave as required.` : '\nall mutants behaved as required (control survived, every real mutant killed)');
process.exit(bad ? 1 : 0);
