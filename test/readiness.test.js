/* Launch readiness — behaviour suite. Executes the real _readiness.js (or a mutated copy of it). */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const SRC = path.join(__dirname, '..', 'netlify', 'functions', '_readiness.js');

function load(src){
  const m = new Module(SRC, module); m.filename = SRC; m.paths = module.paths;
  m._compile(src, SRC); return m.exports;
}

let pass = 0, fail = 0; const out = [];
function t(name, fn){ try { fn(); pass++; out.push('  ok   ' + name); } catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); } }
function eq(a, b, what){ if(JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
const has = (r, check) => r.exceptions.some(e => e.check === check);
const sev = (r, check) => (r.exceptions.find(e => e.check === check) || {}).severity;

function run(src){
  const R = load(src || fs.readFileSync(SRC, 'utf8'));
  pass = 0; fail = 0; out.length = 0;
  const row = o => Object.assign({ code: 'A1', base_price: 10, image: '/x.jpg', description: 'd' }, o || {});
  const sku = o => Object.assign({ manufacturer: 'm', code: 'A1', status: 'active', base_price: 10 }, o || {});
  const page = (codes, o) => Object.assign({ manufacturer: 'm', page_key: 'p', status: 'published', skus: codes.map(c => ({ sku: c })) }, o || {});
  const listing = o => Object.assign({ slug: 'm', name: 'M', hasData: true, freight: { summary: 'x' } }, o || {});
  const GS = { id: 20, run_at: '2026-10-13', fingerprint: 'abc', later_failed: 4 };
  const full = o => Object.assign({ slug: 'm', listing: listing(), catalog: [row()], skus: [sku()], pages: [page(['A1'])],
    meta: { record_authoritative: true }, gold_standard: GS }, o || {});

  t('a complete line is gold_standard at 100%', () => {
    const r = R.lineReadiness(full());
    eq(r.status, 'gold_standard', 'status'); eq(r.completion, 100, 'completion'); eq(r.blockers, 0, 'blockers');
  });
  t('later failed runs are history, not the status', () => {
    const r = R.lineReadiness(full());
    eq(r.status, 'gold_standard', 'status'); eq(sev(r, 'later_runs_failed'), 'info', 'severity'); eq(r.gold_standard.later_failed, 4, 'kept');
  });
  t('legacy rows with no master record are a blocker, never "empty"', () => {
    const r = R.lineReadiness(full({ skus: [], gold_standard: null }));
    eq(r.status, 'blocked', 'status'); eq(sev(r, 'not_migrated'), 'blocker', 'sev'); eq(r.stages.master, 0, 'master stage');
  });
  t('a line with nothing anywhere is no_data at 0%', () => {
    const r = R.lineReadiness({ slug: 'z', listing: listing({ hasData: false }), catalog: null, skus: [] });
    eq(r.status, 'no_data', 'status'); eq(r.completion, 0, 'completion');
  });
  t('listed with hasData:true but nothing to show is a blocker', () => {
    const r = R.lineReadiness({ slug: 'd', listing: listing(), catalog: [], skus: [] });
    eq(sev(r, 'listed_without_rows'), 'blocker', 'sev');
  });
  t('rows that are not listed are unreachable — blocker', () => {
    const r = R.lineReadiness(full({ listing: null }));
    eq(sev(r, 'not_listed'), 'blocker', 'sev'); eq(r.stages.visible, 0, 'visible');
  });
  t('an active SKU with no price is a blocker', () => {
    const r = R.lineReadiness(full({ skus: [sku({ base_price: null })] }));
    eq(sev(r, 'active_sku_without_price'), 'blocker', 'sev');
  });
  t('a discontinued tombstone with no price is not a blocker', () => {
    const r = R.lineReadiness(full({ skus: [sku(), sku({ code: 'OLD', status: 'discontinued', base_price: null })] }));
    eq(has(r, 'active_sku_without_price'), false, 'flag');
  });
  t('parity error blocks', () => { eq(sev(R.lineReadiness(full({ meta: { record_authoritative: true, record_resync_error: 'parity: A1' } })), 'parity_error'), 'blocker', 'sev'); });
  t('authority OFF is reported', () => { eq(sev(R.lineReadiness(full({ meta: {} })), 'record_not_authoritative'), 'warn', 'sev'); });
  t('enriched stage counts only VISIBLE pages', () => {
    const r = R.lineReadiness(full({ catalog: [row(), row({ code: 'B2' })], skus: [sku(), sku({ code: 'B2' })],
      pages: [page(['A1']), page(['B2'], { page_key: 'q', status: 'draft' })] }));
    eq(r.stages.enriched, 50, 'enriched'); eq(r.counts.visible_page_skus, 1, 'visible');
  });
  t('a disabled page claims nothing', () => {
    const r = R.lineReadiness(full({ pages: [page(['A1'], { disabled: true })] }));
    eq(r.stages.enriched, 0, 'enriched');
  });
  t('a discontinued page is visible', () => { eq(R.lineReadiness(full({ pages: [page(['A1'], { status: 'discontinued' })] })).stages.enriched, 100, 'enriched'); });
  t('codes match normalised (case and punctuation)', () => {
    const r = R.lineReadiness(full({ catalog: [row({ code: 'mp-p08' })], skus: [sku({ code: 'MP-P08' })], pages: [page(['MPP08'])] }));
    eq(r.stages.master, 100, 'master'); eq(r.stages.enriched, 100, 'enriched');
  });
  t('deferred enrichment is info, not warn', () => {
    const r = R.lineReadiness(full({ pages: [], meta: { record_authoritative: true, deferrals: ['content pages deferred'] } }));
    eq(sev(r, 'active_skus_without_visible_page'), 'info', 'sev');
  });
  t('undeferred missing pages warn', () => { eq(sev(R.lineReadiness(full({ pages: [] })), 'active_skus_without_visible_page'), 'warn', 'sev'); });
  t('duplicate catalog codes warn', () => { eq(sev(R.lineReadiness(full({ catalog: [row(), row()] })), 'catalog_duplicate_codes'), 'warn', 'sev'); });
  t('unpriced catalog rows lower the catalog stage', () => {
    const r = R.lineReadiness(full({ catalog: [row(), row({ code: 'B', base_price: 0 })], skus: [sku(), sku({ code: 'B' })], pages: [page(['A1', 'B'])] }));
    eq(r.stages.catalog, 50, 'catalog'); eq(has(r, 'catalog_unpriced_rows'), true, 'flag');
  });
  t('a missing image file is a blocker (zero broken images)', () => {
    eq(sev(R.lineReadiness(full({ missing_image_files: ['A1'] })), 'image_file_missing'), 'blocker', 'sev');
  });
  t('no image set warns', () => { eq(sev(R.lineReadiness(full({ catalog: [row({ image: '' })] })), 'catalog_rows_without_image'), 'warn', 'sev'); });
  t('an open regression fix warns', () => { eq(sev(R.lineReadiness(full({ open_regression_fixes: 1 })), 'open_regression_fix'), 'warn', 'sev'); });
  t('no freight terms warns', () => { eq(sev(R.lineReadiness(full({ listing: listing({ freight: undefined }) })), 'no_freight_terms'), 'warn', 'sev'); });
  t('no gold standard → not verified, in_progress', () => {
    const r = R.lineReadiness(full({ gold_standard: null })); eq(r.stages.verified, 0, 'verified'); eq(r.status, 'in_progress', 'status'); eq(r.completion, 80, 'completion');
  });
  t('blockers come first', () => {
    const r = R.lineReadiness(full({ listing: null, pages: [] })); eq(r.exceptions[0].severity, 'blocker', 'first');
  });

  // ---- the matrix
  t('matrix unions every layer (a master-only line still appears)', () => {
    const m = R.launchMatrix({ manufacturers: [listing()], catalogs: { m: [row()] }, skus: [sku({ manufacturer: 'x' })] });
    eq(m.lines.map(l => l.slug), ['m', 'x'], 'slugs');
  });
  t('an alias is applied only when passed, and is reported', () => {
    const noAlias = R.launchMatrix({ catalogs: { gce: [row()] }, skus: [sku({ manufacturer: 'ohio-medical' })] });
    eq(noAlias.lines.map(l => l.slug), ['gce', 'ohio-medical'], 'kept apart');
    const m = R.launchMatrix({ aliases: { gce: 'ohio-medical' }, catalogs: { gce: [row()] }, skus: [sku({ manufacturer: 'ohio-medical' })] });
    eq(m.lines.map(l => l.slug), ['ohio-medical'], 'merged'); eq(sev(m.lines[0], 'slug_alias_applied'), 'warn', 'reported');
  });
  t('gold standard comes from lines[slug]', () => {
    const m = R.launchMatrix({ manufacturers: [listing()], catalogs: { m: [row()] }, skus: [sku()], pages: [page(['A1'])],
      meta: [{ slug: 'm', record_authoritative: true }], lines: { m: { gold_standard: GS } } });
    eq(m.lines[0].status, 'gold_standard', 'status'); eq(m.summary.gold_standard, 1, 'summary');
  });
  t('platform completion averages only lines with data', () => {
    const m = R.launchMatrix({ manufacturers: [listing(), listing({ slug: 'e', hasData: false })], catalogs: { m: [row()] }, skus: [sku()], pages: [page(['A1'])],
      meta: [{ slug: 'm', record_authoritative: true }], lines: { m: { gold_standard: GS } } });
    eq(m.summary.no_data, 1, 'no_data'); eq(m.summary.platform_completion, 100, 'platform');
  });
  t('exclude drops a line (Golden has its own portal)', () => {
    eq(R.launchMatrix({ manufacturers: [listing(), listing({ slug: 'golden' })], exclude: ['golden'] }).lines.map(l => l.slug), ['m'], 'slugs');
  });
  t('an unmeasured master is never "not migrated" and never a %', () => {
    const r = R.lineReadiness(full({ skus: [], measured: { master: false } }));
    eq(has(r, 'not_migrated'), false, 'no false blocker'); eq(r.stages.master, null, 'stage'); eq(r.completion, null, 'completion');
    eq(r.status, 'partial_measurement', 'status'); eq(r.unmeasured, ['master'], 'unmeasured');
  });
  t('without the master, catalog codes stand in for enrichment coverage', () => {
    const r = R.lineReadiness(full({ skus: [], measured: { master: false }, catalog: [row(), row({ code: 'B2' })] }));
    eq(r.stages.enriched, 50, 'enriched'); eq(sev(r, 'active_skus_without_visible_page'), 'warn', 'B2 flagged');
  });
  t('a blocker still wins over a partial measurement', () => {
    eq(R.lineReadiness(full({ listing: null, measured: { runs: false } })).status, 'blocked', 'status');
  });
  t('platform % is not claimed when a line is partial', () => {
    const m = R.launchMatrix({ manufacturers: [listing()], catalogs: { m: [row()] }, pages: [page(['A1'])], measured: { master: false, runs: false } });
    eq(m.summary.platform_completion, null, 'platform'); eq(m.summary.partial_measurement, 1, 'count');
  });
  t('null input does not throw', () => { eq(R.launchMatrix(null).lines.length, 0, 'empty'); eq(R.lineReadiness(null).status, 'no_data', 'line'); });

  return { pass, fail, report: out.join('\n') };
}
module.exports = { run, SRC };
if(require.main === module){ const r = run(); console.log(r.report); console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed'); process.exit(r.fail ? 1 : 0); }
