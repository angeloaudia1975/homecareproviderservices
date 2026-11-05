// Golden ⇄ HCPS Partner 360 — batch B3 (HCPS side): golden-proxy `config` → Golden GET /v1/config (contract 1.3.0).
// Synthetic data only; no network. When ../golden-dealer-portal is checked out with B3, a REAL cross-repo round trip
// runs Golden's real configurator (the portal's own code) behind this repo's signed client.
//   node test/golden-integration-b3.test.js
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
const CONFIG = pv => ({ contract_version: "1.3.0", tenant: "hcps", request_id: "req_k", as_of: "x", etag: "e".repeat(32), engine: "0123456789abcdef", prices_visible: pv, linked: pv, reason: null,
  config: { model: "PR511", rules_type: "configurable", sku: "PR511-LAR", tier: "standard", low_stock_threshold: 50, customer_no: "LEAK-ACCT",
    sizes: [Object.assign({ sku: "PR511-LAR", code: "LAR", label: "Large", msrp: 2992, status: "in", qty: 120 }, pv ? { dealer_price: 1100 } : { dealer_price: 9999 }), { sku: "<script>", code: "x" }],
    tabs: [{ key: "std", label: "Standard fabric", colors: [{ code: "TCP", name: "Calypso", hex: "#4A7FAA", swatch: "https://d3325uqufdmhie.cloudfront.net/a.jpg", status: "in", qty: 120 },
      { code: "TCM", name: "Camel", hex: "red;x", swatch: "javascript:alert(1)", status: "weird" }, { code: "<b>", name: "x" }] },
      Object.assign({ key: "xover", label: "Cross-Over", msrp: 286, colors: [] }, pv ? { upcharge: 142 } : { upcharge: 142 }), { key: "silk", label: "x", colors: [] }],
    tiers: { included: false, included_text: null, options: [Object.assign({ key: "nirvana", msrp: 600, prebuilt_status: "in", prebuilt: 3 }, { upcharge: 200 }), { key: "turbo" }] },
    footrest: { eligible: true, part: "RM621FRE-L", upcharge: 78, msrp: "156" },
    quote: Object.assign({ ok: true, sku: "PR511-LAR", fabric: "xover", color: "JBO", color_name: "JZ Bourbon", tier: "nirvana", footrest: true, lead_note: "⏱ Custom build",
      in_stock: false, custom: true, item_no: "PR511-LAR", item_no_resolved: false, upgrades: ["Nirvana +$200"], details: "Cross-Over: JZ Bourbon (+$142)", internal: "LEAK2" },
      { unit_price: 1608, breakdown: "Base: $1,188 + …" }) } });

function world(o) {
  o = o || {}; const golden = [];
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (/goldenonlineordering\.netlify\.app\//.test(u)) { golden.push(u); return o.golden ? o.golden(u) : res(200, CONFIG(o.pv !== false)); }
    if (/auth\/v1\/user/.test(u)) return res(200, { id: "uid-1" });
    if (/dealer_users/.test(u)) return res(200, [{ status: "approved", dealer_id: D_HQ }]);
    if (/app_settings/.test(u)) return res(200, [{ value: { golden_p360_catalog: true, golden_p360_pilot_dealers: [D_HQ] } }]);
    if (/dealers\?id=eq\./.test(u)) return res(200, [{ id: D_HQ, parent_id: null }]);
    return res(200, []);
  };
  return { golden };
}
const post = b => ({ httpMethod: "POST", headers: { authorization: "Bearer jwt" }, body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);

(async () => {
  await t("config: the query sent to Golden is exactly the validated selection", async () => {
    env(); const w = world();
    const r = J(await load("golden-proxy.js").handler(post({ action: "config", sku: "pr511-lar", fabric: "XOVER", color: "jbo", tier: "Nirvana", footrest: true, extra: "x" })));
    eq([r.ok, r.available], [true, true]);
    const q = new URL(w.golden[0]).searchParams;
    eq([new URL(w.golden[0]).pathname, q.get("sku"), q.get("fabric"), q.get("color"), q.get("tier"), q.get("footrest"), q.has("extra")], ["/v1/config", "PR511-LAR", "xover", "JBO", "nirvana", "1", false]);
  });

  await t("config: footrest is asked for only when the dealer ticked it (true), never by default or on a non-boolean", async () => {
    for (const fr of [undefined, false, "true", 1]) {
      env(); const w = world();
      await load("golden-proxy.js").handler(post({ action: "config", sku: "PR511-LAR", fabric: "std", color: "SUM", footrest: fr }));
      eq(new URL(w.golden[0]).searchParams.has("footrest"), false, "footrest " + JSON.stringify(fr));
    }
  });

  await t("config: bad selections refused before Golden is called", async () => {
    for (const b of [{ sku: "GB107B" }, { sku: "PR511-LAR", color: "T;P" }, { sku: "PR511-LAR", fabric: "silk" }, { sku: "PR511-LAR", tier: "turbo" }, { sku: "PR511-LAR'" }]) {
      env(); const w = world();
      const r = await load("golden-proxy.js").handler(post(Object.assign({ action: "config" }, b)));
      eq(r.statusCode, 400, JSON.stringify(b)); eq(w.golden.length, 0);
    }
  });

  await t("config: allow-list — prices only when visible, no unknown field, https swatches only, unknown keys dropped", async () => {
    env(); world();
    let r = J(await load("golden-proxy.js").handler(post({ action: "config", sku: "PR511-LAR", color: "JBO" })));
    const c = r.config;
    eq([c.sizes.length, c.sizes[0].dealer_price, c.sizes[0].qty], [1, 1100, 120]);
    eq(c.tabs.map(x => x.key), ["std", "xover"]); eq(c.tabs[0].colors.map(x => x.code), ["TCP", "TCM"]);
    eq([c.tabs[0].colors[1].hex, c.tabs[0].colors[1].swatch, c.tabs[0].colors[1].status], [null, null, "out"]);
    eq(c.tiers.options.map(x => x.key), ["nirvana"]);
    eq([c.quote.unit_price, c.quote.item_no, c.footrest.upcharge], [1608, "PR511-LAR", 78]);
    eq([c.tabs[0].msrp, c.tabs[1].msrp, c.footrest.msrp], [null, 286, null], "1.6.1 retail upgrade prices pass as numbers only (a non-number never crosses)");
    ok(!/LEAK/.test(JSON.stringify(r)), "fields outside the contract never cross");
    env(); world({ pv: false });
    r = J(await load("golden-proxy.js").handler(post({ action: "config", sku: "PR511-LAR", color: "JBO" })));
    const s = JSON.stringify(r.config);
    ok(!/dealer_price|unit_price|breakdown|upcharge|9999|\$/.test(s), "no price of any kind when Golden hides prices, even in Golden's text: " + s.slice(0, 120));
    ok(!/"qty"|"prebuilt"/.test(s), "no stock quantity without a verified link");
    eq([r.config.quote.details, r.config.quote.upgrades], ["Cross-Over: JZ Bourbon", ["Nirvana"]]);
    eq(r.config.tabs[1].msrp, 286, "retail upgrade prices are not dealer prices: they show even when Golden hides dealer prices");
  });

  await t("config: Golden's 400/404/outage become a calm 'not offered / not available', never a guess", async () => {
    const res = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body), json: async () => body });
    for (const [st, code, reason] of [[400, "bad_request", "not_offered"], [404, "not_found", "not_found"], [503, "inventory_unavailable", "golden_unavailable"]]) {
      env(); world({ golden: () => res(st, { error: { code } }) });
      const r = J(await load("golden-proxy.js").handler(post({ action: "config", sku: "PR511-LAR" })));
      eq([r.ok, r.available, r.reason], [true, false, reason], String(st));
    }
  });

  // ── Real cross-repo round trip: Golden's real /v1/config (the portal's own configurator code) ──
  const gFN = path.join(GOLDEN, "repo", "functions");
  if (!fs.existsSync(path.join(gFN, "v1-config.js"))) { skipped++; console.log("skip  cross-repo configurator round trip (Golden B3 not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: Golden's real configurator behind this repo's client — dealer price, tier guard, privacy", async () => {
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
        dealer_integration_branch_map: [], dealers: [{ id: "dealer-a", active: true }],
        inventory: [{ sku: "PR511-LAR", size: "LAR", fabcode: "SKN", color_code: "SUM", avail: 3, pool: null }],
      }, rpc: {
        integration_nonce_claim: a => { const f1 = !nonces.has(a.p_nonce); nonces.add(a.p_nonce); return f1; },
        integration_audit_log: () => null,
        get_dealer_portal_data: () => ({ dealer: { customer_no: "LEAK" }, pricing: [{ sku: "PR511-LAR", dealer_cost: 1101 }] }),
      } });
      const handler = fresh("v1-config.js").handler;
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
      return J(await load("golden-proxy.js").handler(post(Object.assign({ action: "config" }, body))));
    };
    const nir = await run("dealer", { sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "nirvana" });
    eq([nir.available, nir.prices_visible, nir.config.quote.unit_price, nir.config.quote.item_no, nir.config.quote.in_stock], [true, true, 1301, "PR511-LAR-SKN-SUM", true]);
    const std = await run("dealer", { sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "standard" });
    eq([std.config.quote.unit_price, std.config.quote.item_no], [1101, "PR511-LAR"], "a Standard build never takes the Nirvana unit's item #");
    const hidden = await run("none", { sku: "PR511-LAR", fabric: "xover", color: "JBO", tier: "nirvana", footrest: true });
    ok(!/unit_price|dealer_price|upcharge|breakdown|\+\$/.test(JSON.stringify(hidden.config)), "no price anywhere when Golden hides prices");
    eq(hidden.config.quote.custom, true);
    const off = await run("dealer", { sku: "PR511-LAR", fabric: "std", color: "UCB" });
    eq([off.available, off.reason], [false, "not_offered"]);
    ok(!JSON.stringify([nir, std, hidden]).includes("LEAK"));
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
