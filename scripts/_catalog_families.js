/* HCPS Product Enrichment — parent product families (owner, 2026-10-31, Access4U; tracker #42).
   One dealer card per meaningful product family; every size / width / configuration is chosen INSIDE the product
   page, and each choice is one exact, source-backed SKU. Rules live with the line's content corrections, in
   content-overrides/<slug>.json "_families", so they are data, re-applied on every enrichment run and on every new
   manufacturer price list: a new SKU that matches a rule joins its family automatically; a SKU that matches no rule
   keeps its own page, as before. Nothing here reads or writes a price — pricing stays on the catalog rows and the
   private price record, keyed by the SKU, so grouping can never change what a SKU costs.

   A rule:
     { "key": "assist-ramps",                          the family page key (stable)
       "name": "Assist Ramp With Handrails",           the card / page name
       "match": { "family": ["AST"] } | { "code_re": "^AST\\d" },   which catalog rows belong
       "axes": [ { "name": "Length", "on": "code", "re": "^AST(\\d+)x", "fmt": "{ft1} ft ({1}\")" },
                 { "name": "Width",  "on": "code", "re": "x(\\d+)$",    "fmt": "{1}\" wide" } ],
       "specs": [ { "label": "Rise", "field": "rise", "fmt": "{v}\"" } ],     per-SKU specification rows
       "content_from": "<existing page key>",           whose words / photos / documents the family keeps
       "description": "…",                              optional: replaces the description (source-backed words only)
       "option_images": { "CODE": "<url>" | {"url","note"} | "none" }   owner-confirmed photo per option, or none
     }
   Axis values come from the SKU's own code or catalog name (never invented); "labels": {"CODE": "text"} may name
   one value by hand. Values sort by their number (fractions understood: 1/2 < 3/4 < 1 < 1 1/4). Two SKUs of one
   family that would show the same combination are an error, reported and never silently merged. */
const codeNorm = s => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const clone = v => JSON.parse(JSON.stringify(v));

/* "1 1/2" → 1.5, "3/4" → 0.75, "5.5" → 5.5, "7 - 14" → 7 */
function num(s) {
  const t = String(s == null ? "" : s);
  const m = /(\d+)\s+(\d+)\/(\d+)|(\d+)\/(\d+)|(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return NaN;
  if (m[1]) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  if (m[4]) return Number(m[4]) / Number(m[5]);
  return Number(m[6]);
}
const fmtNum = n => (Math.round(n * 100) / 100).toString();

function fill(fmt, groups, row) {
  return String(fmt).replace(/\{(ft|in)?(\d)\}|\{v\}|\{field:([a-z_]+)\}/g, (all, unit, i, field) => {
    if (field) return row[field] == null ? "" : String(row[field]);
    if (all === "{v}") return groups[0] == null ? "" : String(groups[0]);
    const g = groups[Number(i)];
    if (g == null) return "";
    if (unit === "ft") return fmtNum(num(g) / 12);
    return String(g);
  }).replace(/\s{2,}/g, " ").trim();
}

function axisValue(rule, ax, row) {
  if (ax.labels && ax.labels[row.code] != null) return { label: String(ax.labels[row.code]), key: num(ax.labels[row.code]) };
  if (ax.field) {
    const v = row[ax.field]; if (v == null || v === "") return null;
    return { label: fill(ax.fmt || "{v}", [String(v)], row), key: num(v) };
  }
  const src = ax.on === "name" ? String(row.name || "") : String(row.code || "");
  const m = new RegExp(ax.re, "i").exec(src); if (!m) return null;
  return { label: fill(ax.fmt || "{1}", m, row), key: num(m[1]) };
}

function specRows(rule, row) {
  const out = [];
  for (const sp of rule.specs || []) {
    let v = null;
    if (sp.field) { const x = row[sp.field]; if (x != null && x !== "") v = fill(sp.fmt || "{v}", [String(x)], row); }
    else if (sp.re) { const m = new RegExp(sp.re, "i").exec(String(sp.on === "name" ? row.name : row.code) || ""); if (m) v = fill(sp.fmt || "{1}", m, row); }
    if (v) out.push({ label: sp.label, value: v });
  }
  return out;
}

function matches(rule, row) {
  const m = rule.match || {};
  if (m.family && !m.family.map(String).includes(String(row.family || ""))) return false;
  if (m.code_re && !new RegExp(m.code_re, "i").test(String(row.code || ""))) return false;
  if (m.name_re && !new RegExp(m.name_re, "i").test(String(row.name || ""))) return false;
  return !!(m.family || m.code_re || m.name_re);
}

/* Regroup pages by the rules. Returns {log, problems}. Pages are changed in place. */
function applyFamilies(pages, catalog, rules, log) {
  log = log || {}; const problems = [];
  const say = (k, m) => { (log[k] = log[k] || []).push(m); };
  if (!Array.isArray(rules) || !rules.length) return { log, problems };
  const where = () => { const w = {}; for (const [k, p] of Object.entries(pages)) for (const s of p.skus || []) w[codeNorm(s.sku)] = k; return w; };
  const claimed = new Set();
  for (const rule of rules) {
    const members = catalog.filter(r => matches(rule, r) && !claimed.has(codeNorm(r.code)));
    if (!members.length) { problems.push({ family: rule.key, problem: "no catalog SKU matches this family" }); continue; }
    members.forEach(r => claimed.add(codeNorm(r.code)));
    const w = where();
    const srcKeys = [...new Set(members.map(r => w[codeNorm(r.code)]).filter(Boolean))];
    const count = k => members.filter(r => w[codeNorm(r.code)] === k).length;
    const leadKey = pages[rule.key] ? rule.key : (rule.content_from && pages[rule.content_from]) ? rule.content_from
      : srcKeys.slice().sort((a, b) => count(b) - count(a))[0];
    const lead = leadKey ? pages[leadKey] : null;
    const entries = {};
    for (const k of srcKeys) for (const s of pages[k].skus || []) entries[codeNorm(s.sku)] = s;
    /* "option_photos": a member that came from its own product page keeps that page's photo as its OPTION photo
       (a gate stays pictured as the gate inside an accessories family); a member whose page had no photo has none —
       the family photo shows, never another option's picture */
    const optPhoto = {};
    if (rule.option_photos) for (const k of srcKeys) { const pg = pages[k]; if (k === rule.key) continue;
      const allMembers = (pg.skus || []).every(s => members.some(r => codeNorm(r.code) === codeNorm(s.sku)));
      const prim = pg.image || ((pg.images_gallery || []).find(g => g.primary) || (pg.images_gallery || [])[0] || {}).url;
      if (allMembers && prim) for (const s of pg.skus || []) optPhoto[codeNorm(s.sku)] = prim; }
    const page = lead ? clone(lead) : { manufacturer: "", status: "published", description: "", features: [], specs: [], images_gallery: [], image: null, documents: [], videos: [] };
    page.page_key = rule.key; page.name = rule.name;
    if (rule.description) page.description = rule.description;
    if (rule.category) page.category = rule.category;
    page.options = {};
    page.group_reason = "family rule " + rule.key + " (content-overrides _families)";
    /* SKUs with their axes, in axis order */
    const combos = new Map();
    const skus = members.map(r => {
      const axes = {}, keys = [];
      for (const ax of rule.axes || []) {
        const v = axisValue(rule, ax, r);
        if (!v) { problems.push({ family: rule.key, sku: r.code, problem: "axis " + ax.name + " not readable from " + (ax.field || ax.on || "code") }); continue; }
        axes[ax.name] = v.label; keys.push(isNaN(v.key) ? 1e9 : v.key);
      }
      const combo = JSON.stringify(axes);
      if (combos.has(combo)) problems.push({ family: rule.key, sku: r.code, problem: "same choice as " + combos.get(combo) + ": " + combo });
      else combos.set(combo, r.code);
      const prev = entries[codeNorm(r.code)] || {};
      const label = Object.values(axes).join(" · ");
      /* "option_images": {CODE: url | {url, note} | "none"} — an owner-confirmed photo for exactly this option, or "none"
         when no exact photo exists (the storefront then says "Image not available for this option" and never borrows
         another option's or the family's picture). It wins over any photo the option carried before. */
      const oi = rule.option_images ? (rule.option_images[r.code] != null ? rule.option_images[r.code] : rule.option_images[codeNorm(r.code)]) : null;
      const oiUrl = oi == null ? null : (typeof oi === "string" ? oi : oi.url || "none");
      const e = Object.assign({}, prev, { sku: r.code, name: r.name, size: label || prev.size || r.name, axes, specs: specRows(rule, r),
        status: prev.status || "active", disabled: !!prev.disabled, image: oiUrl != null ? oiUrl : (prev.image || optPhoto[codeNorm(r.code)] || ""), images: prev.images || [], source: prev.source || "" });
      if (oi && typeof oi === "object" && oi.note) e.image_note = oi.note; else delete e.image_note;
      return { e, keys };
    });
    const nAx = (rule.axes || []).length;
    const ord = Array.isArray(rule.order) ? rule.order.map(codeNorm) : null;   /* an explicit option order, when given */
    if (ord) skus.forEach(x => { const i = ord.indexOf(codeNorm(x.e.sku)); x.keys = [i < 0 ? 1e9 : i]; });
    skus.sort((a, b) => { for (let i = 0; i < (ord ? 1 : nAx); i++) { const d = (a.keys[i] || 0) - (b.keys[i] || 0); if (d) return d; } return 0; });
    page.skus = skus.map(x => x.e); page.sku_count = page.skus.length;
    /* photos: the lead's gallery first, then the other merged pages' (never a page outside the family) */
    const gal = [], seen = new Set();
    for (const k of [leadKey].concat(srcKeys.filter(k => k !== leadKey))) for (const g of ((pages[k] || {}).images_gallery || [])) if (g && g.url && !seen.has(g.url)) { seen.add(g.url); gal.push(Object.assign({}, g, { primary: false })); }
    /* the family's hero: rule.primary_image when it is in the gallery, else the lead page's photo */
    if (gal.length) { let pi = rule.primary_image ? gal.findIndex(g => g.url === rule.primary_image) : -1;
      if (pi < 0) pi = Math.max(0, gal.findIndex(g => g.url === (lead && lead.image))); gal[pi].primary = true; gal.unshift(gal.splice(pi, 1)[0]); }
    page.images_gallery = gal; page.image = gal.length ? gal[0].url : (lead && lead.image) || null;
    page.card_image = page.image || undefined;
    /* the members leave their old pages; a page left with no SKU is removed */
    for (const k of srcKeys) {
      if (k === rule.key) continue;
      pages[k].skus = (pages[k].skus || []).filter(s => !members.some(r => codeNorm(r.code) === codeNorm(s.sku)));
      if (!pages[k].skus.length) { delete pages[k]; say("page_merged", k + " → " + rule.key); }
    }
    pages[rule.key] = page;
    say("family", rule.key + " (" + page.skus.length + ")");
  }
  /* every catalog SKU must still be on exactly one page */
  const seen = {};
  for (const [k, p] of Object.entries(pages)) for (const s of p.skus || []) { const c = codeNorm(s.sku); if (seen[c]) problems.push({ sku: s.sku, problem: "on two pages: " + seen[c] + ", " + k }); seen[c] = k; }
  for (const r of catalog) if (!seen[codeNorm(r.code)]) problems.push({ sku: r.code, problem: "on no page" });
  return { log, problems };
}

module.exports = { applyFamilies, num, axisValue, matches };
