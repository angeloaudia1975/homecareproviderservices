/* Owner directive 2026-11-06 20:55 CT — §2 Dealer Manager is the ONLY source of ordering eligibility; §3 no import, sync or
   background job may grant ordering. Real handlers on the in-memory PostgREST fake; synthetic data only.
   node test/entitlements-grid-only.test.js */
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { createWorld, load, call, standardSeed, t, done, BASE } = require("./phase0-mock");
const { computeAccess } = require("../netlify/functions/_access.js");
const AO = require("../netlify/functions/_accountorg.js");
const EI = require("../netlify/functions/_entitlement_impact.js");

const KY = { state: "KY", business_name: "Syn KY Medical", lat: null, golden_status: "None", ovation_access: false };
const row = (w, d, m) => (w.db.dealer_manufacturers || []).find((r) => r.dealer_id === d && r.manufacturer === m);
function seed() {
  return standardSeed({
    dealers: [
      { id: "hq", business_name: "Syn HQ", state: "KY", parent_id: null, active: true },
      { id: "br", business_name: "Syn Branch", state: "KY", parent_id: "hq", active: true },
      { id: "nogrid", business_name: "Syn No Grid", state: "KY", parent_id: null, active: true },
    ],
    dealer_manufacturers: [
      { dealer_id: "hq", manufacturer: "bemis", account_ref: "B-1", active: true },
      { dealer_id: "hq", manufacturer: "dalton", account_ref: null, active: false },
      { dealer_id: "hq", manufacturer: "pedifix", account_ref: "P-9", active: false },
    ],
  });
}
/* the fake answers like PostgREST (sbGet(path) → rows; sbSend(method, path, body, headers)) */
function orgFor(w) {
  const sbGet = async (p) => (await w.fetch(BASE + "/rest/v1/" + p, { method: "GET" })).json();
  const sbSend = async (method, p, body, headers) => { const r = await w.fetch(BASE + "/rest/v1/" + p, { method, headers: headers || {}, body: body == null ? undefined : JSON.stringify(body) }); if (!r.ok) throw new Error("Supabase " + r.status); const tx = await r.text(); return tx ? JSON.parse(tx) : null; };
  return AO(sbGet, sbSend);
}

(async () => {
  await t("§2 computeAccess: grid-only — no grid = no lines; the grid is exactly what shows; no Kentucky Golden prospect by territory", async () => {
    const old = computeAccess(KY, [], []);
    assert.ok(old.available.length > 0, "the old territory fallback (switch off) still exists for comparison");
    assert.equal(old.golden, "Prospect");
    const none = computeAccess(KY, [], [], { gridOnly: true });
    assert.deepEqual([none.your_accounts, none.available, none.golden], [[], [], "None"]);
    const grid = computeAccess(KY, ["bemis"], ["bemis", "access4u", "golden-technologies"], { gridOnly: true });
    assert.deepEqual([grid.your_accounts, grid.available], [["bemis"], ["access4u"]]);
    assert.equal(computeAccess(Object.assign({}, KY, { golden_status: "Account" }), [], [], { gridOnly: true }).golden, "Account", "the stored Golden status stands");
    assert.deepEqual(computeAccess(KY, [], ["ohio-medical"], { gridOnly: true }).available, [], "retired lines never show");
  });
  await t("§2 dealer-auth: the switch decides; an unreadable switch keeps today's rule", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/dealer-auth.js"), "utf8");
    assert.match(src, /flagOn\(\(pp\)=>sb\("GET",pp\),"grid_only_access"\)/);
    assert.match(src, /\{gridOnly\}\);/);
  });
  await t("§3 reports: reconcileAccountRef never turns ordering on — a matched line with ordering off stays off and is suggested", async () => {
    const w = createWorld(seed()); const O = orgFor(w);
    const r1 = await O.reconcileAccountRef("pedifix", "hq", "P-9", { apply: true });
    assert.deepEqual([r1.status, r1.suggest_access, row(w, "hq", "pedifix").active], ["confirmed", true, false]);
    const r2 = await O.reconcileAccountRef("dalton", "hq", "D-5", { apply: true });
    assert.deepEqual([r2.status, row(w, "hq", "dalton").account_ref, row(w, "hq", "dalton").active], ["set", "D-5", false]);
    const r3 = await O.reconcileAccountRef("yuwell", "hq", "Y-1", { apply: true });
    assert.deepEqual([r3.status, r3.suggest_access, row(w, "hq", "yuwell").active], ["set", true, false], "a line with no row is recorded with ordering OFF");
    assert.equal(row(w, "br", "yuwell").active, false, "the branch gets the org number with ordering off");
    const r4 = await O.reconcileAccountRef("corsicana", "hq", "", { apply: true });
    assert.deepEqual([r4.status, row(w, "hq", "corsicana")], ["active_only", undefined], "activity without a number writes nothing");
    assert.equal(row(w, "hq", "bemis").active, true, "an approved line stays approved");
  });
  await t("§3 commission learn / resolve path: propagateAccountRef keeps the ordering state", async () => {
    const w = createWorld(seed()); const O = orgFor(w);
    await O.propagateAccountRef("pedifix", "hq", "P-10");
    assert.deepEqual([row(w, "hq", "pedifix").account_ref, row(w, "hq", "pedifix").active], ["P-10", false]);
    await O.propagateAccountRef("bemis", "hq", "B-2");
    assert.equal(row(w, "hq", "bemis").active, true);
    assert.equal(row(w, "br", "pedifix").active, false);
  });
  await t("§2/§3 Dealer Manager grid save: unticking a line keeps its identifier with ordering off; nothing else re-enables it", async () => {
    const w = createWorld(seed());
    const r = await call(load("dealers-api.js", w), { action: "access", dealer_id: "hq", manufacturers: ["dalton"] }, { token: "pres" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([row(w, "hq", "bemis").account_ref, row(w, "hq", "bemis").active], ["B-1", false], "identifier kept, ordering off");
    assert.deepEqual([row(w, "hq", "pedifix").account_ref, row(w, "hq", "pedifix").active], ["P-9", false]);
    assert.equal(row(w, "hq", "dalton").active, true, "the ticked line is approved");
  });
  await t("§2 territory suggestions write nothing; the bulk pre-fill is retired", async () => {
    const w = createWorld(seed()); const before = JSON.stringify(w.db.dealer_manufacturers);
    const C = load("dealers-api.js", w);
    const r = await call(C, { action: "prefill_access", dealer_id: "nogrid" }, { token: "pres" });
    assert.equal(r.status, 200); assert.equal(r.body.written, 0); assert.ok(r.body.suggested.length > 0);
    assert.equal((await call(C, { action: "prefill_access_all" }, { token: "pres" })).status, 410);
    assert.equal(JSON.stringify(w.db.dealer_manufacturers), before, "nothing written");
  });
  await t("§3 Zoho account sync and staff tools never write active:true", async () => {
    const z = fs.readFileSync(path.join(__dirname, "../netlify/functions/zoho-api.js"), "utf8");
    assert.ok(!/rpc\("propagate_org_account_numbers"/.test(z), "the SQL function that set active=true is no longer called");
    const d = fs.readFileSync(path.join(__dirname, "../netlify/functions/dealers-api.js"), "utf8");
    const dmWrites = d.split("\n").filter((l) => /dealer_manufacturers/.test(l) && /active:true/.test(l));
    assert.deepEqual(dmWrites, [], "no dealer_manufacturers write in dealers-api sets active:true on its own line");
    assert.equal((d.match(/m=>\(\{m,active:true\}\)/g) || []).length, 1, "the Dealer Manager grid save is the one grant");
    assert.ok(!/active: true/.test(fs.readFileSync(path.join(__dirname, "../netlify/functions/_accountorg.js"), "utf8").replace(/fillHeadquartersBlanks[\s\S]*?\n  }\n/, "")), "_accountorg grants only through the HQ grid inheritance");
  });
  await t("§2 impact report: lists dealers relying on territory, with logins and recent orders; writes nothing", async () => {
    const r = EI.build({
      dealers: [{ id: "a", business_name: "Grid Co", state: "KY" }, { id: "b", business_name: "Territory Co", state: "KY" }, { id: "c", business_name: "Test", state: "KY", is_test: true }],
      dms: [{ dealer_id: "a", manufacturer: "bemis", active: true }],
      users: [{ dealer_id: "b", status: "approved" }], orders: [{ dealer_id: "b", manufacturer: "bemis", submitted_at: "2026-10-01" }], sinceIso: "2025-11-06",
    });
    assert.equal(r.summary.dealers, 2, "TEST dealers left out");
    assert.equal(r.summary.territory_only, 1);
    const b = r.affected.find((x) => x.id === "b"); assert.ok(b.vanish.includes("bemis")); assert.equal(b.material, true); assert.equal(b.portal_logins, 1);
    assert.deepEqual(b.ordered_lines_12m, [{ line: "bemis", orders: 1 }]);
    const a = r.affected.find((x) => x.id === "a"); assert.ok(!a || !a.vanish.length, "a grid dealer loses no line");
  });
  done("entitlements (grid-only, imports never grant)");
})();
