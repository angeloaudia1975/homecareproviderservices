// Self-contained admin UI test: no network server. Playwright intercepts every
// request and fulfills it from _site on disk; the admin-api is mocked in-memory.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SITE = path.resolve(__dirname, "..", "_site");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

// mutable in-memory copies
const store = {
  "src/_data/manufacturers.json": fs.readFileSync(path.join(ROOT, "src/_data/manufacturers.json"), "utf8"),
  "src/_data/documents.json": fs.readFileSync(path.join(ROOT, "src/_data/documents.json"), "utf8"),
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await ctx.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/.netlify/functions/admin-api")) {
      let d = {}; try { d = JSON.parse(req.postData() || "{}"); } catch {}
      const ok = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
      const bad = (c, o) => route.fulfill({ status: c, contentType: "application/json", body: JSON.stringify(o) });
      if (d.action === "login") return d.password === "testpass" ? ok({ token: "mock", github: true }) : bad(401, { error: "Incorrect password." });
      if (d.action === "ping") return ok({ ok: true, github: true });
      if (d.action === "get") return ok({ content: store[d.path] || null, sha: "s1" });
      if (d.action === "put") { store[d.path] = d.content; return ok({ ok: true, sha: "s2" }); }
      if (d.action === "upload") return ok({ ok: true, sha: "s3" });
      return bad(400, { error: "unknown" });
    }
    // static from _site
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const full = path.join(SITE, p);
    if (full.startsWith(SITE) && fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
      return route.fulfill({ status: 200, contentType: MIME[path.extname(full)] || "application/octet-stream", body: fs.readFileSync(full) });
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "404" }); // missing product imgs etc.
  });

  const step = async (name, fn) => { try { await fn(); console.log("PASS " + name); } catch (e) { console.log("FAIL " + name + " -- " + e.message); errors.push(name + ": " + e.message); } };

  await page.goto("http://local.test/admin/", { waitUntil: "domcontentloaded" });

  await step("login", async () => {
    await page.fill("#password", "testpass");
    await page.click("#login-btn");
    await page.waitForSelector("#app:not([hidden])", { timeout: 5000 });
  });
  await step("manufacturer index lists 12", async () => {
    await page.waitForSelector(".pick-card");
    const n = await page.$$eval(".pick-card", (e) => e.length);
    if (n !== 12) throw new Error("expected 12, got " + n);
  });
  await step("Golden opens with 7 section editors", async () => {
    await page.click(".pick-card:nth-child(1)");
    await page.waitForSelector("#sections .card");
    const tags = await page.$$eval("#sections .card .type-tag", (e) => e.map((x) => x.textContent));
    if (tags.length < 7) throw new Error("got " + tags.length + " sections [" + tags + "]");
  });
  await step("editing marks dirty", async () => {
    await page.fill("#sections textarea, #sections input[type=text]", "EDITED");
    await page.waitForSelector(".dirty-dot", { timeout: 3000 });
  });
  await step("publish manufacturers persists", async () => {
    page.on("dialog", (d) => d.accept());
    await page.click("#save-btn");
    await page.waitForSelector(".toast.ok", { timeout: 4000 });
    if (!/EDITED/.test(store["src/_data/manufacturers.json"])) throw new Error("edit not saved to store");
  });
  await step("stub: add all 13 block types", async () => {
    await page.click(".crumbs a");
    await page.waitForSelector(".pick-card");
    await page.click(".pick-card:nth-child(3)"); // Complete Medical Supplies (stub)
    await page.waitForSelector(".addblock select");
    const types = await page.$$eval(".addblock option", (e) => e.map((x) => x.value).filter(Boolean));
    for (const t of types) { await page.selectOption(".addblock select", t); await page.click(".addblock button"); }
    const n = await page.$$eval("#sections .card", (e) => e.length);
    if (n !== types.length) throw new Error("added " + n + " of " + types.length);
    console.log("   all editors rendered: " + types.join(", "));
  });
  await step("reorder + remove block", async () => {
    const before = await page.$$eval("#sections .type-tag", (e) => e.map((x) => x.textContent));
    await page.click("#sections .card:nth-child(1) button[title='Move down']");
    const after = await page.$$eval("#sections .type-tag", (e) => e.map((x) => x.textContent));
    if (before[0] === after[0]) throw new Error("move down did nothing");
    const cnt1 = await page.$$eval("#sections .card", (e) => e.length);
    await page.click("#sections .card:nth-child(1) .btn.danger");
    const cnt2 = await page.$$eval("#sections .card", (e) => e.length);
    if (cnt2 !== cnt1 - 1) throw new Error("remove failed");
  });
  await step("table matrix add row", async () => {
    const rb = await page.$$eval("#sections .matrix tbody tr", (e) => e.length);
    await page.click("#sections .matrix >> text=+ Row");
    const ra = await page.$$eval("#sections .matrix tbody tr", (e) => e.length);
    if (ra !== rb + 1) throw new Error("row not added " + rb + "->" + ra);
  });
  await step("documents: add + persist", async () => {
    await page.click(".tab[data-view=documents]");
    await page.waitForSelector(".doc-table, .empty");
    const before = JSON.parse(store["src/_data/documents.json"]).items.length;
    await page.click(".view-head .btn.primary");
    await page.waitForSelector(".modal");
    await page.fill(".modal input[type=text]", "Test Brochure XYZ");
    await page.click(".modal-foot .btn.primary");
    await page.waitForSelector(".toast.ok", { timeout: 4000 });
    const after = JSON.parse(store["src/_data/documents.json"]).items.length;
    if (after !== before + 1) throw new Error("doc not added " + before + "->" + after);
    if (!/Test Brochure XYZ/.test(store["src/_data/documents.json"])) throw new Error("title not saved");
  });

  await page.screenshot({ path: path.join(__dirname, "admin-shot.png"), fullPage: false });
  await browser.close();
  console.log("\n" + (errors.length
    ? "RESULT: " + errors.length + " issue(s):\n" + errors.map((e) => "  - " + e).join("\n")
    : "RESULT: ALL CHECKS PASSED (no console/page errors)"));
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
