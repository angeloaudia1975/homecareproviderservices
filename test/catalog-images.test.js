/* HCPS Product Enrichment — image layer (scripts/_catalog_images_lib.js + scripts/catalog-images.js).
   Builds a scratch storefront (catalog file, content file, images made with ImageMagick) and proves: site chrome is
   removed, tiny / duplicate photos are dropped, a real photo becomes the primary, one photo on every option becomes
   the page photo, an old small thumbnail never outranks a manufacturer photo, ZIP / folder file names match SKUs
   (longest code, folders, ambiguity reported), imports verify and de-duplicate, approved images survive re-runs and
   a second import adds nothing. Needs ImageMagick (convert / identify) and unzip / zip. */
const fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const L = require("../scripts/_catalog_images_lib.js");
const CLI = path.join(__dirname, "..", "scripts", "catalog-images.js");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("ok   " + n); } catch (e) { fail++; console.log("FAIL " + n + "\n     " + (e && e.message)); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "") + " got " + JSON.stringify(a) + " expected " + JSON.stringify(b)); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "catimg-"));
const shop = path.join(root, "shop"); const gal = path.join(shop, "public", "assets", "products", "acme", "gallery");
fs.mkdirSync(gal, { recursive: true }); fs.mkdirSync(path.join(shop, "public", "data", "content"), { recursive: true });
const img = (file, w, h, draw) => execFileSync("convert", ["-size", w + "x" + h, "xc:white", "-fill", "black", "-draw", draw, "-quality", "92", file]);
/* distinct pictures: a circle, a rectangle, a triangle; an icon; the circle again at another size */
img(path.join(gal, "circle.jpg"), 800, 600, "circle 400,300 400,100");
img(path.join(gal, "rect.jpg"), 800, 600, "rectangle 100,100 700,500");
img(path.join(gal, "tri.jpg"), 800, 600, "polygon 400,50 750,550 50,550");
img(path.join(gal, "icon.png"), 64, 64, "circle 32,32 32,10");
img(path.join(gal, "circle-small.jpg"), 200, 150, "circle 100,75 100,25");
const U = n => "/assets/products/acme/gallery/" + n;
const G = (n, primary) => ({ url: U(n), primary: !!primary, caption: "", source: "x" });

const catalog = [{ code: "A1", name: "Alpha" }, { code: "B1-S", name: "Beta S" }, { code: "B1-L", name: "Beta L" }, { code: "C1", name: "Gamma" }, { code: "D1", name: "Delta" }, { code: "E1", name: "Echo" }, { code: "F1", name: "Fox" }, { code: "B1", name: "Beta base" }];
const mkPages = () => ({
  a: { page_key: "a", skus: [{ sku: "A1", image: U("circle-small.jpg") }], images_gallery: [G("circle.jpg", true), G("icon.png")], image: U("circle.jpg") },
  b: { page_key: "b", skus: [{ sku: "B1-S", image: U("rect.jpg") }, { sku: "B1-L", image: U("rect.jpg") }], images_gallery: [G("icon.png", true)], image: U("icon.png") },
  c: { page_key: "c", skus: [{ sku: "C1", image: "" }], images_gallery: [G("icon.png", true), G("tri.jpg")], image: U("icon.png") },
  d: { page_key: "d", skus: [{ sku: "D1", image: "" }], images_gallery: [G("icon.png", true)], image: U("icon.png") },
  e: { page_key: "e", skus: [{ sku: "E1", image: "" }], images_gallery: [G("icon.png", true), G("circle.jpg"), G("circle-small.jpg")], image: U("icon.png") },
  f: { page_key: "f", skus: [{ sku: "F1", image: "" }], images_gallery: [], image: null },
});

t("site chrome (one small icon on 5+ pages) is removed everywhere", () => {
  const p = mkPages(); const log = L.cleanPages(p, shop, {});
  ok(!JSON.stringify(p).includes("icon.png"), "icon still present"); ok((log.chrome_removed || []).length >= 4, JSON.stringify(log));
});
t("a real photo becomes the primary; tiny and duplicate pictures go", () => {
  const p = mkPages(); L.cleanPages(p, shop, {});
  eq(p.c.image, U("tri.jpg")); eq(p.c.images_gallery.map(g => g.primary), [true]);
  eq(p.e.images_gallery.map(g => g.url), [U("circle.jpg")], "duplicate / tiny circle");
  eq(p.d.images_gallery, [], "chrome-only page has no photo"); eq(p.d.image, null);
});
t("one photo on every option is the page photo; a small thumbnail never outranks the manufacturer photo", () => {
  const p = mkPages(); L.cleanPages(p, shop, {});
  eq(p.b.skus.map(s => s.image), ["", ""]); eq(p.b.image, U("rect.jpg"));
  eq(p.a.skus[0].image, "", "old small thumbnail removed"); eq(p.a.image, U("circle.jpg"));
});
t("file names → SKUs: longest code, separators, folders, ambiguity and unknown names reported", () => {
  const codes = catalog.map(r => r.code);
  eq(L.matchFileToSku("B1-S.jpg", codes).sku, "B1-S");
  eq(L.matchFileToSku("B1-S_2.jpg", codes).sku, "B1-S");
  eq(L.matchFileToSku("b1-l side.png", codes).sku, "B1-L");
  eq(L.matchFileToSku("B1 front.jpg", codes).sku, "B1");
  eq(L.matchFileToSku("A1/IMG_0042.jpg", codes).sku, "A1", "folder");
  eq(L.matchFileToSku("Z9.jpg", codes).sku, null);
  eq(L.matchFileToSku("A12.jpg", codes).sku, "A1", "A1 + view number 2");
});
t("audit reports what a dealer is shown", () => {
  const p = mkPages(); L.cleanPages(p, shop, {});
  const a = L.audit("acme", catalog, p, shop);
  const by = Object.fromEntries(a.rows.map(r => [r.sku, r.issue]));
  eq([by.A1, by.D1, by.F1], [null, "no_photo", "no_photo"]);
});

/* end to end through the CLI: a ZIP, a map, a second run */
fs.writeFileSync(path.join(shop, "public", "data", "acme.json"), JSON.stringify(catalog));
const pages = mkPages(); L.cleanPages(pages, shop, {});
fs.writeFileSync(path.join(shop, "public", "data", "content", "acme.json"), JSON.stringify({ meta: {}, pages }));
const zdir = path.join(root, "zip"); fs.mkdirSync(path.join(zdir, "F1"), { recursive: true });
img(path.join(zdir, "D1.jpg"), 900, 700, "rectangle 200,200 700,500");
img(path.join(zdir, "D1_2.jpg"), 900, 700, "polygon 450,50 850,650 50,650");
img(path.join(zdir, "F1", "photo.png"), 600, 600, "circle 300,300 300,80");
img(path.join(zdir, "B1-S.jpg"), 640, 480, "circle 320,240 320,40");
img(path.join(zdir, "tiny-D1.jpg"), 120, 90, "circle 60,45 60,10");
img(path.join(zdir, "Q7.jpg"), 640, 480, "circle 320,240 320,40");
execFileSync("zip", ["-qr", path.join(root, "imgs.zip"), "."], { cwd: zdir });
const run = (...a) => JSON.parse(execFileSync("node", [CLI, ...a, "--line", "acme", "--shop", shop]).toString().trim().split("\n").pop());
t("ZIP import: matched, verified, stored, applied; an unknown name and a non-SKU name reported", () => {
  const r = run("import", "--zip", path.join(root, "imgs.zip"));
  eq([r.imported, r.unmatched], [4, 2], JSON.stringify(r));
  const c = JSON.parse(fs.readFileSync(path.join(shop, "public", "data", "content", "acme.json"), "utf8")).pages;
  eq(c.d.images_gallery.length, 2, "D1 gets both photos"); ok(c.d.image, "D1 primary");
  eq(c.f.images_gallery.length, 1, "F1 by folder");
  ok(c.b.skus.find(s => s.sku === "B1-S").image && !c.b.skus.find(s => s.sku === "B1-L").image, "B1-S option photo only");
  const ov = JSON.parse(fs.readFileSync(path.join(shop, "content-overrides", "acme.json"), "utf8"));
  ok(ov._images.D1.length === 2 && ov._images.F1.length === 1, "recorded for future runs");
});
t("a second import of the same ZIP adds nothing", () => {
  const before = fs.readFileSync(path.join(shop, "public", "data", "content", "acme.json"), "utf8");
  const nFiles = fs.readdirSync(gal).length;
  run("import", "--zip", path.join(root, "imgs.zip"));
  eq(fs.readdirSync(gal).length, nFiles, "no new files");
  const c = JSON.parse(fs.readFileSync(path.join(shop, "public", "data", "content", "acme.json"), "utf8")).pages;
  eq(c.d.images_gallery.length, 2); eq(c.f.images_gallery.length, 1);
  ok(JSON.stringify(c) === JSON.stringify(JSON.parse(before).pages), "content changed on a re-run");
});
t("a map import rejects a too-small or unreadable image and keeps the reason", () => {
  img(path.join(root, "small.jpg"), 150, 100, "circle 75,50 75,20");
  fs.writeFileSync(path.join(root, "bad.jpg"), "not an image at all, just text padded ".repeat(60));
  fs.writeFileSync(path.join(root, "map.json"), JSON.stringify({ C1: [{ url: path.join(root, "small.jpg"), source: "s" }, { url: path.join(root, "bad.jpg"), source: "s" }], _unresolved: { E1: "no official photo" } }));
  const r = run("import", "--map", path.join(root, "map.json"), "--report", path.join(root, "rep.json"));
  eq([r.imported, r.rejected, r.unresolved], [0, 2, 1], JSON.stringify(r));
  const rep = JSON.parse(fs.readFileSync(path.join(root, "rep.json"), "utf8"));
  ok(/too small/.test(rep.rejected[0].why) && /not an image/.test(rep.rejected[1].why), JSON.stringify(rep.rejected));
});
t("approved images are applied again by applyApproved (what every enrichment run does), without duplicates", () => {
  const ov = JSON.parse(fs.readFileSync(path.join(shop, "content-overrides", "acme.json"), "utf8"));
  const fresh = mkPages(); L.cleanPages(fresh, shop, {});
  L.applyApproved(fresh, ov._images, shop, {}); L.applyApproved(fresh, ov._images, shop, {});
  eq(fresh.d.images_gallery.length, 2); eq(fresh.f.images_gallery.length, 1);
});
t("retire switches a SKU off on its page (reversible), keeps catalog rows, leaves it out of the audit; restore brings it back", () => {
  const cat0 = fs.readFileSync(path.join(shop, "public", "data", "acme.json"), "utf8");
  const r = run("retire", "--skus", "B1-L,C1", "--reason", "owner decision", "--ref", "tracker #42");
  eq(r.retired_now, 2, JSON.stringify(r));
  let c = JSON.parse(fs.readFileSync(path.join(shop, "public", "data", "content", "acme.json"), "utf8")).pages;
  const bl = c.b.skus.find(s => s.sku === "B1-L"); eq([bl.status, bl.disabled, bl.retired.ref], ["hidden", true, "tracker #42"]);
  eq(c.c.skus[0].status, "hidden");
  eq(fs.readFileSync(path.join(shop, "public", "data", "acme.json"), "utf8"), cat0, "catalog file untouched");
  const a = JSON.parse(execFileSync("node", [CLI, "audit", "--line", "acme", "--shop", shop]).toString());
  eq([a.skus, a.retired], [catalog.length - 2, 2]);
  /* a later import / enrichment keeps them retired */
  run("import", "--zip", path.join(root, "imgs.zip"));
  c = JSON.parse(fs.readFileSync(path.join(shop, "public", "data", "content", "acme.json"), "utf8")).pages;
  eq(c.c.skus[0].disabled, true, "still retired after another run");
  const r2 = run("restore", "--skus", "C1");
  c = JSON.parse(fs.readFileSync(path.join(shop, "public", "data", "content", "acme.json"), "utf8")).pages;
  eq([c.c.skus[0].status, c.c.skus[0].disabled, !!c.c.skus[0].retired], ["active", false, false]);
  eq(r2.retired_now, 1);
  let threw = false; try { run("retire", "--skus", "NOPE", "--reason", "x"); } catch (e) { threw = true; } ok(threw, "unknown SKU refused");
});
fs.rmSync(root, { recursive: true, force: true });
console.log(`catalog images: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
