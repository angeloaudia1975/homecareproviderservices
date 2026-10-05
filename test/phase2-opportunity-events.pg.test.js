/* Phase 2E — the opportunity history trigger, run in a REAL Postgres (supabase/phase2_opportunity_events.sql).

   The fake database in phase0-mock.js can't run triggers, so this suite builds a scratch database with the
   live shape of `opportunities` (supabase/pipeline.sql + the Phase 0/1 columns and the owner-email trigger),
   applies the 2E migration, and drives every writer the way it really writes:
     · the Pipeline (pipeline-api add / update — it sends x-hcps-source / x-hcps-actor, which PostgREST hands
       to the database as request.headers)
     · visit approval (_opps.js insert with an origin key, "ignore duplicates")
     · the Zoho pull (zoho-autosync / zoho-api PATCH: stage, status, probability, updated_at — no context)
   Needs psql and a server; skipped when there is none.
     PGTEST_PSQL (default: psql)  PGHOST / PGPORT / PGUSER as usual
   e.g. PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/claude-0 PGPORT=55432 PGUSER=postgres node test/phase2-opportunity-events.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_p2e_' + process.pid;
const run = (db, sql) => {
  const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status));
  return r.stdout.trim();
};
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the trigger against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }

const MIG = path.join(__dirname, '..', 'supabase', 'phase2_opportunity_events.sql');
// The migration ends with `notify pgrst` (harmless) — psql runs it as is.
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const rows = sql => { const o = q(sql); return o ? o.split('\n').map(l => l.split('|')) : []; };
// One PostgREST request = one transaction with request.headers set (exactly what PostgREST does).
const asPipeline = (actor, sql) => q(`begin; select set_config('request.headers', '${JSON.stringify({ 'x-hcps-source': 'pipeline', 'x-hcps-actor': actor })}', true); ${sql}; commit;`);
const asOther = (headers, sql) => q(`begin; select set_config('request.headers', '${JSON.stringify(headers || {})}', true); ${sql}; commit;`);
const ev = id => rows(`select kind, coalesce(from_stage,'-'), coalesce(to_stage,'-'), coalesce(from_status,'-'), coalesce(to_status,'-'), coalesce(value::text,'-'), changed_by, source from opportunity_events where opportunity_id='${id}' order by changed_at, kind desc`);

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  // ---- the live shape, before 2E ----
  file(DB, path.join(__dirname, '..', 'supabase', 'pipeline.sql'));
  q(`create table app_settings (key text primary key, value jsonb, updated_at timestamptz);
     create table staff_users (email text primary key, rep_name text, active boolean default true);
     insert into staff_users values ('greg@hcps.us','Greg Campbell',true),('angelo@hcps.us','Angelo Audia',true);
     alter table opportunities add column owner_email text, add column origin_type text, add column origin_id text, add column origin_key text,
       add column manufacturer text, add column product text, add column quantity numeric, add column contact_id uuid, add column next_step text,
       add column next_step_date date, add column updated_by text, add column zoho_id text;
     create unique index opportunities_origin_once on opportunities (origin_type, origin_id, origin_key);
     create or replace function hcps_staff_email_for(n text) returns text language sql stable as $$ select email from staff_users where lower(rep_name)=lower(btrim(n)) limit 1 $$;
     create or replace function hcps_opportunity_owner_email() returns trigger language plpgsql as $$ begin
       if tg_op='INSERT' then if new.owner_email is null then new.owner_email := hcps_staff_email_for(new.owner_rep); end if;
       elsif new.owner_rep is distinct from old.owner_rep and new.owner_email is not distinct from old.owner_email then new.owner_email := hcps_staff_email_for(new.owner_rep); end if;
       return new; end $$;
     create trigger hcps_opportunity_owner_email before insert or update on opportunities for each row execute function hcps_opportunity_owner_email();`);
  // Deals that exist before 2E (their past moves were never recorded).
  q(`insert into opportunities (id, dealer_id, title, stage, status, value, owner_rep, source, created_at) values
     ('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 'Old open deal', 'quoted', 'open', 1000, 'Greg Campbell', 'manual', now() - interval '200 days'),
     ('00000000-0000-0000-0000-0000000000a2', gen_random_uuid(), 'Old won deal', 'won', 'won', 2500, 'Greg Campbell', 'manual', now() - interval '300 days'),
     ('00000000-0000-0000-0000-0000000000a3', gen_random_uuid(), 'Old Zoho deal', 'contacted', 'open', 700, 'Angelo Audia', 'manual', now() - interval '90 days');
     update opportunities set zoho_id = 'Z-3' where id = '00000000-0000-0000-0000-0000000000a3';`);
  file(DB, MIG);
  const A1 = '00000000-0000-0000-0000-0000000000a1', A2 = '00000000-0000-0000-0000-0000000000a2', A3 = '00000000-0000-0000-0000-0000000000a3';

  t('baseline: one starting entry per existing deal, marked as a baseline (no move, no invented past)', () => {
    assert.deepStrictEqual(ev(A1), [['baseline', '-', 'quoted', '-', 'open', '1000', 'system', 'baseline']]);
    assert.deepStrictEqual(ev(A2), [['baseline', '-', 'won', '-', 'won', '2500', 'system', 'baseline']]);
    assert.strictEqual(q(`select count(*) from opportunity_events`), '3');
    assert.strictEqual(q(`select count(*) from opportunity_events where kind <> 'baseline'`), '0', 'a baseline posing as a move');
    assert.strictEqual(q(`select count(*) from opportunity_events where from_stage is not null or from_status is not null`), '0');
    // The flag is on, nothing else touched.
    assert.strictEqual(q(`select value->>'conversion' from app_settings where key='phase2_flags'`), 'true');
  });

  t('re-running the migration adds no second baseline and changes no deal', () => {
    const before = q(`select md5(string_agg(id::text||stage||status||value||coalesce(stage_changed_at::text,''), ',' order by id)) from opportunities`);
    file(DB, MIG); file(DB, MIG);
    assert.strictEqual(q(`select count(*) from opportunity_events where kind='baseline'`), '3');
    assert.strictEqual(q(`select md5(string_agg(id::text||stage||status||value||coalesce(stage_changed_at::text,''), ',' order by id)) from opportunities`), before);
  });

  t('a Pipeline stage edit (pipeline-api update) writes exactly one event, attributed to who made it', () => {
    asPipeline('greg@hcps.us', `update opportunities set stage='won', status='won', probability=1, updated_at=now(), updated_by='greg@hcps.us', stage_changed_at=now() where id='${A1}'`);
    const e = ev(A1);
    assert.strictEqual(e.length, 2);
    assert.deepStrictEqual(e[1], ['change', 'quoted', 'won', 'open', 'won', '1000', 'greg@hcps.us', 'pipeline']);
  });

  t('a replay (the same stage again), a value-only edit or a title edit writes nothing', () => {
    asPipeline('greg@hcps.us', `update opportunities set stage='won', status='won', probability=1, updated_at=now(), updated_by='greg@hcps.us' where id='${A1}'`);
    asPipeline('greg@hcps.us', `update opportunities set value=1500, updated_at=now() where id='${A1}'`);
    asPipeline('greg@hcps.us', `update opportunities set title='Renamed', notes='x' where id='${A1}'`);
    assert.strictEqual(ev(A1).length, 2);
  });

  t('a status-only change is one event; stage and status together are still one', () => {
    asPipeline('angelo@hcps.us', `update opportunities set status='lost' where id='${A2}'`);
    const e = ev(A2); assert.strictEqual(e.length, 2); assert.deepStrictEqual(e[1].slice(0, 5), ['change', 'won', 'won', 'won', 'lost']);
  });

  t('a Zoho-pulled stage change (no context sent) is one event, with source and person "unknown" — and stamps stage_changed_at', () => {
    assert.strictEqual(q(`select stage_changed_at is null from opportunities where id='${A3}'`), 't');
    // Exactly what zoho-autosync / zoho-api pull_deals PATCH: stage, status, probability, updated_at. The
    // last person to edit it in the Pipeline (updated_by) is NOT the one who moved it in Zoho.
    q(`update opportunities set updated_by='angelo@hcps.us' where id='${A3}'`);
    asOther({ 'content-type': 'application/json', prefer: 'return=minimal' }, `update opportunities set stage='quoted', status='open', probability=0.6, updated_at=now() where id='${A3}'`);
    const e = ev(A3);
    assert.strictEqual(e.length, 2);
    assert.deepStrictEqual(e[1], ['change', 'contacted', 'quoted', 'open', 'open', '700', 'unknown', 'unknown']);
    assert.strictEqual(q(`select stage_changed_at is not null from opportunities where id='${A3}'`), 't');
    // The same pull again (Zoho unchanged): nothing new.
    asOther({}, `update opportunities set stage='quoted', status='open', probability=0.6, updated_at=now() where id='${A3}'`);
    assert.strictEqual(ev(A3).length, 2);
    // Context that isn't the Pipeline's is ignored, not trusted.
    asOther({ 'x-hcps-source': 'zoho', 'x-hcps-actor': 'someone@else' }, `update opportunities set stage='won', status='won' where id='${A3}'`);
    assert.deepStrictEqual(ev(A3)[2].slice(6), ['unknown', 'unknown']);
  });

  t('a deal created from a visit gets one "created" entry (source visit, its creator); a replayed approval adds nothing', () => {
    const ins = `insert into opportunities (dealer_id, title, stage, status, value, probability, owner_rep, owner_email, source, created_by, updated_by, origin_type, origin_id, origin_key)
      values ('00000000-0000-0000-0000-00000000d001', '2 x PR519', 'identified', 'open', 1798, 0.1, 'Greg Campbell', 'greg@hcps.us', 'visit', 'Greg Campbell', 'greg@hcps.us', 'visit_report', 'v-1', 'o1')
      on conflict (origin_type, origin_id, origin_key) do nothing`;
    q(ins); q(ins); q(ins);
    const id = q(`select id from opportunities where origin_id='v-1'`);
    assert.deepStrictEqual(ev(id), [['created', '-', 'identified', '-', 'open', '1798', 'greg@hcps.us', 'visit']]);
    // The legacy visit path (no origin, source 'visit', a name in created_by).
    q(`insert into opportunities (dealer_id, title, stage, source, owner_rep, created_by, notes, status) values (gen_random_uuid(), 'Legacy visit deal', 'identified', 'visit', 'Greg Campbell', 'Greg Campbell', 'From dealer visit', 'open')`);
    const l = q(`select id from opportunities where title='Legacy visit deal'`);
    assert.deepStrictEqual(ev(l)[0].slice(0, 1).concat(ev(l)[0].slice(6)), ['created', 'greg campbell', 'visit']);
  });

  t('a deal added on the Pipeline page: "created" with source pipeline; added with no context: source unknown', () => {
    asPipeline('greg@hcps.us', `insert into opportunities (dealer_id, title, stage, status, value, owner_rep, source, created_by) values (gen_random_uuid(), 'Added in Pipeline', 'contacted', 'open', 400, 'Greg Campbell', 'manual', 'Greg Campbell')`);
    const p = q(`select id from opportunities where title='Added in Pipeline'`);
    assert.deepStrictEqual(ev(p), [['created', '-', 'contacted', '-', 'open', '400', 'greg@hcps.us', 'pipeline']]);
    q(`insert into opportunities (dealer_id, title, stage, status, value, source) values (gen_random_uuid(), 'Console insert', 'identified', 'open', 1, 'manual')`);
    const c = q(`select id from opportunities where title='Console insert'`);
    assert.deepStrictEqual(ev(c)[0].slice(6), ['unknown', 'unknown']);
  });

  t('a history problem never blocks the deal write (bad context is ignored; a failing insert only warns)', () => {
    q(`begin; select set_config('request.headers', 'not json', true); update opportunities set stage='contacted' where id='${A1}'; commit;`);
    assert.strictEqual(q(`select stage from opportunities where id='${A1}'`), 'contacted');
    assert.strictEqual(ev(A1).length, 3);
    // Even with the history table unwritable, the deal still moves.
    q(`alter table opportunity_events add constraint p2e_block check (source <> 'unknown') not valid`);
    q(`update opportunities set stage='quoted' where id='${A1}'`);
    assert.strictEqual(q(`select stage from opportunities where id='${A1}'`), 'quoted');
    q(`alter table opportunity_events drop constraint p2e_block`);
  });

  t('the owner-email trigger and the Zoho push columns are untouched; history never lands on opportunities', () => {
    assert.strictEqual(q(`select owner_email from opportunities where title='Added in Pipeline'`), 'greg@hcps.us');
    const cols = q(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='opportunities'`);
    assert.ok(!/event|history/.test(cols), cols);
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
}
console.log(`\nPhase 2E history trigger (Postgres): ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
