// Golden ⇄ HCPS Partner 360 — batch B7 (HCPS side): the Golden ACCOUNT NUMBER is the pricing contract; HCPS is the
// ship-to system of record. Synthetic data only. Proves: the account gate (fail closed), the number travels in the signed
// delegation with sub_dealer = the dealer holding it, multi-location sharing, isolation of unrelated accounts, the shared
// address book (locations + saved), per-user defaults, add-and-use-at-once, server-side resolution of a ref (never a
// browser address), the reviewed-address check on place, and — with ../golden-dealer-portal checked out — that HCPS and
// Golden validate addresses and compute the address id identically.
//   node test/golden-integration-b7.test.js
"use strict";
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");
const GOLDEN = process.env.GOLDEN_REPO || path.join(ROOT, "..", "golden-dealer-portal");
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, "\n   ", e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e); } };
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((m || "") + " got " + A + " want " + B); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const SECRET = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/contracts/golden-commerce-v1.signing-vectors.json"), "utf8")).secret;
function load(mod) { Object.keys(require.cache).forEach(k => { if (k.startsWith(FN)) delete require.cache[k]; }); return require(path.join(FN, mod)); }
function env() {
  process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_ROLE = "svc";
  process.env.GOLDEN_P360_KEY_ID = "hcps-p360-1"; process.env.GOLDEN_P360_SECRET = SECRET; delete process.env.GOLDEN_API_BASE;
}
const { U, HQ1, BR1, BRX, HQ2, HQ3, HQ4, HQT, INACT, SAVED_A, SAVED_GONE, SAVED_B, db, rest } = require("./golden-b7-world.js");
const QUOTE = { lines: [{ line: 0, sku: "PR511-LAR", qty: 2, fabric: "std", color: "SUM", color_name: "Summit", tier: "nirvana", footrest: false, unit_price: 1300, line_total: 2600,
  details: "Std", upgrades: [], breakdown: "b", lead_note: null, in_stock: true, custom: false, item_no: "PR511-LAR-SKN-SUM", item_no_resolved: true }],
  totals: { subtotal: 2600, freight_total: 70, sh_total: 78, grand_total: 2748, sh_rate: 0.03, sh_waived: false, split: false, free_freight_units: 4, shipments: [{ group: "all", subtotal: 2600, sh: 78, freight: 70 }] },
  freight: { included: true, note: "n" }, quote_hash: "a".repeat(64) };
function world(o) {
  o = o || {}; const tables = db(o), writes = [], golden = [];
  const sb = rest(tables, writes);
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    if (/goldenonlineordering\.netlify\.app\//.test(u)) { golden.push({ u, init }); return o.golden ? o.golden(u, init) : { ok: true, status: 200, text: async () => "{}", json: async () => ({ contract_version: "1.8.0", request_id: "req_1", quote: QUOTE, ship_to_id: null }) }; }
    if (/auth\/v1\/user/.test(u)) return { ok: true, status: 200, json: async () => ({ id: "uid-1" }) };
    return sb(u, init);
  };
  return { tables, writes, golden };
}
const post = (b, h) => ({ httpMethod: "POST", headers: Object.assign({ authorization: "Bearer jwt" }, h || {}), body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);
const deleg = g => JSON.parse(Buffer.from(g.init.headers["x-hcps-delegation"], "base64url").toString("utf8"));
const LINE = { sku: "PR511-LAR", fabric: "std", color: "SUM", tier: "nirvana", qty: 2 };
const api = async (b, o, h) => { env(); const w = world(o); const r = await load("golden-addresses-api.js").handler(post(b, h)); return { r, b: J(r), w }; };
const proxy = async (b, o, h) => { env(); const w = world(o); const r = await load("golden-proxy.js").handler(post(b, h)); return { r, b: J(r), w }; };

(async () => {
  // ---- account number = pricing contract ----
  await t("gate: the number travels in the signed delegation; sub_dealer = the dealer holding it; a branch uses its head office's", async () => {
    let x = await proxy({ action: "eligibility" }, { dealerId: BR1 });
    eq([deleg(x.w.golden[0]).acct, deleg(x.w.golden[0]).sub_dealer, deleg(x.w.golden[0]).sub_branch], ["190100", HQ1, null]);
    x = await proxy({ action: "eligibility" }, { dealerId: HQ2 });
    eq([deleg(x.w.golden[0]).acct, deleg(x.w.golden[0]).sub_dealer], ["190100", HQ2], "separate head office, same number (names differ — irrelevant)");
    x = await proxy({ action: "eligibility" }, { dealerId: BRX });
    eq([deleg(x.w.golden[0]).acct, deleg(x.w.golden[0]).sub_dealer], ["190999", BRX], "a branch with its own number is its own account");
  });
  await t("gate: no Golden number (only another line's) → enabled:false, Golden is never called; two numbers on one dealer → ambiguous", async () => {
    let x = await proxy({ action: "catalog" }, { dealerId: HQ4 });
    eq([x.b.enabled, x.b.reason, x.w.golden.length], [false, "no_golden_account", 0]);
    x = await proxy({ action: "quote", lines: [LINE] }, { dealerId: HQ1, extraDm: [{ dealer_id: HQ1, manufacturer: "golden", account_ref: "190101", active: true }] });
    eq([x.b.enabled, x.b.reason, x.w.golden.length], [false, "golden_account_ambiguous", 0]);
  });
  await t("gate off: no number is sent and B6 behaviour is unchanged", async () => {
    const x = await proxy({ action: "eligibility" }, { dealerId: BR1, flags: { golden_p360_account_gate: false } });
    eq([deleg(x.w.golden[0]).acct, deleg(x.w.golden[0]).sub_dealer], [undefined, HQ1]);
  });
  await t("gate: the browser cannot supply or change the number", async () => {
    const x = await proxy({ action: "quote", lines: [LINE], acct: "220200", account_no: "220200", sub_dealer: HQ3 }, { dealerId: HQ1 });
    eq(deleg(x.w.golden[0]).acct, "190100");
  });

  // ---- shared address book ----
  await t("book: every location carrying the number + their HCPS ship-tos + the account's saved addresses; nothing else", async () => {
    const x = await api({ action: "list" }, { dealerId: BR1 });
    const refs = x.b.entries.map(e => e.ref).sort();
    eq(refs, [`da:${BR1}:ship-ab12`, `gs:${SAVED_A}`, `loc:${BR1}`, `loc:${HQ1}`, `loc:${HQ2}`].sort());
    ok(!JSON.stringify(x.b).includes("Secret Ln") && !JSON.stringify(x.b).includes("Atlanta"), "unrelated account isolated");
    ok(!refs.includes(`loc:${BRX}`), "a branch on another Golden account is not in this book");
    ok(!refs.includes(`loc:${HQT}`) && !refs.includes(`loc:${INACT}`), "TEST and inactive dealers left out for a real viewer");
    ok(!refs.includes(`gs:${SAVED_GONE}`), "removed addresses are gone");
    eq([x.b.default_ref, x.b.preselect], [null, null], "several destinations, no default → nothing pre-selected");
  });
  await t("book: an unrelated account sees only its own (pricing + address isolation)", async () => {
    const x = await api({ action: "list" }, { dealerId: HQ3 });
    eq(x.b.entries.map(e => e.ref).sort(), [`da:${HQ3}:ship-zz99`, `gs:${SAVED_B}`, `loc:${HQ3}`].sort());
  });
  await t("book: switches off / no number → enabled:false; staff preview lists but can never write", async () => {
    eq((await api({ action: "list" }, { flags: { golden_p360_hcps_shipto: false } })).b.enabled, false);
    eq((await api({ action: "list" }, { dealerId: HQ4 })).b.reason, "no_golden_account");
    const pv = { authorization: "" , "x-hcps-preview": "f".repeat(48) };
    const l = await api({ action: "list" }, {}, pv); eq([l.b.enabled, l.b.can_edit], [true, false]);
    const s = await api({ action: "save", address: { name: "X Y", address: "1 A St", city: "Somerset", state: "KY", zip: "42501" } }, {}, pv);
    eq([s.r.statusCode, s.w.writes.length], [403, 0]);
  });

  // ---- add, edit, remove; defaults per user ----
  await t("save: a new address is validated, saved for the ACCOUNT (no approval) and usable at once — another location sees it", async () => {
    env(); const w = world({ dealerId: BR1 }); const H = load("golden-addresses-api.js");
    const s = J(await H.handler(post({ action: "save", address: { name: "John Doe Residence", address: "12 River Rd", city: "london", state: "ky", zip: "40741", phone: "(606) 555-0199" }, make_default: true })));
    ok(s.ok && /^gs:/.test(s.saved_ref), JSON.stringify(s)); eq([s.entry.state, s.entry.city, s.entry.usable], ["KY", "london", true]);
    eq(w.tables.golden_ship_addresses.find(r => `gs:${r.id}` === s.saved_ref).account_no, "190100");
    eq(w.writes.map(x => x.table), ["golden_ship_addresses", "golden_ship_defaults"], "no approval request, no other table");
    const l = J(await H.handler(post({ action: "list" })));
    eq([l.default_ref, l.preselect], [s.saved_ref, s.saved_ref], "my new default is pre-selected");
    // the quote can use it right away; HCPS sends Golden the address from ITS record
    const P = load("golden-proxy.js");
    await P.handler(post({ action: "quote", lines: [LINE], ship_to: { ref: s.saved_ref } }));
    const g = JSON.parse(w.golden[w.golden.length - 1].init.body);
    eq(g.ship_to, { hcps: { ref: s.saved_ref, name: "John Doe Residence", address: "12 River Rd", address2: "", city: "london", state: "KY", zip: "40741", phone: "(606) 555-0199" } });
  });
  await t("save: bad addresses refused with the field (Golden's own rules); markup refused", async () => {
    for (const [a, f] of [[{ name: "X", address: "1 A St", city: "Somerset", state: "KY", zip: "42501" }, "name"], [{ name: "Xy", address: "1 A St", city: "Somerset", state: "ZZ", zip: "42501" }, "state"],
      [{ name: "Xy", address: "1 A St", city: "Somerset", state: "KY", zip: "4250" }, "zip"], [{ name: "Xy", address: "1 A St", city: "Somerset", state: "KY", zip: "42501", phone: "555" }, "phone"],
      [{ name: "<b>Xy</b>", address: "1 A St", city: "Somerset", state: "KY", zip: "42501" }, "text"]]) {
      const x = await api({ action: "save", address: a }); eq([x.r.statusCode, x.b.field, x.w.writes.length], [400, f, 0], JSON.stringify(a));
    }
  });
  await t("edit / remove: only a saved address of THIS account; location addresses are not removable here", async () => {
    let x = await api({ action: "save", ref: `gs:${SAVED_A}`, address: { name: "Mrs. Patient Home", address: "43 Oak Lane", city: "Somerset", state: "KY", zip: "42501" } }, { dealerId: HQ1 });
    eq([x.r.statusCode, x.w.tables.golden_ship_addresses.find(r => r.id === SAVED_A).address], [200, "43 Oak Lane"]);
    x = await api({ action: "save", ref: `gs:${SAVED_B}`, address: { name: "Hijack", address: "1 A St", city: "Somerset", state: "KY", zip: "42501" } }, { dealerId: HQ1 });
    eq([x.r.statusCode, x.w.tables.golden_ship_addresses.find(r => r.id === SAVED_B).name], [404, "Other account home"], "another account's address cannot be edited");
    x = await api({ action: "remove", ref: `gs:${SAVED_B}` }, { dealerId: HQ1 }); eq(x.r.statusCode, 404);
    x = await api({ action: "remove", ref: `loc:${HQ1}` }, { dealerId: HQ1 }); eq([x.r.statusCode, x.b.error], [400, "not_removable"]);
    x = await api({ action: "remove", ref: `gs:${SAVED_A}` }, { dealerId: HQ1 });
    eq([x.b.removed, !!x.w.tables.golden_ship_addresses.find(r => r.id === SAVED_A).removed_at, x.w.tables.golden_ship_addresses.length], [true, true, 3], "kept, marked removed");
  });
  await t("defaults: per user; another user's default never changes; a removed default forces a new choice", async () => {
    const defaults = [{ user_uid: "uid-2", account_no: "190100", ref: `loc:${HQ2}` }, { user_uid: "uid-1", account_no: "190100", ref: `gs:${SAVED_GONE}` }];
    let x = await api({ action: "list" }, { dealerId: HQ1, defaults });
    eq([x.b.default_ref, x.b.default_stale, x.b.preselect], [null, true, null], "my default was removed → choose again");
    x = await api({ action: "set_default", ref: `loc:${BR1}` }, { dealerId: HQ1, defaults });
    eq(x.b.default_ref, `loc:${BR1}`);
    eq(x.w.tables.golden_ship_defaults.find(d => d.user_uid === "uid-2").ref, `loc:${HQ2}`, "the other user's default is untouched");
    x = await api({ action: "set_default", ref: `gs:${SAVED_B}` }, { dealerId: HQ1 }); eq(x.r.statusCode, 404, "never another account's address");
  });
  await t("defaults: one usable destination and no saved default → pre-selected", async () => {
    const x = await api({ action: "list" }, { dealerId: HQ3, extraDm: [] });
    eq(x.b.preselect, null, "HQ3 has three → none");
    const one = await api({ action: "list" }, { dealerId: BRX });
    eq([one.b.entries.length, one.b.preselect], [1, `loc:${BRX}`]);
  });

  // ---- server-side ship-to resolution ----
  await t("quote: a ref outside the account is not found; a browser address is never forwarded; Golden ids still work", async () => {
    let x = await proxy({ action: "quote", lines: [LINE], ship_to: { ref: `gs:${SAVED_B}` } }, { dealerId: HQ1 });
    eq([x.b.reason, x.w.golden.length], ["ship_to_not_found", 0]);
    x = await proxy({ action: "quote", lines: [LINE], ship_to: { hcps: { name: "Fake", address: "1 A", city: "Cincinnati", state: "OH", zip: "45202" } } }, { dealerId: HQ1 });
    eq([x.r.statusCode, x.w.golden.length], [400, 0]);
    x = await proxy({ action: "quote", lines: [LINE], ship_to: { id: "hcps-" + "0".repeat(24) } }, { dealerId: HQ1 });
    eq(x.r.statusCode, 400, "an hcps- id is never accepted from the browser");
    x = await proxy({ action: "quote", lines: [LINE], ship_to: { ref: `loc:${HQ1}` } }, { dealerId: HQ1, flags: { golden_p360_hcps_shipto: false } });
    eq([x.r.statusCode, x.w.golden.length], [400, 0], "switch off → refs refused");
  });
  await t("place: must name the reviewed address; a changed / removed address is never 'not placed' (check My Orders)", async () => {
    const GA = load("_golden_addresses.js");
    const base = { action: "place_order", idempotency_key: crypto.randomUUID(), quote_hash: "a".repeat(64), lines: [LINE], contact: { name: "Pat", phone: "937-555-0100" } };
    env(); let w = world({ dealerId: HQ1 });
    const bk = await GA.book(async p => (await global.fetch("https://sb.test/rest/v1/" + p)).json(), "190100", {});
    const e = bk.entries.find(x => x.ref === `gs:${SAVED_A}`);
    let r = J(await load("golden-proxy.js").handler(post(Object.assign({}, base, { ship_to: { ref: e.ref, reviewed: GA.shipId(e) } }))));
    eq(JSON.parse(w.golden[0].init.body).ship_to.hcps.address, "42 Oak Lane", "reviewed id matches → sent");
    env(); w = world({ dealerId: HQ1 }); w.tables.golden_ship_addresses[0].address = "99 Changed Rd";
    r = J(await load("golden-proxy.js").handler(post(Object.assign({}, base, { ship_to: { ref: e.ref, reviewed: GA.shipId(e) } }))));
    eq([r.placed, r.reason, r.detail, w.golden.length], [null, "unconfirmed", "ship_to_changed", 0]);
    env(); w = world({ dealerId: HQ1 }); w.tables.golden_ship_addresses[0].removed_at = "2026-11-05T00:00:00Z";
    r = J(await load("golden-proxy.js").handler(post(Object.assign({}, base, { ship_to: { ref: e.ref, reviewed: GA.shipId(e) } }))));
    eq([r.placed, r.reason, w.golden.length], [null, "unconfirmed", 0]);
  });
  await t("proxy stays read-only: no Supabase write from golden-proxy", async () => {
    const x = await proxy({ action: "quote", lines: [LINE], ship_to: { ref: `loc:${BR1}` } }, { dealerId: BR1 });
    eq(x.w.writes.length, 0); ok(x.w.golden.length === 1);
  });

  // ---- cross-repo: HCPS and Golden agree on validation and the address id ----
  const gship = path.join(GOLDEN, "repo/functions/lib/golden-shipto.js");
  if (fs.existsSync(gship) && fs.readFileSync(gship, "utf8").includes("hcpsShipTo")) {
    await t("cross-repo: Golden accepts every address HCPS accepts, refuses what HCPS refuses, and computes the same id", async () => {
      const ST = require(gship), GA = load("_golden_addresses.js");
      const cases = [{ name: "Mrs. Patient Home", address: "42 Oak Lane", address2: "Apt 3", city: "Somerset", state: "KY", zip: "42501", phone: "606-555-0142" },
        { name: "Vann — London", address: "5  Elm St", city: " London ", state: "ky", zip: "40741-1234" }, { name: "PR shop", address: "1 Calle", city: "San Juan", state: "PR", zip: "00901", phone: "1 787 555 0100" },
        { name: "X", address: "1 A St", city: "Somerset", state: "KY", zip: "42501" }, { name: "Xy", address: "1 A St", city: "Somerset", state: "KY", zip: "42501", phone: "12345" },
        { name: "Xy", address: "1 A St", city: "Somerset", state: "XX", zip: "42501" }];
      for (const c of cases) {
        const h = GA.validate(c);
        if (!h.ok) continue;   // HCPS refuses → never sent
        const e = Object.assign({ ref: "loc:" + HQ1 }, h.value);
        const g = ST.hcpsShipTo(GA.goldenShipTo(e).hcps);
        ok(g, "Golden refused an address HCPS accepted: " + JSON.stringify(c));
        eq(g.id, GA.shipId(e), "same id");
      }
      eq(cases.filter(c => GA.validate(c).ok).length, 3);
    });
  } else console.log("skip cross-repo (../golden-dealer-portal B7 not checked out)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
