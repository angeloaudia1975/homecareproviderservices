// Golden ⇄ HCPS Partner 360 — batch B6 (HCPS side): golden-proxy `place_order` → Golden POST /v1/orders mode "submit"
// (contract 1.6.0). Synthetic data only. Golden places the order and is the only order of record; HCPS stores nothing.
// When ../golden-dealer-portal is checked out with B6, a REAL cross-repo round trip runs Golden's real validate + submit
// code (atomic placement mirrored from its SQL, test-mode emails, history) behind this repo's signed client.
//   node test/golden-integration-b6.test.js
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
const TEST_SECRET = crypto.createHash("sha256").update("b6-test-key").digest("base64");
const D_HQ = "11111111-2222-4333-8444-555555555555", D_BR = "22222222-2222-4333-8444-555555555555";
const LOC = "cccccccc-0000-4000-8000-000000000001";
const PREVIEW_ORIGIN = "https://deploy-preview-31--hcpsonlineordering.netlify.app";
function load(mod) { Object.keys(require.cache).forEach(k => { if (k.startsWith(FN)) delete require.cache[k]; }); return require(path.join(FN, mod)); }
function env(extra) {
  process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_ROLE = "svc";
  process.env.GOLDEN_P360_KEY_ID = "hcps-p360-1"; process.env.GOLDEN_P360_SECRET = SECRET;
  process.env.GOLDEN_P360_TEST_KEY_ID = "hcps-p360-preview-1"; process.env.GOLDEN_P360_TEST_SECRET = TEST_SECRET;
  process.env.GOLDEN_TEST_API_BASE = "https://deploy-preview-284--goldenonlineordering.netlify.app";
  delete process.env.GOLDEN_API_BASE;
  Object.assign(process.env, extra || {});
}
const HASH = "a".repeat(64);
const QUOTE = { lines: [{ line: 0, sku: "PR511-LAR", qty: 2, fabric: "std", color: "SUM", color_name: "Summit", tier: "nirvana", footrest: false, unit_price: 1300, line_total: 2600,
  details: "Std", upgrades: [], breakdown: "b", lead_note: null, in_stock: true, custom: false, item_no: "PR511-LAR-SKN-SUM", item_no_resolved: true }],
  totals: { subtotal: 2600, freight_total: 70, sh_total: 78, grand_total: 2748, sh_rate: 0.03, sh_waived: false, split: false, free_freight_units: 4, shipments: [{ group: "all", subtotal: 2600, sh: 78, freight: 70 }] },
  freight: { included: true, note: "n" }, quote_hash: HASH };
const ORDERV = () => ({ internal_note: "LEAK", po_number: "PO-1", po_auto: false, ship_to: { id: LOC, kind: "ship_location", label: "Store", address: "1 Main St", city: "Cincinnati", state: "OH", zip: "45202", secret: "LEAK" },
  contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" }, attention: "", notes: "", delivery_type: "business", split_order: false, lines: [{ sku: "PR511-LAR", reference_names: ["Mrs. Smith"], cost: "LEAK" }] });
const PLACED = () => ({ contract_version: "1.6.0", request_id: "req_p", mode: "submit", placed: true, ordering_enabled: true, idempotent_replay: false, engine: "0123456789abcdef",
  order_ref: "P1661", status: "submitted", placed_at: "2026-11-04T16:00:00.000Z", test_mode: true, order: ORDERV(), quote: QUOTE, customer_no: "LEAK", order_id: 1661,
  notifications: { order_desk: "sent", dealer_confirmation: "sent", to: "LEAK@golden" } });
const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
function world(o) {
  o = o || {}; const golden = [];
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    if (/goldenonlineordering\.netlify\.app\//.test(u)) { golden.push({ u, init }); return o.golden ? o.golden(u, init) : res(201, PLACED()); }
    if (/auth\/v1\/user/.test(u)) return res(200, { id: "uid-1" });
    if (/dealer_users/.test(u)) return res(200, [{ status: "approved", dealer_id: o.dealerId || D_HQ }]);
    if (/dealer_preview_tokens/.test(u)) return res(200, [{ dealer_id: o.dealerId || D_HQ, expires_at: null }]);
    if (/app_settings/.test(u)) return res(200, [{ value: Object.assign({ golden_p360_catalog: true, golden_p360_pilot_dealers: [D_HQ] }, o.flags || {}) }]);
    if (/dealers\?id=eq\./.test(u)) {
      const id = decodeURIComponent(u.match(/dealers\?id=eq\.([^&]+)/)[1]);
      const rows = o.dealers || { [D_HQ]: { id: D_HQ, parent_id: null, is_test: !!o.isTest }, [D_BR]: { id: D_BR, parent_id: D_HQ, is_test: !!o.isTest } };
      return res(200, rows[id] ? [rows[id]] : []);
    }
    if ((init.method || "GET") !== "GET") throw new Error("HCPS must store nothing: " + init.method + " " + u);
    return res(200, []);
  };
  return { golden };
}
const post = (b, h) => ({ httpMethod: "POST", headers: Object.assign({ authorization: "Bearer jwt" }, h || {}), body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);
const ORDER = over => Object.assign({ action: "place_order", idempotency_key: crypto.randomUUID(), quote_hash: HASH,
  lines: [{ sku: "pr511-lar", fabric: "std", color: "sum", tier: "nirvana", qty: 2, reference_names: [" Mrs. Smith ", ""], unit_price: 1 }],
  ship_to: { id: LOC }, po_number: "PO-1", contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" }, attention: "", notes: "Back dock" }, over || {});
const PROD_ON = { flags: { golden_p360_checkout: true, golden_p360_ordering: true } };
const PREVIEW_H = { "x-hcps-golden-env": "preview", origin: PREVIEW_ORIGIN };

(async () => {
  await t("place_order: Golden gets POST /v1/orders, mode submit, the SAME key and the SAME fields as the validation", async () => {
    env(); const w = world(PROD_ON); const o = ORDER();
    const r = J(await load("golden-proxy.js").handler(post(Object.assign({}, o, { grand_total: 1, dealer_id: "x", order_ref: "P1" }))));
    eq([r.ok, r.placed, r.order_ref, r.status], [true, true, "P1661", "submitted"]);
    const g = w.golden[0];
    eq([new URL(g.u).pathname, g.init.method, g.init.headers["Idempotency-Key"]], ["/v1/orders", "POST", o.idempotency_key]);
    const sent = JSON.parse(g.init.body);
    eq(sent, { mode: "submit", quote_hash: HASH, lines: [{ sku: "PR511-LAR", fabric: "std", color: "SUM", qty: 2, tier: "nirvana", reference_names: ["Mrs. Smith"] }],
      ship_to: { id: LOC }, contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" }, po_number: "PO-1", notes: "Back dock" });
    // the validation of the same attempt sends the identical body except the mode (Golden compares the two)
    env(); const w2 = world(PROD_ON);
    await load("golden-proxy.js").handler(post(Object.assign({}, o, { action: "validate_order" })));
    eq(Object.assign(JSON.parse(w2.golden[0].init.body), { mode: "submit" }), sent);
    eq(w2.golden[0].init.headers["Idempotency-Key"], o.idempotency_key);
    const d = JSON.parse(Buffer.from(g.init.headers["X-HCPS-Delegation"] || g.init.headers["x-hcps-delegation"], "base64url").toString());
    eq([d.role, d.sub_dealer, d.sub_branch], ["dealer", D_HQ, null]);
  });

  await t("place_order: Golden's answer allow-listed — order of record, totals, notifications; nothing else crosses", async () => {
    env(); world(PROD_ON);
    const r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.order_ref, r.placed_at, r.test_mode, r.quote.totals.grand_total, r.order.ship_to.address, r.notifications, r.idempotent_replay],
      ["P1661", "2026-11-04T16:00:00.000Z", true, 2748, "1 Main St", { order_desk: "sent", dealer_confirmation: "sent" }, false]);
    ok(!/LEAK|order_id/.test(JSON.stringify(r)), "nothing outside the contract crosses");
  });

  await t("place_order: never from a staff view-as token — production path or preview environment; Golden not called", async () => {
    for (const h of [{ "x-hcps-preview": "a".repeat(48) }, Object.assign({ "x-hcps-preview": "a".repeat(48) }, PREVIEW_H)]) {
      env(); const w = world(Object.assign({ isTest: true }, PROD_ON, { flags: Object.assign({ golden_p360_preview_orders: true }, PROD_ON.flags) }));
      const r = await load("golden-proxy.js").handler({ httpMethod: "POST", headers: h, body: JSON.stringify(ORDER()) });
      eq([r.statusCode, J(r).error], [403, "preview_not_allowed"]); eq(w.golden.length, 0);
    }
  });

  await t("place_order: production needs catalog + checkout + ordering switches and the pilot list; otherwise Golden is not called", async () => {
    for (const [flags, reason] of [[{ golden_p360_checkout: true }, "ordering_switched_off"], [{ golden_p360_ordering: true }, "checkout_switched_off"],
      [{ golden_p360_catalog: false, golden_p360_checkout: true, golden_p360_ordering: true }, "switched_off"],
      [{ golden_p360_checkout: true, golden_p360_ordering: true, golden_p360_pilot_dealers: [] }, "not_in_pilot"]]) {
      env(); const w = world({ flags });
      const r = J(await load("golden-proxy.js").handler(post(ORDER())));
      eq([r.enabled, r.reason], [false, reason], JSON.stringify(flags)); eq(w.golden.length, 0);
    }
  });

  await t("go-live: golden_p360_all_linked opens every dealer (empty pilot list); Golden's link still decides", async () => {
    env(); let w = world({ flags: { golden_p360_checkout: true, golden_p360_ordering: true, golden_p360_pilot_dealers: [], golden_p360_all_linked: true } });
    let r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.placed, r.order_ref], [true, "P1661"]); eq(w.golden.length, 1);
    // only exactly true opens it
    for (const v of ["true", 1, null]) {
      env(); w = world({ flags: { golden_p360_checkout: true, golden_p360_ordering: true, golden_p360_pilot_dealers: [], golden_p360_all_linked: v } });
      r = J(await load("golden-proxy.js").handler(post(ORDER())));
      eq([r.enabled, r.reason], [false, "not_in_pilot"], String(v)); eq(w.golden.length, 0);
    }
  });

  await t("go-live: golden_p360_branch_as_account — a branch orders under its head office's account (role dealer, no sub_branch)", async () => {
    env(); let w = world({ dealerId: D_BR, flags: { golden_p360_checkout: true, golden_p360_ordering: true, golden_p360_branch_as_account: true } });
    let r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq(r.placed, true);
    let g = w.golden[0], d = JSON.parse(Buffer.from(g.init.headers["X-HCPS-Delegation"] || g.init.headers["x-hcps-delegation"], "base64url").toString());
    eq([d.role, d.sub_dealer, d.sub_branch], ["dealer", D_HQ, null]);
    // switch off: the branch is delegated as a branch (Golden decides — today branch_not_permitted without a branch map)
    env(); w = world({ dealerId: D_BR, flags: { golden_p360_checkout: true, golden_p360_ordering: true, golden_p360_branch_as_account: "true" } });
    await load("golden-proxy.js").handler(post(ORDER()));
    g = w.golden[0]; d = JSON.parse(Buffer.from(g.init.headers["X-HCPS-Delegation"] || g.init.headers["x-hcps-delegation"], "base64url").toString());
    eq([d.role, d.sub_dealer, d.sub_branch], ["branch_user", D_HQ, D_BR]);
  });

  await t("go-live: neither switch touches the preview environment (a TEST branch stays a branch there)", async () => {
    env(); const w = world({ dealerId: D_BR, flags: { golden_p360_preview_orders: true, golden_p360_branch_as_account: true, golden_p360_all_linked: true },
      dealers: { [D_BR]: { id: D_BR, parent_id: D_HQ, is_test: true }, [D_HQ]: { id: D_HQ, parent_id: null, is_test: true } } });
    await load("golden-proxy.js").handler(post(ORDER(), PREVIEW_H));
    const g = w.golden[0], d = JSON.parse(Buffer.from(g.init.headers["X-HCPS-Delegation"] || g.init.headers["x-hcps-delegation"], "base64url").toString());
    eq([d.role, d.sub_branch], ["branch_user", D_BR]);
  });

  await t("preview environment: only a real dealer sign-in of a TEST dealership, behind golden_p360_preview_orders; signed with the TEST key", async () => {
    // switch off
    env(); let w = world({ isTest: true });
    let r = await load("golden-proxy.js").handler(post(ORDER(), PREVIEW_H));
    eq([r.statusCode, J(r).error], [403, "preview_not_allowed"]); eq(w.golden.length, 0);
    // switch on, but not a TEST dealership
    env(); w = world({ isTest: false, flags: { golden_p360_preview_orders: true } });
    r = await load("golden-proxy.js").handler(post(ORDER(), PREVIEW_H));
    eq([r.statusCode, J(r).error], [403, "preview_not_allowed"]); eq(w.golden.length, 0);
    // a TEST branch whose head office is not TEST
    env(); w = world({ dealerId: D_BR, flags: { golden_p360_preview_orders: true }, dealers: { [D_BR]: { id: D_BR, parent_id: D_HQ, is_test: true }, [D_HQ]: { id: D_HQ, parent_id: null, is_test: false } } });
    r = await load("golden-proxy.js").handler(post(ORDER(), PREVIEW_H));
    eq([r.statusCode, J(r).error], [403, "preview_not_allowed"]); eq(w.golden.length, 0);
    // not from a Partner 360 deploy preview
    env(); w = world({ isTest: true, flags: { golden_p360_preview_orders: true } });
    r = await load("golden-proxy.js").handler(post(ORDER(), { "x-hcps-golden-env": "preview", origin: "https://hcpsonlineordering.netlify.app" }));
    eq([r.statusCode, J(r).error], [403, "preview_not_allowed"]);
    // allowed: TEST dealer, switch on, preview origin → Golden deploy preview, TEST key, role dealer; production switches not needed
    env(); w = world({ isTest: true, flags: { golden_p360_catalog: false, golden_p360_preview_orders: true } });
    r = J(await load("golden-proxy.js").handler(post(ORDER(), PREVIEW_H)));
    eq([r.placed, r.preview, r.order_ref], [true, true, "P1661"]);
    const g = w.golden[0];
    ok(g.u.startsWith("https://deploy-preview-284--goldenonlineordering.netlify.app/v1/orders"), g.u);
    ok(/kid=hcps-p360-preview-1/.test(g.init.headers.Authorization || g.init.headers.authorization), "signed with the TEST key");
    const d = JSON.parse(Buffer.from(g.init.headers["X-HCPS-Delegation"] || g.init.headers["x-hcps-delegation"], "base64url").toString());
    eq(d.role, "dealer");
    // a switch read failure is a 503, never "allowed"
    env(); world({ isTest: true }); const g0 = global.fetch;
    global.fetch = async (u, i) => /app_settings/.test(String(u)) ? res(500, {}) : g0(u, i);
    r = await load("golden-proxy.js").handler(post(ORDER(), PREVIEW_H));
    ok(r.statusCode === 503 || J(r).error === "preview_not_allowed", "fail closed: " + r.statusCode);
  });

  await t("validate_order in the preview environment by a TEST dealer reports Place order only when Golden says so", async () => {
    const VAL = () => ({ mode: "validate", valid: true, ordering_enabled: true, test_mode: true, idempotent_replay: false, order: ORDERV(), quote: QUOTE,
      emails: { golden_order: { recipient: "test_recipient", recipient_configured: true, subject: "New Order", html: "<p>g</p>" }, dealer_confirmation: null } });
    env(); world({ isTest: true, flags: { golden_p360_preview_orders: true }, golden: () => res(200, VAL()) });
    let r = J(await load("golden-proxy.js").handler(post(ORDER({ action: "validate_order" }), PREVIEW_H)));
    eq([r.valid, r.ordering_enabled, r.test_mode, r.emails.golden_order.recipient], [true, true, true, "test_recipient"]);
    env(); world({ isTest: true, flags: { golden_p360_preview_orders: true }, golden: () => res(200, Object.assign(VAL(), { ordering_enabled: false })) });
    r = J(await load("golden-proxy.js").handler(post(ORDER({ action: "validate_order" }), PREVIEW_H)));
    eq(r.ordering_enabled, false);
    // a staff view-as token validating in preview never gets a Place order button
    env(); world({ golden: () => res(200, VAL()) });
    r = J(await load("golden-proxy.js").handler({ httpMethod: "POST", headers: Object.assign({ "x-hcps-preview": "a".repeat(48) }, PREVIEW_H), body: JSON.stringify(ORDER({ action: "validate_order" })) }));
    eq([r.valid, r.ordering_enabled], [true, false]);
  });

  await t("place_order: only a DEFINITE refusal says not placed; everything else is outcome_unknown → retry with the SAME key", async () => {
    const cases = [
      [409, { error: { code: "prices_changed" }, quote: Object.assign({}, QUOTE, { quote_hash: "b".repeat(64) }) }, { placed: false, definite: true, reason: "prices_changed", new_attempt: true }],
      [409, { error: { code: "not_validated" } }, { placed: false, reason: "revalidate", new_attempt: true }],
      [409, { error: { code: "validation_expired" } }, { placed: false, reason: "revalidate", new_attempt: true }],
      [422, { error: { code: "idempotency_conflict" } }, { placed: null, reason: "unconfirmed", retry: false }],
      [409, { error: { code: "attempt_other_dealer" } }, { placed: null, reason: "unconfirmed", retry: false }],
      [403, { error: { code: "scope" } }, { placed: null, reason: "outcome_unknown", retry: true }],
      [401, { error: { code: "bad_signature" } }, { placed: null, reason: "outcome_unknown", retry: true }],
      [409, { error: { code: "duplicate_po" } }, { placed: false, reason: "duplicate_po", new_attempt: true }],
      [409, { error: { code: "freight_quote_required" } }, { placed: false, definite: true, reason: "freight_quote_required", new_attempt: false }],
      [403, { error: { code: "ordering_not_enabled" } }, { placed: false, definite: true, reason: "ordering_unavailable", new_attempt: false }],
      [403, { error: { code: "ordering_disabled" } }, { placed: false, definite: true, reason: "ordering_unavailable", new_attempt: false }],
      [403, { error: { code: "ordering_not_permitted" } }, { placed: false, reason: "ordering_unavailable", new_attempt: false }],
      [403, { error: { code: "order_scope" } }, { placed: false, definite: true, reason: "ordering_unavailable", new_attempt: false }],
      [400, { error: { code: "bad_request", message: "po_required" } }, { placed: false, reason: "invalid", field: "po_required" }],
      [400, { error: { code: "bad_request", message: "weird<x>" } }, { placed: false, reason: "invalid", field: "order" }],
      [503, { error: { code: "idempotency_unavailable" } }, { placed: null, reason: "outcome_unknown", retry: true }],
      [503, { error: { code: "internal" } }, { placed: null, reason: "outcome_unknown", retry: true }],
      [500, {}, { placed: null, reason: "outcome_unknown", retry: true }],
      [409, { error: { code: "idempotency_in_progress" } }, { placed: null, reason: "outcome_unknown", retry: true }],
      [200, PLACED(), { placed: null, reason: "outcome_unknown", retry: true }],
      [201, Object.assign(PLACED(), { order_ref: "G123" }), { placed: null, reason: "outcome_unknown", retry: true }],
      [201, Object.assign(PLACED(), { quote: Object.assign({}, QUOTE, { quote_hash: "c".repeat(64) }) }), { placed: null, reason: "outcome_unknown", retry: true }],
      [201, Object.assign(PLACED(), { status: "invoiced" }), { placed: null, reason: "outcome_unknown", retry: true }],
    ];
    for (const [st, body, want] of cases) {
      env(); world(Object.assign({ golden: () => res(st, body) }, PROD_ON));
      const r = J(await load("golden-proxy.js").handler(post(ORDER())));
      const got = {}; for (const k of Object.keys(want)) got[k] = r[k];
      eq(got, want, st + " " + JSON.stringify(body).slice(0, 60));
      if (want.reason === "prices_changed") eq(r.quote.quote_hash, "b".repeat(64));
    }
    // Golden unreachable / timed out
    env(); world(PROD_ON); const g0 = global.fetch;
    global.fetch = async (u, i) => /goldenonlineordering/.test(String(u)) ? (() => { throw new Error("ECONNRESET"); })() : g0(u, i);
    const r = J(await load("golden-proxy.js").handler(post(ORDER())));
    eq([r.placed, r.reason, r.retry], [null, "outcome_unknown", true]);
  });

  await t("place_order: bad requests refused before Golden is called (key, quote hash, ship-to id, free text)", async () => {
    for (const over of [{ idempotency_key: "nope" }, { idempotency_key: undefined }, { quote_hash: "x" }, { ship_to: { city: "X" } }, { notes: "<b>x</b>" }, { po_number: "P\"O" }]) {
      env(); const w = world(PROD_ON); const o = ORDER(over); if ("idempotency_key" in over && over.idempotency_key === undefined) delete o.idempotency_key;
      const r = await load("golden-proxy.js").handler(post(o));
      eq(r.statusCode, 400, JSON.stringify(over)); eq(w.golden.length, 0);
    }
  });

  await t("source: the proxy stores nothing and never computes a Golden price, S&H or total", async () => {
    const src = fs.readFileSync(path.join(FN, "golden-proxy.js"), "utf8").replace(/^\s*\/\/.*$/mg, "");
    ok(!/method:\s*"(PATCH|DELETE|PUT)"/.test(src) && !/fetch\([^)]*rest\/v1\/[^)]*\{\s*method:\s*"POST"/.test(src), "no Supabase write");
    ok(!/grand_total\s*[=:]\s*[^,}]*[+*]/.test(src), "no total computed by HCPS");
  });

  // ── Real cross-repo round trip: Golden's B6 code behind this repo's client (test mode, synthetic) ──
  const gFN = path.join(GOLDEN, "repo", "functions");
  const golden6 = fs.existsSync(path.join(gFN, "lib", "golden-order-notify.js"));
  if (!golden6) { skipped++; console.log("skip  cross-repo placement round trip (Golden B6 not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: validate → place through Golden's real code — one order, test mailbox only, replay, conflict, history once", async () => {
    const { createMock } = require(path.join(GOLDEN, "repo", "tests", "support", "postgrest-mock.js"));
    const fresh = m => { Object.keys(require.cache).forEach(k => { if (k.startsWith(gFN)) delete require.cache[k]; }); return require(path.join(gFN, m)); };
    const gS = fresh("lib/hcps-s2s.js");
    // Mirror of Golden's SQL (config/migrate-hcps-integration-v1-submit.sql): records per key AND mode; order + answer together.
    const recs = new Map(), orders = []; let nextId = 1661;
    const rk = (p, m) => p.client_id + "|" + p.idempotency_key + "|" + m;
    const valOk = (v, p) => v && v.s === "done" && v.st === 200 && v.resp.valid === true && v.h === p.validate_hash && v.g === p.golden_dealer_id && v.d === p.hcps_dealer_id;
    const rpcIdem = {
      integration_order_claim: ({ p }) => { const k = rk(p, "validate"), r = recs.get(k); if (!r) { const tok = crypto.randomUUID(); recs.set(k, { h: p.request_hash, s: "pending", tok, g: p.golden_dealer_id, d: p.hcps_dealer_id }); return { state: "new", claim_token: tok }; }
        if (r.h !== p.request_hash) return { state: "conflict" }; if (r.s === "done") return { state: "replay", status: r.st, response: r.resp }; return { state: "in_progress" }; },
      integration_order_complete: ({ p }) => { const r = recs.get(rk(p, "validate")); if (!r || r.tok !== p.claim_token) throw new Error("no pending claim"); r.s = "done"; r.st = p.status; r.resp = p.response; return true; },
      integration_order_release: ({ p }) => { recs.delete(rk(p, "validate")); return true; },
      integration_order_submit_lookup: ({ p }) => { const s = recs.get(rk(p, "submit")); if (s) return s.h !== p.request_hash ? { state: "conflict" } : { state: "replay", status: s.st, response: s.resp, order_id: s.oid, email_open: !s.done };
        const v = recs.get(rk(p, "validate")); return valOk(v, p) ? { state: "validated", po_number: v.resp.order.po_number, po_auto: v.resp.order.po_auto } : { state: "not_validated" }; },
      integration_order_submit: ({ p }) => { const k = rk(p, "submit"), s = recs.get(k);
        if (s) return s.h !== p.request_hash ? { state: "conflict" } : { state: "replay", status: s.st, response: s.resp, order_id: s.oid };
        if (!valOk(recs.get(rk(p, "validate")), p)) return { state: "not_validated" };
        const ident = { d: p.hcps_dealer_id, b: p.hcps_branch_id || null, g: p.golden_dealer_id };
        if (p.refusal) { recs.set(k, Object.assign({ h: p.request_hash, st: p.refusal.status, resp: p.refusal.response }, ident)); return { state: "refused", status: p.refusal.status, response: p.refusal.response }; }
        const id = nextId++; orders.push(Object.assign({}, p.order_row, { id, status: "pending", order_source: "online", created_at: new Date().toISOString(), sales_order_no: null }));
        const resp = Object.assign({}, p.response, { order_ref: "P" + id, status: "submitted", placed_at: new Date().toISOString() });
        recs.set(k, Object.assign({ h: p.request_hash, st: 201, resp, oid: id }, ident)); return { state: "created", status: 201, response: resp, order_id: id, email_claim: crypto.randomUUID() }; },
      integration_order_submit_find: ({ p }) => { const s = recs.get(rk(p, "submit")); return s ? { found: true, request_hash: s.h, hcps_dealer_id: s.d, hcps_branch_id: s.b, golden_dealer_id: s.g,
        status: s.st, response: s.resp, order_id: s.oid == null ? null : s.oid, email_open: false } : { found: false }; },
      integration_order_email_claim: () => null,
      integration_order_email_done: ({ p }) => { const s = recs.get(rk(p, "submit")); s.done = p.result; return true; },
    };
    let cost = 1100; const sent = [];
    const call = async (body) => {
      env({ GOLDEN_API_BASE: "https://golden.test" });
      Object.assign(process.env, { SUPABASE_SERVICE_KEY: "svc", GOLDEN_V1_API: "true", HCPS_P360_KEYS: JSON.stringify({ "hcps-p360-1": SECRET }),
        ORDER_EMAIL_TO: "desk@golden.example", ORDER_EMAIL_FROM: "p@golden.example", RESEND_API_KEY: "re_test",
        GOLDEN_V1_ORDERS: process.env.__B6_ORDERS_OFF ? "false" : "true", P360_TEST_DEALERS: "dealer-a", P360_TEST_EMAIL_TO: "angelo@homecareproviderservices.us" });
      delete process.env.P360_ORDER_ENV; delete process.env.CONTEXT;
      const nonces = new Set();
      const goldenSb = createMock({ tables: {
        integration_clients: [{ kid: "hcps-p360-1", client_id: "hcps-partner360", tenant_id: "hcps", scopes: ["golden:read", "golden:order", "golden:history"], active: true, secret_fingerprint: gS.fingerprint(SECRET) }],
        dealer_integration_map: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", tenant_id: "hcps", client_id: "hcps-partner360", hcps_dealer_id: D_HQ, golden_dealer_id: "dealer-a", status: "verified", price_visibility: "dealer", golden_ordering_enabled: true, history_enabled: true }],
        dealer_integration_branch_map: [], dealers: [{ id: "dealer-a", active: true, customer_no: "100001" }], dealer_branches: [],
        dealer_ship_locations: [{ id: LOC, dealer_id: "dealer-a", label: "Store", ship_address: "1 Main St", ship_city: "Cincinnati", ship_state: "OH", ship_zip: "45202", created_at: "2026-01-01" }],
        dealer_locations: [], dealer_special_terms: [], orders, golden_orders: [], golden_order_items: [], order_links: [],
        inventory: [{ sku: "PR511-LAR", size: "LAR", fabcode: "SKN", color_code: "SUM", avail: 3, pool: null }],
      }, rpc: Object.assign({
        integration_nonce_claim: a => { const f1 = !nonces.has(a.p_nonce); nonces.add(a.p_nonce); return f1; },
        integration_audit_log: () => null,
        get_dealer_portal_data: () => ({ dealer: { dealer_id: "dealer-a", name: "Dealer A", customer_no: "100001", terms: "Net 30" }, pricing: [{ sku: "PR511-LAR", dealer_cost: cost }] }),
      }, rpcIdem) });
      const handlers = { "/v1/quote": fresh("v1-quote.js").handler, "/v1/orders": fresh("v1-orders.js").handler, "/v1/history": fresh("v1-history.js").handler };
      world(Object.assign({}, PROD_ON, { flags: Object.assign({ golden_p360_history: true }, PROD_ON.flags) }));
      const hcpsFetch = global.fetch;
      global.fetch = async (u, init) => {
        if (/api\.resend\.com/.test(String(u))) { sent.push(JSON.parse(init.body)); return res(200, { id: "re_1" }); }
        if (String(u).startsWith("https://golden.test/")) {
          const url = new URL(String(u));
          const ev = { httpMethod: init.method, rawUrl: String(u), path: url.pathname, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), queryStringParameters: Object.fromEntries(url.searchParams), body: init.body || "", isBase64Encoded: false };
          const saved = global.fetch; global.fetch = (x, y) => /api\.resend\.com/.test(String(x)) ? saved(x, y) : goldenSb(String(x).replace("https://sb.test", "http://sb.test"), y);
          process.env.SUPABASE_URL = "http://sb.test";
          try { const r = await handlers[url.pathname](ev); return { ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(r.body), text: async () => r.body }; }
          finally { global.fetch = saved; process.env.SUPABASE_URL = "https://sb.test"; }
        }
        return hcpsFetch(u, init);
      };
      return J(await load("golden-proxy.js").handler(post(body)));
    };
    const LN = { sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "nirvana", qty: 2 };
    const q = await call({ action: "quote", lines: [LN], ship_to: { id: LOC } });
    const key = crypto.randomUUID();
    const base = { idempotency_key: key, quote_hash: q.quote.quote_hash, lines: [Object.assign({ reference_names: ["Mrs. Smith"] }, LN)], ship_to: { id: LOC },
      po_number: "PO-55", contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" } };
    // placing before validating is refused
    const early = await call(Object.assign({ action: "place_order" }, base, { idempotency_key: crypto.randomUUID() }));
    eq([early.placed, early.reason], [false, "revalidate"]);
    const v = await call(Object.assign({ action: "validate_order" }, base));
    eq([v.valid, v.ordering_enabled, v.test_mode, v.emails.golden_order.recipient], [true, true, true, "test_recipient"]);
    const p = await call(Object.assign({ action: "place_order" }, base));
    eq([p.placed, p.order_ref, p.status, p.order.po_number, p.quote.quote_hash, p.idempotent_replay, p.test_mode], [true, "P1661", "submitted", "PO-55", q.quote.quote_hash, false, true]);
    eq(orders.length, 1); eq(orders[0].dealer_id, "dealer-a"); ok(orders[0].notes.startsWith("TEST ORDER"), "marked for Golden staff");
    eq(sent.length, 2); ok(sent.every(m => m.to[0] === "angelo@homecareproviderservices.us" && m.subject.startsWith("[TEST")), "test mailbox only");
    ok(!JSON.stringify(p).includes("desk@golden.example"), "the order desk address never reaches HCPS");
    const again = await call(Object.assign({ action: "place_order" }, base));
    eq([again.placed, again.order_ref, again.idempotent_replay], [true, "P1661", true]); eq(orders.length, 1); eq(sent.length, 2, "a replay sends nothing");
    // Golden's ordering switched off AFTER the placement: the retry still gets the placed order (replay first)
    process.env.__B6_ORDERS_OFF = "1";
    const off = await call(Object.assign({ action: "place_order" }, base));
    delete process.env.__B6_ORDERS_OFF;
    eq([off.placed, off.order_ref, off.idempotent_replay], [true, "P1661", true], "never 'not placed' for a placed attempt"); eq(orders.length, 1);
    const vAgain = await call(Object.assign({ action: "validate_order" }, base));
    eq([vAgain.valid, vAgain.idempotent_replay, vAgain.order_ref], [true, true, undefined], "the validation stays the validation");
    const conflict = await call(Object.assign({ action: "place_order" }, base, { po_number: "PO-56" }));
    eq([conflict.placed, conflict.reason], [null, "unconfirmed"], "same key, different content after placement → never 'not placed', never a second order"); eq(orders.length, 1);
    const h = await call({ action: "history" });
    eq(h.orders.filter(o => o.order_ref === "P1661").length, 1, "in Golden's history at once, and once");
    eq(h.orders.find(o => o.order_ref === "P1661").status, "submitted");
    // a price change after review: refused, nothing placed
    const k2 = crypto.randomUUID(), b2 = Object.assign({}, base, { idempotency_key: k2 });
    await call(Object.assign({ action: "validate_order" }, b2));
    cost = 1150;
    const moved = await call(Object.assign({ action: "place_order" }, b2));
    eq([moved.placed, moved.reason, moved.quote.lines[0].unit_price], [false, "prices_changed", 1350]); eq(orders.length, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
