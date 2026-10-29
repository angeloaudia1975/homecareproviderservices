/* HCPS Product Enrichment — image layer shared by scripts/catalog-enrich.js (every enrichment run) and
   scripts/catalog-images.js (audit / discover / import / ZIP import). Pure functions over the storefront's static
   content file (public/data/content/<slug>.json) plus small helpers that read image files from disk.

   Rules (owner, 2026-10-27 "complete image recovery"):
   · a product shows the RIGHT photo or none — never a filler from another product;
   · site chrome (cookie badges, icons, logos) that a manufacturer site repeats on many pages is never a product photo;
   · a SKU photo is an OPTION photo: one picture given to every option of a page is the page's photo, and an old
     small catalog thumbnail never outranks a larger manufacturer photo of the same product;
   · a person's approved images (content-overrides/<slug>.json "_images") are applied on every run and never lost;
   · nothing is duplicated: the same bytes, or the same picture at another size (perceptual hash), are one photo. */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");

const codeNorm = s => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const MIN_SIDE = 300;          // a product photo must be at least this on its long side
const CHROME_PAGES = 5;        // a small image repeated on this many pages of one line is site chrome

/* image facts from disk: [width, height] (0,0 when unreadable) and a 64-bit perceptual hash */
const dimCache = new Map(), hashCache = new Map();
function dims(file) {
  if (dimCache.has(file)) return dimCache.get(file);
  let d = [0, 0];
  try { const o = execFileSync("identify", ["-format", "%w %h", file + "[0]"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(" ").map(Number); if (o[0] > 0) d = o; } catch (e) {}
  dimCache.set(file, d); return d;
}
function dhash(file) {
  if (hashCache.has(file)) return hashCache.get(file);
  let h = null;
  try {
    const raw = execFileSync("convert", [file + "[0]", "-background", "white", "-flatten", "-colorspace", "Gray", "-resize", "9x8!", "-depth", "8", "gray:-"], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 20 });
    if (raw.length >= 72) { let bits = ""; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += raw[y * 9 + x] > raw[y * 9 + x + 1] ? "1" : "0"; h = bits; }
  } catch (e) {}
  hashCache.set(file, h); return h;
}
const hamming = (a, b) => { if (!a || !b) return 64; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const longSide = d => Math.max(d[0] || 0, d[1] || 0);

/* storefront URL (/assets/…) → file on disk */
const fileOf = (shop, url) => /^\//.test(url || "") ? path.join(shop, "public", url.replace(/^\//, "")) : null;

/* the picture shown for a SKU, as the storefront picks it: SKU photo → page primary → catalog file image */
function shownImage(page, sku, catalogRow) {
  const s = page && (page.skus || []).find(x => codeNorm(x.sku) === codeNorm(sku));
  if (s && s.image) return { url: s.image, from: "sku" };
  const g = page && (page.images_gallery || []);
  const prim = page && (page.image || (g.find(x => x.primary) || g[0] || {}).url);
  if (prim) return { url: prim, from: "page" };
  if (catalogRow && catalogRow.image) return { url: catalogRow.image, from: "catalog" };
  return null;
}

/* ── clean one line's pages: chrome, tiny photos, options sharing one photo, a thumbnail outranking a real photo ── */
function cleanPages(pages, shop, log) {
  const say = (k, m) => { (log[k] = log[k] || []).push(m); };
  const all = Object.values(pages);
  /* 1. site chrome: one small image on CHROME_PAGES+ pages */
  const count = new Map();
  for (const p of all) for (const u of new Set((p.images_gallery || []).map(g => g.url).concat((p.skus || []).map(s => s.image).filter(Boolean)))) count.set(u, (count.get(u) || 0) + 1);
  const chrome = new Set();
  for (const [u, n] of count) { const f = fileOf(shop, u); if (n >= CHROME_PAGES && f && longSide(dims(f)) < MIN_SIDE) chrome.add(u); }
  for (const p of all) {
    const before = (p.images_gallery || []).length;
    p.images_gallery = (p.images_gallery || []).filter(g => !chrome.has(g.url));
    for (const s of p.skus || []) if (chrome.has(s.image)) { s.image = ""; }
    if (chrome.has(p.image)) p.image = null;
    if (p.images_gallery.length !== before) say("chrome_removed", p.page_key);
  }
  for (const p of all) {
    const gal = p.images_gallery || [];
    /* 2. a tiny photo is dropped when the page has a real one */
    const big = gal.filter(g => { const f = fileOf(p && shop, g.url); return !f || longSide(dims(f)) >= MIN_SIDE; });
    if (big.length && big.length < gal.length) { say("tiny_removed", p.page_key); p.images_gallery = gal.filter(g => big.includes(g)); }
    /* 3. duplicates inside one gallery (same picture, other size): keep the largest */
    const kept = [];
    for (const g of p.images_gallery) {
      const f = fileOf(shop, g.url); const h = f && dhash(f);
      const twin = h && kept.find(k => { const kf = fileOf(shop, k.url); return kf && hamming(dhash(kf), h) <= 4; });
      if (!twin) { kept.push(g); continue; }
      if (longSide(dims(f)) > longSide(dims(fileOf(shop, twin.url)))) { Object.assign(twin, { url: g.url }); }
      say("duplicate_removed", p.page_key);
    }
    p.images_gallery = kept;
    /* 4. primary = a real photo: the marked primary unless it is tiny and a larger one exists */
    if (p.images_gallery.length) {
      let prim = p.images_gallery.find(g => g.primary) || p.images_gallery[0];
      const pf = fileOf(shop, prim.url);
      if (pf && longSide(dims(pf)) < MIN_SIDE) { const better = p.images_gallery.find(g => { const f = fileOf(shop, g.url); return f && longSide(dims(f)) >= MIN_SIDE; }); if (better) prim = better; }
      p.images_gallery.forEach(g => { g.primary = g === prim; });
      p.images_gallery = [prim].concat(p.images_gallery.filter(g => g !== prim));
      p.image = prim.url;
    } else if (p.image && /^\//.test(p.image) && !fs.existsSync(fileOf(shop, p.image))) p.image = null;
    /* 5. option photos */
    const skus = p.skus || [];
    const withImg = skus.filter(s => s.image);
    const primF = p.image && fileOf(shop, p.image); const primSide = primF ? longSide(dims(primF)) : 0;
    if (skus.length > 1 && withImg.length === skus.length && new Set(withImg.map(s => s.image)).size === 1) {
      /* the same photo on every option is the page's photo, not an option photo */
      const u = withImg[0].image; skus.forEach(s => { s.image = ""; });
      const f = fileOf(shop, u);
      if (!p.images_gallery.some(g => g.url === u) && (!f || longSide(dims(f)) >= MIN_SIDE) && !(p.images_gallery.length && f && p.images_gallery.some(g => { const gf = fileOf(shop, g.url); return gf && hamming(dhash(gf), dhash(f)) <= 4; })))
        p.images_gallery.push({ url: u, primary: !p.images_gallery.length, caption: "", source: "current catalog photo" });
      if (!p.image && p.images_gallery.length) p.image = p.images_gallery[0].url;
      say("shared_option_photo_to_page", p.page_key);
    }
    for (const s of skus) {
      if (!s.image) continue;
      const f = fileOf(shop, s.image); if (!f) continue;
      const side = longSide(dims(f));
      if (!side) { s.image = ""; say("missing_option_photo_removed", p.page_key + ":" + s.sku); continue; }
      /* an old small thumbnail never outranks a larger manufacturer photo of the same product */
      if (side < MIN_SIDE && primSide >= MIN_SIDE) { s.image = ""; say("small_option_photo_removed", p.page_key + ":" + s.sku); }
    }
  }
  return log;
}

/* ── approved images (content-overrides "_images", import tool): { SKU: [{url, source, note}] } ──
   One picture given to every SKU of a page (or to a one-SKU page) joins the page gallery; a picture for some
   options only is that option's photo. A duplicate (same bytes or same picture) is never added twice. */
function applyApproved(pages, approved, shop, log) {
  const say = (k, m) => { (log[k] = log[k] || []).push(m); };
  const pageOf = {};
  for (const p of Object.values(pages)) for (const s of p.skus || []) pageOf[codeNorm(s.sku)] = p;
  const byPage = new Map();
  for (const [sku, list] of Object.entries(approved || {})) {
    if (sku.startsWith("_")) continue;
    const p = pageOf[codeNorm(sku)]; if (!p) { say("approved_sku_not_on_page", sku); continue; }
    if (!byPage.has(p)) byPage.set(p, new Map());
    for (const it of list || []) { const m = byPage.get(p); if (!m.has(it.url)) m.set(it.url, { it, skus: new Set() }); m.get(it.url).skus.add(codeNorm(sku)); }
  }
  for (const [p, m] of byPage) {
    const all = new Set((p.skus || []).map(s => codeNorm(s.sku)));
    const known = (p.images_gallery || []).map(g => g.url);
    const isDup = u => { const f = fileOf(shop, u); const h = f && dhash(f);
      return known.includes(u) || (h && known.some(k => { const kf = fileOf(shop, k); return kf && hamming(dhash(kf), h) <= 4; })); };
    for (const [u, { it, skus }] of m) {
      const f = fileOf(shop, u); if (f && !fs.existsSync(f)) { say("approved_file_missing", u); continue; }
      const pageWide = all.size <= 1 || [...all].every(c => skus.has(c));
      if (pageWide) {
        if (isDup(u)) { say("approved_duplicate", p.page_key); continue; }
        p.images_gallery = (p.images_gallery || []).concat([{ url: u, primary: false, caption: "", source: it.source || "approved image", note: it.note || "" }]);
        known.push(u);
      } else for (const s of p.skus) if (skus.has(codeNorm(s.sku)) && !s.image) { s.image = u; s.image_source = it.source || "approved image"; }
    }
    if (!(p.images_gallery || []).some(g => g.primary) && (p.images_gallery || []).length) p.images_gallery[0].primary = true;
    const prim = (p.images_gallery || []).find(g => g.primary); if (prim) p.image = prim.url;
    say("approved_applied", p.page_key);
  }
  return log;
}

/* ── owner-retired SKUs (content-overrides "_retired": {SKU: {reason, decided, ref}}) ──
   Reversible: the SKU entry on its page is switched off (status "hidden", disabled) so the storefront and the
   order server drop it — not shown, not searchable, not orderable — while the catalog file, the private price
   record and every past order keep it untouched. Removing the SKU from "_retired" (catalog-images restore) brings
   it back on the next run. A retired SKU is left out of the image audit and the missing-image list. */
function applyRetired(pages, retired, log) {
  const say = (k, m) => { (log[k] = log[k] || []).push(m); };
  const keys = Object.keys(retired || {});
  for (const p of Object.values(pages)) for (const s of p.skus || []) {
    const c = codeNorm(s.sku);
    const k = keys.find(x => codeNorm(x) === c);
    if (k) {
      const r = retired[k] || {};
      s.status = "hidden"; s.disabled = true; s.retired = { reason: r.reason || "", decided: r.decided || "", ref: r.ref || "" };
      say("retired", s.sku);
    } else if (s.retired) { delete s.retired; s.status = "active"; s.disabled = false; say("restored", s.sku); }
  }
  return log;
}

/* ── audit: what a dealer sees per SKU ── */
function audit(slug, catalog, pages, shop, retired) {
  const off = new Set(Object.keys(retired || {}).map(codeNorm));
  const retiredRows = catalog.filter(r => off.has(codeNorm(r.code))).map(r => r.code);
  catalog = catalog.filter(r => !off.has(codeNorm(r.code)));
  const pageOf = {};
  for (const p of Object.values(pages)) for (const s of p.skus || []) pageOf[codeNorm(s.sku)] = p;
  const rows = [], urlProducts = new Map();
  for (const r of catalog) {
    const p = pageOf[codeNorm(r.code)];
    const shown = shownImage(p, r.code, r);
    const f = shown && fileOf(shop, shown.url);
    const d = f ? dims(f) : [0, 0];
    const gallery = p ? (p.images_gallery || []).length : 0;
    const issue = !shown ? "no_photo" : f && !fs.existsSync(f) ? "broken_file" : f && !longSide(d) ? "unreadable" : f && longSide(d) < MIN_SIDE ? "low_resolution" : null;
    if (shown) { if (!urlProducts.has(shown.url)) urlProducts.set(shown.url, new Set()); urlProducts.get(shown.url).add(p ? p.page_key : r.code); }
    rows.push({ sku: r.code, name: r.name || "", category: r.category || "", page: p ? p.page_key : null, shown: shown ? shown.url : null, from: shown ? shown.from : null, size: d.join("x"), gallery, issue });
  }
  /* one picture shown on many DIFFERENT pages is a likely mismatch (a family photo on its own variants is fine) */
  for (const row of rows) if (!row.issue && row.shown && (urlProducts.get(row.shown) || new Set()).size >= CHROME_PAGES) row.issue = "shared_across_products";
  const sum = { line: slug, skus: rows.length, with_photo: rows.filter(r => r.shown && !["broken_file", "unreadable"].includes(r.issue)).length,
    multi_photo: rows.filter(r => r.gallery >= 2).length, retired: retiredRows.length, issues: {} };
  for (const r of rows) if (r.issue) sum.issues[r.issue] = (sum.issues[r.issue] || 0) + 1;
  return { summary: sum, rows };
}

/* ── store an image file into the line's assets: verified type + size, ≤900 px, named by its bytes ── */
function storeImage(buf, assetsDir, assetsUrl, opts) {
  const minSide = opts && opts.minSide != null ? opts.minSide : MIN_SIDE;
  if (!buf || buf.length < 1024) return { error: "empty or too small a file" };
  const tmp = path.join(require("os").tmpdir(), "hcps-img-" + sha(buf).slice(0, 16));
  fs.writeFileSync(tmp, buf);
  const d = dims(tmp);
  if (!longSide(d)) { fs.unlinkSync(tmp); return { error: "not an image" }; }
  if (longSide(d) < minSide) { fs.unlinkSync(tmp); return { error: "too small (" + d.join("x") + ", needs " + minSide + " px)" }; }
  /* photos (or images with no transparency) are JPEG; a PNG with real transparency stays PNG */
  let opaque = true;
  try { opaque = execFileSync("identify", ["-format", "%[opaque]", tmp + "[0]"]).toString().trim().toLowerCase() === "true"; } catch (e) {}
  const ext = opaque ? "jpg" : "png";
  const out = tmp + "." + ext;
  const args = [tmp + "[0]", "-resize", "900x900>", "-strip"].concat(ext === "jpg" ? ["-background", "white", "-flatten", "-quality", "80"] : []).concat([out]);
  execFileSync("convert", args);
  const ob = fs.readFileSync(out); fs.unlinkSync(tmp); fs.unlinkSync(out);
  fs.mkdirSync(assetsDir, { recursive: true });
  const name = sha(ob).slice(0, 20) + "." + ext; const file = path.join(assetsDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, ob);
  return { url: assetsUrl + name, file, size: dims(file).join("x"), original: d.join("x") };
}

/* ── ZIP / folder file names → SKUs: the longest catalog code the file name starts with (after normalising);
   what follows must be nothing, a separator, a view word or a number ("RS1x36_2.jpg", "MC01-front.png");
   a folder named after a SKU claims every image inside it. Ambiguous or unknown names are reported, never guessed. */
function matchFileToSku(relPath, codes) {
  const parts = relPath.split(/[\\/]/); const base = parts.pop().replace(/\.[a-z0-9]+$/i, "");
  const norm = codeNorm;
  for (const dir of parts.reverse()) { const hit = codes.filter(c => norm(c) === norm(dir)); if (hit.length === 1) return { sku: hit[0], by: "folder" }; }
  const raw = base.toUpperCase();
  const cands = codes.filter(c => {
    const C = c.toUpperCase();
    if (raw === C) return true;
    if (raw.startsWith(C)) { const rest = raw.slice(C.length); return /^[\s_\-.()]+/.test(rest) || /^\d{1,2}$/.test(rest) && !codes.some(o => o.toUpperCase() === raw); }
    return norm(base) === norm(c);
  });
  if (!cands.length) return { sku: null, why: "no catalog SKU at the start of the file name" };
  const best = cands.sort((a, b) => b.length - a.length);
  if (best.length > 1 && best[0].length === best[1].length) return { sku: null, why: "matches more than one SKU: " + best.slice(0, 3).join(", ") };
  return { sku: best[0], by: "file name" };
}

module.exports = { codeNorm, sha, dims, dhash, hamming, longSide, fileOf, shownImage, cleanPages, applyApproved, applyRetired, audit, storeImage, matchFileToSku, MIN_SIDE, CHROME_PAGES };
