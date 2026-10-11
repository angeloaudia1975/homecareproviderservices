/* HCPS Academy A2D M3 — mutation tests for the M3 SQL. Each mutant removes or weakens ONE safeguard in
   supabase/academy_a2d_m3_author_ops.sql; it is KILLED when the M3 acceptance tests or the M3 hardening file report a
   failure (or the install refuses it). A surviving mutant = a safeguard no test protects. The control (the file as
   committed) must pass first, or the run is invalid. Mutants marked "race" are only observable with two sessions: they
   run the whole Postgres suite (test/academy-m3.pg.test.js) against a mutated copy.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-m3.mutants.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const ROOT = path.join(__dirname, '..');
const SUP = f => path.join(ROOT, 'supabase', f);
const LOCAL = f => path.join(__dirname, 'academy', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
if (psql('postgres', ['-c', 'select 1']).status !== 0) { console.log('SKIP: no Postgres'); process.exit(0); }

const ORIG = fs.readFileSync(SUP('academy_a2d_m3_author_ops.sql'), 'utf8');
const BASE = 'academy_m3mut_base_' + process.pid;
// Template database: fixture + A1 + M1 + M2 (+ a second administrator). Each mutant gets a fresh copy of it.
run('postgres', `drop database if exists ${BASE}`); run('postgres', `create database ${BASE}`);
for (const f of [LOCAL('fixture.sql'), SUP('academy_a1_foundation.sql')]) if (psql(BASE, ['-f', f]).status) throw new Error(f);
run(BASE, 'grant all on all tables in schema public to service_role');
run(BASE, "insert into staff_users (email, name, role, active) values ('owner3@test.example', 'Third Admin', 'owner', true)");
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql']) if (psql(BASE, ['-f', SUP(f)]).status) throw new Error(f);

function verdict(sql) {
  const db = 'academy_m3mut_' + process.pid;
  run('postgres', `drop database if exists ${db}`); run('postgres', `create database ${db} template ${BASE}`);
  try {
    const inst = psql(db, ['-c', sql]);
    const err = e => (e.split('\n').find(l => /ERROR/.test(l)) || e.split('\n')[0]).slice(0, 110);
    if (inst.status !== 0) return { killed: true, why: 'install refused: ' + err(inst.stderr) };
    const acc = psql(db, ['-c', fs.readFileSync(SUP('academy_a2d_m3_acceptance_tests.sql'), 'utf8')]);
    if (acc.status !== 0) return { killed: true, why: 'acceptance stopped: ' + err(acc.stderr) };
    const bad = acc.stdout.split('\n').filter(l => /^\d+\|/.test(l) && l.split('|')[2] !== 'PASS');
    const rows = acc.stdout.split('\n').filter(l => /^\d+\|/.test(l)).length;
    if (rows !== 25) return { killed: true, why: `acceptance gave ${rows} rows` };
    if (bad.length) return { killed: true, why: 'acceptance ' + bad.map(l => '#' + l.split('|')[0]).join(',') };
    const h = psql(db, ['-f', LOCAL('m3_author.sql')]);
    if (h.status !== 0) return { killed: true, why: 'hardening stopped: ' + err(h.stderr) };
    const hb = h.stdout.split('\n').filter(l => /^\d\d\|/.test(l) && !/^\d\d\|PASS\|/.test(l));
    if (h.stdout.split('\n').filter(l => /^\d\d\|/.test(l)).length !== 12) return { killed: true, why: 'hardening row count' };
    if (hb.length) return { killed: true, why: 'hardening ' + hb.map(l => '#' + l.slice(0, 2)).join(',') };
    return { killed: false };
  } finally { run('postgres', `drop database if exists ${db}`); }
}
function raceVerdict(sql) {   // whole suite against a copy of the repo with the mutated file
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3mut-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(dir, 'supabase'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'supabase', 'academy_a2d_m3_author_ops.sql'), sql);
  fs.chmodSync(dir, 0o755);
  const r = spawnSync(process.execPath, [path.join(dir, 'test', 'academy-m3.pg.test.js')], { encoding: 'utf8', env: process.env });
  fs.rmSync(dir, { recursive: true, force: true });
  // Only the two-session tests count: the fingerprint and text checks would flag ANY change to the file.
  const failed = (r.stdout.match(/^ {2}FAIL Concurrency.*$/gm) || []);
  if (!/academy-m3\.pg: \d+ passed/.test(r.stdout)) return { killed: true, why: 'suite did not finish: ' + (r.stderr || '').slice(0, 90) };
  return failed.length ? { killed: true, why: failed[0].trim().slice(0, 90) } : { killed: false };
}

// [name, find, replace, race?] — find must occur exactly once (or use {all:true}).
const M = [
  ['guard: no owner check (marker alone opens the tables)', `and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
                          where p.oid = 'public.academy_author_guard()'::regprocedure) then`, 'then'],
  ['guard: owner alone opens the tables (no marker needed)', `  if coalesce(current_setting('academy.op', true), '') <> ''
     and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
                          where p.oid = 'public.academy_author_guard()'::regprocedure) then`, `  if current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
                          where p.oid = 'public.academy_author_guard()'::regprocedure) then`],
  ['guard: no row guard on fact links', `create trigger academy_author_guard before insert or update or delete on public.academy_content_refs
  for each row execute function public.academy_author_guard();`, ''],
  ['guard: no row guard on media', `create trigger academy_author_guard before insert or update or delete on public.academy_media
  for each row execute function public.academy_author_guard();`, ''],
  ['guard: no TRUNCATE guard on fact links', `create trigger academy_author_guard_truncate before truncate on public.academy_content_refs
  for each statement execute function public.academy_author_guard();`, ''],
  ['guard: no TRUNCATE guard on media', `create trigger academy_author_guard_truncate before truncate on public.academy_media
  for each statement execute function public.academy_author_guard();`, ''],
  ['set_blocks: no draft lock', `  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_lessons where id = p_lesson_id for update;`, `  select * into v_old from academy_lessons where id = p_lesson_id for update;`],
  ['set_blocks: no administrator check', `  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('set_blocks', p_actor);`, `  perform academy_op_begin('set_blocks', p_actor);`],
  ['text: HTML allowed', `if v ~ '<[A-Za-z/!?]' then raise`, `if false then raise`],
  ['text: control characters allowed', `if v ~ '[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]' then`, `if false then`],
  ['blocks: unknown kinds allowed', `    if v_kind is null or not (v_kind = any (KINDS)) then
      raise exception 'academy: block % has an unknown kind', i using errcode = '22023';
    end if;`, `    if v_kind is null or not (v_kind = any (KINDS)) then
      continue;
    end if;`],
  ['blocks: objectives anywhere', `if i <> 1 then raise exception 'academy: the objectives come first in a lesson'`, `if false then raise exception 'x'`],
  ['blocks: knowledge check accepts exam questions', `         and use = 'practice' and status = 'active';`, `         and status = 'active';`],
  ['blocks: knowledge check accepts another version', `select count(*) into v_n from academy_questions where id = any (v_qids) and version_id = p_version_id`, `select count(*) into v_n from academy_questions where id = any (v_qids) and true`],
  ['blocks: fact need not be linked', `        raise exception 'academy: link the fact % % % to this lesson first', v_mfr, v_model, v_field using errcode = '22023';
      end if;
      v_b := jsonb_build_object('kind', v_kind, 'manufacturer_slug'`, `        null;
      end if;
      v_b := jsonb_build_object('kind', v_kind, 'manufacturer_slug'`],
  ['blocks: comparison cells need not be linked', `          if not exists (select 1 from academy_content_refs where lesson_id = p_lesson_id and manufacturer_slug = v_mfr
                           and upper(model_code) = v_model and field = v_field) then
            raise`, `          if false then
            raise`],
  ['blocks: image with both media and placeholder', `if v_has_media = v_has_ph then`, `if not v_has_media and not v_has_ph then`],
  ['blocks: media of any kind', `  if not (v_kind = any (p_kinds)) then`, `  if false then`],
  ['blocks: scenario without a best choice', `if v_best < 1 then raise`, `if false then raise`],
  ['blocks: no size limit', `if octet_length(p_blocks::text) > 65536 then`, `if false then`],
  ['blocks: no block-count limit', `if jsonb_array_length(p_blocks) > 40 then`, `if false then`],
  ['blocks: quote without a date', `  if coalesce(b->>'source_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'academy: a manufacturer quote needs its source date (YYYY-MM-DD)' using errcode = '22023';
      end if;
      begin v_date := (b->>'source_date')::date;
      exception when others then raise exception 'academy: the source date is not a date' using errcode = '22023'; end;`, `      begin v_date := (b->>'source_date')::date;
      exception when others then v_date := null; end;`],
  ['url: any scheme allowed', `if v is not null and v !~ '^https://[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(:[0-9]{2,5})?(/[^[:space:]<>"]*)?$' then`, `if false then`],
  ['alt: file names accepted', `if v ~* '\\.(jpe?g|png|webp|gif|svg|pdf)$' or v ~* '^(img|dsc|image|photo|picture)[ _-]?[0-9]*$' then`, `if false then`],
  ['media: image alt text not checked', `    v_alt := case when m->>'alt_text' = '' then '' else academy_author_alt(m->'alt_text', 'the alt text') end;`, `    v_alt := m->>'alt_text';`],
  ['media: any video host', `    if v_url is null or v_url !~ '^https://(www\\.youtube-nocookie\\.com/embed/[A-Za-z0-9_-]{6,20}|player\\.vimeo\\.com/video/[0-9]{3,12})(\\?[A-Za-z0-9=&_.-]*)?$' then`, `    if v_url is null then`],
  ['media: stored photo or manufacturer file without the President', `    begin perform academy_content_actor_president(p_actor);   -- every stored photo`, `    begin perform null;   -- every stored photo`],
  ['media update: downgrade or change without the President', `  if v_old.storage_path is not null and (v_old.rights = 'manufacturer_permitted' or v_old.kind = 'image') then`, `  if false then`],
  ['media: HCPS-owned may name a manufacturer', `  if v_rights = 'hcps_owned' and v_mfr is not null then`, `  if false then`],
  ['media: link-only file stored', `  if v_rights = 'link_only' and v_path is not null then`, `  if false then`],
  ['media: any storage path', `(v_path !~ '^media/[a-z0-9-]{1,60}/[a-z0-9][a-z0-9._-]{0,120}$' or v_path ~ '\\.\\.')`, `false`],
  ['media update: allowed while published content uses it', `              where v.status <> 'draft' and jsonb_path_exists(l.blocks, '$.**.media_id ? (@ == $id)', jsonb_build_object('id', p_id::text)))`, `              where false)`],
  ['media delete: allowed while a lesson uses it', `  if exists (select 1 from academy_lessons l where jsonb_path_exists(l.blocks, '$.**.media_id ? (@ == $id)', jsonb_build_object('id', p_id::text)))
     or exists`, `  if false
     and exists`],
  ['media: same file recorded twice', `    raise exception 'academy: a media record already uses that file' using errcode = '23505';`, `    null;`],
  ['question: answer need not be a choice', `if v_key is null or jsonb_typeof(v_key) <> 'string' or not ((v_key #>> '{}') = any (v_ids)) then`, `if v_key is null then`],
  ['question: no topic required', `jsonb_array_length(q->'objective_tags') not between 1 and 10 then`, `jsonb_array_length(q->'objective_tags') > 10 then`],
  ['question: exam question reused as practice', `  if exists (select 1 from academy_questions o where o.version_id = p_version_id and o.id is distinct from p_self
               and o.use <> v_use`, `  if false and exists (select 1 from academy_questions o where o.version_id = p_version_id and o.id is distinct from p_self
               and o.use <> v_use`],
  ['question: module of another version', `    if not exists (select 1 from academy_modules where id = v_mod and version_id = p_version_id) then`, `    if not exists (select 1 from academy_modules where id = v_mod) then`],
  ['question: create audit holds the key', `    (v_new - 'answer_key') || jsonb_build_object('answer_key_changed', true));`, `    v_new || jsonb_build_object('answer_key_changed', true));`],
  ['question: update audit holds the key', `    (v_new - 'answer_key') || jsonb_build_object('answer_key_changed', v_new->'answer_key' is distinct from to_jsonb(v_old.answer_key)));`, `    v_new || jsonb_build_object('answer_key_changed', true));`],
  ['question: no draft lock on update', `  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_questions where id = p_id for update;
  if not found then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  q := `, `  select * into v_old from academy_questions where id = p_id for update;
  if not found then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  q := `],
  ['question: retire without a reason', `  if p_status = 'retired' and (p_reason is null or length(trim(p_reason)) = 0) then`, `  if false then`],
  ['question: retire while a check uses it', `  if p_status = 'retired' and exists (select 1 from academy_lessons l join academy_modules m on m.id = l.module_id`, `  if false and exists (select 1 from academy_lessons l join academy_modules m on m.id = l.module_id`],
  ['question: practice used in a check may become an exam question', `  if (q->>'use') <> v_old.use and exists`, `  if false and exists`],
  ['links: duplicates allowed', `    raise exception 'academy: that fact is already linked' using errcode = '23505';`, `    null;`],
  ['links: unlink while a block shows the fact', `      raise exception 'academy: a block in this lesson shows that fact; change the block first' using errcode = '55000';`, `      null;`],
  ['links: no draft lock on link', `  perform academy_content_lock_draft(v_ver);
  if v_lesson is not null then`, `  if v_lesson is not null then`],
  ['distribution: need not name every module', `    if (select count(*) from jsonb_object_keys(v_q)) <> v_count then`, `    if false then`],
  ['distribution: any total', `    if v_sum <> v_ver.exam_questions then
      raise exception 'academy: the distribution adds up to % questions; this version draws %', v_sum, v_ver.exam_questions using errcode = '22023';
    end if;
    update academy_modules m`, `    update academy_modules m`],
  ['distribution: zero allowed', `(p_quotas->>k)::int not between 1 and 200 then`, `(p_quotas->>k)::int not between 0 and 200 then`],
  ['reorder: incomplete order allowed', `     or (select array_agg(id order by id) from academy_modules where version_id = p_version_id)
        is distinct from (select array_agg(x order by x) from unnest(p_order) x) then`, `     then`],
  ['draw: distribution ignored (25 at random, as before)', `    if exists (select 1 from academy_modules where version_id = p_version_id and exam_quota is not null) then
      if exists`, `    if false then
      if exists`],
  ['draw: replaced facts still drawn', `                            and (f.id is null or f.valid_to is not null or f.status <> 'verified')));`, `                            and false));`],
  ['draw: automatic mode does not cover every module', `      v_ids := array(select (array_agg(q.id order by random()))[1] from academy_questions q
                      where q.id = any (v_elig) and q.module_id is not null group by q.module_id);`, `      v_ids := '{}';`],
  ['draw: a short module is filled silently', `        if cardinality(v_pick) < r.exam_quota then`, `        if false then`],
  ['start-attempt: back to the M1 draw', `  v_ids := academy_author_exam_draw(v_ver.id, v_ver.status = 'published' and v_enr.status <> 'withdrawn');   -- A2D M3: per-module draw`, `  v_ids := array(select id from academy_questions
                  where version_id = v_ver.id and use = 'exam' and status = 'active'
                  order by random() limit v_ver.exam_questions);`],
  ['publish: no publish check', `create trigger academy_author_publish_check before update of status on public.academy_course_versions
  for each row when (new.status = 'published' and old.status is distinct from 'published')
  execute function public.academy_author_publish_check();`, ''],
  ['publish: lessons not re-checked (their media not locked)', `    perform academy_author_check_blocks(r.id, new.id, r.blocks);`, `    null;`, 'race'],
  ['delete media: no row lock', `  select * into v_old from academy_media where id = p_id for update;
  if not found then raise exception 'academy: media not found' using errcode = 'P0002'; end if;
  if exists (select 1 from academy_lessons l where`, `  select * into v_old from academy_media where id = p_id;
  if not found then raise exception 'academy: media not found' using errcode = 'P0002'; end if;
  if exists (select 1 from academy_lessons l where`, 'race'],
  ['blocks: media not locked while a lesson is saved', `  select kind into v_kind from academy_media where id = v_id for share;`, `  select kind into v_kind from academy_media where id = v_id;`, 'race'],
  ['links: unlink without the draft lock', `  perform academy_content_lock_draft(v_old.version_id);
  select * into v_old from academy_content_refs where id = p_id for update;`, `  select * into v_old from academy_content_refs where id = p_id for update;`],
  ['set_blocks: marker left set', `  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_lesson_id::text, 'set_blocks', to_jsonb(v_old), v_new);
  perform academy_op_end();`, `  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_lesson_id::text, 'set_blocks', to_jsonb(v_old), v_new);`],
  ['start-attempt: strict draw always (M1 messages lost)', `v_ver.status = 'published' and v_enr.status <> 'withdrawn');   -- A2D M3`, `true);   -- A2D M3`],
  ['draw: incomplete distribution allowed', `      if exists (select 1 from academy_modules where version_id = p_version_id and exam_quota is null) then
        raise exception`, `      if false then
        raise exception`],
  ['draw: exam questions without a module allowed in a distribution', `      if exists (select 1 from academy_questions where id = any (v_elig) and module_id is null) then`, `      if false then`],
  ['draw: questions pinned to an unverified fact drawn', `(f.id is null or f.valid_to is not null or f.status <> 'verified')`, `(f.id is null or f.valid_to is not null)`],
  ['draw: no final shuffle', `  return array(select x from unnest(v_ids) x order by random());`, `  return v_ids;`],
  ['draw: automatic mode skips a module without questions', `      if exists (select 1 from academy_modules m where m.version_id = p_version_id
                   and not exists (select 1 from academy_questions q where q.id = any (v_elig) and q.module_id = m.id)) then
        raise exception`, `      if false then
        raise exception`],
  ['blocks: credential evidence shown in a lesson', `  if exists (select 1 from academy_external_certs where upload_media_id = v_id) then   -- a learner's own evidence`, `  if false then   -- a learner's own evidence`],
  ['distribution: ids in capitals not recognised', `      v_q := v_q || jsonb_build_object(k::uuid::text, (p_quotas->>k)::int);`, `      v_q := v_q || jsonb_build_object(k, (p_quotas->>k)::int);`],
  ['media: two records for one file at the same time', `  if m->>'storage_path' is not null then perform pg_advisory_xact_lock(hashtext('academy_media:' || (m->>'storage_path'))); end if;`, ``, 'race'],
  ['distribution: one module named twice', `      if v_q ? (k::uuid::text) then raise exception 'academy: module % is named twice', k using errcode = '22023'; end if;`, ``],
  ['privileges: operations open to anon', `      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

commit;`, `      execute format('grant execute on function %s to service_role, anon', f.sig);
    end if;
  end loop;
end $$;

commit;`],
  ['privileges: helpers open to the server role', `    if f.proname like 'academy\\_author\\_op\\_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

commit;`, `    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;`],
  ['privileges: an operation without fixed rights', `create function public.academy_author_op_create_media(p_actor text, p_id uuid, p_media jsonb)
returns jsonb language plpgsql security definer`, `create function public.academy_author_op_create_media(p_actor text, p_id uuid, p_media jsonb)
returns jsonb language plpgsql security invoker`],
];

console.log('control (the committed file) ...');
const control = verdict(ORIG);
if (control.killed) { console.log('INVALID RUN: the committed file fails its own tests: ' + control.why); run('postgres', `drop database if exists ${BASE}`); process.exit(1); }
const raceControl = process.env.M3_SKIP_RACE ? null : raceVerdict(ORIG);
if (raceControl && raceControl.killed) { console.log('INVALID RUN: the full suite fails on the committed file: ' + raceControl.why); run('postgres', `drop database if exists ${BASE}`); process.exit(1); }
console.log('control passes' + (raceControl ? ' (unit and full suite)' : ' (unit; race mutants skipped)') + '\n');
let killed = 0, survived = [], invalid = [], skipped = 0;
for (const [name, find, repl, kind] of M) {
  const n = ORIG.split(find).length - 1;
  if (n !== 1) { invalid.push(name + ` (pattern found ${n} times)`); console.log('  INVALID  ' + name); continue; }
  if (kind === 'race' && !raceControl) { skipped++; console.log('  skip     ' + name); continue; }
  const sql = ORIG.replace(find, () => repl);
  const v = kind === 'race' ? raceVerdict(sql) : verdict(sql);
  if (v.killed) { killed++; console.log('  killed   ' + name + '  [' + v.why + ']'); } else { survived.push(name); console.log('  SURVIVED ' + name); }
}
run('postgres', `drop database if exists ${BASE}`);
console.log(`\nacademy-m3 mutants: ${killed}/${M.length - skipped} killed` + (survived.length ? '; survived: ' + survived.join('; ') : '') + (invalid.length ? '; invalid: ' + invalid.join('; ') : ''));
process.exitCode = survived.length || invalid.length ? 1 : 0;
