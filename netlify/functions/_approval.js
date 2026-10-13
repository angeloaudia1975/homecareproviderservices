/* MANUFACTURER CENTER — APPROVE CONTENT & IMAGES (Angelo 2026-10-12, before Bemis's Gold Standard). Pure.

   Auto-Enrich PROPOSES; only the President DECIDES what becomes dealer-facing. For every proposed page this module sets
   the dealer's CURRENT view next to the PROPOSAL, area by area, and builds the page a publication may write from the
   President's RECORDED selections only:

     · areas: Title · Short description · Description · Features · Specs · Sizing · Warranty · Documents & videos ·
       Category · Grouping · Images (main photo + gallery) · Option images (one choice per SKU);
     · choices: Keep current · Use proposed · Edit (text areas; an edit keeps the source's provenance) — and for photos:
       Keep current dealer image · Use this image (a suggested, current or uploaded one) · No option-specific photo;
       the gallery is chosen photo by photo (check/uncheck, order, primary first, duplicates flagged);
     · NO SELECTION = KEEP CURRENT. An area nobody decided renders and publishes as the dealer sees it today; a proposed
       photo reaches a page only when the President picked that exact photo. There is no "use proposed" fallback;
     · a page is approved only when EVERY area where current and proposed differ carries an explicit selection
       (Keep current counts — it is a choice). An area that shows no difference needs none;
     · a selection is tied to what was on screen: if the proposal or the current dealer view changes afterwards, the
       selection is stale and must be made again;
     · Grouping kept as today (the SKUs stay on their separate cards) means the page is NOT published.

   Selections are content_approval decisions (append-only; the latest per area — per SKU for option images — wins).
   Review Issues is separate: a page can have no open issue and still be Waiting for President Content Approval. */
const crypto = require("crypto");

const canon = v => v && typeof v === "object" ? (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v === undefined ? null : v);
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const norm = c => String(c == null ? "" : c).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const str = v => String(v == null ? "" : v).trim();
const arr = v => Array.isArray(v) ? v : [];
const nonEmpty = v => Array.isArray(v) ? v.length > 0 : !!str(v);

const AREAS = [
  { id: "title", label: "Title", edit: "text" },
  { id: "tagline", label: "Short description", edit: "text" },
  { id: "description", label: "Description", edit: "longtext" },
  { id: "features", label: "Features", edit: "list" },
  { id: "specs", label: "Specs", edit: "pairs" },
  { id: "sizing", label: "Sizing", edit: "longtext" },
  { id: "warranty", label: "Warranty", edit: "text" },
  { id: "documents", label: "Documents & videos", edit: "pick" },
  { id: "category", label: "Category", edit: "text" },
  { id: "grouping", label: "Grouping" },
  { id: "images", label: "Images" },
  { id: "option_images", label: "Option images" },
  { id: "card_image", label: "Catalog card image" }   // grouped pages only (2026-10-12)
];
const TEXT_CHOICES = ["keep_current", "use_proposed", "edit"];
const IMAGE_CHOICES = ["keep_current", "custom"];
const OPTION_CHOICES = ["keep_current", "use_image", "none"];
const GROUPING_CHOICES = ["use_proposed", "keep_current"];
/* Catalog card / default image of a grouped page (Angelo 2026-10-12): the photo a dealer sees on the catalog card before
   choosing an option. Never inferred from option order; no default; presentation only (no option, price, order or
   grouping changes). "use_option" = that option's approved photo; "use_image" = another photo of the page; "none". */
const CARD_CHOICES = ["use_option", "use_image", "none"];

/* The latest selection per area (per SKU for option images). */
function selectionsFor(decisions, pageKey){
  const out = {};
  arr(decisions).filter(d => d && d.kind === "content_approval" && d.field === "page:" + pageKey).sort((a, b) => a.id - b.id)
    .forEach(d => { const v = d.hcps_value || {}; if(!v.area) return; const k = v.area === "option_image" ? "option_image:" + norm(v.code) : v.area;
      out[k] = Object.assign({ id: d.id, by: d.decided_by || null, at: d.decided_at || null, reason: d.reason || null }, v); });
  return out;
}

/* What the dealer sees TODAY for one SKU (its product from the storefront's own merge, no draft involved). */
function currentOf(p){
  p = p || {};
  const media = arr(p.media).filter(m => m && m.kind === "image" && m.url).map(m => String(m.url));
  return { code: String(p.code || ""), name: str(p.name), tagline: str(p._tagline), description: str(p.description),
    features: arr(p._features).concat(arr(p._clinical)), specs: arr(p._specs).concat(arr(p._billing)),
    sizing: { rows: arr(p._sizing), note: str(p._sizingNote) }, warranty: str(p._warranty),
    documents: { documents: arr(p._documents), videos: arr(p._videos), source_url: str(p._sourceUrl) },
    category: str(p.category), subcategory: str(p.subcategory), image: str(p.image), media: [...new Set([str(p.image)].concat(media).filter(Boolean))] };
}
const sizingRows = st => Array.isArray(st) ? st : ((st && Array.isArray(st.rows)) ? st.rows : []);

/* The page's proposal as the dealer would see it (the storefront falls back to today's value where the page is empty). */
function proposedOf(row, cur){
  row = row || {}; cur = cur || currentOf({});
  const sx = arr(row.skus).find(s => norm(s && s.sku) === norm(cur.code)) || {};
  const feats = arr(row.features).concat(arr(row.clinical_applications)), specs = arr(row.specs).filter(s => s && (s.label || s.value)).concat(arr(row.billing_codes));
  return { code: cur.code, name: str(sx.name) || cur.name, tagline: str(row.tagline) || cur.tagline, description: str(row.description) || cur.description,
    features: feats.length ? feats : cur.features, specs: specs.length ? specs : cur.specs,
    sizing: { rows: sizingRows(row.sizing_table).length ? sizingRows(row.sizing_table) : cur.sizing.rows, note: str(row.sizing_note) || cur.sizing.note },
    warranty: str(row.warranty) || cur.warranty,
    documents: { documents: arr(row.documents).length ? arr(row.documents) : cur.documents.documents, videos: arr(row.videos).length ? arr(row.videos) : cur.documents.videos, source_url: str(row.source_url) || cur.documents.source_url },
    category: cur.category, subcategory: str(row.subcategory) || cur.subcategory };
}
/* one value per area, per SKU, collapsed when every SKU shows the same */
const AREA_VALUE = {
  tagline: x => x.tagline, description: x => x.description, features: x => x.features, specs: x => x.specs, sizing: x => x.sizing,
  warranty: x => x.warranty, documents: x => x.documents, category: x => ({ category: x.category, subcategory: x.subcategory })
};
const collapse = (codes, f) => { const vals = codes.map(f); return vals.every(v => canon(v) === canon(vals[0])) ? { all: vals[0] } : { by_sku: Object.fromEntries(codes.map((c, i) => [c, vals[i]])) }; };

/* A photo the President uploaded for this page: in the page's own folder under the open window, and not one Auto-Enrich
   copied there (those live under …/rehost/ and are offered — or withheld — as suggestions). */
const isUpload = (prefix, u) => !!(prefix && typeof u === "string" && u.indexOf(prefix) === 0 && !/[?#\s]/.test(u) && u.slice(prefix.length).indexOf("/") < 0
  && /\.(jpe?g|png|webp)$/i.test(u));
/* Every photo the President may choose from: the dealer's current photos, the photos Auto-Enrich copied (promo art never),
   and photos uploaded for this page under the open window. Same picture twice (same bytes) is flagged. */
function imageCandidates({ page, row, current, decisions, uploadPrefix }){
  const mc = (row && row.enrichment_flags && row.enrichment_flags.mc) || {};
  const withheld = new Set(arr(mc.image_withheld).map(w => w && w.url).filter(Boolean));
  const out = [], seen = new Map();
  const add = c => { if(!c.url || withheld.has(c.url)) return; const k = c.url; if(seen.has(k)){ const o = seen.get(k); o.kinds = [...new Set(o.kinds.concat(c.kinds))]; o.codes = [...new Set(o.codes.concat(c.codes))]; return; }
    const o = Object.assign({ codes: [], kinds: [] }, c); seen.set(k, o); out.push(o); };
  (current || []).forEach(cu => cu.media.forEach((u, n) => add({ url: u, kinds: ["current"], codes: [cu.code], role: n === 0 ? "current dealer photo" : "current dealer thumbnail" })));
  arr(mc.images).filter(d => d && d.url && !d.error).forEach(d => add({ url: d.url, kinds: ["proposed"], codes: d.code ? [d.code] : [], sha: d.sha || null, src: d.src || null, role: d.role || "gallery" }));
  const g = arr(row && row.images_gallery).filter(x => x && x.url);
  [row && row.image].concat(g.map(x => x.url)).filter(Boolean).forEach(u => add({ url: u, kinds: ["proposed"], codes: [], role: "gallery" }));
  arr(row && row.skus).forEach(s => { if(s && s.image) add({ url: s.image, kinds: ["proposed"], codes: [s.sku], role: "option photo" }); });
  /* uploads: photos the President uploaded for this page (its own draft folder, never an Auto-Enrich copy) and put on a selection */
  const sel = arr(decisions).filter(d => d && d.kind === "content_approval" && d.field === "page:" + page.page_key).map(d => d.hcps_value || {});
  sel.forEach(v => [v.url].concat(arr(v.value && v.value.gallery).map(x => x && x.url)).filter(u => isUpload(uploadPrefix, u))
    .forEach(u => add({ url: u, kinds: ["uploaded"], codes: v.code ? [v.code] : [], role: "uploaded" })));
  /* duplicates: the same bytes under two addresses */
  const bySha = {}; out.forEach(c => { if(c.sha){ (bySha[c.sha] = bySha[c.sha] || []).push(c); } });
  Object.values(bySha).forEach(list => list.slice(1).forEach(c => { c.duplicate_of = list[0].url; }));
  out.forEach((c, n) => { c.id = "img" + (n + 1); c.proposed_in_draft = c.kinds.indexOf("proposed") >= 0; });
  return out;
}

/* input: { page {page_key,name,status,skus:[{code}]}, row (draft), products (TODAY's products for the page's SKUs),
            todayCards [{name,codes}], decisions, uploadPrefix }
   → { areas:[…], complete, publish, waiting:[labels], selections, candidates, current, proposed } */
function approvalState(input){
  const { page, row } = input;
  const codes = arr(page && page.skus).map(s => String(s.code));
  const prodBy = {}; arr(input.products).forEach(p => { if(p && p.code && !prodBy[norm(p.code)]) prodBy[norm(p.code)] = p; });
  const current = codes.map(c => currentOf(prodBy[norm(c)] || { code: c }));
  const proposed = current.map(cu => proposedOf(row, cu));
  const sel = selectionsFor(input.decisions, page.page_key);
  const candidates = imageCandidates({ page, row, current, decisions: input.decisions, uploadPrefix: input.uploadPrefix });
  const candUrls = new Set(candidates.map(c => c.url));
  const todayCards = arr(input.todayCards).filter(k => k && arr(k.codes).some(c => codes.some(x => norm(x) === norm(c))));
  const oneCardToday = todayCards.length === 1 && todayCards[0].codes.map(norm).sort().join(",") === codes.map(norm).sort().join(",");
  const areas = [];
  const basisOf = (cur, prop) => sha(canon({ cur, prop })).slice(0, 16);
  const state = (id, label, cur, prop, choices, extra) => {
    const same = canon(cur) === canon(prop), basis = basisOf(cur, prop), s = sel[id] || null;
    const stale = !!(s && s.basis && s.basis !== basis);
    const chosen = s && !stale && choices.indexOf(s.choice) >= 0 ? s : null;
    const a = Object.assign({ id, label, current: cur, proposed: prop, same, basis, choices,
      choice: chosen ? chosen.choice : (same ? "no_change" : (choices.indexOf("keep_current") >= 0 ? "keep_current" : null)), selected: !!chosen, decision: chosen ? chosen.id : null, stale,
      value: chosen && chosen.value != null ? chosen.value : null, by: chosen ? chosen.by : null, at: chosen ? chosen.at : null }, extra || {});
    a.approved = same || !!chosen;
    areas.push(a); return a;
  };
  /* Title: the card name and each option's name */
  const curTitle = { card: oneCardToday ? todayCards[0].name : null, options: Object.fromEntries(current.map(c => [c.code, c.name])) };
  const propTitle = { card: str(row && row.name) || null, options: Object.fromEntries(proposed.map(p => [p.code, p.name])) };
  state("title", "Title", curTitle, propTitle, oneCardToday ? TEXT_CHOICES : ["use_proposed", "edit"],
    Object.assign({ cards_today: todayCards.map(k => k.name) },
      oneCardToday ? {} : { note: "These SKUs are on " + todayCards.length + " separate cards today, so the combined card has no current title: choose the proposed one or type one." }));
  for(const d of AREAS.filter(x => AREA_VALUE[x.id])){
    const cur = collapse(current.map(c => c.code), c => AREA_VALUE[d.id](current.find(x => x.code === c)));
    const prop = collapse(current.map(c => c.code), c => AREA_VALUE[d.id](proposed.find(x => x.code === c)));
    state(d.id, d.label, cur, prop, TEXT_CHOICES, { provenance: (row && row.field_provenance && row.field_provenance[d.id === "documents" ? "documents" : d.id]) || null });
  }
  /* Grouping: one card with these SKUs as options, or today's cards */
  /* (what is compared is which SKUs share a card; the names are the Title's business) */
  const cardSets = list => list.map(c => c.map(norm).sort().join("+")).sort();
  state("grouping", "Grouping", { cards: cardSets(todayCards.map(k => k.codes)) }, { cards: cardSets([codes]) }, GROUPING_CHOICES,
    { display: { today: todayCards.map(k => ({ name: k.name, codes: k.codes })),
                 proposed: [{ name: str(row && row.name) || page.name, codes, options: arr(row && row.skus).map(s => ({ code: s.sku, label: str(s.size != null ? s.size : s.option) })) }] },
      note: "Keep current = the SKUs stay on today's separate cards and this page is NOT published. Until you choose, they stay as today." });
  /* Images (main photo + gallery): today = the dealer's current photos; proposed = the draft's gallery */
  const curImgs = { main: current[0] ? current[0].image : "", gallery: [...new Set(current.flatMap(c => c.media))] };
  const propImgs = { main: str(row && row.image) || (arr(row && row.images_gallery)[0] || {}).url || "", gallery: arr(row && row.images_gallery).filter(g => g && g.url).map(g => g.url) };
  const im = state("images", "Images", curImgs, propImgs, IMAGE_CHOICES);
  if(im.selected && im.choice === "custom"){
    const bad = arr(im.value && im.value.gallery).filter(g => !g || !candUrls.has(g.url));
    if(bad.length || !arr(im.value && im.value.gallery).length){ im.selected = false; im.approved = im.same; im.choice = "keep_current"; im.decision = null; im.invalid = bad.length ? "a chosen photo is no longer available" : "an empty gallery"; im.value = null; }
  }
  /* Option images: one selection per SKU */
  const opts = current.map(cu => {
    const sx = arr(row && row.skus).find(s => norm(s && s.sku) === norm(cu.code)) || {};
    const cur = { image: cu.image }, prop = { image: str(sx.image) || propImgs.main || "" };
    const same = canon(cur) === canon(prop), basis = basisOf(cur, prop), s = sel["option_image:" + norm(cu.code)] || null;
    const stale = !!(s && s.basis && s.basis !== basis);
    let chosen = s && !stale && OPTION_CHOICES.indexOf(s.choice) >= 0 ? s : null;
    let invalid = null;
    if(chosen && chosen.choice === "use_image" && !candUrls.has(chosen.url)){ invalid = "the chosen photo is no longer available"; chosen = null; }
    return { code: cu.code, option: str(sx.size != null ? sx.size : sx.option), current: cur, proposed: prop, same, basis, choices: OPTION_CHOICES,
      choice: chosen ? chosen.choice : (same ? "no_change" : "keep_current"), url: chosen && chosen.choice === "use_image" ? chosen.url : null,
      selected: !!chosen, decision: chosen ? chosen.id : null, stale, invalid, approved: same || !!chosen, by: chosen ? chosen.by : null, at: chosen ? chosen.at : null };
  });
  areas.push({ id: "option_images", label: "Option images", options: opts, same: opts.every(o => o.same), selected: opts.every(o => o.selected || o.same), approved: opts.every(o => o.approved) });
  /* Catalog card image — a page with more than one option only. Nothing is pre-selected; the page is not approved
     until the President chooses. The choice is tied to the option photos it was made against. */
  let cardUrl = null;
  if(codes.length > 1){
    const imgOf = o => !o ? null : (o.choice === "use_image" ? o.url : (o.choice === "none" ? null : (o.current.image || null)));
    const shown = opts.map(o => ({ code: o.code, option: o.option, image: imgOf(o) }));
    const basis = basisOf({ options: shown }, null), s = sel.card_image || null;
    const stale = !!(s && s.basis && s.basis !== basis);
    let chosen = s && !stale && CARD_CHOICES.indexOf(s.choice) >= 0 ? s : null, invalid = null;
    if(chosen && chosen.choice === "use_option"){ const o = shown.find(x => norm(x.code) === norm(chosen.code)); if(!o || !o.image){ invalid = "that option has no photo"; chosen = null; } else cardUrl = o.image; }
    else if(chosen && chosen.choice === "use_image"){ if(!candUrls.has(chosen.url)){ invalid = "the chosen photo is no longer available"; chosen = null; } else cardUrl = chosen.url; }
    else if(chosen && chosen.choice === "none") cardUrl = "none";
    areas.push({ id: "card_image", label: "Catalog card image", options: shown, choices: CARD_CHOICES, basis, same: false,
      choice: chosen ? chosen.choice : null, code: chosen && chosen.choice === "use_option" ? chosen.code : null, url: chosen && chosen.choice === "use_image" ? chosen.url : null,
      resolved: cardUrl, selected: !!chosen, approved: !!chosen, decision: chosen ? chosen.id : null, stale, invalid, by: chosen ? chosen.by : null, at: chosen ? chosen.at : null,
      note: "What dealers see on the catalog card before choosing an option. It is never taken from the option order: choose one option's photo, another approved photo, or no photo. Presentation only — no option, price, order or grouping changes." });
  }
  /* a page that combines SKUs into a new card is shown and published only once the President chose that grouping;
     until then (no selection = keep current) its SKUs stay on today's cards */
  const grouping = areas.find(a => a.id === "grouping");
  const publish = grouping.same || (grouping.selected && grouping.choice === "use_proposed");
  const keptAsToday = grouping.selected && grouping.choice === "keep_current";
  const waiting = areas.filter(a => !a.approved).map(a => a.label);
  return { page_key: page.page_key, name: page.name, codes, areas, complete: !waiting.length, publish, waiting, upload_prefix: input.uploadPrefix || null, card_image: cardUrl,
    status: keptAsToday ? "kept_as_today" : (waiting.length ? "waiting_for_approval" : "approved"),
    candidates, current, proposed, selections: sel };
}

/* The page a publication may write: today's dealer view for every area nobody decided, the President's selection
   everywhere else. Draft photo links stay as draft links here (the publication plan copies the chosen ones to live
   storage); a current dealer photo the page must name explicitly is returned as-is and copied the same way. */
const WRITE_FIELDS = ["name", "tagline", "description", "features", "clinical_applications", "specs", "billing_codes", "sizing_table", "sizing_note",
  "warranty", "documents", "videos", "source_url", "category", "subcategory", "options", "field_provenance", "image", "images_gallery", "skus", "card_image"];
function approvedRow(row, st){
  row = row || {};
  const A = id => st.areas.find(a => a.id === id);
  const lead = st.current[0] || currentOf({});
  const out = {};
  const pick = (id, keep, proposed, edit) => { const a = A(id); const c = a.choice;
    if(c === "use_proposed" && a.selected) return proposed(); if(c === "edit" && a.selected) return edit(a.value); return keep(); };
  /* title */
  const t = A("title");
  out.name = pick("title", () => t.current.card || st.current.map(c => c.name).find(Boolean) || row.name || st.name, () => str(row.name) || st.name, v => str(v && v.text) || str(row.name));
  const titleChoice = t.selected ? t.choice : "keep_current";
  out.tagline = pick("tagline", () => null, () => row.tagline || null, v => str(v && v.text) || null);
  out.description = pick("description", () => null, () => row.description || null, v => str(v && v.text) || null);
  const feat = pick("features", () => ({ f: [], c: [] }), () => ({ f: arr(row.features), c: arr(row.clinical_applications) }), v => ({ f: arr(v && v.items).map(str).filter(Boolean), c: [] }));
  out.features = feat.f; out.clinical_applications = feat.c;
  const sp = pick("specs", () => ({ s: [], b: [] }), () => ({ s: arr(row.specs), b: arr(row.billing_codes) }), v => ({ s: arr(v && v.items).filter(x => x && (str(x.label) || str(x.value))).map(x => ({ label: str(x.label), value: str(x.value) })), b: [] }));
  out.specs = sp.s; out.billing_codes = sp.b;
  const sz = pick("sizing", () => ({ t: [], n: null }), () => ({ t: row.sizing_table == null ? [] : row.sizing_table, n: row.sizing_note || null }), v => ({ t: row.sizing_table == null ? [] : row.sizing_table, n: str(v && v.text) || null }));
  out.sizing_table = sz.t; out.sizing_note = sz.n;
  out.warranty = pick("warranty", () => null, () => row.warranty || null, v => str(v && v.text) || null);
  const docs = pick("documents", () => ({ d: [], v: [], s: null }), () => ({ d: arr(row.documents), v: arr(row.videos), s: row.source_url || null }),
    v => ({ d: arr(row.documents).filter(x => arr(v && v.documents).indexOf(x && x.url) >= 0), v: arr(row.videos).filter(x => arr(v && v.videos).indexOf(typeof x === "string" ? x : x && x.url) >= 0), s: v && v.source_url === false ? null : (row.source_url || null) }));
  out.documents = docs.d; out.videos = docs.v; out.source_url = docs.s;
  const cat = pick("category", () => ({ c: lead.category || row.category || null, s: null }), () => ({ c: row.category || null, s: row.subcategory || null }), v => ({ c: row.category || lead.category || null, s: str(v && v.text) || null }));
  out.category = cat.c; out.subcategory = cat.s;
  out.options = A("grouping").selected && A("grouping").choice === "use_proposed" ? (row.options || {}) : {};
  /* images */
  const im = A("images");
  const gallery = im.selected && im.choice === "custom" ? arr(im.value && im.value.gallery).map((g, n) => ({ url: g.url, caption: str(g.caption), primary: n === 0, source: "approved by the President" })) : [];
  out.images_gallery = gallery; out.image = gallery.length ? gallery[0].url : null;
  const optBy = Object.fromEntries(A("option_images").options.map(o => [norm(o.code), o]));
  out.skus = arr(row.skus).map(s => { const o = Object.assign({}, s); const op = optBy[norm(s && s.sku)];
    /* the option's name: the proposal's only when the title was taken from the proposal */
    if(titleChoice === "keep_current") delete o.name;
    else if(titleChoice === "edit") { if(arr(row.skus).length === 1) o.name = out.name; else delete o.name; }
    o.images = [];
    if(!op || op.choice === "none") o.image = null;
    else if(op.choice === "use_image") o.image = op.url;
    /* keep current (chosen, or nothing chosen, or nothing differs): with no page photo the storefront shows today's photo
       by itself; once the page has a gallery, the option must name today's photo explicitly (copied to live storage) */
    else o.image = gallery.length ? (op.current.image || null) : null;
    if(o.image == null) delete o.image;
    return o; });
  /* the catalog card image: a grouped page's explicit choice (an approved photo, or "none"); a single-SKU page has none */
  out.card_image = st.codes.length > 1 && A("card_image") && A("card_image").selected ? A("card_image").resolved : null;
  /* provenance: the source's, plus what the President approved (an edit keeps the facts' source) */
  const prov = Object.assign({}, row.field_provenance || {});
  prov.president_approval = Object.fromEntries(st.areas.filter(a => a.id !== "option_images").map(a => [a.id, { choice: a.choice, decision: a.decision, source: a.id === "card_image" ? null : ((row.field_provenance || {})[a.id] || null) }])
    .concat(A("option_images").options.map(o => ["option_image:" + o.code, { choice: o.choice, decision: o.decision }])));
  out.field_provenance = prov;
  return out;
}

/* What a selection asks for — validated before anything is recorded. url sets: the candidates' urls. */
function selectionProblem(st, area, choice, value, code){
  if(area === "option_image"){
    const o = st.areas.find(a => a.id === "option_images").options.find(x => norm(x.code) === norm(code));
    if(!o) return "“" + code + "” is not an option of this page";
    if(OPTION_CHOICES.indexOf(choice) < 0) return "“" + choice + "” is not a choice for an option photo";
    if(choice === "use_image" && !st.candidates.some(c => c.url === str(value && value.url)) && !isUpload(st.upload_prefix, str(value && value.url))) return "that photo is not one of this page's photos (current, suggested or uploaded here)";
    return null;
  }
  const a = st.areas.find(x => x.id === area);
  if(!a || area === "option_images") return "“" + area + "” is not an approval area" + (area === "card_image" ? " (only a page with more than one option has a catalog card image)" : "");
  if(a.choices.indexOf(choice) < 0) return "“" + choice + "” is not a choice for " + a.label;
  if(area === "card_image"){
    if(choice === "use_option"){ const o = a.options.find(x => norm(x.code) === norm(value && value.code)); if(!o) return "name one of this page's options"; if(!o.image) return "that option has no photo"; }
    if(choice === "use_image" && !st.candidates.some(c => c.url === str(value && value.url))) return "that photo is not one of this page's photos (current, suggested or uploaded here)";
    return null;
  }
  if(area === "images" && choice === "custom"){
    const g = arr(value && value.gallery);
    if(!g.length) return "choose at least one photo for the gallery (or Keep current)";
    if(g.length > 30) return "too many photos";
    const urls = g.map(x => str(x && x.url)); if(new Set(urls).size !== urls.length) return "the same photo twice in the gallery";
    if(urls.some(u => !st.candidates.some(c => c.url === u) && !isUpload(st.upload_prefix, u))) return "a gallery photo is not one of this page's photos (current, suggested or uploaded here)";
  }
  if(choice === "edit"){
    const ed = (AREAS.find(x => x.id === area) || {}).edit;
    if(ed === "text" || ed === "longtext"){ if(!str(value && value.text)) return "type the approved text (or Keep current)"; if(str(value.text).length > 8000) return "the text is too long"; }
    if(ed === "list" && !arr(value && value.items).map(str).filter(Boolean).length) return "list at least one feature";
    if(ed === "pairs" && !arr(value && value.items).some(x => x && (str(x.label) || str(x.value)))) return "list at least one spec";
    if(ed === "pick" && !arr(value && value.documents).length && !arr(value && value.videos).length) return "pick at least one document or video";
  }
  return null;
}
/* the decision recorded for one selection (the caller adds manufacturer / reason / decided_by) */
function selectionRecord(st, area, choice, value, code, windowId){
  const hv = { area, choice, page_name: st.name, window: windowId == null ? null : windowId };
  if(area === "option_image"){ const o = st.areas.find(a => a.id === "option_images").options.find(x => norm(x.code) === norm(code));
    hv.code = o.code; hv.basis = o.basis; if(choice === "use_image") hv.url = str(value.url); }
  else { const a = st.areas.find(x => x.id === area); hv.basis = a.basis;
    if(area === "card_image"){ if(choice === "use_option") hv.code = a.options.find(x => norm(x.code) === norm(value.code)).code; if(choice === "use_image") hv.url = str(value.url); return hv; }
    if(area === "images" && choice === "custom") hv.value = { gallery: arr(value.gallery).map(g => ({ url: str(g.url), caption: str(g.caption).slice(0, 200) })) };
    else if(choice === "edit") hv.value = JSON.parse(JSON.stringify(value));
    if(choice === "edit" && a.provenance) hv.provenance = a.provenance; }
  return hv;
}

/* The checklist line Angelo reads: Title ✓ · Description … */
function checklist(st){ return st.areas.map(a => ({ id: a.id, label: a.label, approved: a.approved, no_change: !!a.same, choice: a.id === "option_images" ? null : a.choice, stale: !!a.stale })); }

module.exports = { isUpload, AREAS, TEXT_CHOICES, IMAGE_CHOICES, OPTION_CHOICES, GROUPING_CHOICES, CARD_CHOICES, WRITE_FIELDS, selectionsFor, currentOf, proposedOf, imageCandidates,
  approvalState, approvedRow, selectionProblem, selectionRecord, checklist, canon };
