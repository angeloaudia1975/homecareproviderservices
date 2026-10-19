/* HCPS Academy A2F / M7 — HCPS certificates (claim after a passed exam, verify, President-only revoke), run in a REAL
   Postgres (pg-safeupdate loaded) on top of A1, M1–M6 exactly as committed. What is tested is what Angelo would run:
   supabase/academy_a2f_m7_certificates.sql and its rollback. Skipped when there is no server.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-m7.pg.test.js
   PG17.6 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1. */
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const LOCAL = f => path.join(__dirname, 'academy', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixtureText = () => { let s = fs.readFileSync(LOCAL('fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }
const json = s => JSON.parse(s);
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const H = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const PRES = `'staff:admin@test.example'`;
const M6 = SUP('academy_a2e_m6_exam_attempts.sql');
const MIG = SUP('academy_a2f_m7_certificates.sql'), RB = SUP('academy_a2f_m7_certificates_rollback.sql');
const HQ = '00000000-0000-0000-0000-0000000000a1', OTHER = '00000000-0000-0000-0000-0000000000b1';
const TESTD = '00000000-0000-0000-0000-0000000000c1';

function base(name, withM7) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  run(name, fixtureText());
  run(name, `alter table public.dealers add column is_test boolean not null default false;
             create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
             insert into public.dealers (id, business_name, is_test) values ('${TESTD}', 'TEST Sandbox', true);`);
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                   'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql']) file(name, SUP(f));
  run(name, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
  file(name, M6);
  run(name, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true), ('owner@test.example', 'Owner', 'owner', true), ('oldpres@test.example', 'Former President', 'president', false) on conflict do nothing");
  if (withM7) file(name, MIG);
}
const course = (db, slug) => json(run(db, `select academy_content_op_create_course(${PRES}, null, ${J({ slug, title: slug, course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`)).id;
function version(db, c, extraLesson) {
  const v = json(run(db, `select academy_content_op_create_version(${PRES}, null, '${c}', '{"exam_questions":2}')`)).id;
  const qs = [];
  for (const k of ['A', 'B']) {
    const m = json(run(db, `select academy_content_op_create_module(${PRES}, null, '${v}', ${J({ title: 'Module ' + k })})`)).id;
    qs.push(json(run(db, `select academy_author_op_create_question(${PRES}, null, '${v}', ${J({ module_id: m, kind: 'single', prompt: 'Exam ' + k + ' ' + v.slice(0, 6) + '?', choices: [{ id: 'a', text: 'Right ' + k }, { id: 'b', text: 'Wrong ' + k }], answer_key: 'a', explanation: 'SECRET-EXPLANATION-' + k, objective_tags: ['topic-' + k.toLowerCase()] })})`)).id);
    const l = json(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', ${J({ title: 'Lesson ' + k, est_minutes: 10 })})`)).id;
    run(db, `select academy_author_op_set_blocks(${PRES}, '${l}', ${J([{ kind: 'text', heading: 'One', body: 'First.' }, { kind: 'text', heading: 'Two', body: 'Second.' }, { kind: 'text', heading: 'Three', body: 'Third.' }])})`);
    if (extraLesson && k === 'A') {   // a second lesson in the same module (position 2)
      const l2 = json(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', ${J({ title: 'Lesson A2', est_minutes: 10 })})`)).id;
      run(db, `select academy_author_op_set_blocks(${PRES}, '${l2}', ${J([{ kind: 'text', heading: 'One', body: 'First.' }, { kind: 'text', heading: 'Two', body: 'Second.' }, { kind: 'text', heading: 'Three', body: 'Third.' }])})`);
    }
  }
  return { v, qs };
}
const publish = (db, v) => { run(db, `select academy_content_op_move_version(${PRES}, '${v}', 'in_review')`); run(db, `select academy_publish_op_publish_version(${PRES}, '${v}', null)`); };
const q1 = (db, sql) => json(run(db, `select coalesce(to_jsonb(x), 'null') from (${sql}) x`));
const count = (db, table, where) => Number(run(db, `select count(*) from ${table}${where ? ' where ' + where : ''}`));
const N = e => e.trim().toLowerCase();
function learnerAt(db, dealer, email, code) {
  run(db, `select academy_access_op_invite(${PRES}, '${dealer}', '${email}', 'Person', 'learner')`);
  run(db, `select academy_access_op_request_code('${email}', '${H(N(email) + code)}', '${H('ip-' + email)}')`);
  return json(run(db, `select academy_access_op_verify_code('${email}', '${H(N(email) + code)}', '${H('ip-' + email)}')`)).learner_id;
}
const enrollRaw = (db, l, v) => json(run(db, `select academy_enroll_op_enroll(${PRES}, '${l}', '${v}', null)`)).id;
const lessonsOf = (db, v) => run(db, `select l.id from academy_lessons l join academy_modules m on m.id = l.module_id where m.version_id = '${v}' order by m.position, l.position`).split('\n').filter(Boolean);
// the learner finishes lessons through M5's own progress operation (only `completed` counts for the exam)
const finish = (db, l, e, ids, status) => { for (const id of ids) run(db, `select academy_progress_op_save('learner:${l}', '${e}', '${id}', '${status || 'completed'}', 0)`); };
// most tests start from an enrollment whose lessons are all complete; the lesson-gate tests use enrollRaw
const enroll = (db, l, v) => { const e = enrollRaw(db, l, v); finish(db, l, e, lessonsOf(db, v)); return e; };
const op = (db, fn, args) => json(run(db, `select academy_exam_op_${fn}(${args})`));
// test-only: move an attempt in time / write one as the owner with the operation marker (the guard lets the owner through)
const asOwner = sql => `begin; select set_config('academy.op', 'test', true); ${sql}; commit;`;
function bg(db, sql) {
  return new Promise(res => {
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ ok: code === 0, out: out.trim(), err }));
  });
}


const flags = (db, on) => run(db, `update app_settings set value = value || '{"academy_certificates": ${on}}' where key = 'phase2_flags'`);
function passAttempt(db, l, e, v, right) {
  const r = op(db, 'start', `'learner:${l}', '${e}'`); assert.strictEqual(r.ok, true, JSON.stringify(r));
  const ans = {}; for (const q of v.qs) ans[q] = right === false ? 'b' : 'a';
  const s = op(db, 'submit', `'learner:${l}', '${r.attempt_id}', ${J(ans)}`); assert.strictEqual(s.passed, right !== false, JSON.stringify(s));
  return r.attempt_id;
}
const claim = (db, l, a) => json(run(db, `select academy_cert_op_claim('learner:${l}', '${a}')`));
const verify = (db, n) => json(run(db, `select academy_cert_op_verify('${n}')`));
const revoke = (db, who, id, reason) => tryRun(db, `select academy_cert_op_revoke('staff:${who}', '${id}', '${reason}')`);

const DB = 'academy_m7_' + process.pid, DB2 = 'academy_m7rb_' + process.pid;
(async () => {
try {
  base(DB, false);
  const C = course(DB, 'golden-like'); const V = version(DB, C); publish(DB, V.v);
  const L1 = learnerAt(DB, HQ, 'one@test.example', '111111');
  const L2 = learnerAt(DB, HQ, 'two@test.example', '222222');
  const L3 = learnerAt(DB, OTHER, 'three@test.example', '333333');
  const L4 = learnerAt(DB, HQ, 'four@test.example', '444444');
  const E1 = enroll(DB, L1, V.v), E2 = enroll(DB, L2, V.v), E3 = enroll(DB, L3, V.v), E4 = enroll(DB, L4, V.v);

  await t('Static: every UPDATE / DELETE in the M7 files carries a WHERE clause (pg-safeupdate)', () => {
    for (const f of [MIG, RB]) {
      const s = fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '');
      for (const m of s.matchAll(/\b(update|delete\s+from)\s+[a-z_.]+\s[\s\S]*?;/gim)) assert.ok(/\bwhere\b/i.test(m[0]), path.basename(f) + ': ' + m[0].slice(0, 80));
    }
  });
  await t('Migration installs in one transaction; all 7 install checks true; a second run is refused', () => {
    const out = file(DB, MIG); const rows = out.split('\n').filter(l => l.includes('|'));
    assert.strictEqual(rows.length, 7, out); assert.ok(rows.every(r => r.endsWith('|t')), out);
    const again = tryRun(DB, fs.readFileSync(MIG, 'utf8')); assert.strictEqual(again.ok, false); assert.match(again.err, /already installed/);
  });
  await t('Rights: the server cannot issue / revoke through M1 or write certificates; anon nothing; helpers owner-only', () => {
    assert.match(tryRun(DB, `set role service_role; select academy_op_issue_certificate('system:grader', '00000000-0000-0000-0000-000000000001', 'X')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; select academy_op_revoke_certificate(${PRES}, '00000000-0000-0000-0000-000000000001', 'reason')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; insert into academy_certificates (cert_number) values ('HCPS-AAAA-AAAA')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; delete from academy_certificates where true`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; select academy_cert_president(${PRES})`).err, /permission denied/);
    assert.match(tryRun(DB, `set role anon; select academy_cert_op_verify('HCPS-AAAA-AAAA')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role authenticated; select academy_cert_op_claim('learner:${L1}', '00000000-0000-0000-0000-000000000001')`).err, /permission denied/);
    assert.ok(tryRun(DB, `set role service_role; select academy_cert_op_verify('HCPS-AAAA-AAAA')`).ok, 'the server calls the operations');
  });

  let AT1, CERT;
  await t('A failed attempt earns nothing (not_passed), and nothing is written', () => {
    flags(DB, true);
    const a = passAttempt(DB, L2, E2, V, false);
    assert.deepStrictEqual(claim(DB, L2, a), { ok: false, reason: 'not_passed' });
    assert.strictEqual(count(DB, 'academy_certificates'), 0);
    flags(DB, false);
  });
  await t('Switch off: a passed attempt is refused with switched_off and nothing is written', () => {
    AT1 = passAttempt(DB, L1, E1, V);
    assert.deepStrictEqual(claim(DB, L1, AT1), { ok: false, reason: 'switched_off' });
    assert.strictEqual(count(DB, 'academy_certificates'), 0);
  });
  await t('Another learner can never claim this attempt', () => {
    flags(DB, true);
    assert.match(tryRun(DB, `select academy_cert_op_claim('learner:${L2}', '${AT1}')`).err, /not this record's learner/);
    assert.match(tryRun(DB, `select academy_cert_op_claim('staff:admin@test.example', '${AT1}')`).err, /not this record's learner/);
  });
  await t('Switch on: the passed attempt earns ONE HCPS certificate — dealership from the membership, 12 months, HCPS number, audited', () => {
    const r = claim(DB, L1, AT1); assert.strictEqual(r.ok, true); assert.strictEqual(r.existing, false);
    CERT = r.certificate;
    assert.match(CERT.cert_number, /^HCPS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.strictEqual(CERT.dealer_name, 'HQ Medical'); assert.strictEqual(CERT.status, 'valid');
    assert.strictEqual(CERT.issuer, 'Home Care Provider Services (HCPS)'); assert.strictEqual(CERT.course_title, 'golden-like');
    const months = Number(run(DB, `select extract(year from age(expires_at, issued_at)) * 12 + extract(month from age(expires_at, issued_at)) from academy_certificates`));
    assert.strictEqual(months, 12);
    assert.strictEqual(count(DB, 'academy_events', `action = 'issue_certificate' and actor = 'system:grader'`), 1);
  });
  await t('Idempotent: a second claim returns the same certificate; 12 simultaneous claims by another learner make exactly one', async () => {
    const again = claim(DB, L1, AT1); assert.strictEqual(again.existing, true); assert.strictEqual(again.certificate.id, CERT.id);
    const a4 = passAttempt(DB, L4, E4, V);
    const rs = await Promise.all(Array.from({ length: 12 }, () => bg(DB, `select academy_cert_op_claim('learner:${L4}', '${a4}')`)));
    assert.ok(rs.every(r => r.ok), rs.map(r => r.err).join('\n'));
    assert.strictEqual(count(DB, 'academy_certificates', `learner_id = '${L4}'`), 1);
    assert.strictEqual(rs.filter(r => json(r.out).existing === false).length, 1);
  });
  await t('Tenant isolation: the dealership on the certificate is the learner\'s own (Other Dealer), never a caller value', () => {
    const a3 = passAttempt(DB, L3, E3, V);
    assert.strictEqual(claim(DB, L3, a3).certificate.dealer_name, 'Other Dealer');
    assert.match(tryRun(DB, `select academy_cert_op_claim('learner:${L3}', '${a3}', 'Forged Dealer')`).err, /does not exist/);
  });
  await t('Verify: public fields only (no email, score, attempt, reason); format and not-found answers; case-insensitive', () => {
    const v = verify(DB, CERT.cert_number.toLowerCase());
    assert.strictEqual(v.found, true); assert.strictEqual(v.status, 'valid'); assert.strictEqual(v.dealer_name, 'HQ Medical');
    assert.deepStrictEqual(Object.keys(v).sort(), ['cert_number', 'course_title', 'dealer_name', 'expires_at', 'found', 'issued_at', 'issuer', 'learner_name', 'revoked_at', 'status']);
    assert.ok(!/@|score|attempt|reason|enrollment/i.test(JSON.stringify(v)));
    assert.deepStrictEqual(verify(DB, 'nonsense'), { found: false, reason: 'format' });
    assert.deepStrictEqual(verify(DB, "HCPS-ZZZZ-ZZZZ"), { found: false, reason: 'not_found' });
  });
  await t('Revoke: only the active President, with a 5–500 character reason; admin, owner, a former President refused', () => {
    assert.match(revoke(DB, 'admin2@test.example', CERT.id, 'Left the company').err, /only the HCPS President/);
    assert.match(revoke(DB, 'owner@test.example', CERT.id, 'Left the company').err, /only the HCPS President/);
    assert.match(revoke(DB, 'oldpres@test.example', CERT.id, 'Left the company').err, /not an active HCPS administrator/);
    assert.match(revoke(DB, 'admin@test.example', CERT.id, 'no').err, /reason \(5 to 500/);
    assert.strictEqual(count(DB, 'academy_certificates', `status = 'revoked'`), 0);
    const r = revoke(DB, 'admin@test.example', CERT.id, 'Issued in error — wrong learner'); assert.ok(r.ok, r.err);
    const v = verify(DB, CERT.cert_number); assert.strictEqual(v.status, 'revoked'); assert.ok(v.revoked_at); assert.ok(!/error/.test(JSON.stringify(v)), 'the reason is never public');
    assert.strictEqual(count(DB, 'academy_events', `action = 'revoke_certificate' and actor = 'staff:admin@test.example'`), 1);
    assert.match(revoke(DB, 'admin@test.example', CERT.id, 'Second time').err, /already revoked/);
    const c = claim(DB, L1, AT1); assert.strictEqual(c.existing, true); assert.strictEqual(c.certificate.status, 'revoked', 'no new certificate after a revocation');
  });
  await t('Expired: past expires_at it verifies as expired (the stored status stays valid)', () => {
    const n = run(DB, `select cert_number from academy_certificates where learner_id = '${L4}'`);
    // test-only time travel: certificates are immutable (A1 trigger), so the superuser skips triggers for this one row
    run(DB, `begin; set local session_replication_role = replica; update academy_certificates set expires_at = now() - interval '1 day', issued_at = now() - interval '2 years' where learner_id = '${L4}'; commit;`);
    assert.strictEqual(verify(DB, n).status, 'expired');
  });
  await t('Ended access: a learner whose membership was ended cannot claim', () => {
    const L5 = learnerAt(DB, HQ, 'five@test.example', '555555'); const E5 = enroll(DB, L5, V.v); const a5 = passAttempt(DB, L5, E5, V);
    const m = run(DB, `select id from academy_memberships where learner_id = '${L5}'`);
    run(DB, `select academy_access_op_deactivate(${PRES}, '${m}', 'Left the dealership')`);
    const r = tryRun(DB, `select academy_cert_op_claim('learner:${L5}', '${a5}')`);
    assert.strictEqual(r.ok, false); assert.match(r.err, /access for this course has ended|not active/);
    assert.strictEqual(count(DB, 'academy_certificates', `learner_id = '${L5}'`), 0);
  });
  await t('Ended access first: a former employee cannot claim, not even to re-read an existing certificate; it stays publicly verifiable', () => {
    const L6 = learnerAt(DB, HQ, 'six@test.example', '666666'); const E6 = enroll(DB, L6, V.v); const a6 = passAttempt(DB, L6, E6, V);
    const c6 = claim(DB, L6, a6).certificate;
    const m = run(DB, `select id from academy_memberships where learner_id = '${L6}'`);
    run(DB, `select academy_access_op_deactivate(${PRES}, '${m}', 'Left the dealership')`);
    const r = tryRun(DB, `select academy_cert_op_claim('learner:${L6}', '${a6}')`);
    assert.strictEqual(r.ok, false); assert.match(r.err, /access for this course has ended|not active/);
    assert.strictEqual(verify(DB, c6.cert_number).status, 'valid', 'the record and its public verification are unchanged');
  });
  await t('Withdrawn enrollment first: an existing certificate is not returned through claim once the enrollment is withdrawn', () => {
    const L7 = learnerAt(DB, HQ, 'seven@test.example', '777777'); const E7 = enroll(DB, L7, V.v); const a7 = passAttempt(DB, L7, E7, V);
    claim(DB, L7, a7);
    run(DB, `begin; set local session_replication_role = replica; update academy_enrollments set status = 'withdrawn', completed_at = null where id = '${E7}'; commit;`);
    assert.match(tryRun(DB, `select academy_cert_op_claim('learner:${L7}', '${a7}')`).err, /withdrawn/);
  });
  await t('Direct writes are still refused by M1\'s guard (owner without a marker)', () => {
    assert.match(tryRun(DB, `update academy_certificates set status = 'valid' where id = '${CERT.id}'`).err, /academy/i);
  });
  await t('Rollback is refused while certificates exist', () => {
    const r = tryRun(DB, fs.readFileSync(RB, 'utf8')); assert.strictEqual(r.ok, false); assert.match(r.err, /rollback refused/);
  });
  await t('Rollback on an untouched install removes M7 and restores the server\'s M1 rights', () => {
    base(DB2, true);
    const out = file(DB2, RB); assert.match(out, /M7 removed\|t/);
    assert.strictEqual(Number(run(DB2, `select count(*) from pg_proc where proname like 'academy\\_cert\\_%'`)), 0);
    assert.strictEqual(run(DB2, `select has_table_privilege('service_role', 'public.academy_certificates', 'insert')`), 't');
    file(DB2, MIG);   // and it installs again
  });
} catch (e) { fail++; console.log('  FAIL setup\n       ' + String(e && e.stack || e)); }
finally {
  try { run('postgres', `drop database if exists ${DB}`); run('postgres', `drop database if exists ${DB2}`); } catch (e) {}
  console.log(`\nacademy-m7.pg: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
})();
