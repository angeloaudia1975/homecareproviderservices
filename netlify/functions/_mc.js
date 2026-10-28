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
  "clear_override","set_group",
  /* Manufacturer Center Phase 6 line writes: they change a line's source register, its source facts,
     its approvals or its freight terms, so a frozen line refuses them exactly like a price change. */
  "mc_register_source","mc_accept_source","mc_import_source_rows","mc_approve_gate","mc_set_freight_terms"]);
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
const basisOf = b => (b === "each" || b === "order_unit") ? b : null;
const ladderKey = (t, bp) => (Array.isArray(t) ? t : []).map(x => ({ q: Math.round(Number(x.minQty != null ? x.minQty : x.min_qty)), p: m2(x.price), pool: x.pool || null }))
  .filter(x => !(x.q === 1 && bp != null && x.p === m2(bp))).sort((a, b) => a.q - b.q).map(x => x.q + ":" + x.p + (x.pool ? "@" + x.pool : "")).join(",");
function check(id, label, ok, detail, severity){ return { id, label, pass: !!ok, severity: severity || "blocking", detail: detail == null ? null : detail }; }

/* Expected freight words on the dealer confirmation (orders-api freightWords) and HCPS email (freightShort). */
function expectedFreightWords(fee, lines, money){
  if(fee > 0){ const f = (lines || []).find(r => r.status === "flat" && r.flatLabel); return { dealer: money(fee) + (f ? " " + f.flatLabel : ""), hcps: money(fee) + " " + (f ? f.flatLabel : "flat") }; }
  const f = (lines || []).find(r => r.status === "free" && r.freeLabel);
  const anyActual = (lines || []).some(r => r.status === "actual");
  /* Owner, 2026-10-27: actual freight is PENDING until HCPS records the manufacturer's confirmation (never $0 / free / final). */
  return { dealer: anyActual ? "pending — the actual freight from the manufacturer's confirmation is added after HCPS places the order" : (f ? f.freeLabel : "Free"),
    hcps: anyActual ? "PENDING — actual freight from the manufacturer's confirmation, after HCPS places the order" : ((lines || []).length ? (f ? f.freeLabel : "FREE") : "—") };
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
      ["case_qty", Number(p.case_qty) > 1 ? Number(p.case_qty) : 1, Number(r.case_qty) > 1 ? Number(r.case_qty) : 1],
      ["msrp_basis", basisOf(p.msrp_basis), basisOf(r.msrp_basis)], ["map_basis", basisOf(p.map_basis), basisOf(r.map_basis)]];
    for(const [f, a, b] of pairs){ if(f === "msrp" && b == null && r.msrp_auto !== false) continue; if(JSON.stringify(a) !== JSON.stringify(b)) drift.push({ code: p.code, field: f, storefront: a, record: b }); }
  }
  const unlisted = active.filter(r => !products.some(p => norm(p.code) === (r.code_norm || norm(r.code)))).map(r => r.code);
  if(authoritative){
    add(check("full_field_parity", "Storefront = record on price, MSRP, MAP, tiers, UOM, case qty and MSRP/MAP basis", !drift.length, drift.length ? drift.slice(0, 50) : { compared: products.length - noRecord.length }));
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
    /* MSRP / MAP basis (Phase 4): "each" on a pack exactly when the record says each — or, with no basis
       on the record, by the storefront's standing rule (MSRP each only for msrp_each rows, MAP each on a pack). */
    const rb = recBy[norm(p.code)] || {};
    const mapEach = !!pk && (basisOf(rb.map_basis) ? basisOf(rb.map_basis) === "each" : true);
    const msrpEach = !!pk && (basisOf(rb.msrp_basis) ? basisOf(rb.msrp_basis) === "each" : p.msrp_each === true);
    const mapv = (p.map != null && p.map !== "" && Number(p.map) > 0) ? Number(p.map) : null;
    if(mapv != null){ const want = "MAP " + R.money(mapv) + (mapEach ? " each" : ""), at = tx.indexOf(want);
      if(at < 0 || (!mapEach && tx.slice(at + want.length).startsWith(" each"))) cardIssues.push({ code: p.code, issue: "MAP wording", want, text: tx }); }
    const ms = tx.match(/MSRP \$[\d,]+\.\d{2}( each)?/);
    if(ms && !!ms[1] !== msrpEach) cardIssues.push({ code: p.code, issue: "MSRP basis wording", want: msrpEach ? "each" : "per order unit", text: tx });
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
  /* The EFFECTIVE freight rule (Phase 5): the record's freight_terms when valid, else the file's entry —
     exactly what lineProducts handed the engine, so every freight check tests what dealers get. */
  const groups = (L.freight || {}).groups || [];
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
    /* The storefront prices each line against the WHOLE cart (family and pooled tier breaks count
       every line), so the engine's cart holds exactly this cart while it prices it — as a dealer's would. */
    cart.clear(); c.forEach(([p, q]) => cart.set(slug + "::" + p.code, { p, qty: q }));
    const items = c.map(([p, q]) => ({ code: p.code, family: p.family == null ? undefined : p.family, qty: q, unit: Number(L.engine.unitPrice(p, q)) }));
    const eng = L.engine.computeFreight(slug, c.map(([p, q]) => ({ p, qty: q })));
    cart.clear();
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
  /* Freight terms as data (Phase 5). A line whose record carries freight_terms must have VALID terms in
     use; terms that fail validation are ignored (the file's rule stands), which is safe for dealers but
     is a fault to fix, so it fails the run. Where both exist, a difference between record and file is
     reported (the record wins). */
  const fileFreight = (freightCfg[slug] || {}).freight || null;
  const termsNoTrace = meta.freight_terms ? (() => { const t = JSON.parse(JSON.stringify(meta.freight_terms)); delete t.trace; return t; })() : null;
  const canon = v => v && typeof v === "object" ? (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v);
  if(meta.freight_terms != null){
    add(check("freight_source", "Freight comes from the record's freight_terms (valid, in use)", L.freightSource === "record" && !L.freightInvalid,
      { source: L.freightSource, invalid: !!L.freightInvalid, trace: meta.freight_terms.trace || null }));
    add(check("freight_record_vs_file", "Record freight terms vs manufacturers.json (the record is used)", true,
      { same: fileFreight ? canon(termsNoTrace) === canon(fileFreight) : null, file_has_rule: !!fileFreight }, "advisory"));
  } else {
    add(check("freight_source", "Freight from manufacturers.json (no record terms)", true, { source: L.freightSource }, "advisory"));
  }

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
    if((Number(o.freight_fee) > 0 || (o.freight_lines || []).some(r => r.status === "free" || r.status === "actual")) && dealerFreight !== want.dealer) eIssues.push({ email: "dealer", freight: dealerFreight, expected: want.dealer });
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

  /* N. Content fingerprint (Release D): what a dealer reads on each product — page, names, option, copy, features, specs,
     warranty, photos, documents — one short hash per product. Advisory until a baseline carries one; then it must hold.
     The price fingerprint above (M) is unchanged, so no line's Gold Standard fingerprint moves because this was added. */
  const contentLines = products.map(p => p.code + "|" + sha([p.name || "", p._encPage || "", p._pageKey || "", p._skuOption || "", p.description || "",
    JSON.stringify(p._features || null), JSON.stringify(p._specs || null), p._warranty || "", p.image || "",
    JSON.stringify((Array.isArray(p.media) ? p.media : []).filter(m => m && m.kind === "image").map(m => m.url)), JSON.stringify(p._documents || null)].join("\u0001")).slice(0, 12)).sort();
  const cfp = sha(contentLines.join("\n")).slice(0, 16);
  const wasC = d.baseline && (d.baseline.checks || []).find(c => c.id === "content_fingerprint");
  if(wasC && wasC.detail && wasC.detail.fingerprint && wasC.severity !== "advisory"){
    const old = wasC.detail.lines || [];
    add(check("content_fingerprint", "Content fingerprint unchanged since baseline run #" + d.baseline.id, wasC.detail.fingerprint === cfp,
      { fingerprint: cfp, baseline: wasC.detail.fingerprint, now: contentLines.filter(l => old.indexOf(l) < 0).slice(0, 20), was: old.filter(l => contentLines.indexOf(l) < 0).slice(0, 20), lines: contentLines }));
  } else {
    add(check("content_fingerprint", "Content fingerprint (pages, copy, photos, options) — the first run that carries it as a Gold Standard becomes its baseline",
      true, { fingerprint: cfp, products: contentLines.length, lines: contentLines, gold: !!d.contentGold }, d.contentGold ? "blocking" : "advisory"));
  }
  const failed = checks.filter(c => c.severity === "blocking" && !c.pass);
  return { manufacturer: slug, result: failed.length ? "fail" : "pass", failed: failed.map(c => c.id), fingerprint: fp, content_fingerprint: cfp, checks, ms: Date.now() - t0 };
}

/* ── 4. GUIDED WORKFLOW (Manufacturer Center Phase 6, approved 2026-10-10) ───────────────────────
   Pure helpers behind the guided screens. Source facts (price_imports, exactly as received) and HCPS
   interpretations (mfr_decisions) are kept apart here and only combined into a PROPOSED staging row —
   which still goes through stage_record_source's dry run and the first approval gate before anything is
   written. Nothing in this section writes. */
const canon = v => v && typeof v === "object" ? (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v === undefined ? null : v);
const planHash = obj => sha(canon(obj));
/* "2/CS" → 2, "4" → 4, "Case of 6" → 6; empty, "Each", "1" or anything unreadable → null (a decision is needed). */
function parseCaseQty(t){
  if(t == null) return null; if(typeof t === "number") return t > 1 && Number.isFinite(t) ? t : null;
  const m = String(t).match(/(\d+(?:\.\d+)?)/); if(!m) return null; const n = Number(m[1]);
  return n > 1 && Number.isFinite(n) ? n : null;
}
const DECIDING_KINDS = ["interpretation", "conflict", "exception"];
/* FIELD-SCOPED DECISIONS (Phase 6 correction, approved 2026-10-11). A decision changes only the product field
   it names in `field` — with that field's own partner, because the two always travel together: the order unit
   (uom + case_qty), the MSRP/MAP basis (msrp_basis + map_basis), and status (+ status_note). Any other key in
   hcps_value describes the DECISION, not the SKU: Bemis #11 (field fee_dropship, {"status":"HOLD"}) is a fee on
   hold, never a product status. A decision whose field is not a product field (a fee, freight, a deferral, an
   acceptance…) changes no SKU at all. A plain (non-object) hcps_value is the value of the named field itself. */
const FIELD_FAMILY = { base_price: ["base_price"], msrp: ["msrp"], map: ["map"], tiers: ["tiers"], msrp_auto: ["msrp_auto"],
  dealer_unit_cost: ["dealer_unit_cost"], uom: ["uom", "case_qty"], case_qty: ["uom", "case_qty"],
  msrp_basis: ["msrp_basis", "map_basis"], map_basis: ["msrp_basis", "map_basis"], status: ["status", "status_note"], status_note: ["status_note"] };
function decisionValues(d){
  const field = String((d && d.field) || "").trim(), fam = FIELD_FAMILY[field], hv = d && d.hcps_value;
  if(!fam || hv == null) return null;
  if(typeof hv !== "object" || Array.isArray(hv)) return { [field]: hv };
  const out = {}; fam.forEach(k => { if(Object.prototype.hasOwnProperty.call(hv, k)) out[k] = hv[k]; });
  return Object.keys(out).length ? out : null;
}
/* Which SKUs a line-wide decision covers. No applies_to (or "all") → every SKU. Wording about packs or cases
   ("packs", "items with a Master Case Qty", "case items"…) → only SKUs whose structured case quantity is > 1 —
   the facts decide, not the sentence. Anything else is not guessed at: the decision is listed as not applied. */
const PACK_WORDS = /\b(packs?|cases?|case[\s_-]*qty|master[\s_-]*case|multi[\s_-]*unit)\b/i;
function appliesTo(d){
  const hv = d && d.hcps_value, a = hv && typeof hv === "object" && !Array.isArray(hv) ? hv.applies_to : null;
  if(a == null || String(a).trim() === "" || /^(all|all items|all skus|every sku|line|the whole line)$/i.test(String(a).trim())) return "all";
  return PACK_WORDS.test(String(a)) ? "packs" : "unknown";
}
/* The HCPS interpretation that applies to one SKU: line-wide decisions first, then the SKU's own decisions,
   oldest to newest within each, so the SKU's latest word wins. `ctx` is { caseQty } — the SKU's structured case
   quantity (source, else record); a SKU decision on the order unit overrides it before pack-only rules are
   judged (Bemis 7YE82350TC Each/1 and 444DISPLAY Display/1 are not packs). A boolean is still accepted. */
function interpretationFor(code, decisions, normCode, ctx){
  const sku = {}, line = {}, skuIds = [], lineIds = [], unapplied = [];
  const mine = (decisions || []).filter(d => DECIDING_KINDS.indexOf(d.kind) >= 0 && decisionValues(d))
    .slice().sort((a, b) => String(a.decided_at || "").localeCompare(String(b.decided_at || "")) || (a.id || 0) - (b.id || 0));
  const lineWide = d => d.code == null || d.code === "";
  for(const d of mine) if(!lineWide(d) && normCode(d.code) === normCode(code)){ Object.assign(sku, decisionValues(d)); skuIds.push(d.id); }
  const given = typeof ctx === "boolean" ? null : (ctx && ctx.caseQty != null && ctx.caseQty !== "" ? Number(ctx.caseQty) : null);
  const isPack = sku.case_qty != null ? Number(sku.case_qty) > 1 : (typeof ctx === "boolean" ? ctx : (given != null && given > 1));
  for(const d of mine){
    if(!lineWide(d)) continue;
    const ap = appliesTo(d);
    if(ap === "unknown"){ unapplied.push({ id: d.id, field: d.field, applies_to: d.hcps_value.applies_to }); continue; }
    if(ap === "packs" && !isPack) continue;
    Object.assign(line, decisionValues(d)); lineIds.push(d.id);
  }
  return { values: Object.assign({}, line, sku), decision_ids: lineIds.concat(skuIds), unapplied };
}
const COMPARE = ["base_price", "msrp", "map", "uom", "case_qty", "dealer_unit_cost", "msrp_basis", "map_basis", "status"];
const LEGACY_NO_ROWS = "Accepted legacy source — row-level source data not stored; Match comparison unavailable.";
function matchLine({ sourceRows, records, storefrontCodes, decisions, normCode, source }){
  const S = {}, Rm = {}; (sourceRows || []).forEach(r => { S[normCode(r.code)] = r; }); (records || []).forEach(r => { Rm[r.code_norm || normCode(r.code)] = r; });
  const shop = new Set((storefrontCodes || []).map(c => normCode(c)));
  const recordView = r => Object.fromEntries(COMPARE.concat(["tiers", "source_id", "source_file"]).map(f => [f, r[f] == null ? null : r[f]]));
  /* An accepted LEGACY source registered without row-level price_imports cannot be compared row by row. That is
     information, not a conflict: no SKU is "not in source" and nothing needs a decision because of it. */
  if(source && source.legacy === true && !(sourceRows || []).length){
    const rows = Object.keys(Rm).sort().map(k => { const r = Rm[k], active = (r.status || "active") === "active";
      return { code: r.code, status: active ? "not_compared" : "retired", on_storefront: shop.has(k), source: null, hcps: {}, decision_ids: [], record: recordView(r), diffs: [], needs_decision: [] }; });
    const n = st => rows.filter(x => x.status === st).length;
    return { rows, stage_rows: [], blocked: [], unapplied: [], comparison: { available: false, reason: "legacy_rows_not_stored", message: LEGACY_NO_ROWS },
      summary: { source_rows: 0, records: (records || []).length, new: 0, same: 0, changes: 0, not_in_source: 0, retired: n("retired"), not_compared: n("not_compared"),
        needs_decision: 0, ready_to_stage: 0, proposed_changes: 0, comparison: "unavailable" } };
  }
  const keys = [...new Set([...Object.keys(S), ...Object.keys(Rm)])].sort();
  const norm1 = (f, v) => (v == null || v === "") ? null : (["base_price", "msrp", "map", "dealer_unit_cost"].indexOf(f) >= 0 ? m2(v) : f === "case_qty" ? (Number(v) > 1 ? Number(v) : 1) : String(v));
  const rows = [], stage_rows = [], blocked = [], unapplied = {};
  for(const k of keys){
    const s = S[k], r = Rm[k], code = (s && s.code) || (r && r.code);
    const caseQty = s ? (s.parsed_case_qty != null ? Number(s.parsed_case_qty) : parseCaseQty(s.raw && (s.raw["Master Case Qty"] != null ? s.raw["Master Case Qty"] : s.raw.case_qty))) : null;
    const interp = interpretationFor(code, decisions, normCode, { caseQty: caseQty != null ? caseQty : (r && r.case_qty != null ? Number(r.case_qty) : null) });
    interp.unapplied.forEach(u => { unapplied[u.id] = u; });
    const facts = s ? { base_price: m2(s.base_price), msrp: m2(s.msrp), map: m2(s.map), case_qty: caseQty, dealer_unit_cost: s.parsed_unit_cost != null ? m2(s.parsed_unit_cost) : null,
      tiers: Array.isArray(s.tiers) && s.tiers.length ? s.tiers : null, description: s.description || null, raw: s.raw || null } : null;
    const needs = [];
    let proposed = null;
    if(s){
      proposed = { code };
      for(const f of ["base_price", "msrp", "map", "tiers", "case_qty", "dealer_unit_cost"]) if(facts[f] != null) proposed[f] = facts[f];
      Object.assign(proposed, interp.values);
      /* The order unit is needed only when neither the source/decisions nor the existing record supply it —
         staging keeps a field the row leaves out, so a record that already names its unit keeps it. */
      const recUom = r && r.uom ? r.uom : null;
      if(proposed.case_qty == null && proposed.uom == null && !recUom) needs.push({ field: "uom", why: "The source gives no case or pack quantity: record what one order unit is (e.g. uom Each, case_qty 1)." });
      else if(Number(proposed.case_qty) > 1 && !proposed.uom && !recUom) needs.push({ field: "uom", why: "The source gives a pack of " + proposed.case_qty + " but does not name the order unit (e.g. Case)." });
      if(!(Number(proposed.base_price) > 0)) needs.push({ field: "base_price", why: "No dealer price in the source." });
    } else if(r && (r.status || "active") === "active"){
      const said = interpretationFor(code, decisions, normCode, { caseQty: r.case_qty }).values;
      if(said.status == null) needs.push({ field: "status", why: "On the master record but not in this source: decide whether it stays active or is retired." });
    }
    const diffs = (s && r) ? COMPARE.filter(f => f in proposed && norm1(f, proposed[f]) !== norm1(f, r[f])).map(f => ({ field: f, record: r[f] == null ? null : r[f], proposed: proposed[f] })) : [];
    const status = s && !r ? "new" : (!s && r ? ((r.status || "active") === "active" ? "not_in_source" : "retired") : (diffs.length ? "changes" : "same"));
    const row = { code, status, on_storefront: shop.has(k), source: facts, hcps: interp.values, decision_ids: interp.decision_ids,
      record: r ? recordView(r) : null, diffs, needs_decision: needs };
    rows.push(row);
    if(s && !needs.length) stage_rows.push(proposed); else if(needs.length) blocked.push({ code, needs });
  }
  const count = st => rows.filter(x => x.status === st).length;
  return { rows, stage_rows, blocked, unapplied: Object.values(unapplied), comparison: { available: true },
    summary: { source_rows: (sourceRows || []).length, records: (records || []).length, new: count("new"), same: count("same"), changes: count("changes"),
      not_in_source: count("not_in_source"), retired: count("retired"), not_compared: 0, needs_decision: rows.filter(x => x.needs_decision.length).length, ready_to_stage: stage_rows.length,
      proposed_changes: count("new") + count("changes"), comparison: "available" } };
}
/* GATE 1 / GATE 2. An approval is an mfr_decisions row of kind "acceptance", field "gate:stage" or
   "gate:activate", recorded only through mc_approve_gate, single-use (used_at), for the same line, and
   bound to exactly what the president looked at: the dry-run plan's hash (gate 1) or a passing pre-activation
   verification run that is newer than every record change (gate 2). */
function gateProblem(d, { manufacturer, gate, want }){
  if(!d) return "no such approval";
  if(d.kind !== "acceptance" || d.field !== "gate:" + gate) return "decision " + d.id + " is not a gate:" + gate + " approval";
  if(d.manufacturer !== manufacturer) return "approval " + d.id + " belongs to " + d.manufacturer;
  if(d.used_at) return "approval " + d.id + " was already used " + String(d.used_at).slice(0, 16);
  const hv = d.hcps_value || {};
  for(const [k, v] of Object.entries(want || {})) if(canon(hv[k]) !== canon(v)) return "approval " + d.id + " was given for a different " + k.replace(/_/g, " ") + " — run the dry run again and approve what it shows";
  return null;
}
function activationRunProblem(run, { manufacturer, lastRecordChange }){
  if(!run) return "no such verification run";
  if(run.manufacturer !== manufacturer) return "run " + run.id + " belongs to " + run.manufacturer;
  if(run.phase !== "pre") return "run " + run.id + " is a " + run.phase + " run; activation needs a pre-activation run";
  if(run.result !== "pass") return "run " + run.id + " did not pass";
  if(lastRecordChange && String(lastRecordChange) > String(run.run_at)) return "the master record changed after run " + run.id + " (" + String(lastRecordChange).slice(0, 16) + ") — verify again";
  return null;
}
/* Freight at every threshold for a given rule — the preview the Commercial & freight screen shows before
   and after a freight-terms change (same carts and words as mc_verify's freight check). */
function freightPreview(engine, R, slug, freight){
  const rows = [], groups = (freight && Array.isArray(freight.groups)) ? freight.groups : [];
  for(const g of groups){
    const T = g.freeAt != null && Number(g.freeAt) > 0 ? Number(g.freeAt) : (g.flatBelow != null && Number(g.flatBelow) > 0 ? Number(g.flatBelow) : null);
    const cat = Array.isArray(g.categories) && g.categories.length ? g.categories[0] : "";
    const brand = Array.isArray(g.brandKeywords) && g.brandKeywords.length && g.brandKeywords[0] !== "*" ? g.brandKeywords[0] : "x";
    for(const v of (T ? [T - 0.01, T, T + 0.01] : [100])){
      const f = engine.computeFreight(slug, [{ p: { base_price: Math.round(v * 100) / 100, brand, category: cat }, qty: 1 }]);
      rows.push({ group: g.label, amount: Math.round(v * 100) / 100, fee: f.fee, words: text(R.freightRowsHtml(f)) });
    }
  }
  if(!groups.length && freight && freight.elseActual) rows.push({ group: freight.otherLabel || "All items", amount: null, fee: 0, words: "actual freight" + (freight.actualNote ? " — " + freight.actualNote : "") });
  return rows;
}
/* Two verification runs, check by check, compared on their VALUES (keys sorted: runs are stored as jsonb,
   which reorders keys) — never on raw JSON text. */
function compareRuns(a, b){
  const by = r => Object.fromEntries((r.checks || []).map(c => [c.id, c]));
  const A = by(a), B = by(b), ids = [...new Set([...Object.keys(A), ...Object.keys(B)])];
  const linesOf = r => (((r.checks || []).find(c => c.id === "fingerprint") || {}).detail || {}).lines || [];
  const la = linesOf(a), lb = linesOf(b);
  return { a: a.id, b: b.id, fingerprint_same: a.fingerprint === b.fingerprint,
    checks: ids.map(id => ({ id, label: (B[id] || A[id]).label, in_a: !!A[id], in_b: !!B[id], pass_a: A[id] ? A[id].pass : null, pass_b: B[id] ? B[id].pass : null,
      same_detail: !!(A[id] && B[id]) && canon(A[id].detail) === canon(B[id].detail) })),
    lines_only_in_a: la.filter(l => lb.indexOf(l) < 0).slice(0, 50), lines_only_in_b: lb.filter(l => la.indexOf(l) < 0).slice(0, 50) };
}

/* ── 5. THE CONTENT FREEZE (Release A, approved by Angelo 2026-10-11) ─────────────────────────────
   A frozen line protects everything a dealer sees, not only its prices: product pages and their
   grouping, content, images and media, product links, related products, catalog-layer names /
   categories / images, the line's logo, visibility, listing mode and categories, and publish / hidden
   state. The database refuses those writes itself (supabase/mc_release_a_content_freeze.sql,
   mfr_content_guard); these rules refuse them first, with a plain message, in catalog-api,
   product-content and images-api. Two explicit, recorded ways through, both mfr_decisions rows:
     · a regression_fix of that line — any change, single use (spent when the request succeeds);
     · the line's OPEN enrichment_window — hidden draft pages only (product-content, never a visible
       page, never publishing, never the catalog layer, media, links, related or line settings).
   Nothing commercial is reachable through a window: prices stay behind Phase 2's guard. */
const CONTENT_ACTIONS = new Set(["save_override","set_category","set_category_map","set_category_order","clear_derived_categories",
  "set_listing_mode","add_media","update_media","delete_media","reorder_media","save_link","clear_link","save_logo","clear_logo"]);
const MEDIA_ID_ACTIONS = new Set(["update_media","delete_media","reorder_media"]);   // name a media row, not a line
function isFrozenProtected(b){ return isCommercialAction(b) || !!(b && CONTENT_ACTIONS.has(b.action)); }
const VISIBLE_STATUSES = ["published","active","discontinued"];          // the storefront's read rule (with disabled = false)
const isVisibleStatus = s => VISIBLE_STATUSES.indexOf(String(s == null ? "" : s)) >= 0;
/* product-content.js: every action that writes. */
const PC_WRITE_ACTIONS = new Set(["approve","reject","approve_all","upsert","ingest_source","upload_image","upload_file","rehost",
  "set_status","set_meta","set_content","save_fields","set_sku","save_skus","remove_skus","rename_sku","move_skus","split",
  "merge_products","delete_product","create_product","save_sizing","bulk","recategorize","undo","save_related",
  "enrich_page","enrich_images","enrich_resolve","enrich_set_image"]);
/* …and the ones an enrichment window may carry: they work on one line's pages and its captured sources.
   The database still decides row by row that each page stays hidden before and after. Not here:
   recategorize (moves pages across every line) and save_related (shown on live pages at once). */
const PC_WINDOW_ACTIONS = new Set(["approve","reject","approve_all","upsert","ingest_source","upload_image","upload_file","rehost",
  "set_status","set_meta","set_content","save_fields","set_sku","save_skus","remove_skus","rename_sku","move_skus","split",
  "merge_products","delete_product","create_product","save_sizing","bulk","undo",
  "enrich_page","enrich_images","enrich_resolve","enrich_set_image"]);   // Release B: Product Enrichment writes hidden drafts only
/* images-api.js: the actions that write (migrate_legacy only when applied). */
function isImageWrite(b){ return !!b && (b.action === "upload" || b.action === "clear" || (b.action === "migrate_legacy" && b.apply === true)); }
/* Why a product-content request falls outside an enrichment window (null = inside it). */
function windowProblem(b){
  const a = b && b.action;
  if(!PC_WINDOW_ACTIONS.has(a)) return a + " changes what dealers see right away; an enrichment window covers hidden draft pages only";
  const publishing = "making a page visible to dealers needs Approve & Publish Manufacturer, not an enrichment window";
  if(a === "set_status" && isVisibleStatus(b.status)) return publishing;
  if(a === "bulk" && b.patch && isVisibleStatus(b.patch.status)) return publishing;
  if(a === "upsert"){ const rows = Array.isArray(b.rows) ? b.rows : [b.row]; if(rows.some(r => r && isVisibleStatus(r.status))) return publishing; }
  return null;
}
/* Is decision d a usable exception of this kind for this line? (null = yes) */
function exceptionProblem(d, kind, slug){
  if(!d) return "no such decision";
  if(d.kind !== kind) return "decision " + d.id + " is a " + d.kind + ", not a " + kind;
  if(d.manufacturer !== slug) return "decision " + d.id + " belongs to " + d.manufacturer + ", not " + slug;
  if(d.used_at != null) return kind === "enrichment_window" ? "the enrichment window " + d.id + " is closed" : "decision " + d.id + " is already used";
  return null;
}
/* (Angelo 2026-10-12) The line's CURRENT Gold Standard: its newest passing baseline / post run with a fingerprint — the
   same run finalize and every regression check compare against. Runs after it (a failed or rolled-back attempt) are
   history: they never make the line read as failing while a newer finalized Gold Standard PASS stands. */
function goldStandardOf(runs){
  const list = (runs || []).filter(Boolean).slice().sort((a, b) => String(b.run_at || "").localeCompare(String(a.run_at || "")) || (Number(b.id) || 0) - (Number(a.id) || 0));
  const g = list.find(r => r.result === "pass" && (r.phase === "baseline" || r.phase === "post") && r.fingerprint);
  if(!g) return null;
  const later = list.filter(r => r !== g && (String(r.run_at || "") > String(g.run_at || "") || (String(r.run_at || "") === String(g.run_at || "") && Number(r.id) > Number(g.id))));
  return { id: g.id, phase: g.phase, result: "pass", fingerprint: g.fingerprint, run_at: g.run_at,
    later_runs: later.length, later_failed: later.filter(r => r.result !== "pass").length,
    latest_attempt: later[0] ? { id: later[0].id, phase: later[0].phase, result: later[0].result, run_at: later[0].run_at } : null };
}
/* (Angelo 2026-10-12) A regression_fix scoped to one published-page correction (hcps_value.scope "content_correction")
   opens nothing else: it is carried out only by product-content's correction actions, never as a general pass. */
function scopedFixProblem(d){
  const v = d && d.hcps_value;
  if(v && v.scope === "content_correction") return "regression_fix " + d.id + " is scoped to correcting " + (v.page_key || "one page") + " (" + (Array.isArray(v.areas) ? v.areas.join(", ") : "") +
    ") through Manufacturer Center's published-page correction; it cannot authorise any other change";
  return null;
}
/* THE ONE GATE for product-content and images-api (catalog-api has freezeGate, same rules).
   read(path) returns rows and throws when it can't read — a freeze state that can't be read refuses.
   Returns { refusal:{status, body} } or { headers, regression, window } to send with the writes. */
async function contentGate({ body, lines, read, windowRule }){
  const L = [...new Set((lines || []).map(s => String(s || "").trim()).filter(Boolean))];
  const open = { headers: {}, regression: null, window: null };
  if(!L.length) return open;                                         // unattributed: the database guard still applies
  let rows;
  try{ rows = await read("manufacturer_meta?slug=in.(" + L.map(s => encodeURIComponent(s)).join(",") + ")&select=slug,frozen"); }
  catch(e){ return { refusal: { status: 503, body: { ok: false, error: "freeze_state_unreadable",
    message: "Whether " + L.join(", ") + " is frozen could not be read, so nothing was changed: " + String((e && e.message) || e).slice(0, 200) } } }; }
  const frozen = L.filter(s => (rows || []).some(r => r && r.slug === s && r.frozen === true));
  const rf = body && body.regression_fix, ew = body && body.enrichment_window;
  const readDecision = async id => { const r = await read("mfr_decisions?id=eq." + id + "&select=id,manufacturer,kind,used_at,hcps_value"); return r && r[0]; };
  /* Release B: a window presented with a request must be that line's own open window, whatever the line — it is
     never carried to another line (frozen or not), never across several lines, and never to images-api. */
  if(ew && !rf){
    if(!windowRule) return { refusal: { status: 423, body: { ok: false, error: "outside_enrichment_window", manufacturer: L[0],
      message: "An enrichment window covers hidden draft pages in Product Enrichment only; it never opens catalog-layer images. Nothing was changed." } } };
    if(L.length > 1) return { refusal: { status: 423, body: { ok: false, error: "enrichment_window_invalid", manufacturer: L[0],
      message: "An enrichment window covers one line; this change spans " + L.join(", ") + ". Nothing was changed." } } };
    if(!frozen.length){
      const id = parseInt(typeof ew === "object" ? ew.decision_id : ew, 10);
      if(!(id > 0)) return { refusal: { status: 400, body: { ok: false, error: "enrichment_window_incomplete", message: "An enrichment window needs its decision_id. Nothing was changed." } } };
      let d; try{ d = await readDecision(id); } catch(e){ return { refusal: { status: 503, body: { ok: false, error: "decision_unreadable", message: "The enrichment window could not be read. Nothing was changed." } } }; }
      const p = exceptionProblem(d, "enrichment_window", L[0]);
      if(p) return { refusal: { status: 423, body: { ok: false, error: "enrichment_window_invalid", manufacturer: L[0], message: p + ". Nothing was changed." } } };
      return open;                                                   // an unfrozen line needs no window; it grants nothing there
    }
  }
  if(!frozen.length) return open;
  const slug = frozen[0];
  if(L.length > 1) return { refusal: { status: 423, body: { ok: false, error: "line_frozen", manufacturer: slug,
    message: "This change spans several lines and " + frozen.join(", ") + (frozen.length > 1 ? " are" : " is") + " frozen (Gold Standard). Change one line at a time. Nothing was changed." } } };
  if(rf){
    const id = parseInt(rf.decision_id, 10), reason = String(rf.reason || "").trim();
    if(!(id > 0) || !reason) return { refusal: { status: 400, body: { ok: false, error: "regression_fix_incomplete", message: "A regression fix needs decision_id and a reason. Nothing was changed." } } };
    let d; try{ d = await readDecision(id); } catch(e){ return { refusal: { status: 503, body: { ok: false, error: "decision_unreadable", message: "The regression_fix decision could not be read. Nothing was changed." } } }; }
    const p = exceptionProblem(d, "regression_fix", slug) || scopedFixProblem(d);
    if(p) return { refusal: { status: 423, body: { ok: false, error: "regression_fix_invalid", manufacturer: slug, message: p + ". Nothing was changed." } } };
    return { headers: { "x-hcps-regression-fix": String(id) }, regression: { id, manufacturer: slug, reason }, window: null };
  }
  if(ew && windowRule){
    const id = parseInt(typeof ew === "object" ? ew.decision_id : ew, 10);
    if(!(id > 0)) return { refusal: { status: 400, body: { ok: false, error: "enrichment_window_incomplete", message: "An enrichment window needs its decision_id. Nothing was changed." } } };
    let d; try{ d = await readDecision(id); } catch(e){ return { refusal: { status: 503, body: { ok: false, error: "decision_unreadable", message: "The enrichment window could not be read. Nothing was changed." } } }; }
    const p = exceptionProblem(d, "enrichment_window", slug);
    if(p) return { refusal: { status: 423, body: { ok: false, error: "enrichment_window_invalid", manufacturer: slug, message: p + ". Nothing was changed." } } };
    const w = windowRule(body);
    if(w) return { refusal: { status: 423, body: { ok: false, error: "outside_enrichment_window", manufacturer: slug, message: w + ". Nothing was changed." } } };
    return { headers: { "x-hcps-enrichment-window": String(id) }, regression: null, window: { id, manufacturer: slug } };
  }
  return { refusal: { status: 423, body: { ok: false, error: "line_frozen", manufacturer: slug, message:
    slug + " is frozen (Gold Standard). Its product pages, images, links, categories and publish state are protected like its prices. Nothing was changed. " +
    "A correction needs a regression_fix decision in Manufacturer Center" + (windowRule ? "; enriching hidden draft pages needs the line's open enrichment window." : ".") } } };
}

/* RELEASE B, GATE 1 — draft media. Under an enrichment window every image on a draft page is a copy in HCPS storage
   filed under that window: product-content/<line>/drafts/w<window>/<page>/... (the database refuses anything else:
   supabase/mc_release_b_draft_media.sql, mfr_draft_media_problem). These mirror that rule for the functions. */
const DRAFT_MEDIA_BUCKET = "product-content";
function draftMediaPrefix(slug, winId){ return String(slug) + "/drafts/w" + String(parseInt(winId, 10)) + "/"; }
function isDraftMediaUrl(url, slug, winId){
  const esc = String(slug).replace(/[^a-z0-9]/g, c => "\\" + c);
  return new RegExp("^https://[a-z0-9]+\\.supabase\\.co/storage/v1/object/public/" + DRAFT_MEDIA_BUCKET + "/" + esc + "/drafts/w" + parseInt(winId, 10) + "/[^?#\\s]+$").test(String(url || ""));
}
/* Every link-like string in the image-bearing fields of a page row (image, images_gallery, skus, options) — what the guard inspects. */
function rowMediaUrls(row){
  const out = [], walk = v => { if(typeof v === "string"){ if(/^\s*(https?:|\/\/|\/)/i.test(v)) out.push(v); } else if(Array.isArray(v)) v.forEach(walk); else if(v && typeof v === "object") Object.keys(v).forEach(k => walk(v[k])); };
  ["image", "images_gallery", "skus", "options"].forEach(k => walk(row && row[k])); return out;
}

module.exports = { COMMERCIAL_ACTIONS, OVERRIDE_COMMERCIAL_KEYS, isCommercialAction, lineOf, STAGE_FIELDS, planStage, verifyLine, text, expectedFreightWords, sha,
  canon, planHash, parseCaseQty, decisionValues, appliesTo, interpretationFor, matchLine, gateProblem, activationRunProblem, freightPreview, compareRuns,
  CONTENT_ACTIONS, MEDIA_ID_ACTIONS, isFrozenProtected, VISIBLE_STATUSES, isVisibleStatus, PC_WRITE_ACTIONS, PC_WINDOW_ACTIONS, isImageWrite,
  windowProblem, exceptionProblem, scopedFixProblem, goldStandardOf, contentGate, DRAFT_MEDIA_BUCKET, draftMediaPrefix, isDraftMediaUrl, rowMediaUrls };
