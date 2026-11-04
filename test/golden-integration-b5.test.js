// Golden ⇄ HCPS Partner 360 — batch B5 (HCPS side): golden-proxy `history` → Golden GET /v1/history and `order` →
// GET /v1/orders/{order_ref} (contract 1.5.0). Synthetic data only. When ../golden-dealer-portal has B5 checked out, a
// REAL cross-repo round trip runs Golden's real history code behind this repo's signed client.
//   node test/golden-integration-b5.test.js
"use strict";
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");
const GOLDEN = process.env.GOLDEN_REPO || path.join(ROOT, "..", "golden-dealer-portal");
let pass = 0, fail = 0, skipped = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, "\n   ", e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e); } };
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((m || "") + " got " + A + " want " + B); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const SECRET = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/contracts/golden-commerce-v1.signing-vectors.json"), "utf8")).secret;
const D_HQ = "11111111-2222-4333-8444-555555555555";
function load(mod) { Object.keys(require.cache).forEach(k => { if (k.startsWith(FN)) delete require.cache[k]; }); return require(path.join(FN, mod)); }
function env(extra) {
  process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_ROLE = "svc";
  process.env.GOLDEN_P360_KEY_ID = "hcps-p360-1"; process.env.GOLDEN_P360_SECRET = SECRET;
  delete process.env.GOLDEN_API_BASE; delete process.env.GOLDEN_P360_TEST_KEY_ID; delete process.env.GOLDEN_P360_TEST_SECRET; delete process.env.GOLDEN_TEST_API_BASE;
  Object.assign(process.env, extra || {});
}
const ORDER = (over) => Object.assign({ order_ref: "P501", source: "linked", status: "shipped", placed_on: "2026-10-01", po_number: "PO-77", so_numbers: ["SO1001"],
  ship_to: { city: "Cincinnati", state: "OH", address: "LEAK" }, expected_date: "2026-10-09", contact: "LEAK", email: "LEAK@x",
  items: [{ sku: "PR511-LAR", description: "Cloud Plus", qty: 2, cost: "LEAK" }],
  tracking: [{ so_number: "SO1001", carrier: "UPS", tracking_number: "1Z999", ship_date: "2026-10-08", url: "javascript:LEAK" }],
  lifecycle: [{ type: "shipped", at: "2026-10-08", so_number: "SO1001", label: "Shipped" }, { type: "variance", label: "LEAK" }],
  totals: { subtotal: 2600, freight: 0, sh: 78, total: 2678 } }, over || {});
const HIST = (over) => Object.assign({ contract_version: "1.5.0", request_id: "req_h", prices_visible: true, orders: [ORDER(), ORDER({ order_ref: "GSO1002", status: "acknowledged", source: "golden" })], next_before: "GSO1002" }, over || {});
function world(o) {
  o = o || {}; const golden = [];
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (/goldenonlineordering\.netlify\.app\//.test(u)) { golden.push({ u, init }); return o.golden ? o.golden(u, init) : res(200, /\/v1\/orders\//.test(u) ? { contract_version: "1.5.0", prices_visible: true, order: ORDER() } : HIST()); }
    if (/auth\/v1\/user/.test(u)) return res(200, { id: "uid-1" });
    if (/dealer_users/.test(u)) return res(200, [{ status: "approved", dealer_id: D_HQ }]);
    if (/app_settings/.test(u)) return res(200, [{ value: Object.assign({ golden_p360_catalog: true, golden_p360_pilot_dealers: [D_HQ] }, o.flags || {}) }]);
    if (/dealers\?id=eq\./.test(u)) return res(200, [{ id: D_HQ, parent_id: null }]);
    if ((init.method || "GET") !== "GET") throw new Error("HCPS must store nothing: " + init.method + " " + u);
    return res(200, []);
  };
  return { golden };
}
const post = b => ({ httpMethod: "POST", headers: { authorization: "Bearer jwt" }, body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);
const ON = { flags: { golden_p360_history: true } };

(async () => {
  await t("history: GET /v1/history with only limit/before; answer allow-listed (no contact, street, cost, variance, unsafe tracking)", async () => {
    env(); const w = world(ON);
    const r = J(await load("golden-proxy.js").handler(post({ action: "history", limit: 20, before: "P502", dealer_id: "x" })));
    const g = new URL(w.golden[0].u);
    eq([g.pathname, w.golden[0].init.method, g.searchParams.get("limit"), g.searchParams.get("before"), g.searchParams.has("dealer_id")], ["/v1/history", "GET", "20", "P502", false]);
    eq([r.available, r.prices_visible, r.orders.length, r.next_before, r.orders[0].totals.total, r.orders[0].tracking[0].tracking_number], [true, true, 2, "GSO1002", 2678, "1Z999"]);
    eq(r.orders[0].lifecycle.map(e => e.type), ["shipped"]);
    ok(!/LEAK/.test(JSON.stringify(r)), "nothing outside the contract crosses");
  });
  await t("history: no amounts when Golden says prices are hidden; a malformed order = no history (all-or-nothing)", async () => {
    const res = (status, body) => ({ ok: true, status, text: async () => JSON.stringify(body), json: async () => body });
    env(); world(Object.assign({ golden: () => res(200, HIST({ prices_visible: false })) }, ON));
    ok(J(await load("golden-proxy.js").handler(post({ action: "history" }))).orders.every(o => !("totals" in o)));
    env(); world(Object.assign({ golden: () => res(200, HIST({ orders: [ORDER({ tracking: [{ so_number: "SO1", carrier: "UPS", tracking_number: "<img src=x onerror=1>", ship_date: "2026-10-08" }] })] })) }, ON));
    eq(J(await load("golden-proxy.js").handler(post({ action: "history" }))).orders[0].tracking[0].tracking_number, "", "unsafe tracking text is blanked");
    for (const bad of [{ order_ref: "x'><" }, { status: "teleported" }, null]) {
      env(); world(Object.assign({ golden: () => res(200, HIST({ orders: [ORDER(), bad === null ? null : ORDER(bad)] })) }, ON));
      const r = J(await load("golden-proxy.js").handler(post({ action: "history" })));
      eq([r.available, r.reason, r.orders], [false, "golden_unavailable", undefined], JSON.stringify(bad));
    }
  });
  await t("order: GET /v1/orders/{ref}; must be the ref asked for; 404 → not_found", async () => {
    env(); const w = world(ON);
    const r = J(await load("golden-proxy.js").handler(post({ action: "order", order_ref: "P501" })));
    eq([new URL(w.golden[0].u).pathname, r.order.order_ref, r.order.status], ["/v1/orders/P501", "P501", "shipped"]);
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    env(); world(Object.assign({ golden: () => res(200, { prices_visible: true, order: ORDER({ order_ref: "P999" }) }) }, ON));
    eq(J(await load("golden-proxy.js").handler(post({ action: "order", order_ref: "P501" }))).reason, "golden_unavailable", "an answer for another order is not shown");
    env(); world(Object.assign({ golden: () => res(404, { error: { code: "not_found" } }) }, ON));
    eq(J(await load("golden-proxy.js").handler(post({ action: "order", order_ref: "P501" }))).reason, "not_found");
    for (const [code, reason] of [["history_not_enabled", "history_not_enabled"], ["branch_history_not_permitted", "branch_history_not_permitted"], ["history_unavailable", "history_unavailable"]]) {
      env(); world(Object.assign({ golden: () => res(code === "history_unavailable" ? 503 : 403, { error: { code } }) }, ON));
      eq(J(await load("golden-proxy.js").handler(post({ action: "history" }))).reason, reason);
    }
  });
  await t("history: bad requests refused before Golden; production needs golden_p360_history exactly true", async () => {
    for (const b of [{ action: "history", limit: 0 }, { action: "history", limit: 51 }, { action: "history", limit: "5" }, { action: "history", before: "../x" }, { action: "order" }, { action: "order", order_ref: "P1/../x" }]) {
      env(); const w = world(ON); eq((await load("golden-proxy.js").handler(post(b))).statusCode, 400, JSON.stringify(b)); eq(w.golden.length, 0);
    }
    for (const flags of [{}, { golden_p360_history: "true" }, { golden_p360_history: 1 }]) {
      env(); const w = world({ flags });
      eq(J(await load("golden-proxy.js").handler(post({ action: "history" }))).reason, "history_switched_off", JSON.stringify(flags)); eq(w.golden.length, 0);
    }
  });

  await t("staff preview token on the PRODUCTION path never reads a dealer's history; an unknown source = no history (all-or-nothing)", async () => {
    const PT = "ab12".repeat(12);
    for (const b of [{ action: "history" }, { action: "order", order_ref: "P501" }]) {
      env(); const w = world(ON); const saved = global.fetch;
      global.fetch = async (u, i) => /dealer_users|auth\/v1\/user/.test(String(u)) ? { ok: true, status: 200, json: async () => [], text: async () => "[]" }
        : /dealer_preview_tokens/.test(String(u)) ? { ok: true, status: 200, json: async () => [{ dealer_id: D_HQ, expires_at: new Date(Date.now() + 3600e3).toISOString() }], text: async () => "" } : saved(u, i);
      const r = await load("golden-proxy.js").handler({ httpMethod: "POST", headers: { "x-hcps-preview": PT }, body: JSON.stringify(b) });
      eq([r.statusCode, J(r).error], [403, "preview_not_allowed"], JSON.stringify(b)); eq(w.golden.length, 0);
    }
    const res = (status, body) => ({ ok: true, status, text: async () => JSON.stringify(body), json: async () => body });
    env(); world(Object.assign({ golden: () => res(200, HIST({ orders: [ORDER(), ORDER({ source: "teleported" })] })) }, ON));
    eq(J(await load("golden-proxy.js").handler(post({ action: "history" }))).reason, "golden_unavailable");
  });

  // ── Real cross-repo round trip ──
  const gFN = path.join(GOLDEN, "repo", "functions");
  if (!fs.existsSync(path.join(gFN, "v1-history.js"))) { skipped++; console.log("skip  cross-repo history round trip (Golden B5 not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: Golden's real history + order behind this repo's client — merged order, tracking, privacy", async () => {
    const { createMock } = require(path.join(GOLDEN, "repo", "tests", "support", "postgrest-mock.js"));
    const fresh = m => { Object.keys(require.cache).forEach(k => { if (k.startsWith(gFN)) delete require.cache[k]; }); return require(path.join(gFN, m)); };
    const gS = fresh("lib/hcps-s2s.js");
    const GC = ["so_number","customer_no","order_date","expected_date","so_status","stat_code","order_type","customer_po","ext_total","carrier","tracking_number","ship_date","ship_city","ship_state","replaced_by_so","replaces_so","revision_status"];
    const g = (o) => { GC.forEach(k => { if (!(k in o)) o[k] = null; }); return o; };
    const call = async (body) => {
      env({ GOLDEN_API_BASE: "https://golden.test" });
      process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.GOLDEN_V1_API = "true"; process.env.HCPS_P360_KEYS = JSON.stringify({ "hcps-p360-1": SECRET });
      const goldenSb = createMock({ tables: {
        integration_clients: [{ kid: "hcps-p360-1", client_id: "hcps-partner360", tenant_id: "hcps", scopes: ["golden:read", "golden:history"], active: true, secret_fingerprint: gS.fingerprint(SECRET) }],
        dealer_integration_map: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", tenant_id: "hcps", client_id: "hcps-partner360", hcps_dealer_id: D_HQ, golden_dealer_id: "dealer-a", status: "verified", price_visibility: "dealer", history_enabled: true }],
        dealer_integration_branch_map: [], dealers: [{ id: "dealer-a", active: true, customer_no: "100001" }],
        orders: [{ id: 501, dealer_id: "dealer-a", created_at: "2026-10-01T15:00:00Z", order_date: "2026-10-01T15:00:00Z", po_number: "PO-77", contact_name: "Pat Secret", email: "pat@x.example",
          ship_address: "1 Main St", ship_city: "Cincinnati", ship_state: "OH", ship_zip: "45202", items: [{ sku: "PR511-LAR", name: "Cloud Plus", qty: 2, unitPrice: 1300 }], subtotal: 2600, freight_total: 0, sh_total: 78, grand_total: 2678 }],
        golden_orders: [g({ so_number: "SO1001", customer_no: "100001", order_date: "2026-10-02", so_status: "Ship", customer_po: "PO-77", ext_total: 2600, carrier: "UPS", tracking_number: "1Z999", ship_date: "2026-10-08", ship_city: "Cincinnati", ship_state: "OH" })],
        golden_order_items: [{ id: 1, so_number: "SO1001", item_no: "PR511-LAR-SKN-SUM", base_sku: "PR511-LAR", qty: 2, list_price: 1300, ext_price: 2600 }],
        order_links: [{ id: 1, portal_order_id: 501, so_number: "SO1001", relationship: "primary", status: "active", match_method: "po", confidence: 1, evidence: {} }],
      }, rpc: { integration_nonce_claim: () => true, integration_audit_log: () => null } });
      world(ON);
      const hcpsFetch = global.fetch;
      global.fetch = async (u, init) => {
        if (String(u).startsWith("https://golden.test/")) {
          const url = new URL(String(u));
          const ev = { httpMethod: init.method, rawUrl: String(u), path: url.pathname, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), queryStringParameters: Object.fromEntries(url.searchParams), body: init.body || "", isBase64Encoded: false };
          const saved = global.fetch; global.fetch = (x, y) => goldenSb(String(x).replace("https://sb.test", "http://sb.test"), y);
          process.env.SUPABASE_URL = "http://sb.test";
          try { const r = await fresh("v1-history.js").handler(ev); return { ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(r.body), text: async () => r.body }; }
          finally { global.fetch = saved; process.env.SUPABASE_URL = "https://sb.test"; }
        }
        return hcpsFetch(u, init);
      };
      return J(await load("golden-proxy.js").handler(post(body)));
    };
    const h = await call({ action: "history", limit: 10 });
    eq([h.available, h.orders.length, h.orders[0].order_ref, h.orders[0].status, h.orders[0].tracking[0].tracking_number, h.orders[0].totals.total], [true, 1, "P501", "shipped", "1Z999", 2678]);
    ok(!/Pat Secret|pat@x|1 Main St|45202/.test(JSON.stringify(h)), "no contact or street crosses");
    const o = await call({ action: "order", order_ref: "P501" });
    eq([o.available, o.order.so_numbers], [true, ["SO1001"]]);
    eq((await call({ action: "order", order_ref: "P999" })).reason, "not_found");
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
