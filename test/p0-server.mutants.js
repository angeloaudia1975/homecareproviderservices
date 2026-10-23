/* P0 (2026-10-23) — mutation harness for the server side of the price lock-down (_pricing.js, catalog-api.js).
   Each real mutant reopens a hole and must be KILLED by test/p0-server.test.js (or, for the shared module, by
   pricing-parity's drift check against the storefront copy); the CONTROL must SURVIVE. The server's in-process
   identity check on the engine's catalog-layers read is defence in depth (the engine always asks for the file it was
   given), so it has no behavioural mutant; the same check in catalog-layers.js is mutated in the storefront harness. */
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const DIR = path.join(__dirname, '..', 'netlify', 'functions');
const M = [
  ['_pricing.js', 'CONTROL — a comment', 'const COMMERCIAL_SELECT = "manufacturer,identity_sha256,rows";', 'const COMMERCIAL_SELECT = "manufacturer,identity_sha256,rows"; /* control */', 'survive'],
  ['_pricing.js', 'a stripped file without a commercial row is priced from nothing', '  if (rows.length && !CC.commercialKeysIn(rows).length)\n    throw', '  if (false)\n    throw'],
  ['_pricing.js', 'the commercial row is ignored', '    return { file: CC.restoreCatalogFile(rows, pick.record.rows), overlay', '    return { file: rows, overlay'],
  ['_pricing.js', 'the engine is answered with the public file\'s (empty) overlay, not the record', 'file_overlay: JSON.parse(JSON.stringify(commercial.overlay))', 'file_overlay: CC.splitCatalogFile(publicFile || []).overlay'],
  ['_pricing.js', 'P0 review: the nearest stored version prices another public file', '  if (list.length)\n    throw new Error(`pricing_unavailable: ${slug}: catalog_version_not_seeded', '  if (list.length) return commercialFor(rows, [Object.assign({}, list[0], { identity_sha256: pick.identity })], slug);\n  if (false)\n    throw new Error(`pricing_unavailable: ${slug}: catalog_version_not_seeded'],
  ['_pricing.js', 'P0 review: a stored record is not checked internally', '    if (!CC.validOverlayRecord(pick.record))\n      throw', '    if (false)\n      throw'],
  ['_catalog_commercial.js', 'P0 review: a row whose fingerprint differs is still restored', "    if(catalogRowPrint(r)!==o.h) throw new Error(", "    if(false) throw new Error("],
  ['_catalog_commercial.js', 'P0 review: the version picker falls back to any stored version', "record: list.find(r=>r && r.identity_sha256===id) || null", "record: list.find(r=>r && r.identity_sha256===id) || list[0] || null"],
  ['_pricing.js', 'catalog-layers answers with every line\'s added products', 'sb("GET", `custom_products?manufacturer=eq.${enc(slug)}&select=${LAYER_SELECT.custom_products}`),', 'sb("GET", `custom_products?select=${LAYER_SELECT.custom_products}`),'],
  ['_pricing.js', 'catalog-layers answers with every line\'s saved edits', 'sb("GET", `product_overrides?manufacturer=eq.${enc(slug)}&select=${LAYER_SELECT.product_overrides}`),', 'sb("GET", `product_overrides?select=${LAYER_SELECT.product_overrides}`),'],
  ['orders-api.js', 'price_check prices a line the dealer does not carry', "      if(!orders.length) return json(400,{error:\"no orders\"});\n      const denied=await entitlementGate(orders, who.dealer_id); if(denied) return denied;\n      let priced;", "      if(!orders.length) return json(400,{error:\"no orders\"});\n      let priced;"],
  ['orders-api.js', 'create accepts a line the dealer does not carry', "      const denied=await entitlementGate(orders, who.dealer_id); if(denied) return denied;\n      /* Re-price", "      /* Re-price"],
  ['orders-api.js', 'an inactive line assignment entitles', "&active=eq.true&select=manufacturer`);\n  const carried", "&select=manufacturer`);\n  const carried"],
  ['orders-api.js', 'an unreadable line list carries everything', "  catch(e){ return json(503,{ok:false,status:\"pricing_unavailable\",error:\"the dealer's lines could not be read\"}); }", "  catch(e){ return null; }"],
  ['catalog-api.js', 'Product Catalog skips the commercial row', '  return P.fullCatalogFile(j, rec, mfr);', '  return j;'],
  ['orders-api.js', 'P0 review: a refusal echoes the priced lines', "  return missing.length ? json(403,{ok:false,status:\"not_entitled\",lines:missing}) : null;", "  return missing.length ? json(403,{ok:false,status:\"not_entitled\",lines:missing,orders}) : null;"],
];
let bad = 0;
for (const [file, name, from, to, expect] of M) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8'), n = src.split(from).length - 1;
  if (n !== 1) { console.log(`BAD ANCHOR(${n}) ${name}`); bad++; continue; }
  const MD = fs.mkdtempSync(path.join(os.tmpdir(), 'p0srv-'));
  for (const x of fs.readdirSync(DIR)) if (/\.js$/.test(x)) fs.copyFileSync(path.join(DIR, x), path.join(MD, x));
  fs.writeFileSync(path.join(MD, file), src.replace(from, to));
  let killed = false;
  /* p0-server = behaviour; pricing-parity = the module copy must equal the storefront's (drift kills any edit). */
  for (const suite of ['p0-server.test.js', 'pricing-parity.test.js']) {
    if (killed) break;
    try { execFileSync('node', [path.join(__dirname, suite)], { stdio: 'pipe', env: Object.assign({}, process.env, { CAT_ROOT: MD }) }); } catch (e) { killed = true; }
  }
  fs.rmSync(MD, { recursive: true, force: true });
  const okk = expect === 'survive' ? !killed : killed; if (!okk) bad++;
  console.log((killed ? 'killed   ' : 'SURVIVED ') + name + (okk ? '' : '   <-- WRONG'));
}
console.log(bad ? `${bad} mutant(s) did not behave as required.` : 'all mutants behaved as required (control survived, every real mutant killed)');
process.exitCode = bad ? 1 : 0;
