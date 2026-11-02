// Golden ⇄ HCPS Partner 360 — batch B2 (HCPS side): golden-proxy catalog + inventory, and the preview path that uses
// a SEPARATE test key against a Golden deploy preview. Synthetic data only; no network.
//   node test/golden-integration-b2.test.js
// When the Golden repo is checked out beside this one (../golden-dealer-portal), a REAL cross-repo round trip runs
// Golden's real /v1/catalog + /v1/inventory handlers (real catalog data file) behind this repo's signed client.
"use strict";
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");
const GOLDEN = process.env.GOLDEN_REPO || path.join(ROOT, "..", "golden-dealer-portal");
let pass = 0, fail = 0, skipped = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, "\n   ", e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e); } };
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((m || "") + " got " + A + " want " + B); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

const VEC = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/contracts/golden-commerce-v1.signing-vectors.json"), "utf8"));
const SECRET = VEC.secret;
const TEST_SECRET = "TEST-ONLY-preview-key-0123456789abcdefghijklmnopqrstuvwxyz-0001";
const PREVIEW_GOLDEN = "https://deploy-preview-280--goldenonlineordering.netlify.app";
const PREVIEW_ORIGIN = "https://deploy-preview-17--hcpsonlineordering.netlify.app";
const D_HQ = "11111111-2222-4333-8444-555555555555", D_BR = "66666666-2222-4333-8444-555555555555", D_TEST = "3f7d87a2-0000-4000-8000-000000000001";
const PREVIEW_TOKEN = "a".repeat(48);

function load(mod) { Object.keys(require.cache).forEach(k => { if (k.startsWith(FN)) delete require.cache[k]; }); return require(path.join(FN, mod)); }
function env(extra) {
  process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_ROLE = "svc";
  process.env.GOLDEN_P360_KEY_ID = "hcps-p360-1"; process.env.GOLDEN_P360_SECRET = SECRET;
  delete process.env.GOLDEN_API_BASE;
  delete process.env.GOLDEN_P360_TEST_KEY_ID; delete process.env.GOLDEN_P360_TEST_SECRET; delete process.env.GOLDEN_TEST_API_BASE;
  Object.assign(process.env, extra || {});
}
const PREVIEW_ENV = { GOLDEN_P360_TEST_KEY_ID: "hcps-p360-preview-1", GOLDEN_P360_TEST_SECRET: TEST_SECRET, GOLDEN_TEST_API_BASE: PREVIEW_GOLDEN };

const CATALOG = (pv) => ({ contract_version: "1.1.0", tenant: "hcps", request_id: "req_c", as_of: "2026-11-02T19:00:00Z", etag: "e".repeat(32), catalog_version: "x",
  prices_visible: pv, linked: pv, reason: pv ? null : "no_verified_link", products: [
    Object.assign({ sku: "PR535-MED", family: "PR535", family_name: "MaxiComforter™", name: "MaxiComforter™", category: "Lift Chairs", subcategory: "2-Zone",
      size_code: "MED", size_label: "Medium", description: "d", specs: ["375 lbs max"], zones: null, class_ii: true, ribbon: null, color_note: null,
      badges: { is_new: false, is_featured: false, is_best_seller: false, top_new: false }, brochure_url: "http://insecure.invalid/x", action: "configure",
      image: "https://cdn.example.invalid/pr535.webp", msrp: 2326, emap: 1793, sort: 27, customer_no: "LEAK-ACCT", terms: "NET30" },
      pv ? { dealer_price: 900, price_source: "account" } : { dealer_price: 123 }),
    { sku: "GB107B", family: "GB107B", family_name: "BuzzAround LT™", name: "BuzzAround LT™ 3-Wheel", category: "Scooters", subcategory: "BuzzAround",
      size_code: null, size_label: null, description: null, specs: [], zones: null, class_ii: true, ribbon: null, color_note: "Red", badges: {}, brochure_url: null,
      action: "add", image: "javascript:alert(1)", msrp: 1588, emap: 1266, sort: 50 },
  ] });

function world(o) {
  o = o || {};
  const sb = [], golden = [];
  const flags = o.flags === undefined ? { golden_p360_catalog: true, golden_p360_pilot_dealers: [D_HQ] } : o.flags;
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (/goldenonlineordering\.netlify\.app\//.test(u)) {
      golden.push({ url: u, headers: init.headers || {} });
      if (o.golden) return o.golden(u, init);
      if (/\/v1\/catalog/.test(u)) return res(200, CATALOG(o.pricesVisible !== false));
      if (/\/v1\/inventory/.test(u)) return res(200, { contract_version: "1.1.0", tenant: "hcps", request_id: "req_i", as_of: "2026-11-02T08:00:00Z", stale: false, low_stock_threshold: 50,
        items: [{ sku: "PR535-MED", status: "in", qty: 120 }, { sku: "GB107B", status: "weird", qty: 2 }, { sku: "BD100A-TB", status: "on_request", qty: null }] });
      return res(200, { contract_version: "1.1.0", state: "browse_only", capabilities: { see_prices: false, order: false, history: false }, request_id: "req_e" });
    }
    sb.push({ url: u, method: init.method || "GET" });
    if (/auth\/v1\/user/.test(u)) return o.noUser ? res(401, {}) : res(200, { id: "uid-1" });
    if (/dealer_users/.test(u)) return res(200, o.noUser ? [] : [{ status: "approved", dealer_id: o.dealer || D_HQ }]);
    if (/dealer_preview_tokens/.test(u)) return res(200, [{ dealer_id: D_TEST, expires_at: new Date(Date.now() + 3600e3).toISOString() }]);
    if (/app_settings/.test(u)) return res(200, flags == null ? [] : [{ value: flags }]);
    if (/dealers\?id=eq\./.test(u)) { const id = decodeURIComponent(u.match(/id=eq\.([^&]+)/)[1]);
      const all = { [D_HQ]: { id: D_HQ, parent_id: null }, [D_BR]: { id: D_BR, parent_id: D_HQ }, [D_TEST]: { id: D_TEST, parent_id: null } };
      return res(200, all[id] ? [all[id]] : []); }
    return res(200, []);
  };
  return { sb, golden };
}
const post = (b, h) => ({ httpMethod: "POST", headers: Object.assign({}, h || { authorization: "Bearer jwt" }), body: JSON.stringify(b) });
const staffPreview = (extra) => post(null, Object.assign({ "x-hcps-preview": PREVIEW_TOKEN, "x-hcps-golden-env": "preview", origin: PREVIEW_ORIGIN }, extra || {}));
const asBody = (h, b) => Object.assign(h, { body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);

(async () => {
  await t("catalog: switch on + pilot → Golden's products, only contract fields, https-only links, prices as Golden says", async () => {
    env(); const w = world();
    const j = J(await load("golden-proxy.js").handler(post({ action: "catalog" })));
    eq([j.ok, j.enabled, j.available, j.prices_visible], [true, true, true, true]);
    const p = j.products[0];
    eq([p.dealer_price, p.price_source], [900, "account"]);
    ok(!("customer_no" in p) && !("terms" in p), "unknown fields dropped");
    eq(p.brochure_url, null, "http brochure dropped"); eq(j.products[1].image, null, "non-https image dropped");
    ok(w.golden.length === 1 && /\/v1\/catalog$/.test(w.golden[0].url), "one signed GET to production Golden");
    ok(/^https:\/\/goldenonlineordering\.netlify\.app\//.test(w.golden[0].url));
    ok(String(w.golden[0].headers.authorization || w.golden[0].headers.Authorization).includes("kid=hcps-p360-1"), "production key");
  });
  await t("catalog: when Golden hides prices, a stray dealer_price never reaches the browser", async () => {
    env(); world({ pricesVisible: false });
    const j = J(await load("golden-proxy.js").handler(post({ action: "catalog" })));
    eq(j.prices_visible, false);
    ok(j.products.every(p => !("dealer_price" in p) && !("price_source" in p)), "no price keys");
  });
  await t("inventory: statuses passed through, unknown status dropped, stale defaults to true when absent", async () => {
    env(); world();
    const j = J(await load("golden-proxy.js").handler(post({ action: "inventory" })));
    eq(j.items, [{ sku: "PR535-MED", status: "in", qty: 120 }, { sku: "BD100A-TB", status: "on_request", qty: null }]);
    eq([j.as_of, j.stale, j.low_stock_threshold], ["2026-11-02T08:00:00Z", false, 50]);
    env(); world({ golden: (u) => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) });
    eq(J(await load("golden-proxy.js").handler(post({ action: "inventory" }))).stale, true);
  });
  await t("switch off / not in pilot / unknown action / no sign-in → Golden never called", async () => {
    env(); let w = world({ flags: { golden_p360_catalog: false } });
    eq(J(await load("golden-proxy.js").handler(post({ action: "catalog" }))).reason, "switched_off"); eq(w.golden.length, 0);
    env(); w = world({ flags: { golden_p360_catalog: true, golden_p360_pilot_dealers: [] } });
    eq(J(await load("golden-proxy.js").handler(post({ action: "inventory" }))).reason, "not_in_pilot"); eq(w.golden.length, 0);
    env(); w = world();
    eq((await load("golden-proxy.js").handler(post({ action: "orders" }))).statusCode, 400);
    env(); w = world({ noUser: true });
    eq((await load("golden-proxy.js").handler(post({ action: "catalog" }))).statusCode, 401); eq(w.golden.length, 0);
  });
  await t("Golden refusal or outage → 'not available', never stale or guessed data; branch refusal named", async () => {
    env(); world({ golden: () => ({ ok: false, status: 503, json: async () => ({ error: { code: "pricing_unavailable" } }) }) });
    const j = J(await load("golden-proxy.js").handler(post({ action: "catalog" })));
    eq([j.available, j.reason, j.products], [false, "golden_unavailable", undefined]);
    env(); world({ dealer: D_BR, flags: { golden_p360_catalog: true, golden_p360_pilot_dealers: [D_HQ] },
      golden: () => ({ ok: false, status: 403, json: async () => ({ error: { code: "branch_not_permitted" } }) }) });
    eq(J(await load("golden-proxy.js").handler(post({ action: "catalog" }))).reason, "branch_not_permitted");
  });
  await t("preview: staff view-as from a Partner 360 deploy preview → TEST key to the Golden deploy preview, production switches not needed", async () => {
    env(PREVIEW_ENV); const w = world({ flags: { golden_p360_catalog: false } });
    const j = J(await load("golden-proxy.js").handler(asBody(staffPreview(), { action: "catalog" })));
    eq([j.ok, j.enabled, j.available, j.preview], [true, true, true, true]);
    eq(w.golden.length, 1); ok(w.golden[0].url.startsWith(PREVIEW_GOLDEN + "/v1/catalog"), "deploy-preview Golden");
    const auth = String(w.golden[0].headers.authorization || w.golden[0].headers.Authorization);
    ok(auth.includes("kid=hcps-p360-preview-1") && !auth.includes("kid=hcps-p360-1,"), "test key, not production");
    const dlg = JSON.parse(Buffer.from(String(w.golden[0].headers["x-hcps-delegation"] || w.golden[0].headers["X-HCPS-Delegation"]), "base64url").toString());
    eq([dlg.role, dlg.sub_dealer], ["staff_preview", D_TEST]);
  });
  await t("preview is refused for a dealer sign-in, the production storefront and foreign origins", async () => {
    for (const h of [
      { authorization: "Bearer jwt", "x-hcps-golden-env": "preview", origin: PREVIEW_ORIGIN },                       // real dealer, not staff
      { "x-hcps-preview": PREVIEW_TOKEN, "x-hcps-golden-env": "preview", origin: "https://hcpsonlineordering.netlify.app" },
      { "x-hcps-preview": PREVIEW_TOKEN, "x-hcps-golden-env": "preview", origin: "https://deploy-preview-1--evil.netlify.app" },
      { "x-hcps-preview": PREVIEW_TOKEN, "x-hcps-golden-env": "preview" },
    ]) {
      env(PREVIEW_ENV); const w = world();
      const r = await load("golden-proxy.js").handler(asBody(post(null, h), { action: "catalog" }));
      eq([r.statusCode, J(r).error], [403, "preview_not_allowed"], JSON.stringify(h)); eq(w.golden.length, 0);
    }
  });
  await t("preview test key is unusable unless it is distinct and points at a Golden deploy preview", async () => {
    for (const bad of [{ GOLDEN_TEST_API_BASE: "https://goldenonlineordering.netlify.app" }, { GOLDEN_TEST_API_BASE: "https://deploy-preview-1--evil.netlify.app" },
                       { GOLDEN_P360_TEST_SECRET: SECRET }, { GOLDEN_P360_TEST_KEY_ID: "hcps-p360-1" }, { GOLDEN_P360_TEST_SECRET: "short" }]) {
      env(Object.assign({}, PREVIEW_ENV, bad)); const w = world();
      const j = J(await load("golden-proxy.js").handler(asBody(staffPreview(), { action: "catalog" })));
      eq([j.enabled, j.reason], [false, "golden_preview_not_configured"], JSON.stringify(bad)); eq(w.golden.length, 0);
    }
  });
  await t("no competing store: every Supabase call golden-proxy makes is a read", async () => {
    env(PREVIEW_ENV); const w = world();
    for (const a of ["eligibility", "catalog", "inventory"]) {
      await load("golden-proxy.js").handler(post({ action: a }));
      await load("golden-proxy.js").handler(asBody(staffPreview(), { action: a }));
    }
    ok(w.sb.length > 0 && w.sb.every(c => c.method === "GET"), "only GETs: " + JSON.stringify(w.sb.filter(c => c.method !== "GET")));
    const src = fs.readFileSync(path.join(FN, "golden-proxy.js"), "utf8");
    ok(!/method:\s*["'](POST|PATCH|PUT|DELETE)["']/.test(src.replace(/GC\.call\(\{ method:"GET"/g, "")), "no write calls in source");
  });

  // ── Real cross-repo round trip (Golden's real handlers + real catalog data) ──
  const gFN = path.join(GOLDEN, "repo", "functions");
  if (!fs.existsSync(path.join(gFN, "v1-catalog.js"))) { skipped++; console.log("skip  cross-repo catalog round trip (Golden B2 not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: real /v1/catalog + /v1/inventory behind this repo's client; prices only for the verified, price-visible link", async () => {
    const { createMock } = require(path.join(GOLDEN, "repo", "tests", "support", "postgrest-mock.js"));
    const fresh = m => { Object.keys(require.cache).forEach(k => { if (k.startsWith(gFN)) delete require.cache[k]; }); return require(path.join(gFN, m)); };
    const gS = fresh("lib/hcps-s2s.js");
    const run = async (visibility, action) => {
      env({ GOLDEN_API_BASE: "https://golden.test" });
      process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.GOLDEN_V1_API = "true"; process.env.HCPS_P360_KEYS = JSON.stringify({ "hcps-p360-1": SECRET });
      const nonces = new Set();
      const goldenSb = createMock({ tables: {
        integration_clients: [{ kid: "hcps-p360-1", client_id: "hcps-partner360", tenant_id: "hcps", scopes: ["golden:read"], active: true, secret_fingerprint: gS.fingerprint(SECRET) }],
        dealer_integration_map: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", tenant_id: "hcps", client_id: "hcps-partner360", hcps_dealer_id: D_HQ, golden_dealer_id: "dealer-a", status: "verified", price_visibility: visibility }],
        dealer_integration_branch_map: [], dealers: [{ id: "dealer-a", active: true }],
        inventory: [{ sku: "PR535-MED", size: "MED", avail: 80, updated_at: new Date().toISOString() }],
      }, rpc: {
        integration_nonce_claim: a => { const k = a.p_nonce; const f1 = !nonces.has(k); nonces.add(k); return f1; },
        integration_audit_log: () => null,
        get_dealer_portal_data: () => ({ dealer: { customer_no: "LEAK" }, pricing: [{ sku: "PR535-MED", dealer_cost: 901 }] }),
      } });
      const handler = fresh(action === "catalog" ? "v1-catalog.js" : "v1-inventory.js").handler;
      world();
      const hcpsFetch = global.fetch;
      global.fetch = async (u, init) => {
        if (String(u).startsWith("https://golden.test/")) {
          const url = new URL(String(u));
          const ev = { httpMethod: init.method, rawUrl: String(u), path: url.pathname, headers: init.headers, queryStringParameters: Object.fromEntries(url.searchParams), body: init.body || "", isBase64Encoded: false };
          const saved = global.fetch; global.fetch = (x, y) => goldenSb(String(x).replace("https://sb.test", "http://sb.test"), y);
          process.env.SUPABASE_URL = "http://sb.test";
          try { const r = await handler(ev); return { ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(r.body), text: async () => r.body }; }
          finally { global.fetch = saved; process.env.SUPABASE_URL = "https://sb.test"; }
        }
        return hcpsFetch(u, init);
      };
      return J(await load("golden-proxy.js").handler(post({ action })));
    };
    const priced = await run("dealer", "catalog");
    eq([priced.available, priced.prices_visible], [true, true]);
    ok(priced.products.length >= 80, "real catalog: " + priced.products.length);
    const pr = priced.products.find(p => p.sku === "PR535-MED");
    eq([pr.dealer_price, pr.price_source, pr.family, pr.size_code], [901, "account", "PR535", "MED"]);
    ok(!JSON.stringify(priced).includes("LEAK"), "account number never crosses");
    const hidden = await run("none", "catalog");
    eq(hidden.prices_visible, false); ok(hidden.products.every(p => !("dealer_price" in p)));
    const inv = await run("dealer", "inventory");
    eq(inv.items.find(i => i.sku === "PR535-MED"), { sku: "PR535-MED", status: "in", qty: 80 });
    eq(inv.stale, false);
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
