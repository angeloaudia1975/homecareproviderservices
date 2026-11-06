// Synthetic HCPS database for the B7 tests (HCPS test/golden-integration-b7.test.js and the ordering repo's
// test/golden-b7.browser.js): dealers, Golden account numbers, addresses — and a small PostgREST stand-in.
"use strict";
const crypto = require("crypto");
const U = n => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Account T90100: head office HQ1 (+ branch BR1 without a number of its own, + branch BRX with ANOTHER number), and a
// separate head office HQ2 that carries the same number. Account T22200: unrelated dealer HQ3. HQ4: no Golden number.
const HQ1 = U(1), BR1 = U(2), BRX = U(3), HQ2 = U(4), HQ3 = U(5), HQ4 = U(6), HQT = U(7), INACT = U(8);
const SAVED_A = U(101), SAVED_GONE = U(102), SAVED_B = U(103);
function db(o) {
  o = o || {};
  return {
    dealers: [
      { id: HQ1, parent_id: null, business_name: "Riverbend Medical", address: "10 Main St", city: "Somerset", state: "KY", zip: "42501", is_test: false, active: true },
      { id: BR1, parent_id: HQ1, business_name: "Riverbend — Hillside", address: "5 Elm St", city: "London", state: "KY", zip: "40741", is_test: false, active: true },
      { id: BRX, parent_id: HQ1, business_name: "Riverbend — Other Account", address: "9 Oak St", city: "Corbin", state: "KY", zip: "40701", is_test: false, active: true },
      { id: HQ2, parent_id: null, business_name: "Riverbend Health LLC (DBA)", address: "77 Pine Rd", city: "Danville", state: "KY", zip: "40422", is_test: false, active: true },
      { id: HQ3, parent_id: null, business_name: "Unrelated Mobility", address: "1 Far Rd", city: "Atlanta", state: "GA", zip: "30301", is_test: false, active: true },
      { id: HQ4, parent_id: null, business_name: "No Golden Number", address: "2 Near Rd", city: "Dayton", state: "OH", zip: "45402", is_test: false, active: true },
      { id: HQT, parent_id: null, business_name: "TEST shop", address: "3 Test Rd", city: "Dayton", state: "OH", zip: "45402", is_test: true, active: true },
      { id: INACT, parent_id: null, business_name: "Closed store", address: "4 Shut Rd", city: "Dayton", state: "OH", zip: "45402", is_test: false, active: false },
    ],
    dealer_manufacturers: (o.prependDm || []).concat([
      { dealer_id: HQ1, manufacturer: "golden-technologies", account_ref: "T90100", active: true },
      { dealer_id: BRX, manufacturer: "golden-technologies", account_ref: "T90999", active: true },
      { dealer_id: HQ2, manufacturer: "golden-technologies", account_ref: " T90100 ", active: true },
      { dealer_id: HQ3, manufacturer: "golden-technologies", account_ref: "T22200", active: true },
      { dealer_id: HQ4, manufacturer: "pedifix", account_ref: "T90100", active: true },
      { dealer_id: HQT, manufacturer: "golden-technologies", account_ref: "T90100", active: true },
      { dealer_id: INACT, manufacturer: "golden-technologies", account_ref: "T90100", active: true },
    ].concat(o.extraDm || [])),
    dealer_addresses: [{ dealer_id: BR1, addr_key: "ship-ab12", label: "London warehouse", address: "6 Dock Rd", city: "London", state: "KY", zip: "40741" },
      { dealer_id: HQ3, addr_key: "ship-zz99", label: "Atlanta dock", address: "8 Dock Rd", city: "Atlanta", state: "GA", zip: "30301" },
      { dealer_id: HQ1, addr_key: "primary", label: "Primary", address: "10 Main St", city: "Somerset", state: "KY", zip: "42501" }],
    golden_ship_addresses: [
      { id: SAVED_A, account_no: "T90100", name: "Mrs. Patient Home", address: "42 Oak Lane", address2: "Apt 3", city: "Somerset", state: "KY", zip: "42501", phone: "606-555-0142", created_dealer: HQ2, removed_at: null, created_at: "2026-11-01" },
      { id: SAVED_GONE, account_no: "T90100", name: "Old drop ship", address: "1 Gone St", address2: "", city: "Somerset", state: "KY", zip: "42501", phone: "", created_dealer: HQ1, removed_at: "2026-11-02T00:00:00Z", created_at: "2026-10-01" },
      { id: SAVED_B, account_no: "T22200", name: "Other account home", address: "2 Secret Ln", address2: "", city: "Atlanta", state: "GA", zip: "30301", phone: "", created_dealer: HQ3, removed_at: null, created_at: "2026-11-01" }],
    golden_ship_defaults: (o.defaults || []).slice(),
    dealer_users: [{ uid: "uid-1", status: "approved", dealer_id: o.dealerId || HQ1 }],
    dealer_preview_tokens: [{ token: "f".repeat(48), dealer_id: o.dealerId || HQ1, expires_at: null }],
    app_settings: [{ key: "phase2_flags", value: Object.assign({ golden_p360_catalog: true, golden_p360_all_linked: true, golden_p360_branch_as_account: true,
      golden_p360_checkout: true, golden_p360_ordering: true, golden_p360_account_gate: true, golden_p360_hcps_shipto: true }, o.flags || {}) }],
  };
}
// A small PostgREST stand-in: eq / in / is / like filters, select, order, limit; POST, PATCH with return=representation.
function rest(tables, writes) {
  const parse = v => { v = decodeURIComponent(v); const m = /^(eq|in|is|like)\.(.*)$/.exec(v); return m ? { op: m[1], arg: m[2] } : null; };
  const match = (row, f) => Object.entries(f).every(([k, c]) => {
    const v = row[k];
    if (c.op === "eq") return String(v) === c.arg;
    if (c.op === "in") return c.arg.replace(/^\(|\)$/g, "").split(",").includes(String(v));
    if (c.op === "is") return c.arg === "null" ? v == null : String(v) === c.arg;
    if (c.op === "like") return new RegExp("^" + c.arg.replace(/\*/g, ".*") + "$").test(String(v));
    return false;
  });
  return (u, init) => {
    const url = new URL(u); const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const rows = tables[table]; if (!rows) return { ok: false, status: 404, text: async () => "no table", json: async () => ({}) };
    const f = {}; let limit = null, offset = 0;
    for (const [k, v] of url.searchParams) { if (["select", "order", "on_conflict"].includes(k)) continue; if (k === "limit") { limit = Number(v); continue; } if (k === "offset") { offset = Number(v); continue; } const p = parse(v); if (p) f[k] = p; }
    const method = (init && init.method) || "GET";
    const res = (st, b) => ({ ok: st < 400, status: st, text: async () => JSON.stringify(b), json: async () => b });
    if (method === "GET") { let out = rows.filter(r => match(r, f)).slice(offset); out = out.slice(0, Math.min(limit == null ? 1000 : limit, 1000)); /* PostgREST max-rows */ return res(200, out); }
    const body = JSON.parse(init.body); writes.push({ method, table, f, body });
    if (method === "PATCH") { const hit = rows.filter(r => match(r, f)); hit.forEach(r => Object.assign(r, body)); return res(200, hit); }
    if (method === "POST") {
      const conflict = url.searchParams.get("on_conflict");
      if (conflict) { const ks = conflict.split(","); const ex = rows.find(r => ks.every(k => String(r[k]) === String(body[k]))); if (ex) { Object.assign(ex, body); return res(201, [ex]); } }
      const row = Object.assign({ id: crypto.randomUUID(), removed_at: null }, body); rows.push(row); return res(201, [row]);
    }
    return res(405, {});
  };
}
module.exports = { U, HQ1, BR1, BRX, HQ2, HQ3, HQ4, HQT, INACT, SAVED_A, SAVED_GONE, SAVED_B, db, rest };
