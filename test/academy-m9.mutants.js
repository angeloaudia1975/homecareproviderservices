/* Mutation check for M9 (the status half of academy_sale_refund_monotonic is defence in depth: M8 itself never turns a
   refunded purchase back into partially refunded, so removing it is an equivalent mutant and is not listed).
   Mutation check for M9: each mutant removes or weakens ONE rule; test/academy-m9.pg.test.js must fail on every one (and
   pass on the clean code first). Files are restored after each run. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const SQL = path.join(__dirname, '..', 'supabase', 'academy_p2_m9_refunds.sql');
const R = f => path.join(__dirname, '..', 'netlify', 'functions', f);
const ADM = R('academy-admin-api.js'), LRN = R('_academy_learner.js');
const M = [
  { f: SQL, from: "    when (select coalesce(head.is_test, false) from head) then false\n", to: "    when (select coalesce(head.is_test, false) from head) then true\n", why: 'real branch under a TEST head office free again' },
  { f: SQL, from: "  if v_reason is null or length(v_reason) < 5 then\n    raise exception 'academy: a price change needs a reason", to: "  if false then\n    raise exception 'academy: a price change needs a reason", why: 'price change without a reason' },
  { f: SQL, from: "  if tg_table_name = 'academy_price_history' then raise exception", to: "  if false then raise exception", why: 'price history editable' },
  { f: SQL, from: "  if v_p.paid_at is null or v_p.paid_at < now() - interval '14 days' then", to: "  if false then", why: 'refund requests after 14 days' },
  { f: SQL, from: "  perform academy_op_actor_learner(p_actor, v_p.learner_id);\n  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then\n    raise exception 'academy: tell us", to: "  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then\n    raise exception 'academy: tell us", why: 'anyone may ask for a refund of any purchase' },
  { f: SQL, from: "  if exists (select 1 from academy_refund_requests where purchase_id = v_p.id and status in ('requested','approved','declined')) then", to: "  if false then", why: 'repeated requests' },
  { f: SQL, from: "create function public.academy_sale_op_refund_decide(p_actor text, p_request_id uuid, p_decision text, p_reason text) returns jsonb\nlanguage plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$\ndeclare v_r academy_refund_requests; v_p academy_purchases;\nbegin\n  perform academy_content_actor_president(p_actor);", to: "create function public.academy_sale_op_refund_decide(p_actor text, p_request_id uuid, p_decision text, p_reason text) returns jsonb\nlanguage plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$\ndeclare v_r academy_refund_requests; v_p academy_purchases;\nbegin\n  perform academy_op_actor_staff(p_actor);", why: 'any administrator decides refunds (database)' },
  { f: SQL, from: "  if v_r.status <> 'requested' then raise exception 'academy: this request was already decided'", to: "  if false then raise exception 'academy: this request was already decided'", why: 'a decision changed afterwards' },
  { f: SQL, from: "  if new.amount_refunded_cents < old.amount_refunded_cents then new.amount_refunded_cents := old.amount_refunded_cents; end if;", to: "", why: 'late smaller refund lowers the record' },
  { f: SQL, from: "  if new.status = 'refunded' and old.status is distinct from 'refunded' then\n    update academy_refund_requests", to: "  if false then\n    update academy_refund_requests", why: 'Stripe refund does not close the request' },
  { f: SQL, from: "  if v_rev.decision = 'block' or (v_n >= 2 and v_rev.decision is distinct from 'allow') then", to: "  if v_rev.decision = 'block' then", why: 'repeat refunders not reviewed' },
  { f: SQL, from: "  if v_rev.decision = 'block' or (v_n >= 2 and v_rev.decision is distinct from 'allow') then", to: "  if (v_n >= 2 and v_rev.decision is distinct from 'allow') then", why: 'block ignored' },
  { f: SQL, from: "revoke all on function public.academy_purchase_op_set_price(text,uuid,jsonb) from public, anon, authenticated, service_role;", to: "", why: 'M8 reason-less price op still callable' },
  { f: ADM, from: "    if (reason.length < 5) A.refuse(400, 'invalid', 'Give a reason for the price change (at least 5 characters).');\n", to: "", why: 'API accepts a short reason (database still refuses)' },
  { f: ADM, from: "        stripe_payment_intent: r.status === 'approved' ? (p.stripe_payment_intent || null) : null }); }),", to: "        stripe_payment_intent: p.stripe_payment_intent || null }); }),", why: 'payment id shown before approval' },
  { f: LRN, from: "      can_request_refund: m9 && !q && r.status === 'paid'", to: "      can_request_refund: m9 && r.status === 'paid'", why: 'refund button shown after a request' },
];
const runTest = () => spawnSync(process.execPath, [path.join(__dirname, 'academy-m9.pg.test.js')], { encoding: 'utf8', env: process.env, timeout: 900000 });
const control = runTest();
if (control.status !== 0) { console.log('CONTROL FAILED — mutation results would be meaningless\n' + control.stdout.slice(-1500)); process.exit(1); }
let killed = 0; const survived = [];
for (const m of M) {
  const orig = fs.readFileSync(m.f, 'utf8');
  if (!orig.includes(m.from)) { console.log('  MISSING ' + m.why); survived.push(m.why + ' (pattern missing)'); continue; }
  fs.writeFileSync(m.f, orig.replace(m.from, m.to));
  try { const r = runTest(); if (r.status !== 0) { killed++; console.log('  killed   ' + m.why); } else { survived.push(m.why); console.log('  SURVIVED ' + m.why); } }
  finally { fs.writeFileSync(m.f, orig); }
}
console.log(`\nacademy-m9 mutants: ${killed}/${M.length} killed${survived.length ? ' — survivors: ' + survived.join('; ') : ''}`);
process.exit(survived.length ? 1 : 0);
