// Golden ⇄ HCPS Partner 360 — batch B4b (HCPS side): golden-proxy `ship_to` → Golden GET /v1/ship-to and
// `validate_order` → Golden POST /v1/orders mode "validate" (contract 1.4.0). Synthetic data only. When
// ../golden-dealer-portal is checked out with B4b, a REAL cross-repo round trip runs Golden's real ship-to + validate code
// (re-pricing, idempotency, exact email previews) behind this repo's signed client.
//   node test/golden-integration-b4b.test.js
"use strict";
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");
const GOLDEN = process.env.GOLDEN_REPO || path.join(ROOT, "..", "golden-dealer-portal");
let pass = 0, fail = 0, skipped = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, "\n   ", e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e); } };
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((m || "") + " got " + A + " want " + B); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const SECRET = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/contracts/golden-commerce-v1.signing-vectors.json"), "utf8")).secret;
const D_HQ = "11111111-2222-4333-8444-555555555555";
const LOC = "cccccccc-0000-4000-8000-000000000001";
function load(mod) { Object.keys(require.cache).forEach(k => { if (k.startsWith(FN)) delete require.cache[k]; }); return require(path.join(FN, mod)); }
function env(extra) {
  process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_ROLE = "svc";
  process.env.GOLDEN_P360_KEY_ID = "hcps-p360-1"; process.env.GOLDEN_P360_SECRET = SECRET;
  delete process.env.GOLDEN_API_BASE; delete process.env.GOLDEN_P360_TEST_KEY_ID; delete process.env.GOLDEN_P360_TEST_SECRET; delete process.env.GOLDEN_TEST_API_BASE;
  Object.assign(process.env, extra || {});
}
const HASH = "a".repeat(64);
const QUOTE = { lines: [{ line: 0, sku: "PR511-LAR", qty: 2, fabric: "std", color: "SUM", color_name: "Summit", tier: "nirvana", footrest: false, unit_price: 1300, line_total: 2600,
  details: "Std", upgrades: [], breakdown: "b", lead_note: null, in_stock: true, custom: false, item_no: "PR511-LAR-SKN-SUM", item_no_resolved: true }],
  totals: { subtotal: 2600, sh_total: 78, grand_total: 2678, sh_rate: 0.03, sh_waived: false, split: false, shipments: [{ group: "all", subtotal: 2600, sh: 78 }] },
  freight: { included: false, note: "n" }, quote_hash: HASH };
const VALID = () => ({ contract_version: "1.4.0", request_id: "req_v", mode: "validate", valid: true, ordering_enabled: false, idempotent_replay: false, engine: "0123456789abcdef",
  order: { internal_note: "LEAK", po_number: "PO-1", po_auto: false, ship_to: { id: LOC, kind: "ship_location", label: "Store", address: "1 Main St", city: "Cincinnati", state: "OH", zip: "45202", secret: "LEAK" },
    contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" }, attention: "", notes: "", delivery_type: "business", split_order: false, lines: [{ sku: "PR511-LAR", reference_names: ["Mrs. Smith"], cost: "LEAK" }] },
  quote: QUOTE, customer_no: "LEAK",
  emails: { golden_order: { recipient: "golden_order_desk", recipient_configured: true, subject: "New Order — X (#1)", html: "<html>golden</html>", to: "LEAK@golden" },
    dealer_confirmation: { to: "pat@d.example", subject: "Order received — PO PO-1", html: "<p>c</p>", text: "c" } } });
function world(o) {
  o = o || {}; const golden = [];
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (/goldenonlineordering\.netlify\.app\//.test(u)) { golden.push({ u, init }); return o.golden ? o.golden(u, init) : res(200, /ship-to/.test(u) ? { scope: "account", ship_to: [{ id: "primary", kind: "primary", label: "Main", address: "10 Rd", city: "Columbus", state: "OH", zip: "43215" }, { id: "x'><", label: "bad" }] } : VALID()); }
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
const ORDER = over => Object.assign({ action: "validate_order", idempotency_key: crypto.randomUUID(), quote_hash: HASH,
  lines: [{ sku: "pr511-lar", fabric: "std", color: "sum", tier: "nirvana", qty: 2, reference_names: [" Mrs. Smith ", ""], unit_price: 1 }],
  ship_to: { id: LOC }, po_number: "PO-1", contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" }, attention: "", notes: "Back dock" }, over || {});
const ON = { flags: { golden_p360_checkout: true } };

(async () => {
  await t("ship_to: GET /v1/ship-to; only well-formed ids pass", async () => {
    env(); const w = world();
    const r = J(await load("golden-proxy.js").handler(post({ action: "ship_to" })));
    eq([new URL(w.golden[0].u).pathname, w.golden[0].init.method], ["/v1/ship-to", "GET"]);
    eq(r.ship_to.map(x => x.id), ["primary"]); eq(r.scope, "account");
  });

  await t("validate_order: Golden gets POST /v1/orders, mode validate, the Idempotency-Key header, ONLY the validated fields", async () => {
    env(); const w = world(ON); const o = ORDER();
    const r = J(await load("golden-proxy.js").handler(post(Object.assign(o, { grand_total: 1, dealer_id: "x", emails: 1 }))));
    eq([r.ok, r.available, r.valid, r.ordering_enabled], [true, true, true, false]);
    const g = w.golden[0];
    eq([new URL(g.u).pathname, g.init.method, g.init.headers["Idempotency-Key"]], ["/v1/orders", "POST", o.idempotency_key]);
    eq(JSON.parse(g.init.body), { mode: "validate", quote_hash: HASH, lines: [{ sku: "PR511-LAR", fabric: "std", color: "SUM", qty: 2, tier: "nirvana", reference_names: ["Mrs. Smith"] }],
      ship_to: { id: LOC }, contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" }, po_number: "PO-1", notes: "Back dock" });
  });

  await t("validate_order: answer allow-listed — Golden's totals + exact emails pass, nothing else (no desk address, no account)", async () => {
    env(); world(ON);
    const r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.quote.totals.grand_total, r.order.ship_to.address, r.order.lines[0].reference_names, r.emails.golden_order.html, r.emails.dealer_confirmation.to],
      [2678, "1 Main St", ["Mrs. Smith"], "<html>golden</html>", "pat@d.example"]);
    ok(!/LEAK/.test(JSON.stringify(r)), "nothing outside the contract crosses");
  });

  await t("validate_order: bad requests refused before Golden is called", async () => {
    const bad = [{ idempotency_key: "nope" }, { idempotency_key: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa" }, { quote_hash: "x" }, { ship_to: undefined }, { ship_to: { city: "X" } },
      { notes: "<b>x</b>" }, { attention: "a\u0007" }, { po_number: "P\"O" }, { contact: { name: "", phone: "1" } }, { contact: { name: "Pat", phone: "call me" } },
      { contact: { name: "Pat", phone: "937-555-0100", email: "bad" } }, { lines: [{ sku: "PR511-LAR", color: "SUM", qty: 1, reference_names: ["a", "b"] }] },
      { lines: [{ sku: "PR511-LAR", color: "SUM", qty: 1, reference_names: ["<x>"] }] }];
    for (const over of bad) {
      env(); const w = world(ON); const o = ORDER(over); if ("ship_to" in over && over.ship_to === undefined) delete o.ship_to;
      const r = await load("golden-proxy.js").handler(post(o));
      eq(r.statusCode, 400, JSON.stringify(over)); eq(w.golden.length, 0);
    }
  });

  await t("validate_order: production path needs golden_p360_checkout exactly true (OFF) — Golden never called", async () => {
    env(); const w = world();
    eq(J(await load("golden-proxy.js").handler(post(ORDER()))).reason, "checkout_switched_off"); eq(w.golden.length, 0);
  });

  await t("validate_order: prices_changed → the new Golden quote; refusals → calm reasons; malformed answer → no validation", async () => {
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    env(); world(Object.assign({ golden: () => res(409, { error: { code: "prices_changed" }, quote: Object.assign({}, QUOTE, { quote_hash: "b".repeat(64) }), idempotent_replay: true }) }, ON));
    let r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.valid, r.reason, r.quote.quote_hash, r.idempotent_replay], [false, "prices_changed", "b".repeat(64), true]);
    for (const [st, code, msg, reason, field] of [[400, "bad_request", "ship_to", "invalid", "ship_to"], [400, "bad_request", "po_required", "invalid", "po_required"],
      [400, "bad_request", "weird<x>", "invalid", "order"], [422, "idempotency_conflict", null, "idempotency_conflict"], [409, "idempotency_in_progress", null, "idempotency_in_progress"],
      [403, "prices_not_visible", null, "prices_not_visible"], [403, "ordering_disabled", null, "ordering_disabled"]]) {
      env(); world(Object.assign({ golden: () => res(st, { error: { code, message: msg } }) }, ON));
      r = J(await load("golden-proxy.js").handler(post(ORDER())));
      eq([r.valid, r.reason, r.field], [false, reason, field], code + " " + msg);
    }
    env(); world(Object.assign({ golden: () => res(200, Object.assign(VALID(), { ordering_enabled: true })) }, ON));
    r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.available, r.reason, r.emails], [false, "golden_unavailable", undefined], "a validation that says ordering is on is not shown");
  });

  await t("validate_order: Golden's answer must be for THIS quote and these lines — otherwise no validation is shown", async () => {
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    for (const bad of [g => { g.quote = Object.assign({}, g.quote, { quote_hash: "c".repeat(64) }); }, g => { g.order.lines.push({ sku: "PR511-LAR" }); }, g => { g.order.lines[0] = null; }]) {
      env(); world(Object.assign({ golden: () => { const g = VALID(); bad(g); return res(200, g); } }, ON));
      const r = J(await load("golden-proxy.js").handler(post(ORDER())));
      eq([r.available, r.reason, r.emails], [false, "golden_unavailable", undefined]);
    }
  });

  await t("validate_order: request_id only in Golden's known shape; invisible / bidi characters refused before Golden", async () => {
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    env(); world(Object.assign({ golden: () => res(200, Object.assign(VALID(), { request_id: "<img src=x>" })) }, ON));
    eq(J(await load("golden-proxy.js").handler(post(ORDER()))).request_id, null);
    env(); world(Object.assign({ golden: () => res(200, VALID()) }, ON));
    eq(J(await load("golden-proxy.js").handler(post(ORDER()))).request_id, "req_v");
    for (const over of [{ notes: "a\u202Eb" }, { po_number: "PO\u200B1" }, { contact: { name: "Pa\u2028t", phone: "937-555-0100" } }, { attention: "a\u2066b" }, { notes: "x\u00ADy" }]) {
      env(); const w = world(ON);
      eq((await load("golden-proxy.js").handler(post(ORDER(over)))).statusCode, 400, JSON.stringify(over)); eq(w.golden.length, 0);
    }
  });

  await t("validate_order: CRLF notes forwarded as line breaks; Golden's 503 internal = a calm retry (same attempt)", async () => {
    env(); const w = world(ON);
    await load("golden-proxy.js").handler(post(ORDER({ notes: "one\r\ntwo" })));
    eq(JSON.parse(w.golden[0].init.body).notes, "one\ntwo");
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    env(); world(Object.assign({ golden: () => res(503, { error: { code: "internal", message: "internal", retryable: true } }) }, ON));
    const r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.valid, r.reason, r.retry], [false, "temporarily_unavailable", true]);
  });

  await t("validate_order: a staff view-as token never reaches the production ordering path, even with checkout on", async () => {
    env(); const w = world(ON);
    const ev = { httpMethod: "POST", headers: { "x-hcps-preview": "a".repeat(48) }, body: JSON.stringify(ORDER()) };
    const g0 = global.fetch; global.fetch = async (u, i) => /dealer_preview_tokens/.test(String(u)) ? { ok: true, status: 200, json: async () => [{ dealer_id: D_HQ, expires_at: null }], text: async () => "" } : g0(u, i);
    const r = await load("golden-proxy.js").handler(ev);
    eq([r.statusCode, J(r).error], [403, "preview_not_allowed"]); eq(w.golden.length, 0);
  });

  // ── Real cross-repo round trip ──
  const gFN = path.join(GOLDEN, "repo", "functions");
  if (!fs.existsSync(path.join(gFN, "v1-orders.js"))) { skipped++; console.log("skip  cross-repo validate round trip (Golden B4b not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: Golden's real ship-to + validate behind this repo's client — re-pricing, idempotency, exact emails, privacy", async () => {
    const { createMock } = require(path.join(GOLDEN, "repo", "tests", "support", "postgrest-mock.js"));
    const fresh = m => { Object.keys(require.cache).forEach(k => { if (k.startsWith(gFN)) delete require.cache[k]; }); return require(path.join(gFN, m)); };
    const gS = fresh("lib/hcps-s2s.js");
    const rows = new Map();
    const idem = {
      integration_order_claim: ({ p }) => { const k = p.idempotency_key, r = rows.get(k); if (!r) { const tok = crypto.randomUUID(); rows.set(k, { h: p.request_hash, s: "pending", tok }); return { state: "new", claim_token: tok }; }
        if (r.h !== p.request_hash) return { state: "conflict" }; if (r.s === "done") return { state: "replay", status: r.st, response: r.resp }; return { state: "in_progress" }; },
      integration_order_complete: ({ p }) => { const r = rows.get(p.idempotency_key); if (!r || r.tok !== p.claim_token) throw new Error("no pending claim"); r.s = "done"; r.st = p.status; r.resp = p.response; return true; },
      integration_order_release: ({ p }) => { rows.delete(p.idempotency_key); return true; },
    };
    let cost = 1100;
    const call = async (body) => {
      env({ GOLDEN_API_BASE: "https://golden.test" });
      process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.GOLDEN_V1_API = "true"; process.env.HCPS_P360_KEYS = JSON.stringify({ "hcps-p360-1": SECRET });
      process.env.ORDER_EMAIL_TO = "desk@golden.example"; process.env.ORDER_EMAIL_FROM = "p@golden.example";
      const nonces = new Set(); const sent = [];
      const goldenSb = createMock({ tables: {
        integration_clients: [{ kid: "hcps-p360-1", client_id: "hcps-partner360", tenant_id: "hcps", scopes: ["golden:read"], active: true, secret_fingerprint: gS.fingerprint(SECRET) }],
        dealer_integration_map: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", tenant_id: "hcps", client_id: "hcps-partner360", hcps_dealer_id: D_HQ, golden_dealer_id: "dealer-a", status: "verified", price_visibility: "dealer" }],
        dealer_integration_branch_map: [], dealers: [{ id: "dealer-a", active: true, customer_no: "100001" }], dealer_branches: [],
        dealer_ship_locations: [{ id: LOC, dealer_id: "dealer-a", label: "Store", ship_address: "1 Main St", ship_city: "Cincinnati", ship_state: "OH", ship_zip: "45202", created_at: "2026-01-01" }],
        dealer_locations: [], dealer_special_terms: [], orders: [],
        inventory: [{ sku: "PR511-LAR", size: "LAR", fabcode: "SKN", color_code: "SUM", avail: 3, pool: null }],
      }, rpc: Object.assign({
        integration_nonce_claim: a => { const f1 = !nonces.has(a.p_nonce); nonces.add(a.p_nonce); return f1; },
        integration_audit_log: () => null,
        get_dealer_portal_data: () => ({ dealer: { dealer_id: "dealer-a", name: "Dealer A", customer_no: "100001", terms: "Net 30" }, pricing: [{ sku: "PR511-LAR", dealer_cost: cost }] }),
      }, idem) });
      const handlers = { "/v1/quote": fresh("v1-quote.js").handler, "/v1/ship-to": fresh("v1-ship-to.js").handler, "/v1/orders": fresh("v1-orders.js").handler };
      world(ON);
      const hcpsFetch = global.fetch;
      global.fetch = async (u, init) => {
        if (/api\.resend\.com/.test(String(u))) { sent.push(u); throw new Error("no email may be sent"); }
        if (String(u).startsWith("https://golden.test/")) {
          const url = new URL(String(u));
          const ev = { httpMethod: init.method, rawUrl: String(u), path: url.pathname, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), queryStringParameters: Object.fromEntries(url.searchParams), body: init.body || "", isBase64Encoded: false };
          const saved = global.fetch; global.fetch = (x, y) => goldenSb(String(x).replace("https://sb.test", "http://sb.test"), y);
          process.env.SUPABASE_URL = "http://sb.test";
          try { const r = await handlers[url.pathname](ev); return { ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(r.body), text: async () => r.body }; }
          finally { global.fetch = saved; process.env.SUPABASE_URL = "https://sb.test"; }
        }
        return hcpsFetch(u, init);
      };
      const out = J(await load("golden-proxy.js").handler(post(body)));
      eq(sent.length, 0, "no email sent");
      return out;
    };
    const ship = await call({ action: "ship_to" });
    eq(ship.ship_to.map(x => x.id), [LOC]);
    const LN = { sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "nirvana", qty: 2 };
    const q = await call({ action: "quote", lines: [LN], ship_to: { id: LOC } });
    eq([q.ship_to_id, q.quote.lines[0].unit_price], [LOC, 1300]);
    const key = crypto.randomUUID();
    const body = { action: "validate_order", idempotency_key: key, quote_hash: q.quote.quote_hash, lines: [Object.assign({ reference_names: ["Mrs. Smith"] }, LN)], ship_to: { id: LOC },
      po_number: "PO-55", contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" } };
    const v = await call(body);
    eq([v.valid, v.ordering_enabled, v.idempotent_replay, v.order.po_number, v.quote.quote_hash], [true, false, false, "PO-55", q.quote.quote_hash]);
    ok(v.emails.golden_order.html.includes("Unit 1: Mrs. Smith") || v.emails.golden_order.html.includes("Reference: Mrs. Smith"), "the exact Golden email carries the reference name");
    ok(v.emails.golden_order.html.includes("1 Main St") && v.emails.golden_order.subject === "New Order — Dealer A (#100001)");
    ok(!JSON.stringify(v).includes("desk@golden.example"), "Golden's order desk address never reaches HCPS");
    const again = await call(body);
    eq([again.valid, again.idempotent_replay], [true, true], "same attempt replays");
    const conflict = await call(Object.assign({}, body, { po_number: "PO-56" }));
    eq(conflict.reason, "idempotency_conflict");
    cost = 1150;   // Golden's price moves after the review
    const moved = await call(Object.assign({}, body, { idempotency_key: crypto.randomUUID() }));
    eq([moved.valid, moved.reason, moved.quote.lines[0].unit_price], [false, "prices_changed", 1350]);
    const typed = await call(Object.assign({}, body, { idempotency_key: crypto.randomUUID(), ship_to: { id: "dddddddd-0000-4000-8000-000000000009" } }));
    eq([typed.valid, typed.field], [false, "ship_to"]);
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
