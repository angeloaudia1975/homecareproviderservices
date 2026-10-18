/* HCPS Academy A2B / M5 — learner accounts and access, run in a REAL Postgres (pg-safeupdate loaded, as Supabase's API
   sessions do) on top of A1, M1, M2, M3, M3.1 and M4 exactly as committed. What is tested is what Angelo would run:
   supabase/academy_a2b_m5_learner_access.sql and its rollback. Skipped when there is no server.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-m5.pg.test.js
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
const MIG = SUP('academy_a2b_m5_learner_access.sql'), RB = SUP('academy_a2b_m5_learner_access_rollback.sql');
const HQ = '00000000-0000-0000-0000-0000000000a1', NORTH = '00000000-0000-0000-0000-0000000000a2', OTHER = '00000000-0000-0000-0000-0000000000b1';
const TESTD = '00000000-0000-0000-0000-0000000000c1';
const UID = '00000000-0000-0000-0000-00000000aaaa', UID2 = '00000000-0000-0000-0000-00000000bbbb';

function base(name) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  run(name, fixtureText());
  run(name, `alter table public.dealers add column is_test boolean not null default false;
             create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
             insert into public.dealers (id, business_name, is_test) values ('${TESTD}', 'TEST Sandbox', true);`);
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql', 'academy_c2_m4_publish_ops.sql']) file(name, SUP(f));
  run(name, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
}
const course = (db, slug) => json(run(db, `select academy_content_op_create_course(${PRES}, null, ${J({ slug, title: slug, course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`)).id;
function version(db, c) {
  const v = json(run(db, `select academy_content_op_create_version(${PRES}, null, '${c}', '{"exam_questions":2}')`)).id;
  const lessons = [];
  for (const k of ['A', 'B']) {
    const m = json(run(db, `select academy_content_op_create_module(${PRES}, null, '${v}', ${J({ title: 'Module ' + k })})`)).id;
    run(db, `select academy_author_op_create_question(${PRES}, null, '${v}', ${J({ module_id: m, kind: 'single', prompt: 'Q ' + k + ' ' + v.slice(0, 6) + '?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'a', explanation: 'x', objective_tags: ['t'] })})`);
    const l = json(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', ${J({ title: 'Lesson ' + k, est_minutes: 10 })})`)).id;
    run(db, `select academy_author_op_set_blocks(${PRES}, '${l}', ${J([{ kind: 'text', heading: 'One', body: 'First screen.' }, { kind: 'text', heading: 'Two', body: 'Second screen.' }, { kind: 'text', heading: 'Three', body: 'Third screen.' }])})`);
    lessons.push(l);
  }
  return { v, lessons };
}
const publish = (db, v) => { run(db, `select academy_content_op_move_version(${PRES}, '${v}', 'in_review')`); run(db, `select academy_publish_op_publish_version(${PRES}, '${v}', null)`); };
const q1 = (db, sql) => json(run(db, `select coalesce(to_jsonb(x), 'null') from (${sql}) x`));
const count = (db, table, where) => Number(run(db, `select count(*) from ${table}${where ? ' where ' + where : ''}`));
const events = (db, where) => count(db, 'academy_events', where);
const N = e => e.trim().toLowerCase();   // the API normalises the address before it hashes the code
const req = (db, email, code, ip) => json(run(db, `select academy_access_op_request_code('${email}', '${H(N(email) + code)}', '${H(ip || 'ip1')}')`));
const ver = (db, email, code, ip) => json(run(db, `select academy_access_op_verify_code('${email}', '${H(N(email) + code)}', '${H(ip || 'ip1')}')`));
const invite = (db, actor, dealer, email, role) => json(run(db, `select academy_access_op_invite(${actor}, '${dealer}', '${email}', 'Person ${email.split('@')[0]}', '${role || 'learner'}')`));
function bg(db, sql) {
  return new Promise(res => {
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ ok: code === 0, out: out.trim(), err }));
  });
}

const DB = 'academy_m5_' + process.pid, DB2 = 'academy_m5rb_' + process.pid;
(async () => {
try {
  base(DB);
  const C = course(DB, 'golden-like'); const V1 = version(DB, C);
  const CT = course(DB, 'test-sandbox-course'); const VT = version(DB, CT);
  const DRAFT = version(DB, course(DB, 'draft-only'));

  await t('Static: every UPDATE / DELETE in the M5 files carries a WHERE clause (pg-safeupdate)', () => {
    for (const f of [MIG, RB]) {
      const s = fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '').replace(/\bfor\s+update\b/gi, 'for_lock').replace(/\bdo\s+update\b/gi, 'do_upsert');
      for (const m of s.matchAll(/\b(update|delete\s+from)\s+[a-z_.]+\s[\s\S]*?;/gim)) assert.ok(/\bwhere\b/i.test(m[0]), path.basename(f) + ': ' + m[0].slice(0, 80));
    }
  });
  await t('Migration installs in one transaction; all 8 install checks true; a second run is refused and changes nothing', () => {
    const out = file(DB, MIG); const rows = out.split('\n').filter(l => l.includes('|'));
    assert.strictEqual(rows.length, 8, out); assert.ok(rows.every(r => r.endsWith('|t')), out);
    const again = tryRun(DB, fs.readFileSync(MIG, 'utf8')); assert.strictEqual(again.ok, false); assert.match(again.err, /already installed/);
  });
  publish(DB, V1.v); publish(DB, VT.v);

  await t('RULE 19: the server role reads the learner tables but cannot write them; anon and authenticated get nothing; no M5 helper is callable by the server', () => {
    for (const tb of ['academy_learners', 'academy_memberships', 'academy_invites', 'academy_enrollments', 'academy_progress', 'academy_sessions', 'academy_login_codes', 'academy_handoff_codes']) {
      assert.ok(tryRun(DB, `set role service_role; select count(*) from ${tb}`).ok, tb + ' readable');
      assert.strictEqual(tryRun(DB, `set role service_role; delete from ${tb} where true`).ok, false, tb + ' not deletable');
      assert.strictEqual(tryRun(DB, `set role anon; select count(*) from ${tb}`).ok, false, tb + ' closed to anon');
    }
    const ins = tryRun(DB, `set role service_role; insert into academy_learners (full_name, email) values ('X', 'x@example.com')`);
    assert.strictEqual(ins.ok, false); assert.match(ins.err, /permission denied/);
    assert.strictEqual(tryRun(DB, `set role service_role; select academy_access_end_sessions('${UID}', 'x')`).ok, false, 'helper not callable');
    assert.strictEqual(tryRun(DB, `set role authenticated; select academy_access_op_request_code('a@b.co', '${H(1)}', '${H(2)}')`).ok, false);
    assert.ok(tryRun(DB, `set role service_role; select academy_access_op_request_code('nobody@example.com', '${H(1)}', '${H(2)}')`).ok, 'the server calls an operation');
  });

  let TM, LEARNER;
  await t('HCPS invites a Training Manager; a code for an UNKNOWN address is recorded but not sent; the invited address gets one; the code signs in once and accepts the invitation', () => {
    const inv = invite(DB, PRES, HQ, 'manager@test.example', 'training_manager');
    assert.strictEqual(inv.status, 'pending'); assert.ok(!('token_hash' in inv));
    assert.deepStrictEqual(req(DB, 'stranger@example.com', '111111').send, false);
    assert.strictEqual(req(DB, 'Manager@Test.example ', '222222').send, true, 'addresses are normalised');
    const r = ver(DB, 'manager@test.example', '222222'); assert.strictEqual(r.ok, true, JSON.stringify(r));
    TM = r.learner_id;
    assert.strictEqual(q1(DB, `select role, access_type, status from academy_memberships where learner_id = '${TM}'`).role, 'training_manager');
    assert.strictEqual(q1(DB, `select status from academy_invites where id = '${inv.id}'`).status, 'accepted');
    assert.strictEqual(ver(DB, 'manager@test.example', '222222').ok, false, 'a used code never works twice');
    assert.ok(events(DB, `action in ('invite','accept_invite','sign_in','create_learner','sign_in_code_sent')`) >= 5);
  });
  await t('Wrong codes: each try counts; the 5th wrong try burns the code; an expired code fails; a new request replaces the old code', () => {
    invite(DB, `'learner:${TM}'`, HQ, 'learner@test.example');
    req(DB, 'learner@test.example', '333333');
    for (let i = 1; i <= 4; i++) assert.strictEqual(ver(DB, 'learner@test.example', '000000').reason, 'wrong');
    assert.strictEqual(ver(DB, 'learner@test.example', '000000').reason, 'expired', 'the 5th wrong try burns it');
    assert.strictEqual(ver(DB, 'learner@test.example', '333333').ok, false, 'even the right code is dead after 5 wrong tries');
    req(DB, 'learner@test.example', '444444'); req(DB, 'learner@test.example', '555555');
    assert.strictEqual(ver(DB, 'learner@test.example', '444444').ok, false, 'an older code is replaced by the newer one');
    run(DB, `update academy_login_codes set created_at = created_at - interval '1 hour', expires_at = created_at - interval '1 hour' + interval '1 second' where email = 'learner@test.example' and used_at is null and burned_at is null`);
    assert.strictEqual(ver(DB, 'learner@test.example', '555555').reason, 'expired');
  });
  await t('Rate limits: 3 codes per address per 15 minutes; 10 per network address; 25 guesses per network address', () => {
    run(DB, `delete from academy_login_codes where email = 'learner@test.example'`);
    for (let i = 0; i < 3; i++) assert.notStrictEqual(req(DB, 'learner@test.example', '66666' + i, 'ipA').limited, 'email');
    assert.strictEqual(req(DB, 'learner@test.example', '666669', 'ipA').limited, 'email');
    for (let i = 0; i < 7; i++) req(DB, `probe${i}@example.com`, '1', 'ipA');
    assert.strictEqual(req(DB, 'another@example.com', '1', 'ipA').limited, 'network');
    run(DB, `update academy_login_codes set tries = 5 where ip_hash = '${H('ipA')}' and created_at > now() - interval '15 minutes' and email like 'probe%'`);
    assert.strictEqual(ver(DB, 'learner@test.example', '666662', 'ipA').reason, 'limited');
    run(DB, `delete from academy_login_codes where ip_hash = '${H('ipA')}'`);
    req(DB, 'learner@test.example', '777777', 'ipB'); const r = ver(DB, 'learner@test.example', '777777', 'ipB');
    assert.strictEqual(r.ok, true); LEARNER = r.learner_id;
  });
  await t('Simultaneous: the same code redeemed 10 times at once opens exactly ONE session', async () => {
    req(DB, 'learner@test.example', '888888', 'ipC');
    const before = count(DB, 'academy_sessions', `learner_id = '${LEARNER}'`);
    const rs = await Promise.all(Array.from({ length: 10 }, () => bg(DB, `select academy_access_op_verify_code('learner@test.example', '${H('learner@test.example888888')}', '${H('ipC')}')`)));
    assert.strictEqual(rs.filter(r => r.ok && json(r.out).ok).length, 1, rs.map(r => r.out || r.err).join('\n'));
    assert.strictEqual(count(DB, 'academy_sessions', `learner_id = '${LEARNER}'`), before + 1);
  });
  await t('S3 simultaneous: 15 requests from ONE network address for 15 different addresses at the same instant create exactly 10 codes (the network limit cannot be raced)', async () => {
    run(DB, `delete from academy_login_codes where ip_hash = '${H('ipRace')}'`);
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => bg(DB, `begin; select academy_access_op_request_code('race${i}@example.com', '${H('race' + i)}', '${H('ipRace')}'); select pg_sleep(0.2); commit;`)));
    assert.ok(rs.every(r => r.ok), rs.map(r => r.err).join('\n'));
    assert.strictEqual(count(DB, 'academy_login_codes', `ip_hash = '${H('ipRace')}'`), 10);
    assert.strictEqual(rs.filter(r => json(r.out).limited === 'network').length, 5);
    // and 40 simultaneous WRONG guesses from one network address (40 different addresses, so no address lock serialises
    // them) count exactly 25 tries; the other 15 are refused as limited
    run(DB, `delete from academy_login_codes where ip_hash = '${H('ipRace')}'`);
    run(DB, `insert into academy_login_codes (email, code_hash, ip_hash, eligible, expires_at)
             select 'guess' || g || '@example.com', md5('c' || g) || md5('d' || g), '${H('ipRace')}', false, now() + interval '9 minutes' from generate_series(0, 39) g`);
    const gs = await Promise.all(Array.from({ length: 40 }, (_, i) => bg(DB, `begin; select academy_access_op_verify_code('guess${i}@example.com', '${H('wrong' + i)}', '${H('ipRace')}'); select pg_sleep(0.2); commit;`)));
    assert.ok(gs.every(r => r.ok), gs.map(r => r.err).join('\n'));
    assert.strictEqual(Number(run(DB, `select coalesce(sum(tries), 0) from academy_login_codes where ip_hash = '${H('ipRace')}'`)), 25, 'exactly 25 tries counted');
    assert.strictEqual(gs.filter(r => json(r.out).reason === 'limited').length, 15);
    run(DB, `delete from academy_login_codes where ip_hash = '${H('ipRace')}'`);
  });
  await t('Undelivered codes: the mail worker burns a code it could not send (id AND hash must match), it stops counting toward the limits, and it never signs anyone in', () => {
    run(DB, `delete from academy_login_codes where email = 'learner@test.example'`);
    const ids = [];
    for (const c of ['301301', '302302', '303303']) ids.push(req(DB, 'learner@test.example', c, 'ipU').code_id);
    assert.strictEqual(req(DB, 'learner@test.example', '304304', 'ipU').limited, 'email', 'three per 15 minutes');
    assert.strictEqual(json(run(DB, `select academy_access_op_code_undelivered('${ids[2]}', '${H('nobody')}')`)).ok, false, 'wrong hash: nothing');
    for (const [i, c] of [[0, '301301'], [1, '302302'], [2, '303303']]) assert.strictEqual(json(run(DB, `select academy_access_op_code_undelivered('${ids[i]}', '${H('learner@test.example' + c)}')`)).ok, true);
    assert.strictEqual(json(run(DB, `select academy_access_op_code_undelivered('${ids[2]}', '${H('learner@test.example303303')}')`)).ok, false, 'only once');
    assert.strictEqual(ver(DB, 'learner@test.example', '303303', 'ipU').ok, false, 'an undelivered code never works');
    assert.strictEqual(req(DB, 'learner@test.example', '305305', 'ipU').send, true, 'undelivered codes no longer count: asking again works');
    assert.strictEqual(ver(DB, 'learner@test.example', '305305', 'ipU').ok, true);
    assert.strictEqual(events(DB, `action = 'sign_in_code_undelivered'`), 3);
    assert.strictEqual(tryRun(DB, `set role anon; select academy_access_op_code_undelivered('${ids[0]}', '${H('x')}')`).ok, false);
    run(DB, `delete from academy_login_codes where email = 'learner@test.example'`);
  });
  await t('HCPS staff are never learners: no invite, no code, no handoff (D6)', () => {
    assert.strictEqual(tryRun(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'rep@test.example', 'Rep', 'learner')`).ok, false);
    assert.strictEqual(req(DB, 'admin@test.example', '121212').send, false);
    run(DB, `insert into dealer_users values ('${UID2}', 'rep@test.example', '${OTHER}', 'approved')`);
    assert.match(tryRun(DB, `select academy_access_op_handoff_mint('${UID2}', '${H('h0')}')`).err, /staff/);
    run(DB, `delete from dealer_users where uid = '${UID2}'`);
  });
  await t('Training Manager scope (D3, F): own dealer and its branches only; never another dealership; never a Training Manager invitation', () => {
    assert.ok(invite(DB, `'learner:${TM}'`, NORTH, 'branch@test.example').id, 'a branch of the TM dealer');
    const other = tryRun(DB, `select academy_access_op_invite('learner:${TM}', '${OTHER}', 'x@other.example', 'X', 'learner')`);
    assert.strictEqual(other.ok, false); assert.match(other.err, /Training Manager or HCPS/);
    assert.match(tryRun(DB, `select academy_access_op_invite('learner:${TM}', '${HQ}', 'tm2@test.example', 'X', 'training_manager')`).err, /only HCPS/);
    assert.match(tryRun(DB, `select academy_access_op_invite('learner:${LEARNER}', '${HQ}', 'y@test.example', 'Y', 'learner')`).err, /Training Manager or HCPS/, 'a plain learner invites nobody');
    // a Training Manager of the BRANCH manages the branch only
    const bt = invite(DB, PRES, NORTH, 'branchtm@test.example', 'training_manager'); req(DB, 'branchtm@test.example', '131313'); const btm = ver(DB, 'branchtm@test.example', '131313').learner_id;
    assert.ok(bt.id && btm);
    assert.match(tryRun(DB, `select academy_access_op_invite('learner:${btm}', '${HQ}', 'z@test.example', 'Z', 'learner')`).err, /Training Manager or HCPS/, 'a branch TM never reaches the parent');
    assert.ok(invite(DB, `'learner:${btm}'`, NORTH, 'z2@test.example').id);
  });
  let ENR;
  await t('Enrollment: only a PUBLISHED version; by HCPS or the dealership TM; never across dealerships; a TEST course only for a TEST dealership', () => {
    assert.match(tryRun(DB, `select academy_enroll_op_enroll('learner:${TM}', '${LEARNER}', '${DRAFT.v}', null)`).err, /published/);
    ENR = json(run(DB, `select academy_enroll_op_enroll('learner:${TM}', '${LEARNER}', '${V1.v}', null)`));
    assert.strictEqual(ENR.status, 'not_started'); assert.strictEqual(ENR.access_source, 'assigned');
    assert.match(tryRun(DB, `select academy_enroll_op_enroll('learner:${TM}', '${LEARNER}', '${V1.v}', null)`).err, /already enrolled/);
    assert.match(tryRun(DB, `select academy_enroll_op_enroll('learner:${TM}', '${LEARNER}', '${VT.v}', null)`).err, /TEST/);
    // someone at another dealership: the HQ TM cannot enroll them
    const o = invite(DB, PRES, OTHER, 'otherguy@example.com'); req(DB, 'otherguy@example.com', '141414'); const og = ver(DB, 'otherguy@example.com', '141414').learner_id;
    assert.ok(o.id && og);
    assert.match(tryRun(DB, `select academy_enroll_op_enroll('learner:${TM}', '${og}', '${V1.v}', null)`).err, /Training Manager or HCPS/);
    assert.strictEqual(json(run(DB, `select academy_enroll_op_enroll(${PRES}, '${og}', '${V1.v}', null)`)).access_source, 'admin_grant');
    assert.match(tryRun(DB, `select academy_enroll_op_enroll('learner:${LEARNER}', '${LEARNER}', '${V1.v}', null)`).err, /Training Manager or HCPS/, 'no self-enrollment');
  });
  await t('Progress: own enrollment only; lesson of that version only; resume point bounded; completed is never undone; enrollment moves to in_progress; first view + completion audited', () => {
    const save = (actor, l, st, rb) => tryRun(DB, `select academy_progress_op_save('${actor}', '${ENR.id}', '${l}', '${st}', ${rb})`);
    assert.match(save('learner:' + TM, V1.lessons[0], 'viewed', 0).err, /not this record's learner/);
    assert.match(save('learner:' + LEARNER, VT.lessons[0], 'viewed', 0).err, /not part of this course/);
    assert.match(save('learner:' + LEARNER, V1.lessons[0], 'viewed', 3).err, /not part of the lesson/, '3 screens = resume 0..2');
    assert.ok(save('learner:' + LEARNER, V1.lessons[0], 'viewed', 1).ok);
    assert.strictEqual(q1(DB, `select status from academy_enrollments where id = '${ENR.id}'`).status, 'in_progress');
    assert.ok(save('learner:' + LEARNER, V1.lessons[0], 'viewed', 2).ok);
    assert.ok(save('learner:' + LEARNER, V1.lessons[0], 'completed', 2).ok);
    assert.ok(save('learner:' + LEARNER, V1.lessons[0], 'viewed', 0).ok);
    assert.strictEqual(q1(DB, `select status from academy_progress where enrollment_id = '${ENR.id}' and lesson_id = '${V1.lessons[0]}'`).status, 'completed', 'completed stays completed');
    assert.strictEqual(events(DB, `entity = 'academy_progress' and entity_id like '${ENR.id}:%'`), 2, 'start + completion only (resume points are not audit noise)');
  });
  await t('Deactivation and suspension end live sessions at once; a TM cannot end another TM or themselves; HCPS can; access comes back as a NEW membership', () => {
    const lm = q1(DB, `select id from academy_memberships where learner_id = '${LEARNER}' and status = 'active'`).id;
    const tmm = q1(DB, `select id from academy_memberships where learner_id = '${TM}' and status = 'active'`).id;
    assert.match(tryRun(DB, `select academy_access_op_deactivate('learner:${TM}', '${tmm}', 'x')`).err, /only HCPS/);
    assert.match(tryRun(DB, `select academy_access_op_deactivate('learner:${TM}', '${lm}', '')`).err, /reason/);
    const open = count(DB, 'academy_sessions', `learner_id = '${LEARNER}' and ended_at is null`); assert.ok(open >= 2);
    assert.strictEqual(json(run(DB, `select academy_access_op_deactivate('learner:${TM}', '${lm}', 'left the company')`)).sessions_ended, open);
    assert.strictEqual(count(DB, 'academy_sessions', `learner_id = '${LEARNER}' and ended_at is null`), 0);
    assert.match(tryRun(DB, `select academy_progress_op_save('learner:${LEARNER}', '${ENR.id}', '${V1.lessons[1]}', 'viewed', 0)`).err, /ended/);
    run(DB, `delete from academy_login_codes where email = 'learner@test.example'`);   // test only: start under the rate limit
    req(DB, 'learner@test.example', '151515'); assert.strictEqual(ver(DB, 'learner@test.example', '151515').reason, 'not_allowed', 'no active access = no sign-in');
    const back = json(run(DB, `select academy_access_op_reactivate('learner:${TM}', '${LEARNER}', '${HQ}')`));
    assert.ok(back.membership_id && back.membership_id !== lm);
    assert.strictEqual(q1(DB, `select membership_id from academy_enrollments where id = '${ENR.id}'`).membership_id, back.membership_id, 'their course and its progress come back with the access');
    assert.strictEqual(q1(DB, `select after->>'enrollments_restored' as n from academy_events where action = 'reactivate' order by id desc limit 1`).n, '1');
    assert.match(tryRun(DB, `select academy_access_op_reactivate('learner:${TM}', '${(q1(DB, `select id from academy_learners where email = 'otherguy@example.com'`)).id}', '${HQ}')`).err, /never part of your dealership/);
    req(DB, 'learner@test.example', '161616'); assert.strictEqual(ver(DB, 'learner@test.example', '161616').ok, true);
    assert.match(tryRun(DB, `select academy_access_op_set_learner_status('learner:${TM}', '${LEARNER}', 'suspended', 'x')`).err, /staff/);
    assert.ok(json(run(DB, `select academy_access_op_set_learner_status(${PRES}, '${LEARNER}', 'suspended', 'investigation')`)).sessions_ended >= 1);
    run(DB, `delete from academy_login_codes where email = 'learner@test.example'`);
    req(DB, 'learner@test.example', '171717'); assert.strictEqual(ver(DB, 'learner@test.example', '171717').ok, false);
    run(DB, `select academy_access_op_set_learner_status(${PRES}, '${LEARNER}', 'active', 'cleared')`);
  });
  await t('Withdraw and re-enroll: a reason is required; the enrollment comes back with its saved progress (in_progress)', () => {
    assert.match(tryRun(DB, `select academy_enroll_op_withdraw('learner:${TM}', '${ENR.id}', ' ')`).err, /reason/);
    run(DB, `select academy_enroll_op_withdraw('learner:${TM}', '${ENR.id}', 'wrong course')`);
    assert.strictEqual(json(run(DB, `select academy_enroll_op_enroll('learner:${TM}', '${LEARNER}', '${V1.v}', null)`)).status, 'in_progress');
  });
  await t('Moving to another dealership: the existing enrollment (and its progress) is re-attached to the new access by enrolling again — never a second enrollment, never stuck as "already enrolled"', () => {
    const hq = q1(DB, `select id from academy_memberships where learner_id = '${LEARNER}' and dealer_id = '${HQ}' and status = 'active'`).id;
    run(DB, `select academy_access_op_deactivate(${PRES}, '${hq}', 'moved to another dealership')`);
    const other = json(run(DB, `select academy_access_op_reactivate(${PRES}, '${LEARNER}', '${OTHER}')`)).membership_id;
    assert.strictEqual(q1(DB, `select membership_id from academy_enrollments where id = '${ENR.id}'`).membership_id, hq, 'another dealership never inherits it by itself');
    const e = json(run(DB, `select academy_enroll_op_enroll(${PRES}, '${LEARNER}', '${V1.v}', null)`));
    assert.strictEqual(e.id, ENR.id); assert.strictEqual(e.membership_id, other); assert.strictEqual(e.status, 'in_progress');
    assert.strictEqual(count(DB, 'academy_enrollments', `learner_id = '${LEARNER}' and version_id = '${V1.v}'`), 1);
    assert.strictEqual(events(DB, `action = 're_attach' and entity_id = '${ENR.id}'`), 1);
    assert.match(tryRun(DB, `select academy_enroll_op_enroll(${PRES}, '${LEARNER}', '${V1.v}', null)`).err, /already enrolled/);
    const o = q1(DB, `select id from academy_memberships where id = '${other}'`).id;
    run(DB, `select academy_access_op_deactivate(${PRES}, '${o}', 'test: back to HQ')`);
    run(DB, `select academy_access_op_reactivate(${PRES}, '${LEARNER}', '${HQ}')`);
    run(DB, `select academy_enroll_op_enroll(${PRES}, '${LEARNER}', '${V1.v}', null)`);
  });
  await t('Cross-dealership training history: a Training Manager can never pull a person\'s earlier training from ANOTHER dealership into their own view; only HCPS can move it (audited)', () => {
    invite(DB, PRES, OTHER, 'mover@other.example'); req(DB, 'mover@other.example', '414141', 'ipM'); const mv = ver(DB, 'mover@other.example', '414141', 'ipM').learner_id; assert.ok(mv);
    const oe = json(run(DB, `select academy_enroll_op_enroll(${PRES}, '${mv}', '${V1.v}', null)`));
    run(DB, `select academy_progress_op_save('learner:${mv}', '${oe.id}', '${V1.lessons[0]}', 'completed', 2)`);
    const om = q1(DB, `select id from academy_memberships where learner_id = '${mv}' and status = 'active'`).id;
    run(DB, `select academy_access_op_deactivate(${PRES}, '${om}', 'joined HQ Medical')`);
    assert.match(tryRun(DB, `select academy_access_op_reactivate('learner:${TM}', '${mv}', '${HQ}')`).err, /never part of your dealership/);
    run(DB, `select academy_access_op_reactivate(${PRES}, '${mv}', '${HQ}')`);
    assert.strictEqual(q1(DB, `select membership_id from academy_enrollments where id = '${oe.id}'`).membership_id, om, 'restoring access at HQ does not move OTHER\'s training');
    const tmTry = tryRun(DB, `select academy_enroll_op_enroll('learner:${TM}', '${mv}', '${V1.v}', null)`);
    assert.strictEqual(tmTry.ok, false); assert.match(tmTry.err, /earlier training from another dealership; ask HCPS/);
    assert.strictEqual(q1(DB, `select membership_id from academy_enrollments where id = '${oe.id}'`).membership_id, om, 'nothing moved');
    const moved = json(run(DB, `select academy_enroll_op_enroll(${PRES}, '${mv}', '${V1.v}', null)`));
    assert.strictEqual(moved.id, oe.id); assert.notStrictEqual(moved.membership_id, om);
    assert.strictEqual(events(DB, `action = 're_attach' and entity_id = '${oe.id}' and actor = 'staff:admin@test.example'`), 1);
  });
  await t('Partner 360 handoff: approved login only; 60-second single use; a new code replaces the old; the learner is linked to the login (no duplicate identity); replay refused', async () => {
    run(DB, `insert into dealer_users values ('${UID}', 'learner@test.example', '${HQ}', 'pending')`);
    assert.match(tryRun(DB, `select academy_access_op_handoff_mint('${UID}', '${H('h1')}')`).err, /not approved/);
    run(DB, `update dealer_users set status = 'approved' where uid = '${UID}'`);
    run(DB, `select academy_access_op_handoff_mint('${UID}', '${H('h1')}')`);
    run(DB, `select academy_access_op_handoff_mint('${UID}', '${H('h2')}')`);
    assert.strictEqual(json(run(DB, `select academy_access_op_handoff_redeem('${H('h1')}', '${H('ip')}')`)).ok, false, 'the replaced code is dead');
    const rs = await Promise.all(Array.from({ length: 8 }, () => bg(DB, `select academy_access_op_handoff_redeem('${H('h2')}', '${H('ip')}')`)));
    const oks = rs.filter(r => r.ok && json(r.out).ok); assert.strictEqual(oks.length, 1, 'one redemption wins');
    assert.strictEqual(json(oks[0].out).learner_id, LEARNER, 'the same person: the existing learner with that address is linked, not duplicated');
    assert.strictEqual(q1(DB, `select auth_user_id from academy_learners where id = '${LEARNER}'`).auth_user_id, UID);
    assert.strictEqual(count(DB, 'academy_learners', `email = 'learner@test.example'`), 1);
    run(DB, `select academy_access_op_handoff_mint('${UID}', '${H('h3')}')`);
    run(DB, `update academy_handoff_codes set created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '61 seconds' where code_hash = '${H('h3')}'`);
    assert.strictEqual(json(run(DB, `select academy_access_op_handoff_redeem('${H('h3')}', '${H('ip')}')`)).reason, 'expired');
    // a brand-new Partner 360 user becomes a learner with a dealer_user membership
    run(DB, `insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000cccc', 'newdealer@example.com'); insert into dealer_users values ('00000000-0000-0000-0000-00000000cccc', 'newdealer@example.com', '${OTHER}', 'approved')`);
    run(DB, `select academy_access_op_handoff_mint('00000000-0000-0000-0000-00000000cccc', '${H('h4')}')`);
    const n = json(run(DB, `select academy_access_op_handoff_redeem('${H('h4')}', '${H('ip')}')`)); assert.strictEqual(n.ok, true);
    assert.strictEqual(q1(DB, `select access_type from academy_memberships where learner_id = '${n.learner_id}'`).access_type, 'dealer_user');
  });
  await t('Defence in depth: someone who has since become HCPS staff gets no code even with an active membership; access ended AFTER the code was sent stops the sign-in; one address never belongs to two Partner 360 logins', () => {
    run(DB, `insert into staff_users (email, name, role, active) values ('nowstaff@test.example', 'Now Staff', 'rep', false)`);
    invite(DB, PRES, HQ, 'nowstaff@test.example'); req(DB, 'nowstaff@test.example', '191919'); const ns = ver(DB, 'nowstaff@test.example', '191919');
    assert.strictEqual(ns.ok, true);
    run(DB, `update staff_users set active = true where email = 'nowstaff@test.example'`);
    run(DB, `delete from academy_login_codes where email = 'nowstaff@test.example'`);
    assert.strictEqual(req(DB, 'nowstaff@test.example', '202020').send, false, 'an active staff address is never sent a learner code');
    // the code was sent while access was active; access ends before it is typed
    const p = invite(DB, PRES, HQ, 'late@test.example'); req(DB, 'late@test.example', '212121'); const late = ver(DB, 'late@test.example', '212121').learner_id; assert.ok(p.id && late);
    run(DB, `delete from academy_login_codes where email = 'late@test.example'`);
    assert.strictEqual(req(DB, 'late@test.example', '222222').send, true);
    run(DB, `select academy_access_op_deactivate(${PRES}, '${q1(DB, `select id from academy_memberships where learner_id = '${late}' and status = 'active'`).id}', 'left')`);
    assert.strictEqual(ver(DB, 'late@test.example', '222222').reason, 'not_allowed', 'no access at the moment of sign-in = no session');
    // a second Partner 360 login carrying an address that is already linked to another login
    run(DB, `insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000eeee', 'learner@test.example'); insert into dealer_users values ('00000000-0000-0000-0000-00000000eeee', 'learner@test.example', '${HQ}', 'approved')`);
    run(DB, `select academy_access_op_handoff_mint('00000000-0000-0000-0000-00000000eeee', '${H('h9')}')`);
    assert.strictEqual(json(run(DB, `select academy_access_op_handoff_redeem('${H('h9')}', '${H('ip')}')`)).reason, 'not_allowed');
    assert.strictEqual(count(DB, 'academy_learners', `auth_user_id = '00000000-0000-0000-0000-00000000eeee'`), 0);
  });
  await t('Sign-out ends only your own session', () => {
    const s = q1(DB, `select id from academy_sessions where learner_id = '${LEARNER}' and ended_at is null limit 1`).id;
    assert.match(tryRun(DB, `select academy_access_op_end_session('learner:${TM}', '${s}')`).err, /not your session/);
    run(DB, `select academy_access_op_end_session('learner:${LEARNER}', '${s}')`);
    assert.ok(q1(DB, `select ended_at from academy_sessions where id = '${s}'`).ended_at);
  });
  await t('Atomic: if the audit row cannot be written, the change is not made either', () => {
    run(DB, `create function public.t_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$; create trigger t_fail before insert on academy_events for each row execute function public.t_fail_audit()`);
    const before = count(DB, 'academy_invites');
    assert.strictEqual(tryRun(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'atomic@test.example', 'A', 'learner')`).ok, false);
    assert.strictEqual(count(DB, 'academy_invites'), before);
    run(DB, `drop trigger t_fail on academy_events; drop function public.t_fail_audit()`);
  });
  await t('M1–M4 untouched: their functions still install-check and the A1 / M1 learner rules still hold', () => {
    assert.strictEqual(run(DB, `select count(*) from pg_proc where proname like 'academy\\_op\\_%'`), '18', 'M1: 11 operations + 7 helpers');
    assert.ok(tryRun(DB, `select academy_op_set_training_manager(${PRES}, '${q1(DB, `select id from academy_memberships where learner_id = '${LEARNER}' and status = 'active'`).id}', true, 'promotion')`).ok, 'M1 still grants the TM role');
  });
  await t('Rollback is refused while learner records exist; on a database without them it removes M5 cleanly and gives the server its rights back', () => {
    const r = tryRun(DB, fs.readFileSync(RB, 'utf8')); assert.strictEqual(r.ok, false); assert.match(r.err, /refused/);
    base(DB2); file(DB2, MIG);
    const out = file(DB2, RB); assert.match(out, /M5 removed\|t/);
    assert.ok(tryRun(DB2, `set role service_role; insert into academy_learners (auth_user_id, full_name, email) values ('${UID}', 'X', 'x@example.com')`).ok);
  });
} finally {
  for (const d of [DB, DB2]) try { run('postgres', `drop database if exists ${d}`); } catch (e) { /* ignore */ }
  console.log(`\nacademy-m5.pg: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
})();
