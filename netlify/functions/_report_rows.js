/* Server-side reader for manufacturer ORDER / SALES exports (Phase C, CLAUDE.md §18). Turns the stored original file
   (CSV or XLSX/XLS, bytes from the private mfr-sources bucket) into the SAME canonical rows the Sales Report Import page
   builds in the browser: the column patterns below are the page's autoMap patterns (test/report-rows.test.js keeps them
   identical) plus the ship-to street / ship-to id / billing columns the Ship-To review needs.

   It never changes the file: every row keeps its original cells (raw) and its 1-based line number in the file.
   CSV is read by hand so text stays text (a ZIP "02134" or "47591-1143" is never turned into a number). */
let _XLSX = null; const xlsx = () => (_XLSX = _XLSX || require("xlsx"));

// The Sales Report Import page's autoMap (src/admin/sales-import.html) — same order, same patterns.
const PAGE_PATTERNS = {
  order_number: /order.*num|^number$|order.?#|^po$|invoice/i, date: /created date|order date|^date$|invoice date/i,
  company: /company name|^company$|account name|dealer|^customer name$/i, account_ref: /customer username|username|account ?ref|customer id|account ?(number|no|num|#)|acct ?(number|no|num|#)|^account$/i,
  product_name: /line item name|product name|item name|^description$|^product$/i, product_code: /line item sku|^sku$|item.?no|^model$|product code/i,
  qty: /line item quantity|^quantity$|^qty$/i, unit_price: /wholesale pric|unit price|dealer price|^price$/i, line_amount: /line total|line amount|extended|ext price/i,
  ship_name: /shipping name/i, ship_city: /shipping city|ship city/i, ship_state: /shipping state|ship state/i, ship_zip: /shipping zip|ship zip|shipping postal/i, email: /e-?mail/i,
};
// Added for the Ship-To review (never used by the page's import).
const EXTRA_PATTERNS = {
  ship_address: /^(shipping|ship to|ship-to|ship) ?(street|address)( ?1| line 1)?$/i, ship_address2: /^(shipping|ship to|ship) ?address ?(2|line 2)$/i,
  ship_to_id: /^(ship ?to|ship-to|shipping) ?(id|number|no|#|code|account)$/i,
  bill_address: /^billing ?(street|address)( ?1)?$/i, bill_city: /^billing city$/i, bill_state: /^billing state$/i, bill_zip: /^billing (zip|postal)/i,
};
const PAGE_ORDER = ["order_number", "date", "company", "account_ref", "product_name", "product_code", "qty", "unit_price", "line_amount",
  "ship_name", "ship_city", "ship_state", "ship_zip", "email"];   // the page's TARGETS order (first match per column wins)

function parseCsv(text) {
  const out = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); out.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); out.push(row); }
  return out;
}

// bytes + format ("csv" | "xlsx" | "xls") → { headers, table:[[cells]], sheet }
function readTable(buf, format) {
  if (format === "csv") {
    let t = Buffer.from(buf).toString("utf8"); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    const all = parseCsv(t).filter(r => r.some(c => String(c).trim() !== ""));
    return { headers: (all[0] || []).map(h => String(h).trim()), table: all.slice(1), sheet: null };
  }
  const X = xlsx(); const wb = X.read(Buffer.from(buf), { type: "buffer", cellDates: false });
  // The sheet with the most rows that looks like an order export (has an order number and a company column).
  let best = null;
  for (const name of wb.SheetNames) {
    const rows = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: "", raw: false });
    if (!rows.length) continue;
    const hdr = rows[0].map(h => String(h).trim());
    const ok = hdr.some(h => PAGE_PATTERNS.order_number.test(h)) && hdr.some(h => PAGE_PATTERNS.company.test(h));
    if (ok && (!best || rows.length > best.table.length + 1)) best = { headers: hdr, table: rows.slice(1), sheet: name };
  }
  if (!best) throw new Error("no order sheet: no sheet has an order number and a company column");
  return best;
}

function autoMap(headers) {
  const map = {}, used = new Set();
  for (const k of PAGE_ORDER) { const re = PAGE_PATTERNS[k];
    for (let i = 0; i < headers.length; i++) { if (used.has(i)) continue; if (re.test(headers[i])) { map[k] = i; used.add(i); break; } } }
  for (const [k, re] of Object.entries(EXTRA_PATTERNS)) {
    for (let i = 0; i < headers.length; i++) { if (used.has(i)) continue; if (re.test(String(headers[i]).trim())) { map[k] = i; used.add(i); break; } } }
  return map;
}

// → { headers, map, rows:[{line, raw:[cells], order_number, date, company, account_ref, …}], sheet }
function readOrderRows(buf, format) {
  const t = readTable(buf, format), map = autoMap(t.headers);
  if (map.order_number == null || map.company == null) throw new Error("not an order export: no order-number or company column");
  const g = (r, k) => { const i = map[k]; return i == null ? "" : String(r[i] == null ? "" : r[i]).trim(); };
  const rows = [];
  t.table.forEach((r, j) => {
    const o = { line: j + 2, raw: r.map(c => String(c == null ? "" : c)) };
    for (const k of Object.keys(map)) o[k] = g(r, k);
    if (o.ship_address2) o.ship_address = [o.ship_address, o.ship_address2].filter(Boolean).join(" ");
    if (String(o.order_number || "").trim() || String(o.company || "").trim()) rows.push(o);
  });
  return { headers: t.headers, map, rows, sheet: t.sheet };
}

module.exports = { readOrderRows, readTable, autoMap, parseCsv, PAGE_PATTERNS, EXTRA_PATTERNS };
