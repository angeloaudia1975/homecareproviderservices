/* BULK CATALOG CORRECTIONS (Batch 2, 2026-10-26; tracker homecareproviderservices#42). Pure: no database, no network.

   It turns the Catalog Exceptions queue into a CORRECTION PLAN the President can filter (manufacturer, category,
   part number), preview and apply. Each proposal shows the original value, the proposed value, the evidence it
   rests on, how many SKUs it touches and the existing tool that owns the write.

   What this module may propose to APPLY is deliberately narrow — review decisions that change nothing a dealer
   sees, recorded append-only in mfr_decisions (kind "exception", field "catalog:<kind>", the same table and
   history Manufacturer Center uses):
     catalog:duplicate_code  a part number listed more than once is classified from the catalog rows themselves:
                             repeated_record (identical rows), cross_listing (same product in two sections — only
                             category / subcategory / family differ) or shared_part (the same part filed under two
                             models — names differ only by words naming the model's own section). Anything else
                             differs (unit, brand, UPC, photo, size…) = conflict: a possible mapping error that only
                             the owner can resolve, so it is NEVER applied from here. Nothing is ever deleted.
     catalog:image_status    a missing photo's review state: source_requested (no official photo held) or
                             candidate_same_part (a photo is already shown for this exact part number on another
                             listing). Photos are never assigned here — rights stay unresolved and the code stays
                             in the queue until the photo is approved and placed in Product Images.
   Everything else (prices, units, content, categories, page assignments, freight, retired items) is listed with
   its evidence and a link to the tool that owns it, never applied here: commercial facts come only from
   Manufacturer Center sources; content from Product Enrichment; a frozen Gold Standard line only through a
   recorded regression fix.

   Undo: decisions are never edited or deleted. A later decision on the same line + field + part number with
   status "reopened" supersedes it (latest wins), and the code returns to the queue.

   NEVER a price: inputs carry no commercial value; outputs carry codes, sections, names and counts only. */
const crypto = require("crypto");

const CLASSES = { repeated_record: "Repeated record (identical rows)", cross_listing: "Cross-listing (same product in two sections)",
  shared_part: "Shared part (one part number filed under two models)", conflict: "Conflict — possible mapping error" };
const ACCEPTED = new Set(["repeated_record", "cross_listing", "shared_part"]);
const IMAGE_STATUS = { source_requested: "Official photo requested — rights pending", candidate_same_part: "Photo already shown for this part number — approve in Product Images" };
const PLACEMENT = ["category", "subcategory", "family"];
/* Non-commercial identity fields compared between two rows of one part number. Never a price field. */
const IDENTITY = ["name", "category", "subcategory", "family", "uom", "brand", "upc", "hcpc", "image", "size", "qty_per_pack",
  "alt_code", "rise", "length_ft", "width_in", "weight_lb", "details_url"];
const FIELD = { duplicate: "catalog:duplicate_code", image: "catalog:image_status" };
const norm = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const val = v => v == null ? "" : String(v).trim();
const words = s => new Set(val(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/* rows: every catalog row of one part number on one line (two or more). */
function classifyDuplicate(rows) {
  const rs = (rows || []).filter(Boolean);
  const differs = IDENTITY.filter(f => new Set(rs.map(r => val(r[f]))).size > 1);
  const sections = rs.map(r => [val(r.category), val(r.subcategory)].filter(Boolean).join(" › ") || "(no section)");
  if (!differs.length) return { classification: "repeated_record", differs, sections };
  if (differs.every(f => PLACEMENT.includes(f))) return { classification: "cross_listing", differs, sections };
  if (differs.every(f => PLACEMENT.includes(f) || f === "name") && rs.length >= 2) {
    /* Each row's extra name words must all name its own section (e.g. "Lite" in "Zen-O Lite"). */
    let extra = 0;
    const named = rs.every(r => {
      const others = new Set(); rs.filter(x => x !== r).forEach(x => words(x.name).forEach(w => others.add(w)));
      const sec = new Set([...words(r.category), ...words(r.subcategory), ...words(r.family)]);
      const own = [...words(r.name)].filter(w => !others.has(w)); extra += own.length;
      return own.every(w => sec.has(w));
    });
    if (named && extra > 0) return { classification: "shared_part", differs, sections };
  }
  return { classification: "conflict", differs, sections };
}

/* Latest decision per manufacturer + field + normalised code (append-only history, latest wins). */
function latestReviews(decisions) {
  const out = {};
  for (const d of (decisions || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0))) {
    if (!d || !/^catalog:/.test(String(d.field || "")) || !d.code) continue;
    out[d.manufacturer + "|" + d.field + "|" + norm(d.code)] = d;
  }
  return out;
}
function reviewOf(reviews, slug, field, code) { return (reviews || {})[slug + "|" + field + "|" + norm(code)] || null; }
function reviewStatus(d) { const v = d && d.hcps_value; return v && (v.classification || v.status) || null; }

/* A duplicate code is settled when its latest review accepts a non-conflict classification. */
function duplicateSettled(reviews, slug, code) {
  const d = reviewOf(reviews, slug, FIELD.duplicate, code);
  return !!(d && ACCEPTED.has(reviewStatus(d)));
}

const TOOL = {
  pricing: ["Manufacturer Center → Sources", s => "/admin/manufacturer-center.html#line=" + encodeURIComponent(s)],
  units: ["Manufacturer Center → Commercial", s => "/admin/manufacturer-center.html#line=" + encodeURIComponent(s) + "&tab=commercial"],
  content: ["Manufacturer Center → Continue Product Enrichment", s => "/admin/manufacturer-center.html#line=" + encodeURIComponent(s)],
  images: ["Product Images", s => "/admin/images.html#manufacturer=" + encodeURIComponent(s)],
  freight: ["Manufacturer Center → Commercial & freight", s => "/admin/manufacturer-center.html#line=" + encodeURIComponent(s) + "&tab=commercial"],
  retired: ["Product Catalog", s => "/admin/catalog.html#manufacturer=" + encodeURIComponent(s)],
  sku: ["Product Catalog", s => "/admin/catalog.html#manufacturer=" + encodeURIComponent(s)],
  frozen: ["Manufacturer Center → Decisions (regression fix)", s => "/admin/manufacturer-center.html#line=" + encodeURIComponent(s) + "&tab=decisions"],
};
const link = (k, s) => ({ tool: TOOL[k][0], href: TOOL[k][1](s) });

/* input: { queue (exceptionsQueue output), rows: {slug: [catalog rows, non-commercial fields]}, decisions,
            filter: {manufacturers?:[], categories?:[], codes?:[]} }
   output: { proposals:[...], plan_hash, counts } */
function buildPlan(input) {
  const i = input || {}, q = i.queue || { lines: [] }, f = i.filter || {};
  const reviews = latestReviews(i.decisions);
  const wantM = new Set((f.manufacturers || []).filter(Boolean)), wantC = new Set((f.categories || []).filter(Boolean));
  const wantK = new Set((f.codes || []).map(norm).filter(Boolean));
  const proposals = [];
  const push = p => { if (wantC.size && !wantC.has(p.cat)) return;
    if (wantK.size && !(p.codes || []).some(c => wantK.has(norm(c)))) return; proposals.push(p); };
  for (const l of q.lines || []) {
    if (wantM.size && !wantM.has(l.slug)) continue;
    const rows = (i.rows || {})[l.slug] || [];
    for (const x of l.items || []) {
      if (x.severity === "info" && x.cat !== "sku") continue;
      if (x.cat === "ready") continue;
      /* A part number printed twice is named twice by readiness — one proposal per part number. */
      const seen = new Set(), codes = (Array.isArray(x.codes) ? x.codes : []).filter(c => { const k = norm(c); if (seen.has(k)) return false; seen.add(k); return true; });
      if (l.frozen) {
        push({ id: `${l.slug}:${x.check}`, manufacturer: l.slug, cat: x.cat, kind: "frozen_line", codes, affected: x.count || codes.length || 1,
          original: x.detail, proposed: "No change from here — this line is frozen (Gold Standard).",
          evidence: [`${l.name} is a frozen Gold Standard line; any correction needs an isolated regression-fix decision and a passing fingerprint verification.`],
          supported: false, blocked: "frozen", ...link("frozen", l.slug) });
        continue;
      }
      if (x.check === "catalog_duplicate_codes") {
        for (const code of codes) {
          const same = rows.filter(r => r && norm(r.code) === norm(code));
          const c = classifyDuplicate(same), cur = reviewOf(reviews, l.slug, FIELD.duplicate, code);
          const settled = cur && ACCEPTED.has(reviewStatus(cur));
          push({ id: `${l.slug}:dup:${norm(code)}`, manufacturer: l.slug, cat: "sku", kind: "duplicate_classification", codes: [code],
            affected: 1, field: FIELD.duplicate,
            original: `${code} is listed ${same.length} times: ${c.sections.join(" · ")}`,
            proposed: c.classification === "conflict"
              ? `Needs the owner's decision — the listings differ in ${c.differs.join(", ")} (possible mapping error). Nothing is changed or deleted.`
              : `Record as “${CLASSES[c.classification]}”; keep every listing (nothing deleted).`,
            classification: c.classification, differs: c.differs,
            evidence: same.map(r => `${val(r.name)} — ${[val(r.category), val(r.subcategory)].filter(Boolean).join(" › ") || "(no section)"}${r.uom ? " · " + val(r.uom) : ""}${r.family ? " · family " + val(r.family) : ""}`)
              .concat(c.differs.length ? [`Fields that differ: ${c.differs.join(", ")}`] : ["Every identity field is identical."]),
            current: cur ? { decision_id: cur.id, status: reviewStatus(cur), by: cur.decided_by, at: cur.decided_at } : null,
            supported: c.classification !== "conflict" && !settled,
            blocked: c.classification === "conflict" ? "owner_decision" : (settled ? "already_recorded" : null), ...link("sku", l.slug) });
        }
        continue;
      }
      if (x.cat === "images" && codes.length && /without_image|without_photo|file_missing/.test(x.check)) {
        for (const code of codes) {
          const same = rows.filter(r => r && norm(r.code) === norm(code));
          const shown = same.map(r => val(r.image)).filter(Boolean);
          const status = shown.length ? "candidate_same_part" : "source_requested";
          const cur = reviewOf(reviews, l.slug, FIELD.image, code);
          push({ id: `${l.slug}:img:${norm(code)}:${x.check}`, manufacturer: l.slug, cat: "images", kind: "image_status", codes: [code], affected: 1,
            field: FIELD.image, original: x.check === "page_without_photo" ? `Page ${code} has no main photo` : `${code} has no photo`,
            proposed: `Record review status “${IMAGE_STATUS[status]}”. The code stays in the queue until a photo with recorded rights is placed in Product Images.`,
            status, candidates: shown.slice(0, 3),
            evidence: shown.length ? [`Already shown for ${code} on another listing: ${shown[0]}`] : [`No photo is held for ${code} in the catalog file or the saved catalog layers.`],
            current: cur ? { decision_id: cur.id, status: reviewStatus(cur), by: cur.decided_by, at: cur.decided_at } : null,
            supported: !(cur && reviewStatus(cur) === status), blocked: cur && reviewStatus(cur) === status ? "already_recorded" : null, ...link("images", l.slug) });
        }
        continue;
      }
      /* Everything else: evidence + the owning tool; never applied here. */
      const why = { pricing: "Commercial facts come only from an accepted manufacturer source in Manufacturer Center — never inferred.",
        units: "Units and case quantities change only from an authoritative manufacturer source (Manufacturer Center).",
        content: "Descriptions, specifications, categories and page assignments come only from manufacturer-official sources through Product Enrichment, with President approval.",
        freight: "Freight terms change only from a recorded source or decision (Manufacturer Center).",
        retired: "Retired / not-offered state changes only through Product Catalog with a recorded reason.",
        sku: "Part-number structure changes only through Product Catalog (rename keeps contract prices).", images: "Photos are placed only through Product Images once rights are recorded." }[x.cat] || "Owned by another tool.";
      push({ id: `${l.slug}:${x.check}`, manufacturer: l.slug, cat: x.cat, kind: "handoff", codes, affected: x.count || codes.length || 1,
        original: x.detail, proposed: "Resolve in " + (TOOL[x.cat] || TOOL.sku)[0] + ".", evidence: [why],
        supported: false, blocked: "owning_tool", ...link(TOOL[x.cat] ? x.cat : "sku", l.slug) });
    }
  }
  proposals.sort((a, b) => (a.manufacturer + a.cat + a.id).localeCompare(b.manufacturer + b.cat + b.id));
  const plan_hash = planHash(proposals);
  const counts = { total: proposals.length, applicable: proposals.filter(p => p.supported).length,
    owner_decision: proposals.filter(p => p.blocked === "owner_decision").length, frozen: proposals.filter(p => p.blocked === "frozen").length,
    handoff: proposals.filter(p => p.blocked === "owning_tool").length, already_recorded: proposals.filter(p => p.blocked === "already_recorded").length,
    affected_skus: proposals.filter(p => p.supported).reduce((n, p) => n + p.affected, 0) };
  return { proposals, plan_hash, counts };
}
function planHash(proposals) {
  const core = (proposals || []).filter(p => p.supported).map(p => [p.id, p.kind, p.classification || p.status || "", (p.codes || []).join(","), p.current ? p.current.decision_id : 0]);
  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

/* The mfr_decisions row a supported proposal records. Refuses anything this module may not apply. */
function decisionFor(p, actor, reason) {
  if (!p || !p.supported) throw new Error("not_applicable");
  if (!reason || String(reason).trim().length < 5) throw new Error("reason_required");
  const base = { manufacturer: p.manufacturer, kind: "exception", field: p.field, code: String(p.codes[0]).slice(0, 80),
    reason: String(reason).trim().slice(0, 2000), decided_by: String(actor || "president").slice(0, 80), source_id: null,
    supersedes_id: p.current && p.current.decision_id ? p.current.decision_id : null };
  if (p.kind === "duplicate_classification") {
    if (!ACCEPTED.has(p.classification)) throw new Error("owner_decision");
    return Object.assign(base, { manufacturer_value: { listings: p.evidence.slice(0, 10) },
      hcps_value: { classification: p.classification, differs: p.differs, keep_all_listings: true, plan_id: p.id } });
  }
  if (p.kind === "image_status") {
    if (!IMAGE_STATUS[p.status]) throw new Error("bad_status");
    return Object.assign(base, { manufacturer_value: null, hcps_value: { status: p.status, candidates: p.candidates || [], rights: "unresolved", plan_id: p.id } });
  }
  throw new Error("not_applicable");
}
/* Undo = a superseding decision; the original stays in history. */
function reopenFor(decision, actor, reason) {
  if (!decision || !/^catalog:/.test(String(decision.field || ""))) throw new Error("not_a_correction");
  if (!reason || String(reason).trim().length < 5) throw new Error("reason_required");
  return { manufacturer: decision.manufacturer, kind: "exception", field: decision.field, code: decision.code,
    reason: String(reason).trim().slice(0, 2000), decided_by: String(actor || "president").slice(0, 80), source_id: null,
    supersedes_id: decision.id, manufacturer_value: null, hcps_value: { status: "reopened" } };
}

module.exports = { classifyDuplicate, latestReviews, reviewOf, reviewStatus, duplicateSettled, buildPlan, planHash, decisionFor, reopenFor,
  CLASSES, IMAGE_STATUS, ACCEPTED, FIELD, IDENTITY };
