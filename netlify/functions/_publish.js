/* MANUFACTURER CENTER RELEASE D — PUBLISH & VERIFY: the publication plan (pure; approved to build 2026-10-11).

   The dry run Angelo approves. From the line's enrichment state it derives, deterministically:
     · WHAT is published: only pages whose Review Issues status is Ready. A held page (or any page that is not Ready) is
       never in a plan, whatever window built it;
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
    if(!isDraftUrl(u)) return u;
    const me = I(u); if(!me) return u;
    const same = gal.find(g => I(g.url) && I(g.url).sha === me.sha) || gal.find(g => I(g.url) && stem(g.url) === stem(u));
    return same ? same.url : u;
  };
  const toLive = {}, promote = {}, deduped = [];
  const live = u => {
    if(!isDraftUrl(u)) return u;
    const c = canonOf(u), m = I(c);
    if(!m || !m.sha) throw new Error("no fingerprint for photo " + c);
    const path = livePath(slug, pk, m.sha, extOf(c, m.type)), url = publicBase + path;
    if(c !== u) deduped.push({ from: u, same_as: c, why: I(u) && I(u).sha === m.sha ? "same bytes" : "same picture at another size" });
    toLive[u] = url;
    if(!promote[path]) promote[path] = { from: c, to: url, path, sha: m.sha, bytes: m.bytes || null, type: m.type || null, uses: [] };
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
  return { after: { status: "published", disabled: false, draft_window: null, image, images_gallery: gallery, skus },
    promote: Object.values(promote), deduped, mapping: toLive };
}

/* input: { slug, window, publicBase (…/storage/v1/object/public/product-content/), pages (enrichSummary pages),
            drafts (product_content rows of the line), records, meta, decisions, info (photo fingerprints),
            preview (buildPreview output for the AFTER rows) }
   → { publishable, problems, ready:[…], held:[…], summary, plan_hash, approval } */
function buildPlan(input){
  const { slug, pages, drafts, records, meta, decisions, info, preview } = input;
  const problems = [];
  const ready = (pages || []).filter(p => p.status === "ready"), held = (pages || []).filter(p => p.status !== "ready");
  const rowOf = k => (drafts || []).find(r => r && r.page_key === k) || null;
  const readyOut = [];
  for(const p of ready){
    const row = rowOf(p.page_key);
    if(!row){ problems.push(p.name + ": no draft row"); continue; }
    if(ENRICH.isVisibleRow(row)){ problems.push(p.name + ": already visible — enrichment never re-publishes a live page"); continue; }
    if(input.window && row.draft_window != null && String(row.draft_window) !== String(input.window)) problems.push(p.name + ": built under window " + row.draft_window + ", not the open window " + input.window);
    let im; try{ im = planImages(slug, row, info || {}, input.publicBase); }catch(e){ problems.push(p.name + ": " + e.message); continue; }
    const left = draftUrlsOf(Object.assign({}, row, im.after, { options: row.options }));
    const optLeft = draftUrlsOf({ options: row.options });
    if(optLeft.length) problems.push(p.name + ": an option swatch points at a draft photo (" + optLeft.length + ")");
    if(left.length && !optLeft.length) problems.push(p.name + ": a draft-folder link would remain");
    readyOut.push({ page_key: p.page_key, name: p.name, skus: p.skus.map(s => s.code), before: row, after: im.after, promote: im.promote, deduped: im.deduped,
      changes: { status: (row.status || "") + " → published", draft_window: (row.draft_window == null ? "none" : row.draft_window) + " → cleared",
        photos: draftUrlsOf(row).length + " draft links → " + im.promote.length + " live copies" } });
  }
  const heldOut = held.map(p => ({ page_key: p.page_key, name: p.name, status: p.status, skus: p.skus.map(s => s.code),
    issues: (p.issues || []).map(i => i.title), holds: Object.keys(p.resolutions || {}).map(k => k + ":" + p.resolutions[k].choice + "#" + p.resolutions[k].id),
    row: rowOf(p.page_key) }));
  if(!readyOut.length) problems.push("no Ready page to publish");
  heldOut.forEach(h => { if(h.row && ENRICH.isVisibleRow(h.row)) problems.push(h.name + ": a held page is visible"); });
  if(!preview) problems.push("no dealer preview of the publication");
  else if(!preview.pass) problems.push("the dealer preview of the publication fails: " + preview.checks.filter(c => !c.pass).map(c => c.id).join(", "));
  const s = preview ? preview.summary : {};
  const summary = { cards_today: s.cards_today, cards_after: s.cards_proposed, active_skus: s.active_skus, accounted: s.accounted, missing: s.missing,
    duplicates: s.duplicates, commercial_changes: s.commercial_changes, retired_excluded: s.retired_excluded || [],
    enriched_pages_live: readyOut.length, held_on_current_cards: heldOut.length,
    photos_promoted: readyOut.reduce((n, r) => n + r.promote.length, 0), duplicates_removed: readyOut.reduce((n, r) => n + r.deduped.length, 0) };
  const lineDecisions = (decisions || []).filter(d => d && (d.kind === "content_resolution" || d.kind === "enrichment_window"))
    .map(d => [d.id, d.kind, d.field, d.hcps_value, d.used_at || null]).sort((a, b) => a[0] - b[0]);
  const hashed = { v: 1, slug, window: input.window || null,
    ready: readyOut.map(r => ({ page_key: r.page_key, before: r.before, after: r.after, promote: r.promote.map(x => [x.from, x.path, x.sha]) })),
    held: heldOut.map(h => ({ page_key: h.page_key, status: h.status, issues: h.issues, holds: h.holds, row: h.row })),
    decisions: lineDecisions, records: (records || []).slice().sort((a, b) => String(a.code).localeCompare(String(b.code))),
    meta: meta ? { enriched_only: meta.enriched_only === true, category_map: meta.category_map || null, freight_terms: meta.freight_terms || null, frozen: meta.frozen === true } : null,
    preview: preview ? { summary: preview.summary, skus: preview.skus, checks: preview.checks.map(c => [c.id, c.pass]) } : null };
  const plan_hash = sha256(canon(hashed));
  const approval = { plan_hash, window: input.window || null, pages: readyOut.map(r => r.page_key),
    before: Object.fromEntries(readyOut.map(r => [r.page_key, r.before])), after: Object.fromEntries(readyOut.map(r => [r.page_key, r.after])),
    promote: readyOut.flatMap(r => r.promote.map(x => ({ page_key: r.page_key, from: x.from, to: x.to, path: x.path, sha: x.sha }))),
    held: heldOut.map(h => ({ page_key: h.page_key, name: h.name, skus: h.skus, issues: h.issues, holds: h.holds })), summary };
  return { publishable: !problems.length, problems, ready: readyOut, held: heldOut, summary, plan_hash, approval };
}

/* The report Angelo reads (no raw rows). */
function planReport(plan){
  return { publishable: plan.publishable, problems: plan.problems, plan_hash: plan.plan_hash, summary: plan.summary,
    ready: plan.ready.map(r => ({ page_key: r.page_key, name: r.name, skus: r.skus, changes: r.changes,
      promote: r.promote.map(x => ({ from: x.from, to: x.to, sha: x.sha.slice(0, 16), uses: x.uses })), deduped: r.deduped,
      after_photos: { main: r.after.image, gallery: r.after.images_gallery.map(g => g.url), options: r.after.skus.filter(s => s.image).map(s => ({ sku: s.sku, option: s.size || "", image: s.image })) } })),
    held: plan.held.map(h => ({ page_key: h.page_key, name: h.name, status: h.status, skus: h.skus, issues: h.issues, holds: h.holds })) };
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

module.exports = { buildPlan, planReport, planImages, draftUrlsOf, isDraftUrl, livePath, liveMatchesPlan, canon, sha256, DRAFT_RE };
