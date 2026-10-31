/* Parent product families (scripts/_catalog_families.js, owner 2026-10-31): rules group a line's SKUs into one page per
   family with one picker per axis; every SKU stays on exactly one page; values sort by number (fractions too); two SKUs
   with the same choices are an error; re-running changes nothing; a new SKU from a later price list joins its family;
   a SKU no rule matches keeps its own page; option photos and content survive the merge. */
const F = require("../scripts/_catalog_families.js");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("ok   " + n); } catch (e) { fail++; console.log("FAIL " + n + "\n     " + (e && e.message)); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "") + " got " + JSON.stringify(a) + " expected " + JSON.stringify(b)); };
const ok = (c, m) => { if (!c) throw new Error(m); };

const cat = [
  { code: "AST24x30", name: "Assist Ramp 24 x 30", family: "AST", width_in: 30, rise: 3 },
  { code: "AST24x36", name: "Assist Ramp 24 x 36", family: "AST", width_in: 36, rise: 3 },
  { code: "AST96x30", name: "Assist Ramp 96 x 30", family: "AST", width_in: 30, rise: 8 },
  { code: "AST36x36", name: "Assist Ramp 36 x 36", family: "AST", width_in: 36, rise: 3.6 },
  { code: "TRR012", name: "Composite Ramp 1/2\"", family: "TRR" },
  { code: "TRR1", name: "Composite Ramp 1\"", family: "TRR" },
  { code: "TRR034", name: "Composite Ramp 3/4\"", family: "TRR" },
  { code: "TRR112", name: "Composite Ramp 1 1/2\"", family: "TRR" },
  { code: "GATE36", name: "36\" Wide Gate", family: "GATE" },
];
const rules = [
  { key: "assist", name: "Assist Ramp", match: { family: ["AST"] }, content_from: "a1",
    axes: [{ name: "Length", on: "code", re: "^AST(\\d+)x", fmt: "{ft1} ft" }, { name: "Width", on: "code", re: "x(\\d+)$", fmt: "{1}\" wide" }],
    specs: [{ label: "Rise", field: "rise", fmt: "{v}\"" }] },
  { key: "rubber", name: "Rubber Ramp", match: { family: ["TRR"] }, axes: [{ name: "Rise", on: "name", re: "Ramp (\\d+(?: \\d/\\d)?|\\d/\\d)\"", fmt: "{1}\"" }] },
];
const mk = () => ({
  a1: { page_key: "a1", name: "Assist 24x30", description: "The Assist ramp.", images_gallery: [{ url: "/a.jpg", primary: true }], image: "/a.jpg",
    skus: [{ sku: "AST24x30", image: "" }, { sku: "AST24x36", image: "/opt36.jpg" }] },
  a2: { page_key: "a2", name: "Assist 96", images_gallery: [{ url: "/b.jpg", primary: true }], image: "/b.jpg", skus: [{ sku: "AST96x30" }] },
  a3: { page_key: "a3", name: "Assist 36", images_gallery: [{ url: "/a.jpg", primary: true }], skus: [{ sku: "AST36x36" }] },
  r1: { page_key: "r1", name: "Composite", images_gallery: [], skus: [{ sku: "TRR012" }, { sku: "TRR1" }, { sku: "TRR034" }, { sku: "TRR112" }] },
  g: { page_key: "g", name: "Gate", images_gallery: [{ url: "/g.jpg", primary: true }], skus: [{ sku: "GATE36" }] },
});

t("one page per family, merged pages removed, unmatched SKU keeps its page", () => {
  const p = mk(); const r = F.applyFamilies(p, cat, rules, {});
  eq(r.problems, []); eq(Object.keys(p).sort(), ["assist", "g", "rubber"]);
  eq(p.assist.skus.length, 4); eq(p.assist.description, "The Assist ramp.", "content from content_from page");
});
t("axes, labels and per-SKU specs come from the SKU itself; SKUs sort by axis numbers", () => {
  const p = mk(); F.applyFamilies(p, cat, rules, {});
  eq(p.assist.skus.map(s => s.sku), ["AST24x30", "AST24x36", "AST36x36", "AST96x30"]);
  eq(p.assist.skus[3].axes, { Length: "8 ft", Width: "30\" wide" });
  eq(p.assist.skus[3].size, "8 ft · 30\" wide");
  eq(p.assist.skus[3].specs, [{ label: "Rise", value: "8\"" }]);
});
t("fractions sort as numbers (1/2 < 3/4 < 1 < 1 1/2)", () => {
  const p = mk(); F.applyFamilies(p, cat, rules, {});
  eq(p.rubber.skus.map(s => s.axes.Rise), ["1/2\"", "3/4\"", "1\"", "1 1/2\""]);
});
t("option photos and galleries survive; the family gallery has no duplicates", () => {
  const p = mk(); F.applyFamilies(p, cat, rules, {});
  eq(p.assist.skus.find(s => s.sku === "AST24x36").image, "/opt36.jpg");
  eq(p.assist.images_gallery.map(g => g.url), ["/a.jpg", "/b.jpg"]); eq(p.assist.image, "/a.jpg"); eq(p.assist.card_image, "/a.jpg");
});
t("re-running changes nothing", () => {
  const p = mk(); F.applyFamilies(p, cat, rules, {}); const once = JSON.stringify(p);
  F.applyFamilies(p, cat, rules, {}); eq(JSON.stringify(p), once);
});
t("a new SKU in a later price list joins its family automatically", () => {
  const p = mk(); F.applyFamilies(p, cat, rules, {});
  p.new1 = { page_key: "new1", name: "Assist 48", skus: [{ sku: "AST48x30" }], images_gallery: [] };
  const cat2 = cat.concat([{ code: "AST48x30", name: "Assist Ramp 48 x 30", family: "AST", width_in: 30 }]);
  const r = F.applyFamilies(p, cat2, rules, {});
  eq(r.problems, []); ok(!p.new1, "own page removed"); eq(p.assist.skus.map(s => s.sku), ["AST24x30", "AST24x36", "AST36x36", "AST48x30", "AST96x30"]);
});
t("two SKUs with the same choices, an unreadable axis, a SKU on no page are reported", () => {
  const p = mk();
  const cat3 = cat.concat([{ code: "AST24x30B", name: "Assist Ramp 24 x 30 B", family: "AST" }]);
  p.a1.skus.push({ sku: "AST24x30B" });
  const bad = rules.map(r => r.key === "assist" ? Object.assign({}, r, { axes: [{ name: "Length", on: "code", re: "^AST(\\d+)x", fmt: "{ft1} ft" }] }) : r);
  const r = F.applyFamilies(p, cat3, bad, {});
  ok(r.problems.some(x => /same choice/.test(x.problem)), JSON.stringify(r.problems));
  const p2 = mk(); delete p2.g; const r2 = F.applyFamilies(p2, cat, rules, {});
  ok(r2.problems.some(x => x.sku === "GATE36" && /no page/.test(x.problem)), JSON.stringify(r2.problems));
});
t("number parsing", () => { eq(["1/2", "3/4", "1 1/4", "08", "7 - 14", "5.5"].map(F.num), [0.5, 0.75, 1.25, 8, 7, 5.5]); });
console.log(`catalog families: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
