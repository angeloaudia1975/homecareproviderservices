// MI-1c — parser for Strongback's monthly dealer-intelligence PDF ("<Owner>: your Strongback dealers").
// Input: the layout from _strongback_layout.js (pages → lines → words with positions). Output: everything the report
// prints, as printed, each piece with its SOURCE POSITION (page + baseline y), plus validation checks.
//
// Rules (MI-1c / SB-0, Angelo 2026-10-10/11):
//  * Strongback's words stay Strongback's: tier, trend, "One-Hit Wonder", "not known", "sample sent" are stored as
//    printed. Interpretations (amount as a number, a date, a product-line class) sit BESIDE the printed text, never
//    instead of it. Spelling errors in the source ("Ackworth") are kept.
//  * Chart bars and their value labels are visual only and are not read (text smaller than 7 pt).
//  * Every position key is derived from where the text is printed, so re-parsing the same file gives the same keys
//    and two identical notes printed in two places stay two notes.
//  * A structural problem is an ERROR (the import is refused); a figure in the report that does not add up to the
//    report's own headline is a WARNING (shown to the operator; Strongback's numbers are never "corrected").
const PARSER_VERSION = "strongback-dealer-report/1";

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12 };
const STATES = { alabama: "AL", florida: "FL", georgia: "GA", illinois: "IL", indiana: "IN", kentucky: "KY", michigan: "MI",
  mississippi: "MS", missouri: "MO", "north carolina": "NC", ohio: "OH", "south carolina": "SC", tennessee: "TN",
  virginia: "VA", "west virginia": "WV", alabama_: "AL" };
const LABELS = { CONTACT: "contact", "LAST ORDER": "last_order", ERGOSTEEL: "ergosteel", "CHAIR ON THE FLOOR": "floor",
  "WHAT THEY TOLD US": "told_us", "OUR LAST CONTACTS": "contact_log" };
const LABEL_START = ["CONTACT", "LAST ORDER", "ERGOSTEEL", "CHAIR ON THE", "WHAT THEY", "OUR LAST"];
const LABEL_CONT = { "CHAIR ON THE": "FLOOR", "WHAT THEY": "TOLD US", "OUR LAST": "CONTACTS" };

const pad2 = n => String(n).padStart(2, "0");
const isoOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const money = s => { const m = /^\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(String(s).trim()); return m ? Number(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : "")) : null; };
const posKey = (page, y) => `p${page}:y${Number(y).toFixed(1)}`;
const fail = (code, msg) => { const e = new Error(`${code}: ${msg}`); e.code = code; return e; };

function stateCode(s) {
  const t = String(s || "").trim(); if (/^[A-Z]{2}$/.test(t)) return t;
  return STATES[t.toLowerCase()] || null;
}
function splitCity(text) {   // "Chattanooga, TN" → {city, state_text, state}
  const i = text.lastIndexOf(",");
  if (i < 0) return { city: text.trim(), state_text: null, state: null };
  const st = text.slice(i + 1).trim();
  return { city: text.slice(0, i).trim(), state_text: st, state: stateCode(st) };
}
function monthName(s) {   // "September 2026" → "2026-09"
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(String(s).trim()); if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[2]}-${pad2(MONTHS[m[1].toLowerCase()])}`;
}
function dayMonthYear(s) {   // "8 October 2026" → "2026-10-08"
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(String(s).trim()); if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  const iso = `${m[3]}-${pad2(MONTHS[m[2].toLowerCase()])}-${pad2(m[1])}`; return isoOk(iso) ? iso : null;
}
// Dates printed in a note: ISO ("2026-06-30") or "Dec 17 2025". Returned as ISO; the note keeps the printed form.
const datesIn = t => {
  const out = (String(t).match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).filter(isoOk);
  const re = /\b([A-Z][a-z]{2,8})\.? (\d{1,2}),? (\d{4})\b/g; let m;
  while ((m = re.exec(String(t)))) { const mo = MONTHS[m[1].toLowerCase()]; if (mo) { const iso = `${m[3]}-${pad2(mo)}-${pad2(m[2])}`; if (isoOk(iso)) out.push(iso); } }
  return [...new Set(out)].sort();
};
const joinText = lines => lines.map(l => l.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------------------
// Header, headline figures and the two summary sections (page 1).
function parseHeader(pages) {
  const p1 = pages[0]; if (!p1) throw fail("not_a_strongback_report", "the PDF has no pages");
  const L = p1.lines;
  const title = L.find(l => / your Strongback dealers$/.test(l.text));
  if (!title) throw fail("not_a_strongback_report", 'no "…: your Strongback dealers" title on page 1');
  const sub = L.find(l => /^Sales through .+ · \d+ dealers$/.test(l.text));
  if (!sub) throw fail("not_a_strongback_report", 'no "Sales through <month> · <n> dealers" line on page 1');
  const sm = /^Sales through (.+) · (\d+) dealers$/.exec(sub.text);
  const header = {
    title: title.text, owner: title.text.replace(/: your Strongback dealers$/, ""),
    subtitle: sub.text, through_text: sm[1], through_month: monthName(sm[1]), dealer_count: Number(sm[2]),
    pos: posKey(1, title.y),
  };
  if (!header.through_month) throw fail("not_a_strongback_report", `"${sm[1]}" is not a month`);

  // Headline figures: the large figure row and the label lines under it, paired by column.
  const below = L.filter(l => l.y < sub.y);
  const valueLine = below.find(l => l.words.length >= 3 && l.words.every(w => /^\$?[\d,]+$/.test(w.text)));
  const kpis = [];
  if (valueLine) {
    const labelLines = below.filter(l => l.y < valueLine.y && l.y > valueLine.y - 40 && l.size < valueLine.size);
    valueLine.words.forEach((w, i) => {
      const nextX = valueLine.words[i + 1] ? valueLine.words[i + 1].x : Infinity;
      const label = joinText(labelLines.map(l => l.words.filter(x => x.x >= w.x - 4 && x.x < nextX - 4).map(x => x.text).join(" ")));
      kpis.push({ value_text: w.text, value: w.text.startsWith("$") ? money(w.text) : Number(w.text.replace(/,/g, "")),
        label, pos: `${posKey(1, valueLine.y)}:x${Math.round(w.x)}` });
    });
  }
  // Sections in capitals ("YOUR FIRST 8 MONTHS", "WORTH A LOOK THIS MONTH"): their lines up to the next heading.
  const sections = [];
  const tableTop = L.find(l => /^DEALER\b/.test(l.text) || l.words.some(w => w.text === "DEALER"));
  const headIdx = L.map((l, i) => (/^[A-Z0-9 ]{6,}$/.test(l.text) && l.y > (tableTop ? tableTop.y + 20 : 0) && /[A-Z]{3}/.test(l.text) ? i : -1)).filter(i => i >= 0);
  headIdx.forEach((hi, k) => {
    const end = k + 1 < headIdx.length ? headIdx[k + 1] : L.findIndex(l => tableTop && l.y <= tableTop.y + 14);
    const body = L.slice(hi + 1, end < 0 ? undefined : end).filter(l => !tableTop || l.y > tableTop.y + 14);
    // A paragraph break is a new line whose text begins a sentence after a line that ended one.
    const paras = []; let cur = [];
    for (const b of body) { cur.push(b.text); if (/[.!?]$/.test(b.text)) { paras.push(joinText(cur)); cur = []; } }
    if (cur.length) paras.push(joinText(cur));
    sections.push({ heading: L[hi].text, paragraphs: paras, pos: posKey(1, L[hi].y) });
  });
  return { header, kpis, sections };
}

// Figures the report states in words ("New dealers you brought in: 15, $27,808 so far.") — read, never invented.
function sectionFigures(sections) {
  const all = sections.map(s => s.paragraphs.join(" ")).join(" ");
  const f = {};
  let m;
  if ((m = /New dealers you brought in: (\d+), (\$[\d,]+) so far/.exec(all))) { f.new_dealers = Number(m[1]); f.new_dealers_amount_text = m[2]; f.new_dealers_amount = money(m[2]); }
  if ((m = /Of your (\d+) ordering dealers, (\d+)% have already reordered and (\d+)% have bought ErgoSteel/.exec(all))) {
    f.ordering_dealers = Number(m[1]); f.reordered_pct = Number(m[2]); f.ergosteel_pct = Number(m[3]); }
  if ((m = /For (\d+) of your (\d+) ordering dealers we do not know whether/.exec(all))) { f.display_unknown = Number(m[1]); }
  return f;
}

// ---------------------------------------------------------------------------------------------------------------
// The dealer table (page 1 → n). Columns are taken from the printed header, words are placed by x.
function parseTable(pages) {
  const all = []; for (const p of pages) for (const l of p.lines) all.push({ ...l, page: p.page });
  const hIdx = all.findIndex(l => l.words.some(w => w.text === "DEALER") && l.words.some(w => w.text === "TIER"));
  if (hIdx < 0) throw fail("table_not_found", "no DEALER / TIER header");
  const hPage = all[hIdx].page, hY = all[hIdx].y;
  const hdr = all.filter(l => l.page === hPage && Math.abs(l.y - hY) <= 8).flatMap(l => l.words);
  const at = (t, after = -1) => { const w = hdr.filter(w => w.text === t && w.x > after).sort((a, b) => a.x - b.x)[0]; if (!w) throw fail("table_not_found", `no ${t} column`); return w.x; };
  const cols = { tier: at("TIER"), trend: at("TREND") };
  cols.l12m = at("LAST"); cols.month = at("SEP") ; cols.last_order = at("LAST", cols.l12m + 1); cols.ergosteel = at("ERGOSTEEL"); cols.floor = at("CHAIR");
  // The month column is headed by the month's own abbreviation (SEP for September).
  const order = ["tier", "trend", "l12m", "month", "last_order", "ergosteel", "floor"];
  const colOf = x => { let c = null; for (const k of order) if (x >= cols[k] - 4) c = k; return c; };
  const footIdx = all.findIndex((l, i) => i > hIdx && /^Amounts are what we invoiced/.test(l.text));
  if (footIdx < 0) throw fail("table_not_found", "no table footnote (Amounts are what we invoiced…)");
  const body = all.slice(hIdx + 1, footIdx).filter(l => !(l.page === hPage && Math.abs(l.y - hY) <= 8));
  const footnote = joinText(all.slice(footIdx, footIdx + 3).filter((l, i, a) => i === 0 || (l.page === a[0].page && a[0].y - l.y < 30)).map(l => l.text));
  const rows = []; let cur = null;
  for (const l of body) {
    const left = l.words.filter(w => w.x < cols.tier - 4), right = l.words.filter(w => w.x >= cols.tier - 4);
    const startsRow = right.some(w => /^T[1-4]$/.test(w.text) && colOf(w.x) === "tier");
    if (startsRow) { cur = { page: l.page, y: l.y, name: [], city: [], cells: {} }; rows.push(cur); }
    if (!cur) { if (l.words.length) throw fail("table_unreadable", `text before the first row on page ${l.page}: "${l.text}"`); continue; }
    for (const w of left) { if (w.size >= 8.9) cur.name.push(w.text); else cur.city.push(w.text); }
    for (const w of right) { const c = colOf(w.x); (cur.cells[c] = cur.cells[c] || []).push(w.text); }
  }
  const tierRule = {}; let m; const re = /T([1-4]) from (\$\d{1,3}(?:,\d{3})*)/g;
  while ((m = re.exec(footnote))) tierRule["T" + m[1]] = money(m[2]);
  return { cols, footnote, tier_rule: tierRule, rows: rows.map((r, i) => {
    const cell = k => joinText(r.cells[k] || []);
    const city = splitCity(joinText(r.city));
    const lo = cell("last_order");
    const er = cell("ergosteel"), em = /^buying \((\d+)\)$/.exec(er);
    return { row_no: i + 1, pos: posKey(r.page, r.y), page: r.page, name: joinText(r.name), city_text: joinText(r.city), ...city,
      tier: cell("tier"), trend: cell("trend"), l12m_text: cell("l12m"), l12m: money(cell("l12m")),
      month_text: cell("month"), month_amount: money(cell("month")), last_order_text: lo, last_order_date: isoOk(lo) ? lo : null,
      ergosteel_text: er, ergosteel_chairs: em ? Number(em[1]) : null, floor_text: cell("floor") };
  }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Dealer pages: group headings, dealer headers, and the labelled fields.
function contactColumns(lines, valueX) {
  // Column starts: the value column, plus every word that begins after a wide gap on some line.
  const starts = [valueX];
  for (const l of lines) l.words.forEach((w, i) => {
    if (i > 0 && w.x - l.words[i - 1].x2 > 15 && !starts.some(s => Math.abs(s - w.x) < 8)) starts.push(w.x);
  });
  starts.sort((a, b) => a - b);
  const cols = starts.map(x => ({ x, lines: [] }));
  for (const l of lines) {
    const by = new Map();
    for (const w of l.words) { let ci = 0; starts.forEach((s, k) => { if (w.x >= s - 4) ci = k; }); (by.get(ci) || by.set(ci, []).get(ci)).push(w.text); }
    for (const [ci, ws] of by) cols[ci].lines.push({ text: ws.join(" "), y: l.y, page: l.page });
  }
  return cols.filter(c => c.lines.length).map(c => {
    const email = c.lines.filter(x => /@/.test(x.text)).map(x => x.text);
    const phone = c.lines.filter(x => !/@/.test(x.text) && /^[()\d\s.+-]{7,}$/.test(x.text) && (x.text.match(/\d/g) || []).length >= 7).map(x => x.text);
    const other = c.lines.filter(x => !email.includes(x.text) && !phone.includes(x.text)).map(x => x.text);
    return { lines: c.lines.map(x => x.text), name: other[0] || null, title: other.length > 1 ? other.slice(1).join(" ") : null,
      phones: phone, emails: email, pos: `${posKey(c.lines[0].page, c.lines[0].y)}:x${Math.round(c.x)}` };
  });
}

function productLine(text) {   // "STRONGBACK Comfort: 24 Wheelchair-2025* (1010-2025)" → name + code + HCPS class
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(text.trim());
  const name = m ? m[1] : text.trim(), code = m ? m[2] : null;
  const t = (name + " " + (code || "")).toLowerCase();
  const cls = /sample billing/.test(t) ? "sample" : /brochure/.test(t) ? "brochure"
    : /wobbler|sign\b|\(d2g\)|\bd2g\b/.test(t) ? "sign" : /warranty|replacement part/.test(t) ? "warranty" : "product";
  return { text: text.trim(), name, code, class: cls };
}

function parseErgo(text) {
  const m = /^Buying: (\d+) chairs? in (\d+) orders?, first (\d{4}-\d{2}-\d{2}), last (\d{4}-\d{2}-\d{2})\.\s*(.*)$/.exec(text);
  if (m) return { text, status: "buying", chairs: Number(m[1]), orders: Number(m[2]), first: m[3], last: m[4], note: m[5] || null };
  const n = /^Not ordered yet\.\s*(.*)$/.exec(text);
  if (n) return { text, status: "not_ordered", chairs: 0, orders: 0, first: null, last: null, note: n[1] || null };
  return { text, status: "unrecognised", chairs: null, orders: null, first: null, last: null, note: null };
}
function parseFloor(text) {
  if (/^Not known\./.test(text)) return { text, status: "not_known", note: text.replace(/^Not known\.\s*/, "") || null };
  if (/^A sample was sent; not confirmed that it is on the floor\./.test(text))
    return { text, status: "sample_sent", note: text.replace(/^A sample was sent; not confirmed that it is on the floor\.\s*/, "") || null };
  return { text, status: "unrecognised", note: null };
}

function parseDealerPages(pages, tableEnd, owner) {
  const lines = [];
  for (const p of pages) for (const l of p.lines) {
    if (p.page < tableEnd.page || (p.page === tableEnd.page && l.y >= tableEnd.y)) continue;
    if (l.size < 7) continue;   // chart value labels and month axis — visual only
    lines.push({ ...l, page: p.page });
  }
  const groups = [], dealers = [], report_notes = [];
  let group = null, d = null, field = null, label = null, pendingTier = null;
  const flushField = () => { field = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const gm = /^(.+) \((\d+)\)$/.exec(l.text);
    if (l.size >= 12.8 && gm) {   // group heading, e.g. "Slowing down (3)", then its one-line description
      const desc = lines[i + 1] && lines[i + 1].size < 12 && lines[i + 1].page === l.page && l.y - lines[i + 1].y < 25 ? lines[i + 1] : null;
      group = { heading: gm[1], count: Number(gm[2]), heading_text: l.text, description: desc ? desc.text : null,
        pos: posKey(l.page, l.y), description_pos: desc ? posKey(desc.page, desc.y) : null, dealers: [] };
      groups.push(group); if (desc) i++; d = null; flushField(); continue;
    }
    const tm = /^Tier ([1-4]) (.+)$/.exec(l.text);
    if (tm && l.size < 9 && l.x > 300) { pendingTier = { tier_text: `Tier ${tm[1]}`, tier: `T${tm[1]}`, trend: tm[2], pos: posKey(l.page, l.y) }; continue; }
    if (l.size >= 12 && l.size < 12.8) {   // dealer name
      if (!pendingTier) throw fail("dealer_page_unreadable", `"${l.text}" (page ${l.page}) has no Tier line`);
      if (!group) throw fail("dealer_page_unreadable", `"${l.text}" (page ${l.page}) is not under a group heading`);
      d = { name: l.text, page: l.page, pos: posKey(l.page, l.y), x: l.x, group: group.heading, ...pendingTier,
        city_text: null, bought_text: null, l12m_text: null, l12m: null, prior12_text: null, prior12: null,
        fields: {} };
      dealers.push(d); group.dealers.push(l.text); pendingTier = null; flushField(); continue;
    }
    if (/^Strongback Mobility USA · /.test(l.text)) {   // report footer (last page), may wrap; "prepared <date>" is read from it when printed
      const parts = [l]; while (lines[i + 1] && lines[i + 1].page === l.page && l.y - lines[i + 1].y < 20 && lines[i + 1].size <= l.size) parts.push(lines[++i]);
      report_notes.push({ kind: "footer", text: joinText(parts.map(x => x.text)), pos: posKey(l.page, l.y) });
      d = null; flushField(); continue;
    }
    if (!d) { if (l.text.trim()) report_notes.push({ kind: "unplaced", text: l.text, pos: posKey(l.page, l.y) }); continue; }
    if (!d.city_text && l.size < 9 && l.size > 8.2 && !/^What they bought/.test(l.text)) { d.city_text = l.text; d.city_pos = posKey(l.page, l.y); continue; }
    if (/^What they bought from us/.test(l.text)) {
      d.bought_text = l.text; d.bought_pos = posKey(l.page, l.y);
      const bm = /last 12 months (\$[\d,]+), the 12 months before (\$[\d,]+)/.exec(l.text);
      if (bm) { d.l12m_text = bm[1]; d.l12m = money(bm[1]); d.prior12_text = bm[2]; d.prior12 = money(bm[2]); }
      continue;
    }
    // Labels sit in the left column in small capitals; values to their right.
    const labelWords = l.words.filter(w => w.x < d.x + 70 && /^[A-Z]+$/.test(w.text));
    const lt = labelWords.map(w => w.text).join(" ");
    const valueWords = l.words.filter(w => !labelWords.includes(w));
    if (lt && LABEL_START.includes(lt)) {
      label = lt; field = LABELS[lt] || LABELS[lt + " " + (LABEL_CONT[lt] || "")]; if (!field) field = { "CHAIR ON THE": "floor", "WHAT THEY": "told_us", "OUR LAST": "contact_log" }[lt];
      d.fields[field] = d.fields[field] || { lines: [], label_pos: posKey(l.page, l.y) };
    } else if (lt && label && LABEL_CONT[label] === lt) { /* second half of a two-line label */ }
    else if (lt && !valueWords.length) throw fail("dealer_page_unreadable", `unknown label "${lt}" for ${d.name} (page ${l.page})`);
    if (!valueWords.length) continue;
    if (!field) throw fail("dealer_page_unreadable", `text before any label for ${d.name} (page ${l.page}): "${l.text}"`);
    d.fields[field].lines.push({ text: valueWords.map(w => w.text).join(" "), words: valueWords, y: l.y, page: l.page, x: valueWords[0].x });
  }
  if (pendingTier) throw fail("dealer_page_unreadable", "a Tier line without a dealer name after it");

  for (const d of dealers) {
    const F = d.fields, out = {};
    Object.assign(d, splitCity(d.city_text || ""));
    // CONTACT: people in columns.
    if (F.contact) { const vx = Math.min(...F.contact.lines.map(x => x.x)); out.contacts = contactColumns(F.contact.lines.map(x => ({ words: x.words, y: x.y, page: x.page })), vx); }
    else out.contacts = [];
    // Strongback prints the report owner (the HCPS rep) beside some dealers: that column is not a dealer contact.
    for (const c of out.contacts) c.role = (c.name && owner && c.name === owner) || c.emails.some(e => /@homecareproviderservices\./i.test(e)) ? "report_owner" : "dealer_contact";
    // LAST ORDER: first line = date (or "no order since …"); the rest = what was on that order.
    if (F.last_order) {
      const [first, ...rest] = F.last_order.lines;
      out.last_order = { text: first ? first.text : null, date: first && isoOk(first.text) ? first.text : null,
        pos: first ? posKey(first.page, first.y) : null,
        lines: rest.map(x => ({ ...productLine(x.text), pos: posKey(x.page, x.y) })) };
    } else out.last_order = null;
    out.ergosteel = F.ergosteel ? { ...parseErgo(joinText(F.ergosteel.lines.map(x => x.text))), pos: posKey(F.ergosteel.lines[0].page, F.ergosteel.lines[0].y) } : null;
    out.floor = F.floor ? { ...parseFloor(joinText(F.floor.lines.map(x => x.text))), pos: posKey(F.floor.lines[0].page, F.floor.lines[0].y) } : null;
    if (F.told_us) { const t = joinText(F.told_us.lines.map(x => x.text)); out.told_us = { text: t, dates: datesIn(t), pos: posKey(F.told_us.lines[0].page, F.told_us.lines[0].y) }; }
    else out.told_us = null;
    // OUR LAST CONTACTS: an entry starts with "YYYY-MM-DD Channel:"; other lines continue the entry above.
    out.contact_log = [];
    if (F.contact_log) for (const x of F.contact_log.lines) {
      const em = /^(\d{4}-\d{2}-\d{2}) ([A-Z][A-Za-z]+): (.*)$/.exec(x.text);
      if (em && isoOk(em[1])) out.contact_log.push({ date: em[1], channel: em[2], parts: [em[3]], pos: posKey(x.page, x.y) });
      else if (out.contact_log.length) out.contact_log[out.contact_log.length - 1].parts.push(x.text);
      else throw fail("dealer_page_unreadable", `contact entry without a date for ${d.name}: "${x.text}"`);
    }
    out.contact_log = out.contact_log.map(e => ({ date: e.date, channel: e.channel, text: joinText(e.parts), pos: e.pos }));
    d.detail = out; delete d.fields; delete d.x;
  }
  return { groups, dealers, report_notes };
}

// ---------------------------------------------------------------------------------------------------------------
function parseReport(layout) {
  if (!layout || !Array.isArray(layout.pages) || !layout.pages.length) throw fail("not_a_strongback_report", "no pages");
  const { header, kpis, sections } = parseHeader(layout.pages);
  const figures = sectionFigures(sections);
  const table = parseTable(layout.pages);
  // The table ends at its footnote; dealer pages follow it.
  const footLine = (() => { for (const p of layout.pages) for (const l of p.lines) if (/^Amounts are what we invoiced/.test(l.text)) return { page: p.page, y: l.y }; })();
  const lastFoot = (() => { const p = layout.pages.find(x => x.page === footLine.page); const ls = p.lines.filter(l => l.y <= footLine.y && footLine.y - l.y < 30); return { page: footLine.page, y: Math.min(...ls.map(l => l.y)) - 0.1 }; })();
  const pagesPart = parseDealerPages(layout.pages, lastFoot, header.owner);
  const footer = pagesPart.report_notes.find(n => n.kind === "footer") || null;
  const pm = footer && /prepared (\d{1,2} [A-Za-z]+ \d{4})/.exec(footer.text);
  header.prepared_text = pm ? pm[1] : null; header.prepared_date = pm ? dayMonthYear(pm[1]) : null;
  header.footer_text = footer ? footer.text : null; header.footer_pos = footer ? footer.pos : null;
  header.pdf = layout.meta || null;

  // Offers printed by Strongback (a group description, the footer): stored as unverified manufacturer text only.
  const offers = [];
  for (const g of pagesPart.groups) if (g.description && /\d+%/.test(g.description)) offers.push({ text: g.description, where: `group: ${g.heading}`, pos: g.description_pos });
  if (footer && /\d+%/.test(footer.text)) offers.push({ text: footer.text, where: "footer", pos: footer.pos });

  // Join table rows with dealer pages (exact printed name).
  const byName = new Map(pagesPart.dealers.map(d => [d.name, d]));
  const dealers = table.rows.map(r => ({ ...r, detail_page: byName.get(r.name) || null }));

  // ---- validation
  const errors = [], warnings = [], checks = [];
  const check = (id, ok, detail, level = "error") => { checks.push({ id, ok: !!ok, level, detail }); if (!ok) (level === "error" ? errors : warnings).push({ id, detail }); };
  check("dealer_count", table.rows.length === header.dealer_count, `table rows ${table.rows.length}, header says ${header.dealer_count}`);
  const names = table.rows.map(r => r.name); check("unique_names", new Set(names.map((n, i) => n + "|" + table.rows[i].city_text)).size === names.length, "each printed dealer + city appears once");
  for (const r of table.rows) {
    const bad = [];
    if (!r.name) bad.push("name"); if (!r.city || !r.state) bad.push("city/state");
    if (!/^T[1-4]$/.test(r.tier)) bad.push("tier"); if (!r.trend) bad.push("trend");
    if (r.l12m === null) bad.push("last 12 months"); if (r.month_amount === null) bad.push("month");
    if (!r.last_order_date && !/^none since [A-Z][a-z]{2} \d{4}$/.test(r.last_order_text)) bad.push("last order");
    if (!/^(not yet|buying \(\d+\))$/.test(r.ergosteel_text)) bad.push("ErgoSteel");
    if (!/^(not known|sample sent)$/.test(r.floor_text)) bad.push("chair on floor");
    check(`row_${r.row_no}_fields`, bad.length === 0, `${r.name}: ${bad.length ? "unreadable " + bad.join(", ") : "all fields read"}`);
    if (r.l12m !== null && /^T[1-4]$/.test(r.tier) && Object.keys(table.tier_rule).length === 3) {
      const t = r.l12m >= table.tier_rule.T1 ? "T1" : r.l12m >= table.tier_rule.T2 ? "T2" : r.l12m >= table.tier_rule.T3 ? "T3" : "T4";
      check(`row_${r.row_no}_tier_rule`, t === r.tier, `${r.name}: ${r.l12m_text} → ${t} by Strongback's own rule; printed ${r.tier}`, "warning");
    }
  }
  check("tier_rule_read", Object.keys(table.tier_rule).length === 3, `tier rule from the footnote: ${JSON.stringify(table.tier_rule)}`);
  const pagesTotal = pagesPart.groups.reduce((s, g) => s + g.count, 0);
  check("detail_page_count", pagesPart.dealers.length === pagesTotal, `${pagesPart.dealers.length} dealer pages, group headings add up to ${pagesTotal}`);
  for (const g of pagesPart.groups) check(`group_${g.heading}`, g.dealers.length === g.count, `"${g.heading_text}": ${g.dealers.length} dealer pages`);
  for (const d of pagesPart.dealers) {
    const r = table.rows.find(x => x.name === d.name);
    check(`page_${d.pos}_in_table`, !!r, `${d.name}: dealer page ${r ? "matches table row " + r.row_no : "has no table row"}`);
    if (!r) continue;
    check(`page_${d.pos}_agrees`, r.tier === d.tier && r.trend === d.trend && r.l12m === d.l12m && r.city_text === d.city_text,
      `${d.name}: page ${d.tier_text} ${d.trend} ${d.l12m_text} ${d.city_text} / table ${r.tier} ${r.trend} ${r.l12m_text} ${r.city_text}`);
    const bad = [];
    if (!d.detail.last_order) bad.push("LAST ORDER"); if (!d.detail.ergosteel) bad.push("ERGOSTEEL"); if (!d.detail.floor) bad.push("CHAIR ON THE FLOOR");
    if (d.detail.ergosteel && d.detail.ergosteel.status === "unrecognised") bad.push("ErgoSteel wording");
    if (d.detail.floor && d.detail.floor.status === "unrecognised") bad.push("chair-on-floor wording");
    if (d.prior12 === null) bad.push("12 months before");
    check(`page_${d.pos}_fields`, bad.length === 0, `${d.name}: ${bad.length ? "missing " + bad.join(", ") : "all labelled fields read"}`);
    if (d.detail.ergosteel && d.detail.ergosteel.status === "buying") {
      check(`page_${d.pos}_ergosteel`, `buying (${d.detail.ergosteel.chairs})` === r.ergosteel_text, `${d.name}: page ${d.detail.ergosteel.chairs} chairs / table "${r.ergosteel_text}"`, "warning");
    }
  }
  for (const n of pagesPart.report_notes.filter(n => n.kind === "unplaced")) check(`unplaced_${n.pos}`, false, `text outside any dealer: "${n.text}"`);
  // The prepared date as printed. A footer that says "prepared …" but whose date cannot be read is an ERROR (never
  // guessed); a report that prints no prepared date at all is "not stated" (a warning) — the import then needs the
  // register to say "not stated" too, and an upload or received date is never put in its place.
  const preparedPrinted = !!(footer && /\bprepared\b/i.test(footer.text));
  if (preparedPrinted) check("prepared_date", !!header.prepared_date, `prepared: ${header.prepared_text || "printed, but the date could not be read"}`);
  else check("prepared_date", false, "the report does not state a prepared date (not stated)", "warning");
  // Headline figures against the table (Strongback's own numbers; a gap is shown, never corrected).
  const sum = k => table.rows.reduce((s, r) => s + (r[k] || 0), 0);
  const k0 = kpis[0], k3 = kpis.find(k => /to /.test(k.label)), kN = kpis.find(k => /dealers that ordered/.test(k.label));
  if (k0) check("month_total", k0.value === sum("month_amount"), `${k0.label} ${k0.value_text}; table ${header.through_text.split(" ")[0]} column adds up to $${sum("month_amount").toLocaleString("en-US")}`, "warning");
  if (k3) check("l12m_total", k3.value === sum("l12m"), `${k3.label} ${k3.value_text}; table last-12-months column adds up to $${sum("l12m").toLocaleString("en-US")}`, "warning");
  if (kN) check("ordering_dealers", kN.value === table.rows.filter(r => r.l12m > 0).length, `${kN.value} dealers that ordered; ${table.rows.filter(r => r.l12m > 0).length} rows with last-12-months above $0`, "warning");

  return { parser: PARSER_VERSION, header, kpis, sections, figures, table: { footnote: table.footnote, tier_rule: table.tier_rule },
    groups: pagesPart.groups, dealers, offers, checks, errors, warnings };
}

module.exports = { parseReport, PARSER_VERSION, _internal: { productLine, parseErgo, parseFloor, splitCity, money, monthName, dayMonthYear } };
