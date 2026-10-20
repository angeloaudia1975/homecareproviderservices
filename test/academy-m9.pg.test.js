/* HCPS Academy Phase 2 / M9 (live payments) — migration review checks on a real Postgres:
   1. rollback round trip: M8 → M9 → rollback restores the three M8 functions, the sandbox-only CHECK and the privileges
      exactly (function definitions, ACLs, constraints compared), and M9 installs again afterwards;
   2. SQL mutation run: each safety line of M9 is removed in turn and the full payments suite
      (test/academy-payments.pg.test.js) must fail for every mutant.
     PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres PGTEST_NO_SAFEUPDATE=1 node test/academy-m9.pg.test.js [--no-mutants] */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const DB = 'academy_m9_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
let fx = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8');
if (process.env.PGTEST_NO_SAFEUPDATE === '1') fx = fx.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, '');
run(DB, fx);
run(DB, `alter table public.dealers add column is_test boolean not null default false, add column status text, add column account_class text;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);`);
file(DB, SUP('academy_a1_foundation.sql'));
run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql',
                 'academy_p2_m8_payments.sql']) file(DB, SUP(f));
const snap = () => run(DB, `select md5(string_agg(x, '|' order by x)) from (
    select p.proname || ':' || pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text, '') as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'academy\\_purchase\\_%'
    union all select 'con:' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.academy_purchases'::regclass
    union all select 'col:' || attname || ':' || format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.academy_purchases'::regclass and attnum > 0 and not attisdropped) s`);
const before = snap();
const m9 = file(DB, SUP('academy_p2_m9_live_payments.sql'));
ok(m9.split('\n').filter(l => l.includes('|')).every(l => l.endsWith('|t')), 'M9 installs; every install check true');
ok(snap() !== before, 'M9 changes the three functions and the constraint');
const rb = file(DB, SUP('academy_p2_m9_live_payments_rollback.sql'));
ok(/\|t$/.test(rb), 'rollback reports sandbox-only again');
ok(snap() === before, 'rollback restores the M8 functions, privileges and the sandbox-only CHECK exactly');
ok(psql(DB, ['-f', SUP('academy_p2_m9_live_payments_rollback.sql')]).status !== 0, 'a second rollback is refused');
ok(/\|t$/.test(file(DB, SUP('academy_p2_m9_live_payments.sql')).split('\n').pop()), 'M9 installs again after the rollback');
run('postgres', `drop database if exists ${DB} with (force)`);

if (!process.argv.includes('--no-mutants')) {
  const src = fs.readFileSync(SUP('academy_p2_m9_live_payments.sql'), 'utf8');
  const MUT = [
    ['session event mode check removed', `    elsif v_p.livemode is distinct from p_livemode then\n      v_out := 'mode_mismatch';\n    elsif p_type = 'checkout.session.expired' then`, `    elsif p_type = 'checkout.session.expired' then`],
    ['refund/dispute mode check removed', `    elsif v_p.livemode is distinct from p_livemode then\n      v_out := 'mode_mismatch';\n    elsif v_p.status in ('review') then`, `    elsif v_p.status in ('review') then`],
    ['sandbox payment granted while live', `      elsif not p_livemode and academy_purchase_live_mode() then`, `      elsif false then`],
    ['second payment granted', `      elsif exists (select 1 from academy_purchases o where o.email = v_p.email and o.course_id = v_p.course_id and o.id <> v_p.id`, `      elsif false and exists (select 1 from academy_purchases o where o.email = v_p.email and o.course_id = v_p.course_id and o.id <> v_p.id`],
    ['early refund not replayed', `        if v_p.status = 'paid' and v_pi is not null then`, `        if false then`],
    ['won dispute restores a refunded purchase', `        if v_p.status = 'disputed' and v_p.amount_refunded_cents < v_p.amount_cents + v_p.amount_tax_cents then`, `        if v_p.status in ('disputed','refunded') then`],
    ['lost dispute keeps access', `        perform academy_purchase_withdraw(v_p, 'dispute lost');\n`, ``],
    ['full refund ignores tax', `      v_amt := v_p.amount_cents + v_p.amount_tax_cents;      -- full refund`, `      v_amt := v_p.amount_cents;      -- full refund`],
    ['tax cap not checked', `coalesce(p_data->>'amount_tax', '0') !~ '^[0-9]{1,5}$' or coalesce(p_data->>'amount_subtotal', '0') !~ '^[0-9]{1,7}$' then true\n                  when coalesce(p_data->>'amount_tax', '0')::int > 100000 then true\n`, `coalesce(p_data->>'amount_subtotal', '0') !~ '^[0-9]{1,7}$' then true\n`],
    ['review loses the payment id', `      update academy_purchases set stripe_payment_intent = coalesce(v_pi, stripe_payment_intent), updated_at = now()\n       where id = v_p.id returning * into v_p;\n      if p_data`, `      if p_data`],
    ['open reuses a checkout of the other mode', `v_open.livemode = v_live and `, ``],
    ['purchases always stamped sandbox', `p_ip_hash, v_live)`, `p_ip_hash, false)`],
    ['attach ignores the live switch', `  if p_livemode and not academy_purchase_live_mode() then raise exception 'academy: live payments are not enabled' using errcode = '42501'; end if;\n`, ``],
    ['attach ignores the purchase mode', `  if v.livemode is distinct from p_livemode then raise exception 'academy: the checkout mode does not match this purchase' using errcode = '42501'; end if;\n`, ``],
    ['attach accepts any session prefix', `(case when p_livemode then '^cs_live_[A-Za-z0-9_]{8,250}$' else '^cs_test_[A-Za-z0-9_]{8,250}$' end)`, `'^cs_[a-z]+_[A-Za-z0-9_]{8,250}$'`],
    ['tax total not checked', `else (p_data->>'amount_total') is distinct from ((p_data->>'amount_subtotal')::bigint + coalesce((p_data->>'amount_tax')::bigint, 0))::text end)`, `else false end)`],
    ['price compared after tax', `coalesce(p_data->>'amount_subtotal', p_data->>'amount_total') is distinct from`, `(p_data->>'amount_total') is distinct from`],
    ['live switch read loosely', `(value->'academy_payments_live') = 'true'::jsonb from app_settings where key = 'phase2_flags'), false)\n$$;`, `(value->'academy_payments_live') is not null from app_settings where key = 'phase2_flags'), false)\n$$;`],
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9mut-'));
  let killed = 0;
  for (const [name, a, b] of MUT) {
    if (!src.includes(a)) { fail++; console.log('  FAIL mutant anchor missing: ' + name); continue; }
    const f = path.join(dir, name.replace(/\W+/g, '_') + '.sql'); fs.writeFileSync(f, src.replace(a, () => b));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'academy-payments.pg.test.js')], { env: Object.assign({}, process.env, { ACADEMY_M9_FILE: f }), encoding: 'utf8' });
    if (r.status !== 0 && /passed, [1-9]/.test(r.stdout)) killed++; else { fail++; console.log('  FAIL mutant survived: ' + name + ' ' + (r.stdout.split('\n').slice(-2).join(' '))); }
  }
  console.log(`  SQL mutants killed ${killed}/${MUT.length}`);
  ok(killed === MUT.length, 'every M9 SQL mutant is caught by the payments suite');
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
