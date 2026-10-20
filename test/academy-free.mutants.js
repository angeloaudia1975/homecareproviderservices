/* Mutation check for F1 (free launch). Each mutant breaks ONE rule in the F1 migration or its server code; the real
   suite (test/academy-free.pg.test.js) must FAIL for every mutant. Files are restored after each run, whatever happens.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=localtest node test/academy-free.mutants.js */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const R = f => path.join(__dirname, '..', f);
const SQL = 'supabase/academy_p2_f1_free_access.sql';
const M = [
  [SQL, "when (select coalesce(head.is_test, false) from head) then false", "when false then false", 'TEST inherited from a TEST head office'],
  [SQL, "bool_and(x.active is distinct from false", "bool_or(x.active is distinct from false", 'a branch inherits from its head office'],
  [SQL, "not in ('prospect','closed','inactive','dormant')", "not in ('closed')", 'prospect status counts as network'],
  [SQL, "in ('', 'dealer'))", "in ('', 'dealer', 'manufacturer'))", 'a manufacturer account counts as a dealer'],
  [SQL, "if academy_access_is_staff(v_email) then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;", "", 'staff may register'],
  [SQL, "    return jsonb_build_object('ok', false, 'reason', 'partner360');", "    null;", 'a Partner 360 user gets a second identity'],
  [SQL, "if v_l.id is not null and v_l.status <> 'active' then", "if false then", 'a suspended learner may register'],
  [SQL, "or (select count(*) from academy_free_registrations where email = v_email and created_at > now() - interval '1 hour') >= 3", "", 'no per-email limit'],
  [SQL, "and a.mode = 'free')\n     or v_c.status <> 'published'", ")\n     or v_c.status <> 'published'", 'register on a course that is not free'],
  [SQL, "if not exists (select 1 from academy_course_access a where a.course_id = v_c.id and a.mode = 'free') or v_c.course_type", "if v_c.course_type", 'enroll in a course that is not free'],
  [SQL, "if v_c.slug like 'test-%' and not coalesce(v_test, false) then", "if false then", 'a TEST course for anyone'],
  [SQL, "    return jsonb_build_object('ok', true, 'existing', true, 'enrollment_id', v_e.id, 'status', v_e.status);   -- repeat / double click", "    null;", 'a repeat click re-enrolls'],
  [SQL, "perform pg_advisory_xact_lock(hashtext('academy-free-enroll:' || v_lid::text || ':' || v_v.id::text));", "", 'no lock: simultaneous clicks race'],
  [SQL, "if exists (select 1 from academy_course_access a where a.course_id = new.course_id and a.mode <> 'paid') then", "if false then", 'a free course can be bought'],
  [SQL, "    update academy_purchases set status = 'superseded', updated_at = now() where course_id = p_course_id and status = 'open';\n  end if;\n  perform academy_op_audit('staff'", "    null;\n  end if;\n  perform academy_op_audit('staff'", 'open checkouts stay open'],
  [SQL, "perform academy_content_actor_president(p_actor);\n  if p_mode", "perform academy_op_actor_staff(p_actor);\n  if p_mode", 'any administrator sets access'],
  [SQL, "perform academy_op_audit('learner', p_actor, 'academy_enrollments', v_e.id::text, 'free_enroll', null, to_jsonb(v_e));", "", 'free enrollment not audited'],
  [SQL, "where m.learner_id = v_lid and m.status = 'active' and m.dealer_id is not null and academy_purchase_dealer_eligible(m.dealer_id)", "where m.learner_id = v_lid and m.status = 'active' and m.dealer_id is not null", 'an ineligible dealership gives free network access'],
  ['netlify/functions/academy-checkout.js', "if ((await freeSlugs()).has(slug)) return", "if (false) return", 'checkout does not answer "free"'],
  ['netlify/functions/academy-checkout.js', ".filter(c => !free.has(c.slug))", "", 'a free course stays in the paid catalog'],
  ['netlify/functions/academy-admin-api.js', "WRITE.set_course_access = async (staff, b) => {\n  requirePresident(staff);", "WRITE.set_course_access = async (staff, b) => {", 'the API lets any administrator set access'],
  ['netlify/functions/academy-free.js', "if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return", "if (false) return", 'registration from any site'],
  ['netlify/functions/academy-free.js', "if (!(await open())) return A.respond(event, 403", "if (false) return A.respond(event, 403", 'registration while the Academy is closed'],
];
let killed = 0, survived = [];
// control: the unmutated suite passes
const ctl = spawnSync('node', [R('test/academy-free.pg.test.js')], { encoding: 'utf8', env: process.env });
if (ctl.status !== 0) { console.log('CONTROL FAILED — fix the suite first\n' + ctl.stdout.slice(-2000)); process.exit(2); }
console.log('control: suite passes');
for (const [f, from, to, why] of M) {
  const file = R(f), orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.log('  BAD MUTANT (text not found): ' + why); survived.push(why + ' (not applied)'); continue; }
  try {
    fs.writeFileSync(file, orig.replace(from, to));
    for (const k of Object.keys(require.cache)) delete require.cache[k];
    const r = spawnSync('node', [R('test/academy-free.pg.test.js')], { encoding: 'utf8', env: process.env });
    if (r.status !== 0) { killed++; console.log('  killed   ' + why); } else { survived.push(why); console.log('  SURVIVED ' + why); }
  } finally { fs.writeFileSync(file, orig); }
}
console.log(`\nF1 mutants: ${killed}/${M.length} killed`);
process.exit(survived.length ? 1 : 0);
