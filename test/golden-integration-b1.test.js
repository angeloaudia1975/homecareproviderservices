// Golden ⇄ HCPS Partner 360 — batch B0 + B1 (HCPS side). Synthetic data only; no network.
//   node test/golden-integration-b1.test.js
// Covers: contract lock + shared signing module, the signed client, golden-proxy (dealer → Golden eligibility),
// golden-links-api (staff proposals), the orders-api Golden guard (HCPS never records a Golden order), the
// separate sign-in secret in federation-api, and — when the Golden repo is checked out beside this one
// (../golden-dealer-portal) — a REAL cross-repo round trip: this repo's client signs, Golden's real gate verifies.
"use strict";
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");
const GOLDEN = process.env.GOLDEN_REPO || path.join(ROOT, "..", "golden-dealer-portal");
let pass = 0, fail = 0, skipped = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, "\n   ", e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e); } };
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((m || "") + " got " + A + " want " + B); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

const VEC = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/contracts/golden-commerce-v1.signing-vectors.json"), "utf8"));
const SECRET = VEC.secret;
const D_HQ = "11111111-2222-4333-8444-555555555555", D_BR = "66666666-2222-4333-8444-555555555555", D_OTHER = "77777777-2222-4333-8444-555555555555";
function load(mod) { Object.keys(require.cache).forEach(k => { if (k.startsWith(FN)) delete require.cache[k]; }); return require(path.join(FN, mod)); }
function env(extra) {
  process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_ROLE = "svc";
  process.env.GOLDEN_P360_KEY_ID = "hcps-p360-test"; process.env.GOLDEN_P360_SECRET = SECRET;
  delete process.env.GOLDEN_API_BASE; delete process.env.GOLDEN_SSO_SECRET; process.env.FEDERATION_SECRET = "TEST-ONLY-federation-secret-0123456789abcdef-01";
  Object.assign(process.env, extra || {});
}
// Fake Supabase + fake Golden. golden(url, init) answers Golden calls; everything else is the Supabase stub.
function world(o) {
  o = o || {};
  const sb = [], golden = [], writes = [];
  const flags = o.flags === undefined ? { golden_p360_catalog: true, golden_p360_links: true, golden_p360_pilot_dealers: [D_HQ] } : o.flags;
  global.fetch = async (url, init) => {
    const u = String(url); init = init || {};
    const res = (status, body) => ({ ok: status < 400, status, text: async () => body == null ? "" : JSON.stringify(body), json: async () => body });
    if (u.startsWith("https://goldenonlineordering.netlify.app/") || u.startsWith("https://golden.test/")) {
      golden.push({ url: u, init });
      if (o.goldenDown) throw new Error("ECONNREFUSED");
      return o.golden ? o.golden(u, init) : res(200, { contract_version: "1.0.0", state: "account", capabilities: { see_prices: true, order: false, history: true }, order_route: null, request_id: "req_x" });
    }
    sb.push({ url: u, method: init.method || "GET", body: init.body });
    if (init.method && init.method !== "GET") { writes.push({ url: u, method: init.method, body: init.body }); return res(201, null); }
    if (/auth\/v1\/user/.test(u)) return o.noUser ? res(401, {}) : res(200, { id: "uid-1", email: o.email || "angelo@example.invalid" });
    if (/staff_users/.test(u)) return res(200, o.staff === undefined ? [{ role: "president", active: true, name: "A" }] : o.staff);
    if (/dealer_users/.test(u)) return res(200, o.dealerUser === undefined ? [{ status: "approved", dealer_id: D_HQ }] : o.dealerUser);
    if (/dealer_preview_tokens/.test(u)) return res(200, o.preview || []);
    if (/app_settings/.test(u)) return res(200, flags == null ? [] : [{ value: flags }]);
    if (/dealers\?id=eq\./.test(u)) { const id = decodeURIComponent(u.match(/id=eq\.([^&]+)/)[1]);
      const all = { [D_HQ]: { id: D_HQ, parent_id: null, hcps_account: "100001", is_test: false }, [D_BR]: { id: D_BR, parent_id: D_HQ, hcps_account: "100001" } };
      return res(200, all[id] ? [all[id]] : []); }
    if (/dealers\?id=in\./.test(u)) return res(200, [{ id: D_HQ, business_name: "Dealer HQ", hcps_account: "100001", parent_id: null, city: "Town", state: "KY", is_test: false },
      { id: D_BR, business_name: "Dealer Branch", hcps_account: "100001", parent_id: D_HQ, city: "Town2", state: "KY", is_test: false }]);
    if (/federation_events/.test(u)) return res(200, [
      { dealer_id: D_HQ, external_dealer_id: "dealer-a", customer_no: "100001", received_at: "2026-11-02T10:00:00Z" },
      { dealer_id: D_HQ, external_dealer_id: "dealer-a", customer_no: "100001", received_at: "2026-11-01T10:00:00Z" },
      { dealer_id: D_BR, external_dealer_id: "dealer-a-br", customer_no: "100009", received_at: "2026-11-01T09:00:00Z" }]);
    if (/golden_dealer_links/.test(u)) return res(200, o.links || []);
    if (/manufacturers\?/.test(u)) return res(200, [{ slug: "golden-technologies", name: "Golden" }, { slug: "bemis", name: "Bemis" }]);
    return res(200, []);
  };
  return { sb, golden, writes };
}
const post = (b, h) => ({ httpMethod: "POST", headers: Object.assign({ authorization: "Bearer jwt" }, h || {}), body: JSON.stringify(b) });
const J = r => JSON.parse(r.body);

(async () => {
  // ── Contract ──────────────────────────────────────────────────────────────
  await t("contract lock pins the shared files in this repo too", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/contracts/golden-commerce-v1.lock.json"), "utf8"));
    const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    eq(sha(path.join(ROOT, "docs/contracts/golden-commerce-v1.md")), lock.files["golden-commerce-v1.md"], "contract md");
    eq(sha(path.join(ROOT, "docs/contracts/golden-commerce-v1.schema.json")), lock.files["golden-commerce-v1.schema.json"], "schema");
    eq(sha(path.join(ROOT, "docs/contracts/golden-commerce-v1.signing-vectors.json")), lock.files["golden-commerce-v1.signing-vectors.json"], "vectors");
    eq(sha(path.join(FN, "_golden_s2s.js")), lock.files["hcps-s2s.js"], "shared signing module");
    eq(sha(path.join(ROOT, "docs/FEDERATED_ARCHITECTURE.md")), lock.files["FEDERATED_ARCHITECTURE.md"], "blueprint");
    ok(/\*\*Version:\*\* 1\.3\.0/.test(fs.readFileSync(path.join(ROOT, "docs/FEDERATED_ARCHITECTURE.md"), "utf8")), "blueprint v1.3.0");
  });
  await t("signing vectors reproduce byte-for-byte with this repo's copy", () => {
    env(); const S = load("_golden_s2s.js");
    for (const v of VEC.vectors) eq(S.sign({ kid: v.kid, secret: SECRET, method: v.method, path: v.path, query: v.query, body: v.body, delegation: v.delegation, ts: v.ts, nonce: v.nonce }), v.expected_headers, v.name);
  });
  await t("no secret value is committed: only the public TEST vector secret appears in docs/contracts", () => {
    const txt = fs.readdirSync(path.join(ROOT, "docs/contracts")).map(f => fs.readFileSync(path.join(ROOT, "docs/contracts", f), "utf8")).join("\n");
    ok(!/GOLDEN_P360_SECRET\s*=\s*\S|HCPS_P360_KEYS\s*=\s*\{/.test(txt), "no assignment of a real secret");
    ok(VEC.secret.startsWith("TEST-ONLY"), "vector secret is marked test-only");
  });

  // ── Signed client ─────────────────────────────────────────────────────────
  await t("client: not configured → no network call", async () => {
    env({ GOLDEN_P360_SECRET: "" }); const w = world(); const GC = load("_golden_client.js");
    const r = await GC.call({ method: "GET", path: "/v1/health" });
    eq(r.configured, false); eq(w.golden.length, 0);
    env({ GOLDEN_P360_SECRET: "short" }); const w2 = world(); eq((await load("_golden_client.js").call({ path: "/v1/health" })).configured, false); eq(w2.golden.length, 0);
  });
  await t("client: signs exactly what it sends; delegation fixed to 90 s and audience; bad paths refused", async () => {
    env(); const w = world(); const GC = load("_golden_client.js"); const S = load("_golden_s2s.js");
    await GC.call({ method: "POST", path: "/v1/identity/assign", query: { b: "2", a: "1" }, body: { x: 1 }, delegation: { sub_dealer: D_HQ, role: "hcps_staff", actor: "s@example.invalid" } });
    const c = w.golden[0]; const u = new URL(c.url);
    eq(u.search, "?a=1&b=2", "sorted query on the wire");
    const v = S.verify({ headers: c.init.headers, method: "POST", path: u.pathname, query: Object.fromEntries(u.searchParams), rawBody: c.init.body, secretFor: () => SECRET });
    ok(v.ok, JSON.stringify(v)); eq(v.delegation.sub_dealer, D_HQ); eq(v.delegation.exp - v.delegation.iat, 90); eq(v.delegation.aud, "golden-commerce-v1");
    eq(c.init.redirect, "error", "never follows a redirect with a signed request");
    let threw = false; try { await GC.call({ path: "/sso" }); } catch (e) { threw = true; } ok(threw, "only /v1 paths");
    threw = false; try { await GC.call({ path: "https://evil.example/v1/x" }); } catch (e) { threw = true; } ok(threw, "no absolute URLs");
  });
  await t("client: network failure → golden_unreachable, never data", async () => {
    env(); world({ goldenDown: true }); const r = await load("_golden_client.js").call({ path: "/v1/health" });
    eq([r.ok, r.status, r.error, r.json], [false, 0, "golden_unreachable", null]);
  });

  // ── golden-proxy ──────────────────────────────────────────────────────────
  await t("proxy: not signed in → 401, Golden never called", async () => {
    env(); const w = world({ noUser: true }); const r = await load("golden-proxy.js").handler(post({ action: "eligibility" }));
    eq(r.statusCode, 401); eq(w.golden.length, 0);
  });
  await t("proxy: a pending (not approved) dealer login → 401, no call", async () => {
    env(); const w = world({ dealerUser: [{ status: "pending", dealer_id: D_HQ }] });
    eq((await load("golden-proxy.js").handler(post({ action: "eligibility" }))).statusCode, 401); eq(w.golden.length, 0);
  });
  await t("proxy: switch off (missing, false, read error) → enabled:false, Golden never called", async () => {
    for (const flags of [null, { golden_p360_catalog: false, golden_p360_pilot_dealers: [D_HQ] }, { golden_p360_catalog: "true", golden_p360_pilot_dealers: [D_HQ] }]) {
      env(); const w = world({ flags }); const j = J(await load("golden-proxy.js").handler(post({ action: "eligibility" })));
      eq([j.ok, j.enabled, j.reason], [true, false, "switched_off"]); eq(w.golden.length, 0);
    }
  });
  await t("proxy: dealer not in the pilot list → enabled:false, no call", async () => {
    env(); const w = world({ flags: { golden_p360_catalog: true, golden_p360_pilot_dealers: [D_OTHER] } });
    eq(J(await load("golden-proxy.js").handler(post({ action: "eligibility" }))).reason, "not_in_pilot"); eq(w.golden.length, 0);
  });
  await t("proxy: HQ dealer → delegation = organisation, role dealer; answer passed through, nothing stored", async () => {
    env(); const w = world(); const S = load("_golden_s2s.js");
    const j = J(await load("golden-proxy.js").handler(post({ action: "eligibility", dealer_id: D_OTHER, sub_dealer: D_OTHER })));
    eq([j.enabled, j.available, j.state], [true, true, "account"]); eq(j.capabilities, { see_prices: true, order: false, history: true });
    const d = S.decodeDelegation(w.golden[0].init.headers["x-hcps-delegation"]);
    eq([d.sub_dealer, d.sub_branch, d.role], [D_HQ, null, "dealer"], "caller-supplied dealer ignored");
    eq(w.writes.length, 0, "proxy writes nothing");
  });
  await t("proxy: branch dealer → sub_dealer = parent, sub_branch = branch, role branch_user", async () => {
    env(); const w = world({ dealerUser: [{ status: "approved", dealer_id: D_BR }] }); const S = load("_golden_s2s.js");
    await load("golden-proxy.js").handler(post({ action: "eligibility" }));
    const d = S.decodeDelegation(w.golden[0].init.headers["x-hcps-delegation"]);
    eq([d.sub_dealer, d.sub_branch, d.role], [D_HQ, D_BR, "branch_user"]);
  });
  await t("proxy: staff preview → staff_preview role and ordering forced off", async () => {
    env(); const w = world({ noUser: true, preview: [{ dealer_id: D_HQ, expires_at: new Date(Date.now() + 60000).toISOString() }],
      golden: () => ({ ok: true, status: 200, json: async () => ({ state: "account", capabilities: { see_prices: true, order: true, history: true }, order_route: "direct" }) }) });
    const j = J(await load("golden-proxy.js").handler(post({ action: "eligibility" }, { authorization: "", "x-hcps-preview": "a".repeat(48) })));
    eq([j.capabilities.order, j.order_route], [false, null]);
    eq(load("_golden_s2s.js").decodeDelegation(w.golden[0].init.headers["x-hcps-delegation"]).role, "staff_preview");
  });
  await t("proxy: Golden error/unreachable → available:false, no guessed state", async () => {
    env(); world({ golden: () => ({ ok: false, status: 503, json: async () => ({ error: { code: "golden_v1_disabled" } }) }) });
    let j = J(await load("golden-proxy.js").handler(post({ action: "eligibility" })));
    eq([j.available, j.reason, j.state], [false, "golden_unavailable", undefined], "Golden's internal code never reaches the browser");
    env(); world({ goldenDown: true }); j = J(await load("golden-proxy.js").handler(post({ action: "eligibility" })));
    eq([j.available, j.reason], [false, "golden_unavailable"]);
    env({ GOLDEN_P360_SECRET: "" }); world(); j = J(await load("golden-proxy.js").handler(post({ action: "eligibility" })));
    eq([j.enabled, j.reason], [false, "golden_not_configured"]);
  });
  await t("proxy: response never carries Golden account data", async () => {
    env(); world({ golden: () => ({ ok: true, status: 200, json: async () => ({ state: "account", capabilities: { see_prices: true, order: false, history: false }, customer_no: "100001", terms: "NET30", golden_dealer_id: "dealer-a" }) }) });
    const raw = (await load("golden-proxy.js").handler(post({ action: "eligibility" }))).body;
    for (const leak of ["100001", "NET30", "dealer-a"]) ok(!raw.includes(leak), "leaked " + leak);
  });

  // ── golden-links-api ──────────────────────────────────────────────────────
  const links = (b, o) => { env(); const w = world(o); return load("golden-links-api.js").handler(post(b)).then(r => ({ r, w, j: J(r) })); };
  await t("links: reps and relations refused; no token refused", async () => {
    eq((await links({ action: "status" }, { staff: [{ role: "rep", active: true }] })).r.statusCode, 403);
    eq((await links({ action: "status" }, { staff: [{ role: "relations", active: true }] })).r.statusCode, 403);
    eq((await links({ action: "status" }, { noUser: true })).r.statusCode, 401);
  });
  await t("links: status reports configuration + Golden health", async () => {
    const { j } = await links({ action: "status" }, { golden: () => ({ ok: true, status: 200, json: async () => ({ capabilities: { eligibility: true } }) }) });
    eq([j.configured, j.golden_reachable, j.switch_on], [true, true, true]);
  });
  await t("links: candidates group Golden events per dealer/account and flag account-number matches", async () => {
    const { j } = await links({ action: "candidates" });
    eq(j.candidates.length, 2);
    const hq = j.candidates.find(c => c.dealer_id === D_HQ); eq([hq.events, hq.account_matches, hq.is_branch], [2, true, false]);
    const br = j.candidates.find(c => c.dealer_id === D_BR); eq([br.account_matches, br.is_branch], [false, true]);
  });
  await t("links: candidates still list accounts before the link table exists; any other read failure still fails", async () => {
    const miss = (re, msg) => (orig => async (u, i) => re.test(String(u)) ? { ok: false, status: 404, json: async () => ({}), text: async () => msg } : orig(u, i));
    env(); world(); global.fetch = miss(/golden_dealer_links/, '{"code":"PGRST205","message":"Could not find the table \'public.golden_dealer_links\' in the schema cache"}')(global.fetch);
    let r = await load("golden-links-api.js").handler(post({ action: "candidates" })); let j = J(r);
    eq([r.statusCode, j.ok, j.links_installed, j.candidates.length, j.candidates[0].link], [200, true, false, 2, null]);
    env(); world(); global.fetch = miss(/golden_dealer_links/, '{"message":"permission denied"}')(global.fetch);
    eq((await load("golden-links-api.js").handler(post({ action: "candidates" }))).statusCode, 500, "other link-table failure is not hidden");
    env(); world(); global.fetch = miss(/federation_events/, '{"code":"PGRST205","message":"Could not find the table \'public.federation_events\'"}')(global.fetch);
    eq((await load("golden-links-api.js").handler(post({ action: "candidates" }))).statusCode, 500, "a missing events table is not hidden");
    const { j: k } = await links({ action: "candidates" }); eq(k.links_installed, true);
  });
  await t("links page: a failed candidates call shows an error, never an empty list", async () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src/admin/golden-links.html"), "utf8");
    ok(/if\(!c\|\|c\.ok!==true\)/.test(html) && /Could not load the Golden accounts/.test(html), "error branch present");
  });
  await t("links: propose refused when the switch is off, for a branch, for a manual guess without a note", async () => {
    let x = await links({ action: "propose", dealer_id: D_HQ, golden_dealer_id: "dealer-a", method: "account_number" }, { flags: { golden_p360_links: false } });
    eq([x.r.statusCode, x.j.error, x.w.golden.length], [503, "switched_off", 0]);
    x = await links({ action: "propose", dealer_id: D_BR, golden_dealer_id: "dealer-a", method: "account_number" });
    eq([x.r.statusCode, x.w.golden.length], [400, 0]);
    x = await links({ action: "propose", dealer_id: D_HQ, golden_dealer_id: "dealer-a", method: "manual" });
    eq([x.r.statusCode, x.w.golden.length], [400, 0]);
  });
  await t("links: propose sends a signed hcps_staff delegation and records the proposal mirror", async () => {
    const x = await links({ action: "propose", dealer_id: D_HQ, golden_dealer_id: "Dealer-A", customer_no: "100001", method: "account_number" },
      { golden: () => ({ ok: true, status: 200, json: async () => ({ result: "proposed", link_id: "dddddddd-0000-4000-8000-000000000001", status: "proposed" }) }) });
    eq([x.r.statusCode, x.j.result], [200, "proposed"]);
    const sent = JSON.parse(x.w.golden[0].init.body);
    eq([sent.golden_dealer_id, sent.hcps_dealer_id, sent.evidence.method], ["dealer-a", D_HQ, "account_number"]);
    const d = load("_golden_s2s.js").decodeDelegation(x.w.golden[0].init.headers["x-hcps-delegation"]);
    eq([d.role, d.sub_dealer, d.actor], ["hcps_staff", D_HQ, "angelo@example.invalid"]);
    const wr = x.w.writes.find(w => /golden_dealer_links/.test(w.url)); ok(wr, "mirror written");
    eq(JSON.parse(wr.body)[0].status, "proposed");
  });
  await t("links: Golden refusal → nothing written", async () => {
    const x = await links({ action: "propose", dealer_id: D_HQ, golden_dealer_id: "dealer-a", method: "account_number" },
      { golden: () => ({ ok: false, status: 409, json: async () => ({ error: { code: "link_conflict", message: "already linked" } }) }) });
    eq([x.r.statusCode, x.j.error, x.w.writes.length], [409, "link_conflict", 0]);
  });
  await t("links: refresh asks Golden as staff_preview and stores Golden's state", async () => {
    const x = await links({ action: "refresh", dealer_id: D_HQ }, { golden: () => ({ ok: true, status: 200, json: async () => ({ state: "none", reason: "no_verified_link", capabilities: { see_prices: false, order: false, history: false } }) }) });
    eq(x.j.state, "not_verified");
    eq(load("_golden_s2s.js").decodeDelegation(x.w.golden[0].init.headers["x-hcps-delegation"]).role, "staff_preview");
    const wr = x.w.writes.find(w => w.method === "PATCH"); ok(wr && !("status" in JSON.parse(wr.body)), "a not-verified answer never marks the mirror verified");
  });

  await t("links: refresh marks ONLY the link Golden names as verified; every other row for the dealer is not verified", async () => {
    const LID = "dddddddd-0000-4000-8000-000000000001";
    const x = await links({ action: "refresh", dealer_id: D_HQ }, { golden: () => ({ ok: true, status: 200, json: async () => ({ state: "account", link_id: LID, capabilities: { see_prices: true, order: false, history: false } }) }) });
    eq(x.j.state, "verified");
    const p = x.w.writes.filter(w => w.method === "PATCH");
    eq(p.length, 2, "two targeted updates");
    ok(/golden_link_id=eq\.dddddddd/.test(p[0].url) && JSON.parse(p[0].body).golden_state === "verified", "named link verified");
    ok(/golden_link_id\.neq\.dddddddd/.test(decodeURIComponent(p[1].url)) && JSON.parse(p[1].body).golden_state === "not_verified", "the others are not");
    ok(p.every(w => !("status" in JSON.parse(w.body))), "status stays HCPS's own record");
  });
  await t("links: a proposal mirror row starts unchecked (golden_state null)", async () => {
    const x = await links({ action: "propose", dealer_id: D_HQ, golden_dealer_id: "dealer-a", method: "account_number" },
      { golden: () => ({ ok: true, status: 200, json: async () => ({ result: "unchanged", link_id: "dddddddd-0000-4000-8000-000000000001", status: "verified" }) }) });
    const row = JSON.parse(x.w.writes.find(w => /golden_dealer_links/.test(w.url)).body)[0];
    eq([row.status, row.golden_state], ["proposed", null], "Golden's word is recorded only by refresh");
  });

  // ── orders-api guard (D6) ─────────────────────────────────────────────────
  await t("orders-api: a Golden order is refused (409) and nothing is written", async () => {
    env(); const w = world(); const OA = load("orders-api.js");
    const r = await OA.handler(post({ action: "create", dealer: {}, orders: [{ manufacturer_slug: "golden-technologies", po: "P1", items: [{ code: "PR511-MED", qty: 1, unit: 1 }], items_subtotal: 1 }] }));
    eq([r.statusCode, J(r).status], [409, "golden_routes_to_golden"]);
    eq(w.writes.filter(x => /\/orders|order_items/.test(x.url)).length, 0, "no order rows");
    const r2 = await OA.handler(post({ action: "create", dealer: {}, orders: [{ manufacturer_slug: "bemis", po: "P2", items: [] }, { manufacturer: "golden", po: "P3", items: [] }] }));
    eq(J(r2).status, "golden_routes_to_golden", "a mixed request is refused whole");
  });

  // ── Sign-in link secret ───────────────────────────────────────────────────
  const sso = async (extra) => {
    env(extra); world();
    global.fetch = (orig => async (u, i) => /partner_dealer_map/.test(String(u)) ? { ok: true, status: 200, json: async () => [{ external_dealer_id: "dealer-a" }], text: async () => "" } : orig(u, i))(global.fetch);
    const r = await load("federation-api.js").handler(post({ action: "golden_sso_link", dealer_id: D_HQ }));
    return J(r);
  };
  await t("sso link: signed with GOLDEN_SSO_SECRET when set, aud golden-sso; legacy secret only as fallback", async () => {
    const NEW = "TEST-ONLY-sso-secret-0123456789abcdef-0123456789";
    let j = await sso({ GOLDEN_SSO_SECRET: NEW });
    ok(j.ok, JSON.stringify(j));
    const tok = new URL(j.url).searchParams.get("t"); const [p, s] = [tok.slice(0, tok.lastIndexOf(".")), tok.slice(tok.lastIndexOf(".") + 1)];
    eq(s, crypto.createHmac("sha256", NEW).update(p, "utf8").digest("hex"), "new secret");
    eq(JSON.parse(Buffer.from(p, "base64url").toString()).aud, "golden-sso");
    j = await sso({});
    const tok2 = new URL(j.url).searchParams.get("t"); const p2 = tok2.slice(0, tok2.lastIndexOf("."));
    eq(tok2.slice(tok2.lastIndexOf(".") + 1), crypto.createHmac("sha256", process.env.FEDERATION_SECRET).update(p2, "utf8").digest("hex"), "legacy fallback");
  });

  // ── Cross-repo: HCPS client → Golden's REAL gate + eligibility ─────────────
  const gFN = path.join(GOLDEN, "repo", "functions");
  if (!fs.existsSync(path.join(gFN, "v1-eligibility.js"))) { skipped++; console.log("skip  cross-repo round trip (Golden repo not checked out at " + GOLDEN + ")"); }
  else await t("cross-repo: this repo's signed request passes Golden's real gate; a forged one does not", async () => {
    env({ GOLDEN_API_BASE: "https://golden.test" });
    process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.GOLDEN_V1_API = "true"; process.env.HCPS_P360_KEYS = JSON.stringify({ "hcps-p360-test": SECRET });
    const fresh = m => { Object.keys(require.cache).forEach(k => { if (k.startsWith(gFN)) delete require.cache[k]; }); return require(path.join(gFN, m)); };
    const gS = fresh("lib/hcps-s2s.js");
    const nonces = new Set();
    const goldenSb = async (u, init) => {
      const res = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b });
      if (/integration_clients/.test(u)) return res([{ kid: "hcps-p360-test", client_id: "hcps-partner360", tenant_id: "hcps", scopes: ["golden:read"], active: true, secret_fingerprint: gS.fingerprint(SECRET) }]);
      if (/rpc\/integration_nonce_claim/.test(u)) { const a = JSON.parse(init.body); const k = a.p_nonce; const fresh1 = !nonces.has(k); nonces.add(k); return res(fresh1); }
      if (/rpc\/integration_audit_log/.test(u)) return res(null);
      if (/dealer_integration_map/.test(u)) return res([{ id: "aaaaaaaa-0000-4000-8000-000000000001", golden_dealer_id: "dealer-a", price_visibility: "dealer", golden_ordering_enabled: false, history_enabled: false }]);
      if (/dealers\?id=eq\.dealer-a/.test(u)) return res([{ id: "dealer-a", active: true, multi_location_enabled: false }]);
      return res([]);
    };
    const handler = fresh("v1-eligibility.js").handler;
    const hcpsWorld = world();
    // Route this repo's outbound Golden call into Golden's real handler (as Netlify would).
    const hcpsFetch = global.fetch;
    global.fetch = async (u, init) => {
      if (String(u).startsWith("https://golden.test/")) {
        const url = new URL(String(u));
        const ev = { httpMethod: init.method, rawUrl: String(u), path: url.pathname, headers: init.headers, queryStringParameters: Object.fromEntries(url.searchParams), body: init.body || "", isBase64Encoded: false };
        const saved = global.fetch; global.fetch = goldenSb;
        try { const r = await handler(ev); return { ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(r.body), text: async () => r.body }; }
        finally { global.fetch = saved; }
      }
      if (/supabase|sb\.test/.test(String(u)) && process.env.SUPABASE_URL === "https://sb.test") return hcpsFetch(u, init);
      return goldenSb(String(u), init);
    };
    const j = J(await load("golden-proxy.js").handler(post({ action: "eligibility" })));
    eq([j.available, j.state, j.capabilities.see_prices], [true, "account", true], "real gate accepted");
    // Forge: wrong secret on HCPS side → Golden refuses with bad_signature.
    process.env.GOLDEN_P360_SECRET = SECRET + "-forged";
    const j2 = J(await load("golden-proxy.js").handler(post({ action: "eligibility" })));
    eq([j2.available, j2.reason], [false, "golden_unavailable"], "refused by Golden; detail stays server-side");
    void hcpsWorld;
  });

  console.log(`\n${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""}`);
  process.exit(fail ? 1 : 0);
})();
