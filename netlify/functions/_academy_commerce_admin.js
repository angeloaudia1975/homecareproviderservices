/* HCPS Academy — Phase 2 commerce in the Academy Command Center (registered in academy-admin-api.js, behind the same
   staff sign-in, academy_admin switch and administrator check).
     READ  (administrators):  commerce_overview · eligibility_check {dealer_id | q}
     WRITE (the President only, checked here AND in the database):
           set_price {course_id, patch, reason} · set_eligibility_override {dealer_id, eligible: true|false|null, reason}
           buyer_review {email, decision: allow|block, reason} · refund_decide {purchase_id, decision: approve|decline, reason}
   Approving a refund records the decision first (audited), then asks Stripe for the refund with an idempotency key — a
   retry never refunds twice. The purchase becomes "refunded" only when Stripe's signed refund event arrives.
   Outside organizations are shown here apart from dealerships; they never appear in dealer figures. Nothing returned
   here carries a key, a signature or card data. */
const A = require('./_academy.js');
const C = require('./_academy_commerce.js');

const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPresident = s => !!s && s.kind === 'staff' && s.role === 'president';
const requirePresident = s => { if (!isPresident(s)) A.refuse(403, 'president_only', 'Only the President may change pricing, eligibility or refunds.'); };
const reason = v => { const s = A.text(v, 500, 'Reason'); if (s.length < 5) A.refuse(400, 'invalid', 'Give a reason (at least 5 characters).'); return s; };
async function byIds(table, ids, select) {
  const list = [...new Set((ids || []).filter(x => UUID.test(String(x))).map(String))];
  const out = []; for (let i = 0; i < list.length; i += 150) out.push(...await A.sbGet(`${table}?id=in.(${list.slice(i, i + 150).map(enc).join(',')})&select=${select}`));
  return out;
}

const READ = {}, WRITE = {};

READ.commerce_overview = async () => {
  const [sw, courses, prices, history, purchases, overrides, reviews] = await Promise.all([
    A.switches(),
    A.sbGet(`academy_courses?select=id,slug,title,course_type,manufacturer_slug,status&order=title.asc`),
    A.sbGet(`academy_course_prices?select=*`),
    A.sbGet(`academy_course_price_history?select=id,course_id,before,after,reason,actor,at&order=id.desc&limit=30`),
    A.sbGet(`academy_purchases?select=id,course_id,buyer_email,organization_id,amount_cents,currency,mode,status,access,access_note,paid_at,refund_requested_at,refund_request_reason,refunded_cents,refunded_at,review_note&order=paid_at.desc&limit=300`),
    A.sbGet(`academy_eligibility_overrides?superseded_at=is.null&select=id,dealer_id,eligible,reason,set_by,set_at&order=id.desc`),
    A.sbGet(`academy_buyer_reviews?superseded_at=is.null&select=id,email,decision,reason,decided_by,decided_at&order=id.desc`),
  ]);
  const key = C.stripeKey(true);
  const orgs = Object.fromEntries((await byIds('academy_organizations', purchases.map(p => p.organization_id), 'id,name')).map(o => [String(o.id), o.name]));
  const dealers = Object.fromEntries((await byIds('dealers', overrides.map(o => o.dealer_id), 'id,business_name')).map(d => [String(d.id), d.business_name]));
  const title = Object.fromEntries(courses.map(c => [String(c.id), c.title]));
  const refundsBy = {}; for (const p of purchases) if (p.refunded_cents > 0) refundsBy[p.buyer_email] = (refundsBy[p.buyer_email] || 0) + 1;
  const paid = purchases.filter(p => p.mode === 'live');
  return {
    ok: true,
    readiness: {
      payments_switch: sw.academy_payments, live_switch: sw.academy_payments_live, academy_open: sw.academy_open,
      stripe_key_mode: key ? key.mode : null, webhook_secret: !!C.webhookSecret(),
      live_ready: !!(sw.academy_payments && sw.academy_payments_live && key && key.mode === 'live' && C.webhookSecret()),
    },
    courses: courses.filter(c => c.course_type !== 'manufacturer_program').map(c => {
      const p = prices.find(x => String(x.course_id) === String(c.id)) || null;
      return { id: c.id, slug: c.slug, title: c.title, status: c.status, test_course: c.slug.startsWith('test-'),
               price: p && { price_cents: p.price_cents, price: C.dollars(p.price_cents), network_included: p.network_included, sale_mode: p.sale_mode,
                             rights_status: p.rights_status, rights_ref: p.rights_ref, public_note: p.public_note, updated_at: p.updated_at, updated_by: p.updated_by } };
    }),
    price_history: history.map(h => Object.assign({}, h, { course: title[String(h.course_id)] || 'Course' })),
    purchases: purchases.map(p => ({ id: p.id, course: title[String(p.course_id)] || 'Course', buyer_email: p.buyer_email,
      organization: orgs[String(p.organization_id)] || null, amount: C.dollars(p.amount_cents), amount_cents: p.amount_cents, mode: p.mode,
      status: p.status, access: p.access, access_note: p.access_note, paid_at: p.paid_at, refund_requested_at: p.refund_requested_at,
      refund_request_reason: p.refund_request_reason, refunded: C.dollars(p.refunded_cents), review_note: p.review_note,
      buyer_refunds: refundsBy[p.buyer_email] || 0 })),
    totals: { live_purchases: paid.length, live_revenue: C.dollars(paid.reduce((s, p) => s + p.amount_cents - p.refunded_cents, 0)),
              refund_requests: purchases.filter(p => p.status === 'refund_requested').length,
              needs_review: purchases.filter(p => p.access === 'needs_review' || p.status === 'disputed').length },
    overrides: overrides.map(o => Object.assign({}, o, { dealer: dealers[String(o.dealer_id)] || null })),
    buyer_reviews: reviews,
  };
};

READ.eligibility_check = async (staff, b) => {
  let ids;
  if (b.dealer_id) ids = [A.uuid(b.dealer_id, 'dealership')];
  else {
    const q = String(b.q || '').trim();
    if (q.length < 2 || q.length > 80 || /[*,()]/.test(q)) A.refuse(400, 'invalid', 'Type at least 2 letters of the dealership name.');
    ids = (await A.sbGet(`dealers?business_name=ilike.*${enc(q)}*&select=id&limit=20`)).map(d => d.id);
  }
  if (!ids.length) return { ok: true, dealers: [] };
  const rows = await byIds('dealers', ids, 'id,business_name,parent_id,status,account_class,is_test');
  const out = [];
  for (const d of rows) out.push(Object.assign({ id: d.id, dealer: d.business_name, status: d.status || null, account_class: d.account_class || null,
                                                 is_test: !!d.is_test, branch: !!d.parent_id }, { eligibility: await A.eligibility(d.id) }));
  return { ok: true, dealers: out.sort((a, b) => String(a.dealer).localeCompare(String(b.dealer))) };
};

const PATCH_KEYS = ['price_cents', 'network_included', 'sale_mode', 'rights_status', 'rights_ref', 'public_note'];
WRITE.set_price = async (staff, b) => {
  requirePresident(staff);
  const patch = b.patch && typeof b.patch === 'object' && !Array.isArray(b.patch) ? b.patch : A.refuse(400, 'invalid', 'Nothing to change.');
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCH_KEYS.includes(k)) A.refuse(400, 'invalid', `${k} cannot be set here.`);
    if (k === 'price_cents') { if (!Number.isInteger(v) || v < 0 || v > 1000000) A.refuse(400, 'invalid', 'The price must be a whole number of cents from 0 to 1,000,000.'); clean[k] = v; }
    else if (k === 'network_included') { if (typeof v !== 'boolean') A.refuse(400, 'invalid', 'Included for network dealers must be yes or no.'); clean[k] = v; }
    else if (k === 'sale_mode') clean[k] = A.oneOf(v, ['off', 'test', 'live'], 'Sale mode');
    else if (k === 'rights_status') clean[k] = A.oneOf(v, ['not_confirmed', 'confirmed', 'not_required'], 'Manufacturer rights');
    else clean[k] = v == null || String(v).trim() === '' ? null : A.text(v, k === 'public_note' ? 300 : 500, k === 'public_note' ? 'Public note' : 'Rights reference');
  }
  if (!Object.keys(clean).length) A.refuse(400, 'invalid', 'Nothing to change.');
  const r = await A.commerceOp('set_price', { p_actor: A.actorLabel(staff), p_course_id: A.uuid(b.course_id, 'course'), p_patch: clean, p_reason: reason(b.reason) });
  return { ok: true, audited: true, price: r.price };
};

WRITE.set_eligibility_override = async (staff, b) => {
  requirePresident(staff);
  const e = b.eligible === true || b.eligible === false ? b.eligible : (b.eligible == null ? null : A.refuse(400, 'invalid', 'Choose included, not included or remove.'));
  const r = await A.commerceOp('set_override', { p_actor: A.actorLabel(staff), p_dealer_id: A.uuid(b.dealer_id, 'dealership'), p_eligible: e, p_reason: reason(b.reason) });
  return { ok: true, audited: true, unchanged: !!r.unchanged, eligibility: r.eligibility };
};

WRITE.buyer_review = async (staff, b) => {
  requirePresident(staff);
  const addr = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || addr.length > 254) A.refuse(400, 'invalid', 'Enter a valid email address.');
  await A.commerceOp('buyer_review', { p_actor: A.actorLabel(staff), p_email: addr, p_decision: A.oneOf(b.decision, ['allow', 'block'], 'Decision'), p_reason: reason(b.reason) });
  return { ok: true, audited: true };
};

WRITE.refund_decide = async (staff, b) => {
  requirePresident(staff);
  const id = A.uuid(b.purchase_id, 'purchase');
  const decision = A.oneOf(b.decision, ['approve', 'decline'], 'Decision');
  const r = await A.commerceOp('refund_decide', { p_actor: A.actorLabel(staff), p_purchase_id: id, p_decision: decision, p_reason: reason(b.reason) });
  if (decision === 'decline') return { ok: true, audited: true };
  const sk = C.stripeKey(await A.switchOn('academy_payments_live'));
  if (!sk || sk.mode !== r.mode) return { ok: true, audited: true, refund: 'pending', message: 'The refund is approved and recorded. Stripe could not be reached with the matching key, so it was not sent yet — approve again once the key is set.' };
  if (!(r.amount_cents > 0)) return { ok: true, audited: true, refund: 'nothing_left' };
  try {
    await C.createRefund(sk, { id, payment_intent_id: r.payment_intent_id }, r.amount_cents);
  } catch (e) {
    console.error('[academy-commerce] refund', e && e.status, e && e.type);
    return { ok: true, audited: true, refund: 'pending', message: 'The refund is approved and recorded, but Stripe did not accept it yet. Approve again to retry; it can never be sent twice.' };
  }
  return { ok: true, audited: true, refund: 'sent', message: 'Stripe accepted the refund. The purchase shows as refunded when Stripe confirms it.' };
};

const PRESIDENT_ONLY = Object.keys(WRITE);
module.exports = { READ, WRITE, PRESIDENT_ONLY };
