/* Manufacturer content review (Catalog Completion) — synthetic fixtures only; no researched copy, no prices.
   node test/content-review.test.js   (CAT_ROOT=<dir> runs against a mutated copy of netlify/functions) */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const ROOT = process.env.CAT_ROOT || path.join(__dirname, "..", "netlify", "functions");
const CR = require(path.join(ROOT, "_content_review.js"));
let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; }catch(e){ fail++; console.log("FAIL", name, "—", e.message); } }
function eq(a, b, m){ const x = JSON.stringify(a), y = JSON.stringify(b); if(x !== y) throw new Error((m || "") + " expected " + y + " got " + x); }
function ok(v, m){ if(!v) throw new Error(m || "expected truthy"); }

const U = "https://daltonmedical.com/product/";
const fam = (o) => Object.assign({ family: "F", codes: ["X1"], product_url: U + "x1/", description: "The X1 bench gives a stable seat for bathing and transfers in the home bathroom every day.",
  features: ["Tool-free assembly", "Adjustable legs", "Non-slip feet"], specs: { "Seat Height": "17″–21″" }, category_suggestion: "Bathroom Safety",
  image_urls: [U.replace("product/", "wp-content/uploads/x1-front.jpg")], source_urls: [U + "x1/"], confidence: "high", notes: "" }, o);
const line = (fams, cat, extra) => CR.reviewLine("dalton", Object.assign({ retrieved: "2026-10-23", families: fams, not_found: [] }, extra || {}), cat || fams.flatMap(f => f.codes.map(c => ({ code: c, name: c + " item" }))));
const sku = (L, c) => L.skus.find(s => s.sku === c);
const has = (s, code) => s.reasons.some(r => r.code === code);
const hold = (s, code) => s.reasons.some(r => r.code === code && r.level === "hold");

t("official hosts: site, sub-domain, cdn (assets only), parent, look-alikes rejected", () => {
  eq(CR.checkSource("dalton", "https://www.daltonmedical.com/a").role, "official_site");
  eq(CR.checkSource("abm-respiratory-care", "https://eifu.abmrc.com/x").role, "official_site");
  const c = CR.checkSource("access4u", "https://static.wixstatic.com/media/a.jpg"); eq([c.ok, c.role, c.assets_only], [true, "official_cdn", true]);
  eq(CR.checkSource("ohio-medical", "https://assets.esab.com/x.pdf").role, "parent_company");
  eq(CR.checkSource("dalton", "https://daltonmedical.com.evil.com/a").ok, false);
  eq(CR.checkSource("dalton", "https://evil-daltonmedical.com/a").ok, false);
  eq(CR.checkSource("dalton", "https://www.amazon.com/dp/1").role, "rejected");
  eq(CR.checkSource("dalton", "daltonmedical.com/x").ok, false);
});
t("frozen lines and unknown lines are refused", () => {
  for(const s of ["bemis", "climbing-steps", "strongback", "strongback-mobility", "ovation", "ovation-medical"]){
    let threw = false; try{ CR.reviewLine(s, { families: [] }, []); }catch(e){ threw = /frozen/.test(e.message); } ok(threw, s); }
  let threw = false; try{ CR.reviewLine("nobody", { families: [] }, []); }catch(e){ threw = true; } ok(threw);
});
t("clean, high-confidence official family is Ready with provenance", () => {
  const L = line([fam()]); const s = sku(L, "X1"); eq(s.status, "ready", JSON.stringify(s.reasons)); eq(s.discontinued, false);
  const p = L.pages[0]; eq(p.source.official, true); eq(p.provenance.description.source_url, U + "x1/"); eq(p.provenance.description.fetched_at, "2026-10-23");
  eq(p.draft.warranty, null);
});
t("non-official product page → held, none of its words used", () => {
  const L = line([fam({ product_url: "https://www.amazon.com/dp/X1" })]); const s = sku(L, "X1");
  ok(hold(s, "non_official_source")); eq(L.pages[0].draft.description, null); eq(L.pages[0].draft.features, []);
});
t("non-official secondary link dropped with a review note", () => { const L = line([fam({ source_urls: [U + "x1/", "https://reseller.example/x1"] })]); ok(has(sku(L, "X1"), "rejected_source_link")); });
t("family without a product page → not_found hold", () => { const L = line([fam({ product_url: null, source_urls: [] })]); ok(hold(sku(L, "X1"), "not_found")); ok(!has(sku(L, "X1"), "non_official_source")); });
t("catalog SKU missing from research → not_found, never discontinued", () => {
  const L = line([fam()], [{ code: "X1", name: "x" }, { code: "Z9", name: "z" }]); const z = sku(L, "Z9");
  eq([z.status, z.page_key, z.discontinued], ["held", null, false]); ok(hold(z, "not_found"));
});
t("listed not_found code → held even when a family lists it", () => { const L = line([fam({ codes: ["X1", "X2"] })], null, { not_found: ["X2"] }); ok(hold(sku(L, "X2"), "not_found")); ok(!has(sku(L, "X1"), "not_found")); });
t("capacity conflict note naming one code holds that code; siblings get capacity_by_model", () => {
  const L = line([fam({ codes: ["A1", "A2"], notes: "CONFLICT: HCPS name for A1 says 300 lb; page says 220 lb." })]);
  ok(hold(sku(L, "A1"), "capacity_conflict")); eq(sku(L, "A1").status, "held"); eq(L.pages[0].status, "held"); ok(!hold(sku(L, "A2"), "capacity_conflict")); ok(has(sku(L, "A2"), "capacity_by_model"));
});
t("capacity conflict note naming no code holds every code (K2)", () => {
  const L = line([fam({ codes: ["K2A", "K2B"], notes: "Weight capacity conflict in source: '300 lb in the specifications table; 250 lb in the manual'" })]);
  ok(hold(sku(L, "K2A"), "capacity_conflict")); ok(hold(sku(L, "K2B"), "capacity_conflict"));
});
t("catalog name capacity vs manufacturer capacity", () => {
  const bad = line([fam({ specs: { "Weight Capacity": "250 lbs." } })], [{ code: "X1", name: "Bench 300 Lbs Weight Capacity" }]); ok(hold(sku(bad, "X1"), "capacity_conflict"));
  const good = line([fam({ specs: { "Weight Capacity": "300 lbs." } })], [{ code: "X1", name: "Bench 300 Lbs Weight Capacity" }]); ok(!has(sku(good, "X1"), "capacity_conflict"));
  const scale = line([fam({ specs: { "Maximum Weight Capacity": "1100 lbs (1000 lb safety load limit)" } })], [{ code: "X1", name: "Scale 1000 lb capacity" }]); ok(!has(sku(scale, "X1"), "capacity_conflict"));
  const none = line([fam({ specs: {} })], [{ code: "X1", name: "Bench 300LB Weight Capacity" }]); ok(has(sku(none, "X1"), "catalog_fact_unconfirmed")); ok(!hold(sku(none, "X1"), "capacity_conflict"));
});
t("product weight is not a capacity", () => { const L = line([fam({ specs: { "Maximum Weight (net weight)": "41 lb", "Weight Capacity": "300 lb" } })], [{ code: "X1", name: "Chair 300 lb capacity" }]); eq(sku(L, "X1").status, "ready"); });
t("two different capacity statements on a one-SKU page → hold; on a multi-model page → review", () => {
  const one = line([fam({ specs: { "Weight Capacity": "300 lb" }, features: ["Weight capacity of 250 lb", "a", "b"] })]); ok(hold(sku(one, "X1"), "capacity_conflict"));
  const many = line([fam({ codes: ["M1", "M2"], specs: { "Weight Capacity": "300 lb" }, features: ["Weight capacity of 250 lb", "a", "b"] })]); ok(has(sku(many, "M1"), "capacity_by_model")); ok(!hold(sku(many, "M1"), "capacity_conflict"));
});
t("warranty conflict: note holds the whole family; catalog years vs stated warranty", () => {
  const n = line([fam({ codes: ["Z1", "Z1+B"], notes: "WARRANTY CONFLICT: leaflet states 5 year warranty; HCPS name of Z1 says 3-yr — confirm" })]);
  ok(hold(sku(n, "Z1"), "warranty_conflict")); ok(hold(sku(n, "Z1+B"), "warranty_conflict"));
  const m = line([fam({ specs: { "Warranty": "2 years" } })], [{ code: "X1", name: "Unit 3 Year Warranty" }]); ok(hold(sku(m, "X1"), "warranty_conflict"));
  const g = line([fam({ specs: { "Warranty": "3 years; battery 1 year" } })], [{ code: "X1", name: "Unit 3 Year Warranty Compressor 1 Year Warranty Sieve" }]); ok(!has(sku(g, "X1"), "warranty_conflict"));
  eq(g.pages[0].draft.warranty, "3 years; battery 1 year");
});
t("a stock conflict note is availability, not a spec hold", () => { const L = line([fam({ notes: "Stock signal conflicting: grid showed Sold Out; page in stock." })]); ok(has(sku(L, "X1"), "possibly_not_current")); ok(!has(sku(L, "X1"), "spec_conflict")); eq(sku(L, "X1").status, "needs_review"); });
t("other conflict notes → spec_conflict hold", () => { const L = line([fam({ notes: "CONFLICT: HCPS name says 22″–36″; page says 25–32 inches." })]); ok(hold(sku(L, "X1"), "spec_conflict")); });
t("paraphrased description is never draft copy", () => {
  const L = line([fam({ description: "PediFix cushion absorbs shock. (second part summarized) The rest describes fit." })]);
  eq(L.pages[0].draft.description, null); ok(has(sku(L, "X1"), "paraphrased_copy"));
});
t("paraphrased warranty stays blank", () => { const L = line([fam({ specs: { "Warranty (paraphrased)": "1 yr full" } })]); eq(L.pages[0].draft.warranty, null); ok(has(sku(L, "X1"), "paraphrased_warranty")); });
t("assembled copy needs review", () => { const L = line([fam({ notes: "Description assembled from the official selection guide wording." })]); ok(has(sku(L, "X1"), "assembled_copy")); });
t("no description captured → review, never filled", () => { const L = line([fam({ description: null })]); ok(has(sku(L, "X1"), "no_description")); eq(L.pages[0].draft.description, null); });
t("OTC drug items are held for verbatim Drug Facts; a code containing OTC is not", () => {
  const L = line([fam({ notes: "OTC drug: use Drug Facts verbatim before publishing." })]); ok(hold(sku(L, "X1"), "otc_drug_facts"));
  const a = line([fam({ description: "Contains clotrimazole 1% antifungal for athlete's foot in a dropper bottle form for daily use." })]); ok(hold(sku(a, "X1"), "otc_drug_facts"));
  const p = line([fam({ codes: ["M905IOTC"], notes: "Colours seen on site: M905IOTC, M905LL." })]); ok(!has(sku(p, "M905IOTC"), "otc_drug_facts"));
});
t("CBD → regulatory_check hold", () => { const L = line([fam({ notes: "Contains CBD — check state rules." })]); ok(hold(sku(L, "X1"), "regulatory_check")); });
t("warranty void as a medical bed → unsupported_claim hold", () => {
  const L = line([fam({ notes: "SBI warranty text says using the base as a medical or hospital bed voids the warranty." })]); ok(hold(sku(L, "X1"), "unsupported_claim"));
});
t("freight wording in content → unsupported_claim", () => { const L = line([fam({ features: ["Free shipping on all orders", "a", "b"] })]); ok(hold(sku(L, "X1"), "unsupported_claim")); });
t("Corsicana line exception queued without blocking a page", () => {
  const L = CR.reviewLine("corsicana", { families: [] }, []); const e = L.exceptions.find(x => x.sku === null);
  eq([e.kind, e.level, e.status], ["unsupported_claim", "hold", "open"]); ok(/freight/i.test(e.evidence));
});
t("successor-company source is reviewed, not silently official", () => {
  const L = CR.reviewLine("corsicana", { families: [fam({ codes: ["S1"], product_url: "https://southbayinternational.com/products/s1", source_urls: [] })] }, [{ code: "S1", name: "s" }]);
  ok(has(sku(L, "S1"), "successor_source")); eq(L.pages[0].source.official, true);
});
t("image rights / third-party brand → image_rights hold", () => {
  const L = line([fam({ notes: "Image filenames begin 'costcare-'; confirm image rights." })]); ok(hold(sku(L, "X1"), "image_rights"));
  const R = line([fam({ notes: "Resvent is the original manufacturer; Rx device." })]); ok(hold(sku(R, "X1"), "image_rights")); ok(has(sku(R, "X1"), "third_party_brand"));
});
t("site status: sold out holds, possibly-not-current and reseller only review, nothing discontinued", () => {
  const L = line([fam({ codes: ["P1", "P2", "P3"] })], null, { site_status_flags: { sold_out_on_site: { "P1 Pads": ["P1"] }, possibly_not_current_on_site: { "P2 Old": "legacy page only" }, reseller_lead_only: { "P3": "reseller says discontinued" } } });
  ok(hold(sku(L, "P1"), "sold_out_on_site")); ok(has(sku(L, "P2"), "possibly_not_current")); ok(has(sku(L, "P3"), "reseller_lead"));
  ok(L.skus.every(s => s.discontinued === false)); ok(!hold(sku(L, "P2"), "possibly_not_current"));
});
t("retail model / SKU rows become provenance aliases, not specs", () => {
  const L = line([fam({ specs: { "Model Number": "A84505T 000", "Seat Height": "17″" }, dalton_site_skus: ["X1-RET"] })]);
  ok(!("Model Number" in L.pages[0].draft.specs)); ok(L.pages[0].provenance.retail_model.some(r => r.value === "A84505T 000")); ok(L.pages[0].provenance.retail_model.some(r => r.value === "X1-RET" && /Retail Model/.test(r.label)));
});
t("first-person copy is neutralised", () => { const L = line([fam({ description: "We're the best. Our patented frame keeps the bench steady on wet bathroom floors for every user." })]); eq(L.pages[0].draft.description, "Dalton’s patented frame keeps the bench steady on wet bathroom floors for every user."); });
t("confidence below high needs review", () => { ok(has(sku(line([fam({ confidence: "medium" })]), "X1"), "medium_confidence")); ok(has(sku(line([fam({ confidence: "low" })]), "X1"), "low_confidence")); });
t("Rx and claims need attributed wording", () => { const L = line([fam({ features: ["Rx: a prescription is required", "Relief guaranteed", "c"] })]); ok(has(sku(L, "X1"), "rx_device")); ok(has(sku(L, "X1"), "claim_attribution")); });
t("exception records use the common schema", () => {
  const L = line([fam({ notes: "CONFLICT: page says 25–32 inches." })]); const e = L.exceptions[0];
  eq(Object.keys(e), ["manufacturer", "sku", "page_key", "kind", "level", "evidence", "source_ref", "decision_needed", "status"]); eq(e.status, "open");
});
t("importer flags map onto the common schema", () => {
  const e = CR.fromImporterFlag("dalton", { level: "blocker", code: "no_dealer_price", detail: "no dealer price", code_ref: "X1", locator: "row 4" });
  eq([e.manufacturer, e.sku, e.kind, e.level, e.source_ref, e.status], ["dalton", "X1", "no_dealer_price", "hold", "row 4", "open"]);
  eq(CR.fromImporterFlag("d", { level: "warn", code: "c" }).level, "review"); eq(CR.fromImporterFlag("d", { level: "info", code: "c" }).decision_needed, null);
});
t("prices in the catalog list never reach the output", () => {
  const L = line([fam()], [{ code: "X1", name: "x", dealer_price: 12.34, msrp: 99.99, map: 50 }]); CR.stageImages(L, {});
  const s = JSON.stringify(L); ok(!/12\.34|99\.99|dealer_price|msrp|"map"/.test(s));
});

/* images */
const img = (u) => U.replace("product/", "wp-content/uploads/" + u);
t("images: rights pending, never rehosted, not fetched stays not fetched", () => {
  const L = line([fam()]); const I = CR.stageImages(L, {});
  eq([I[0].classification, I[0].fetched, I[0].fetch_note, I[0].rights_status, I[0].sha256], ["primary_candidate", false, "not fetched", "pending", null]); ok(/not rehosted/.test(I[0].rehost));
});
t("images: promo / banner art is never primary → no_primary_image", () => {
  const L = line([fam({ image_urls: [img("bongo_hero_2024.png"), img("banner-x.jpg")] })]); const I = CR.stageImages(L, {});
  ok(I.every(i => i.classification === "promo")); ok(has(sku(L, "X1"), "no_primary_image")); eq(L.pages[0].primary_image, null);
});
t("images: a promo-sounding FOLDER does not make a product photo promo", () => { eq(CR.promoReason("https://gcegroup.com/files/POC_campaign/Zeno_front__1211.jpg"), null); ok(CR.promoReason(img("Untitled-design-1.png"))); });
t("images: no image → no_image review", () => { const L = line([fam({ image_urls: [] })]); CR.stageImages(L, {}); ok(has(sku(L, "X1"), "no_image")); eq(sku(L, "X1").status, "needs_review"); });
t("images: non-official host rejected", () => { const L = line([fam({ image_urls: ["https://m.media-amazon.com/x.jpg", img("x1.jpg")] })]); const I = CR.stageImages(L, {}); eq(I[0].classification, "rejected"); eq(I[1].classification, "primary_candidate"); });
t("images: fetched facts recorded; duplicates collapse onto the largest; small photo not primary; non-image rejected", () => {
  const a = img("a.jpg"), b = img("b-600x600.jpg"), c = img("c.jpg"), d = img("d.jpg");
  const L = line([fam({ image_urls: [d, a, b, c] })]);
  const F = { [a]: { sha256: "s1", bytes: 1000, width: 800, height: 800, content_type: "image/jpeg", http_status: 200, fetched_at: "2026-10-23T00:00:00Z" },
    [b]: { sha256: "s1", bytes: 400, width: 600, height: 600, content_type: "image/jpeg", http_status: 200 },
    [c]: { sha256: "s3", bytes: 300, width: 120, height: 120, content_type: "image/jpeg", http_status: 200 },
    [d]: { sha256: "s4", bytes: 50, content_type: "text/html", http_status: 200 } };
  const I = CR.stageImages(L, F), by = u => I.find(i => i.url === u);
  eq(by(d).classification, "rejected"); eq(by(a).classification, "primary_candidate"); eq(by(b).classification, "duplicate"); eq(by(b).duplicate_of, by(a).id);
  eq(by(c).classification, "gallery"); eq([by(a).fetched, by(a).sha256, by(a).width], [true, "s1", 800]);
});
t("images: a photo under 300 px is never primary", () => {
  const s = img("s.jpg"), b = img("b.jpg"); const L = line([fam({ image_urls: [s, b] })]);
  const I = CR.stageImages(L, { [s]: { sha256: "1", bytes: 10, width: 100, height: 100, content_type: "image/png" }, [b]: { sha256: "2", bytes: 99, width: 900, height: 700, content_type: "image/jpeg" } });
  eq(I.map(i => i.classification), ["gallery", "primary_candidate"]);
});
t("images: same photo at another size (no bytes) collapses by file stem", () => {
  const L = line([fam({ image_urls: [img("x1-scaled.jpg"), img("x1.jpg")] })]); const I = CR.stageImages(L, {}); eq(I.filter(i => i.classification === "duplicate").length, 1);
});
t("images: a fetch failure is recorded, never invented", () => {
  const u = img("x1.jpg"); const L = line([fam({ image_urls: [u] })]); const I = CR.stageImages(L, { [u]: { error: "timeout" } });
  eq([I[0].fetched, I[0].sha256], [false, null]); ok(/fetch failed: timeout/.test(I[0].fetch_note));
});
t("imageSize reads PNG, GIF, JPEG and WebP headers", () => {
  const png = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20); eq(CR.imageSize(png), { width: 640, height: 480 });
  const gif = Buffer.alloc(32); gif.write("GIF89a"); gif.writeUInt16LE(10, 6); gif.writeUInt16LE(20, 8); eq(CR.imageSize(gif), { width: 10, height: 20 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0, 0, 0, 0, 0, 0, 0, 0, 0]); eq(CR.imageSize(jpg), { width: 600, height: 300 });
  const wp = Buffer.alloc(32); wp.write("RIFF"); wp.write("WEBP", 8); wp.write("VP8X", 12); wp.writeUIntLE(99, 24, 3); wp.writeUIntLE(49, 27, 3); eq(CR.imageSize(wp), { width: 100, height: 50 });
  eq(CR.imageSize(Buffer.from("not an image at all, just text....")), null);
});

/* CLI (no fetch): refuses the repo as output; writes the package; never copies prices */
t("CLI writes the review package outside the repo only", () => {
  if(process.env.CAT_ROOT) return; // the CLI requires the real module path
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crv-")), inn = path.join(tmp, "in"), out = path.join(tmp, "out"); fs.mkdirSync(inn);
  fs.writeFileSync(path.join(inn, "dalton-content.json"), JSON.stringify({ retrieved: "2026-10-23", families: [fam()], not_found: [] }));
  fs.writeFileSync(path.join(inn, "dalton-skus.json"), JSON.stringify([{ code: "X1", name: "x", dealer_price: 77.77 }, { code: "Y2", name: "y" }]));
  const cli = path.join(__dirname, "..", "scripts", "content-review.js");
  let refused = false; try{ execFileSync("node", [cli, "--in", inn, "--out", path.join(__dirname, "..", "tmp-review")], { stdio: "pipe" }); }catch(e){ refused = /inside the repository/.test(String(e.stderr)); }
  ok(refused, "repo output refused"); ok(!fs.existsSync(path.join(__dirname, "..", "tmp-review")));
  execFileSync("node", [cli, "--in", inn, "--out", out, "--only", "dalton"], { stdio: "pipe" });
  for(const f of ["dalton-review.json", "exceptions.json", "images.json", "summary.json"]) ok(fs.existsSync(path.join(out, f)), f);
  const all = fs.readdirSync(out).filter(f => f.endsWith(".json")).map(f => fs.readFileSync(path.join(out, f), "utf8")).join("");
  ok(!/77\.77|dealer_price/.test(all)); eq(JSON.parse(fs.readFileSync(path.join(out, "summary.json")))[0].held, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* Image fetch hardening (PR #38 review): every redirect hop's host is checked; size is capped by header AND by counting */
async function ta(name, fn){ try{ await fn(); pass++; }catch(e){ fail++; console.log("FAIL", name, "—", e.message); } }
const PNG = (() => { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b); b.writeUInt32BE(640, 16); b.writeUInt32BE(480, 20); return b; })();
const fakeFetch = (routes, log) => async (u, o) => { (log || []).push([u, o && o.redirect]); const r = routes[u]; if(!r) return new Response("", { status: 404 }); return typeof r === "function" ? r() : r; };
const redirect = to => new Response(null, { status: 302, headers: { location: to } });
const imgRes = (buf, h) => new Response(buf, { status: 200, headers: Object.assign({ "content-type": "image/png" }, h || {}) });
(async () => {
await ta("fetch: an official URL that redirects to another site is refused (final host checked, manual redirects)", async () => {
  const u = "https://daltonmedical.com/wp-content/uploads/a.png", log = [];
  const r = await CR.fetchImageSafe("dalton", u, { fetchImpl: fakeFetch({ [u]: redirect("https://cdn.evil.example/a.png"), "https://cdn.evil.example/a.png": imgRes(PNG) }, log) });
  ok(/redirected off the official hosts \(cdn\.evil\.example\)/.test(r.error), r.error); eq(r.sha256, undefined);
  eq(log.map(x => x[0]), [u], "the off-site target is never requested"); eq(log[0][1], "manual");
  const L = line([fam({ image_urls: [u] })]); const I = CR.stageImages(L, { [u]: r });
  eq([I[0].classification, I[0].fetched], ["rejected", false]);
});
await ta("fetch: a redirect between official hosts is followed and recorded; https never downgraded; hop limit", async () => {
  const u = "https://daltonmedical.com/wp-content/uploads/a.png", v = "https://www.daltonmedical.com/wp-content/uploads/a-1.png";
  const r = await CR.fetchImageSafe("dalton", u, { fetchImpl: fakeFetch({ [u]: redirect(v), [v]: imgRes(PNG) }) });
  eq([r.error, r.final_url, r.redirects.length, r.width, r.bytes], [undefined, v, 1, 640, 64]);
  const h = await CR.fetchImageSafe("dalton", u, { fetchImpl: fakeFetch({ [u]: redirect("http://daltonmedical.com/a.png") }) });
  ok(/https to http/.test(h.error), h.error);
  const loop = await CR.fetchImageSafe("dalton", u, { fetchImpl: async () => redirect(u) });
  ok(/too many redirects/.test(loop.error), loop.error);
  const off = await CR.fetchImageSafe("dalton", "https://www.amazon.com/x.png", { fetchImpl: async () => { throw new Error("must not be called"); } });
  ok(/not an official host/.test(off.error), off.error);
});
await ta("fetch: size capped by Content-Length and by counting the body (a missing or lying header can't get round it)", async () => {
  const u = "https://daltonmedical.com/wp-content/uploads/big.png", big = Buffer.alloc(2048, 1);
  const a = await CR.fetchImageSafe("dalton", u, { maxBytes: 1024, fetchImpl: fakeFetch({ [u]: imgRes(PNG, { "content-length": "999999" }) }) });
  ok(/declared/.test(a.error), a.error);
  const b = await CR.fetchImageSafe("dalton", u, { maxBytes: 1024, fetchImpl: fakeFetch({ [u]: () => imgRes(big) }) });
  ok(/larger than/.test(b.error) && !b.sha256, b.error);
  const c = await CR.fetchImageSafe("dalton", u, { maxBytes: 1024, fetchImpl: fakeFetch({ [u]: () => imgRes(big, { "content-length": "10" }) }) });
  ok(/larger than/.test(c.error) && !c.sha256, "a lying Content-Length is caught while reading");
  eq(CR.IMAGE_MAX_BYTES, 8 * 1024 * 1024);
});
await ta("rights: every candidate stays pending and is never described as licensed", async () => {
  const L = line([fam()]); const I = CR.stageImages(L, {});
  ok(I.every(i => i.rights_status === "pending" && /not licensed/.test(i.rights_note)));
  eq([L.counts.images.rights_pending, L.counts.images.rights_recorded], [I.length, 0]);
});
console.log(`content-review: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
