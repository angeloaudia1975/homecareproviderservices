/* P0 (2026-10-23, homecareproviderservicesordering issue #2) — test helper. The storefront's public
   catalog files no longer carry prices: their commercial half lives in the private table
   catalog_file_commercial, which these tests cannot read (and which must never be committed — both
   repositories are public). Tests that need a line's FULL catalog file (as the server sees it after
   restoring the commercial row) read the last priced copy from the ordering repository's git history
   (P0_BASE_REF), and this helper refuses if that copy's public half no longer equals the file in the
   ordering tree — so a test can never run on a stale catalog.
     fullFile(slug)      → the full file (parsed)
     fullFilePath(slug)  → a temp file holding the original text byte for byte (mutation harnesses
                           anchor on its exact formatting) */
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const ORD = process.env.ORDER_REPO || path.join(__dirname, '..', '..', 'homecareproviderservicesordering');
const REF = process.env.P0_BASE_REF || '4b1bad3';
const CC = require(path.join(__dirname, '..', 'netlify', 'functions', '_catalog_commercial.js'));
const cache = {};
function originalText(slug) {
  if (cache[slug]) return cache[slug];
  const cur = path.join(ORD, 'public', 'data', slug + '.json');
  const pub = JSON.parse(fs.readFileSync(cur, 'utf8'));
  if (CC.commercialKeysIn(pub).length) return (cache[slug] = fs.readFileSync(cur, 'utf8'));   // an ordering tree from before the strip
  let txt;
  try { txt = execFileSync('git', ['-C', ORD, 'show', `${REF}:public/data/${slug}.json`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { throw new Error(`p0-fullfile: cannot read ${slug}.json at ${REF} from ${ORD} (fetch that commit, or set P0_BASE_REF)`); }
  if (JSON.stringify(CC.splitCatalogFile(JSON.parse(txt)).public) !== JSON.stringify(pub))
    throw new Error(`p0-fullfile: the public ${slug}.json no longer matches ${REF} — move P0_BASE_REF to the last priced commit`);
  return (cache[slug] = txt);
}
const fullFile = slug => JSON.parse(originalText(slug));
function fullFilePath(slug) {
  const p = path.join(os.tmpdir(), `p0-full-${process.pid}-${slug}.json`);
  fs.writeFileSync(p, originalText(slug)); return p;
}
module.exports = { fullFile, fullFilePath, ORD, REF };
