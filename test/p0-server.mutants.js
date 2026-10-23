/* P0 (2026-10-23) — mutation harness for the server side of the price lock-down (_pricing.js, catalog-api.js).
   Each real mutant reopens a hole and must be KILLED by test/p0-server.test.js; the CONTROL must SURVIVE. */
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const M = [
  ['_pricing.js', 'CONTROL — a comment', 'const COMMERCIAL_SELECT = "manufacturer,rows";', 'const COMMERCIAL_SELECT = "manufacturer,rows"; /* control */', 'survive'],
  ['_pricing.js', 'a stripped file without a commercial row is priced from nothing', '  if (rows.length && !CC.commercialKeysIn(rows).length)\n    throw', '  if (false)\n    throw'],
  ['_pricing.js', 'the commercial row is ignored', '  if (row) return CC.restoreCatalogFile(rows, row.rows);', '  if (row) return rows;'],
  ['_pricing.js', 'the server prices from the public file, not the restored one', '  const file = fullCatalogFile(publicFile, commercialRec, slug);', '  const file = (fullCatalogFile(publicFile, commercialRec, slug), publicFile);'],
  ['_pricing.js', 'catalog-layers answers with every line\'s added products', 'sb("GET", `custom_products?manufacturer=eq.${enc(slug)}&select=${LAYER_SELECT.custom_products}`),', 'sb("GET", `custom_products?select=${LAYER_SELECT.custom_products}`),'],
  ['_pricing.js', 'catalog-layers answers with every line\'s saved edits', 'sb("GET", `product_overrides?manufacturer=eq.${enc(slug)}&select=${LAYER_SELECT.product_overrides}`),', 'sb("GET", `product_overrides?select=${LAYER_SELECT.product_overrides}`),'],
  ['orders-api.js', 'price_check prices a line the dealer does not carry', "      if(!orders.length) return json(400,{error:\"no orders\"});\n      const denied=await entitlementGate(orders, who.dealer_id); if(denied) return denied;\n      let priced;", "      if(!orders.length) return json(400,{error:\"no orders\"});\n      let priced;"],
  ['orders-api.js', 'create accepts a line the dealer does not carry', "      const denied=await entitlementGate(orders, who.dealer_id); if(denied) return denied;\n      /* Re-price", "      /* Re-price"],
  ['orders-api.js', 'an inactive line assignment entitles', "&active=eq.true&select=manufacturer`);\n  const carried", "&select=manufacturer`);\n  const carried"],
  ['orders-api.js', 'an unreadable line list carries everything', "  catch(e){ return json(503,{ok:false,status:\"pricing_unavailable\",error:\"the dealer's lines could not be read\"}); }", "  catch(e){ return null; }"],
  ['catalog-api.js', 'Product Catalog skips the commercial row', '  return require("./_pricing.js").fullCatalogFile(j, rec, mfr);', '  return j;'],
];
let bad = 0;
for (const [file, name, from, to, expect] of M) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8'), n = src.split(from).length - 1;
  if (n !== 1) { console.log(`BAD ANCHOR(${n}) ${name}`); bad++; continue; }
  const MD = fs.mkdtempSync(path.join(os.tmpdir(), 'p0srv-'));
  for (const x of fs.readdirSync(DIR)) if (/\.js$/.test(x)) fs.copyFileSync(path.join(DIR, x), path.join(MD, x));
  fs.writeFileSync(path.join(MD, file), src.replace(from, to));
  let killed = false;
  try { execFileSync('node', [path.join(__dirname, 'p0-server.test.js')], { stdio: 'pipe', env: Object.assign({}, process.env, { CAT_ROOT: MD }) }); } catch (e) { killed = true; }
  fs.rmSync(MD, { recursive: true, force: true });
  const okk = expect === 'survive' ? !killed : killed; if (!okk) bad++;
  console.log((killed ? 'killed   ' : 'SURVIVED ') + name + (okk ? '' : '   <-- WRONG'));
}
console.log(bad ? `${bad} mutant(s) did not behave as required.` : 'all mutants behaved as required (control survived, every real mutant killed)');
process.exitCode = bad ? 1 : 0;
