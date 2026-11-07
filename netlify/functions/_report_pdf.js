/* C3-07 Stage 6 — the dealer report as a branded PDF (pdf-lib, standard fonts; nothing fetched from the internet).
   HCPS's original logo is bundled with the function (netlify.toml included_files); the dealer's logo is drawn only when it
   is an inline PNG / JPEG stored on HCPS's own record (an https logo is never fetched from here). Every figure comes from the
   report object built by _dealer_report.js — this file only lays it out. AI suggestions are NOT part of the PDF. */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const NAVY = rgb(0.043, 0.122, 0.2), BLUE = rgb(0.086, 0.506, 0.761), ORANGE = rgb(0.937, 0.388, 0.145), INK = rgb(0.043, 0.051, 0.059);
const MUTED = rgb(0.42, 0.45, 0.5), LINE = rgb(0.86, 0.88, 0.9), ZEBRA = rgb(0.965, 0.973, 0.98), GREEN = rgb(0.09, 0.5, 0.3), RED = rgb(0.75, 0.15, 0.15);
const W = 612, H = 792, M = 40;
const LOGO_PATHS = [path.join(__dirname, '../../src/assets/brand/hcps-logo-original.png'), path.join(process.cwd(), 'src/assets/brand/hcps-logo-original.png')];

/* Helvetica (WinAnsi) can't draw every character: keep what it can, replace the rest */
function safe(s) {
  return String(s == null ? '' : s).replace(/[≥]/g, '>=').replace(/[≤]/g, '<=').replace(/[ ]/g, ' ')
    .replace(/[^\x20-\x7e¡-ÿ–—‘’“”•…€]/g, '?');
}
const money = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pctTxt = (p) => (p == null ? '—' : (p > 0 ? '+' : '') + p + '%');

async function render({ report, dealer, scopeName, generated }) {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`Dealer Performance Report — ${scopeName}`)); doc.setAuthor('HomeCare Provider Services'); doc.setCreator('HCPS 360 Dealer Portal');
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  let logo = null; for (const p of LOGO_PATHS) { try { logo = await doc.embedPng(fs.readFileSync(p)); break; } catch (e) { /* next */ } }
  let dlogo = null;
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dealer.logo_url || ''));
  if (m) { try { const bytes = Buffer.from(m[2], 'base64'); dlogo = /png/i.test(m[1]) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); } catch (e) { dlogo = null; } }

  let page, y;
  const pages = [];
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); y = H - M; };
  const text = (s, x, yy, o = {}) => page.drawText(safe(s), { x, y: yy, size: o.size || 9, font: o.bold ? B : F, color: o.color || INK });
  const width = (s, size, bold) => (bold ? B : F).widthOfTextAtSize(safe(s), size);
  const clip = (s, w, size, bold) => { s = safe(s); if (width(s, size, bold) <= w) return s; while (s.length > 1 && width(s + '…', size, bold) > w) s = s.slice(0, -1); return s + '…'; };
  const wrap = (s, w, size) => { const out = []; let cur = ''; for (const word of safe(s).split(/\s+/)) { const t = cur ? cur + ' ' + word : word; if (width(t, size) > w && cur) { out.push(cur); cur = word; } else cur = t; } if (cur) out.push(cur); return out; };
  const need = (h) => { if (y - h < M + 30) newPage(); };
  const heading = (t, sub) => { need(95); y -= 18; text(t, M, y, { size: 12.5, bold: true, color: NAVY }); page.drawRectangle({ x: M, y: y - 5, width: 34, height: 2, color: ORANGE }); y -= 12; if (sub) { for (const l of wrap(sub, W - 2 * M, 8)) { y -= 10; text(l, M, y, { size: 8, color: MUTED }); } } y -= 6; };
  const para = (s, o = {}) => { for (const l of wrap(s, W - 2 * M, o.size || 8.5)) { need(12); y -= 11; text(l, M, y, { size: o.size || 8.5, color: o.color || INK }); } };
  /* cols: [{label, w, align:'r'|'l', get(row)->string, color?(row)}] */
  const table = (cols, rows, empty) => {
    const rowH = 15, x0 = M;
    const head = () => { need(rowH * 2); page.drawRectangle({ x: x0, y: y - rowH, width: W - 2 * M, height: rowH, color: NAVY }); let x = x0 + 6;
      for (const c of cols) { const lab = clip(c.label, c.w - 8, 7.5, true); text(lab, c.align === 'r' ? x + c.w - 10 - width(lab, 7.5, true) : x, y - 10.5, { size: 7.5, bold: true, color: rgb(1, 1, 1) }); x += c.w; } y -= rowH; };
    head();
    if (!rows.length) { y -= 13; text(empty || 'Nothing in this period.', x0 + 6, y, { size: 8.5, color: MUTED }); y -= 4; return; }
    rows.forEach((r, i) => {
      if (y - rowH < M + 30) { newPage(); head(); }
      if (i % 2) page.drawRectangle({ x: x0, y: y - rowH, width: W - 2 * M, height: rowH, color: ZEBRA });
      let x = x0 + 6;
      for (const c of cols) { const v = clip(c.get(r), c.w - 8, 8, !!c.bold); text(v, c.align === 'r' ? x + c.w - 10 - width(v, 8, !!c.bold) : x, y - 10.5, { size: 8, bold: !!c.bold, color: (c.color && c.color(r)) || INK }); x += c.w; }
      y -= rowH;
    });
    page.drawLine({ start: { x: x0, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE });
  };
  const chg = (r) => (r.change_pct == null ? MUTED : r.change_pct < 0 ? RED : GREEN);

  // ---- page 1 header
  newPage();
  if (logo) { const s = Math.min(150 / logo.width, 52 / logo.height); page.drawImage(logo, { x: M, y: y - logo.height * s, width: logo.width * s, height: logo.height * s }); }
  if (dlogo) { const s = Math.min(130 / dlogo.width, 52 / dlogo.height); page.drawImage(dlogo, { x: W - M - dlogo.width * s, y: y - dlogo.height * s, width: dlogo.width * s, height: dlogo.height * s }); }
  y -= 66;
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 3, color: BLUE });
  y -= 24; text('Dealer Performance Report', M, y, { size: 18, bold: true, color: NAVY });
  const who = scopeName && dealer.business_name && !String(scopeName).startsWith(dealer.business_name) ? `${dealer.business_name} — ${scopeName}` : (scopeName || dealer.business_name || '');
  y -= 16; text(clip(who, W - 2 * M, 11, true), M, y, { size: 11, bold: true });
  y -= 13; text(`${report.period.label} · prepared ${generated} by HomeCare Provider Services`, M, y, { size: 8.5, color: MUTED });

  // ---- scorecard tiles
  const R = report, sc = R.scorecard;
  const tiles = [
    ['Purchases', money(R.purchases.total), R.purchases.prior != null ? `Last year ${money(R.purchases.prior)} (${pctTxt(R.purchases.change_pct)})` : 'No full prior-year history'],
    ['Units', String(R.purchases.units), `${sc.active_lines_12m} active line(s), past 12 months`],
    ['Average month (12 mo.)', money(sc.avg_month_12m), sc.last_purchase_month ? `Last reported purchase ${sc.last_purchase_month}` : 'No reported purchases'],
    ['Portal orders', String(R.portal.orders), `${money(R.portal.merchandise)} merchandise · not added to purchases`],
  ];
  y -= 16; const tw = (W - 2 * M - 18) / 4;
  tiles.forEach((t, i) => { const x = M + i * (tw + 6); page.drawRectangle({ x, y: y - 58, width: tw, height: 58, color: ZEBRA, borderColor: LINE, borderWidth: 0.6 });
    text(clip(t[0], tw - 12, 7.5, true), x + 7, y - 13, { size: 7.5, bold: true, color: MUTED }); text(clip(t[1], tw - 12, 14, true), x + 7, y - 32, { size: 14, bold: true, color: i === 0 ? ORANGE : NAVY });
    wrap(t[2], tw - 12, 6.8).slice(0, 2).forEach((l, k) => text(l, x + 7, y - 44 - k * 8, { size: 6.8, color: MUTED })); });
  y -= 64;

  // ---- monthly
  heading('Monthly purchases', R.period.ytd ? 'Bars: this year; outline: the same month last year (lines with full HCPS history only).' : 'Bars: this year; outline: the year before (lines with full HCPS history only).');
  need(120); const ch = 90, cw = (W - 2 * M) / 12, mx = Math.max(1, ...R.monthly.map((x) => Math.max(x.purchases, x.prior || 0)));
  const base = y - ch - 4;
  R.monthly.forEach((x, i) => { const bx = M + i * cw + cw * 0.18, bw = cw * 0.64;
    if (x.prior) { const h = (x.prior / mx) * ch; page.drawRectangle({ x: bx, y: base, width: bw, height: h, borderColor: MUTED, borderWidth: 0.6 }); }
    if (x.purchases) { const h = (x.purchases / mx) * ch; page.drawRectangle({ x: bx + 2, y: base, width: bw - 4, height: h, color: BLUE }); }
    text(x.label, bx + bw / 2 - width(x.label, 7) / 2, base - 10, { size: 7, color: MUTED }); });
  page.drawLine({ start: { x: M, y: base }, end: { x: W - M, y: base }, thickness: 0.5, color: LINE });
  y = base - 16;

  /* ---- Total Sales (owner 2026-11-06, Priority 7): the same valuation as the screen and Excel */
  const V = R.valuation;
  if (V && V.matched_cost > 0) {
    heading('Total Sales — potential retail of purchases', 'Potential retail is the value of the inventory purchased at today’s Shop retail reference (manufacturer MSRP, else HCPS calculated retail at 2× standard dealer cost) — not sales made. Historical purchases are valued at current prices.');
    const vt = [
      ['Wholesale valued', money(V.matched_cost), `Coverage ${V.coverage_pct == null ? '—' : V.coverage_pct + '%'} of ${money(V.purchases_total)} purchases`],
      ['Potential retail (Shop)', money(V.benchmark.retail), `Profit ${money(V.benchmark.profit)} · margin ${V.benchmark.margin_pct == null ? '—' : V.benchmark.margin_pct + '%'}`],
      ['Potential retail (your prices)', money(V.custom.retail), V.custom.products_with_custom_price ? `Profit ${money(V.custom.profit)} · margin ${V.custom.margin_pct == null ? '—' : V.custom.margin_pct + '%'}` : 'No retail prices of your own set — Shop reference used'],
      ['Difference', money(V.difference), 'Your prices versus the Shop reference'],
    ];
    need(70); const tw2 = (W - 2 * M - 18) / 4;
    vt.forEach((t, i) => { const x = M + i * (tw2 + 6); page.drawRectangle({ x, y: y - 58, width: tw2, height: 58, color: ZEBRA, borderColor: LINE, borderWidth: 0.6 });
      text(clip(t[0], tw2 - 12, 7.5, true), x + 7, y - 13, { size: 7.5, bold: true, color: MUTED }); text(clip(t[1], tw2 - 12, 14, true), x + 7, y - 32, { size: 14, bold: true, color: NAVY });
      wrap(t[2], tw2 - 12, 6.8).slice(0, 2).forEach((l, k) => text(l, x + 7, y - 44 - k * 8, { size: 6.8, color: MUTED })); });
    y -= 64;
    const pm = (v) => (v == null ? '—' : v + '%');
    table([{ label: 'Manufacturer', w: 150, get: (r) => r.name, bold: true }, { label: 'Wholesale', w: 75, align: 'r', get: (r) => money(r.cost) },
      { label: 'Retail (Shop)', w: 80, align: 'r', get: (r) => money(r.retail) }, { label: 'Profit', w: 70, align: 'r', get: (r) => money(r.profit) },
      { label: 'Margin', w: 52, align: 'r', get: (r) => pm(r.margin_pct) }, { label: 'Retail (yours)', w: 105, align: 'r', get: (r) => money(r.custom_retail) }], V.by_manufacturer);
    y -= 8;
    table([{ label: 'Category', w: 150, get: (r) => r.category, bold: true }, { label: 'Wholesale', w: 75, align: 'r', get: (r) => money(r.cost) },
      { label: 'Retail (Shop)', w: 80, align: 'r', get: (r) => money(r.retail) }, { label: 'Profit', w: 70, align: 'r', get: (r) => money(r.profit) },
      { label: 'Margin', w: 52, align: 'r', get: (r) => pm(r.margin_pct) }, { label: 'Retail (yours)', w: 105, align: 'r', get: (r) => money(r.custom_retail) }], V.by_category);
    if (R.company) { y -= 8; para(`Company comparison, same period: this location bought ${money(R.purchases.total)} of the company's ${money(R.company.purchases)} (${R.company.branch_share_pct == null ? '—' : R.company.branch_share_pct + '%'}). Company potential retail ${money(R.company.retail_benchmark)}, profit ${money(R.company.profit)}, margin ${R.company.margin_pct == null ? '—' : R.company.margin_pct + '%'}.`); }
    if (V.gaps && V.gaps.length) { y -= 4; para(`${money(V.gap_amount)} of purchases could not be valued (no matching Shop product or no MSRP / standard cost) — listed in the Excel export.`, { color: MUTED, size: 8 }); }
  }

  heading('By manufacturer', 'Manufacturer-reported purchases. A dash means HCPS history for the line does not cover last year.');
  table([{ label: 'Manufacturer', w: 190, get: (r) => r.name, bold: true }, { label: 'Purchases', w: 85, align: 'r', get: (r) => money(r.purchases) },
    { label: 'Last year', w: 85, align: 'r', get: (r) => money(r.prior) }, { label: 'Change', w: 70, align: 'r', get: (r) => pctTxt(r.change_pct), color: chg },
    { label: 'Share', w: 102, align: 'r', get: (r) => r.share_pct + '%' }], R.manufacturers);

  heading('By product category', 'Categories as listed in the current HCPS catalog.');
  table([{ label: 'Category', w: 220, get: (r) => r.category, bold: true }, { label: 'Units', w: 60, align: 'r', get: (r) => String(r.units) },
    { label: 'Purchases', w: 85, align: 'r', get: (r) => money(r.purchases) }, { label: 'Last year', w: 85, align: 'r', get: (r) => money(r.prior) },
    { label: 'Change', w: 82, align: 'r', get: (r) => pctTxt(r.change_pct), color: chg }], R.categories);

  if (R.branches.length > 1) {
    heading('Locations', 'Each location’s own manufacturer-reported purchases.');
    table([{ label: 'Location', w: 170, get: (r) => r.name + (r.city ? ', ' + r.city : ''), bold: true }, { label: 'Purchases', w: 80, align: 'r', get: (r) => money(r.purchases) },
      { label: 'Last year', w: 80, align: 'r', get: (r) => money(r.prior) }, { label: 'Change', w: 60, align: 'r', get: (r) => pctTxt(r.change_pct), color: chg },
      { label: 'Last purchase', w: 72, align: 'r', get: (r) => r.last_purchase_month || '—' }, { label: 'Top line', w: 70, get: (r) => r.top_line || '—' }], R.branches);
  }

  heading('Top products', 'By purchases in the period.');
  table([{ label: 'Product', w: 230, get: (r) => r.name, bold: true }, { label: 'Line', w: 110, get: (r) => r.manufacturer_name }, { label: 'Item #', w: 72, get: (r) => r.code },
    { label: 'Units', w: 50, align: 'r', get: (r) => String(r.qty) }, { label: 'Purchases', w: 70, align: 'r', get: (r) => money(r.purchases) }], R.top_products);

  if (R.declining_categories.length) { heading('Categories down versus last year', 'At least $500 last year and 20% or more lower this year.');
    table([{ label: 'Category', w: 250, get: (r) => r.category, bold: true }, { label: 'This period', w: 95, align: 'r', get: (r) => money(r.purchases) },
      { label: 'Last year', w: 95, align: 'r', get: (r) => money(r.prior) }, { label: 'Change', w: 92, align: 'r', get: (r) => pctTxt(r.change_pct), color: chg }], R.declining_categories); }

  heading('Assortment opportunities', `Products other HCPS dealers order (each named by at least 3 dealers) on lines you already buy, that you haven't ordered in 12 months. A suggestion, not a forecast.`);
  table([{ label: 'Product', w: 240, get: (r) => r.name, bold: true }, { label: 'Line', w: 110, get: (r) => r.manufacturer_name }, { label: 'Category', w: 110, get: (r) => r.category },
    { label: 'Dealers ordering', w: 72, align: 'r', get: (r) => String(r.dealers) }], R.opportunities, 'No opportunities found from the network data.');

  heading('Quotes and portal activity', 'Activity — not purchases.');
  para(`Customer quotes created: ${R.quotes.created} (${R.quotes.sent} sent, ${R.quotes.draft} not sent). Quotes are not orders.`);
  para(`Orders placed in the 360 Dealer Portal: ${R.portal.orders}, ${money(R.portal.merchandise)} merchandise${R.portal.cancelled_excluded ? `; ${R.portal.cancelled_excluded} cancelled order(s) excluded` : ''}. Portal orders are shown apart and not added to purchases: once a manufacturer ships and reports an order it appears in purchases.`);

  heading('About this report');
  para('Purchases are manufacturer-reported (sales reports and commission statements received by HCPS). Year-over-year comparisons appear only where HCPS holds that line’s history for the whole comparison period. Categories come from the current HCPS catalog. Potential retail and margins value purchased inventory at current Shop reference prices; they are not sales or customer traffic.', { color: MUTED, size: 8 });
  for (const n of R.notes) para('• ' + n, { color: MUTED, size: 8 });

  pages.forEach((p, i) => { p.drawText(safe(`HomeCare Provider Services · 360 Dealer Portal · Confidential — prepared for ${dealer.business_name || 'the dealer'}`), { x: M, y: 22, size: 7, font: F, color: MUTED });
    const t = `Page ${i + 1} of ${pages.length}`; p.drawText(t, { x: W - M - F.widthOfTextAtSize(t, 7), y: 22, size: 7, font: F, color: MUTED }); });
  return Buffer.from(await doc.save());
}
module.exports = { render, safe };
