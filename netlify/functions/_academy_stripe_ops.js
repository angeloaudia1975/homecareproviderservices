/* HCPS Academy — Stripe housekeeping shared by the checkout and the Command Center (security review 2026-10-20).
     expireStale()   closes, at Stripe, every checkout HCPS has superseded but Stripe would still accept (a price change, or
                     the buyer starting again), so nobody can pay an old checkout as well as the new one. Best effort: a
                     failure is reported, never thrown; a second paid checkout is also caught by the database (review).
     reconcile()     lists completed Academy checkouts in Stripe (sandbox and live, last N days) whose HCPS purchase is not
                     recorded as paid / refunded / disputed / in review — money taken without access, for the owner. */
const A = require('./_academy.js');
const STRIPE = require('./_stripe.js');
const DONE = new Set(['paid', 'refunded', 'partially_refunded', 'disputed', 'review']);

async function expireStale(limit) {
  const now = new Date().toISOString();
  let rows = [];
  try {
    rows = await A.sbGet(`academy_purchases?select=id,stripe_session_id,livemode&status=eq.superseded&stripe_session_id=not.is.null&expires_at=gt.${encodeURIComponent(now)}&order=created_at.desc&limit=${limit || 20}`);
  } catch (e) { return { checked: 0, expired: 0, failed: 0, error: 'unreadable' }; }
  let expired = 0, failed = 0;
  for (const r of rows || []) {
    try { await STRIPE.expireSession(r.stripe_session_id, r.livemode === true); expired++; }
    catch (e) { if (e && e.code === 'checkout_session_already_expired') expired++; else failed++; }
  }
  return { checked: (rows || []).length, expired, failed };
}

async function reconcile(days) {
  const since = Math.floor(Date.now() / 1000) - (days || 14) * 86400;
  const out = { days: days || 14, modes: {}, problems: [] };
  for (const live of [false, true]) {
    const mode = live ? 'live' : 'sandbox';
    if (!STRIPE.keyReady(live)) { out.modes[mode] = 'not_configured'; continue; }
    let sessions;
    try { sessions = await STRIPE.completedSessions(live, since); }
    catch (e) { out.modes[mode] = 'stripe_unreachable'; continue; }
    out.modes[mode] = { completed: sessions.length };
    if (!sessions.length) continue;
    const ids = sessions.map(s => s.session_id);
    const rows = await A.sbGet(`academy_purchases?select=id,stripe_session_id,status,livemode&stripe_session_id=in.(${ids.map(encodeURIComponent).join(',')})`);
    const by = Object.fromEntries((rows || []).map(r => [r.stripe_session_id, r]));
    for (const s of sessions) {
      if (s.payment_status !== 'paid') continue;
      const p = by[s.session_id];
      if (!p || !DONE.has(p.status) || p.livemode !== live) {
        out.problems.push({ mode, session_id: s.session_id, created: new Date(s.created * 1000).toISOString(), amount_total: s.amount_total,
          email: s.email, hcps_status: p ? p.status : 'no purchase found' });
      }
    }
  }
  return out;
}
module.exports = { expireStale, reconcile };
