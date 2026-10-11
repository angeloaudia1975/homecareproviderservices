/* Manufacturer Center Phase 6 — supabase/mc_phase6_append_only.sql in a REAL Postgres. Builds the same scratch
   database as mc-guard.pg.test.js (Phases 1–2 applied), applies the Phase 6 file twice, then proves: runs and
   decisions cannot be rewritten, deleted or truncated; a single-use decision can be spent exactly once; the
   freeze guard and the regression_fix path still work; the file's own check table reads ok. Skipped without Postgres. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mc6_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres for the Phase 6 SQL (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const refused = sql => { try { q(sql); } catch (e) { assert.ok(/append_only/.test(e.message), e.message); return; } throw new Error('NOT refused: ' + sql); };
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql'));
  file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_backfill.sql')); file(DB, SB('mc_phase2_freeze_guard.sql'));
  q(`insert into mfr_verification_runs(manufacturer,phase,result,checks,fingerprint) values ('bemis','baseline','pass','[]','abc')`);
  let out;
  t('phase 6 applies, and applies again; its own check table reads ok on every row', () => {
    file(DB, SB('mc_phase6_append_only.sql')); out = file(DB, SB('mc_phase6_append_only.sql'));
    const rows = out.trim().split('\n').filter(l => /\|/.test(l));
    assert.ok(rows.length >= 7, out); rows.forEach(l => assert.ok(/\|ok$/.test(l), 'check row failed: ' + l));
  });
  t('a verification run is never rewritten, deleted or truncated', () => {
    refused(`update mfr_verification_runs set result='fail'`); refused(`update mfr_verification_runs set fingerprint='zzz'`);
    refused(`delete from mfr_verification_runs`); refused(`truncate mfr_verification_runs`);
    assert.strictEqual(q(`select count(*)||'|'||min(result)||'|'||min(fingerprint) from mfr_verification_runs`), '1|pass|abc');
  });
  t('a decision is never rewritten, deleted or truncated (reason, values, kind, who)', () => {
    const id = q(`select min(id) from mfr_decisions`);
    refused(`update mfr_decisions set reason='changed' where id=${id}`); refused(`update mfr_decisions set hcps_value='{"x":1}' where id=${id}`);
    refused(`update mfr_decisions set kind='exception' where id=${id}`); refused(`delete from mfr_decisions where id=${id}`); refused(`truncate mfr_decisions`);
  });
  t('a single-use decision (gate approval / regression_fix) is spent exactly once, and nothing else can change with it', () => {
    const id = q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('pedifix','gate:stage','acceptance','approve','p','{"plan_hash":"a"}') returning id`);
    refused(`update mfr_decisions set used_at=now(), reason='sneaky' where id=${id}`);
    q(`update mfr_decisions set used_at=now(), used_by='president' where id=${id}`);
    refused(`update mfr_decisions set used_at=now() where id=${id}`); refused(`update mfr_decisions set used_at=null where id=${id}`);
    assert.strictEqual(q(`select (used_at is not null)||'|'||used_by||'|'||reason from mfr_decisions where id=${id}`), 'true|president|approve');
  });
  t('inserting new runs and decisions still works', () => {
    q(`insert into mfr_verification_runs(manufacturer,phase,result,checks) values ('pedifix','pre','pass','[]')`);
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('pedifix','uom','interpretation','x','p')`);
  });
  t('the freeze guard and the regression_fix path still work with Phase 6 installed', () => {
    assert.throws(() => q(`update product_skus set base_price=1 where manufacturer='bemis'`), /line_frozen/);
    const fix = q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','base_price','regression_fix','test','p') returning id`);
    q(`begin; select set_config('request.headers','{"x-hcps-regression-fix":"${fix}"}', true); update product_skus set base_price=base_price where manufacturer='bemis'; update mfr_decisions set used_at=now(), used_by='p' where id=${fix}; rollback;`);
  });
} finally { run('postgres', `drop database if exists ${DB}`); }
console.log(`mc phase 6 append-only (Postgres): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
