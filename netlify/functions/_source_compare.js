/* PRIVATE PRICE-LIST COMPARISON (2026-10-27; tracker homecareproviderservices#42). Pure: no database, no network.

   The offline importer (scripts/catalog-import.js) used to compare a manufacturer's price list with the PUBLIC catalog
   file — which the P0 security release stripped of every price — so every priced row read "changed". The comparison
   now happens on the server (catalog-api `source_compare`, President only) against what dealers are actually charged
   today: the storefront's own merge (_pricing.js lineProducts — the private catalog_file_commercial record for the
   deployed file's exact version, the saved layers, and the master record where it is authoritative). Nothing here
   reads a public file for a price.

   Per part number, one state:
     unchanged     every commercial field the source STATES equals today's value
     changed       at least one stated field differs (the field names are reported, never the values)
     added         on the source, not in today's catalog
     removed       in today's catalog, not on the source — "not on the source", never a retirement
     ambiguous     the part number appears more than once with DIFFERENT figures (on the source, or in today's catalog),
                   so no single comparison is honest
     unverifiable  the source row has no usable general dealer price (missing, not a number, or quoted for one named
                   account — ABM), or today's product carries no price to compare with
   A field the source does not state is never compared ("not stated" is not "changed"). A derived MSRP (2× dealer,
   `_msrp_suggested`) is not a stated price: a different source MSRP reads "msrp (today derived)"; an equal one is unchanged
   with a note. A pack quantity of 1 is a single unit (= none stated). Today's pack size is the numeric field (case_qty, or the
   catalog file's qty_per_pack), else the count the unit wording states ("Pack of 12") — PediFix keeps it there; equal by
   wording alone is unchanged with a note (the record still needs the numeric field before activation).

   Refusals (no comparison is guessed): a source with no SHA-256 (its identity is unknown), a source for another line,
   an empty source, or a catalog the server could not read for its exact version (the caller refuses before this).

   OUTPUT NEVER CARRIES A PRICE: codes, states, field names, counts, the source's provenance and the catalog version
   fingerprint only. A test greps the output for every input figure. */
const crypto = require("crypto");
const FIELDS = ["dealer_price", "tiers", "msrp", "map", "uom", "case_qty"];
const STATES = ["unchanged", "changed", "added", "removed", "ambiguous", "unverifiable"];
const norm = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const num = v => { if (v === "" || v == null) return null; const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, "")); return isFinite(n) ? n : null; };
const cents = v => { const n = num(v); return n == null ? null : Math.round(n * 100); };
const txt = v => v == null ? "" : String(v).trim().toLowerCase().replace(/\s+/g, " ");
/* A ladder as the quantities where the price actually changes: a rung at quantity 1, or at the single-unit price, buys
   nothing and is dropped on both sides (a list printing "1 / 10 / 20" with 10+ at the 1-unit price = today's "20+"). */
function tiersKey(t, base) {
  if (!Array.isArray(t) || !t.length) return null;
  const b = cents(base);
  const rows = t.map(r => [parseInt(r && (r.min_qty != null ? r.min_qty : r.minQty), 10) || 1, cents(r && r.price)])
    .filter(r => r[1] != null && r[0] > 1 && r[1] !== b).sort((a, b2) => a[0] - b2[0]);
  return rows.length ? rows.map(r => r[0] + ":" + r[1]).join("|") : null;
}
/* A pack quantity: 1 means a single unit, the same as none stated (a list printing "1" against an "Each" product is not a
   unit difference). */
const packN = v => { const n = parseInt(v, 10); return n > 1 ? n : null; };
/* The count a unit WORDING states ("Pack of 12", "12-roll pack", "Case of 10", "Box of 100", "2/CS"), else null. */
function countInWords(u) {
  const s = String(u == null ? "" : u);
  const m = s.match(/\b(?:pack|case|box|bag|carton|set)\s+of\s+(\d+)\b/i) || s.match(/\b(\d+)\s*[- ]?(?:\w+[- ])?(?:pack|pk|ct|count)\b/i) || s.match(/\b(\d+)\s*\/\s*(?:cs|case|bx|box|pk)\b/i);
  return m ? packN(m[1]) : null;
}
/* Today's commercial values of one product, as the shop prices it. */
function currentOf(p) {
  /* A row that carries a list dealer price beside a discounted base (Access4U: dealer_price + tier_prices) is compared on
     the LIST price — the figure a manufacturer price list prints (the importer's own rule). */
  const raw = p.dealer_price != null && p.dealer_price !== "" ? p.dealer_price : p.base_price, price = cents(raw);
  /* Today's pack size: the numeric field (case_qty, or the catalog file's qty_per_pack — PediFix), else the count the unit
     wording dealers read states ("Pack of 12"). Which one supplied it is kept for the note. */
  const numeric = packN(p.case_qty) || packN(p.qty_per_pack), worded = numeric ? null : countInWords(p.uom);
  return { dealer_price: price, tiers: tiersKey(p.tiers || p.tier_prices, raw), msrp: cents(p.msrp), msrp_derived: !!p._msrp_suggested,
    map: cents(p.map), uom: txt(p.uom) || null, case_qty: numeric || worded, case_from_words: !!worded };
}
/* What a source row STATES (null = not stated). */
function sourceOf(r) {
  const price = cents(r.dealer_price);
  /* An MSRP / MAP the importer DERIVED from a stated rule (Access4U: MSRP = dealer × 1.5) is not a stated price. */
  const stated = (v, how) => (how == null || how === "stated") ? cents(v) : null;
  return { dealer_price: price, tiers: tiersKey(r.tiers, r.dealer_price), msrp: stated(r.msrp, r.msrp_source), map: stated(r.map, r.map_source), uom: txt(r.uom) || null,
    case_qty: packN(r.case_qty) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* input: { slug, line (importer line.json: {manufacturer, source:{file, sha256, received_date, effective_date…}, rows}),
            products (today's priced products from lineProducts), identity (catalog version), authority }
   output: { ok, refused?, summary, rows:[{code, state, fields?, note?, locators?}], source, catalog } */
function compareSource(input) {
  const i = input || {}, line = i.line || {}, src = line.source || {};
  const refuse = (code, message) => ({ ok: false, refused: code, message });
  if (!src.sha256 || !/^[0-9a-f]{64}$/i.test(String(src.sha256))) return refuse("source_unidentified", "The source has no SHA-256 fingerprint, so which file this is cannot be shown. Run the importer on the original file.");
  if (!line.manufacturer || (line.manufacturer !== i.slug && !(i.aliases || []).includes(line.manufacturer)))
    return refuse("wrong_line", `The source is for "${line.manufacturer || "?"}", not ${i.slug}.`);
  const srows = (Array.isArray(line.rows) ? line.rows : []).filter(r => r && norm(r.code));
  if (!srows.length) return refuse("empty_source", "The source has no rows with a part number.");
  if (!i.identity) return refuse("catalog_version_unknown", "Today's catalog version could not be established; nothing was compared.");

  const S = new Map(), C = new Map();
  for (const r of srows) { const k = norm(r.code); (S.get(k) || S.set(k, []).get(k)).push(r); }
  for (const p of (i.products || []).filter(p => p && norm(p.code) && p.active !== false)) { const k = norm(p.code); (C.get(k) || C.set(k, []).get(k)).push(p); }
  const out = [];
  for (const [k, rs] of S) {
    const code = String(rs[0].code), locators = rs.map(r => r.locator).filter(Boolean).slice(0, 4);
    const forms = rs.map(sourceOf);
    if (new Set(forms.map(f => JSON.stringify(f))).size > 1) { out.push({ code, state: "ambiguous", note: "listed " + rs.length + " times on the source with different figures", locators }); continue; }
    const s = forms[0];
    const scoped = rs.some(r => r.dealer_price_scope && !/^general$/i.test(String(r.dealer_price_scope)));
    const cur = C.get(k);
    if (!cur) { out.push({ code, state: scoped || s.dealer_price == null ? "unverifiable" : "added", note: scoped ? "price quoted for a named account — not a general dealer price" : (s.dealer_price == null ? "no general dealer price on the source" : "not in today's catalog"), locators }); continue; }
    if (scoped) { out.push({ code, state: "unverifiable", note: "price quoted for a named account — not a general dealer price", locators }); continue; }
    if (s.dealer_price == null) { out.push({ code, state: "unverifiable", note: "no usable dealer price on the source", locators }); continue; }
    const cforms = cur.map(currentOf);
    if (new Set(cforms.map(f => JSON.stringify(f))).size > 1) { out.push({ code, state: "ambiguous", note: "listed " + cur.length + " times in today's catalog with different figures", locators }); continue; }
    const c = cforms[0];
    if (c.dealer_price == null) { out.push({ code, state: "unverifiable", note: "today's product carries no price to compare with", locators }); continue; }
    const fields = [], notes = [];
    for (const f of FIELDS) {
      if (s[f] == null) continue;                                  // not stated on the source: never compared
      if (f === "msrp" && c.msrp_derived) { if (same(s[f], c[f])) notes.push("MSRP now stated by the source (equal to today's derived MSRP)"); else fields.push("msrp (today derived)"); continue; }
      if (!same(s[f], c[f])) fields.push(f);
      else if (f === "case_qty" && c.case_from_words) notes.push("pack size today only in the unit wording, not a numeric field");
    }
    const note = notes.length ? { note: notes.join("; ") } : {};
    out.push(fields.length ? Object.assign({ code, state: "changed", fields, locators }, note) : Object.assign({ code, state: "unchanged", locators }, note));
  }
  for (const [k, cs] of C) if (!S.has(k)) out.push({ code: String(cs[0].code), state: "removed", note: "in today's catalog, not on this source — never retired from a comparison" });
  out.sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.code.localeCompare(b.code));
  const summary = Object.fromEntries(STATES.map(s => [s, out.filter(r => r.state === s).length]));
  summary.source_rows = srows.length; summary.catalog_products = [...C.values()].reduce((n, v) => n + v.length, 0);
  const fieldCounts = {}; out.filter(r => r.state === "changed").forEach(r => r.fields.forEach(f => { fieldCounts[f] = (fieldCounts[f] || 0) + 1; }));
  return { ok: true, manufacturer: i.slug, summary, changed_fields: fieldCounts, rows: out,
    source: { file: src.file || null, sha256: String(src.sha256).toLowerCase(), title: src.title || null, received_date: src.received_date || null,
      effective_date: src.effective_date || null, effective_date_status: src.effective_date_status || null },
    catalog: { identity: String(i.identity).slice(0, 16), authority: i.authority || "layers" },
    fingerprint: crypto.createHash("sha256").update(JSON.stringify([src.sha256, i.identity, out])).digest("hex") };
}
module.exports = { compareSource, FIELDS, STATES, tiersKey, cents };
