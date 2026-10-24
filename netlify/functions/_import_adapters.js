/* Manufacturer source adapters for the catalog importer (_catalog_import.js). Each adapter turns ONE manufacturer
   file into the normalized line: rows of source facts, word for word, with a locator back to the cell / page. An
   adapter never guesses a price, a pack size, a MAP or an effective date; what the file does not state stays null,
   and what it states as a rule (e.g. "MSRP = dealer × 1.5") is applied only with msrp_source "source_rule" and the
   rule quoted in terms[]. Shared readers: workbook rows by header aliases, and positioned PDF text anchored on part
   numbers. Image-only PDFs have no text layer: they come in as a transcription and are cross-checked against OCR
   (scripts/catalog-import.js), never trusted from one reading. */
const crypto = require("crypto");
const { money, clean, flag } = require("./_catalog_import.js");

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

// ---------- workbook ----------
function sheetRows(buf, sheetName) {
  const X = require("xlsx");
  const wb = X.read(buf, { type: "buffer" });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  return { name, rows: X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" }) };
}
/* Find the header row: the first row in which every required alias group matches a cell. */
function headerMap(rows, groups, maxScan) {
  for (let i = 0; i < Math.min(rows.length, maxScan || 40); i++) {
    const cells = rows[i].map(c => clean(c).toLowerCase());
    const map = {};
    let ok = true;
    for (const [key, spec] of Object.entries(groups)) {
      const idx = cells.findIndex(c => spec.re.test(c));
      if (idx < 0) { if (spec.required) { ok = false; break; } continue; }
      map[key] = idx;
    }
    if (ok) return { row: i, map };
  }
  return null;
}
const cell = (r, i) => (i == null ? "" : clean(r[i]));

// ---------- PDF ----------
function pdfjs() {
  const warn = console.warn, log = console.log;
  console.warn = () => {}; console.log = () => {};
  try { globalThis.pdfjsWorker = require("pdfjs-dist/legacy/build/pdf.worker.js"); return require("pdfjs-dist/legacy/build/pdf.js"); }
  finally { console.warn = warn; console.log = log; }
}
async function pdfItems(buf) {
  const doc = await pdfjs().getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const raw = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ page: p, x: it.transform[4], y: it.transform[5], w: it.width, s: it.str }))
      .sort((a, b) => (b.y - a.y) || (a.x - b.x));
    // A word split into pieces by the PDF writer ("BNG50" + "1") is put back together: same baseline, no gap.
    for (const it of raw) {
      const prev = out[out.length - 1];
      if (prev && prev.page === p && Math.abs(prev.y - it.y) <= 0.5 && it.x - (prev.x + prev.w) >= -0.5 && it.x - (prev.x + prev.w) <= 0.8) {
        prev.s += it.s; prev.w = it.x + it.w - prev.x;
      } else out.push(Object.assign({}, it));
    }
  }
  return { pages: doc.numPages, items: out };
}
/* Join items into cells: same page, same baseline (±tol), within one x-range, left to right. */
function textIn(items, x0, x1) { return items.filter(i => i.x >= x0 && i.x < x1).sort((a, b) => (b.y - a.y) || (a.x - b.x)); }
function joinLine(items) {
  const rows = [];
  for (const it of items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
    const R = rows.find(r => Math.abs(r.y - it.y) <= 2);
    if (R) R.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows.sort((a, b) => b.y - a.y).map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(" ").replace(/\s+/g, " ").replace(/\s+([,)®])/g, "$1").trim()).join(" ").trim();
}
/* Anchor table: every item matching codeRe inside codeX is a row; other items are assigned to the anchor whose
   band (halfway to the neighbouring anchors on the same page) contains them. Items in price columns that lie far
   from every anchor's line are returned as "spanning" (a value printed once for a group of rows). */
function anchorTable(items, opt) {
  const anchors = items.filter(i => i.x >= opt.codeX[0] && i.x < opt.codeX[1] && opt.codeRe.test(clean(i.s)))
    .sort((a, b) => (a.page - b.page) || (b.y - a.y));
  const rows = anchors.map(a => ({ anchor: a, code: clean(a.s), cols: {}, page: a.page }));
  const spanning = [];
  const stop = opt.stopRe || null;
  const skipped = new Set();
  if (opt.skipLine) {
    const lines = [];
    for (const it of items) { const L = lines.find(l => l.page === it.page && Math.abs(l.y - it.y) <= 1.5); if (L) L.items.push(it); else lines.push({ page: it.page, y: it.y, items: [it] }); }
    for (const L of lines) if (opt.skipLine(joinLine(L.items))) for (const it of L.items) skipped.add(it);
  }
  for (const it of items) {
    if (anchors.includes(it) || skipped.has(it)) continue;
    if (stop && stop.test(clean(it.s))) continue;
    const col = Object.entries(opt.columns).find(([, r]) => it.x >= r[0] && it.x < r[1]);
    if (!col) continue;
    const same = rows.filter(r => r.page === it.page);
    if (!same.length) continue;
    let best = null, bd = Infinity;
    for (const r of same) { const d = Math.abs(r.anchor.y - it.y); if (d < bd) { bd = d; best = r; } }
    const idx = same.indexOf(best);
    const up = same[idx - 1], down = same[idx + 1];
    const topBand = up ? (up.anchor.y + best.anchor.y) / 2 : best.anchor.y + (opt.band || 14);
    const botBand = down ? (down.anchor.y + best.anchor.y) / 2 : best.anchor.y - (opt.band || 14);
    if (it.y > topBand + 0.1 || it.y < botBand - 0.1) continue;
    const isPrice = (opt.priceCols || []).includes(col[0]);
    if (isPrice && bd > (opt.lineTol || 3)) { spanning.push({ col: col[0], s: clean(it.s), y: it.y, page: it.page, near: best.code }); continue; }
    (best.cols[col[0]] = best.cols[col[0]] || []).push(it);
  }
  for (const r of rows) for (const k of Object.keys(r.cols)) r[k] = joinLine(r.cols[k]);
  return { rows, spanning };
}
/* Section headings: text items in the heading x-range that sit between rows and carry no price. */
function headingsBetween(items, rows, x0, x1, re) {
  return items.filter(i => i.x >= x0 && i.x < x1 && re.test(clean(i.s)) && !rows.some(r => r.anchor === i));
}
function sectionOf(row, heads) {
  let best = null;
  for (const h of heads) if (h.page < row.page || (h.page === row.page && h.y > row.anchor.y)) {
    if (!best || h.page > best.page || (h.page === best.page && h.y < best.y)) best = h;
  }
  return best ? clean(best.s) : null;
}

// ---------- adapters ----------
const base = (manufacturer, file, buf, extra) => Object.assign({
  manufacturer, source: { file, sha256: sha256(buf), title: null, effective_date: null, effective_date_status: "not_stated", received_date: null },
  terms: [], rows: [] }, extra || {});

/* Corsicana Healthcare — "CORSICANA HEALTHCARE PRICE LIST 2026" workbook. Freight is per item and per method. */
function corsicana(buf, file) {
  const L = base("corsicana", file, buf);
  const { name, rows } = sheetRows(buf);
  const H = headerMap(rows, { code: { re: /^item number/, required: true }, name: { re: /^name$/ }, desc: { re: /^description/ },
    price: { re: /healthcare price|dealer|cost/, required: true }, msrp: { re: /^msrp/ }, white: { re: /white glove/ },
    parcel: { re: /ups|fedex/ }, ltl: { re: /^ltl/ } });
  if (!H) throw new Error("corsicana: header row not found");
  L.source.title = "Corsicana Healthcare price list 2026 (" + name + ")";
  L.terms.push({ kind: "freight_columns", text: [rows[H.row][H.map.white], rows[H.row][H.map.parcel], rows[H.row][H.map.ltl]].map(clean).join(" | ") });
  for (let i = H.row + 1; i < rows.length; i++) {
    const r = rows[i], code = cell(r, H.map.code);
    if (!code) continue;
    const row = { code, name: cell(r, H.map.name), description: cell(r, H.map.desc), dealer_price: money(cell(r, H.map.price)),
      msrp: money(cell(r, H.map.msrp)), msrp_source: money(cell(r, H.map.msrp)) != null ? "stated" : null, map: null, map_source: null,
      tiers: [], uom: null, case_qty: null, locator: `${name}!row ${i + 1}`, flags: [],
      raw: { printed_price: cell(r, H.map.price), white_glove: cell(r, H.map.white), parcel: cell(r, H.map.parcel), ltl: cell(r, H.map.ltl) } };
    // "Case of N" in the description is read as the order unit, but a unit taken from free text is unverified until
    // the manufacturer confirms the price is per case (reviewer, PR #35: SB10MATPRON1-TL case of 10).
    if (/case of (\d+)/i.test(row.description)) { row.uom = "Case"; row.case_qty = Number(row.description.match(/case of (\d+)/i)[1]);
      row.flags.push(flag("blocker", "case_qty_unverified", `"${row.description.match(/case of \d+/i)[0]}" is in the description only — confirm the case quantity and that the price is per case`)); }
    for (const k of ["white_glove", "parcel", "ltl"]) if (/^tbd$/i.test(row.raw[k])) row.flags.push(flag("warn", "freight_tbd", k + " freight is 'TBD' on the source"));
    L.rows.push(row);
  }
  return L;
}

/* Ohio Medical (legacy slug gce) — "GCE Digital Pricelist 2026". Price Each + Price 5+ = two quantity breaks. */
function ohioMedical(buf, file) {
  const L = base("ohio-medical", file, buf);
  const { name, rows } = sheetRows(buf);
  const H = headerMap(rows, { code: { re: /^item number/, required: true }, desc: { re: /^description/ }, cat: { re: /^category/ },
    contents: { re: /package contents/ }, weight: { re: /weight/ }, flow: { re: /flow/ },
    p1: { re: /^price each/, required: true }, p5: { re: /^price 5\+/ }, msrp: { re: /^msrp/ } });
  if (!H) throw new Error("ohio-medical: header row not found");
  L.source.title = "GCE / Ohio Medical digital price list 2026 (" + name + ")";
  for (let i = H.row + 1; i < rows.length; i++) {
    const r = rows[i], code = cell(r, H.map.code).replace(/\s*\+\s*/g, "+");
    if (!code) continue;
    const p1 = money(cell(r, H.map.p1)), p5 = money(cell(r, H.map.p5));
    const row = { code, name: cell(r, H.map.desc), description: cell(r, H.map.contents), category_hint: cell(r, H.map.cat),
      dealer_price: p1, tiers: p5 != null ? [{ min_qty: 1, price: p1 }, { min_qty: 5, price: p5 }] : [],
      msrp: money(cell(r, H.map.msrp)), msrp_source: money(cell(r, H.map.msrp)) != null ? "stated" : null, map: null, map_source: null,
      uom: null, case_qty: null, locator: `${name}!row ${i + 1}`, flags: [],
      raw: { printed_price: cell(r, H.map.p1), weight: cell(r, H.map.weight), oxygen_flow: cell(r, H.map.flow) } };
    if (code.includes("+")) row.flags.push(flag("info", "bundle_code", "a bundle of two part numbers sold as one line"));
    const pk = (row.name + " " + row.description).match(/pack of (\d+)|pk of (\d+)/i);
    if (pk) row.flags.push(flag("info", "pack_in_text", "the description names a pack of " + (pk[1] || pk[2]) + " — the price list gives no unit column; confirm the order unit"));
    L.rows.push(row);
  }
  return L;
}

/* PediFix — "2025 PediFix OTC Price List" order form. Cost = dealer price; QTY per pack = units in the selling pack. */
function pedifix(buf, file) {
  const L = base("pedifix", file, buf);
  const { name, rows } = sheetRows(buf);
  const title = rows.map(r => r.map(clean).join(" ")).find(t => /price list/i.test(t)) || "";
  L.source.title = clean(title);
  const eff = title.match(/effective\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (eff) { const y = eff[3].length === 2 ? "20" + eff[3] : eff[3]; L.source.effective_date = `${y}-${eff[1].padStart(2, "0")}-${eff[2].padStart(2, "0")}`; L.source.effective_date_status = "stated"; }
  const H = headerMap(rows, { code: { re: /^item #/, required: true }, cost: { re: /^cost$/, required: true }, desc: { re: /^description/ },
    size: { re: /^size/ }, upc: { re: /^upc/ }, pack: { re: /qty per pack/ }, msrp: { re: /^msrp/ } });
  if (!H) throw new Error("pedifix: header row not found");
  let section = null;
  for (let i = H.row + 1; i < rows.length; i++) {
    const r = rows[i], code = cell(r, H.map.code), cost = money(cell(r, H.map.cost));
    if (!code) continue;
    if (cost == null) { if (!/^\d+\/\d+\/\d+$|^rev\d+/i.test(code)) section = code; continue; }
    const pack = parseInt(cell(r, H.map.pack), 10);
    const row = { code, name: cell(r, H.map.desc), size: cell(r, H.map.size), section, dealer_price: cost, tiers: [],
      msrp: money(cell(r, H.map.msrp)), msrp_source: money(cell(r, H.map.msrp)) != null ? "stated" : null, map: null, map_source: null,
      upc: cell(r, H.map.upc) || null, uom: pack > 1 ? `Pack of ${pack}` : null, case_qty: pack > 1 ? pack : (pack === 1 ? 1 : null),
      locator: `${name}!row ${i + 1}`, flags: [], raw: { printed_price: cell(r, H.map.cost) } };
    if (!(pack >= 1)) row.flags.push(flag("info", "no_pack_qty", "no 'QTY per pack' on the source row"));
    L.rows.push(row);
  }
  L.terms.push({ kind: "msrp_basis", text: "MSRP column printed per selling pack (same row as Cost)" });
  return L;
}

/* AIRAVANT / Bongo Rx — provider price list (one page). Breaks 1–9 / 10–19 / 20+; a 10–19 / 20+ price printed once
   for a section with "(can mix and match)" applies to every row of that section, pooled across the section. */
async function airavant(buf, file) {
  const L = base("airavant-bongorx", file, buf);
  const { items } = await pdfItems(buf);
  const all = items.map(i => clean(i.s)).join(" ");
  const rev = all.match(/(\d{5}) Rev ([A-Z])/);
  L.source.title = "Bongo Rx Provider Price List" + (rev ? ` (${rev[1]} Rev ${rev[2]})` : "");
  L.terms.push({ kind: "map", text: "MSRP & MAP (Minimum Advertised Price) column; provider agrees not to market below MAP" });
  const isHead = t => /^BONGO RX [A-Z ]+$/.test(t);
  const isNote = t => /^\((each )?includes/i.test(t) && !/^\(includes \d|^\(includes 1 each/i.test(t) || /^\(Includes 1 each of size s SM/i.test(t);
  const T = anchorTable(items, { codeRe: /^BNG\d{3}$/, codeX: [40, 105], band: 18, lineTol: 3, skipLine: t => isHead(t) || /^\((Each includes|Includes 1 each of sizes? ?s? SM, MD, LG, and XL, a headgear)/i.test(t),
    columns: { name: [105, 350], msrp: [350, 415], p1: [415, 468], p10: [468, 522], p20: [522, 600] }, priceCols: ["msrp", "p1", "p10", "p20"] });
  const lineHeads = [];
  for (const it of items) { const L = lineHeads.find(l => l.page === it.page && Math.abs(l.y - it.y) <= 1.5); if (L) L.items.push(it); else lineHeads.push({ page: it.page, y: it.y, items: [it] }); }
  const heads = lineHeads.map(l => ({ page: l.page, y: l.y, s: joinLine(l.items) })).filter(h => isHead(h.s));
  const secRows = {};
  for (const r of T.rows) {
    const sec = sectionOf(r, heads) || "";
    const row = { code: r.code, name: r.name || "", section: sec, dealer_price: money(r.p1), msrp: money(r.msrp), msrp_source: "stated",
      map: money(r.msrp), map_source: "stated", tiers: [], uom: null, case_qty: null, locator: `p${r.page} y${r.anchor.y.toFixed(0)}`, flags: [], raw: { printed_price: r.p1 || "" } };
    row._p10 = money(r.p10); row._p20 = money(r.p20);
    (secRows[sec] = secRows[sec] || []).push(row);
    L.rows.push(row);
  }
  // spanning prices: the leftmost of the section's 10–19 column and 20+ column, printed once
  for (const sp of T.spanning) {
    const v = money(sp.s); if (v == null) continue;
    const near = L.rows.find(r => r.code === sp.near); if (!near) continue;
    const group = secRows[near.section] || [];
    for (const r of group) { if (sp.col === "p10" && r._p10 == null) { r._p10 = v; r._pool = true; } if (sp.col === "p20" && r._p20 == null) { r._p20 = v; r._pool = true; } }
  }
  for (const r of L.rows) {
    if (r.dealer_price != null) {
      r.tiers = [{ min_qty: 1, price: r.dealer_price }];
      const pool = r._pool ? (r.section || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : undefined;
      if (r._p10 != null) r.tiers.push(Object.assign({ min_qty: 10, price: r._p10 }, pool ? { pool } : {}));
      if (r._p20 != null) r.tiers.push(Object.assign({ min_qty: 20, price: r._p20 }, pool ? { pool } : {}));
      if (r._pool) r.flags.push(flag("info", "mix_and_match", "10+/20+ prices printed once for the section with '(can mix and match)' — pooled across " + r.section));
    }
    if (/Pack/i.test(r.name) && /includes 4/i.test(r.name)) { r.uom = "Pack of 4"; }
    delete r._p10; delete r._p20; delete r._pool;
  }
  return L;
}

/* ABM Respiratory Care — BiWaze Clear / BiWaze Cough home-care price lists. The dealer column is headed with ONE
   account's name ("Williams Bros Pharmacy"): it is staged as a named-account price, never as the general dealer price. */
async function abm(buf, file) {
  const L = base("abm-respiratory-care", file, buf);
  const { items } = await pdfItems(buf);
  const txt = items.map(i => clean(i.s)).join(" ");
  const per = txt.replace(/\bst\b/g, "").replace(/\s+,/g, ",").match(/January 1, (\d{4})\s*[–-]\s*December 31, (\d{4})/);
  if (per) { L.source.effective_date = `${per[1]}-01-01`; L.source.effective_date_status = "stated"; L.terms.push({ kind: "validity", text: per[0] }); }
  const sys = /BiWaze Clear/.test(txt) ? "BiWaze Clear" : /BiWaze Cough/.test(txt) ? "BiWaze Cough" : "BiWaze";
  L.source.title = `ABM Respiratory Care ${sys} price list`;
  const head = items.filter(i => /^(Williams|Bros|Pharmacy)$/.test(clean(i.s)));
  const priceX = head.length ? Math.min(...head.map(i => i.x)) - 25 : 520;
  const msrpHead = items.find(i => /^(MSRP|Retail)$/.test(clean(i.s)));
  const msrpX = msrpHead ? msrpHead.x - 25 : 470;
  L.terms.push({ kind: "price_column", text: "Dealer column headed: " + head.map(i => clean(i.s)).join(" ") });
  const descHead = items.find(i => /^Description$/.test(clean(i.s)));
  const descX = descHead ? descHead.x - 100 : 235;
  const T = anchorTable(items, { codeRe: /^B[CK]\d{3,6}$/, codeX: [30, 82], band: 16, lineTol: 6,
    columns: { name: [82, descX], desc: [descX, msrpX], msrp: [msrpX, priceX], price: [priceX, 600] }, priceCols: ["msrp", "price"] });
  const heads = items.filter(i => i.x < 95 && /^(Breathing Circuits|Accessories, Replacement Parts, and Maintenance|Replacement Parts and Maintenance)$/.test(clean(i.s)));
  for (const r of T.rows) {
    const row = { code: r.code, name: (r.name || "").replace(/\s*®\s*/g, "® "), description: (r.desc || "").replace(/\s+®/g, "®"), section: sectionOf(r, heads) || sys + " system",
      dealer_price: money(r.price), dealer_price_scope: head.length ? "named_account" : "dealer", msrp: money(r.msrp), msrp_source: money(r.msrp) != null ? "stated" : null,
      map: null, map_source: null, tiers: [], uom: null, case_qty: null, locator: `p${r.page} y${r.anchor.y.toFixed(0)}`, flags: [], raw: { printed_price: r.price || "" } };
    const moq = row.description.match(/MOQ\s*=\s*(\d+)/i);
    if (moq) row.flags.push(flag("warn", "minimum_order_qty", "source states a minimum order quantity of " + moq[1] + " — the storefront has no MOQ rule"));
    const pk = row.description.match(/pack of (\d+)/i);
    if (pk) row.flags.push(flag("info", "pack_in_text", "the description names a pack of " + pk[1] + "; the list gives no unit column"));
    L.rows.push(row);
  }
  return L;
}

/* Dalton Medical — dealer price list (two columns per page, section headings with an item count). The section
   counts printed on the list are checked against the rows read; the stated total ("339 listed items") too. */
async function dalton(buf, file) {
  const L = base("dalton", file, buf);
  const { items } = await pdfItems(buf);
  const txt = items.map(i => clean(i.s));
  const eff = txt.join(" ").match(/Effective (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  if (eff) { L.source.effective_date = `${eff[3]}-${String(months.indexOf(eff[1]) + 1).padStart(2, "0")}-${eff[2].padStart(2, "0")}`; L.source.effective_date_status = "stated"; }
  L.source.title = "Dalton Medical dealer price list" + (eff ? " — effective " + eff[0].replace("Effective ", "") : "");
  for (const t of txt) {
    if (/LTL Freight|\$0-\$999|\$2,000\+|Lift gate|Inside delivery/i.test(t)) L.terms.push({ kind: "freight", text: t });
    if (/listed items|Revised|exactly as supplied/i.test(t)) L.terms.push({ kind: "list_note", text: t });
    // A discount mentioned anywhere on the list is recorded as text only — never applied (CLAUDE.md §17: the
    // corrected November list exactly as printed, never an extra 5%).
    if (/\d+\s*%|discount/i.test(t)) L.terms.push({ kind: "discount_text_not_applied", text: t });
  }
  const stated = (txt.join(" ").match(/(\d+) listed items/) || [])[1];
  const cols = [{ x0: 0, x1: 300, code: [28, 100], desc: [100, 255], price: [255, 300] }, { x0: 300, x1: 620, code: [308, 380], desc: [380, 535], price: [535, 620] }];
  const codeRe = /^[A-Z0-9][A-Za-z0-9./-]{2,}$/;
  const order = (page, col, y) => page * 1e6 + (col ? 5e5 : 0) + (1000 - y);   // reading order: page, left then right column, top down
  const heads = [];   // { key, name, count|null }
  const found = [];
  for (const c of cols) {
    // below the "ITEM #" header row where a page has one; pages without it carry items from the top
    const headerY = p => { const h = items.find(i => i.page === p && /^ITEM #$/.test(clean(i.s))); return h ? h.y - 1 : Infinity; };
    const colItems = items.filter(i => i.x >= c.x0 && i.x < c.x1 && i.y < headerY(i.page));
    const T = anchorTable(colItems, { codeRe, codeX: c.code, band: 12, lineTol: 2.5, columns: { desc: c.desc, price: c.price }, priceCols: ["price"] });
    const real = T.rows.filter(r => /^\$/.test(r.price || "") && money(r.price) != null);   // a section's item count is not a price
    for (const h of colItems.filter(i => i.x >= c.code[0] && i.x < c.code[1] && /^[A-Z0-9 &/().,'-]+$/.test(clean(i.s)) && clean(i.s).length > 3 && !real.some(r => r.anchor === i))) {
      const cnt = colItems.find(i => i.page === h.page && Math.abs(i.y - h.y) < 2 && /^\d+$/.test(clean(i.s)) && i.x > c.desc[0] + 100);
      heads.push({ key: order(h.page, c.x0, h.y), name: clean(h.s).replace(/\s*\(CONT\.\)$/, ""), count: cnt ? Number(clean(cnt.s)) : null, cont: /\(CONT\.\)$/.test(clean(h.s)) });
    }
    for (const r of real) found.push({ r, key: order(r.page, c.x0, r.anchor.y), col: c.x0 });
    for (const r of T.rows.filter(r => !real.includes(r) && !heads.some(h => h.name === clean(r.anchor.s))))
      L.unpriced = (L.unpriced || []).concat([{ code: r.code, page: r.page, text: r.desc || "" }]);
  }
  heads.sort((a, b) => a.key - b.key);
  const topNames = new Set(heads.filter(h => h.count != null).map(h => h.name));
  const sectionCounts = heads.filter(h => h.count != null).map(h => ({ name: h.name, count: h.count }));
  found.sort((a, b) => a.key - b.key);
  for (const f of found) {
    let top = null, sub = null;
    for (const h of heads) { if (h.key > f.key) break; if (topNames.has(h.name)) { if (!top || top !== h.name) sub = null; top = h.name; } else sub = h.name; }
    const r = f.r;
    L.rows.push({ code: r.code, name: r.desc || "", section: top || "", subsection: sub, dealer_price: money(r.price), msrp: null, msrp_source: null, map: null, map_source: null,
      tiers: [], uom: null, case_qty: null, locator: `p${r.page} ${f.col ? "right" : "left"} y${r.anchor.y.toFixed(0)}`, flags: [], raw: { printed_price: r.price }, _k: f.key });
    const pk = (r.desc || "").match(/(\d+)\s*(?:Pcs|Pc|Ea|Each)?\s*\/\s*(Case|CS|Cs|Pk|PK|Box|BX|Bx|Bag|Pack)\b/);
    if (pk) L.rows[L.rows.length - 1].flags.push(flag("warn", "pack_in_text", `the description says ${pk[0]} — the list prints one price and no unit column; confirm whether the price is per ${pk[2]} before staging (no unit is inferred)`));
    const hc = (r.desc || "").match(/\b([A-EK]\d{4})\b/);
    if (hc) L.rows[L.rows.length - 1].hcpcs_in_text = hc[1];
  }
  for (const r of L.rows) delete r._k;
  L.checks = { stated_total: stated ? Number(stated) : null, rows_read: L.rows.length, section_counts: sectionCounts };
  if (stated && Number(stated) !== L.rows.length) L.exceptions_pre = [flag("blocker", "row_count_mismatch", `the list states ${stated} items; ${L.rows.length} were read`)];
  const counted = {};
  for (const r of L.rows) counted[r.section] = (counted[r.section] || 0) + 1;
  L.checks.section_mismatches = sectionCounts.filter(s => counted[s.name] != null && counted[s.name] !== s.count).map(s => ({ section: s.name, stated: s.count, read: counted[s.name] }));
  return L;
}

/* Access4U — "Dealer Pricelist Fall 2026" is an image-only PDF. Input = a transcription (JSON rows) made from the page
   images; scripts/catalog-import.js cross-checks every price and part number against OCR before it is accepted.
   Width columns ("x W" with 30 / 36 in) become one row per width that is offered (X = not offered); option
   up-charges (Picket / Commercial / Guardrail) stay options on the row, never separate SKUs. */
function access4u(transcription, buf, file) {
  const L = base("access4u", file, buf);
  L.source.title = "Access4U Dealer Pricelist Fall 2026";
  L.terms.push({ kind: "msrp_rule", text: "All prices represent dealer level pricing. For MSRP multiply x 1.5. MAP pricing is 30% below MSRP." });
  for (const t of transcription.rows) {
    // "…x3W" = one part number per width (3W → 30 / 36). Other width columns: the code the source prints for that
    // width, else a PROPOSED code flagged for confirmation — never silently made up.
    const variants = t.widths ? Object.entries(t.widths).filter(([, p]) => p !== "X" && p != null).map(([w, p]) => {
        if (/3W$/.test(t.code)) return { code: t.code.replace(/3W$/, w), price: p, width: w };
        const given = (t.width_code || {})[w];
        return given ? { code: given, price: p, width: w } : { code: `${t.code}x${w}`, price: p, width: w, proposed: true };
      }) : [{ code: t.code, price: t.price, width: t.width }];
    for (const v of variants) {
      const price = money(v.price);
      const msrp = price != null ? Math.round(price * 1.5 * 100) / 100 : null;
      const row = { code: v.code, name: t.description.replace(/x W$/, "x " + (v.width || "")).trim() + (t.widths && !/x W$/.test(t.description) && v.width ? ` x ${v.width}" Wide` : ""), section: t.section, dealer_price: price,
        msrp, msrp_source: msrp != null ? "source_rule" : null, map: msrp != null ? Math.round(msrp * 0.7 * 100) / 100 : null, map_source: msrp != null ? "source_rule" : null,
        tiers: [], uom: null, case_qty: null, options: (t.options || []).filter(o => o.price_add !== "X").map(o => ({ label: o.label, price_add: money(o.price_add) })),
        locator: `p${t.page} ${t.section} "${t.code}"`, flags: [], raw: { printed_price: v.price == null ? null : String(v.price), length: t.length || null, width: v.width || t.width || null, rise: t.rise || null } };
      if (t.note) row.flags.push(flag("warn", "source_note", t.note));
      if (v.proposed) row.flags.push(flag("blocker", "proposed_variant_code", `the source prints one part number (${t.code}) for both widths; "${v.code}" is a proposed code for the ${v.width}" width — confirm with Access4U`));
      L.rows.push(row);
    }
  }
  return L;
}

/* Ohio Medical: canonical slug "ohio-medical"; the legacy slug "gce" is accepted as an alias and runs the same
   adapter (the storefront file is still public/data/gce.json — _catalog_import.catalogFileSlug). */
const ADAPTERS = { corsicana: { kind: "xlsx", fn: corsicana }, "ohio-medical": { kind: "xlsx", fn: ohioMedical }, pedifix: { kind: "xlsx", fn: pedifix },
  "airavant-bongorx": { kind: "pdf", fn: airavant }, "abm-respiratory-care": { kind: "pdf", fn: abm }, dalton: { kind: "pdf", fn: dalton },
  access4u: { kind: "transcription", fn: access4u } };
ADAPTERS.gce = ADAPTERS["ohio-medical"];
const adapterFor = slug => ADAPTERS[require("./_catalog_import.js").canonicalSlug(slug)] || null;

module.exports = { ADAPTERS, adapterFor, sheetRows, headerMap, pdfItems, anchorTable, joinLine, sha256 };
