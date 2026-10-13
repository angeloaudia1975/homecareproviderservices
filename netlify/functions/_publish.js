/* MANUFACTURER CENTER RELEASE D — PUBLISH & VERIFY: the publication plan (pure; approved to build 2026-10-11).

   The dry run Angelo approves. From the line's enrichment state it derives, deterministically:
     · WHAT is published: only pages whose Review Issues status is Ready AND whose content & images the President
       approved area by area (_approval.js, 2026-10-12). A held page (or any page that is not Ready) is never in a plan,
       whatever window built it; a Ready page waiting for approval keeps its current catalog cards;
     · WHAT each page says and shows: only the President's recorded selections — an area nobody decided keeps today's
       dealer view, and a suggested photo nobody picked can never enter the plan;
     · the exact rows as they are now ("before") and the exact fields each becomes ("after"): published, not
       disabled, no draft_window, every photo pointing at a LIVE copy (product-content/<line>/live/<page>/<sha>.<ext>);
     · the photos to promote: one live copy per distinct picture. The same picture used twice — an option's photo and
       the same photo in the page gallery (same bytes, or the same file at another size) — becomes ONE live copy, so
       the storefront (which hides a thumbnail equal to the hero) never shows it twice. Each option keeps its own
       photo; a genuinely different view is never removed;
     · the dealer accounting the publication must produce (cards today → after, every active SKU, held products on
       their current catalog cards, commercial unchanged) — from the Release C preview run on the "after" rows;
     · the plan hash: everything above plus the held pages, the line's decisions and the commercial record. The
       approval records the hash; publishing re-derives the plan and refuses if one byte differs.
   Nothing here reads the network or writes anything. */
const crypto = require("crypto");
const ENRICH = require("./_enrich.js");
const APPROVAL = require("./_approval.js");

const DRAFT_RE = /\/storage\/v1\/object\/public\/product-content\/[^?#\s]*\/drafts\/w\d+\//;
const canon = v => v && typeof v === "object" ? (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v === undefined ? null : v);
const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const isDraftUrl = u => typeof u === "string" && DRAFT_RE.test(u);
const extOf = (u, type) => { const m = /\.([a-z0-9]{3,4})(?:$|[?#])/i.exec(String(u || "")); const e = (m ? m[1] : String(type || "").split("/")[1] || "jpg").toLowerCase();
  return e === "jpeg" ? "jpg" : (["jpg", "png", "webp", "gif"].indexOf(e) >= 0 ? e : "jpg"); };
const safeKey = k => String(k || "page").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "page";
const livePath = (slug, pageKey, sha, ext) => `${slug}/live/${safeKey(pageKey)}/${String(sha).slice(0, 24)}.${ext}`;

/* Every draft-folder link on a row (image, gallery, per-SKU photos and their lists, option swatches). */
function draftUrlsOf(row){
  const out = new Set();
  const walk = v => { if(typeof v === "string"){ if(isDraftUrl(v)) out.add(v); } else if(Array.isArray(v)) v.forEach(walk); else if(v && typeof v === "object") Object.keys(v).forEach(k => walk(v[k])); };
  [row && row.image, row && row.images_gallery, row && row.skus, row && row.options].forEach(walk);
  return [...out];
}

/* info: { <draft url>: { sha, src, bytes, type } } — from the draft's own copy records, or hashed by the server. */
function planImages(slug, row, info, publicBase){
  const pk = row.page_key, gal = (Array.isArray(row.images_gallery) ? row.images_gallery : []).filter(g => g && g.url);
  const I = u => info[u] || null;
  const stem = u => ENRICH.photoStem((I(u) && I(u).src) || u);
  /* the canonical copy of a picture: an option photo that IS a gallery picture (same bytes, else same file at another size) uses the gallery's copy */
  const canonOf = u => {
    if(!isDraftUrl(u) && !(I(u) && I(u).current)) return u;
    const me = I(u); if(!me) return u;
    const same = gal.find(g => I(g.url) && I(g.url).sha === me.sha) || gal.find(g => I(g.url) && stem(g.url) === stem(u));
    return same ? same.url : u;
  };
  const toLive = {}, promote = {}, deduped = [];
  /* a photo the page names is copied to live storage when it is a draft copy OR a current dealer photo the President chose
     to keep (the database accepts live copies only); a live copy of this line stays as it is; anything else is refused */
  const isLive = u => typeof u === "string" && u.indexOf(publicBase + slug + "/live/") === 0 && !/[?#\s]/.test(u.slice((publicBase + slug + "/live/").length));
  const live = u => {
    if(isLive(u)) return u;
    if(!isDraftUrl(u) && !(I(u) && I(u).current)) throw new Error("photo is neither a draft copy, a kept current photo nor a live copy: " + u);
    const c = canonOf(u), m = I(c);
    if(!m || !m.sha) throw new Error("no fingerprint for photo " + c);
    const path = livePath(slug, pk, m.sha, extOf(c, m.type)), url = publicBase + path;
    if(c !== u) deduped.push({ from: u, same_as: c, why: I(u) && I(u).sha === m.sha ? "same bytes" : "same picture at another size" });
    toLive[u] = url;
    if(!promote[path]) promote[path] = { from: m.fetch_url || c, to: url, path, sha: m.sha, bytes: m.bytes || null, type: m.type || null, uses: [], kept_current: !!m.current };
    return url;
  };
  const used = (u, role) => { const url = live(u); const p = Object.values(promote).find(x => x.to === url); if(p && p.uses.indexOf(role) < 0) p.uses.push(role); return url; };
  const seen = new Set(), gallery = [];
  gal.forEach((g, n) => { const url = used(g.url, n === 0 || g.primary ? "main photo" : "gallery"); if(seen.has(url)){ deduped.push({ from: g.url, same_as: url, why: "same picture twice in the gallery" }); return; }
    seen.add(url); gallery.push(Object.assign({}, g, { url })); });
  if(gallery.length && !gallery.some(g => g.primary === true)) gallery[0] = Object.assign({}, gallery[0], { primary: true });
  const image = row.image ? used(row.image, "main photo") : (gallery[0] ? gallery[0].url : null);
  const skus = (Array.isArray(row.skus) ? row.skus : []).map(s => { const o = Object.assign({}, s);
    if(o.image) o.image = used(o.image, "option photo · " + o.sku);
    if(Array.isArray(o.images)) o.images = o.images.map(u => used(u, "option photo · " + o.sku));
    return o; });
  /* the approved content fields travel with the photos (the publication writes exactly these) */
  const fields = {}; (APPROVAL.WRITE_FIELDS).forEach(f => { if(f !== "image" && f !== "images_gallery" && f !== "skus" && f !== "card_image" && Object.prototype.hasOwnProperty.call(row, f)) fields[f] = row[f] === undefined ? null : row[f]; });
  /* a grouped page's catalog card image (the President's explicit choice): a live copy like every photo, or "none" */
  if(Object.prototype.hasOwnProperty.call(row, "card_image")) fields.card_image = !row.card_image ? null : (row.card_image === "none" ? "none" : used(row.card_image, "catalog card image"));
  return { after: Object.assign(fields, { status: "published", disabled: false, draft_window: null, image, images_gallery: gallery, skus }),
    promote: Object.values(promote), deduped, mapping: toLive };
}

/* input: { slug, window, publicBase (…/storage/v1/object/public/product-content/), pages (enrichSummary pages),
            drafts (product_content rows of the line), records, meta, decisions, info (photo fingerprints),
            approvals { page_key: approvalState }, approved { page_key: approvedRow },
            preview (buildPreview output for the AFTER rows) }
   → { publishable, problems, ready:[…], held:[…], awaiting:[…], summary, plan_hash, approval }
   A page is published only when it is Ready in Review Issues AND the President approved its content and images: every
   area that differs from today carries his explicit selection. The "after" row is built from those selections only —
   an area nobody decided keeps today's dealer view, and a suggested photo nobody picked never enters the plan. */
function buildPlan(input){
  const { slug, pages, drafts, records, meta, decisions, info, preview } = input;
  const approvals = input.approvals || {}, approved = input.approved || {};
  const problems = [];
  const isReady = p => p.status === "ready";
  const approvedFor = p => { const a = approvals[p.page_key]; return !!(a && a.complete && a.publish && approved[p.page_key]); };
  const ready = (pages || []).filter(p => isReady(p) && approvedFor(p));
  const awaiting = (pages || []).filter(p => isReady(p) && !approvedFor(p));
  /* (2026-10-12) a page an earlier publication already made live is neither held nor part of this plan: it stays live
     exactly as it is (its row is in the hash, so a change to it invalidates the plan) */
  const isLive = p => p.status === "published";
  const live = (pages || []).filter(isLive);
  const held = (pages || []).filter(p => !isReady(p) && !isLive(p));
  const rowOf = k => (drafts || []).find(r => r && r.page_key === k) || null;
  const readyOut = [];
  for(const p of ready){
    const row = rowOf(p.page_key);
    if(!row){ problems.push(p.name + ": no draft row"); continue; }
    if(ENRICH.isVisibleRow(row)){ problems.push(p.name + ": already visible — enrichment never re-publishes a live page"); continue; }
    if(input.window && row.draft_window != null && String(row.draft_window) !== String(input.window)) problems.push(p.name + ": built under window " + row.draft_window + ", not the open window " + input.window);
    const ap = Object.assign({}, row, approved[p.page_key]);
    /* every photo the approved page names: a selection the President made, or a photo dealers see today */
    const st = approvals[p.page_key];
    const chosen = new Set(st.areas.filter(a => a.id === "images" && a.selected && a.choice === "custom").flatMap(a => (a.value && a.value.gallery || []).map(g => g.url))
      .concat(st.areas.find(a => a.id === "option_images").options.filter(o => o.selected && o.choice === "use_image").map(o => o.url)));
    if(st.card_image && st.card_image !== "none") chosen.add(st.card_image);
    const today = new Set(st.current.flatMap(c => c.media));
    const named = [ap.image, ap.card_image === "none" ? null : ap.card_image].concat((ap.images_gallery || []).map(g => g && g.url)).concat((ap.skus || []).map(s => s && s.image)).filter(Boolean);
    const unapproved = named.filter(u => !chosen.has(u) && !today.has(u));
    if(unapproved.length){ problems.push(p.name + ": a photo nobody approved would be published (" + unapproved.length + ")"); continue; }
    let im; try{ im = planImages(slug, ap, info || {}, input.publicBase); }catch(e){ problems.push(p.name + ": " + e.message); continue; }
    const left = draftUrlsOf(Object.assign({}, ap, im.after, { options: ap.options }));
    const optLeft = draftUrlsOf({ options: ap.options });
    if(optLeft.length) problems.push(p.name + ": an option swatch points at a draft photo (" + optLeft.length + ")");
    if(left.length && !optLeft.length) problems.push(p.name + ": a draft-folder link would remain");
    readyOut.push({ page_key: p.page_key, name: p.name, skus: p.skus.map(s => s.code), before: row, after: im.after, promote: im.promote, deduped: im.deduped,
      selections: APPROVAL.checklist(st),
      changes: { status: (row.status || "") + " → published", draft_window: (row.draft_window == null ? "none" : row.draft_window) + " → cleared",
        photos: im.promote.filter(x => !x.kept_current).length + " approved new photo(s) + " + im.promote.filter(x => x.kept_current).length + " kept current photo(s) → live copies" } });
  }
  const heldOut = held.map(p => ({ page_key: p.page_key, name: p.name, status: p.status, skus: p.skus.map(s => s.code),
    issues: (p.issues || []).map(i => i.title), holds: Object.keys(p.resolutions || {}).map(k => k + ":" + p.resolutions[k].choice + "#" + p.resolutions[k].id),
    row: rowOf(p.page_key) }));
  const liveOut = live.map(p => ({ page_key: p.page_key, name: p.name, skus: p.skus.map(s => s.code), row: rowOf(p.page_key) }));
  liveOut.forEach(h => { if(!h.row || !ENRICH.isVisibleRow(h.row)) problems.push(h.name + ": shown as published but its page is not visible"); });
  const awaitOut = awaiting.map(p => { const a = approvals[p.page_key];
    return { page_key: p.page_key, name: p.name, skus: p.skus.map(s => s.code), status: a ? a.status : "waiting_for_approval", waiting: a ? a.waiting : ["(not reviewed)"], row: rowOf(p.page_key) }; });
  if(!readyOut.length) problems.push(awaitOut.length ? "no page has the President's content & image approval yet (" + awaitOut.map(a => a.name).join(", ") + ")" : "no Ready page to publish");
  heldOut.forEach(h => { if(h.row && ENRICH.isVisibleRow(h.row)) problems.push(h.name + ": a held page is visible"); });
  awaitOut.forEach(h => { if(h.row && ENRICH.isVisibleRow(h.row)) problems.push(h.name + ": a page waiting for approval is visible"); });
  if(!preview) problems.push("no dealer preview of the publication");
  else if(!preview.pass) problems.push("the dealer preview of the publication fails: " + preview.checks.filter(c => !c.pass).map(c => c.id).join(", "));
  const s = preview ? preview.summary : {};
  const summary = { cards_today: s.cards_today, cards_after: s.cards_proposed, active_skus: s.active_skus, accounted: s.accounted, missing: s.missing,
    duplicates: s.duplicates, commercial_changes: s.commercial_changes, retired_excluded: s.retired_excluded || [],
    enriched_pages_live: readyOut.length, already_live_unchanged: liveOut.length, held_on_current_cards: heldOut.length, waiting_for_approval: awaitOut.length,
    photos_promoted: readyOut.reduce((n, r) => n + r.promote.length, 0), duplicates_removed: readyOut.reduce((n, r) => n + r.deduped.length, 0) };
  const lineDecisions = (decisions || []).filter(d => d && (d.kind === "content_resolution" || d.kind === "enrichment_window" || d.kind === "content_approval"))
    .map(d => [d.id, d.kind, d.field, d.hcps_value, d.used_at || null]).sort((a, b) => a[0] - b[0]);
  const hashed = { v: 2, slug, window: input.window || null,
    ready: readyOut.map(r => ({ page_key: r.page_key, before: r.before, after: r.after, promote: r.promote.map(x => [x.from, x.path, x.sha]) })),
    held: heldOut.map(h => ({ page_key: h.page_key, status: h.status, issues: h.issues, holds: h.holds, row: h.row })),
    awaiting: awaitOut.map(h => ({ page_key: h.page_key, waiting: h.waiting, row: h.row })),
    live: liveOut.map(h => ({ page_key: h.page_key, row: h.row })),
    decisions: lineDecisions, records: (records || []).slice().sort((a, b) => String(a.code).localeCompare(String(b.code))),
    meta: meta ? { enriched_only: meta.enriched_only === true, category_map: meta.category_map || null, freight_terms: meta.freight_terms || null, frozen: meta.frozen === true } : null,
    preview: preview ? { summary: preview.summary, skus: preview.skus, checks: preview.checks.map(c => [c.id, c.pass]) } : null };
  const plan_hash = sha256(canon(hashed));
  const approval = { plan_hash, window: input.window || null, pages: readyOut.map(r => r.page_key),
    before: Object.fromEntries(readyOut.map(r => [r.page_key, r.before])), after: Object.fromEntries(readyOut.map(r => [r.page_key, r.after])),
    promote: readyOut.flatMap(r => r.promote.map(x => ({ page_key: r.page_key, from: x.from, to: x.to, path: x.path, sha: x.sha }))),
    held: heldOut.map(h => ({ page_key: h.page_key, name: h.name, skus: h.skus, issues: h.issues, holds: h.holds })),
    awaiting: awaitOut.map(h => ({ page_key: h.page_key, name: h.name, skus: h.skus, waiting: h.waiting })),
    live_before: liveOut.map(h => h.page_key),
    selections: Object.fromEntries(readyOut.map(r => [r.page_key, r.selections])), summary };
  return { publishable: !problems.length, problems, ready: readyOut, held: heldOut, awaiting: awaitOut, live: liveOut, summary, plan_hash, approval };
}

/* The report Angelo reads (no raw rows). */
function planReport(plan){
  return { publishable: plan.publishable, problems: plan.problems, plan_hash: plan.plan_hash, summary: plan.summary,
    ready: plan.ready.map(r => ({ page_key: r.page_key, name: r.name, skus: r.skus, changes: r.changes, selections: r.selections,
      promote: r.promote.map(x => ({ from: x.from, to: x.to, sha: x.sha.slice(0, 16), uses: x.uses, kept_current: !!x.kept_current })), deduped: r.deduped,
      after_photos: { main: r.after.image, gallery: r.after.images_gallery.map(g => g.url), card: r.after.card_image == null ? null : r.after.card_image, options: r.after.skus.filter(s => s.image).map(s => ({ sku: s.sku, option: s.size || "", image: s.image })) } })),
    held: plan.held.map(h => ({ page_key: h.page_key, name: h.name, status: h.status, skus: h.skus, issues: h.issues, holds: h.holds })),
    awaiting: (plan.awaiting || []).map(h => ({ page_key: h.page_key, name: h.name, status: h.status, skus: h.skus, waiting: h.waiting })),
    live_unchanged: (plan.live || []).map(h => ({ page_key: h.page_key, name: h.name, skus: h.skus })) };
}

/* ── CORRECTING A PUBLISHED PAGE (Angelo 2026-10-12, the Assurance correction) ────────────────────────────────────────
   Once a line is the Gold Standard a published page changes only under a regression_fix. This plan is the dry run of
   such a correction, built exactly like a publication (the same approval → execute → finalize path and database
   function) but scoped by the regression_fix itself:
     · the regression_fix names ONE page and the content areas it may correct (hcps_value: { scope: "content_correction",
       page_key, areas }); it must be this line's, unspent;
     · the corrected text is the President's, recorded as content_approval decisions that carry correction = <fix id>;
     · "after" is the live row with ONLY those areas' fields replaced — every other field (title, photos, option photos,
       catalog card image, documents, grouping/options, category, provenance) byte-for-byte as it is live;
     · every other page of the line is in the hash: if any page changes, the approval is invalid;
     · nothing commercial is touched (the dealer preview of the corrected line must show 0 commercial changes).
   It never needs, uses or spends an enrichment window. */
const CORRECTION_FIELDS = { description: ["description"], features: ["features", "clinical_applications"], specs: ["specs", "billing_codes"] };
const strv = v => String(v == null ? "" : v).trim();
function correctionFields(area, value){
  const v = value || {};
  if(area === "description") return { description: strv(v.text) || null };
  if(area === "features") return { features: (Array.isArray(v.items) ? v.items : []).map(strv).filter(Boolean), clinical_applications: [] };
  if(area === "specs") return { specs: (Array.isArray(v.items) ? v.items : []).filter(x => x && (strv(x.label) || strv(x.value))).map(x => ({ label: strv(x.label), value: strv(x.value) })), billing_codes: [] };
  return null;
}
/* Is this decision a usable correction regression_fix for this line? (null = yes) */
function correctionFixProblem(rf, slug){
  if(!rf) return "no such regression_fix";
  if(rf.kind !== "regression_fix") return "decision " + rf.id + " is a " + rf.kind + ", not a regression_fix";
  if(rf.manufacturer !== slug) return "regression_fix " + rf.id + " belongs to " + rf.manufacturer + ", not " + slug;
  if(rf.used_at) return "regression_fix " + rf.id + " is already used";
  const v = rf.hcps_value || {};
  if(v.scope !== "content_correction" || !v.page_key || !Array.isArray(v.areas) || !v.areas.length) return "regression_fix " + rf.id + " is not scoped to a published-page content correction";
  if(v.areas.some(a => !CORRECTION_FIELDS[a])) return "regression_fix " + rf.id + " names an area a correction cannot change";
  return null;
}
/* The latest correction text per area recorded under this regression_fix. */
function correctionsFor(decisions, rfId, pageKey){
  const out = {};
  (decisions || []).filter(d => d && d.kind === "content_approval" && d.field === "page:" + pageKey && d.hcps_value && Number(d.hcps_value.correction) === Number(rfId))
    .sort((a, b) => a.id - b.id).forEach(d => { out[d.hcps_value.area] = { id: d.id, value: d.hcps_value.value, from: d.hcps_value.from_decision || null, by: d.decided_by || null, at: d.decided_at || null }; });
  return out;
}
/* input: { slug, rf (the regression_fix decision), pages (enrichSummary pages), drafts (every product_content row of the
            line), records, meta, decisions, preview (buildPreview of the corrected line) }
   → { publishable, problems, page_key, name, before, after, changes, others, summary, plan_hash, approval } */
function correctionPlan(input){
  const { slug, rf, pages, drafts, records, meta, decisions, preview } = input;
  const problems = [];
  const rfp = correctionFixProblem(rf, slug);
  const scope = (rf && rf.hcps_value) || {};
  const pk = scope.page_key || null, areas = Array.isArray(scope.areas) ? scope.areas.slice() : [];
  const page = (pages || []).find(p => p.page_key === pk) || null;
  const row = (drafts || []).find(r => r && r.page_key === pk) || null;
  if(rfp) problems.push(rfp);
  if(!page) problems.push("the page " + pk + " is not one of this line's pages");
  else if(page.status !== "published") problems.push(page.name + " is not a published page (" + page.status + ")");
  if(!row) problems.push("no live row for " + pk);
  else if(!ENRICH.isVisibleRow(row)) problems.push(pk + ": the page is not visible — a correction changes a live page only");
  const corr = correctionsFor(decisions, rf && rf.id, pk);
  Object.keys(corr).forEach(a => { if(areas.indexOf(a) < 0) problems.push("a correction for " + a + " is outside regression_fix " + (rf && rf.id) + "'s scope"); });
  const after = row ? JSON.parse(JSON.stringify(row)) : null, changes = [];
  if(row){
    for(const a of areas){
      const c = corr[a];
      if(!c){ problems.push("no corrected text recorded for " + a); continue; }
      const f = correctionFields(a, c.value);
      if(!f){ problems.push("cannot correct " + a); continue; }
      if(a === "description" && !f.description) problems.push("the corrected description is empty");
      if(a === "features" && !f.features.length) problems.push("the corrected features are empty");
      if(a === "specs" && !f.specs.length) problems.push("the corrected specs are empty");
      Object.assign(after, f);
      changes.push({ area: a, decision: c.id, from: c.from, by: c.by, at: c.at, before: Object.fromEntries(Object.keys(f).map(k => [k, row[k] === undefined ? null : row[k]])), after: f });
    }
    /* the scope, proved on the rows themselves: only the named areas' fields differ */
    const allowed = new Set(areas.flatMap(a => CORRECTION_FIELDS[a] || []));
    const changed = [...new Set(Object.keys(row).concat(Object.keys(after)))].filter(k => canon(row[k]) !== canon(after[k]));
    const outside = changed.filter(k => !allowed.has(k));
    if(outside.length) problems.push("the correction would change fields outside its scope: " + outside.join(", "));
    const left = draftUrlsOf(after); if(left.length) problems.push("a draft-folder link is on the live page (" + left.length + ")");
  }
  const others = (drafts || []).filter(r => r && r.page_key !== pk).map(r => ({ page_key: r.page_key, row: r }));
  const visible = (drafts || []).filter(r => r && ENRICH.isVisibleRow(r)).map(r => r.page_key).sort();
  const held = (pages || []).filter(p => p.page_key !== pk && p.status !== "published" && p.status !== "ready");
  const awaiting = (pages || []).filter(p => p.page_key !== pk && p.status === "ready");
  if(!preview) problems.push("no dealer preview of the correction");
  else if(preview.pass !== true) problems.push("the dealer preview of the correction fails: " + preview.checks.filter(c => !c.pass).map(c => c.id).join(", "));
  const s = preview ? preview.summary : {};
  const summary = { cards_today: s.cards_today, cards_after: s.cards_proposed, active_skus: s.active_skus, accounted: s.accounted, missing: s.missing,
    duplicates: s.duplicates, commercial_changes: s.commercial_changes, retired_excluded: s.retired_excluded || [],
    pages_corrected: row ? 1 : 0, other_pages_unchanged: others.length, live_pages: visible.length, photos_promoted: 0 };
  /* (the approval itself and its regression_fix are not hashed as decisions: the approval is recorded after the dry run,
     and the fix is checked unspent on every step; its scope is hashed) */
  const HASHED_KINDS = ["content_resolution", "enrichment_window", "content_approval"];
  const lineDecisions = (decisions || []).filter(d => d && HASHED_KINDS.indexOf(d.kind) >= 0)
    .map(d => [d.id, d.kind, d.field, d.hcps_value, d.used_at || null]).sort((a, b) => a[0] - b[0]);
  const hashed = { v: "correction-1", slug, regression_fix: rf ? [rf.id, rf.hcps_value || null] : null, page_key: pk, areas, before: row, after,
    others: others.map(o => [o.page_key, o.row]), decisions: lineDecisions,
    records: (records || []).slice().sort((a, b) => String(a.code).localeCompare(String(b.code))),
    meta: meta ? { enriched_only: meta.enriched_only === true, category_map: meta.category_map || null, freight_terms: meta.freight_terms || null, frozen: meta.frozen === true } : null,
    preview: preview ? { summary: preview.summary, skus: preview.skus, checks: preview.checks.map(c => [c.id, c.pass]) } : null };
  const plan_hash = sha256(canon(hashed));
  const approval = { plan_hash, window: null, pages: pk ? [pk] : [],
    correction: { regression_fix: rf ? rf.id : null, page_key: pk, page_name: page ? page.name : null, areas, from: Object.fromEntries(changes.map(c => [c.area, c.decision])) },
    before: pk && row ? { [pk]: row } : {}, after: pk && after ? { [pk]: after } : {}, promote: [],
    held: held.map(h => ({ page_key: h.page_key, name: h.name, skus: h.skus.map(x => x.code), issues: (h.issues || []).map(i => i.title), holds: [] })),
    awaiting: awaiting.map(h => ({ page_key: h.page_key, name: h.name, skus: h.skus.map(x => x.code), waiting: ["(not in this correction)"] })),
    live_before: visible.filter(k => k !== pk), summary };
  return { publishable: !problems.length, problems, page_key: pk, name: page ? page.name : null, before: row, after, changes, others, summary, plan_hash, approval };
}

/* The pages that must be visible after a publication (or correction) is carried out: the ones it publishes plus the
   ones that were already live before it (an approval recorded before 2026-10-12 has no live_before: its pages only). */
function expectedVisible(approval){
  const a = approval || {};
  return [...new Set((Array.isArray(a.pages) ? a.pages : []).concat(Array.isArray(a.live_before) ? a.live_before : []))].sort();
}
/* The plan pages as the dealer preview of a publication must read them (Angelo 2026-10-12, runs #17–#19): a Ready page
   that is NOT in this publication keeps its current catalog cards — Waiting / unchanged, never "missing / 0 cards". */
function pagesForPublication(pages, publishedKeys){
  const keys = new Set(publishedKeys || []);
  return (pages || []).map(p => p && p.status === "ready" && !keys.has(p.page_key) ? Object.assign({}, p, { status: "waiting_for_approval" }) : p);
}

/* After publishing: the live dealer view must be exactly the approved one. */
function liveMatchesPlan(expectedProducts, liveProducts){
  const strip = list => (list || []).map(p => { const o = {}; Object.keys(p || {}).sort().forEach(k => { if(typeof p[k] !== "function" && k !== "_unlinked") o[k] = p[k]; }); return o; })
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const a = strip(expectedProducts), b = strip(liveProducts), diffs = [];
  const by = l => Object.fromEntries(l.map(p => [String(p.code), p]));
  const A = by(a), B = by(b);
  new Set(Object.keys(A).concat(Object.keys(B))).forEach(c => { if(canon(A[c]) !== canon(B[c])){
    const ks = [...new Set(Object.keys(A[c] || {}).concat(Object.keys(B[c] || {})))].filter(k => canon((A[c] || {})[k]) !== canon((B[c] || {})[k]));
    diffs.push({ code: c, fields: ks.length ? ks : ["(missing)"] }); } });
  const draftLinks = (JSON.stringify(liveProducts).match(/https?:[^"]*\/drafts\/w\d+\/[^"]*/g) || []);
  return { same: !diffs.length, diffs, draft_links: draftLinks };
}

module.exports = { buildPlan, planReport, expectedVisible, pagesForPublication, correctionPlan, correctionFields, correctionFixProblem, correctionsFor, CORRECTION_FIELDS, planImages, draftUrlsOf, isDraftUrl, livePath, liveMatchesPlan, canon, sha256, DRAFT_RE };
