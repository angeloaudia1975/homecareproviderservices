/* GOLDEN RETAIL REFERENCE — cache, fallback and monitoring for report valuation (owner directive 2026-11-06 20:55 CT, §7).
   Golden stays the authority for its product and MSRP data. A report asks Golden live (the dealer's own Golden access, a
   bounded attempt + one quick retry); every successful answer refreshes ONE shared HCPS reference of Golden's retail data —
   per SKU: name, category, official MSRP and Golden's STANDARD dealer price (never an account- or dealer-specific price) —
   stored server-side only (app_settings key golden_retail_ref, RLS service-role only). When Golden is slow or down, or the
   dealer is not linked to Golden, the report values from that reference while it is fresh enough (≤ STALE_MAX), clearly
   labelled with its date; past that the purchases are "Golden catalog unavailable" — never a zero, never invented.
   The dealer's own account price is used ONLY live, and only to tell a plain configuration from a paid upgrade.
   Monitoring (app_settings golden_ref_monitor, throttled): calls, timeouts, failures, last response time, last success,
   SKUs in the reference, and the match coverage of the last report that used it. */
'use strict';
const KEY = 'golden_retail_ref', MON = 'golden_ref_monitor';
const REFRESH_EVERY = 6 * 3600e3;          // rewrite the stored reference at most every 6 h
const STALE_MAX = 7 * 24 * 3600e3;          // a stored reference older than 7 days is not used
const TRY_MS = 3000, RETRY_MS = 2500, RETRY_IF_FAST = 1500;
const pos = (v) => { const n = Number(v); return n > 0 ? Math.round(n * 100) / 100 : null; };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const MEM = { ref: null, at: 0, mon: { calls: 0, timeouts: 0, failures: 0, last_ms: null, last_error: null, last_success_at: null, stale_uses: 0, unavailable: 0 }, monWritten: 0 };

function within(p, ms) { return Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]); }

/* live Golden catalog → { products } or a reason; never throws */
async function live(fetchCatalog) {
  const t0 = Date.now(); MEM.mon.calls++;
  let r = await within(Promise.resolve().then(fetchCatalog), TRY_MS);
  if (!(r.v && r.v.ok) && Date.now() - t0 < RETRY_IF_FAST) r = await within(Promise.resolve().then(fetchCatalog), RETRY_MS);   // one quick retry
  MEM.mon.last_ms = Date.now() - t0;
  if (r.timeout) { MEM.mon.timeouts++; MEM.mon.last_error = 'timeout'; return { reason: 'timeout' }; }
  if (r.e || !r.v) { MEM.mon.failures++; MEM.mon.last_error = String((r.e && r.e.message) || 'no answer').slice(0, 120); return { reason: 'failed' }; }
  const v = r.v;
  if (v.reason === 'no_access') return { reason: 'no_access' };
  const j = v.json;
  if (!v.ok || !j) { MEM.mon.failures++; MEM.mon.last_error = 'status ' + (v.status || '?'); return { reason: 'failed' }; }
  if (j.linked !== true) return { reason: 'not_linked' };
  if (!Array.isArray(j.products)) { MEM.mon.failures++; MEM.mon.last_error = 'no product list'; return { reason: 'failed' }; }
  MEM.mon.last_success_at = new Date().toISOString(); MEM.mon.last_error = null;
  return { products: j.products };
}

/* one shared reference: official MSRP + STANDARD price only */
function toReference(products) {
  const items = {};
  for (const g of products || []) {
    if (!g || !g.sku) continue;
    const msrp = pos(g.msrp), std = g.price_source === 'standard' ? pos(g.dealer_price) : null;
    if (!msrp && !std) continue;
    items[String(g.sku).toUpperCase()] = { s: String(g.sku), n: String(g.name || g.title || '').slice(0, 120), c: g.category ? String(g.category).slice(0, 60) : null, m: msrp, d: std };
  }
  return items;
}
function catalogFrom(items, products, asOf, source) {
  const out = new Map(); const own = new Map();
  for (const g of products || []) if (g && g.sku) own.set(String(g.sku).toUpperCase(), pos(g.dealer_price));
  for (const [k, x] of Object.entries(items || {})) {
    out.set(k, { code: x.s, name: x.n, category: x.c, ref: x.m || (x.d ? r2(2 * x.d) : null), ref_source: x.m ? 'msrp' : x.d ? 'calculated' : 'none', cost: x.d,
      base_price: own.has(k) ? own.get(k) : null });   // the dealer's own price: live only, never stored
  }
  return { byCode: out, readable: true, source, as_of: asOf };
}

async function readStored(sbGet) {
  if (MEM.ref && Date.now() - MEM.at < 600e3) return MEM.ref;
  try { const r = await sbGet(`app_settings?key=eq.${KEY}&select=value`); const v = r && r[0] && r[0].value; if (v && v.items && v.at) { MEM.ref = v; MEM.at = Date.now(); return v; } } catch (e) { console.error('golden ref read failed', e && String(e.message).slice(0, 100)); }
  return null;
}
async function upsert(sbSend, key, value) {
  await sbSend('POST', 'app_settings?on_conflict=key', { key, value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

/* main: { catalog|null, reason, source:'live'|'stored', as_of }  (deps: sbGet, sbSend, fetchCatalog) */
async function goldenReference(deps, opts) {
  const now = (opts && opts.now) || Date.now();
  const got = await live(deps.fetchCatalog);
  const stored = await readStored(deps.sbGet);
  if (got.products) {
    const items = toReference(got.products);
    const fresh = stored && now - Date.parse(stored.at) < REFRESH_EVERY;
    if (!fresh && Object.keys(items).length) {
      const v = { at: new Date(now).toISOString(), count: Object.keys(items).length, items };
      try { await upsert(deps.sbSend, KEY, v); MEM.ref = v; MEM.at = Date.now(); } catch (e) { console.error('golden ref write failed', e && String(e.message).slice(0, 100)); }
    }
    return { catalog: catalogFrom(items, got.products, new Date(now).toISOString(), 'live'), source: 'live', as_of: new Date(now).toISOString() };
  }
  if (stored && now - Date.parse(stored.at) <= STALE_MAX) {
    MEM.mon.stale_uses++;
    if (got.reason === 'timeout' || got.reason === 'failed') console.error('golden catalog ' + got.reason + ' — valuing from the stored reference of ' + stored.at);
    return { catalog: catalogFrom(stored.items, null, stored.at, 'stored'), source: 'stored', as_of: stored.at, live_reason: got.reason };
  }
  MEM.mon.unavailable++;
  console.error('golden valuation unavailable: ' + got.reason + (stored ? ' (stored reference too old: ' + stored.at + ')' : ' (no stored reference)'));
  return { catalog: null, reason: got.reason === 'no_access' || got.reason === 'not_linked' ? 'golden_not_connected' : 'golden_unavailable', live_reason: got.reason };
}

/* monitoring: written at most every 5 minutes per instance (plus the coverage of the report that just used Golden) */
async function recordMonitor(sbSend, extra) {
  if (Date.now() - MEM.monWritten < 300e3) return;
  MEM.monWritten = Date.now();
  try { await upsert(sbSend, MON, Object.assign({ at: new Date().toISOString(), reference_skus: MEM.ref ? MEM.ref.count : null, reference_as_of: MEM.ref ? MEM.ref.at : null }, MEM.mon, extra || {})); } catch (e) { /* monitoring never breaks a report */ }
}
module.exports = { goldenReference, recordMonitor, toReference, catalogFrom, _MEM: MEM, STALE_MAX, REFRESH_EVERY };
