/* HCPS Smart Email Learning, Phase 3 — supabase/email_learning_p3_shapes_redact.sql in a REAL Postgres (synthetic data only),
   on top of Phase 1 + Phase 2: install checks; RULE 19 on email_draft_shapes; a shape is written once, only for the draft's
   own author; the President-only REDACT removes a rule's evidence and wording everywhere (rule, events, version snapshots),
   retires an approved rule in a new version, rejects a suggested one, and the rule can never be refreshed, approved,
   edited or restored again; the guard refuses every other route (owner without a marker, server role with a forged
   marker); Phase 2 keeps working; a second run is safe; the migration rollback refuses after a redaction and, on a clean
   database, puts the Phase 2 functions back byte for byte.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/email-learning-p3.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_el3_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const S = f => path.join(__dirname, '..', 'supabase', f);
const P1 = S('email_learning_p1_capture.sql'), P2 = S('email_learning_p2_rules.sql');
const SQL = process.env.EL3_SQL || S('email_learning_p3_shapes_redact.sql'), RB = S('email_learning_p3_shapes_redact_rollback.sql');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 8).join(' | ')); } }
const refused = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('refused for another reason: ' + e.message.split('\n')[0]); return; } throw new Error('expected a refusal'); };
const lit = o => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const PRES = 'owner@hcps.test', REP = 'rep@hcps.test';
const key = n => (n.toString(16) + '0'.repeat(32)).slice(0, 32).replace(/[^0-9a-f]/g, 'a');
const D1 = '0d000000-0000-4000-8000-000000000001', D2 = '0d000000-0000-4000-8000-000000000002', D3 = '0d000000-0000-4000-8000-000000000003';
const SECRET = 'call pat lowercase';
const W = n => ['zero','one','two','three','four','five','six','seven','eight','nine'][n % 10];   // stands for the lowercase name masking could not catch

function setup(db) {
  run('postgres', `drop database if exists ${db}`); run('postgres', `create database ${db}`);
  const q = sql => run(db, sql);
  q(`do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$`);
  q(`alter role service_role bypassrls`);
  q(`create table app_settings (key text primary key, value jsonb); insert into app_settings values ('phase2_flags','{"email_learning_capture":true}')`);
  q(`create table staff_users (email text primary key, role text, active boolean, name text);
     insert into staff_users values ('${PRES}','president',true,'Owner'),('${REP}','rep',true,'Rep')`);
  q(`grant usage on schema public to anon, authenticated, service_role`);
  file(db, P1);
  return q;
}
const fp = q => q(`select md5(string_agg(prosrc, '|' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace and proname in
  ('hcps_email_rule_guard','hcps_email_rule_president','hcps_email_rule_snapshot','hcps_email_rule_version','hcps_email_rule_note','hcps_email_rule_decide','hcps_email_profile_rollback')`);

const q = setup(DB);
const as = (role, sql) => run(DB, `set role ${role}; ${sql}`);
const call = (fn, o) => JSON.parse(as('service_role', `select public.${fn}(${lit(o)})::text`));
const mkDraft = (author, dealer) => {
  const id = JSON.parse(q(`select public.hcps_email_draft_create(${lit({ author_email: author, dealer_id: dealer, email_type: 'previsit_headsup', template: 'previsit', generator: 'routes-api',
    subject: 'Visit next week', body: 'Hi there, I hope this email finds you well. See you soon.' })})::text`)).id;
  q(`select public.hcps_email_draft_record_send(${lit({ draft_id: id, author_email: author, dealer_id: dealer, subject: 'Visit next week', body: 'Hi there, see you soon.', recipient_count: 1 })})`);
  return id;
};
const ver = () => +as('service_role', 'select public.hcps_email_rule_version()');
const ruleOf = id => JSON.parse(q(`select row_to_json(r)::text from public.email_learning_rules r where id = '${id}'`) || 'null');
let PD = [];
const note = (n, o) => call('hcps_email_rule_note', Object.assign({ rule_key: key(n), pattern_key: key(n + 500), email_type: 'previsit_headsup', kind: 'remove_phrase',
  pattern: { phrase: SECRET + ' ' + W(n) }, instruction: `Don't write “${SECRET} ${W(n)}”.`, examples: ['− ' + SECRET + ' ' + W(n)], draft_ids: PD.slice(0, 3),
  first_seen: '2026-10-01T10:00:00Z', last_seen: '2026-10-20T10:00:00Z' }, o || {}));
const decide = o => { const r = ruleOf(o.rule_id); return call('hcps_email_rule_decide', Object.assign({ by: PRES, reason: 'Matches how I write', expected_version: ver(),
  expected_status: r ? r.status : 'suggested' }, o)); };
const redact = o => { const r = /^[0-9a-f-]{36}$/.test(o.rule_id) ? ruleOf(o.rule_id) : null; return call('hcps_email_rule_redact', Object.assign({ by: PRES, reason: 'Holds a customer name', expected_version: ver(),
  expected_status: r ? r.status : 'suggested' }, o)); };

try {
  t('Phase 3 refuses to install without Phase 2', () => { refused(() => file(DB, SQL), /install Phase 2/); });
  file(DB, P2);
  const P2FP = fp(q);
  PD = [D1, D1, D2, D3].map(d => mkDraft(PRES, d));
  const REPD = mkDraft(REP, D1);
  // Rules before Phase 3: A approved (two versions), B suggested.
  const A = note(1).id; decide({ rule_id: A, decision: 'approve' }); decide({ rule_id: A, decision: 'edit', instruction: `Never write “${SECRET} again”.` });
  const B = note(2).id;

  t('install: every check ok', () => {
    const out = file(DB, SQL).trim().split('\n').filter(l => /^\d+\|/.test(l));
    assert.strictEqual(out.length, 8, out.join('\n'));
    for (const l of out) assert.ok(/\|t$/.test(l), 'check ' + l);
  });
  t('a second run is safe (every check still ok, nothing changed)', () => {
    const before = q(`select md5(string_agg(row_to_json(r)::text, '|' order by id)) from public.email_learning_rules r`);
    const out = file(DB, SQL).trim().split('\n').filter(l => /^\d+\|/.test(l));
    for (const l of out) assert.ok(/\|t$/.test(l), 'check ' + l);
    assert.strictEqual(q(`select md5(string_agg(row_to_json(r)::text, '|' order by id)) from public.email_learning_rules r`), before);
  });
  t('the static safe-update rule: every UPDATE carries a WHERE clause; no DELETE statement', () => {
    const src = fs.readFileSync(SQL, 'utf8').replace(/--[^\n]*/g, '');
    const updates = src.split(/;\s*/).filter(s => /\bupdate\s+public\./i.test(s));
    assert.ok(updates.length >= 4); for (const u of updates) assert.ok(/\bwhere\b/i.test(u), u.slice(0, 120));
    assert.ok(!/\bdelete\s+from\b/i.test(src));
  });
  t('RULE 19: anon and authenticated reach neither the shapes table nor a Phase 3 function', () => {
    for (const r of ['anon', 'authenticated']) {
      refused(() => as(r, 'select count(*) from public.email_draft_shapes'), /permission denied/);
      for (const f of ['hcps_email_draft_shape', 'hcps_email_rule_redact']) refused(() => as(r, `select public.${f}('{}'::jsonb)`), /permission denied/);
    }
  });
  t('the server role reads shapes but cannot write them; the owner without a marker is refused', () => {
    assert.strictEqual(as('service_role', 'select count(*) from public.email_draft_shapes'), '0');
    refused(() => as('service_role', `insert into public.email_draft_shapes (draft_id, author_email, ai) values ('${PD[0]}','${PRES}',true)`), /permission denied/);
    refused(() => q(`insert into public.email_draft_shapes (draft_id, author_email, ai) values ('${PD[0]}','${PRES}',true)`), /email_shape_guard/);
    refused(() => as('service_role', 'select public.hcps_email_draft_shape_guard()'), /permission denied/);
  });
  t('a shape: once, for the draft\'s own author only; bad input is a status', () => {
    { const r = call('hcps_email_draft_shape', { draft_id: PD[0], author_email: PRES, profile_version: 2, style: 'brief_direct', ai: true }); assert.strictEqual(r.status, 'recorded', JSON.stringify(r)); }
    assert.strictEqual(call('hcps_email_draft_shape', { draft_id: PD[0], author_email: PRES, profile_version: 9, style: 'consultative', ai: false }).status, 'exists');
    assert.strictEqual(q(`select profile_version || '/' || style || '/' || ai from public.email_draft_shapes where draft_id = '${PD[0]}'`), '2/brief_direct/true', 'the first record stands');
    assert.strictEqual(call('hcps_email_draft_shape', { draft_id: REPD, author_email: PRES, ai: true }).status, 'not_found', 'another author\'s draft');
    assert.strictEqual(call('hcps_email_draft_shape', { draft_id: PD[1], author_email: PRES, style: 'shouty', ai: true }).status, 'bad_request');
    assert.strictEqual(call('hcps_email_draft_shape', { draft_id: 'nope', author_email: PRES, ai: true }).status, 'bad_request');
    assert.strictEqual(call('hcps_email_draft_shape', { draft_id: PD[1], author_email: PRES, profile_version: 0, ai: false }).status, 'recorded');
    assert.strictEqual(q(`select coalesce(profile_version::text,'null') from public.email_draft_shapes where draft_id = '${PD[1]}'`), 'null', 'version 0 is no version');
    refused(() => q(`update public.email_draft_shapes set style = 'consultative' where draft_id = '${PD[0]}'`), /email_shape_guard/);
    refused(() => q(`delete from public.email_draft_shapes where draft_id = '${PD[0]}'`), /email_shape_guard/);
    refused(() => q(`truncate public.email_draft_shapes`), /email_shape_guard/);
  });
  t('redact: the active President only, with a reason, from the version and status on screen', () => {
    assert.strictEqual(redact({ rule_id: A, by: REP }).status, 'president_only');
    assert.strictEqual(redact({ rule_id: A, reason: 'x' }).status, 'reason_required');
    assert.strictEqual(redact({ rule_id: A, expected_version: ver() - 1 }).status, 'version_conflict');
    assert.strictEqual(redact({ rule_id: A, expected_status: 'suggested' }).status, 'version_conflict');
    assert.strictEqual(redact({ rule_id: 'nope', expected_status: 'approved' }).status, 'not_found');
    assert.strictEqual(ruleOf(A).redacted_at, null);
  });
  let vBefore;
  t('redacting an approved rule: evidence and wording gone everywhere, retired in a new version', () => {
    vBefore = ver();
    const r = redact({ rule_id: A }); assert.strictEqual(r.status, 'redacted'); assert.strictEqual(r.rule_status, 'retired');
    assert.strictEqual(ver(), vBefore + 1);
    const x = ruleOf(A);
    assert.deepStrictEqual(x.pattern, { redacted: true }); assert.deepStrictEqual(x.examples, []);
    assert.ok(/^Redacted by the owner/.test(x.instruction) && x.instruction === x.suggested_instruction);
    assert.strictEqual(x.redacted_by, PRES);
    const everywhere = q(`select coalesce(string_agg(row_to_json(e)::text, ' '), '') from public.email_learning_rule_events e where rule_id = '${A}'`) + ' '
      + q(`select coalesce(string_agg(row_to_json(p)::text, ' '), '') from public.email_learning_profiles p`) + ' '
      + q(`select row_to_json(r)::text from public.email_learning_rules r where id = '${A}'`);
    assert.ok(!everywhere.includes(`${SECRET} one`) && !everywhere.includes(`${SECRET} again`), 'the old wording survives somewhere');
    assert.strictEqual(q(`select action || '/' || (before->>'status') || '/' || (after->>'status') from public.email_learning_rule_events where rule_id = '${A}' and action = 'redacted'`), 'redacted/approved/retired');
    assert.strictEqual(q(`select action from public.email_learning_profiles where version = ${ver()}`), 'redact');
    assert.strictEqual(q(`select count(*) from jsonb_array_elements((select rules from public.email_learning_profiles where version = ${ver()})) e where e->>'id' = '${A}'`), '0');
    assert.strictEqual(q(`select count(*) from public.email_learning_profiles p, jsonb_array_elements(p.rules) e where e->>'id' = '${A}' and e->>'redacted' = 'true'`), '2', 'older snapshots keep a marker');
  });
  t('a redacted rule is never changed again: not by the analyser, a decision, a rollback, another redact or by hand', () => {
    assert.strictEqual(note(1, { draft_ids: PD }).status, 'redacted');
    assert.deepStrictEqual(ruleOf(A).examples, []);
    assert.strictEqual(note(7, { pattern_key: key(501) }).status, 'sibling_exists', 'the same edit is never suggested again');
    assert.strictEqual(decide({ rule_id: A, decision: 'approve' }).status, 'redacted');
    assert.strictEqual(redact({ rule_id: A }).status, 'redacted');
    const rb = call('hcps_email_profile_rollback', { to_version: 1, by: PRES, reason: 'Back to the start', expected_version: ver() });
    assert.strictEqual(rb.ok, true); assert.strictEqual(ruleOf(A).status, 'retired', 'a rollback to a version that held it leaves it out');
    refused(() => q(`update public.email_learning_rules set examples = '["− x"]' where id = '${A}'`), /email_rule_guard/);
    refused(() => as('service_role', `select set_config('hcps.email_rule_op','redact',false); update public.email_learning_rules set status = 'approved' where id = '${A}'`), /permission denied|email_rule_guard/);
    refused(() => q(`begin; select set_config('hcps.email_rule_op','decide',true); update public.email_learning_rules set decision_reason = 'changed by hand', decided_at = now() where id = '${A}'; commit;`), /email_rule_guard: a redacted rule/);
  });
  t('redacting a suggested rule rejects it, with no new version', () => {
    const v = ver(); const r = redact({ rule_id: B }); assert.strictEqual(r.rule_status, 'rejected'); assert.strictEqual(ver(), v);
    assert.ok(!q(`select coalesce(string_agg(row_to_json(e)::text, ' '), '') from public.email_learning_rule_events e`).includes(`${SECRET} two`));
  });
  t('the guard: events and versions change only through a redaction, only the parts it scrubs', () => {
    refused(() => q(`update public.email_learning_rule_events set reason = 'x' where rule_id = '${A}'`), /email_rule_guard/);
    refused(() => q(`begin; select set_config('hcps.email_rule_op','redact',true); update public.email_learning_rule_events set reason = 'x' where rule_id = '${A}'; commit;`), /email_rule_guard/);
    refused(() => q(`begin; select set_config('hcps.email_rule_op','redact',true); update public.email_learning_profiles set reason = 'x' where version = 1; commit;`), /email_rule_guard/);
    refused(() => q(`delete from public.email_learning_profiles where version = 1`), /email_rule_guard/);
  });
  t('Phase 2 keeps working after Phase 3: suggest, approve, reword, retire, roll back', () => {
    const C = note(3).id; assert.ok(C);
    assert.strictEqual(decide({ rule_id: C, decision: 'approve' }).rule_status, 'approved');
    assert.strictEqual(decide({ rule_id: C, decision: 'edit', instruction: 'Keep it short.' }).rule_status, 'approved');
    const v = ver(); assert.strictEqual(decide({ rule_id: C, decision: 'retire' }).rule_status, 'retired');
    assert.strictEqual(call('hcps_email_profile_rollback', { to_version: v, by: PRES, reason: 'Bring it back', expected_version: ver() }).ok, true);
    assert.strictEqual(ruleOf(C).status, 'approved'); assert.strictEqual(ruleOf(C).instruction, 'Keep it short.');
  });
  t('the migration rollback refuses after a redaction (nothing changed)', () => {
    const before = fp(q); refused(() => file(DB, RB), /redacted/); assert.strictEqual(fp(q), before);
    assert.notStrictEqual(before, P2FP, 'Phase 3 replaced the Phase 2 functions');
  });
  t('on a clean database the rollback puts Phase 2 back byte for byte', () => {
    const D = DB + '_r'; const q2 = setup(D);
    try {
      file(D, P2); const p2 = fp(q2); file(D, SQL); assert.notStrictEqual(fp(q2), p2);
      file(D, RB); assert.strictEqual(fp(q2), p2);
      assert.strictEqual(q2(`select to_regclass('public.email_draft_shapes') is null`), 't');
      assert.strictEqual(q2(`select count(*) from information_schema.columns where table_name = 'email_learning_rules' and column_name like 'redacted%'`), '0');
      file(D, SQL); // and Phase 3 installs again after a rollback
    } finally { run('postgres', `drop database if exists ${D}`); }
  });
} finally { run('postgres', `drop database if exists ${DB}`); }
console.log(`\nEmail learning P3 (database): ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
