/* HCPS Academy A2D M3.1 — mutation run on the atomic lesson save (the SQL). Each mutant is a copy of the committed
   migration with ONE deliberate defect, installed on a fresh copy of A1 + M1 + M2 + M3. It is "killed" when the M3.1
   acceptance tests or the two-session checks below catch it. A control run (the unmodified file) must pass everything.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-m3_1.mutants.js */
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const MIG = fs.readFileSync(SUP('academy_a2d_m3_1_save_lesson.sql'), 'utf8');

const MUTANTS = [
  { from: 'if v_old.blocks is distinct from p_base_blocks then', to: 'if false then', why: 'no compare-and-set: a save overwrites another editor\'s work' },
  { from: "  perform academy_content_lock_draft(v_ver);\n  select * into v_old from academy_lessons where id = p_lesson_id for update;",
    to: "  if (select status from academy_course_versions where id = v_ver) <> 'draft' then raise exception 'academy: locked' using errcode = '55000'; end if;\n  select * into v_old from academy_lessons where id = p_lesson_id;",
    why: 'no locks: the comparison is made without holding the version or the lesson' },
  { from: "     where r.lesson_id = p_lesson_id and r.question_id is null", to: "     where r.version_id = v_ver and r.lesson_id is distinct from null", why: 'pruning reaches other lessons\' links' },
  { from: "     where r.lesson_id = p_lesson_id and r.question_id is null", to: "     where (r.lesson_id = p_lesson_id or r.question_id is not null)", why: 'pruning reaches question links' },
  { from: "       and not (r.manufacturer_slug || '|' || upper(r.model_code) || '|' || coalesce(r.field, '') = any (v_want))", to: '', why: 'pruning removes links the saved screens still need' },
  { from: "      from unnest(v_want) k\n     where not exists", to: "      from unnest(v_want) k\n     where false and not exists", why: 'needed links never created (the checker refuses every fact)' },
  { from: "  v_blocks := academy_author_check_blocks(p_lesson_id, v_ver, p_blocks);", to: "  v_blocks := p_blocks;", why: 'the M3 block checker skipped' },
  { from: "  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_lesson_id::text, 'save_lesson', to_jsonb(v_old),",
    to: "  perform 1 where false and (select 1) = (select 1);\n  perform jsonb_build_object(to_jsonb(v_old),", why: 'no audit row' },
  { from: "  perform academy_op_actor_staff(p_actor);\n  perform academy_op_begin('save_lesson', p_actor);", to: "  perform academy_op_begin('save_lesson', p_actor);", why: 'any actor accepted' },
  { from: "  perform academy_op_end();\n  return jsonb_build_object('lesson'", to: "  return jsonb_build_object('lesson'", why: 'the operation marker left set after a save' },
  { from: "grant execute on function public.academy_save_op_lesson(text, uuid, jsonb, jsonb) to service_role;", to: "grant execute on function public.academy_save_op_lesson(text, uuid, jsonb, jsonb) to service_role, anon;", why: 'the public key may call the save' },
  { from: "  if p_base_blocks is null or jsonb_typeof(p_base_blocks) <> 'array' then", to: "  if false then", why: 'a save without a starting point accepted' },
  { from: "  if v_old.blocks is distinct from p_base_blocks then", to: "  if v_old.blocks is distinct from p_base_blocks and false then", why: 'conflict check disabled (variant)' },
];

const BASE = 'academy_m31mut_base_' + process.pid;
function makeBase() {
  run('postgres', `drop database if exists ${BASE}`); run('postgres', `create database ${BASE}`);
  let fx = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8');
  if (NO_SAFEUPDATE) fx = fx.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, '');
  run(BASE, fx); file(BASE, SUP('academy_a1_foundation.sql'));
  run(BASE, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql']) file(BASE, SUP(f));
}
function bg(db, sql) {
  return new Promise(res => {
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
    let err = ''; p.stderr.on('data', d => err += d); p.on('close', code => res({ ok: code === 0, err }));
  });
}
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;
const OBJ = { kind: 'objectives', items: ['Explain the first thing', 'Explain the second thing'] };
async function checks(db) {
  const failures = [];
  const out = file(db, SUP('academy_a2d_m3_1_acceptance_tests.sql'));
  for (const l of out.split('\n').filter(x => /^\d+\|/.test(x))) { const [n, , result] = l.split('|'); if (result !== 'PASS') failures.push('acceptance #' + n + ' ' + result); }
  // two sessions save the same lesson from the same start: exactly one may win
  const c = JSON.parse(run(db, `select academy_content_op_create_course(${PRES}, null, ${J({ slug: 'mut-cc', title: 'x', course_type: 'training' })})`)).id;
  const v = JSON.parse(run(db, `select academy_content_op_create_version(${PRES}, null, '${c}', '{}')`)).id;
  const m = JSON.parse(run(db, `select academy_content_op_create_module(${PRES}, null, '${v}', '{"title":"M"}')`)).id;
  const l = JSON.parse(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', '{"title":"L"}')`)).id;
  const save = h => `begin; select academy_save_op_lesson(${PRES}, '${l}', '[]'::jsonb, ${J([OBJ, { kind: 'text', heading: h, body: 'x' }])}); select pg_sleep(0.6); commit;`;
  const [a, b] = await Promise.all([bg(db, save('A')), bg(db, save('B'))]);
  if ([a, b].filter(x => x.ok).length !== 1) failures.push('concurrency: ' + [a, b].filter(x => x.ok).length + ' saves won');
  return failures;
}

(async () => {
  makeBase();
  let killed = 0; const survivors = [];
  for (let i = -1; i < MUTANTS.length; i++) {
    const mu = MUTANTS[i];
    let sql = MIG;
    if (mu) { if (!sql.includes(mu.from)) { console.log(`  BAD    #${i} pattern not found: ${mu.why}`); survivors.push('#' + i + ' (pattern)'); continue; } sql = sql.replace(mu.from, mu.to); }
    const db = 'academy_m31mut_' + process.pid + '_' + (i + 1);
    run('postgres', `drop database if exists ${db}`); run('postgres', `create database ${db} template ${BASE}`);
    const tmp = path.join(require('os').tmpdir(), `m31mut_${process.pid}_${i + 1}.sql`); fs.writeFileSync(tmp, sql);
    let failures;
    try { file(db, tmp); failures = await checks(db); } catch (e) { failures = ['install/run error: ' + String(e.message).split('\n')[0]]; }
    run('postgres', `drop database if exists ${db} with (force)`); fs.unlinkSync(tmp);
    if (!mu) {
      console.log(failures.length ? `control: FAILED (${failures.join('; ')})` : 'control: clean (acceptance 17/17, concurrency one winner)');
      if (failures.length) { run('postgres', `drop database if exists ${BASE} with (force)`); process.exit(1); }
      continue;
    }
    if (failures.length) { killed++; console.log(`  killed   #${i} ${mu.why}  [${failures[0]}]`); }
    else { survivors.push(mu.why); console.log(`  SURVIVED #${i} ${mu.why}`); }
  }
  run('postgres', `drop database if exists ${BASE} with (force)`);
  console.log(`\nacademy M3.1 SQL mutants: ${killed}/${MUTANTS.length} killed` + (survivors.length ? '\nsurvivors: ' + survivors.join(' | ') : ''));
  process.exit(survivors.length ? 1 : 0);
})();
