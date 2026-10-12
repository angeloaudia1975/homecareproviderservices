/* MANUFACTURER CENTER RELEASE C — DEALER PREVIEW (approved 2026-10-11). Pure; read-only; staff-only.

   "What would a dealer see if the approved enrichment were published?" The answer is computed by the storefront's OWN
   code, never by a second rule: product-content.js runs Partner 360's catalog merge (_pricing.js lineProducts →
   _shop_engine.js, verbatim) twice — TODAY with the pages that are live, and PROPOSED with the line's Ready drafts
   treated as published in memory — and this module turns the two product lists into dealer cards with the storefront's
   picker (_shop_picker.js) and price words (_shop_render.js), then proves the accounting:

     · every ACTIVE commercial SKU is on exactly one card, today and proposed (none missing, none twice);
     · a held-back page's SKUs keep exactly the product they have today (their current catalog card) — byte for byte;
     · nothing commercial moves: price, MSRP, MAP, tiers, UOM / case qty, MSRP/MAP basis, unit price at 1/2/6/11/21,
       the price words and the freight are identical today and proposed, and equal to the record;
     · retired SKUs stay off both;
     · each Ready page is one card whose options are exactly its SKUs, each a distinct choice;
     · no held draft's words or photos reach the proposed dealer view, and today's dealer view carries no draft photo.

   Nothing is written, published or copied. A held item's staff note is returned for the staff screen only; it is never
   part of a product a dealer would receive. */

const HELD_NOTE = "Using current catalog content — enrichment held for source review";
const COMMERCIAL_FIELDS = ["base_price", "msrp", "map", "tiers", "uom", "case_qty", "msrp_basis", "map_basis", "msrp_each", "price_note", "group", "family"];
const LADDER = [1, 2, 6, 11, 21];
const upper = c => String(c == null ? "" : c).trim().toUpperCase();
const norm = c => upper(c).replace(/[^A-Z0-9]/g, "");
const text = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const canon = v => v && typeof v === "object" ? (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v === undefined ? null : v);
const DRAFT_MEDIA = /\/drafts\/w\d+\//;

/* The rows the shop would read if the Ready drafts were published: today's live pages plus each Ready draft with a
   published status — in memory only. A Ready draft never takes a page key a live page already has. */
function proposedContentRows(liveRows, drafts, readyKeys){
  const live = Array.isArray(liveRows) ? liveRows : [];
  const have = new Set(live.map(r => r && r.page_key));
  const add = (drafts || []).filter(r => r && readyKeys.has(r.page_key) && !have.has(r.page_key))
    .map(r => { const x = Object.assign({}, r, { status: "published", disabled: false }); delete x.enrichment_flags; return x; });
  return live.concat(add);
}

/* The cart line the storefront prints for one product at qty 1 (renderCart's words). */
function cartLine(p, R, engine, PICK){
  const u = Number(engine.unitPrice(p, 1)) || 0, pk = R.packOf(p);
  return {
    title: String(p.name || ""),
    sub: String(p.code) + (p._skuOption ? " · " + PICK.variantLabel(p) : "") + (p.brand ? " · " + p.brand : ""),
    money: (pk ? `1 × ${pk.label} = ${pk.n} each · ` : "") + "Unit " + (u ? R.money(u) : "—") + (pk ? " per " + pk.label : "") + " · Line " + (u ? R.money(u) : "—")
  };
}

/* Dealer cards, exactly as the storefront groups them (groupKeyOf: the page, else the catalog group, else the code). */
function cardsOf(products, ctx){
  const { R, PICK, engine, heldCodes } = ctx;
  /* The storefront's catalog photos are paths on the storefront ("/assets/products/bemis/…"): shown here they must be
     read from the storefront, exactly where a dealer's browser reads them (display only — the proofs use the raw data). */
  const abs = u => !u ? "" : (/^https?:/i.test(u) ? String(u) : String(ctx.base || "").replace(/\/+$/, "") + (String(u).startsWith("/") ? "" : "/") + u);
  const groups = new Map();
  (products || []).forEach(p => { const k = PICK.groupKeyOf(p); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
  return [...groups].map(([key, list]) => {
    const G = PICK.sortVariants(list.slice()), lead = G[0];
    const media = [...new Set([lead.image].concat((lead.media || []).filter(m => m && m.kind === "image").map(m => m.url)).filter(Boolean).map(abs))];
    const held = !lead._pageKey && G.some(p => heldCodes.has(norm(p.code)));
    return {
      key: String(key), name: PICK.groupDisplayName(lead), page_key: lead._pageKey || null, enriched: !!lead._pageKey,
      staff_note: held ? HELD_NOTE : null,
      image: abs(lead.image), media,
      description: String(lead.description || ""), features: Array.isArray(lead._features) ? lead._features : [],
      specs: Array.isArray(lead._specs) ? lead._specs : [], warranty: lead._warranty || null,
      documents: Array.isArray(lead._documents) ? lead._documents : [], category: lead.category || "", subcategory: lead.subcategory || "",
      codes: G.map(p => String(p.code)),
      axes: G.length > 1 ? PICK.optionAxes(G) : null,
      options: G.map(p => ({ code: String(p.code), label: G.length > 1 ? PICK.variantLabel(p) : "", image: abs(p.image),
        price_html: R.priceHtml(p), price_text: text(R.priceHtml(p)), uom: p.uom || "", case_qty: Number(p.case_qty) > 1 ? Number(p.case_qty) : 1,
        orderable: !p._discontinued, cart: cartLine(p, R, engine, PICK) }))
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/* input: { slug, records (product_skus rows), meta {enriched_only}, plan pages [{page_key,name,status,skus:[{code}]}],
            drafts (product_content draft rows of the line), today {products, engine}, proposed {products, engine}, R, PICK } */
function buildPreview(input){
  const { slug, records, meta, R, PICK } = input;
  const pages = input.pages || [], drafts = input.drafts || [];
  const T = input.today, P = input.proposed;
  const active = (records || []).filter(r => (r.status || "active") === "active");
  const retired = (records || []).filter(r => (r.status || "active") !== "active");
  /* a page already published by Release D counts with the Ready ones (its SKUs are on their enriched card) */
  const ready = pages.filter(p => p.status === "ready" || p.status === "published"), held = pages.filter(p => p.status !== "ready" && p.status !== "published");
  const readyCodes = new Set(ready.flatMap(p => p.skus.map(s => norm(s.code))));
  const heldCodes = new Set(held.flatMap(p => p.skus.map(s => norm(s.code))));
  const pageOf = c => pages.find(p => p.skus.some(s => norm(s.code) === norm(c))) || null;
  const todayCards = cardsOf(T.products, { R, PICK, engine: T.engine, heldCodes: new Set(), base: input.base });
  const propCards = cardsOf(P.products, { R, PICK, engine: P.engine, heldCodes, base: input.base });
  const byCode = list => { const m = {}; (list || []).forEach(p => { (m[norm(p.code)] = m[norm(p.code)] || []).push(p); }); return m; };
  const tBy = byCode(T.products), pBy = byCode(P.products);
  const cardsWith = (cards, c) => cards.filter(k => k.codes.some(x => norm(x) === norm(c)));
  /* _unlinked is the merge's own bookkeeping ("no page claims this SKU"): set only when the line has pages to look in,
     and never read by the storefront (public/index.html sets it and nothing else touches it) — so it is not compared. */
  const NOT_DEALER_FACING = new Set(["_unlinked"]);
  const strip = p => { const o = {}; Object.keys(p || {}).sort().forEach(k => { if(typeof p[k] !== "function" && !NOT_DEALER_FACING.has(k)) o[k] = p[k]; }); return o; };
  const ladder = (e, p) => LADDER.map(q => Math.round(Number(e.unitPrice(p, q)) * 100) / 100).join("/");
  const m2 = v => v == null || v === "" ? null : Math.round(Number(v) * 100) / 100;

  const checks = [], add = (id, label, pass, detail) => checks.push({ id, label, pass: !!pass, detail: detail == null ? null : detail });
  const skus = [], missing = [], dupes = [], commercial = [], heldChanged = [];
  for(const r of active){
    const c = r.code, pg = pageOf(c), tc = cardsWith(todayCards, c), pc = cardsWith(propCards, c);
    const tp = (tBy[norm(c)] || [])[0] || null, pp = (pBy[norm(c)] || [])[0] || null;
    if(!pc.length || !pp) missing.push(c);
    if(pc.length > 1 || (pBy[norm(c)] || []).length > 1 || tc.length > 1) dupes.push(c);
    const diffs = [];
    if(tp && pp){
      COMMERCIAL_FIELDS.forEach(f => { if(canon(tp[f]) !== canon(pp[f])) diffs.push({ field: f, today: tp[f] == null ? null : tp[f], proposed: pp[f] == null ? null : pp[f] }); });
      if(ladder(T.engine, tp) !== ladder(P.engine, pp)) diffs.push({ field: "unit_price_1_2_6_11_21", today: ladder(T.engine, tp), proposed: ladder(P.engine, pp) });
      if(text(R.priceHtml(tp)) !== text(R.priceHtml(pp))) diffs.push({ field: "price_words", today: text(R.priceHtml(tp)), proposed: text(R.priceHtml(pp)) });
      /* and the proposed product against the master record itself */
      [["base_price", m2(pp.base_price), m2(r.base_price)], ["map", m2(pp.map), m2(r.map)], ["uom", pp.uom ? String(pp.uom) : null, r.uom ? String(r.uom) : null],
       ["case_qty", Number(pp.case_qty) > 1 ? Number(pp.case_qty) : 1, Number(r.case_qty) > 1 ? Number(r.case_qty) : 1]]
        .forEach(([f, a, b]) => { if(JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: f + "_vs_record", proposed: a, record: b }); });
      if(!(r.msrp == null && r.msrp_auto !== false) && m2(pp.msrp) !== m2(r.msrp)) diffs.push({ field: "msrp_vs_record", proposed: m2(pp.msrp), record: m2(r.msrp) });
    }
    if(diffs.length) commercial.push({ code: c, diffs });
    const isHeld = heldCodes.has(norm(c)), isReady = readyCodes.has(norm(c));
    if(!isReady && tp && pp && canon(strip(tp)) !== canon(strip(pp))){
      const a = strip(tp), z = strip(pp); heldChanged.push({ code: c, fields: [...new Set(Object.keys(a).concat(Object.keys(z)))].filter(k => canon(a[k]) !== canon(z[k])) }); }
    skus.push({ code: c, page: pg ? pg.name : null, page_status: pg ? pg.status : "no page", path: isReady ? "enriched page" : (isHeld ? "current catalog card (held for source review)" : "current catalog card"),
      today_card: tc.map(k => k.name), proposed_card: pc.map(k => k.name), proposed_enriched: pc.length === 1 && pc[0].enriched,
      unit: tp ? (Number(tp.case_qty) > 1 ? "Case of " + tp.case_qty : (tp.uom || "Each")) : null,
      price_today: tp ? text(R.priceHtml(tp)) : null, price_proposed: pp ? text(R.priceHtml(pp)) : null,
      orderable_today: !!tp && !tp._discontinued, orderable_proposed: !!pp && !pp._discontinued, commercial_same: !diffs.length });
  }
  add("all_active_skus_represented", "Every active commercial SKU is on a proposed dealer card", !missing.length, missing.length ? missing : { active: active.length });
  add("no_duplicates", "No SKU appears on two cards (today or proposed)", !dupes.length, dupes.length ? dupes : null);
  add("orderable_unchanged", "Every SKU orderable today is orderable in the proposal", skus.every(s => s.orderable_proposed === s.orderable_today || s.orderable_proposed), skus.filter(s => s.orderable_today && !s.orderable_proposed).map(s => s.code));
  const retiredListed = retired.filter(r => tBy[norm(r.code)] || pBy[norm(r.code)]).map(r => r.code);
  add("retired_excluded", "Retired / discontinued SKUs stay off today and proposed", !retiredListed.length, retiredListed.length ? retiredListed : retired.map(r => r.code + " (" + (r.status || "retired") + ")"));
  add("commercial_unchanged", "Price, MSRP, MAP, tiers, UOM / case qty, basis, unit price ladder and price words: identical today and proposed, and equal to the record", !commercial.length, commercial.length ? commercial : { skus: active.length });
  add("held_items_unchanged", "Held-back and unpaged SKUs keep exactly today's product (current catalog card)", !heldChanged.length, heldChanged.length ? heldChanged : { skus: active.filter(r => !readyCodes.has(norm(r.code))).length });
  /* each Ready page: one card, its SKUs exactly, distinct options */
  const pageFaults = [];
  for(const pg of ready){
    const cs = propCards.filter(k => k.page_key === pg.page_key);
    const want = pg.skus.map(s => norm(s.code)).sort().join(","), got = cs.length === 1 ? cs[0].codes.map(norm).sort().join(",") : "";
    if(cs.length !== 1) pageFaults.push({ page: pg.name, issue: cs.length + " cards" });
    else if(want !== got) pageFaults.push({ page: pg.name, issue: "card SKUs " + got + " ≠ page SKUs " + want });
    else if(cs[0].options.length > 1){
      const labels = cs[0].options.map(o => String(o.label).trim().toLowerCase());
      if(labels.some(l => !l) || new Set(labels).size !== labels.length) pageFaults.push({ page: pg.name, issue: "options not distinct: " + cs[0].options.map(o => o.label).join(" / ") });
    }
  }
  add("ready_pages_one_card", "Each Ready page renders as one card with exactly its SKUs as distinct options", !pageFaults.length, pageFaults.length ? pageFaults : ready.map(p => p.name + " (" + p.skus.length + " SKU" + (p.skus.length === 1 ? "" : "s") + ")"));
  /* held content never leaks; draft photos never on today's dealer view */
  const heldDrafts = drafts.filter(d => d && held.some(h => h.page_key === d.page_key));
  const leakNeedles = [];
  heldDrafts.forEach(d => { if(d.description && String(d.description).length > 30) leakNeedles.push(String(d.description).slice(0, 60));
    (Array.isArray(d.features) ? d.features : []).forEach(f => { if(String(f).length > 30) leakNeedles.push(String(f).slice(0, 60)); });
    [d.image].concat((d.images_gallery || []).map(g => g && g.url)).concat((d.skus || []).map(s => s && s.image)).filter(Boolean).forEach(u => leakNeedles.push(String(u))); });
  /* a held draft built from the catalog line repeats words dealers already see today — only what is NEW is a leak */
  /* ...and a sentence a Ready page states from its OWN source is that page's words, not a leak: manufacturers reuse
     bullets across products (Bemis prints "Special ring bumpers for added security" on Steadfast and on Assurance). */
  const propJson = JSON.stringify(P.products), todayJson = JSON.stringify(T.products);
  const readyJson = JSON.stringify(drafts.filter(d => d && ready.some(r => r.page_key === d.page_key)).map(d => [d.description, d.features, d.image, d.images_gallery, d.skus]));
  const shared = leakNeedles.filter(n => propJson.indexOf(n) >= 0 && todayJson.indexOf(n) < 0 && readyJson.indexOf(n) >= 0);
  const leaks = [...new Set(leakNeedles.filter(n => propJson.indexOf(n) >= 0 && todayJson.indexOf(n) < 0 && readyJson.indexOf(n) < 0))];
  add("held_content_not_shown", "No held draft's copy or photos reach the proposed dealer view", !leaks.length, leaks.length ? leaks.slice(0, 10) : { checked: leakNeedles.length, also_on_a_ready_page_own_source: [...new Set(shared)] });
  const todayDraftMedia = JSON.stringify(T.products).match(new RegExp("https?:[^\"]*" + DRAFT_MEDIA.source + "[^\"]*", "g")) || [];
  add("no_draft_photos_today", "Today's dealer view carries no draft photo (drafts stay hidden until published)", !todayDraftMedia.length, todayDraftMedia.length ? todayDraftMedia.slice(0, 10) : null);
  add("enriched_only_off", "Line is not 'enriched only' — a SKU without a live page keeps its current catalog card", !(meta && meta.enriched_only === true),
    meta && meta.enriched_only === true ? "enriched_only is ON: held SKUs would disappear from the shop" : null);
  /* freight: the same cart prices the same freight */
  const cartOf = list => list.filter(p => !p._discontinued).map(p => ({ p, qty: 1 }));
  const fT = T.engine.computeFreight(slug, cartOf(T.products)), fP = P.engine.computeFreight(slug, cartOf(P.products));
  const fw = f => text(R.freightRowsHtml(f));
  add("freight_unchanged", "Freight for the same cart: identical fee and words", m2(fT.fee) === m2(fP.fee) && fw(fT) === fw(fP), { today: { fee: fT.fee, words: fw(fT) }, proposed: { fee: fP.fee, words: fw(fP) } });

  const summary = { enriched_pages_ready: ready.length, held_back: held.length, active_skus: active.length,
    accounted: active.length - missing.length, missing: missing.length, duplicates: dupes.length, commercial_changes: commercial.length,
    cards_today: todayCards.length, cards_proposed: propCards.length, retired_excluded: retired.map(r => r.code) };
  return { manufacturer: slug, read_only: true, summary, checks, pass: checks.every(c => c.pass), skus,
    today: todayCards, proposed: propCards,
    ready_pages: ready.map(p => ({ page_key: p.page_key, name: p.name, skus: p.skus.map(s => s.code) })),
    held_pages: held.map(p => ({ page_key: p.page_key, name: p.name, status: p.status, skus: p.skus.map(s => s.code), issues: (p.issues || []).map(i => i.title) })),
    held_note: HELD_NOTE };
}

module.exports = { buildPreview, cardsOf, proposedContentRows, cartLine, HELD_NOTE, DRAFT_MEDIA };
