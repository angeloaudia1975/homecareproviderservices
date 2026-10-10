/* MANUFACTURER CENTER — the shared rules (Phases 1–3, approved by Angelo 2026-10-10).
   Manufacturer Center orchestrates the existing systems; it is not another product database or
   pricing engine. This file holds the three things every caller must agree on:
     1. which requests are COMMERCIAL writes (the freeze applies to exactly these);
     2. SAFE STAGING — a field a source row leaves out stays as it is, and a value is only ever
        cleared on purpose, with a recorded decision;
     3. VERIFICATION — the full pre/post activation check (product card, cart, server pricing,
        freight, both emails, impact, retired SKUs, images, fingerprint), not parity alone.
   Pure where it can be: the database, the storefront files and the email builders are passed in. */
const crypto = require("crypto");

/* ── 1. COMMERCIAL WRITES ────────────────────────────────────────────────────────────────────
   catalog-api actions that change a price, MSRP, MAP, tier, status, UOM, code, provenance or
   authority. A frozen line refuses all of them unless the request carries an approved
   regression_fix (the database refuses them too — mfr_freeze_guard — whichever path they take). */
const COMMERCIAL_ACTIONS = new Set(["stage_record_source","set_record_provenance","set_record_authority","bulk_price",
  "save_product","delete_product","delete_products_bulk","discontinue_sku","retire_sku","restore_sku","rename_code",
  "merge_layers","merge_layers_bulk","merge_products","merge_products_bulk","unmerge_layers","unmerge_product",
  "clear_override","set_group"]);
const OVERRIDE_COMMERCIAL_KEYS = ["base_price","msrp","map","msrp_auto","tiers","active","disposition","price_note","case_qty","effective_date","source_file"];
function isCommercialAction(b){
  if(!b || !b.action) return false;
  if(COMMERCIAL_ACTIONS.has(b.action)) return true;
  if(b.action === "save_override") return OVERRIDE_COMMERCIAL_KEYS.some(k => b.patch && Object.prototype.hasOwnProperty.call(b.patch, k)) || b.replace === true;
  if(b.action === "reconcile") return b.apply === true;
  return false;
}
function lineOf(b){ return String((b && (b.manufacturer || b.slug)) || "").trim(); }

/* ── 2. SAFE STAGING ─────────────────────────────────────────────────────────────────────────
   For a SKU that already has a record:
     field absent from the row          → "not_in_source": kept exactly as it is;
     field present, same value          → "unchanged";
     field present, different value     → "changed" (written);
     field present as null/empty, record holds a value → "would_clear": refused unless the field
       is listed in `clear` AND the request names a decision approving it.
   A new SKU is created from what the row gives (absent = empty, as before). */
const STAGE_FIELDS = ["base_price","tiers","map","msrp","msrp_auto","status","status_note","uom","case_qty","dealer_unit_cost","msrp_basis","map_basis"];
const BASES = ["each","order_unit"];
function planStage({ rows, existingByNorm, clear, clearApproved, normCode, num, cleanTiers, LIVE_STATUS, ALLOWED_STATUS }){
  const clearSet = new Set(Array.isArray(clear) ? clear.map(String) : []);
  const bad = [], plan = [], seen = new Map();
  const money = v => (v == null ? null : Math.round(Number(v) * 100) / 100);
  const ladder = t => JSON.stringify((cleanTiers(t) || []).map(x => [x.min_qty, x.price, x.pool || null]));
  const same = (f, a, b) => {
    if(f === "tiers") return ladder(a) === ladder(b);
    if(["base_price","map","msrp","dealer_unit_cost"].includes(f)) return money(a) === money(b);
    if(f === "case_qty") return (a == null ? null : Number(a)) === (b == null ? null : Number(b));
    if(f === "msrp_auto") return (a === true) === (b === true);
    return (a == null || a === "" ? null : String(a)) === (b == null || b === "" ? null : String(b));
  };
  const norm = (f, v, code) => {
    if(v === undefined) return undefined;
    switch(f){
      case "base_price": case "map": case "msrp": case "dealer_unit_cost": {
        if(v == null || v === "") return null; const n = num(v); if(n == null || !(n >= 0)) throw new Error(f + " is not a valid amount"); return n; }
      case "tiers": return v == null ? null : cleanTiers(v);
      case "msrp_auto": return v === true;
      case "status": { const s = v == null ? null : String(v); if(s != null && ALLOWED_STATUS.indexOf(s) < 0) throw new Error("status " + s); return s; }
      case "status_note": return v == null ? null : String(v).slice(0, 300);
      case "uom": return v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, 40);
      case "case_qty": { if(v == null || v === "") return null; const n = num(v); if(!(n > 0)) throw new Error("case_qty"); return n; }
      case "msrp_basis": case "map_basis": { if(v == null || v === "") return null; const s = String(v); if(BASES.indexOf(s) < 0) throw new Error(f + " must be each or order_unit"); return s; }
    }
    return v;
  };
  for(const r of (rows || [])){
    const code = String((r && r.code) || "").trim();
    if(!code){ bad.push({ code: "", why: "no code" }); continue; }
    const key = normCode(code);
    if(seen.has(key)){ seen.set(key, seen.get(key) + 1); continue; } seen.set(key, 1);
    const present = STAGE_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(r, f));
    const vals = {};
    try{ present.forEach(f => { vals[f] = norm(f, r[f], code); }); }
    catch(e){ bad.push({ code, why: String(e.message || e) }); continue; }
    const before = existingByNorm[key] || null;
    if(!before){
      const row = { code, status: vals.status || LIVE_STATUS, msrp_auto: vals.msrp_auto === true };
      STAGE_FIELDS.forEach(f => { if(f in vals && f !== "status" && f !== "msrp_auto") row[f] = vals[f]; });
      if(row.status === LIVE_STATUS && !(num(row.base_price) > 0)){ bad.push({ code, why: "an active row needs a base price" }); continue; }
      plan.push({ code, action: "create", before: null, set: row, after: row,
        changed: Object.fromEntries(Object.keys(row).filter(k => k !== "code").map(k => [k, [null, row[k]]])),
        unchanged: [], would_clear: [], not_in_source: STAGE_FIELDS.filter(f => !(f in row)) });
      continue;
    }
    const set = {}, changed = {}, unchanged = [], would_clear = [], refusedClears = [];
    for(const f of present){
      const v = vals[f], was = before[f];
      if(same(f, was, v)){ unchanged.push(f); continue; }
      const clearing = (v == null || (f === "tiers" && (!v || !v.length))) && !(was == null || (f === "tiers" && !(cleanTiers(was) || []).length));
      if(clearing){
        would_clear.push(f);
        const approved = clearSet.has(f) && clearApproved;
        if(approved){ set[f] = null; changed[f] = [was, null]; } else refusedClears.push(f);
        continue;
      }
      set[f] = v; changed[f] = [was, v];
    }
    const merged = Object.assign({}, before, set);
    if((merged.status || LIVE_STATUS) === LIVE_STATUS && !(num(merged.base_price) > 0)){ bad.push({ code, why: "an active row needs a base price" }); continue; }
    plan.push({ code: before.code || code, action: "update", before, set, after: merged, changed, unchanged, would_clear,
      refused_clears: refusedClears, not_in_source: STAGE_FIELDS.filter(f => present.indexOf(f) < 0) });
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  return { plan, bad, duplicates };
}

/* ── 3. VERIFICATION ─────────────────────────────────────────────────────────────────────────── */
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&middot;/g, "·");
/* The words a dealer reads, exactly as the browser's textContent gives them (the same canonical
   form the Partner 360 fingerprint uses): block ends become spaces, tags vanish, entities decode. */
const text = html => decode(String(html || "").replace(/<\/div>/g, " </div>").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const m2 = v => (v == null || v === "" ? null : Math.round(Number(v) * 100) / 100);
const ladderKey = (t, bp) => (Array.isArray(t) ? t : []).map(x => ({ q: Math.round(Number(x.minQty != null ? x.minQty : x.min_qty)), p: m2(x.price), pool: x.pool || null }))
  .filter(x => !(x.q === 1 && bp != null && x.p === m2(bp))).sort((a, b) => a.q - b.q).map(x => x.q + ":" + x.p + (x.pool ? "@" + x.pool : "")).join(",");
function check(id, label, ok, detail, severity){ return { id, label, pass: !!ok, severity: severity || "blocking", detail: detail == null ? null : detail }; }

/* Expected freight words on the dealer confirmation (orders-api freightWords) and HCPS email (freightShort). */
function expectedFreightWords(fee, lines, money){
  if(fee > 0){ const f = (lines || []).find(r => r.status === "flat" && r.flatLabel); return { dealer: money(fee) + (f ? " " + f.flatLabel : ""), hcps: money(fee) + " " + (f ? f.flatLabel : "flat") }; }
  const f = (lines || []).find(r => r.status === "free" && r.freeLabel);
  const anyActual = (lines || []).some(r => r.status === "actual");
  return { dealer: f ? f.freeLabel : "Free", hcps: anyActual ? "actual freight (confirmed by manufacturer)" : ((lines || []).length ? (f ? f.freeLabel : "FREE") : "—") };
}

/* verifyLine — everything a dealer would see for one line, checked on the server.
   deps: { slug, sb, PRICING, files, ENGINE_SOURCE, RENDER_SOURCE, EMAIL_SOURCE, EXTRACT, liveIndexHtml,
           orderConfirmation, unitLabel, fetchImpl, ORDERING_BASE, baseline } */
async function verifyLine(d){
  const checks = [], e = encodeURIComponent, slug = d.slug, t0 = Date.now();
  const add = c => { checks.push(c); return c; };

  // A. The server's copies are the deployed storefront's code.
  const live = d.liveIndexHtml || "";
  let engineSame = false, renderSame = false, cartTpl = false;
  try{ engineSame = d.EXTRACT.extractEngine(live) === d.ENGINE_SOURCE; }catch(err){}
  try{ renderSame = d.EXTRACT.extractRender(live) === d.RENDER_SOURCE; }catch(err){}
  cartTpl = live.indexOf(d.EXTRACT.CART_PACK_TEMPLATE) >= 0;
  add(check("engine_in_sync", "Server pricing engine = live storefront code", engineSame, engineSame ? null : "the deployed index.html no longer matches _shop_engine.js"));
  add(check("render_in_sync", "Server card/freight rendering = live storefront code", renderSame, renderSame ? null : "the deployed index.html no longer matches _shop_render.js"));
  add(check("cart_template", "Cart pack line template present on the live storefront", cartTpl));

  // B. Load the line exactly as the server prices it.
  const [metaRows, records, mfrList] = await Promise.all([
    d.sb("GET", `manufacturer_meta?slug=eq.${e(slug)}&select=slug,record_authoritative,record_resync_error,frozen,deferrals,freight_terms`),
    d.sb("GET", `product_skus?manufacturer=eq.${e(slug)}&select=*&limit=10000`),
    d.files.manufacturersFile()]);
  const meta = (metaRows && metaRows[0]) || {};
  const freightCfg = {}; (Array.isArray(mfrList) ? mfrList : []).forEach(m => { if(m && m.slug) freightCfg[m.slug] = m; });
  const cart = new Map();
  const L = await d.PRICING.lineProducts({ slug, sb: d.sb, catalogFile: d.files.catalogFile, contentFile: d.files.contentFile, contract: {}, cart, freightCfg });
  const products = L.products.filter(p => !p._discontinued);
  const R = new Function("state", "contractPrice", d.RENDER_SOURCE + ";return {priceHtml,freightRowsHtml,packOf,packNote,dealerPriceNote,money};")({ dealer: {} }, () => null);
  const norm = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const active = (records || []).filter(r => (r.status || "active") === "active");
  const retired = (records || []).filter(r => (r.status || "active") !== "active");
  const recBy = {}; active.forEach(r => { recBy[r.code_norm || norm(r.code)] = r; });
  const authoritative = meta.record_authoritative === true;
  add(check("authority", "Record authority", true, { authoritative, source: L.source, frozen: meta.frozen === true }, "advisory"));

  // C. Full-field parity — every visible product against its master record.
  const drift = [], noRecord = [];
  for(const p of products){
    const r = recBy[norm(p.code)];
    if(!r){ noRecord.push(p.code); continue; }
    const pairs = [["base_price", m2(p.base_price), m2(r.base_price)], ["msrp", m2(p.msrp), m2(r.msrp)], ["map", m2(p.map), m2(r.map)],
      ["tiers", ladderKey(p.tiers, p.base_price), ladderKey(r.tiers, r.base_price)],
      ["uom", p.uom ? String(p.uom) : null, r.uom ? String(r.uom) : null],
      ["case_qty", Number(p.case_qty) > 1 ? Number(p.case_qty) : 1, Number(r.case_qty) > 1 ? Number(r.case_qty) : 1]];
    for(const [f, a, b] of pairs){ if(f === "msrp" && b == null && r.msrp_auto !== false) continue; if(JSON.stringify(a) !== JSON.stringify(b)) drift.push({ code: p.code, field: f, storefront: a, record: b }); }
  }
  const unlisted = active.filter(r => !products.some(p => norm(p.code) === (r.code_norm || norm(r.code)))).map(r => r.code);
  if(authoritative){
    add(check("full_field_parity", "Storefront = record on price, MSRP, MAP, tiers, UOM and case qty", !drift.length, drift.length ? drift.slice(0, 50) : { compared: products.length - noRecord.length }));
    add(check("every_product_has_record", "Every visible product has an active master record", !noRecord.length, noRecord.length ? noRecord.slice(0, 50) : null));
    add(check("every_record_listed", "Every active record is visible on Partner 360", !unlisted.length, unlisted.length ? unlisted.slice(0, 50) : null, "advisory"));
  } else {
    add(check("full_field_parity", "Storefront vs record (line not record-authoritative)", true, { differences_if_activated: drift.slice(0, 50), no_record: noRecord.slice(0, 50) }, "advisory"));
  }

  // D. Source alignment — the record against the accepted source as received, and HCPS decisions.
  const [srcRows, imports, decisions] = await Promise.all([
    d.sb("GET", `mfr_sources?manufacturer=eq.${e(slug)}&status=eq.accepted&select=id,kind,title,legacy,received_date,manufacturer_effective_date,effective_date_status`),
    d.sb("GET", `price_imports?manufacturer=eq.${e(slug)}&source_id=not.is.null&select=code,base_price,msrp,map,parsed_case_qty,parsed_unit_cost,source_id&limit=10000`),
    d.sb("GET", `mfr_decisions?manufacturer=eq.${e(slug)}&select=id,code,field,kind,hcps_value&limit=1000`)]);
  const accepted = (srcRows || []).filter(s => s.kind === "price_list");
  const noProv = active.filter(r => r.source_id == null).map(r => r.code);
  add(check("provenance", "Every active record names its accepted source", !noProv.length, noProv.length ? noProv.slice(0, 50) : { sources: accepted.map(s => s.title) }, "advisory"));
  const live_imports = (imports || []).filter(i => accepted.some(s => s.id === i.source_id && !s.legacy));
  if(live_imports.length){
    const mis = [];
    const uomDecision = c => (decisions || []).find(x => x.field === "uom" && x.code && norm(x.code) === norm(c) && x.kind === "interpretation");
    for(const i of live_imports){
      const r = recBy[norm(i.code)]; if(!r){ mis.push({ code: i.code, field: "record", source: "present", record: "missing" }); continue; }
      [["base_price", i.base_price, r.base_price], ["msrp", i.msrp, r.msrp], ["map", i.map, r.map], ["dealer_unit_cost", i.parsed_unit_cost, r.dealer_unit_cost]]
        .forEach(([f, a, b]) => { if(m2(a) !== m2(b)) mis.push({ code: i.code, field: f, source: m2(a), record: m2(b) }); });
      const dec = uomDecision(i.code);
      if(dec){ const hv = dec.hcps_value || {}; if(String(r.uom || "") !== String(hv.uom || "") || Number(r.case_qty || 1) !== Number(hv.case_qty || 1)) mis.push({ code: i.code, field: "uom", decision: hv, record: { uom: r.uom, case_qty: r.case_qty } }); }
      else if(i.parsed_case_qty != null && Number(r.case_qty) !== Number(i.parsed_case_qty)) mis.push({ code: i.code, field: "case_qty", source: Number(i.parsed_case_qty), record: r.case_qty });
      else if(i.parsed_case_qty == null) mis.push({ code: i.code, field: "case_qty", source: null, record: r.case_qty, note: "no case qty in source and no HCPS decision" });
    }
    add(check("source_alignment", "Record = accepted source as received (or a recorded HCPS decision)", !mis.length, mis.length ? mis.slice(0, 50) : { rows: live_imports.length }));
  } else {
    add(check("source_alignment", "Record vs source as received", true, accepted.length ? "legacy source — no as-received rows to compare" : "no accepted price list registered", "advisory"));
  }
  const eff = accepted.find(s => !s.legacy) || accepted[0];
  if(eff) add(check("effective_date", "Manufacturer effective date", true, { status: eff.effective_date_status, date: eff.manufacturer_effective_date, received: eff.received_date }, "advisory"));

  // E. Product cards — the words on every card, and the rules they must follow.
  const cardIssues = [], cards = {};
  for(const p of products){
    const html = R.priceHtml(p), tx = text(html); cards[p.code] = tx;
    const pk = R.packOf(p);
    if(p.base_price != null && tx.indexOf("$" + Number(p.base_price).toFixed(2)) < 0) cardIssues.push({ code: p.code, issue: "price not shown", text: tx });
    if(pk){ if(tx.indexOf("per " + pk.label) < 0 || tx.indexOf(`Dealer order unit = 1 ${pk.label} (${pk.n} each)`) < 0) cardIssues.push({ code: p.code, issue: "pack wording missing", text: tx }); }
    const mapv = (p.map != null && p.map !== "" && Number(p.map) > 0) ? Number(p.map) : null;
    if(mapv != null && tx.indexOf("MAP " + R.money(mapv) + (pk ? " each" : "")) < 0) cardIssues.push({ code: p.code, issue: "MAP wording", text: tx });
    if((tx.match(/MSRP /g) || []).length > 1) cardIssues.push({ code: p.code, issue: "MSRP shown twice", text: tx });
    const note = R.dealerPriceNote(p.price_note, p);
    if(/\$[\d,.]+\s*\/\s*unit/i.test(note)) cardIssues.push({ code: p.code, issue: "derived per-unit price in note", text: note });
  }
  add(check("product_cards", "Product cards: price, pack wording, MAP/MSRP, no derived notes", !cardIssues.length, cardIssues.length ? cardIssues.slice(0, 50) : { cards: products.length }));

  // F. Cart lines for pack SKUs.
  const packs = products.filter(p => R.packOf(p));
  add(check("cart_lines", "Cart reads 'N × unit = M each' for pack SKUs", cartTpl, { pack_skus: packs.length,
    example: packs.length ? `1 × ${R.packOf(packs[0]).label} = ${R.packOf(packs[0]).n} each · Unit ${R.money(L.engine.unitPrice(packs[0], 1))} per ${R.packOf(packs[0]).label}` : null }));

  // G. Server pricing = storefront engine, on every SKU and on the closest real carts either side of each freight threshold.
  const groups = ((freightCfg[slug] || {}).freight || {}).groups || [];
  const thresholds = [...new Set(groups.flatMap(g => [g.freeAt, g.flatBelow].filter(v => v != null && Number(v) > 0).map(Number)))];
  const carts = [products.map(p => [p, 1])];
  for(const T of thresholds){
    let below = null, above = null;
    for(const p of products){ const u = Number(L.engine.unitPrice(p, 1)); if(!(u > 0)) continue;
      const q = Math.ceil((T - 0.0001) / u); for(const qq of [q - 1, q]){ if(qq < 1 || qq > 60) continue; const tot = Math.round(qq * Number(L.engine.unitPrice(p, qq)) * 100) / 100;
        if(tot < T && (!below || tot > below.tot)) below = { p, qq, tot }; if(tot >= T && (!above || tot < above.tot)) above = { p, qq, tot }; } }
    if(below) carts.push([[below.p, below.qq]]); if(above) carts.push([[above.p, above.qq]]);
  }
  const priceIssues = [], cartResults = [];
  for(const c of carts){
    if(!c.length) continue;
    const items = c.map(([p, q]) => ({ code: p.code, family: p.family == null ? undefined : p.family, qty: q, unit: Number(L.engine.unitPrice(p, q)) }));
    const eng = L.engine.computeFreight(slug, c.map(([p, q]) => ({ p, qty: q })));
    const res = await d.PRICING.priceOrders({ orders: [{ manufacturer_slug: slug, items }], dealerId: null, sb: d.sb,
      catalogFile: d.files.catalogFile, contentFile: d.files.contentFile, manufacturersFile: d.files.manufacturersFile });
    const o = res.orders[0];
    if(res.changed) priceIssues.push({ cart: items.length > 3 ? items.length + " SKUs" : items.map(i => i.code + "×" + i.qty).join("+"), issue: "server price differs", items: o.items.filter(i => i.changed).slice(0, 10).map(i => ({ code: i.code, browser: i.client_unit, server: i.unit })) });
    if(Math.round(Number(o.freight_fee) * 100) !== Math.round(Number(eng.fee) * 100)) priceIssues.push({ cart: items.map(i => i.code + "×" + i.qty).join("+"), issue: "freight differs", browser: eng.fee, server: o.freight_fee });
    if(items.length <= 3) cartResults.push({ cart: items.map(i => i.code + "×" + i.qty).join("+"), subtotal: o.subtotal, freight: o.freight_fee, total: o.estimated_total });
  }
  add(check("browser_equals_server", "Server price and freight = storefront engine (every SKU + threshold carts)", !priceIssues.length, priceIssues.length ? priceIssues : { skus: products.length, threshold_carts: cartResults }));

  // H. Freight at each threshold: one cent below, exact, one cent above — fee and wording.
  const fIssues = [], fRows = [];
  for(const g of groups){
    const T = g.freeAt != null && Number(g.freeAt) > 0 ? Number(g.freeAt) : (g.flatBelow != null && Number(g.flatBelow) > 0 ? Number(g.flatBelow) : null);
    const cat = Array.isArray(g.categories) && g.categories.length ? g.categories[0] : "";
    const brand = Array.isArray(g.brandKeywords) && g.brandKeywords.length && g.brandKeywords[0] !== "*" ? g.brandKeywords[0] : "x";
    const pts = T ? [T - 0.01, T, T + 0.01] : [100];
    for(const v of pts){
      const f = L.engine.computeFreight(slug, [{ p: { base_price: Math.round(v * 100) / 100, brand, category: cat }, qty: 1 }]);
      const words = text(R.freightRowsHtml(f));
      fRows.push({ group: g.label, amount: Math.round(v * 100) / 100, fee: f.fee, words });
      if(g.freeAt != null && v >= Number(g.freeAt) && words.indexOf(g.freeLabel || "FREE freight") < 0) fIssues.push({ group: g.label, amount: v, issue: "free/prepaid wording", words });
      if(T && g.freeAt != null && v < Number(g.freeAt) && (g.flatFee != null || g.flatUnder != null) && !(f.fee > 0)) fIssues.push({ group: g.label, amount: v, issue: "fee missing below threshold" });
      if(T && g.freeAt != null && v >= Number(g.freeAt) && f.fee > 0) fIssues.push({ group: g.label, amount: v, issue: "fee charged at/above threshold" });
      if(g.flatLabel && f.fee > 0 && words.indexOf(g.flatLabel) < 0) fIssues.push({ group: g.label, amount: v, issue: "fee wording", words });
    }
  }
  add(check("freight_boundaries", "Freight fee and wording at each threshold (−1¢ / exact / +1¢)", !fIssues.length, fIssues.length ? fIssues : (fRows.length ? fRows : "no freight groups (freight confirmed per order)")));

  // I. Both emails, rendered — nothing sent, nothing stored.
  const sample = [...packs.slice(0, 2), ...products.filter(p => !R.packOf(p)).slice(0, 2)];
  if(sample.length){
    const items = sample.map(p => ({ code: p.code, family: p.family == null ? undefined : p.family, qty: 1, unit: Number(L.engine.unitPrice(p, 1)) }));
    const res = await d.PRICING.priceOrders({ orders: [{ manufacturer_slug: slug, items }], dealerId: null, sb: d.sb,
      catalogFile: d.files.catalogFile, contentFile: d.files.contentFile, manufacturersFile: d.files.manufacturersFile });
    const o = res.orders[0];
    const summary = { slug, line: slug, po: "VERIFY", freight_fee: o.freight_fee, estimated_total: o.estimated_total, freight_lines: o.freight_lines || [], subtotal: o.subtotal,
      items: o.items.map(it => { const x = { code: it.code, name: it.name, qty: it.qty, unit_price: it.unit, line_total: it.line_total }; const lb = d.unitLabel(it); return lb ? Object.assign(x, { unit_label: lb }) : x; }) };
    const dealer = d.orderConfirmation("verify@example.invalid", { business: "Verification only" }, [summary]);
    const E = new Function(d.EMAIL_SOURCE + ";return {buildEmail};")();
    const shopItems = sample.map(p => ({ code: p.code, name: p.name, brand: p.brand || "", uom: p.uom || "", case_qty: R.packOf(p) ? R.packOf(p).n : undefined, qty: 1, unit: Number(L.engine.unitPrice(p, 1)) }));
    const hcps = E.buildEmail({ business: "Verification only", email: "verify@example.invalid" }, { manufacturer_name: slug, manufacturer_slug: slug, po: "VERIFY", items: shopItems,
      items_count: shopItems.length, items_subtotal: o.subtotal, estimated_total: o.estimated_total, freight_fee: o.freight_fee, freight_lines: o.freight_lines || [] }, "2026-10-10T12:00:00Z");
    const want = expectedFreightWords(Number(o.freight_fee), o.freight_lines, n => "$" + (Math.round(Number(n) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const eIssues = [];
    for(const p of sample){ const pk = R.packOf(p); if(!pk) continue; const lab = `${pk.label} (${pk.n} each)`;
      if(dealer.text.indexOf(lab) < 0) eIssues.push({ email: "dealer", code: p.code, missing: lab });
      if(hcps.text.indexOf(lab) < 0) eIssues.push({ email: "hcps", code: p.code, missing: lab }); }
    const dealerFreight = (dealer.text.match(/Freight: ([^\n]+)/) || [])[1] || null;
    const hcpsFreight = (hcps.text.match(/Freight: ([^\n]+)/) || [])[1] || null;
    if((Number(o.freight_fee) > 0 || (o.freight_lines || []).some(r => r.status === "free")) && dealerFreight !== want.dealer) eIssues.push({ email: "dealer", freight: dealerFreight, expected: want.dealer });
    if(hcpsFreight !== want.hcps) eIssues.push({ email: "hcps", freight: hcpsFreight, expected: want.hcps });
    add(check("emails", "Dealer confirmation and HCPS email: unit wording and freight words", !eIssues.length, eIssues.length ? eIssues : { dealer_freight: dealerFreight, hcps_freight: hcpsFreight,
      dealer_lines: dealer.text.split("\n").filter(l => / x /.test(l)), hcps_lines: hcps.text.split("\n").filter(l => / x /.test(l)) }));
  }

  // J. Impact — contract prices and saved carts that touch this line.
  const [contracts, carts2] = await Promise.all([
    d.sb("GET", `dealer_contract_prices?manufacturer=eq.${e(slug)}&active=eq.true&select=dealer_id,code,price&limit=2000`),
    d.sb("GET", `dealer_carts?select=dealer_id,cart,updated_at&limit=5000`)]);
  const codes = new Set((records || []).map(r => norm(r.code)));
  const cartHits = [];
  (carts2 || []).forEach(c => { const its = (c.cart && Array.isArray(c.cart.items)) ? c.cart.items : [];
    its.forEach(i => { const p = i && i.p || {}; if(p.manufacturer === slug || codes.has(norm(p.code))) cartHits.push({ dealer_id: c.dealer_id, code: p.code, qty: i.qty, updated_at: c.updated_at }); }); });
  add(check("impact", "Contract prices and saved carts touching this line", true, { contract_prices: (contracts || []).length, contract_rows: (contracts || []).slice(0, 25), saved_cart_lines: cartHits.length, cart_rows: cartHits.slice(0, 25) }, "advisory"));

  // K. Retired SKUs are not listed and cannot be ordered.
  const rIssues = [];
  if(retired.length){
    const listed = retired.filter(r => products.some(p => norm(p.code) === (r.code_norm || norm(r.code))));
    listed.forEach(r => rIssues.push({ code: r.code, issue: "listed on Partner 360" }));
    const res = await d.PRICING.priceOrders({ orders: [{ manufacturer_slug: slug, items: retired.slice(0, 50).map(r => ({ code: r.code, qty: 1, unit: 1 })) }], dealerId: null, sb: d.sb,
      catalogFile: d.files.catalogFile, contentFile: d.files.contentFile, manufacturersFile: d.files.manufacturersFile });
    res.orders[0].items.filter(i => i.available !== false).forEach(i => rIssues.push({ code: i.code, issue: "priced as available" }));
  }
  add(check("retired_refused", "Retired / discontinued SKUs: not listed, refused by the server", !rIssues.length, rIssues.length ? rIssues : { retired: retired.map(r => r.code + " (" + r.status + ")") }));

  // L. Images load.
  const imgs = [...new Set(products.map(p => p.image).filter(Boolean))];
  const noImage = products.filter(p => !p.image).map(p => p.code);
  const broken = [], deadline = Date.now() + (d.imageBudgetMs || 7000); let checked = 0, incomplete = false;
  const abs = u => /^https?:/i.test(u) ? u : d.ORDERING_BASE + (u.startsWith("/") ? "" : "/") + u;
  const one = async u => { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
    try{ let r = await d.fetchImpl(abs(u), { method: "HEAD", signal: ctl.signal }); if(r.status === 405 || r.status === 403) r = await d.fetchImpl(abs(u), { method: "GET", headers: { range: "bytes=0-0" }, signal: ctl.signal });
      const ct = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
      if(!(r.ok || r.status === 206) || (ct && !/^image\//i.test(ct))) broken.push({ url: u, status: r.status, type: ct }); }
    catch(err){ broken.push({ url: u, error: String((err && err.name) || err) }); } finally{ clearTimeout(tm); checked++; } };
  for(let i = 0; i < imgs.length; i += 24){ if(Date.now() > deadline){ incomplete = true; break; } await Promise.all(imgs.slice(i, i + 24).map(one)); }
  add(check("images", "Every product image loads", !broken.length && !incomplete, broken.length || incomplete ? { broken: broken.slice(0, 50), checked, of: imgs.length, incomplete } : { images: imgs.length }));
  if(noImage.length) add(check("images_placeholder", "Products shown with the 'No image' placeholder", true, noImage.slice(0, 50), "advisory"));

  // M. Fingerprint — the same canonical lines Partner 360's own fingerprint uses.
  const lines = products.map(p => [p.code, p.base_price, p.msrp, p.map, JSON.stringify(p.tiers || null), p.uom || "", p.case_qty || "",
    [1, 2, 6, 11, 21].map(q => L.engine.unitPrice(p, q)).join("/"), cards[p.code], p.category || "", p.subcategory || "", p.image || ""].join("|")).sort();
  const fr = text(R.freightRowsHtml(L.engine.computeFreight(slug, products.slice(0, 3).map(p => ({ p, qty: 2 })))));
  const fpFull = sha(lines.join("\n") + "\nFR " + fr), fp = fpFull.slice(0, 16);
  if(d.baseline && d.baseline.fingerprint){
    const was = (d.baseline.checks || []).find(c => c.id === "fingerprint");
    const old = (was && was.detail && was.detail.lines) || [];
    const changed = lines.filter(l => old.indexOf(l) < 0), gone = old.filter(l => lines.indexOf(l) < 0);
    add(check("fingerprint", "Line fingerprint unchanged since baseline run #" + d.baseline.id, d.baseline.fingerprint === fp,
      { fingerprint: fp, baseline: d.baseline.fingerprint, products: lines.length, now: changed.slice(0, 20), was: gone.slice(0, 20), lines }));
  } else {
    add(check("fingerprint", "Line fingerprint (first run — becomes the baseline)", true, { fingerprint: fp, products: lines.length, lines }, "advisory"));
  }

  const failed = checks.filter(c => c.severity === "blocking" && !c.pass);
  return { manufacturer: slug, result: failed.length ? "fail" : "pass", failed: failed.map(c => c.id), fingerprint: fp, checks, ms: Date.now() - t0 };
}

module.exports = { COMMERCIAL_ACTIONS, OVERRIDE_COMMERCIAL_KEYS, isCommercialAction, lineOf, STAGE_FIELDS, planStage, verifyLine, text, expectedFreightWords, sha };
