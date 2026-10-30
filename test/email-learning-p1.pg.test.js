/* HCPS Smart Email Learning, Phase 1 — supabase/email_learning_p1_capture.sql in a REAL Postgres (synthetic data only):
   install checks; RULE 19 (anon / authenticated nothing, service_role SELECT only, functions service_role only);
   the guard refuses every write that is not one of the three functions (owner included, service_role with a forged
   marker included); a send is recorded once, by the same author, for the same dealer; the original never changes;
   purge clears all text after 12 months and only then; a second run of the migration is safe; rollback refuses with rows.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/email-learning-p1.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_el1_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SQL = process.env.EL1_SQL || path.join(__dirname, '..', 'supabase', 'email_learning_p1_capture.sql');
const RB = path.join(__dirname, '..', 'supabase', 'email_learning_p1_capture_rollback.sql');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 2).join(' | ')); } }
const q = sql => run(DB, sql);
const as = (role, sql) => run(DB, `set role ${role}; ${sql}`);
const refused = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('refused for another reason: ' + e.message.split('\n')[0]); return; } throw new Error('expected a refusal'); };
const call = (fn, o) => JSON.parse(as('service_role', `select public.${fn}('${JSON.stringify(o).replace(/'/g, "''")}'::jsonb)::text`));
const ANG = 'angelo@hcps.test', DEALER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const draft = (o) => call('hcps_email_draft_create', Object.assign({ author_email: ANG, dealer_id: DEALER, email_type: 'previsit_headsup', template: 'previsit',
  generator: 'routes-api', subject: 'HCPS will be in your area — Tuesday, March 3', body: 'Hi Pat,\n\nI will be in Sampletown on Tuesday.\n\nSam Rep\nHCPS' }, o || {}));

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  q(`do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$`);
  q(`alter role service_role bypassrls`);   // as on Supabase: the server role bypasses RLS (anon / authenticated do not)
  q(`create table app_settings (key text primary key, value jsonb); insert into app_settings values ('phase2_flags','{"adhoc_visit":true}')`);
  q(`grant usage on schema public to anon, authenticated, service_role`);

  let checks;
  t('install: every check ok', () => {
    const out = file(DB, SQL).trim().split('\n').filter(l => /^\d+\|/.test(l));
    checks = out.map(l => l.split('|'));
    assert.strictEqual(checks.length, 7, out.join('\n'));
    for (const c of checks) assert.strictEqual(c[c.length - 1], 't', 'check ' + c.join(' | '));
  });
  t('the static safe-update rule: every UPDATE in the file carries a WHERE clause; no DELETE statement', () => {
    const src = fs.readFileSync(SQL, 'utf8').replace(/--[^\n]*/g, '');
    const updates = src.split(/;\s*/).filter(s => /\bupdate\s+public\./i.test(s));
    assert.ok(updates.length >= 2); for (const u of updates) assert.ok(/\bwhere\b/i.test(u), u.slice(0, 120));
    assert.ok(!/\bdelete\s+from\b/i.test(src));
  });
  t('RULE 19: anon and authenticated can neither read nor write the table nor call the functions', () => {
    for (const r of ['anon', 'authenticated']) {
      refused(() => as(r, 'select count(*) from public.email_drafts'), /permission denied/);
      refused(() => as(r, `select public.hcps_email_draft_create('{}'::jsonb)`), /permission denied/);
      refused(() => as(r, `select public.hcps_email_draft_record_send('{}'::jsonb)`), /permission denied/);
      refused(() => as(r, `select public.hcps_email_draft_purge_expired()`), /permission denied/);
    }
  });
  let id;
  t('create: a draft is stored with its fingerprint; nothing sent', () => {
    const r = draft(); assert.ok(r.ok && /^[0-9a-f-]{36}$/.test(r.id)); id = r.id;
    const row = q(`select email_type||'|'||generator||'|'||(sent_at is null)||'|'||(original_sha256 = public.hcps_email_draft_sha(original_subject, original_body))||'|'||
                   (content_expires_at between now() + interval '364 days' and now() + interval '367 days') from public.email_drafts where id='${id}'`);
    assert.strictEqual(row, 'previsit_headsup|routes-api|true|true|true');
  });
  t('create: bad type / generator / author / dealer id / empty text are refused', () => {
    refused(() => draft({ email_type: 'spam' }), /check constraint/);
    refused(() => draft({ generator: 'browser' }), /check constraint/);
    refused(() => draft({ author_email: 'Not An Email' }), /check constraint/);
    refused(() => draft({ dealer_id: 'd-greg' }), /email_draft_bad_request/);
    refused(() => draft({ body: '   ' }), /email_draft_bad_request/);
    refused(() => draft({ subject: 'x'.repeat(301) }), /check constraint/);
  });
  t('service_role: SELECT works; a direct insert / update / delete / truncate is refused', () => {
    assert.ok(+as('service_role', 'select count(*) from public.email_drafts') >= 1);
    refused(() => as('service_role', `insert into public.email_drafts (author_email,email_type,template,generator,original_subject,original_body,original_sha256)
      values ('${ANG}','follow_up','x','ai-email-api','s','b','${'0'.repeat(64)}')`), /permission denied/);
    refused(() => as('service_role', `update public.email_drafts set edited = true where true`), /permission denied/);
    refused(() => as('service_role', `delete from public.email_drafts where true`), /permission denied/);
    refused(() => as('service_role', `truncate public.email_drafts`), /permission denied/);
  });
  t('service_role with a forged marker still cannot write (the guard needs the owner\'s rights too)', () => {
    refused(() => as('service_role', `select set_config('hcps.email_draft_op','send',false); update public.email_drafts set edited = true where true`), /permission denied|email_draft_guard/);
  });
  t('owner without the marker: insert / update / delete / truncate refused by the guard', () => {
    refused(() => q(`insert into public.email_drafts (author_email,email_type,template,generator,original_subject,original_body,original_sha256)
      values ('${ANG}','follow_up','x','ai-email-api','s','b','${'0'.repeat(64)}')`), /email_draft_guard/);
    refused(() => q(`update public.email_drafts set original_body = 'changed' where id='${id}'`), /email_draft_guard/);
    refused(() => q(`delete from public.email_drafts where id='${id}'`), /email_draft_guard/);
    refused(() => q(`truncate public.email_drafts`), /email_draft_guard/);
  });
  t('owner WITH the send marker cannot change the original draft', () => {
    refused(() => q(`select set_config('hcps.email_draft_op','send',true); update public.email_drafts set original_body = 'x', sent_at = now(),
      sent_subject='s', sent_body='b', sent_sha256='${'0'.repeat(64)}', edited=true, recipient_count=1 where id='${id}'`), /changes only the sent fields/);
  });
  t('record_send: another author, another dealer, a missing draft and a junk id are refused with a status, nothing written', () => {
    const base = { draft_id: id, author_email: ANG, dealer_id: DEALER, subject: 'S', body: 'B', recipient_count: 1 };
    assert.strictEqual(call('hcps_email_draft_record_send', Object.assign({}, base, { author_email: 'greg@hcps.test' })).status, 'author_mismatch');
    assert.strictEqual(call('hcps_email_draft_record_send', Object.assign({}, base, { dealer_id: OTHER })).status, 'dealer_mismatch');
    assert.strictEqual(call('hcps_email_draft_record_send', Object.assign({}, base, { dealer_id: null })).status, 'dealer_mismatch');
    assert.strictEqual(call('hcps_email_draft_record_send', Object.assign({}, base, { draft_id: '33333333-3333-4333-8333-333333333333' })).status, 'not_found');
    assert.strictEqual(call('hcps_email_draft_record_send', Object.assign({}, base, { draft_id: "x'; drop table email_drafts; --" })).status, 'not_found');
    assert.strictEqual(q(`select count(*) from public.email_drafts where sent_at is not null`), '0');
  });
  t('record_send: the edited version is kept once; the original is unchanged; edited = true', () => {
    const before = q(`select original_subject||'|'||original_body||'|'||original_sha256 from public.email_drafts where id='${id}'`);
    const r = call('hcps_email_draft_record_send', { draft_id: id, author_email: ANG.toUpperCase(), dealer_id: DEALER, subject: 'Visiting Sampletown Tuesday',
      body: 'Hi Pat,\n\nI\'ll be in Sampletown Tuesday morning.\n\nSam Rep\nHCPS', recipient_count: 2 });
    assert.deepStrictEqual(r, { ok: true, status: 'recorded', edited: true });
    assert.strictEqual(q(`select original_subject||'|'||original_body||'|'||original_sha256 from public.email_drafts where id='${id}'`), before);
    assert.strictEqual(q(`select sent_subject||'|'||recipient_count||'|'||edited from public.email_drafts where id='${id}'`), 'Visiting Sampletown Tuesday|2|true');
  });
  t('record_send: a second send of the same draft is not recorded again', () => {
    const r = call('hcps_email_draft_record_send', { draft_id: id, author_email: ANG, dealer_id: DEALER, subject: 'Other', body: 'Other', recipient_count: 1 });
    assert.strictEqual(r.status, 'already_sent');
    assert.strictEqual(q(`select sent_subject from public.email_drafts where id='${id}'`), 'Visiting Sampletown Tuesday');
  });
  t('record_send: sent unchanged → edited = false; a draft with no dealer matches a send with no dealer', () => {
    const d = draft({ dealer_id: null, email_type: 'follow_up', template: 'follow_up', generator: 'ai-email-api' });
    const r = call('hcps_email_draft_record_send', { draft_id: d.id, author_email: ANG, dealer_id: null,
      subject: 'HCPS will be in your area — Tuesday, March 3', body: 'Hi Pat,\n\nI will be in Sampletown on Tuesday.\n\nSam Rep\nHCPS', recipient_count: 1 });
    assert.deepStrictEqual(r, { ok: true, status: 'recorded', edited: false });
    assert.strictEqual(q(`select edited::text from public.email_drafts where id='${d.id}'`), 'false', 'the stored flag matches');
  });
  t('purge: nothing is cleared before 12 months; after, all text is cleared once and the record stays', () => {
    assert.strictEqual(as('service_role', 'select public.hcps_email_draft_purge_expired()'), '0');
    // Age one draft (owner, with the purge marker's sibling: a test-only re-date through a temporary trigger bypass).
    q(`alter table public.email_drafts disable trigger email_draft_guard; update public.email_drafts set content_expires_at = now() - interval '1 day' where id='${id}';
       alter table public.email_drafts enable trigger email_draft_guard`);
    assert.strictEqual(as('service_role', 'select public.hcps_email_draft_purge_expired()'), '1');
    assert.strictEqual(q(`select coalesce(original_subject,'∅')||coalesce(original_body,'∅')||coalesce(sent_subject,'∅')||coalesce(sent_body,'∅')||'|'||
      (content_purged_at is not null)||'|'||email_type||'|'||edited from public.email_drafts where id='${id}'`), '∅∅∅∅|true|previsit_headsup|true');
    assert.strictEqual(as('service_role', 'select public.hcps_email_draft_purge_expired()'), '0');
    assert.strictEqual(call('hcps_email_draft_record_send', { draft_id: id, author_email: ANG, dealer_id: DEALER, subject: 'x', body: 'y' }).status, 'already_sent');
  });
  t('a purged draft can never get text back (owner with the purge marker)', () => {
    refused(() => q(`select set_config('hcps.email_draft_op','purge',true); update public.email_drafts set original_body = 'back' where id='${id}'`), /email_draft_guard/);
  });
  t('the migration runs a second time without error and changes no row', () => {
    const before = q(`select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from public.email_drafts x`);
    file(DB, SQL);
    assert.strictEqual(q(`select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from public.email_drafts x`), before);
  });
  t('the capture switch is never turned on by the migration', () => {
    assert.strictEqual(q(`select value::text from app_settings where key='phase2_flags'`), '{"adhoc_visit": true}');
  });
  t('rollback refuses while drafts are stored', () => { refused(() => file(DB, RB), /rollback refused/); });
  t('rollback on an empty install removes everything', () => {
    const DB2 = DB + '_rb'; run('postgres', `drop database if exists ${DB2}`); run('postgres', `create database ${DB2}`);
    try {
      run(DB2, `do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if; end $$;
        create table app_settings (key text primary key, value jsonb)`);
      file(DB2, SQL); file(DB2, RB);
      assert.strictEqual(run(DB2, `select to_regclass('public.email_drafts') is null and to_regprocedure('public.hcps_email_draft_create(jsonb)') is null`), 't');
    } finally { run('postgres', `drop database if exists ${DB2}`); }
  });
} finally { run('postgres', `drop database if exists ${DB}`); }
console.log(`\nEmail learning P1 (Postgres): ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
