// Golden ⇄ HCPS Partner 360 — batch B4a (HCPS side): golden-proxy `quote` → Golden POST /v1/quote (contract 1.4.0).
// Synthetic data only; no network. When ../golden-dealer-portal is checked out with B4a, a REAL cross-repo round trip
// runs Golden's real quote (the portal's configurator + S&H rule) behind this repo's signed client.
//   node test/golden-integration-b4.test.js
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
const HASH = "a".repeat(64);
const QUOTE = () => ({ contract_version: "1.4.0", tenant: "hcps", request_id: "req_q", as_of: "2026-11-03T00:00:00Z", engine: "0123456789abcdef", sh_terms_checked: true, ordering_enabled: false,
  quote: { lines: [{ line: 0, sku: "PR511-LAR", qty: 2, fabric: "xover", color: "JBO", color_name: "JZ Bourbon", tier: "nirvana", footrest: true, unit_price: 1608, line_total: 3216,
      details: "Cross-Over: JZ Bourbon", upgrades: ["Nirvana"], breakdown: "Base …", lead_note: "Custom build", in_stock: false, custom: true, item_no: "PR511-LAR", item_no_resolved: false, cost_basis: "LEAK" }],
    totals: { subtotal: 3216, sh_total: 160.8, grand_total: 3376.8, sh_rate: 0.05, sh_waived: false, split: false, shipments: [{ group: "all", subtotal: 3216, sh: 160.8 }, { group: "weird", subtotal: 1, sh: 1 }], margin: "LEAK" },
    freight: { included: false, note: "Freight and delivery add-ons are confirmed at checkout." }, quote_hash: HASH }, customer_no: "LEAK" });

function world(o) {
  o = o || {}; const golden = [];
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (/goldenonlineordering\.netlify\.app\//.test(u)) { golden.push({ u, init }); return o.golden ? o.golden(u, init) : res(200, QUOTE()); }
    if (/auth\/v1\/user/.test(u)) return res(200, { id: "uid-1" });
    if (/dealer_users/.test(u)) return res(200, [{ status: "approved", dealer_id: D_HQ }]);
    if (/app_settings/.test(u)) return res(200, [{ value: { golden_p360_catalog: o.off ? false : true, golden_p360_pilot_dealers: [D_HQ] } }]);
    if (/dealers\?id=eq\./.test(u)) return res(200, [{ id: D_HQ, parent_id: null }]);
    if ((init.method || "GET") !== "GET") throw new Error("HCPS must store nothing: " + (init.method) + " " + u);
    return res(200, []);
  };
  return { golden };
}
const post = b => ({ httpMethod: "POST", headers: { authorization: "Bearer jwt" }, body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);
const LINE = { sku: "pr511-lar", fabric: "XOVER", color: "jbo", tier: "Nirvana", footrest: true, qty: 2 };

(async () => {
  await t("quote: Golden gets a POST with only the validated selection — never a price, never an unknown field", async () => {
    env(); const w = world();
    const r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [Object.assign({ unit_price: 1, price: 1, dealer_price: 1, extra: "x" }, LINE)], split_order: true, ship_to: { id: "primary", city: "Nashville", state: "TN" }, total: 5 })));
    eq([r.ok, r.available], [true, true]);
    eq(w.golden.length, 1); const g = w.golden[0];
    eq([new URL(g.u).pathname, g.init.method, new URL(g.u).search], ["/v1/quote", "POST", ""]);
    eq(JSON.parse(g.init.body), { lines: [{ sku: "PR511-LAR", fabric: "xover", color: "JBO", qty: 2, tier: "nirvana", footrest: true }], split_order: true, ship_to: { id: "primary" } });
  });

  await t("quote: bad carts refused before Golden is called", async () => {
    const bad = [[], [Object.assign({}, LINE, { qty: 0 })], [Object.assign({}, LINE, { qty: 21 })], [Object.assign({}, LINE, { qty: 1.5 })], [Object.assign({}, LINE, { color: "" })],
      [Object.assign({}, LINE, { sku: "GB107B" })], [Object.assign({}, LINE, { fabric: "silk" })], [Object.assign({}, LINE, { tier: "turbo" })], [Object.assign({}, LINE, { footrest: "yes" })],
      Array.from({ length: 31 }, () => LINE), "x", [null]];
    for (const st of [{ city: "Nashville", state: "TN" }, { id: "1 Main St" }, "primary"]) {
      env(); const w = world();
      const r = await load("golden-proxy.js").handler(post({ action: "quote", lines: [LINE], ship_to: st }));
      eq(r.statusCode, 400, JSON.stringify(st)); eq(w.golden.length, 0);
    }
    for (const lines of bad) {
      env(); const w = world();
      const r = await load("golden-proxy.js").handler(post({ action: "quote", lines }));
      eq(r.statusCode, 400, JSON.stringify(lines).slice(0, 60)); eq(w.golden.length, 0);
    }
  });

  await t("quote: allow-list — Golden's amounts pass through unchanged, nothing outside the contract crosses", async () => {
    env(); world();
    const r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [LINE] })));
    eq([r.quote.lines[0].unit_price, r.quote.lines[0].line_total, r.quote.totals.grand_total, r.quote.totals.sh_total, r.quote.quote_hash], [1608, 3216, 3376.8, 160.8, HASH]);
    eq(r.quote.totals.shipments, [{ group: "all", subtotal: 3216, sh: 160.8 }]);
    eq([r.ordering_enabled, r.sh_terms_checked, r.quote.freight.included], [false, true, false]);
    ok(!/LEAK|margin|cost_basis|customer_no/.test(JSON.stringify(r)), "fields outside the contract never cross");
  });

  await t("quote: a line or total HCPS can't show faithfully = no quote at all (never partial), and ordering_enabled must be false", async () => {
    const mk = f => { const q = QUOTE(); f(q); return q; };
    for (const [name, body] of [["bad price", mk(q => { q.quote.lines[0].unit_price = "1608"; })], ["bad total", mk(q => { q.quote.totals.grand_total = null; })],
      ["bad hash", mk(q => { q.quote.quote_hash = "x"; })], ["ordering on", mk(q => { q.ordering_enabled = true; })], ["no quote", mk(q => { delete q.quote; })]]) {
      env(); world({ golden: () => ({ ok: true, status: 200, json: async () => body, text: async () => "" }) });
      const r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [LINE] })));
      eq([r.available, r.reason, r.quote], [false, "golden_unavailable", undefined], name);
    }
  });

  await t("quote: Golden's refusals become calm reasons with the line named — never a guessed price", async () => {
    const res = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body), json: async () => body });
    for (const [st, code, msg, reason, line] of [[403, "prices_not_visible", null, "prices_not_visible", null], [400, "bad_request", "color@1", "not_offered", 1],
      [404, "not_found", "not_configurable@0", "not_found", 0], [503, "pricing_unavailable", "line@2", "pricing_unavailable", 2], [503, "inventory_unavailable", null, "golden_unavailable", undefined],
      [401, "key_mismatch", null, "golden_unavailable", undefined]]) {
      env(); world({ golden: () => res(st, { error: { code, message: msg } }) });
      const r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [LINE, LINE, LINE] })));
      eq([r.ok, r.available, r.reason, r.line, r.quote], [true, false, reason, line, undefined], code);
    }
  });

  await t("quote: switch off / not in pilot / signed out → Golden never called", async () => {
    env(); let w = world({ off: true });
    eq(J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [LINE] }))).reason, "switched_off"); eq(w.golden.length, 0);
    env(); w = world();
    const r = await load("golden-proxy.js").handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "quote", lines: [LINE] }) });
    eq(r.statusCode, 401); eq(w.golden.length, 0);
  });

  await t("quote: HCPS stores nothing — golden-proxy has no write to Supabase", async () => {
    const src = fs.readFileSync(path.join(FN, "golden-proxy.js"), "utf8");
    ok(!/method:\s*["'](POST|PATCH|PUT|DELETE)["'][^\n]*rest\/v1|Prefer|upsert/i.test(src), "no Supabase write");
  });

  // ── Real cross-repo round trip: Golden's real /v1/quote (the portal's configurator + S&H rule) ──
  const gFN = path.join(GOLDEN, "repo", "functions");
  if (!fs.existsSync(path.join(gFN, "v1-quote.js"))) { skipped++; console.log("skip  cross-repo quote round trip (Golden B4a not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: Golden's real quote behind this repo's client — prices, S&H, hash, privacy", async () => {
    const { createMock } = require(path.join(GOLDEN, "repo", "tests", "support", "postgrest-mock.js"));
    const fresh = m => { Object.keys(require.cache).forEach(k => { if (k.startsWith(gFN)) delete require.cache[k]; }); return require(path.join(gFN, m)); };
    const gS = fresh("lib/hcps-s2s.js");
    const run = async (visibility, body) => {
      env({ GOLDEN_API_BASE: "https://golden.test" });
      process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.GOLDEN_V1_API = "true"; process.env.HCPS_P360_KEYS = JSON.stringify({ "hcps-p360-1": SECRET });
      const nonces = new Set();
      const goldenSb = createMock({ tables: {
        integration_clients: [{ kid: "hcps-p360-1", client_id: "hcps-partner360", tenant_id: "hcps", scopes: ["golden:read"], active: true, secret_fingerprint: gS.fingerprint(SECRET) }],
        dealer_integration_map: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", tenant_id: "hcps", client_id: "hcps-partner360", hcps_dealer_id: D_HQ, golden_dealer_id: "dealer-a", status: "verified", price_visibility: visibility, golden_ordering_enabled: false, history_enabled: false }],
        dealer_integration_branch_map: [], dealers: [{ id: "dealer-a", active: true }], dealer_special_terms: [],
        inventory: [{ sku: "PR511-LAR", size: "LAR", fabcode: "SKN", color_code: "SUM", avail: 3, pool: null }],
      }, rpc: {
        integration_nonce_claim: a => { const f1 = !nonces.has(a.p_nonce); nonces.add(a.p_nonce); return f1; },
        integration_audit_log: () => null,
        get_dealer_portal_data: () => ({ dealer: { customer_no: "LEAK" }, pricing: [{ sku: "PR511-LAR", dealer_cost: 1101 }] }),
      } });
      const handler = fresh("v1-quote.js").handler;
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
      return J(await load("golden-proxy.js").handler(post(Object.assign({ action: "quote" }, body))));
    };
    const q = await run("dealer", { lines: [{ sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "nirvana", qty: 2, unit_price: 1 }] });
    eq([q.available, q.ordering_enabled, q.quote.lines[0].unit_price, q.quote.lines[0].line_total, q.quote.lines[0].in_stock], [true, false, 1301, 2602, true]);
    ok(q.quote.totals.subtotal === 2602 && q.quote.totals.grand_total === q.quote.totals.subtotal + q.quote.totals.sh_total, "grand total = subtotal + S&H, all Golden's");
    ok(/^[0-9a-f]{64}$/.test(q.quote.quote_hash));
    const again = await run("dealer", { lines: [{ sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "nirvana", qty: 2 }] });
    eq(again.quote.quote_hash, q.quote.quote_hash, "same cart, same prices → same hash");
    const hidden = await run("none", { lines: [{ sku: "PR511-LAR", fabric: "std", color: "SUM", qty: 1 }] });
    eq([hidden.available, hidden.reason, hidden.quote], [false, "prices_not_visible", undefined]);
    const off = await run("dealer", { lines: [{ sku: "PR511-LAR", fabric: "std", color: "SUM", qty: 1 }, { sku: "PR511-LAR", fabric: "std", color: "UCB", qty: 1 }] });
    eq([off.available, off.reason, off.line], [false, "not_offered", 1]);
    ok(!JSON.stringify([q, hidden, off]).includes("LEAK"));
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
