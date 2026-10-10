/* Phase 2F-5 — the migration, run in a REAL Postgres (supabase/phase2f5_deal_sync.sql + its rollback).

   Builds a scratch database with the live shape (pipeline.sql + the Phase 0/1 columns, the 2E history triggers,
   zoho_sync.sql, the 2F-4 migration), applies 2F-5 twice, and checks what the deal engine relies on:
     · opportunities.zoho_stage is nullable and writing it alone records NO stage history and stamps nothing;
       the engine's Zoho apply (stage, status, probability, zoho_stage, updated_at — no Pipeline context) records
       one history row with source 'unknown', exactly as the old pull did
     · zoho_deal_baseline upserts on opportunity_id; one OPEN conflict per deal + field (a second is refused); a
       resolved one is kept and a new one can open; both go with their deal
     · a processed inbound event can be 'synced' / 'conflict' with an outcome (2F-4's checks still hold)
     · the rollback removes only what 2F-5 added (no deal value changes) and the migration can be applied again
   Needs psql and a server; skipped when there is none (same switches as phase2-opportunity-events.pg.test.js). */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_p2f5_' + process.pid;
const run = (db, sql) => {
  const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status));
  return r.stdout.trim();
};
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the 2F-5 migration against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f);

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const refused = (sql, re) => { try { q(sql); } catch (e) { assert.ok(re.test(e.message), e.message); return; } throw new Error('not refused: ' + sql); };

run('postgres', `do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end $$;`);
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, SB('pipeline.sql'));
  q(`create table app_settings (key text primary key, value jsonb, updated_at timestamptz);
     alter table opportunities add column owner_email text, add column origin_type text, add column origin_id text, add column origin_key text,
       add column updated_by text, add column zoho_id text;`);
  file(DB, SB('phase2_opportunity_events.sql'));
  file(DB, SB('zoho_sync.sql'));
  file(DB, SB('phase2f4_inbound_identity.sql'));
  q(`insert into opportunities (id, dealer_id, title, stage, status, value, expected_close, zoho_id) values
     ('00000000-0000-0000-0000-0000000000b1', gen_random_uuid(), 'Linked deal', 'contacted', 'open', 100, '2026-11-01', 'Z1'),
     ('00000000-0000-0000-0000-0000000000b2', gen_random_uuid(), 'Other deal', 'quoted', 'open', 50, '2026-12-01', 'Z2');`);
  const O1 = '00000000-0000-0000-0000-0000000000b1', O2 = '00000000-0000-0000-0000-0000000000b2';
  const before = q(`select md5(string_agg(id||stage||status||value||coalesce(expected_close::text,'')||coalesce(zoho_id,''), '|' order by id)) from opportunities`);
  const evBefore = q(`select count(*) from opportunity_events`);

  t('the migration applies, and applies again unchanged', () => {
    file(DB, SB('phase2f5_deal_sync.sql')); file(DB, SB('phase2f5_deal_sync.sql'));
    assert.strictEqual(q(`select is_nullable from information_schema.columns where table_name='opportunities' and column_name='zoho_stage'`), 'YES');
    assert.strictEqual(q(`select count(*) from zoho_deal_baseline`), '0');
    assert.strictEqual(q(`select md5(string_agg(id||stage||status||value||coalesce(expected_close::text,'')||coalesce(zoho_id,''), '|' order by id)) from opportunities`), before, 'a deal changed');
    assert.strictEqual(q(`select count(*) from opportunity_events`), evBefore, 'history was written by the migration');
  });

  t('writing zoho_stage alone records no stage history and stamps nothing', () => {
    q(`update opportunities set zoho_stage='Value Proposition' where id='${O1}'`);
    assert.strictEqual(q(`select count(*) from opportunity_events`), evBefore);
    assert.strictEqual(q(`select coalesce(stage_changed_at::text,'-') from opportunities where id='${O1}'`), '-');
  });

  t('the engine\'s Zoho apply (no Pipeline context) records ONE history row, source unknown — as the old pull did', () => {
    q(`begin; select set_config('request.headers', '{}', true); update opportunities set stage='quoted', status='open', probability=0.6, zoho_stage='Negotiation/Review', updated_at=now() where id='${O1}'; commit;`);
    assert.strictEqual(q(`select kind||'|'||from_stage||'|'||to_stage||'|'||source||'|'||changed_by from opportunity_events where opportunity_id='${O1}' and kind='change'`), 'change|contacted|quoted|unknown|unknown');
    assert.notStrictEqual(q(`select coalesce(stage_changed_at::text,'-') from opportunities where id='${O1}'`), '-');
  });

  t('baseline: upsert on opportunity_id; jsonb base keeps per-field values', () => {
    q(`insert into zoho_deal_baseline (opportunity_id, zoho_id, base) values ('${O1}','Z1','{"stage":"contacted","zoho_stage":"Value Proposition","amount":100,"close_date":"2026-11-01"}')
       on conflict (opportunity_id) do update set base=excluded.base, updated_at=now()`);
    q(`insert into zoho_deal_baseline (opportunity_id, zoho_id, base) values ('${O1}','Z1','{"stage":"quoted","zoho_stage":"Negotiation/Review","amount":100,"close_date":"2026-11-01"}')
       on conflict (opportunity_id) do update set base=excluded.base, updated_at=now()`);
    assert.strictEqual(q(`select count(*)||'|'||(base->>'zoho_stage') from zoho_deal_baseline group by base`), '1|Negotiation/Review');
  });

  t('one Zoho Deal id belongs to at most ONE HCPS deal: a second baseline with the same Zoho id is refused', () => {
    refused(`insert into zoho_deal_baseline (opportunity_id, zoho_id) values ('${O2}','Z1')`, /zoho_deal_baseline_zoho_uniq/);
    assert.strictEqual(q(`select count(*) from pg_indexes where indexname='zoho_deal_baseline_zoho_idx'`), '0');
  });

  t('conflicts: one OPEN per deal + field; a resolved one is kept and a new one may open; unknown kinds/fields refused', () => {
    q(`insert into zoho_deal_conflicts (opportunity_id, zoho_id, field, kind, base_value, hcps_value, zoho_value) values ('${O1}','Z1','amount','both_changed','100','150','175')`);
    refused(`insert into zoho_deal_conflicts (opportunity_id, zoho_id, field, kind) values ('${O1}','Z1','amount','both_changed')`, /zoho_deal_conflicts_one_open/);
    q(`insert into zoho_deal_conflicts (opportunity_id, zoho_id, field, kind) values ('${O1}','Z1','stage','unmapped_stage')`);
    q(`update zoho_deal_conflicts set status='resolved', resolved_at=now(), resolution='both sides agree again' where opportunity_id='${O1}' and field='amount'`);
    q(`insert into zoho_deal_conflicts (opportunity_id, zoho_id, field, kind) values ('${O1}','Z1','amount','both_changed')`);
    assert.strictEqual(q(`select count(*) from zoho_deal_conflicts where opportunity_id='${O1}' and field='amount'`), '2');
    refused(`insert into zoho_deal_conflicts (opportunity_id, field, kind) values ('${O1}','title','both_changed')`, /check/);
    refused(`insert into zoho_deal_conflicts (opportunity_id, field, kind) values ('${O1}','amount','zoho_wins')`, /check/);
    refused(`insert into zoho_deal_conflicts (opportunity_id, field, kind, status) values ('${O2}','amount','both_changed','closed')`, /check/);
  });

  t('an inbound Deal event can end synced / conflict with its outcome (2F-4 checks still hold)', () => {
    const id = q(`select (hcps_zoho_capture_event('{"event_key":"k-z1","entity":"deals","entity_id":"Z1","zoho_id":"Z1","status":"pending"}'::jsonb))->>'id'`);
    q(`update zoho_sync_queue set classification='external', class_reason='x', classified_at=now() where id=${id}`);
    q(`update zoho_sync_queue set status='conflict', outcome='amount changed on both sides — conflict, neither side changed', processed_at=now() where id=${id}`);
    q(`update zoho_sync_queue set status='synced', outcome='amount 100 → 250' where id=${id}`);
    refused(`update zoho_sync_queue set status='ignored' where id=${id}`, /zoho_sync_queue_echo_check/);
  });

  t('a deleted deal takes its baseline and conflicts with it', () => {
    q(`insert into zoho_deal_baseline (opportunity_id, zoho_id) values ('${O2}','Z2'); insert into zoho_deal_conflicts (opportunity_id, field, kind) values ('${O2}','close_date','no_baseline')`);
    q(`delete from opportunities where id='${O2}'`);
    assert.strictEqual(q(`select count(*) from zoho_deal_baseline where opportunity_id='${O2}'`) + q(`select count(*) from zoho_deal_conflicts where opportunity_id='${O2}'`), '00');
  });

  t('rollback removes exactly what 2F-5 added — no deal value changes — and the migration applies again', () => {
    const vals = q(`select string_agg(id||stage||status||value, '|' order by id) from opportunities`);
    const evs = q(`select count(*) from opportunity_events`);
    file(DB, SB('phase2f5_deal_sync_rollback.sql'));
    assert.strictEqual(q(`select count(*) from information_schema.tables where table_name in ('zoho_deal_baseline','zoho_deal_conflicts')`), '0');
    assert.strictEqual(q(`select count(*) from information_schema.columns where (table_name='opportunities' and column_name='zoho_stage') or (table_name='zoho_sync_queue' and column_name='outcome')`), '0');
    assert.strictEqual(q(`select string_agg(id||stage||status||value, '|' order by id) from opportunities`), vals);
    assert.strictEqual(q(`select count(*) from opportunity_events`), evs, 'the rollback wrote history');
    file(DB, SB('phase2f5_deal_sync.sql'));
    assert.strictEqual(q(`select count(*) from information_schema.tables where table_name in ('zoho_deal_baseline','zoho_deal_conflicts')`), '2');
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
}
console.log(`\nPhase 2F-5 migration (Postgres): ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
