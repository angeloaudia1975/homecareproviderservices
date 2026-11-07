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
   POTENTIAL RETAIL VALUATION (owner 2026-11-06): purchased quantity × the Shop retail reference, per product, with coverage
   and gaps — always labelled potential, never a sale. Nothing here estimates customer traffic. */
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

/* the window: a past year = Jan–Dec; the current year = Jan through the latest month HCPS has a report for on the lines in
   play (reports arrive weeks after a month ends — an unreported month is never shown as a month of no purchases) */
function windowFor(year, today, lastReported) {
  const Y = Number(year), ty = Number(String(today).slice(0, 4)), tm = Number(String(today).slice(5, 7));
  const lr = lastReported && String(lastReported).slice(0, 4) === String(Y) ? Number(String(lastReported).slice(5, 7)) : null;
  const last = Y === ty ? Math.max(1, Math.min(tm, lr || Math.max(1, tm - 1))) : 12;
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

/* POTENTIAL RETAIL VALUATION (owner 2026-11-06, Priorities 6–8) of purchase rows: per product, verified purchased quantity ×
   the Shop retail reference for ONE order unit (never 2× a purchase total). Only rows with a quantity, an amount and a
   reference are valued; the rest are listed as gaps with the reason. Potential gross profit = matched retail − the matched
   rows' wholesale cost; margin = profit ÷ matched retail. The dealer-custom view uses the dealer's saved retail price
   (location override → company default) where one exists and the Shop reference otherwise — it never replaces the benchmark.
   Marketing materials (signs, brochures) are not valued. */
function valuate(rows, o) {
  const pct1 = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : null);
  let total = 0, cost = 0, retail = 0, custom = 0; const customSet = new Set();
  const gaps = new Map(), byM = new Map(), byC = new Map(), byP = new Map(), byMonth = new Map();
  const uomConverted = [];
  const add = (map, k, init, f) => { const x = map.get(k) || init(); f(x); map.set(k, x); };
  for (const r of rows) {
    total += r.amt;
    if (o.isMkt(r.code, r.name, r.mfr)) { if (r.amt !== 0) add(gaps, r.mfr + '|' + r.code + '|marketing', () => ({ manufacturer: r.mfr, manufacturer_name: o.mName(r.mfr), code: r.code, name: r.name, amount: 0, units: 0, reason: 'marketing' }), (x) => { x.amount = r2(x.amount + r.amt); x.units += r.qty; }); continue; }
    const res = o.resolve(r.mfr, r.code, r.name);
    /* a credit / return (negative amount) of a matched product takes its units back out at the same reference, so a returned
       chair never stays in potential retail; its quantity sign follows the amount */
    /* review #109: a credit takes units back out only when the report prints a negative quantity (a return); an amount-only
       credit (price credit, rebate) is not a returned unit — it is listed, never valued. A Golden purchase matched only to its
       base model is valued only when it cost no more than the base model's standard price (a priced upgrade is never valued at
       the base MSRP — no invented upgrade pricing). A line whose catalog could not be read says so. */
    const q = r.qty;
    const unitCost = r.qty ? r.amt / r.qty : null;
    let reason = res && res.unavailable ? (res.reason === 'golden_not_connected' ? 'golden_not_connected' : 'catalog_unavailable') : !(Math.abs(r.qty) > 0) ? 'no_quantity' : !(r.amt !== 0) ? 'no_amount' : (r.amt < 0 && !(r.qty < 0)) ? 'credit_without_units' : !res ? 'not_in_catalog' : !(res.ref > 0) ? 'no_retail_reference'
      : (res.matched_by === 'golden_base' && !((res.base_price || res.cost) > 0 && unitCost != null && Math.abs(unitCost) <= (res.base_price || res.cost) * 1.02 + 0.01)) ? 'configuration_not_priced' : null;
    /* UNIT OF MEASURE (owner 2026-11-06 §6): the manufacturer's quantity is kept as supplied. For a product sold in packs /
       cases the retail reference is per ORDER unit, so the report's price per unit tells which unit it counted: about the
       standard order-unit cost → order units (as is); about the standard cost of ONE piece → pieces, converted to packs with
       the documented pack size (evidence kept); neither, or no standard cost to compare → "unit of measure needs review"
       — never a guessed total. Never inferred from a name; never multiplied twice. */
    let uq = q, uomConv = false;
    if (!reason && (res.pack || 1) > 1) {
      const c = res.cost, uc = unitCost == null ? null : Math.abs(unitCost);
      /* "about" a standard cost = 60%–150% of it (dealer discounts, freight-in). When BOTH readings fit (small packs) or
         neither does, the unit is not provable → review, never a guess. */
      const near = (x) => x >= 0.6 && x <= 1.5;
      const asOrder = c > 0 && uc != null && near(uc / c), asPiece = c > 0 && uc != null && near(uc * res.pack / c);
      if (asOrder && !asPiece) uq = q;
      else if (asPiece && !asOrder) { uq = q / res.pack; uomConv = true; }
      else reason = 'uom_review';
    }
    if (uomConv) uomConverted.push({ manufacturer: r.mfr, code: r.code, source_qty: q, pack: res.pack, order_units: Math.round(uq * 1000) / 1000, evidence: `reported $${r2(Math.abs(unitCost))} per unit ≈ standard $${r2(res.cost / res.pack)} per piece (pack of ${res.pack} at $${r2(res.cost)})` });
    if (reason) { if (r.amt !== 0) add(gaps, r.mfr + '|' + r.code + '|' + reason, () => ({ manufacturer: r.mfr, manufacturer_name: o.mName(r.mfr), code: r.code, name: r.name, amount: 0, units: 0, reason }), (x) => { x.amount = r2(x.amount + r.amt); x.units += q; }); continue; }
    const ret = r2(uq * res.ref);
    const cp = typeof o.custom === 'function' ? o.custom(r.loc, r.mfr, res.code || r.code) : null;
    const cRet = cp > 0 ? r2(uq * cp) : ret; if (cp > 0) customSet.add(r.mfr + '|' + r.code);
    cost += r.amt; retail += ret; custom += cRet;
    const upd = (x) => { x.cost = r2(x.cost + r.amt); x.retail = r2(x.retail + ret); x.custom_retail = r2(x.custom_retail + cRet); x.units = Math.round((x.units + uq) * 1000) / 1000; x.source_units = (x.source_units || 0) + q; };
    const init = () => ({ cost: 0, retail: 0, custom_retail: 0, units: 0 });
    add(byM, r.mfr, () => Object.assign({ slug: r.mfr, name: o.mName(r.mfr) }, init()), upd);
    add(byC, o.catOf(r), () => Object.assign({ category: o.catOf(r) }, init()), upd);
    add(byP, r.mfr + '|' + r.code, () => Object.assign({ manufacturer: r.mfr, manufacturer_name: o.mName(r.mfr), code: r.code, name: res.name || r.name, reference: res.ref, reference_source: res.ref_source, matched_by: res.matched_by || 'exact' }, init()), upd);
    add(byMonth, r.m, () => Object.assign({ month: r.m }, init()), upd);
  }
  const fin = (x) => Object.assign(x, { profit: r2(x.retail - x.cost), margin_pct: pct1(x.retail - x.cost, x.retail), custom_profit: r2(x.custom_retail - x.cost), custom_margin_pct: pct1(x.custom_retail - x.cost, x.custom_retail) });
  const list = (m) => [...m.values()].map(fin).sort((a, b) => b.retail - a.retail);
  total = r2(total); cost = r2(cost); retail = r2(retail); custom = r2(custom);
  return { purchases_total: total, matched_cost: cost, coverage_pct: pct1(cost, total),
    benchmark: { retail, profit: r2(retail - cost), margin_pct: pct1(retail - cost, retail) },
    custom: { retail: custom, profit: r2(custom - cost), margin_pct: pct1(custom - cost, custom), products_with_custom_price: customSet.size },
    difference: r2(custom - retail),
    uom: { converted: uomConverted.slice(0, 200), converted_lines: uomConverted.length, review_lines: [...gaps.values()].filter((g) => g.reason === 'uom_review').length },
    by_manufacturer: list(byM), by_category: list(byC), by_product: list(byP).slice(0, 100),
    monthly: (o.months || []).map((m) => fin(byMonth.get(m) || { month: m, cost: 0, retail: 0, custom_retail: 0, units: 0 })),
    gaps: [...gaps.values()].sort((a, b) => b.amount - a.amount), gap_amount: r2([...gaps.values()].reduce((t, g) => t + g.amount, 0)) };
}

/* input.reportedMonths: {line: ['YYYY-MM', …]} — the months HCPS holds ANY report for that line (all dealers). A month is
   compared with last year only when both that month and the same month last year were reported for the line — so a
   reporting lag, a line that started reporting recently or a gap in a line's reports is never compared as $0. */
function build(input) {
  const { year, today, locations, scope } = input;
  const ids = new Set(scope === 'company' ? locations.map((l) => String(l.id)) : [String(scope)]);
  const mName = (s) => (input.mfrName && input.mfrName[s]) || s || '—';
  /* category: the injected Shop resolver (_report_catalog: shop merge → catalog file → Golden catalog → verified legacy
     mapping) first; signs / brochures / displays → Marketing & Displays; otherwise the old catalog-file lookup */
  const resolve = typeof input.resolve === 'function' ? input.resolve : () => null;
  /* marketing (signs, brochures, displays): only an item the Shop does NOT list — a Shop product whose name says "display"
     (a pedal exerciser with an LED display, a product-filled display pack) keeps its Shop category and is valued (review #109) */
  const mktWords = typeof input.isMarketing === 'function' ? input.isMarketing : () => false;
  const listed = (s, c, nm) => { const x = s ? resolve(s, c, nm) : null; return !!(x && !x.unavailable); };
  const isMkt = (c, nm, s) => mktWords(c, nm) && !listed(s, c, nm);
  const MKT = input.marketingLabel || 'Marketing & Displays';
  const catFile = (s, c) => { const f = input.catalog && input.catalog[s]; const p = f && f[c]; return p ? p.category || 'Uncategorized' : null; };
  const cat = (s, c, nm) => { const r = resolve(s, c, nm); if (r && r.category) return r.category; if (isMkt(c, nm, s)) return MKT; return catFile(s, c); };
  const REPM = {}; for (const [k, v] of Object.entries(input.reportedMonths || {})) REPM[k] = new Set(v || []);
  const reported = (s, m) => !!(REPM[s] && REPM[s].has(m));
  const S = cleanSales(input.sales || []);
  const all = S.rows.filter((r) => ids.has(r.loc));
  const linesHere = [...new Set(all.map((r) => r.mfr))];
  const lastReported = linesHere.reduce((a, s) => { for (const m of (REPM[s] || [])) if (m > a && String(m).slice(0, 4) === String(year)) a = m; return a; }, '');
  const W = windowFor(year, today, lastReported);
  const inW = new Set(W.months), inP = new Set(W.prior);
  const comparable = (s, m) => reported(s, m) && reported(s, addMonths(m, -12));   // m = a current-window month
  const sum = (a) => r2(a.reduce((x, r) => x + r.amt, 0));
  const lastM = ym(today), twelve = new Set(Array.from({ length: 12 }, (_, i) => addMonths(lastM, -i)));

  /* one helper for every comparison: purchases over the window, and the like-for-like pair over comparable months only */
  const compare = (rows) => {
    const c = rows.filter((r) => inW.has(r.m)), p = rows.filter((r) => inP.has(r.m));
    const cc = c.filter((r) => comparable(r.mfr, r.m)), pc = p.filter((r) => comparable(r.mfr, addMonths(r.m, 12)));
    const lines = [...new Set(c.concat(p).map((r) => r.mfr))];
    const cmpMonths = W.months.filter((m) => lines.some((s) => comparable(s, m)));
    const partial = lines.some((s) => W.months.some((m) => reported(s, m) && !comparable(s, m))) || (lines.length > 0 && !cmpMonths.length);
    const curCmp = sum(cc), priCmp = cmpMonths.length ? sum(pc) : null;
    return { purchases: sum(c), units: c.filter((r) => !isMkt(r.code, r.name, r.mfr)).reduce((x, r) => x + r.qty, 0), marketing_units: c.filter((r) => isMkt(r.code, r.name, r.mfr)).reduce((x, r) => x + r.qty, 0), prior: priCmp, current_compared: curCmp, change_pct: priCmp == null ? null : pct(curCmp, priCmp), partial, compared_months: cmpMonths.length };
  };

  const T = compare(all);
  const totalCur = T.purchases;

  // by manufacturer
  const manufacturers = [...new Set(all.filter((r) => inW.has(r.m) || inP.has(r.m)).map((r) => r.mfr))].map((slug) => {
    const x = compare(all.filter((r) => r.mfr === slug));
    const firstReport = [...(REPM[slug] || [])].sort()[0] || null;
    return { slug, name: mName(slug), purchases: x.purchases, units: x.units, marketing_units: x.marketing_units, prior: x.prior, change_pct: x.change_pct, partial: x.partial, compared_months: x.compared_months,
      share_pct: totalCur > 0 ? Math.round(x.purchases / totalCur * 1000) / 10 : 0, history_from: x.prior == null ? ((input.firstReport && input.firstReport[slug]) || firstReport) : null };
  }).filter((m) => m.purchases !== 0 || (m.prior || 0) !== 0).sort((a, b) => b.purchases - a.purchases || (b.prior || 0) - (a.prior || 0));

  // by category (catalog category of each SKU; a SKU no current catalog lists is shown as such)
  /* a SKU the HCPS catalog doesn't list (e.g. Golden, ordered through Golden's own system) is grouped under its line, never guessed */
  const catOf = (r) => cat(r.mfr, r.code, r.name) || `${mName(r.mfr)} — category not listed`;
  const categories = [...new Set(all.filter((r) => inW.has(r.m) || inP.has(r.m)).map(catOf))].map((c) => {
    const x = compare(all.filter((r) => catOf(r) === c));
    return { category: c, purchases: x.purchases, units: c === MKT ? x.marketing_units : x.units, prior: x.prior, change_pct: x.change_pct, partial: x.partial, unlisted: / — category not listed$/.test(c) };
  }).filter((c) => c.purchases !== 0 || (c.prior || 0) !== 0 || (c.category === MKT && c.units > 0)).sort((a, b) => b.purchases - a.purchases);
  const declining = categories.filter((c) => !c.unlisted && c.prior != null && c.prior >= 500 && c.change_pct != null && c.change_pct <= -20)
    .map((c) => ({ category: c.category, purchases: c.purchases, prior: c.prior, change_pct: c.change_pct }));

  // top products
  const cur = all.filter((r) => inW.has(r.m));
  const byP = new Map();
  for (const r of cur) { const k = r.mfr + '|' + r.code; const x = byP.get(k) || { manufacturer: r.mfr, manufacturer_name: mName(r.mfr), code: r.code, name: ((resolve(r.mfr, r.code, r.name) || {}).name) || (input.catalog && input.catalog[r.mfr] && input.catalog[r.mfr][r.code] && input.catalog[r.mfr][r.code].name) || r.name, qty: 0, purchases: 0, category: catOf(r) }; x.qty += r.qty; x.purchases = r2(x.purchases + r.amt); byP.set(k, x); }
  const top_products = [...byP.values()].sort((a, b) => b.purchases - a.purchases).slice(0, 15);

  // monthly series: this year; last year only for the lines comparable in that month
  const monthly = W.months.map((m, i) => ({ month: m, label: MONTHS[i], purchases: sum(cur.filter((r) => r.m === m)),
    prior: sum(all.filter((r) => r.m === W.prior[i] && comparable(r.mfr, m))) }));

  // portal orders (apart from purchases; never summed with them)
  const yearMonths = new Set(Array.from({ length: 12 }, (_, i) => W.year + '-' + String(i + 1).padStart(2, '0')));
  const orders = (input.orders || []).filter((o) => ids.has(String(o.dealer_id)));
  const live = orders.filter((o) => o.status !== 'cancelled' && yearMonths.has(ym(o.submitted_at)));
  const portal = { orders: live.length, merchandise: r2(live.reduce((s, o) => s + (num(o.subtotal) || 0), 0)), cancelled_excluded: orders.filter((o) => o.status === 'cancelled' && yearMonths.has(ym(o.submitted_at))).length,
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
    const x = compare(s), c = s.filter((r) => inW.has(r.m));
    const lastPurchase = s.reduce((a, r) => (r.m > a ? r.m : a), '');
    const lastOrder = ordersAll.filter((o) => L.has(String(o.dealer_id)) && o.status !== 'cancelled').reduce((a, o) => (String(o.submitted_at || '') > a ? String(o.submitted_at) : a), '');
    const t12 = s.filter((r) => twelve.has(r.m));
    return { purchases: x.purchases, prior: x.prior, change_pct: x.change_pct, partial: x.partial,
      last_purchase_month: lastPurchase || null, last_portal_order: lastOrder ? lastOrder.slice(0, 10) : null,
      active_lines_12m: [...new Set(t12.map((r) => r.mfr))].length, avg_month_12m: r2(sum(t12) / 12),
      top_line: (() => { const m = new Map(); c.forEach((r) => m.set(r.mfr, (m.get(r.mfr) || 0) + r.amt)); const t = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; return t ? mName(t[0]) : null; })() };
  };
  const scorecard = vitals([...ids]);
  const branches = scope === 'company' ? locations.map((l) => Object.assign({ id: l.id, name: l.name, city: l.city || '', state: l.state || '' }, vitals([String(l.id)])))
    .sort((a, b) => b.purchases - a.purchases) : [];

  // opportunities: network favourites on lines this company buys, not bought here in 12 months (names from the catalog only)
  const boughtLines = new Set(all.filter((r) => r.m >= addMonths(lastM, -23)).map((r) => r.mfr));
  const recent = new Set(all.filter((r) => twelve.has(r.m)).map((r) => r.mfr + '|' + r.code));
  for (const o of orders) if (o.status !== 'cancelled' && twelve.has(ym(o.submitted_at))) for (const i of (o.items || [])) recent.add(o.manufacturer + '|' + i.code);
  const retired = input.isRetired || (() => false);
  const opportunities = (input.network || [])
    .filter((n) => n.dealers >= MIN_DEALERS && boughtLines.has(n.manufacturer) && !retired(n.manufacturer) && !recent.has(n.manufacturer + '|' + n.code) && cat(n.manufacturer, n.code) && cat(n.manufacturer, n.code) !== MKT)
    .sort((a, b) => b.dealers - a.dealers || b.units - a.units).slice(0, 10)
    .map((n) => ({ manufacturer: n.manufacturer, manufacturer_name: mName(n.manufacturer), code: n.code,
      /* a line with no public catalog file (Golden) names it from the Shop resolver (review #109: never read an absent file) */
      name: ((input.catalog && input.catalog[n.manufacturer]) || {})[n.code] ? input.catalog[n.manufacturer][n.code].name || n.code : ((resolve(n.manufacturer, n.code) || {}).name || n.code),
      category: cat(n.manufacturer, n.code), dealers: n.dealers }));

  const valuation = valuate(cur, { resolve, isMkt, mName, catOf, custom: input.customPrice, months: W.months });
  /* branch vs company (owner 2026-11-06, Priority 8): when a head office views ONE location, the same period's company totals
     and the location's share — computed from the same rows (no head office / branch double counting: each row belongs to one
     location). Only for a viewer who can see the company. */
  let company = null;
  if (scope !== 'company' && input.companyView === true && locations.length > 1) {
    const allIds = new Set(locations.map((l) => String(l.id)));
    const crow = S.rows.filter((r) => allIds.has(r.loc) && inW.has(r.m));
    const cv = valuate(crow, { resolve, isMkt, mName, catOf, custom: input.customPrice, months: W.months });
    const cp = sum(crow), cu = crow.filter((r) => !isMkt(r.code, r.name, r.mfr)).reduce((x, r) => x + r.qty, 0);
    company = { purchases: cp, units: cu, branch_share_pct: cp > 0 ? Math.round(totalCur / cp * 1000) / 10 : null,
      retail_benchmark: cv.benchmark.retail, profit: cv.benchmark.profit, margin_pct: cv.benchmark.margin_pct, coverage_pct: cv.coverage_pct,
      custom_retail: cv.custom.retail, locations: locations.length };
  }
  const notes = [];
  if (valuation.matched_cost > 0) notes.push('Retail values are POTENTIAL retail of the inventory purchased, at today\'s Shop retail reference prices (official MSRP, else HCPS calculated retail at 2× standard dealer cost) — not sales made. Historical purchases are valued at current prices.');
  if (S.notes.duplicates_removed) notes.push(`${S.notes.duplicates_removed} commission-statement line(s) that repeat a sales-report line were counted once.`);
  if (S.notes.rows_without_amount) notes.push(`${S.notes.rows_without_amount} reported line(s) have no amount (for example open invoices) and are not counted.`);
  if (W.ytd && all.length) notes.push(`This year runs through ${monthLabel(W.through)}, the latest month HCPS has manufacturer reports for on these lines.`);
  const noCmp = manufacturers.filter((m) => m.prior == null).map((m) => m.name + (m.history_from ? ` (reports from ${monthLabel(m.history_from)})` : ''));
  if (noCmp.length) notes.push('No year-over-year comparison for: ' + noCmp.join(', ') + ' — HCPS has no reports for the same months last year.');
  const part = manufacturers.filter((m) => m.prior != null && m.partial).map((m) => m.name);
  if (part.length || (T.partial && T.prior != null)) notes.push('Year-over-year compares only the months HCPS has reports for in both years' + (part.length ? ' (partial for: ' + part.join(', ') + ')' : '') + '.');
  const noCat = [...new Set(cur.filter((r) => !cat(r.mfr, r.code, r.name)).map((r) => r.mfr))];
  if (noCat.length) notes.push('Product categories are not listed in the HCPS catalog for: ' + noCat.map(mName).join(', ') + ' — shown under the line name.');

  return { period: { year: W.year, ytd: W.ytd, from: W.months[0], through: W.through, prior_from: W.prior[0], prior_through: W.prior[W.prior.length - 1], label: (W.ytd ? 'Year to date ' : '') + W.year + (W.ytd ? ` (Jan–${MONTHS[W.months.length - 1]})` : '') },
    scorecard, purchases: { total: totalCur, prior: T.prior, current_compared: T.current_compared, change_pct: T.change_pct, partial: T.partial, units: T.units },
    monthly, manufacturers, categories, declining_categories: declining, top_products, branches, portal, quotes, opportunities, notes, valuation, company,
    years: [...new Set(all.map((r) => r.m.slice(0, 4)))].filter(Boolean).sort().reverse() };
}

/* the facts an AI recommendation may use — every one carries an id the recommendation must cite */
function facts(rep, scopeName) {
  const F = []; const add = (id, text) => F.push({ id, text });
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  add('total', `${scopeName}: purchases ${rep.period.label} ${money(rep.purchases.total)}` + (rep.purchases.prior != null ? `; over the months reported in both years ${money(rep.purchases.current_compared)} this year versus ${money(rep.purchases.prior)} last year (${rep.purchases.change_pct}% change)` : '; no comparable prior-year reports'));
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

module.exports = { valuate, build, cleanSales, windowFor, facts, numbersOk, checkRecommendations, lane, MIN_DEALERS, monthLabel };
