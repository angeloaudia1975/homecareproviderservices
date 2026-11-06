/* C3-07 Stage 4 — CUSTOMER QUOTE DOCUMENT (owner directive 2026-11-05; pricing choices D3 2026-11-05 15:20 CT).
   One renderer for the printed / PDF quote AND the emailed quote, so the two never drift. The page sends STRUCTURED lines,
   never HTML; every field is validated and escaped here.

   Each line carries ONE customer price basis (the three approved choices) — never the dealer's wholesale cost:
     msrp   the manufacturer's VERIFIED suggested retail, looked up on HCPS's own records at render time (never taken from
            the request; Golden's official retail is taken from the configured record, as on brochures). No verified MSRP
            → the line prints "Price on request" and is left out of the total.
     retail the dealer's SAVED retail price (dealer_retail_prices: the location's own price, else the company default),
            looked up at render time — what the dealer saved is what the customer sees.
     once   a one-time price for this quote only, typed by the dealer.
   This module never reads a dealer cost, tier, contract price or MAP table.                                              */
'use strict';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);
const money = (v) => '$' + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const MAX_LINES = 60;
const BASES = new Set(['msrp', 'retail', 'once']);
const GOLDEN = new Set(['golden-technologies', 'golden']);
/* images: https only (a quote is emailed; no data: URLs, no relative paths a mail client can't resolve) */
const safeImg = (u) => { const s = String(u || '').trim(); return /^https:\/\/[^\s"'<>]{4,500}$/i.test(s) ? s : ''; };
const price = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) && n > 0 && n <= 1000000 ? Math.round(n * 100) / 100 : NaN; };

/* One requested line → {line} or {error}. */
function cleanLine(x, i) {
  const n = i + 1;
  if (!x || typeof x !== 'object') return { error: `Line ${n} is not valid.` };
  const mfr = clip(x.mfr, 60).toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(mfr)) return { error: `Line ${n}: unknown manufacturer.` };
  const code = clip(x.code, 120); if (!code) return { error: `Line ${n} needs its part number.` };
  /* the part number printed (and whose MSRP is looked up) is the line's own code — never a different product's. A Golden
     line's code is its configuration key (model|fabric|colour|tier|footrest); its item number is Golden's own. */
  const sku = GOLDEN.has(mfr) ? clip(x.sku || code.split('|')[0], 60) : clip(code.split('|u=')[0], 60);
  if (!GOLDEN.has(mfr) && x.sku != null && String(x.sku).trim() && String(x.sku).trim() !== sku) return { error: `Line ${n}: the part number does not match the product.` };
  const name = clip(x.name, 200) || sku;
  const qty = Number(x.qty == null ? 1 : x.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return { error: `Line ${n}: quantity must be a whole number from 1 to 9,999.` };
  const basis = String(x.basis || '').toLowerCase();
  if (!BASES.has(basis)) return { error: `Line ${n}: choose MSRP, your retail price or a one-time price.` };
  let unit = null;
  if (basis === 'msrp' && GOLDEN.has(mfr) && /\|u=/.test(code)) return { error: `Line ${n}: an upgraded configuration has no manufacturer MSRP — choose your retail price or a one-time price.` };
  if (basis === 'once' || (basis === 'msrp' && GOLDEN.has(mfr))) {
    unit = price(x.unit);
    if (Number.isNaN(unit)) return { error: `Line ${n}: the price must be more than $0.` };
    if (basis === 'once' && unit == null) return { error: `Line ${n}: enter the one-time price.` };
  }
  return { line: { mfr, code, sku, name, option: clip(x.option, 200), mfrName: clip(x.mfrName, 80), qty, basis, unit, image: safeImg(x.image),
    upgrade: /\|u=/.test(code) } };
}
function cleanLines(input) {
  const a = Array.isArray(input) ? input : [];
  if (a.length > MAX_LINES) return { error: `A quote can hold up to ${MAX_LINES} lines.` };
  const out = [];
  for (let i = 0; i < a.length; i++) { const c = cleanLine(a[i], i); if (c.error) return { error: c.error }; out.push(c.line); }
  return { lines: out };
}
function cleanHeader(x) {
  x = x || {};
  const email = clip(x.customer_email, 200);
  if (email && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email)) return { error: 'Enter a valid customer email, or leave it blank.' };
  return { header: { title: clip(x.title, 120), customer_name: clip(x.customer_name, 120), customer_email: email,
    customer_phone: clip(x.customer_phone, 40), valid_for: clip(x.valid_for, 40) || '30 days', notes: clip(x.notes, 2000) } };
}

/* Resolve each line's customer price on HCPS's records. lookups = { msrp(mfr, sku) → number|null, retail(mfr, code) → number|null }.
   Throws when a store can't be read (the caller answers 503 — never a quote with silently missing prices). */
async function resolvePrices(lines, lookups) {
  const out = [];
  for (const l of lines) {
    let unit = null, note = '';
    if (l.basis === 'once') unit = l.unit;
    else if (l.basis === 'retail') { unit = await lookups.retail(l.mfr, l.code); if (unit == null) note = 'no saved retail price'; }
    else if (GOLDEN.has(l.mfr)) unit = l.unit;                                   // Golden's official retail, as on brochures
    else if (l.upgrade) note = 'MSRP not provided for this configuration';
    else { unit = await lookups.msrp(l.mfr, l.sku); if (unit == null) note = 'MSRP not provided'; }
    out.push(Object.assign({}, l, { unit, note, amount: unit != null ? Math.round(unit * l.qty * 100) / 100 : null }));
  }
  return out;
}

/* dealer = { business_name, address, city, state, zip, phone, email, website, logo_url } from HCPS's own record. */
function renderQuote({ dealer, header, lines, quote_no, date, forEmail }) {
  const d = dealer || {};
  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const unpriced = lines.filter((l) => l.amount == null).length;
  const logo = safeImg(d.logo_url);
  const site = /^https?:\/\//i.test(String(d.website || '')) ? String(d.website) : (d.website ? 'https://' + String(d.website).replace(/^\/+/, '') : '');
  const addr = [d.address, [d.city, d.state].filter(Boolean).join(', '), d.zip].filter(Boolean).join(' · ');
  const contact = [d.phone, d.email].filter(Boolean).map(esc).join(' · ');
  const rows = lines.map((l) => `<tr>
      <td class="pic">${l.image ? `<img src="${esc(l.image)}" alt="" width="56" height="56">` : ''}</td>
      <td><b>${esc(l.name)}</b>${l.option ? `<div class="sub">${esc(l.option)}</div>` : ''}<div class="sub">${l.mfrName ? esc(l.mfrName) + ' · ' : ''}Item ${esc(l.sku)}</div></td>
      <td class="n">${l.qty}</td>
      <td class="n">${l.unit != null ? money(l.unit) + (l.basis === 'msrp' ? '<div class="sub">MSRP</div>' : '') : `<span class="na">${esc(l.note || 'Price on request')}</span>`}</td>
      <td class="n">${l.amount != null ? money(l.amount) : '—'}</td></tr>`).join('');
  const css = `body{margin:0;background:${forEmail ? '#ffffff' : '#eef1f4'};font-family:Helvetica,Arial,sans-serif;color:#1e2732}
    .sheet{max-width:8in;margin:${forEmail ? '0 auto' : '24px auto'};background:#fff;padding:.55in .6in;box-sizing:border-box;${forEmail ? '' : 'box-shadow:0 6px 24px rgba(0,0,0,.12)'}}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:3px solid #1e2732;padding-bottom:14px}
    .biz{display:flex;gap:14px;align-items:center}.biz img{max-height:64px;max-width:180px;object-fit:contain}
    .bn{font-size:18pt;font-weight:700}.bc{font-size:9.5pt;color:#55606c;line-height:1.5}
    .qt{text-align:right}.qt .t{font-size:20pt;font-weight:800;letter-spacing:2px;color:#1e2732}.qt .m{font-size:9.5pt;color:#55606c;line-height:1.6}
    .for{margin:16px 0 10px;font-size:10.5pt}.for b{font-size:11.5pt}
    table{width:100%;border-collapse:collapse;font-size:10pt}th{text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.5px;color:#55606c;border-bottom:1px solid #c9d0d6;padding:6px 6px}
    td{padding:8px 6px;border-bottom:1px solid #e3e7eb;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}td.pic{width:62px}td.pic img{object-fit:contain;border:1px solid #e3e7eb;border-radius:4px;background:#fff}
    .sub{font-size:8.5pt;color:#6b7580;margin-top:2px}.na{font-size:9pt;color:#9a6a12}
    tr{page-break-inside:avoid}.tot{display:flex;justify-content:flex-end;margin-top:12px}.tot div{min-width:2.6in;border-top:2px solid #1e2732;padding-top:8px;font-size:12.5pt;font-weight:700;display:flex;justify-content:space-between}
    .notes{margin-top:18px;font-size:10pt;white-space:pre-wrap;border-left:3px solid #c9d0d6;padding-left:10px}
    .fine{margin-top:22px;font-size:8pt;color:#7b858f;line-height:1.5}
    .toolbar{max-width:8in;margin:16px auto 0;display:flex;gap:10px;justify-content:flex-end}.toolbar button{font:600 13px Helvetica,Arial;padding:9px 16px;border-radius:8px;border:1px solid #1e2732;background:#1e2732;color:#fff;cursor:pointer}
    @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none;padding:.35in .4in}.toolbar{display:none}@page{margin:.4in}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quote ${esc(quote_no || '')} — ${esc(d.business_name || '')}</title><style>${css}</style></head><body>
${forEmail ? '' : '<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>'}
<div class="sheet">
  <div class="top"><div class="biz">${logo ? `<img src="${esc(logo)}" alt="${esc(d.business_name || '')}">` : ''}<div><div class="bn">${esc(d.business_name || '')}</div>
    <div class="bc">${addr ? esc(addr) + '<br>' : ''}${contact}${site ? (contact ? '<br>' : '') + esc(site.replace(/^https?:\/\//i, '')) : ''}</div></div></div>
    <div class="qt"><div class="t">QUOTE</div><div class="m">${quote_no ? 'No. ' + esc(quote_no) + '<br>' : ''}${esc(date || '')}<br>Valid for ${esc(header.valid_for || '30 days')}</div></div></div>
  ${header.customer_name || header.title ? `<div class="for">${header.customer_name ? `Prepared for <b>${esc(header.customer_name)}</b>` : ''}${header.title ? `${header.customer_name ? '<br>' : ''}${esc(header.title)}` : ''}</div>` : '<div class="for"></div>'}
  <table><thead><tr><th></th><th>Product</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No products on this quote yet.</td></tr>'}</tbody></table>
  <div class="tot"><div><span>Total</span><span>${money(total)}</span></div></div>
  ${header.notes ? `<div class="notes">${esc(header.notes)}</div>` : ''}
  <div class="fine">Prices are quoted by ${esc(d.business_name || 'your provider')}${lines.some((l) => l.basis === 'msrp' && l.unit != null) ? '; items marked MSRP show the manufacturer’s suggested retail price' : ''}.${unpriced ? ' Items without a price are not included in the total — ask us for pricing.' : ''} Taxes, delivery and installation are not included unless listed. This quote is valid for ${esc(header.valid_for || '30 days')} from the date above.</div>
</div></body></html>`;
}
module.exports = { cleanLine, cleanLines, cleanHeader, resolvePrices, renderQuote, MAX_LINES, safeImg };
