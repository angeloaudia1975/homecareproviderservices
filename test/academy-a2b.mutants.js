/* HCPS Academy A2B — mutation tests. Each mutant breaks ONE rule (in the M5 SQL or the server code) in a scratch copy of
   the working tree; the A2B suites must then fail. A clean control run must pass first, and the CONTROL mutant (a
   comment only) must survive. Needs a local Postgres (same env as the .pg tests).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-a2b.mutants.js [from] [to] */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const WRK = 'netlify/functions/academy-mail-background.js';
const SQL = 'supabase/academy_a2b_m5_learner_access.sql', LRN = 'netlify/functions/_academy_learner.js', AC = 'netlify/functions/_academy.js',
      APIF = 'netlify/functions/academy-api.js', HAND = 'netlify/functions/academy-handoff.js', SES = 'netlify/functions/_academy_session.js';
const MUTANTS = [
  { f: SQL, control: true, from: '-- Signing out ends this session', to: '-- Signing out ends this session (control)', why: 'CONTROL: a comment only' },
  // ---- sign-in codes
  { f: SQL, from: "  if v_c.code_hash <> p_code_hash then", to: "  if false then", why: 'any code signs in' },
  { f: SQL, from: "burned_at = case when tries + 1 >= 5 then now() end", to: "burned_at = null", why: 'unlimited guesses on one code' },
  { f: SQL, from: "  update academy_login_codes set used_at = now() where id = v_c.id;", to: "", why: 'a code works twice' },
  { f: SQL, from: "where email = v_email and used_at is null and burned_at is null and expires_at > now()\n   order by", to: "where email = v_email and used_at is null and burned_at is null\n   order by", why: 'an expired code works' },
  { f: SQL, from: "and created_at > now() - interval '15 minutes') >= 3", to: "and created_at > now() - interval '15 minutes') >= 300", why: 'no per-address limit' },
  { f: SQL, from: "where ip_hash = p_ip_hash and not undelivered and created_at > now() - interval '15 minutes') >= 10 then", to: "where ip_hash = p_ip_hash and not undelivered and created_at > now() - interval '15 minutes') >= 1000 then", why: 'no per-network limit' },
  { f: SQL, from: "  v_eligible := not academy_access_is_staff(v_email) and (", to: "  v_eligible := (", why: 'HCPS staff can get a learner code (D6)' },
  { f: SQL, from: "  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));\n  -- a network", to: "  -- a network", why: 'simultaneous redemptions of one code (no lock)', equivalent: 'the code row is read FOR UPDATE, which already serialises redemptions (the 10-at-once test proves one session either way); the lock is kept as a second barrier' },
  { f: SQL, from: "  if v_l.id is null or not exists (select 1 from academy_memberships where learner_id = v_l.id and status = 'active') then", to: "  if v_l.id is null then", why: 'no active membership still signs in' },
  // ---- handoff
  { f: SQL, from: "   where du.uid = p_auth_user_id and du.status = 'approved' limit 1;", to: "   where du.uid = p_auth_user_id limit 1;", why: 'an unapproved Partner 360 login gets a code' },
  { f: SQL, from: "  if not found or v_h.used_at is not null or v_h.expires_at <= now() then", to: "  if not found then", why: 'a handoff code is replayed or used after expiry' },
  { f: SQL, from: "      if v_l.auth_user_id is not null then", to: "      if false then", why: 'one address claimed by two Partner 360 logins' },
  // ---- people
  { f: SQL, from: "  if p_role = 'training_manager' and v_kind <> 'staff' then", to: "  if false then", why: 'a Training Manager appoints Training Managers' },
  { f: SQL, from: "  select p_tm_dealer = p_dealer or exists (select 1 from dealers d where d.id = p_dealer and d.parent_id = p_tm_dealer)", to: "  select true", why: 'a Training Manager reaches every dealership' },
  { f: SQL, from: "    v_ended := academy_access_end_sessions(v_m.learner_id, 'access_ended');", to: "", why: 'ending access leaves the session open' },
  { f: SQL, from: "  if p_status = 'suspended' then v_ended := academy_access_end_sessions(p_learner_id, 'suspended'); end if;", to: "", why: 'suspension leaves the session open' },
  { f: SQL, from: "  if v_kind <> 'staff' and (v_m.role = 'training_manager' or p_actor = 'learner:' || v_m.learner_id::text) then", to: "  if false then", why: 'a Training Manager ends another Training Manager' },
  // ---- enrollment and progress
  { f: SQL, from: "  select count(*) into v_moved from moved;", to: "  v_moved := 0;", why: 'restored access leaves the old courses stranded' },
  { f: SQL, from: "                                 and m.dealer_id = p_dealer_id and m.status <> 'active')", to: "                                 and m.status <> 'active')", why: 'restoring access at one dealership takes courses from another' },
  { f: SQL, from: "    if v_e.status <> 'withdrawn' and exists (select 1 from academy_memberships m where m.id = v_e.membership_id and m.status = 'active') then", to: "    if v_e.status <> 'withdrawn' then", why: 'a moved learner is stuck as already enrolled' },
  { f: SQL, from: "  if v_v.status <> 'published' then raise exception 'academy: learners are enrolled only in a published course version'", to: "  if false then raise exception 'academy: learners are enrolled only in a published course version'", why: 'enrollment in a draft' },
  { f: SQL, from: "  if v_c.slug like 'test-%' and not v_test then", to: "  if false then", why: 'a TEST course for a real dealership' },
  { f: SQL, from: "  v_status := case when v_old.status = 'completed' then 'completed' else p_status end;", to: "  v_status := p_status;", why: 'completion undone' },
  { f: SQL, from: "  perform academy_op_actor_learner(p_actor, v_e.learner_id);", to: "", why: 'someone else saves your progress' },
  { f: SQL, from: "    execute format('revoke all on table public.%I from service_role', t);", to: "", why: 'the server writes learner tables directly' },
  // ---- server
  { f: AC, from: "if (!s || s.ended_at || String(s.learner_id) !== c.learner_id || !(Date.parse(s.expires_at) > Date.now())) return null;", to: "if (!s) return null;", why: 'an ended session still works' },
  { f: LRN, from: "delete payload.warnings;", to: "", why: 'staff authoring notes reach the learner' },
  { f: LRN, from: "byIds('academy_questions', refs.questions, 'id,version_id,use,status,kind,prompt,choices'),", to: "byIds('academy_questions', refs.questions, 'id,version_id,use,status,kind,prompt,choices,answer_key,explanation'),", why: 'answer keys in the lesson payload' },
  { f: LRN, from: "  if (q.use !== 'practice') A.refuse(403, 'not_practice'", to: "  if (false) A.refuse(403, 'not_practice'", why: 'an exam question is graded in a lesson' },
  { f: LRN, from: "{ if (!scope.has(String(dealerId))) A.refuse(403", to: "{ if (false) A.refuse(403", why: 'a TM invites for another dealership (server)', db: true },
  { f: LRN, from: "  if (!tms.length) A.refuse(403, 'forbidden', 'Only a Training Manager can do that.');", to: "", why: 'a plain learner opens the team view' },
  { f: LRN, from: "  return A.respond(event, 200, { ok: true, message: SENT });", to: "  return A.respond(event, 200, { ok: true, message: SENT, send: !!(r && r.send) });", why: 'the answer tells known and unknown addresses apart' },
  { f: LRN, from: "  if (!(await A.switchOn('academy_invites'))) A.refuse(403, 'flag_off', 'Invitations are not open yet.');", to: "", why: 'TM invitations with the switch off' },
  { f: HAND, from: "  if (!A.PARTNER360_ORIGINS.includes(origin)) return", to: "  if (false) return", why: 'a Training link minted from any site' },
  { f: HAND, from: "  const on = (await A.switchOn('academy_learner')) && (await A.switchOn('academy_handoff'));", to: "  const on = await A.switchOn('academy_learner');", why: 'the Partner 360 entry opens without its switch' },
  { f: APIF, from: "  if (!(await A.switchOn('academy_learner'))) return", to: "  if (false) return", why: 'the learner API open with its switch off' },
  { f: SES, from: "    if (!c || c.v !== 2 || typeof c.sub !== 'string' || typeof c.sid !== 'string') return null;", to: "    if (!c || typeof c.sub !== 'string') return null;", why: 'a cookie with no session row id' },
  // ---- security review (S1–S3, delivery failure, cross-dealership history)
  { f: SQL, from: "  perform pg_advisory_xact_lock(hashtext('academy-ip:' || p_ip_hash));\n  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));\n  if (select count(*)", to: "  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));\n  if (select count(*)", why: 'S3: concurrent codes from one network address race the limit' },
  { f: SQL, from: "  perform pg_advisory_xact_lock(hashtext('academy-ip:' || p_ip_hash));\n  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));\n  -- a network", to: "  perform pg_advisory_xact_lock(hashtext('academy-code:' || v_email));\n  -- a network", why: 'S3: concurrent guesses from one network address race the try limit' },
  { f: SQL, from: "where email = v_email and not undelivered and created_at > now() - interval '15 minutes') >= 3", to: "where email = v_email and created_at > now() - interval '15 minutes') >= 3", why: 'an undelivered code still counts (the person is stranded)' },
  { f: SQL, from: "  select * into v_c from academy_login_codes where id = p_code_id and code_hash = p_code_hash for update;", to: "  select * into v_c from academy_login_codes where id = p_code_id for update;", why: 'anyone with a code id can burn it' },
  { f: SQL, from: "    if v_e.status <> 'withdrawn' and v_kind <> 'staff' and not exists (", to: "    if false and not exists (", why: 'a TM pulls another dealership\'s training history' },
  { f: LRN, from: "  const v = String(h['x-nf-client-connection-ip'] || '').trim();", to: "  const v = String(h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || '').trim();", why: 'S2: a forwarded header buys a new rate-limit bucket' },
  { f: LRN, from: "  const accepted = await MAIL.dispatch(A.SESSION.sealJob(job));", to: "  const accepted = real ? (await MAIL.send(addr, MAIL.codeMessage(code))).sent : true;", why: 'S1: the answer waits for the email provider' },
  { f: LRN, from: "  await holdUntil(t0);\n  return A.respond(event, 200", to: "  return A.respond(event, 200", why: 'S1: no minimum answer time' },
  { f: LRN, from: "  if (real && !accepted) {", to: "  if (false) {", why: 'worker unreachable: the code stays live and counted' },
  { f: WRK, from: "  if (!claim || !claim.ok || claim.email !== job.to) return 'stale';", to: "", why: 'a duplicate or replayed envelope sends a second email' },
  { f: SQL, from: "  if not found or v_c.mailed_at is not null or v_c.used_at is not null", to: "  if not found or v_c.used_at is not null", why: 'a code is mailed twice' },
  { f: SQL, from: "     or v_c.expires_at <= now() or not v_c.eligible then", to: "     or v_c.expires_at <= now() then", why: 'an unknown address is mailed a code' },
  { f: WRK, from: "  await A.accessOp('access_op_code_undelivered', { p_code_id: job.id, p_code_hash: job.h });", to: "", why: 'a failed email strands the person' },
  { f: WRK, from: "  if (job.k !== 'code') return 'decoy';", to: "", why: 'a decoy is mailed' },
  { f: SES, from: "    if (!job || typeof job.iat !== 'number' || job.iat > t + 60 || t - job.iat > (maxAge || 120)) return null;", to: "    if (!job) return null;", why: 'an old envelope is still acted on' },
];
const SUITES = ['test/academy-m5.pg.test.js', 'test/academy-a2b.pg.test.js'];
function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2bmut-'));
  for (const d of ['netlify', 'supabase', 'test', 'src']) execSync(`cp -r ${path.join(ROOT, d)} ${dir}/`);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
function tests(dir) {
  return SUITES.map(f => { const r = spawnSync(process.execPath, [f], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 300000 });
    return { f, ok: r.status === 0, tail: (r.stdout || '').trim().split('\n').slice(-1)[0] }; });
}
const [from, to] = process.argv.slice(2).map(Number);
const list = MUTANTS.slice(from || 0, to || MUTANTS.length);
const dir = tree();
let killed = 0; const survived = [];
try {
  if (!from) { const c = tests(dir); if (!c.every(x => x.ok)) { console.log('CONTROL FAILED', c); process.exit(1); } console.log('control: clean (' + c.map(x => x.tail).join(' · ') + ')'); }
  for (const [i, m] of list.entries()) {
    const p = path.join(dir, m.f), orig = fs.readFileSync(p, 'utf8');
    if (!orig.includes(m.from)) { console.log(`  ANCHOR NOT FOUND #${(from || 0) + i}: ${m.why}`); survived.push(m.why + ' (anchor)'); continue; }
    fs.writeFileSync(p, orig.replace(m.from, m.to));
    const r = tests(dir); fs.writeFileSync(p, orig);
    const dead = r.some(x => !x.ok);
    if (m.control) { console.log((dead ? '  CONTROL KILLED (bad) ' : '  control survived ') + m.why); if (dead) survived.push('CONTROL'); continue; }
    if (m.equivalent && !dead) { console.log(`  equivalent #${(from || 0) + i} ${m.why} — ${m.equivalent}`); continue; }
    if (dead) { killed++; console.log(`  killed   #${(from || 0) + i} ${m.why}`); } else { survived.push(m.why); console.log(`  SURVIVED #${(from || 0) + i} ${m.why}`); }
  }
} finally { execSync(`rm -rf ${dir}`); }
const total = list.filter(m => !m.control && !m.equivalent).length;
console.log(`\nacademy A2B mutants: ${killed}/${total} killed${survived.length ? '; survivors: ' + survived.join('; ') : ''}`);
process.exitCode = survived.length ? 1 : 0;
