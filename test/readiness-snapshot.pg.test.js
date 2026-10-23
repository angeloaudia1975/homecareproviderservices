/* supabase/readiness_snapshot.sql against a scratch database shaped like the project (the same stub + real migrations
   test/mc-guard.pg.test.js uses). Proves: it runs on the real schema, it is read-only (every table's contents are
   identical before and after), it carries no wholesale price, and its output feeds _readiness.js. Needs psql and a
   server; skipped when there is none. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_ready_' + process.pid;
const ROOT = path.join(__dirname, '..');
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };

try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP readiness-snapshot.pg: no postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const ALL = `select md5(string_agg(t, '|' order by t)) from (
  select to_jsonb(p)::text t from product_skus p union all select to_jsonb(c)::text from product_content c
  union all select to_jsonb(m)::text from manufacturer_meta m union all select to_jsonb(r)::text from mfr_verification_runs r
  union all select to_jsonb(d)::text from mfr_decisions d) x`;

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, path.join(__dirname, 'mc-guard.stub.sql'));
  file(DB, path.join(ROOT, 'migrate-phase2-product-skus.sql'));
  file(DB, path.join(__dirname, 'mc-guard.data.sql'));
  file(DB, path.join(__dirname, 'mc-content.stub.sql'));
  file(DB, path.join(ROOT, 'supabase', 'mc_phase1_foundation.sql'));
  q(`alter table product_content add column if not exists disabled boolean default false, add column if not exists published_at timestamptz`);
  q(`insert into product_skus(manufacturer, code, base_price, msrp, map, status) values
       ('zz-test','P1',123.45,200,180,'active'),('zz-test','P2',null,null,null,'active'),('zz-test','OLD',9.99,null,null,'discontinued'),
       ('golden','G1',500,null,null,'active') on conflict do nothing`);
  q(`insert into product_content(manufacturer, page_key, status, skus) values ('zz-test','p1','published','[{"sku":"P1"}]'::jsonb)`);
  q(`insert into mfr_verification_runs(manufacturer, phase, result, checks, fingerprint, run_at, run_by) values ('zz-test','post','pass','{}'::jsonb,'abc', now(), 'test')`);

  let snap;
  t('the snapshot runs on the real schema and touches nothing', () => {
    const before = q(ALL); snap = JSON.parse(file(DB, path.join(ROOT, 'supabase', 'readiness_snapshot.sql'))); assert.strictEqual(q(ALL), before);
  });
  t('it is one read-only statement (no insert/update/delete/ddl/function call)', () => {
    const sql = require('fs').readFileSync(path.join(ROOT, 'supabase', 'readiness_snapshot.sql'), 'utf8').replace(/--.*$/gm, '');
    assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|truncate|perform|execute)\b/i.test(sql), 'write keyword found');
    assert.strictEqual(sql.split(';').filter(s => s.trim()).length, 1, 'more than one statement');
  });
  t('it carries no wholesale price — only priced / unpriced', () => {
    const z = snap.skus.filter(s => s.manufacturer === 'zz-test');
    assert.deepStrictEqual(z.map(s => s.base_price).sort(), [1, 1, null].sort());
    assert.ok(!JSON.stringify(snap).includes('123.45'), 'a dealer price leaked');
    assert.ok(z.every(s => !('msrp' in s) && !('map' in s)), 'MSRP/MAP values leaked');
  });
  t('Golden is excluded', () => assert.ok(!snap.skus.some(s => s.manufacturer === 'golden')));
  t('its output feeds the readiness matrix', () => {
    const R = require('../netlify/functions/_readiness.js'); const { goldStandardOf } = require('../netlify/functions/_mc.js');
    const runs = snap.runs.filter(r => r.manufacturer === 'zz-test');
    const m = R.launchMatrix({ manufacturers: [{ slug: 'zz-test', name: 'ZZ', hasData: true, freight: {} }], catalogs: { 'zz-test': [{ code: 'P1', base_price: 1, image: '/x' }, { code: 'P2', base_price: 1, image: '/y' }] },
      skus: snap.skus, pages: snap.pages, meta: snap.meta, lines: { 'zz-test': { gold_standard: goldStandardOf(runs) } } });
    const l = m.lines.find(x => x.slug === 'zz-test');
    assert.strictEqual(l.counts.master_active, 2); assert.strictEqual(l.stages.enriched, 50);
    assert.ok(l.exceptions.some(e => e.check === 'active_sku_without_price' && e.codes.includes('P2')));
    assert.ok(l.gold_standard && l.gold_standard.fingerprint === 'abc');
  });
} finally {
  run('postgres', `drop database if exists ${DB}`);
}
console.log(`\nreadiness-snapshot.pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
