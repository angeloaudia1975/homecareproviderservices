/* Contractual commission mutants (CLAUDE.md §18, Angelo 2026-10-12 22:00 CT). JS mutants are written to a temporary copy of
   netlify/functions/_contract_commission.js (CT_MODULE) and run against test/contract-commission.test.js; SQL mutants to a
   temporary copy of supabase/mi_f_commission_events.sql (MIF_SQL) run by test/mi-f-commission-events.pg.test.js.
   Nothing in the repo changes on disk. Every mutant must be killed; the clean control must pass. */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const JS = path.join(__dirname, '..', 'netlify', 'functions', '_contract_commission.js');
const SQL = path.join(__dirname, '..', 'supabase', 'mi_f_commission_events.sql');
const M = {
  rate_10:               ['js', 'rate: 0.09,', 'rate: 0.10,'],
  any_status_eligible:   ['js', 'else if (C.eligible_status.test(st))', 'else if (true)'],
  reversal_counts:       ['js', 'else if (C.reversal_status.test(st)) {', 'else if (false) {'],
  unverified_excluded:   ['js', 'const counts = o.eligibility === "eligible" || o.eligibility === "eligible_unverified_status";', 'const counts = o.eligibility === "eligible";'],
  earned_plus_reported:  ['js', 'o.outstanding = r2(o.earned - o.paid);', 'o.outstanding = r2(o.earned + o.reported_due - o.paid);'],
  unmatched_creates_sale:['js', 'if (!o) { S.unmatched++;', 'if (!o && false) { S.unmatched++;'],
  repeat_counted_twice:  ['js', 'if (seen.has(dupKey) && seen.get(dupKey) !== s.source_id)', 'if (false)'],
  bad_statement_counted: ['js', 'if (!p.ok) { problems.push(', 'if (false) { problems.push('],
  due_is_paid:           ['js', 'o.reported_due = r2(o.reported_due + L.due); o.statement_refs.push(ref);', 'o.reported_due = r2(o.reported_due + L.due); o.paid = r2(o.paid + L.due); o.statement_refs.push(ref);'],
  partial_allocated:     ['js', 'if (S.total_due != null && S.paid >= S.total_due) {', 'if (S.total_due != null && S.paid > 0) {'],
  superseded_counted:    ['js', 'const live = ev.filter(x => !superseded.has(x.id));', 'const live = ev;'],
  history_loses:         ['js', 'if (r2(x.amount) !== r2(o.amount)) o.flags.push', 'o.amount = x.amount; if (r2(x.amount) !== r2(o.amount)) o.flags.push'],
  totals_unchecked:      ['js', 'if (out.total_due != null && sumDue !== out.total_due)', 'if (false)'],
  due_date_as_sale:      ['js', 'const d = dateOnly(r.date); if (d && (!o.date || d < o.date)) o.date = d;', 'const d = "2026-10-04"; if (d && (!o.date || d < o.date)) o.date = d;'],
  other_mfr_contract:    ['js', 'const contractFor = slug => CONTRACTS[slug] || null;', 'const contractFor = slug => CONTRACTS[slug] || CONTRACTS["strongback-mobility"];'],
  overdue_never:         ['js', 'age > C.overdue_days.unreported) o.labels.push', 'age > 100000) o.labels.push'],
  overdue_before_first:  ['js', 'if (firstStmt && o.date.slice(0, 7) >= firstStmt)', 'if (true)'],
  overdue_no_label:      ['js', 'else o.labels.push("earlier_statements_not_on_file");', 'else;'],
  coverage_mixed_rate:   ['js', 'Math.abs(r2(Number(r.amount) * C.rate) - r2(Number(r.commission))) <= 0.01', 'true'],
  review_dismiss_lost:   ['js', 'review_lines: review.filter(r => !r.decision || r.decision === "investigate").length,', 'review_lines: review.length,'],
  sql_any_staff:         ['sql', "if not public.hcps_mfr_mi_e_president(v_actor) then", "if v_actor is null then"],
  sql_no_evidence:       ['sql', "and length(btrim(coalesce(evidence, ''))) >= 5", ""],
  sql_both_targets:      ['sql', "and ((source_id is null) <> (order_number is null)) and decision is null)),", "and decision is null)),"],
  sql_any_source:        ['sql', "if not found or s.kind <> 'commission_statement' or s.manufacturer <> v_mfr then", "if not found then"],
  sql_supersede_twice:   ['sql', "if exists (select 1 from public.mfr_commission_events where supersedes_id = v_sup) then raise exception", "if false then raise exception"],
  sql_updates_allowed:   ['sql', "if tg_level = 'STATEMENT' or tg_op <> 'INSERT' then", "if tg_level = 'STATEMENT' then"],
  sql_public_grant:      ['sql', "revoke all on table public.mfr_commission_events from public, anon, authenticated, service_role;", "revoke all on table public.mfr_commission_events from service_role; grant select on table public.mfr_commission_events to anon;"],
};
const run = (suite, env) => { const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { env, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || ''); if (/^SKIP/m.test(out)) return { skipped: true }; const x = out.match(/(\d+) passed, (\d+) failed/); return { failed: x ? +x[2] : 1 }; };
const ctl = [run('contract-commission.test.js', process.env), run('mi-f-commission-events.pg.test.js', process.env)];
const clean = ctl.every(r => r.failed === 0 && !r.skipped); console.log('CONTROL:', clean ? 'clean' : 'FAILURES ' + JSON.stringify(ctl));
let killed = 0; const bad = [];
for (const [n, [kind, from, to]] of Object.entries(M)) {
  const srcPath = kind === 'js' ? JS : SQL, src = fs.readFileSync(srcPath, 'utf8');
  if (!src.includes(from)) { bad.push(n); console.log('NO ANCHOR ' + n); continue; }
  const tmp = path.join(kind === 'js' ? path.dirname(JS) : os.tmpdir(), `.mut-${process.pid}-${n}` + (kind === 'js' ? '.js' : '.sql'));
  fs.writeFileSync(tmp, src.split(from).join(to));
  const env = Object.assign({}, process.env, kind === 'js' ? { CT_MODULE: tmp } : { MIF_SQL: tmp });
  const r = run(kind === 'js' ? 'contract-commission.test.js' : 'mi-f-commission-events.pg.test.js', env); fs.unlinkSync(tmp);
  if (r.skipped) { bad.push(n); console.log('SKIPPED  ' + n); } else if (r.failed > 0) { killed++; console.log('killed   ' + n); } else { bad.push(n); console.log('SURVIVED ' + n); }
}
console.log(`\n${killed}/${Object.keys(M).length} killed`); process.exitCode = (!clean || bad.length) ? 1 : 0;
