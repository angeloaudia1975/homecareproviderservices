/* HCPS Academy A2F — mutation tests. Each mutant breaks ONE certificate rule (in the M7 SQL, the learner / Training
   Manager code, the admin revoke or the public verification) in a scratch copy of the working tree; the A2F suites must
   then fail. A clean control run must pass first, and the CONTROL mutant (a comment only) must survive.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-a2f.mutants.js [from] [to] */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const SQL = 'supabase/academy_a2f_m7_certificates.sql', LRN = 'netlify/functions/_academy_learner.js', ADM = 'netlify/functions/academy-admin-api.js', VER = 'netlify/functions/academy-verify.js';
const MUTANTS = [
  { f: SQL, control: true, from: '-- What a learner (and the printed certificate) sees', to: '-- What a learner (and the printed certificate) sees (control)', why: 'CONTROL: a comment only' },
  { f: SQL, from: "  perform academy_op_actor_learner(p_actor, v_e.learner_id);\n  perform pg_advisory_xact_lock", to: "  perform pg_advisory_xact_lock", why: 'anyone claims anyone’s attempt' },
  { f: SQL, from: "  perform pg_advisory_xact_lock(hashtext('academy-cert:' || v_e.id::text));\n", to: "", why: 'simultaneous claims (no lock)' },
  { f: SQL, from: "  if found then return jsonb_build_object('ok', true, 'existing', true, 'certificate', academy_cert_view(v_c)); end if;", to: "", why: 'a second claim is not idempotent' },
  { f: SQL, from: "  if (select value->'academy_certificates' from app_settings where key = 'phase2_flags') is distinct from 'true'::jsonb then\n    return jsonb_build_object('ok', false, 'reason', 'switched_off');\n  end if;\n  if v_a.submitted_at", to: "  if v_a.submitted_at", why: 'the switch is checked only by M1 (an error, not switched_off)' },
  { f: SQL, from: "  if v_a.submitted_at is null or v_a.passed is not true then", to: "  if v_a.submitted_at is null then", why: 'a failed attempt reaches issuance' },
  { f: SQL, from: "  select * into v_m from academy_memberships where id = v_e.membership_id and status = 'active';", to: "  select * into v_m from academy_memberships where id = v_e.membership_id;", why: 'ended access still earns a certificate' },
  { f: SQL, from: "  select d.business_name into v_dealer from dealers d where d.id = v_m.dealer_id;", to: "  select d.business_name into v_dealer from dealers d order by d.business_name limit 1;", why: 'the dealership printed is not the learner’s own' },
  { f: SQL, from: "                   and lower(coalesce(s.role, '')) = 'president') then\n    raise exception 'academy: only the HCPS President may revoke", to: "                   ) then\n    raise exception 'academy: only the HCPS President may revoke", why: 'any administrator revokes' },
  { f: SQL, from: "  perform academy_cert_president(p_actor);\n  if p_reason", to: "  if p_reason", why: 'anyone revokes' },
  { f: SQL, from: "  if p_reason is null or length(trim(p_reason)) < 5 or length(p_reason) > 500 then", to: "  if p_reason is null then", why: 'a revocation without a real reason' },
  { f: SQL, from: "    'expires_at', v->'expires_at', 'status', v->>'status', 'revoked_at', v->'revoked_at', 'issuer', v->>'issuer');", to: "    'expires_at', v->'expires_at', 'status', v->>'status', 'revoked_at', v->'revoked_at', 'issuer', v->>'issuer', 'reason', v_c.revoked_reason, 'enrollment_id', v_c.enrollment_id);", why: 'verification shows the reason and internal ids' },
  { f: SQL, from: "    'status', case when c.status = 'revoked' then 'revoked' when c.expires_at is not null and c.expires_at <= now() then 'expired' else 'valid' end,", to: "    'status', case when c.status = 'revoked' then 'revoked' else 'valid' end,", why: 'an expired certificate verifies as valid' },
  { f: SQL, from: "  if v_n !~ '^HCPS-[A-Z0-9]{4}-[A-Z0-9]{4}$' then return jsonb_build_object('found', false, 'reason', 'format'); end if;", to: "", why: 'any text is looked up' },
  { f: SQL, from: "declare v_n text := upper(btrim(coalesce(p_number, '')));", to: "declare v_n text := coalesce(p_number, '');", why: 'lower case / spaces are not accepted' },
  { f: SQL, from: "revoke execute on function public.academy_op_issue_certificate(text, uuid, text) from service_role;", to: "", why: 'the server issues around the claim rules' },
  { f: SQL, from: "revoke execute on function public.academy_op_revoke_certificate(text, uuid, text) from service_role;", to: "", why: 'the server revokes around President-only' },
  { f: SQL, from: "revoke insert, update, delete, truncate on table public.academy_certificates from service_role;", to: "", why: 'the server can write certificates directly' },
  { f: SQL, from: "    if f.proname like 'academy\\_cert\\_op\\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;", to: "    execute format('grant execute on function %s to service_role, anon', f.sig);", why: 'the public key calls the operations and helpers' },
  { f: LRN, from: "  if (r && r.passed === true && await A.switchOn('academy_certificates')) {", to: "  if (r && await A.switchOn('academy_certificates')) {", why: 'a failed exam tries to claim' },
  { f: LRN, from: "    } catch (e) { console.error('[academy] certificate not issued after a pass'", to: "    } catch (e) { throw e; console.error('[academy] certificate not issued after a pass'", why: 'a claim failure fails the graded exam' },
  { f: LRN, from: "  if (!(await A.switchOn('academy_certificates'))) A.refuse(403, 'flag_off', CERT_WAIT.switched_off);", to: "", why: 'claim_certificate works with the switch off' },
  { f: LRN, from: "    expiring_soon: st === 'valid' && left != null && left <= EXPIRING_DAYS,", to: "    expiring_soon: false,", why: 'nothing is flagged as expiring' },
  // (not a mutant: widening the TM certificate read is equivalent — certOf() maps only the TM's own in-scope enrollment ids; the roster scope itself is covered by A2B)
  { f: LRN, from: "  const enr = memIds.length ? await A.sbGet(`academy_enrollments?membership_id=${idsIn(memIds)}", to: "  const enr = memIds.length ? await A.sbGet(`academy_enrollments?membership_id=not.is.null&x=${idsIn(memIds)}", why: 'a Training Manager sees other dealerships’ courses and certificates' },
  { f: LRN, from: "const certStatus = (c, now) => c.status === 'revoked' ? 'revoked' :", to: "const certStatus = (c, now) => false ? 'revoked' :", why: 'a revoked certificate shows as valid to the learner' },
  { f: LRN, from: "it is not issued or endorsed by Golden Technologies.' };", to: "' };", why: 'no Golden disclosure' },
  { f: ADM, from: "WRITE.revoke_certificate = async (staff, b) => {\n  requirePresident(staff);", to: "WRITE.revoke_certificate = async (staff, b) => {", why: 'the API lets any administrator revoke' },
  { f: ADM, from: "  if (reason.trim().length < 5) A.refuse(400, 'invalid', 'Give a reason of at least 5 characters.');", to: "", why: 'the API sends a short reason' },
  { f: ADM, from: "p_actor: A.actorLabel(staff), p_certificate_id:", to: "p_actor: b.p_actor || A.actorLabel(staff), p_certificate_id:", why: 'the API takes the acting person from the request' },
  { f: VER, from: "  if (event.httpMethod !== 'GET') return", to: "  if (false) return", why: 'verification accepts POST' },
  { f: VER, from: "  if (!(await A.switchOn('academy_certificates'))) return", to: "  if (false) return", why: 'verification open with the switch off' },
  { f: VER, from: "    issuer: r.issuer, disclosure: DISCLOSURE });", to: "    issuer: r.issuer, disclosure: DISCLOSURE, raw: r });", why: 'the public answer carries the raw database row' },
];
const SUITES = ['test/academy-m7.pg.test.js', 'test/academy-a2f.pg.test.js'];
function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2fmut-'));
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
    if (dead) { killed++; console.log(`  killed   #${(from || 0) + i} ${m.why}`); } else { survived.push(m.why); console.log(`  SURVIVED #${(from || 0) + i} ${m.why}`); }
  }
} finally { execSync(`rm -rf ${dir}`); }
const total = list.filter(m => !m.control).length;
console.log(`\nacademy A2F mutants: ${killed}/${total} killed${survived.length ? '; survivors: ' + survived.join('; ') : ''}`);
process.exitCode = survived.length ? 1 : 0;
