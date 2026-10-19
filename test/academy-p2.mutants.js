/* Mutation check for Phase 2 commerce: each mutant removes or weakens ONE money / access / isolation rule (in the M8
   SQL or the server code); test/academy-p2.pg.test.js must fail on every one (and pass on the clean code first).
   Files are restored after each run. ~35 s per mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const R = f => path.join(__dirname, '..', 'netlify', 'functions', f);
const SQL = path.join(__dirname, '..', 'supabase', 'academy_p2_m8_commerce.sql');
const COM = R('_academy_commerce.js'), WH = R('academy-stripe-webhook.js'), CO = R('academy-checkout.js'), CA = R('_academy_commerce_admin.js'), ADM = R('academy-admin-api.js');
const M = [
  // signature / webhook
  { f: COM, from: "  if (Math.abs(now - t) > TOLERANCE_S) return false;", to: "", why: 'stale webhook timestamps accepted' },
  { f: COM, from: "return b.length === expected.length && crypto.timingSafeEqual(b, expected);", to: "return b.length === expected.length;", why: 'any 64-hex signature accepted' },
  { f: WH, from: "  if (!C.verifySignature(raw, h['stripe-signature'] || h['Stripe-Signature'], secret)) return plain(400, { error: 'bad_signature' });", to: "", why: 'webhook signature not checked' },
  { f: WH, from: "  if (!sk || sk.mode !== mode) return plain(400, { error: 'wrong_mode' });", to: "", why: 'live event accepted by a test setup' },
  { f: WH, from: "      if (o.payment_status !== 'paid') return plain(200, { ok: true, waiting: 'payment' });", to: "", why: 'unpaid session treated as paid' },
  // checkout
  { f: CO, from: "  if (await A.pilotMode()) return null;", to: "", why: 'sales during the pilot' },
  { f: COM, from: "  if (mode === 'live' && !liveAllowed) return null;", to: "", why: 'live key used without the live switch' },
  { f: CO, from: "  if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return", to: "  if (false) return", why: 'cross-site checkout POST' },
  // SQL money rules
  { f: SQL, from: "  if v_co.mode <> p_mode or v_co.amount_cents <> p_amount_cents or v_co.currency <> lower(coalesce(p_currency, '')) then", to: "  if false then", why: 'amount mismatch grants access' },
  { f: SQL, from: "  if v_pu.id is not null then\n    perform academy_commerce_event_once(p_event_id, 'checkout.session.completed', p_mode, 'duplicate');", to: "  if false then\n    perform academy_commerce_event_once(p_event_id, 'checkout.session.completed', p_mode, 'duplicate');", why: 'second event for a paid session grants again' },
  { f: SQL, from: "  if v_p.network_included and academy_commerce_included_dealer(v_email) is not null then", to: "  if false then", why: 'network dealers charged' },
  { f: SQL, from: "  if v_test or h_test then return out || jsonb_build_object('eligible', false, 'reason', 'test_dealer'); end if;", to: "", why: 'TEST dealers free' },
  { f: SQL, from: "  if v_status <> 'active' or h_status <> 'active' then", to: "  if v_status <> 'active' then", why: 'branch of a prospect free' },
  { f: SQL, from: "  if v_class not in ('', 'dealer') or h_class not in ('', 'dealer') then", to: "  if false then", why: 'manufacturer accounts free' },
  { f: SQL, from: "  if p_patch->>'sale_mode' = 'test' and v_c.slug not like 'test-%' then", to: "  if false then", why: 'test-mode sale of a real course (first check)' },
  { f: SQL, from: "  check (sale_mode <> 'live' or rights_status in ('confirmed','not_required'))", to: "  check (true)", why: 'live sale without manufacturer rights' },
  { f: SQL, from: "  if v.paid_at < now() - interval '14 days' then", to: "  if false then", why: 'refunds after 14 days' },
  { f: SQL, from: "  if p_refunded_total <= v.refunded_cents then", to: "  if false then", why: 'late smaller refund total lowers the record' },
  { f: SQL, from: "    if v_e.status in ('not_started','in_progress') then", to: "    if v_e.status in ('not_started','in_progress','completed') then", why: 'refund takes back completed training' },
  { f: SQL, from: "  if v_rev.decision = 'block' or (v_refunds >= 2 and v_rev.decision is distinct from 'allow') then", to: "  if v_rev.decision = 'block' then", why: 'repeat refunders not reviewed' },
  { f: SQL, from: "    raise exception 'academy: only the HCPS President may change pricing, eligibility or refunds' using errcode = '42501';", to: "    null;", why: 'any administrator changes prices / refunds' },
  { f: SQL, from: "    if new.organization_id is not null and coalesce(current_setting('academy.op', true), '') not like 'commerce\\_%' then", to: "    if false then", why: 'outside access created without a purchase' },
  { f: SQL, from: "  if coalesce(current_setting('academy.op', true), '') not like 'commerce\\_%'\n     or current_user", to: "  if false\n     and current_user", why: 'commerce guard off' },
  // admin
  { f: CA, from: "const requirePresident = s => { if (!isPresident(s)) A.refuse(403, 'president_only'", to: "const requirePresident = s => { if (false) A.refuse(403, 'president_only'", why: 'API lets an admin change prices (database still refuses)' },
  { f: ADM, from: "  members = members.filter(m => !m.organization_id);", to: "", why: 'outside buyers counted as dealership learners' },
];
const runTest = () => spawnSync(process.execPath, [path.join(__dirname, 'academy-p2.pg.test.js')], { encoding: 'utf8', env: process.env, timeout: 900000 });
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
console.log(`\nacademy-p2 mutants: ${killed}/${M.length} killed${survived.length ? ' — survivors: ' + survived.join('; ') : ''}`);
process.exit(survived.length ? 1 : 0);
