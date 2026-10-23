#!/usr/bin/env node
/* Launch readiness — offline / read-only runner for the go-live matrix (netlify/functions/_readiness.js).

   node scripts/catalog-readiness.js --shop <path to homecareproviderservicesordering> [--snapshot snap.json]
        [--public] [--alias gce=ohio-medical] [--exclude golden] [--out dir]

   Inputs, all READ-ONLY:
     --shop      the storefront repo: public/data/manufacturers.json + public/data/<slug>.json, and checks every
                 local image path exists (zero broken images).
     --snapshot  JSON from supabase/readiness_snapshot.sql (run by Angelo in a read-only session):
                 { skus:[...], pages:[...], meta:[...], runs:[...], decisions:[...] }. product_skus and the MC
                 tables are closed to the anon key, so commercial/verification stages need this.
     --public    also read product_content + manufacturer_meta with the PUBLIC anon key the storefront ships
                 (env PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON). GET only. Ignored for tables a snapshot gives.
   Output: <out>/launch-readiness.json and <out>/launch-readiness.md. Never writes anywhere else. */
const fs = require('fs');
const path = require('path');
const R = require('../netlify/functions/_readiness.js');
const { goldStandardOf } = require('../netlify/functions/_mc.js');

function args(argv) {
  const a = { alias: [], exclude: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--public') a.public = true;
    else if (k === '--alias' || k === '--exclude') a[k.slice(2)].push(argv[++i]);
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function publicRead(table, select) {
  const url = process.env.PUBLIC_SUPABASE_URL, key = process.env.PUBLIC_SUPABASE_ANON;
  if (!url || !key) throw new Error('--public needs PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON');
  const r = await fetch(`${url}/rest/v1/${table}?select=${select}`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`);   // a failed read is an error, never an empty layer (§17)
  return r.json();
}

function loadShop(shop) {
  const data = path.join(shop, 'public', 'data');
  const manufacturers = JSON.parse(fs.readFileSync(path.join(data, 'manufacturers.json'), 'utf8'));
  const catalogs = {}, missing_images = {};
  for (const f of fs.readdirSync(data).filter(f => f.endsWith('.json') && f !== 'manufacturers.json')) {
    const slug = f.replace(/\.json$/, '');
    const rows = JSON.parse(fs.readFileSync(path.join(data, f), 'utf8'));
    if (!Array.isArray(rows)) continue;
    catalogs[slug] = rows;
    for (const r of rows) {
      const img = String((r && r.image) || '').split('?')[0];
      if (!img || /^https?:/i.test(img)) continue;
      if (!fs.existsSync(path.join(shop, 'public', img))) (missing_images[slug] = missing_images[slug] || []).push(R.normCode(r.code));
    }
  }
  return { manufacturers, catalogs, missing_images };
}

function markdown(m, meta) {
  const L = [];
  L.push('# Partner 360 — manufacturer launch readiness', '', `Generated ${meta.generated} · sources: ${meta.sources.join(', ')}`, '');
  const s = m.summary;
  L.push(`**Launch-ready: ${s.launch_ready} of ${s.launch_ready_of} lines** (Gold Standard + no blocker + dealer checkout verified).`, '');
  L.push(`Average stage completion ${s.average_stage_completion == null ? 'not claimed (partial measurement)' : s.average_stage_completion + '%'} — an equal-weight average of the five stage percentages over the ${s.average_over_lines} lines with data${s.excluded_no_data.length ? ' (excluded, no data: ' + s.excluded_no_data.join(', ') + ')' : ''}. It is NOT a launch-ready percentage. Gold Standard ${s.gold_standard} · blocked ${s.blocked} · in progress ${s.in_progress} · no data ${s.no_data}.`, '');
  L.push('"Listed" means present in manufacturers.json with rows — not that an approved dealer sees prices or can order.', '');
  L.push('| Line | Status | Launch-ready | Stage avg | Catalog | Master | Enriched | Listed | Verified | Rows | Master active | Blockers |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of m.lines) L.push(`| ${l.name} | ${l.status} | ${l.launch_ready ? 'yes' : 'no'} | ${l.completion == null ? 'partial' : l.completion + '%'} | ${['catalog','master','enriched','listed','verified'].map(k => l.stages[k] == null ? '—' : l.stages[k] + '%').join(' | ')} | ${l.counts.catalog_rows} | ${l.counts.master_active} | ${l.blockers} |`);
  L.push('', '## Exceptions', '');
  for (const l of m.lines) {
    if (!l.exceptions.length) continue;
    L.push(`### ${l.name} (${l.slug})`);
    for (const e of l.exceptions) L.push(`- **${e.severity}** \`${e.check}\` — ${e.detail}${e.count ? ` (${e.count}: ${e.codes.slice(0, 12).join(', ')}${e.count > 12 ? ', …' : ''})` : ''}`);
    L.push('');
  }
  if (meta.missing.length) L.push('## Not measured in this run', '', ...meta.missing.map(x => '- ' + x), '');
  return L.join('\n');
}

async function main() {
  const a = args(process.argv);
  if (!a.shop) { console.error('usage: --shop <ordering repo> [--snapshot file] [--public] [--alias a=b] [--exclude slug] [--out dir]'); process.exit(2); }
  const shop = loadShop(a.shop);
  const snap = a.snapshot ? JSON.parse(fs.readFileSync(a.snapshot, 'utf8')) : {};
  const sources = ['shop repo ' + path.resolve(a.shop)], missing = [];
  let pages = snap.pages, metaRows = snap.meta;
  if (snap.skus) sources.push('snapshot ' + a.snapshot);
  if (a.public) {
    if (!pages) { pages = await publicRead('product_content', 'manufacturer,page_key,status,disabled,skus'); sources.push('public product_content'); }
    if (!metaRows) { metaRows = await publicRead('manufacturer_meta', 'slug,record_authoritative,record_resync_error,frozen,deferrals'); sources.push('public manufacturer_meta'); }
  }
  if (!snap.skus) missing.push('master record (product_skus) — closed to the public key; run supabase/readiness_snapshot.sql read-only and pass --snapshot');
  if (!snap.runs) missing.push('verification runs (Gold Standard) — same snapshot');
  if (!pages) missing.push('enrichment pages — pass --public or a snapshot');
  const runsBy = {}, fixesBy = {};
  for (const r of snap.runs || []) (runsBy[r.manufacturer] = runsBy[r.manufacturer] || []).push(r);
  for (const d of snap.decisions || []) if (d.kind === 'regression_fix' && !d.used_at) fixesBy[d.manufacturer] = (fixesBy[d.manufacturer] || 0) + 1;
  const lines = {};
  for (const s of new Set([...Object.keys(runsBy), ...Object.keys(fixesBy)])) lines[s] = { gold_standard: goldStandardOf(runsBy[s] || []), open_regression_fixes: fixesBy[s] || 0 };
  const aliases = Object.fromEntries(a.alias.map(x => x.split('=')));
  const m = R.launchMatrix({ manufacturers: shop.manufacturers, catalogs: shop.catalogs, missing_images: shop.missing_images,
    skus: snap.skus || [], pages: pages || [], meta: metaRows || [], lines, aliases, exclude: a.exclude,
    measured: { master: !!snap.skus, pages: !!pages, runs: !!snap.runs } });
  const meta = { generated: new Date().toISOString(), sources, missing, aliases };
  const out = a.out || '.';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'launch-readiness.json'), JSON.stringify(Object.assign({ meta }, m), null, 2));
  fs.writeFileSync(path.join(out, 'launch-readiness.md'), markdown(m, meta));
  console.log(`launch-ready ${m.summary.launch_ready}/${m.summary.launch_ready_of} · stage avg ${m.summary.average_stage_completion ?? 'partial'}% over ${m.summary.average_over_lines} · ${m.lines.length} lines · blocked ${m.summary.blocked} → ${path.join(out, 'launch-readiness.md')}`);
}
main().catch(e => { console.error('readiness failed: ' + e.message); process.exit(1); });
