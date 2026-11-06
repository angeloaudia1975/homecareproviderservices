/* C3-07 Stage 6 — DEALER & BRANCH REPORTING (pure; no I/O). Built from HCPS's own records only:
     • PURCHASES  = manufacturer-reported sales (monthly_sales: sales reports and commission statements). The authoritative
                    purchase history. A commission-lane row that repeats a sales-report row (same location, line, month, qty and
                    amount — the MI-1a cross-lane rule) is counted ONCE. A row with no amount is never counted as $0.
     • PORTAL ORDERS = orders placed in the 360 Dealer Portal (cancelled excluded). Shown APART from purchases and never added to
                    them: once the manufacturer ships and reports an order, it appears in purchases too.
     • QUOTES     = saved customer quotes — activity, never sales (their prices are resolved only when a quote is printed).
     • OPPORTUNITIES = products the HCPS dealer network orders (other dealers, ≥ MIN_DEALERS of them, no names or figures) on
                    lines this company already buys, that this scope hasn't bought in 12 months. A suggestion, not a forecast.
   Year-over-year is shown only where HCPS's history for that line reaches back over the whole comparison window
   (coverageStart = the first month HCPS holds any report for the line); otherwise it says so instead of comparing to zero.
   Nothing here estimates costs, margins or customer traffic. */
'use strict';
const MIN_DEALERS = 3;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };   // a blank is never 0
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ym = (s) => String(s || '').slice(0, 7);
const lane = (r) => (r.source === 'sales_report' ? 'sales_report' : (r.source === 'commission' || (!r.source && !r.external_ref)) ? 'commission' : 'other');
function monthLabel(m) { const [y, mo] = String(m).split('-'); return (MONTHS[Number(mo) - 1] || '?') + ' ' + y; }
function addMonths(m, k) { let [y, mo] = m.split('-').map(Number); mo += k; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return y + '-' + String(mo).padStart(2, '0'); }
function pct(cur, prev) { return prev > 0 ? Math.round((cur - prev) / prev * 1000) / 10 : null; }

/* the comparison window: a past year = Jan–Dec; the current year = Jan through this month (the same months last year) */
function windowFor(year, today) {
  const Y = Number(year), ty = Number(String(today).slice(0, 4)), tm = Number(String(today).slice(5, 7));
  const last = Y === ty ? tm : 12;
  const months = []; for (let i = 1; i <= last; i++) months.push(Y + '-' + String(i).padStart(2, '0'));
  return { year: String(Y), months, prior: months.map((m) => addMonths(m, -12)), ytd: Y === ty, through: months[months.length - 1] };
}

/* manufacturer-reported purchases with the cross-lane duplicates removed */
function cleanSales(rows) {
  const notes = { duplicates_removed: 0, rows_without_amount: 0 };
  const key = (r) => [r.dealer_id, r.manufacturer, ym(r.period), num(r.qty), r2(r.amount)].join('|');
  const salesKeys = new Map();
  for (const r of rows) if (lane(r) === 'sales_report' && num(r.amount) != null) salesKeys.set(key(r), (salesKeys.get(key(r)) || 0) + 1);
  const out = [];
  for (const r of rows) {
    if (num(r.amount) == null) { notes.rows_without_amount++; continue; }
    if (lane(r) === 'commission') { const k = key(r), n = salesKeys.get(k) || 0; if (n > 0) { salesKeys.set(k, n - 1); notes.duplicates_removed++; continue; } }
    out.push({ loc: String(r.dealer_id), mfr: String(r.manufacturer || ''), m: ym(r.period), code: String(r.product_code || ''), name: r.product_name || r.product_code || 'Item', qty: num(r.qty) || 0, amt: r2(r.amount) });
  }
  return { rows: out, notes };
}

function build(input) {
  const { year, today, locations, scope } = input;
  const W = windowFor(year, today);
  const ids = new Set(scope === 'company' ? locations.map((l) => String(l.id)) : [String(scope)]);
  const mName = (s) => (input.mfrName && input.mfrName[s]) || s || '—';
  const cat = (s, c) => { const f = input.catalog && input.catalog[s]; const p = f && f[c]; return p ? p.category || 'Uncategorized' : null; };
  const coverage = input.coverageStart || {};
  const covered = (s) => !!coverage[s] && coverage[s] <= W.prior[0];

  const S = cleanSales(input.sales || []);
  const sales = S.rows.filter((r) => ids.has(r.loc));
  const inW = new Set(W.months), inP = new Set(W.prior);
  const cur = sales.filter((r) => inW.has(r.m)), pri = sales.filter((r) => inP.has(r.m));
  const sum = (a) => r2(a.reduce((s, r) => s + r.amt, 0));
  const lastM = addMonths(ym(today), 0), twelve = new Set(Array.from({ length: 12 }, (_, i) => addMonths(lastM, -i)));

  // lines active in either window — year-over-year for the total only when every one of them has full history
  const linesInPlay = [...new Set(cur.concat(pri).map((r) => r.mfr))];
  const uncovered = linesInPlay.filter((s) => !covered(s));
  const totalCur = sum(cur), totalPri = uncovered.length ? null : sum(pri);

  // by manufacturer
  const byM = new Map();
  for (const r of cur) { const x = byM.get(r.mfr) || { slug: r.mfr, name: mName(r.mfr), purchases: 0, units: 0 }; x.purchases = r2(x.purchases + r.amt); x.units += r.qty; byM.set(r.mfr, x); }
  for (const r of pri) if (!byM.has(r.mfr)) byM.set(r.mfr, { slug: r.mfr, name: mName(r.mfr), purchases: 0, units: 0 });
  const manufacturers = [...byM.values()].map((x) => {
    const p = covered(x.slug) ? sum(pri.filter((r) => r.mfr === x.slug)) : null;
    return Object.assign(x, { prior: p, change_pct: p == null ? null : pct(x.purchases, p), share_pct: totalCur > 0 ? Math.round(x.purchases / totalCur * 1000) / 10 : 0,
      history_from: covered(x.slug) ? null : (coverage[x.slug] || null) });
  }).sort((a, b) => b.purchases - a.purchases || (b.prior || 0) - (a.prior || 0));

  // by category (catalog category of each SKU; a SKU no current catalog lists is shown as such)
  const catOf = (r) => cat(r.mfr, r.code) || 'Not in current catalog';
  const byC = new Map();
  const touch = (c) => byC.get(c) || byC.set(c, { category: c, purchases: 0, units: 0, prior: 0, partial: false }).get(c);
  for (const r of cur) { const x = touch(catOf(r)); x.purchases = r2(x.purchases + r.amt); x.units += r.qty; if (!covered(r.mfr)) x.partial = true; }
  for (const r of pri) { const x = touch(catOf(r)); if (covered(r.mfr)) x.prior = r2(x.prior + r.amt); else x.partial = true; }
  const categories = [...byC.values()].map((x) => Object.assign(x, { prior: x.partial ? null : x.prior, change_pct: x.partial ? null : pct(x.purchases, x.prior) }))
    .sort((a, b) => b.purchases - a.purchases);
  const declining = categories.filter((c) => c.prior != null && c.prior >= 500 && c.change_pct != null && c.change_pct <= -20)
    .map((c) => ({ category: c.category, purchases: c.purchases, prior: c.prior, change_pct: c.change_pct }));

  // top products
  const byP = new Map();
  for (const r of cur) { const k = r.mfr + '|' + r.code; const x = byP.get(k) || { manufacturer: r.mfr, manufacturer_name: mName(r.mfr), code: r.code, name: r.name, qty: 0, purchases: 0, category: catOf(r) }; x.qty += r.qty; x.purchases = r2(x.purchases + r.amt); byP.set(k, x); }
  const top_products = [...byP.values()].sort((a, b) => b.purchases - a.purchases).slice(0, 15);

  // monthly series (prior-year bars only from lines with full history)
  const monthly = W.months.map((m, i) => ({ month: m, label: MONTHS[i], purchases: sum(cur.filter((r) => r.m === m)),
    prior: sum(pri.filter((r) => r.m === W.prior[i] && covered(r.mfr))) }));

  // portal orders (apart from purchases; never summed with them)
  const orders = (input.orders || []).filter((o) => ids.has(String(o.dealer_id)));
  const live = orders.filter((o) => o.status !== 'cancelled' && inW.has(ym(o.submitted_at)));
  const portal = { orders: live.length, merchandise: r2(live.reduce((s, o) => s + (num(o.subtotal) || 0), 0)), cancelled_excluded: orders.filter((o) => o.status === 'cancelled' && inW.has(ym(o.submitted_at))).length,
    by_status: live.reduce((a, o) => { const s = o.status || 'submitted'; a[s] = (a[s] || 0) + 1; return a; }, {}),
    by_manufacturer: [...live.reduce((a, o) => { const x = a.get(o.manufacturer) || { slug: o.manufacturer, name: mName(o.manufacturer), orders: 0, merchandise: 0 }; x.orders++; x.merchandise = r2(x.merchandise + (num(o.subtotal) || 0)); return a.set(o.manufacturer, x); }, new Map()).values()].sort((a, b) => b.merchandise - a.merchandise) };

  // quotes (activity, not sales)
  const qs = (input.quotes || []).filter((q) => ids.has(String(q.location_id)) && String(q.created_at || '').slice(0, 4) === W.year);
  const quotes = { created: qs.length, sent: qs.filter((q) => q.status === 'sent').length, draft: qs.filter((q) => q.status !== 'sent').length, lines: qs.reduce((s, q) => s + (Array.isArray(q.lines) ? q.lines.length : (q.line_count || 0)), 0) };

  // per-location scorecards ("Vital Signs")
  const ordersAll = input.orders || [];
  const vitals = (locIds) => {
    const L = new Set(locIds);
    const s = S.rows.filter((r) => L.has(r.loc));
    const c = s.filter((r) => inW.has(r.m)), p = s.filter((r) => inP.has(r.m));
    const unc = [...new Set(c.concat(p).map((r) => r.mfr))].filter((x) => !covered(x));
    const lastPurchase = s.reduce((a, r) => (r.m > a ? r.m : a), '');
    const lastOrder = ordersAll.filter((o) => L.has(String(o.dealer_id)) && o.status !== 'cancelled').reduce((a, o) => (String(o.submitted_at || '') > a ? String(o.submitted_at) : a), '');
    const t12 = s.filter((r) => twelve.has(r.m));
    const pur = sum(c), prev = unc.length ? null : sum(p);
    return { purchases: pur, prior: prev, change_pct: prev == null ? null : pct(pur, prev), prior_unavailable_lines: unc.map(mName),
      last_purchase_month: lastPurchase || null, last_portal_order: lastOrder ? lastOrder.slice(0, 10) : null,
      active_lines_12m: [...new Set(t12.map((r) => r.mfr))].length, avg_month_12m: r2(sum(t12) / 12),
      top_line: (() => { const m = new Map(); c.forEach((r) => m.set(r.mfr, (m.get(r.mfr) || 0) + r.amt)); const t = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; return t ? mName(t[0]) : null; })() };
  };
  const scorecard = vitals([...ids]);
  const branches = scope === 'company' ? locations.map((l) => Object.assign({ id: l.id, name: l.name, city: l.city || '', state: l.state || '' }, vitals([String(l.id)])))
    .sort((a, b) => b.purchases - a.purchases) : [];

  // opportunities: network favourites on lines this company buys, not bought here in 12 months
  const boughtLines = new Set(S.rows.filter((r) => ids.has(r.loc) && r.m >= addMonths(lastM, -23)).map((r) => r.mfr));
  const recent = new Set(S.rows.filter((r) => ids.has(r.loc) && twelve.has(r.m)).map((r) => r.mfr + '|' + r.code));
  for (const o of orders) if (o.status !== 'cancelled' && twelve.has(ym(o.submitted_at))) for (const i of (o.items || [])) recent.add(o.manufacturer + '|' + i.code);
  const retired = input.isRetired || (() => false);
  const opportunities = (input.network || [])
    .filter((n) => n.dealers >= MIN_DEALERS && boughtLines.has(n.manufacturer) && !retired(n.manufacturer) && !recent.has(n.manufacturer + '|' + n.code) && cat(n.manufacturer, n.code))
    .sort((a, b) => b.dealers - a.dealers || b.units - a.units).slice(0, 10)
    .map((n) => ({ manufacturer: n.manufacturer, manufacturer_name: mName(n.manufacturer), code: n.code, name: (input.catalog[n.manufacturer][n.code] || {}).name || n.name || n.code,
      category: cat(n.manufacturer, n.code), dealers: n.dealers }));

  const notes = [];
  if (S.notes.duplicates_removed) notes.push(`${S.notes.duplicates_removed} commission-statement line(s) that repeat a sales-report line were counted once.`);
  if (S.notes.rows_without_amount) notes.push(`${S.notes.rows_without_amount} reported line(s) without an amount are not counted.`);
  if (uncovered.length) notes.push('Year-over-year totals are not shown because HCPS history does not cover the whole comparison period for: ' + uncovered.map((s) => mName(s) + (coverage[s] ? ` (from ${monthLabel(coverage[s])})` : '')).join(', ') + '.');
  const noCat = [...new Set(cur.map((r) => r.mfr))].filter((s) => !(input.catalog && input.catalog[s]));
  if (noCat.length) notes.push('Categories are unavailable for: ' + noCat.map(mName).join(', ') + '.');

  return { period: { year: W.year, ytd: W.ytd, from: W.months[0], through: W.through, prior_from: W.prior[0], prior_through: W.prior[W.prior.length - 1], label: (W.ytd ? 'Year to date ' : '') + W.year + (W.ytd ? ` (Jan–${MONTHS[W.months.length - 1]})` : '') },
    scorecard, purchases: { total: totalCur, prior: totalPri, change_pct: totalPri == null ? null : pct(totalCur, totalPri), units: cur.reduce((s, r) => s + r.qty, 0) },
    monthly, manufacturers, categories, declining_categories: declining, top_products, branches, portal, quotes, opportunities, notes,
    years: [...new Set(S.rows.filter((r) => ids.has(r.loc)).map((r) => r.m.slice(0, 4)))].filter(Boolean).sort().reverse() };
}

/* the facts an AI recommendation may use — every one carries an id the recommendation must cite */
function facts(rep, scopeName) {
  const F = []; const add = (id, text) => F.push({ id, text });
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  add('total', `${scopeName}: purchases ${rep.period.label} ${money(rep.purchases.total)}` + (rep.purchases.prior != null ? `; same period last year ${money(rep.purchases.prior)} (${rep.purchases.change_pct}% change)` : '; no full prior-year history'));
  rep.manufacturers.slice(0, 8).forEach((m, i) => add('mfr' + i, `${m.name}: ${money(m.purchases)}` + (m.prior != null ? `, last year ${money(m.prior)}` + (m.change_pct != null ? ` (${m.change_pct}%)` : '') : '')));
  rep.categories.slice(0, 8).forEach((c, i) => add('cat' + i, `Category ${c.category}: ${money(c.purchases)}` + (c.prior != null ? `, last year ${money(c.prior)}` : '')));
  rep.declining_categories.forEach((c, i) => add('down' + i, `Declining category ${c.category}: ${c.change_pct}% versus last year`));
  rep.top_products.slice(0, 5).forEach((p, i) => add('top' + i, `Top product ${p.name} (${p.manufacturer_name}): ${p.qty} units, ${money(p.purchases)}`));
  rep.opportunities.slice(0, 6).forEach((o, i) => add('opp' + i, `${o.name} (${o.manufacturer_name}, ${o.category}) is ordered by ${o.dealers} other HCPS dealers and not by ${scopeName} in the past 12 months`));
  rep.branches.slice(0, 8).forEach((b, i) => add('br' + i, `Location ${b.name}: ${money(b.purchases)}` + (b.change_pct != null ? ` (${b.change_pct}% vs last year)` : '')));
  if (rep.portal.orders) add('portal', `${rep.portal.orders} portal orders in the period`);
  if (rep.quotes.created) add('quotes', `${rep.quotes.created} customer quotes created (${rep.quotes.sent} sent)`);
  return F;
}
/* every number in an AI sentence must be one of the facts' numbers (no new figures, no totals the facts don't state) */
function numbersOk(text, F) {
  const allowed = new Set(); const grab = (s) => (String(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map((x) => String(Number(x)));
  F.forEach((f) => grab(f.text).forEach((x) => allowed.add(x)));
  return grab(text).every((x) => allowed.has(x));
}
function checkRecommendations(list, F) {
  const ids = new Set(F.map((f) => f.id));
  return (Array.isArray(list) ? list : []).filter((r) => r && typeof r.title === 'string' && typeof r.detail === 'string' && Array.isArray(r.refs) && r.refs.length
    && r.refs.every((x) => ids.has(x)) && r.title.length <= 120 && r.detail.length <= 600 && numbersOk(r.title + ' ' + r.detail, F))
    .slice(0, 5).map((r) => ({ title: r.title.trim(), detail: r.detail.trim(), refs: r.refs }));
}

module.exports = { build, cleanSales, windowFor, facts, numbersOk, checkRecommendations, lane, MIN_DEALERS, monthLabel };
