// Golden ⇄ HCPS Partner 360 — batch B8 (HCPS side, contract 1.9.0 §4j): every Golden family through golden-proxy —
// scooters / power chairs ("mobility"), their accessories, Passport beds, and freight Golden quotes by hand (oversized
// scooter, 2+ beds). Synthetic data only. Golden prices everything; HCPS forwards only the line fields, never a price,
// and never shows unknown freight as $0. When ../golden-dealer-portal is checked out with B8, a REAL cross-repo round trip
// runs Golden's real quote / validate / place / history code behind this repo's signed client (the B6 harness, verbatim).
//   node test/golden-integration-b8.test.js
"use strict";
const path = require("path"), fs = require("fs");
const B6 = fs.readFileSync(path.join(__dirname, "golden-integration-b6.test.js"), "utf8");
const PRE = B6.split("\n(async () => {")[0].replace(/^"use strict";/m, "");
const H = new Function("require", "__dirname", PRE + "\nreturn { t, eq, ok, env, world, load, post, J, res, SECRET, LOC, D_HQ, HASH, PROD_ON, GOLDEN, FN, crypto, counts: () => ({ pass, fail, skipped }), bump: k => { if (k === 'skip') skipped++; } };")(require, __dirname);
const { t, eq, ok, env, world, load, post, J, res, LOC, HASH, PROD_ON, GOLDEN, FN, crypto, SECRET } = H;
// The B6 cross-repo harness (Golden's real handlers behind this repo's client), verbatim from its test.
const CROSS = B6.slice(B6.indexOf('    const { createMock } = require(path.join(GOLDEN, "repo", "tests", "support", "postgrest-mock.js"));'), B6.indexOf("    const LN = {"));

const MLINE = { kind: "mobility", sku: "GC340E", color: "RED", qty: 1 };
const QM = (over) => Object.assign({ lines: [
  { line: 0, kind: "mobility", sku: "GC340E", name: "Companion HD 3-Wheel", qty: 1, color: "RED", color_name: "Red", unit_price: 1000, line_total: 1000, details: "Color: Red", upgrades: [], in_stock: true, custom: false, item_no: "GC340-RED-VNS-B", item_no_resolved: true },
  { line: 1, kind: "accessory", sku: "MBE-BATT22 *", accessory_id: "MBE-BATT22", for: "GA541D", name: "Battery, 22NF", qty: 2, color: null, color_name: null, unit_price: 50, line_total: 100, details: "", upgrades: [], in_stock: true, custom: false, item_no: "MBE-BATT22 *", item_no_resolved: false },
  { line: 2, kind: "bed", sku: "BD100A-QB", name: "Passport Hi-Low Bed — Queen", qty: 1, size: "QB", config: "set", delivery: "curbside", rural: false, mattress_sku: "MAT100A-QB", color: null, color_name: null, unit_price: 2000, line_total: 2000, details: "Complete Set", upgrades: [], in_stock: true, custom: false, item_no: "BD100A-QB", item_no_resolved: false }],
  totals: { subtotal: 3100, freight_total: 200, sh_total: 93, grand_total: 3393, sh_rate: 0.03, sh_waived: false, split: false, free_freight_units: 4, shipments: [{ group: "all", subtotal: 3100, sh: 93, freight: 200 }] },
  freight: { included: true, note: "n" }, quote_hash: HASH }, over || {});
const QUOTED = { contract_version: "1.9.0", request_id: "req_q", as_of: "x", engine: "0123456789abcdef", sh_terms_checked: true, ordering_enabled: false, quote: QM() };

(async () => {
  await t("quote: mobility / accessory / bed lines go to Golden with only their own fields — never a price", async () => {
    env(); const w = world({ golden: () => res(200, QUOTED) });
    const r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [
      Object.assign({ unit_price: 1, name: "x" }, { kind: "mobility", sku: "gc340e", color: "red", qty: 1 }),
      { kind: "accessory", sku: "mbe-batt22", for: "ga541d", qty: 2, price: 0 },
      { kind: "bed", size: "qb", config: "SET", delivery: "Curbside", qty: 1, dealer_price: 1 }], ship_to: { id: LOC } })));
    eq(r.available, true, JSON.stringify(r));
    eq(JSON.parse(w.golden[0].init.body).lines, [{ kind: "mobility", sku: "GC340E", qty: 1, color: "RED" }, { kind: "accessory", sku: "MBE-BATT22", for: "GA541D", qty: 2 },
      { kind: "bed", size: "QB", config: "set", delivery: "curbside", qty: 1 }]);
    eq(r.quote.lines.map(l => [l.kind, l.sku, l.unit_price]), [["mobility", "GC340E", 1000], ["accessory", "MBE-BATT22 *", 50], ["bed", "BD100A-QB", 2000]]);
    eq([r.quote.lines[2].size, r.quote.lines[2].config, r.quote.lines[2].delivery, r.quote.lines[1].for], ["QB", "set", "curbside", "GA541D"]);
    ok(!("fabric" in r.quote.lines[0]) && !("breakdown" in r.quote.lines[0]), "no chair fields on a scooter line");
  });

  await t("quote: bad lines refused before Golden is called", async () => {
    const bad = [{ kind: "mobility", sku: "XX100", qty: 1 }, { kind: "mobility", sku: "GC340E", color: "R;D", qty: 1 }, { kind: "mobility", sku: "GC340E", qty: 21 },
      { kind: "accessory", sku: "MBA-RBASK", for: "PR510-SME", qty: 1 }, { kind: "accessory", sku: "MBA RBASK", for: "GC340E", qty: 1 },
      { kind: "bed", size: "QB", config: "base", delivery: "wg", qty: 1 }, { kind: "bed", size: "QB", config: "set", delivery: "retailer", rural: true, qty: 1 },
      { kind: "bed", size: "XL", config: "set", delivery: "retailer", qty: 1 }, { kind: "sofa", sku: "GC340E", qty: 1 }];
    for (const l of bad) {
      env(); const w = world({ golden: () => res(200, QUOTED) });
      const r = await load("golden-proxy.js").handler(post({ action: "quote", lines: [l] }));
      eq(r.statusCode, 400, JSON.stringify(l)); eq(w.golden.length, 0);
    }
  });

  await t("quote: Golden-quoted freight is passed on as 'to be quoted' — never as $0, never without Golden's flag", async () => {
    const cfq = QM({ totals: Object.assign({}, QM().totals, { freight_total: 0, freight_quote_required: true, shipments: [{ group: "all", subtotal: 3100, sh: 93, freight: 0, freight_quote: true }] }),
      freight: { included: false, note: "Golden quotes the freight" } });
    env(); world({ golden: () => res(200, Object.assign({}, QUOTED, { quote: cfq })) });
    let r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [MLINE] })));
    eq([r.available, r.quote.totals.freight_quote_required, r.quote.totals.shipments[0].freight_quote, r.quote.freight.included], [true, true, true, false]);
    // "not included" without Golden saying freight is to be quoted = no quote at all
    env(); world({ golden: () => res(200, Object.assign({}, QUOTED, { quote: QM({ freight: { included: false, note: "?" } }) })) });
    r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [MLINE] })));
    eq(r.available, false);
    // the flag without a shipment marked = unreadable, never a guessed total
    env(); world({ golden: () => res(200, Object.assign({}, QUOTED, { quote: QM({ totals: Object.assign({}, QM().totals, { freight_quote_required: true }), freight: { included: false, note: "x" } }) })) });
    r = J(await load("golden-proxy.js").handler(post({ action: "quote", lines: [MLINE] })));
    eq(r.available, false);
  });

  await t("validate_order: the freight acknowledgement is forwarded only when the dealer gave it; Golden's refusal is named", async () => {
    const base = { action: "validate_order", idempotency_key: crypto.randomUUID(), quote_hash: HASH, lines: [MLINE], ship_to: { id: LOC }, contact: { name: "Pat", phone: "937-555-0100" } };
    env(); let w = world(Object.assign({ golden: () => res(409, { error: { code: "freight_quote_ack_required" } }) }, PROD_ON));
    let r = J(await load("golden-proxy.js").handler(post(base)));
    eq([r.valid, r.reason], [false, "freight_quote_ack_required"]);
    ok(!("freight_quote_ack" in JSON.parse(w.golden[0].init.body)));
    env(); w = world(Object.assign({ golden: () => res(409, { error: { code: "freight_quote_ack_required" } }) }, PROD_ON));
    await load("golden-proxy.js").handler(post(Object.assign({}, base, { freight_quote_ack: true })));
    eq(JSON.parse(w.golden[0].init.body).freight_quote_ack, true);
    env(); w = world(PROD_ON);
    r = await load("golden-proxy.js").handler(post(Object.assign({}, base, { freight_quote_ack: "yes" })));
    eq(r.statusCode, 400); eq(w.golden.length, 0);
    // placement refused for want of the acknowledgement: definite, a new attempt
    env(); world(Object.assign({ golden: () => res(409, { error: { code: "freight_quote_ack_required" } }) }, PROD_ON));
    r = J(await load("golden-proxy.js").handler(post(Object.assign({}, base, { action: "place_order" }))));
    eq([r.placed, r.definite, r.reason, r.new_attempt], [false, true, "freight_quote_ack_required", true]);
  });

  await t("config: a scooter / bed order panel — allow-listed, prices only when visible, quantities only when linked", async () => {
    const OPT = { kind: "mobility", sku: "GC340E", name: "Companion HD", category: "Scooters", color_required: true, color_note: null, internal: "LEAK",
      colors: [{ code: "RED", name: "Red", hex: "#C53030", status: "low", qty: 7 }, { code: "B;D", name: "x", status: "in" }], stock: null,
      accessories: [{ id: "MBA-RBASK", description: "Rear Basket", group: "accessory", dealer_price: 40, cost: 1 }], dealer_price: 1000, orderable: true };
    for (const [pv, linked] of [[true, true], [false, false]]) {
      env(); const w = world({ golden: () => res(200, { prices_visible: pv, linked, etag: "e", options: OPT }) });
      const r = J(await load("golden-proxy.js").handler(post({ action: "config", sku: "gc340e", color: "RED", fabric: "silk" })));
      eq(Object.fromEntries(new URL(w.golden[0].u).searchParams), { sku: "GC340E" }, "only the sku is asked");
      eq([r.options.kind, r.options.colors.length, "internal" in r.options], ["mobility", 1, false]);
      eq(["dealer_price" in r.options, "dealer_price" in r.options.accessories[0], "qty" in r.options.colors[0]], [pv, pv, linked]);
      ok(!("cost" in r.options.accessories[0]));
    }
    env(); world({ golden: () => res(200, { prices_visible: true, linked: true, options: { kind: "bed", sku: "BD100A-QB", size: "QB", label: "Queen", name: "Bed",
      configs: [{ key: "set", label: "Set", dealer_price: 2000 }, { key: "base", label: "Base", dealer_price: 1500 }], deliveries: [{ key: "wg", label: "WG", requires: "set", rural_option: 99 }, { key: "x", label: "y" }], accessories: [], orderable: true } }) });
    const b = J(await load("golden-proxy.js").handler(post({ action: "config", sku: "BD100A-QB" })));
    eq([b.options.kind, b.options.configs.length, b.options.deliveries.length, b.options.deliveries[0].rural_option], ["bed", 2, 1, 99]);
  });

  await t("history: Golden's freight status is passed on, nothing else", async () => {
    env(); world({ golden: () => res(200, { prices_visible: true, orders: [{ order_ref: "P1", source: "portal", status: "submitted", placed_on: "2026-11-05", po_number: "PO", so_numbers: [], ship_to: { city: "C", state: "OH" },
      expected_date: null, items: [], tracking: [], lifecycle: [], freight_status: "to_be_quoted" }, { order_ref: "P2", source: "portal", status: "submitted", placed_on: "2026-11-05", po_number: "PO", so_numbers: [], ship_to: { city: "C", state: "OH" },
      expected_date: null, items: [], tracking: [], lifecycle: [], freight_status: "weird" }], next_before: null }), flags: { golden_p360_history: true } });
    const r = J(await load("golden-proxy.js").handler(post({ action: "history" })));
    eq(r.available, true, JSON.stringify(r).slice(0, 200));
    eq(r.orders[0].freight_status, "to_be_quoted"); ok(!("freight_status" in r.orders[1]));
  });

  // ── Real cross-repo round trip: Golden's B8 code behind this repo's client ──
  const golden8 = fs.existsSync(path.join(GOLDEN, "repo", "functions", "lib", "golden-mobility.js"));
  if (!golden8) { H.bump("skip"); console.log("skip  cross-repo B8 round trip (Golden B8 not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: scooter + accessory + bed, and an oversized scooter with Golden-quoted freight, through Golden's real code", async () => {
    const run = new Function("ctx", "with (ctx) { return (async () => {\n" + CROSS + "\n return { call, orders, sent }; })(); }");
    const ctx = Object.assign({}, H, { path, fs, crypto, require, PROD_ON, world, J, res, env, post, load, SECRET, D_HQ: H.D_HQ, LOC, GOLDEN, gFN: path.join(GOLDEN, "repo", "functions") });
    const { call, orders } = await run(ctx);
    const lines = [MLINE, { kind: "accessory", sku: "MBA-RBASK", for: "GC340E", qty: 1 }, { kind: "bed", size: "QB", config: "set", delivery: "curbside", qty: 1 }];
    const q = await call({ action: "quote", lines, ship_to: { id: LOC } });
    eq(q.available, true, JSON.stringify(q).slice(0, 300));
    // Golden's own figures, read from the private Golden checkout at run time (no Golden price is written in this repo)
    const GD = require(path.join(GOLDEN, "repo", "functions", "lib", "golden-mobility-data.json"));
    const FRT = require(path.join(GOLDEN, "repo", "functions", "lib", "golden-freight.js"));
    const gm = GD.models.find(m => m.sku === "GC340E"), qb = GD.beds.find(b => b.size === "QB");
    eq(q.quote.lines.map(l => [l.kind, l.sku, l.unit_price]), [["mobility", "GC340E", gm.card_price], ["accessory", "MBA-RBASK", gm.accessories.find(a => a.id === "MBA-RBASK").price],
      ["bed", "BD100A-QB", qb.base.cost + qb.mattress.cost]]);
    eq(q.quote.totals.freight_total, FRT.UNIT_RATES[1] + FRT.BED_FRT.QB.set.curbside, "1 unit + Queen set curbside, Golden's own schedule");
    ok(!q.quote.totals.freight_quote_required);
    const key = crypto.randomUUID();
    const base = { idempotency_key: key, quote_hash: q.quote.quote_hash, lines, ship_to: { id: LOC }, po_number: "PO-80", contact: { name: "Pat", phone: "937-555-0100", email: "pat@d.example" } };
    const v = await call(Object.assign({ action: "validate_order" }, base));
    eq([v.valid, v.ordering_enabled], [true, true], JSON.stringify(v).slice(0, 300));
    const p = await call(Object.assign({ action: "place_order" }, base));
    eq([p.placed, p.order_ref], [true, "P1661"], JSON.stringify(p).slice(0, 300));
    eq(orders.length, 1); eq(orders[0].items.map(i => i.sku), ["GC340E", "MBA-RBASK", "BD100A-QB"]); eq(orders[0].items[2].isBed, true);
    // an oversized scooter: Golden quotes the freight — acknowledged before it can be placed
    const L2 = [{ kind: "mobility", sku: "GA541D", color: "SIL", qty: 1 }];
    const q2 = await call({ action: "quote", lines: L2, ship_to: { id: LOC } });
    eq([q2.available, q2.quote.totals.freight_quote_required, q2.quote.freight.included], [true, true, false]);
    const b2 = { idempotency_key: crypto.randomUUID(), quote_hash: q2.quote.quote_hash, lines: L2, ship_to: { id: LOC }, po_number: "PO-81", contact: { name: "Pat", phone: "937-555-0100" } };
    const no = await call(Object.assign({ action: "validate_order" }, b2));
    eq([no.valid, no.reason], [false, "freight_quote_ack_required"]);
    const b3 = Object.assign({}, b2, { idempotency_key: crypto.randomUUID(), freight_quote_ack: true });
    const v3 = await call(Object.assign({ action: "validate_order" }, b3));
    eq([v3.valid, v3.order.freight_quote_required], [true, true], JSON.stringify(v3).slice(0, 300));
    const p3 = await call(Object.assign({ action: "place_order" }, b3));
    eq(p3.placed, true); eq(orders.length, 2); ok(/FREIGHT TO BE QUOTED BY GOLDEN/.test(orders[1].notes), "the order desk is told");
    const h = await call({ action: "history" });
    const row = (h.orders || []).find(o => o.order_ref === p3.order_ref);
    eq(row && row.freight_status, "to_be_quoted");
  });

  const c = H.counts();
  console.log(`\n${c.pass} passed, ${c.fail} failed${c.skipped ? ", " + c.skipped + " skipped" : ""}`);
  process.exit(c.fail ? 1 : 0);
})();
