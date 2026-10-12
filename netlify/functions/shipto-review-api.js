// Phase C — Ship-To Review (Connect 360 · Sales Data & Analytics). CLAUDE.md §18 "Ship-To Correction & Branch
// Assignment" and Angelo's Phase C decision of 2026-10-11 20:53 CT.
//
// For every REGISTERED order / sales export (MI-1b register, mfr_sources), it reads the stored ORIGINAL file (private
// bucket mfr-sources, SHA-256 re-checked), groups its lines into ORDERS and resolves each order's HCPS branch with the
// shared strict resolver (_shipto.js): verified mappings, saved ZIP assignments, one dealer, a unique ZIP / street.
// Anything else is "needs ship-to review" — never a silent headquarters / first-branch fallback. A person picks the
// branch (and fills in missing ship-to details) on the review screen; Save & Continue stores a VERSIONED correction
// overlay (hcps_mfr_shipto_correct — the file is never changed), optionally remembers a verified mapping, revalidates the
// report and moves to the next order.
//
// It never imports: no monthly_sales, commission, dealer, alias, account-number, rep or Zoho write. A report is "ready"
// only when no order needs review; until then it is "held" as a whole (no partial import, ever). The manual Sales
// Report Import is unchanged (legacy mode, with its preview flags).
//
// Who: president / admin / owner only (Connect 360 staff sign-in, RULE 9). The acting person is ALWAYS the verified
// sign-in, never a request field.
//
//   POST {action:"queue", manufacturer?}                    → registered order exports with their review status
//   POST {action:"report", source_id}                        → the order-level review (orders needing review first)
//   POST {action:"correct", source_id, order_key, dealer_id, scope?, ship_name?, ship_address?, ship_city?, ship_state?,
//         ship_zip?, reason, expected_version, remember?, replace_mapping?, confirm_outside_family?}
//                                                            → saved + revalidated report + the next order to review
//   POST {action:"mappings", manufacturer}                   → verified mappings (active and retired)
//   POST {action:"retire_mapping", mapping_id, reason}
//   POST {action:"dealer_search", q}                         → existing (non-TEST) dealers / branches by name, city, ZIP
//   POST {action:"export", source_id}                        → the corrected report as CSV (original columns + HCPS columns)
//   POST {action:"shadow", manufacturer, period_from?, period_to?}
//                                                            → READ-ONLY: history in monthly_sales re-resolved strictly
const crypto = require("crypto");
const SH = require("./_shipto.js");
const RV = require("./_shipto_review.js");
const RR = require("./_report_rows.js");
const { NAME_FIRST } = require("./_mfr_rules.js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = "mfr-sources";
const ADMIN = new Set(["president", "admin", "owner"]);
const SRC_COLS = "id,manufacturer,kind,title,file_name,file_sha256,storage_path,received_date,report_period_start,report_period_end,status,created_by,created_at";
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const e = encodeURIComponent;
const clean = (v, n) => { const s = v == null ? "" : String(v).trim(); return s ? s.slice(0, n || 300) : ""; };
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

async function sbGet(p) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); }
async function sbGetAll(base, order) {
  const PAGE = 1000; let from = 0, out = [];
  for (;;) { const sep = base.includes("?") ? "&" : "?"; const rows = await sbGet(`${base}${sep}order=${order}&limit=${PAGE}&offset=${from}`);
    out = out.concat(rows); if (rows.length < PAGE) return out; from += PAGE; }
}
async function rpc(fn, p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H(), "content-type": "application/json" }, body: JSON.stringify({ p }) });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch (x) { body = { message: text }; }
  if (r.ok) return { ok: true, body };
  const msg = String((body && body.message) || text || "").slice(0, 500);
  const m = msg.match(/\b(shipto_[a-z_]+|mfr_shipto_guard)\b/);
  return { ok: false, status: r.status, code: m ? m[1] : "database_error", message: msg };
}
async function whoami(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if (!tok) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null; const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if (!email) return null;
    const s = await sbGet(`staff_users?email=eq.${e(email)}&select=email,role,active,name`); const su = s && s[0];
    if (!su || su.active === false) return null;
    return { email, role: su.role || "rep", name: su.name || email };
  } catch (x) { return null; }
}

// Everything the resolver needs for one manufacturer. Strict: an unreadable source of evidence throws (→ 503), it is
// never treated as "no evidence" (which would send every order to review — or worse, hide a mapping).
async function loadContext(slug) {
  const [dealers, accounts, aliases, zm, mappings] = await Promise.all([
    sbGetAll("dealers?select=id,business_name,parent_id,city,state,zip,address,is_test", "id"),
    sbGetAll(`dealer_manufacturers?manufacturer=eq.${e(slug)}&select=dealer_id,account_ref`, "dealer_id"),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id", "alias_norm"),
    sbGet(`app_settings?key=eq.${e("zipmap:" + slug)}&select=value`),
    sbGetAll(`mfr_shipto_mappings?manufacturer=eq.${e(slug)}&select=id,account_ref,ship_key,scope,dealer_id,retired_at,verified_by,verified_at,retired_by,retire_reason`, "id"),
  ]);
  const real = dealers.filter(d => d.is_test !== true);           // a manufacturer report never routes to a TEST dealer
  const matcher = SH.makeMatcher({ dealers: real, accounts, aliases, nameFirst: NAME_FIRST.has(slug) });
  const zipmap = (zm && zm[0] && zm[0].value && typeof zm[0].value === "object") ? zm[0].value : {};
  return { dealers: real, allById: new Map(dealers.map(d => [d.id, d])), matcher, zipmap, mappings, active: mappings.filter(m => !m.retired_at) };
}

// The stored original, re-checked against its SHA-256, read into canonical order rows.
async function readSource(id) {
  const src = (await sbGet(`mfr_sources?id=eq.${parseInt(id, 10) || 0}&select=${SRC_COLS}`))[0];
  if (!src) return { error: [404, { error: "not_found" }] };
  if (src.kind !== "sales_export") return { error: [422, { error: "not_an_order_export", message: "Ship-To review reads registered order / sales exports." }] };
  if (!src.storage_path || !src.file_sha256) return { error: [422, { error: "no_stored_file" }] };
  const fr = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${src.storage_path}`, { headers: H() });
  if (!fr.ok) return { error: [502, { error: "file_unreadable", message: `The stored original could not be read (${fr.status}).` }] };
  const bytes = Buffer.from(await fr.arrayBuffer());
  if (sha256(bytes) !== src.file_sha256) return { error: [409, { error: "file_changed", message: "The stored file does not match the SHA-256 on record — nothing is read from it." }] };
  const fmt = (String(src.storage_path).match(/\.(csv|xlsx|xls)$/) || [])[1];
  if (!fmt) return { error: [422, { error: "unsupported_format" }] };
  let parsed; try { parsed = RR.readOrderRows(bytes, fmt); } catch (x) { return { error: [422, { error: "unreadable_report", message: String(x.message || x).slice(0, 300) }] }; }
  return { src, parsed };
}

async function reviewOf(src, parsed, ctx) {
  const corrections = await sbGetAll(`mfr_shipto_corrections?source_id=eq.${src.id}&select=id,order_key,version,supersedes_id,order_fingerprint,scope,dealer_id,ship_name,ship_address,ship_city,ship_state,ship_zip,reason,actor,created_at`, "id");
  const review = RV.buildReview(parsed.rows, { matcher: ctx.matcher, mappings: ctx.active, zipmap: ctx.zipmap, corrections });
  const nameOf = id => { const d = ctx.allById.get(id); return d ? d.business_name : null; };
  const history = {}; for (const c of corrections) (history[c.order_key] = history[c.order_key] || []).push(c);
  for (const o of review.orders) {
    o.dealer = o.dealer_id ? nameOf(o.dealer_id) : null;
    o.versions = (history[o.order_key] || []).sort((a, b) => b.version - a.version).map(c => ({ ...c, dealer: nameOf(c.dealer_id) }));
    o.current_version = o.versions.length ? o.versions[0].version : 0;
    for (const s of o.suggestions || []) s.name = s.name || nameOf(s.dealer_id);
  }
  return { review, corrections, nameOf };
}
const ORDER = { needs_review: 0, corrected: 1, resolved: 2 };
const summary = (src, rv) => ({ source_id: src.id, manufacturer: src.manufacturer, title: src.title, file_name: src.file_name, status_register: src.status,
  received_date: src.received_date, period: [src.report_period_start, src.report_period_end], review_status: rv.status, counts: rv.counts,
  needs_review_by_reason: rv.needs_review_by_reason, totals: rv.totals });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "cache-control": "no-store" } };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "not_configured" });
  const me = await whoami(event);
  if (!me) return json(401, { error: "sign_in_required" });
  if (!ADMIN.has(me.role)) return json(403, { error: "management_only", message: "Ship-To review is for President / Admin." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (x) { return json(400, { error: "bad_json" }); }
  const actor = "staff:" + me.email;

  try {
    if (b.action === "queue") {
      const mfr = clean(b.manufacturer, 80);
      const srcs = await sbGetAll(`mfr_sources?kind=eq.sales_export&status=in.(received,accepted)${mfr ? `&manufacturer=eq.${e(mfr)}` : ""}&select=${SRC_COLS}`, "id.desc");
      const ctxs = new Map(), out = [];
      for (const s of srcs.slice(0, 60)) {
        const r = await readSource(s.id);
        if (r.error) { out.push({ source_id: s.id, manufacturer: s.manufacturer, title: s.title, file_name: s.file_name, review_status: "unreadable", error: r.error[1].error, message: r.error[1].message || "" }); continue; }
        if (!ctxs.has(s.manufacturer)) ctxs.set(s.manufacturer, await loadContext(s.manufacturer));
        const { review } = await reviewOf(r.src, r.parsed, ctxs.get(s.manufacturer));
        out.push(summary(r.src, review));
      }
      out.sort((a, b2) => (a.review_status === "held" ? 0 : 1) - (b2.review_status === "held" ? 0 : 1) || b2.source_id - a.source_id);
      return json(200, { ok: true, reports: out, held: out.filter(x => x.review_status === "held").length });
    }

    if (b.action === "report" || b.action === "export") {
      const r = await readSource(b.source_id); if (r.error) return json(r.error[0], r.error[1]);
      const ctx = await loadContext(r.src.manufacturer);
      const { review, nameOf } = await reviewOf(r.src, r.parsed, ctx);
      if (b.action === "export") {
        const csv = RV.correctedCsv(r.parsed.headers, r.parsed.rows, review, nameOf);
        return json(200, { ok: true, file_name: String(r.src.file_name || "report").replace(/\.(csv|xlsx|xls)$/i, "") + " — HCPS ship-to corrected.csv", csv });
      }
      review.orders.sort((x, y) => ORDER[x.status] - ORDER[y.status] || String(x.order_key).localeCompare(String(y.order_key), undefined, { numeric: true }));
      return json(200, { ok: true, report: summary(r.src, review), orders: review.orders, headers: r.parsed.headers, map: r.parsed.map });
    }

    if (b.action === "correct") {
      const r = await readSource(b.source_id); if (r.error) return json(r.error[0], r.error[1]);
      const ctx = await loadContext(r.src.manufacturer);
      const { review } = await reviewOf(r.src, r.parsed, ctx);
      const o = review.orders.find(x => x.order_key === String(b.order_key || ""));
      if (!o) return json(404, { error: "order_not_found", message: "That order is not in this report." });
      const dealer = ctx.allById.get(String(b.dealer_id || ""));
      if (!dealer || dealer.is_test === true) return json(422, { error: "shipto_unknown_dealer", message: "Choose an existing HCPS dealer or branch." });
      const inFamily = o.candidates.some(c => c.dealer_id === dealer.id);
      if (!inFamily && b.confirm_outside_family !== true)
        return json(409, { error: "outside_family", message: `${dealer.business_name} is not in the dealer family this account / company matched. Confirm to assign it anyway.`,
          candidates: o.candidates });
      const remember = b.remember === true;
      const p = { source_id: r.src.id, order_key: o.order_key, order_fingerprint: o.fingerprint, reported: o.reported, dealer_id: dealer.id,
        scope: b.scope === "corporate" ? "corporate" : "branch", ship_name: clean(b.ship_name, 200), ship_address: clean(b.ship_address, 300),
        ship_city: clean(b.ship_city, 100), ship_state: clean(b.ship_state, 40), ship_zip: clean(b.ship_zip, 10), reason: clean(b.reason, 500),
        actor, expected_version: b.expected_version == null || b.expected_version === "" ? "" : String(parseInt(b.expected_version, 10)),
        remember, replace_mapping: b.replace_mapping === true,
        mapping_account_ref: SH._internal.nref(o.reported.account_ref), mapping_ship_key: o.ship_key || "" };
      const rr = await rpc("hcps_mfr_shipto_correct", p);
      if (!rr.ok) return json(/shipto_(stale|mapping_conflict)/.test(rr.code) ? 409 : rr.status >= 500 ? 502 : 422, { error: rr.code, message: rr.message });
      const again = await reviewOf(r.src, r.parsed, await loadContext(r.src.manufacturer));   // revalidate (mappings may now resolve other orders)
      const order = again.review.orders.find(x => x.order_key === o.order_key);
      const next = again.review.orders.filter(x => x.status === "needs_review")
        .sort((x, y) => String(x.order_key).localeCompare(String(y.order_key), undefined, { numeric: true }))
        .find(x => String(x.order_key).localeCompare(String(o.order_key), undefined, { numeric: true }) > 0)
        || again.review.orders.find(x => x.status === "needs_review") || null;
      return json(200, { ok: true, saved: rr.body, order, report: summary(r.src, again.review), next_order_key: next ? next.order_key : null });
    }

    if (b.action === "mappings") {
      const mfr = clean(b.manufacturer, 80); if (!mfr) return json(400, { error: "manufacturer_required" });
      const ctx = await loadContext(mfr);
      return json(200, { ok: true, mappings: ctx.mappings.map(m => ({ ...m, dealer: (ctx.allById.get(m.dealer_id) || {}).business_name || null })) });
    }

    if (b.action === "retire_mapping") {
      const reason = clean(b.reason, 500); if (reason.length < 3) return json(422, { error: "shipto_reason_required", message: "Retiring a mapping needs a reason." });
      const rr = await rpc("hcps_mfr_shipto_retire", { mapping_id: String(parseInt(b.mapping_id, 10) || 0), reason, actor });
      if (!rr.ok) return json(rr.status >= 500 ? 502 : 422, { error: rr.code, message: rr.message });
      return json(200, { ok: true, retired: rr.body });
    }

    if (b.action === "dealer_search") {
      const qq = clean(b.q, 80).toUpperCase(); if (qq.length < 2) return json(200, { ok: true, dealers: [] });
      const ds = await sbGetAll("dealers?select=id,business_name,parent_id,city,state,zip,address,is_test", "id");
      const byId = new Map(ds.map(d => [d.id, d]));
      const hits = ds.filter(d => d.is_test !== true && [d.business_name, d.city, d.zip, d.address].some(v => String(v || "").toUpperCase().includes(qq))).slice(0, 25)
        .map(d => ({ dealer_id: d.id, name: d.business_name, branch: !!d.parent_id, parent: d.parent_id ? (byId.get(d.parent_id) || {}).business_name || null : null,
          city: d.city, state: d.state, zip: d.zip, address: d.address }));
      return json(200, { ok: true, dealers: hits });
    }

    if (b.action === "shadow") {
      const mfr = clean(b.manufacturer, 80); if (!mfr) return json(400, { error: "manufacturer_required" });
      const f = clean(b.period_from, 7), t = clean(b.period_to, 7);
      let filt = `monthly_sales?manufacturer=eq.${e(mfr)}`;
      if (/^\d{4}-\d{2}$/.test(f)) filt += `&period=gte.${f}-01`;
      if (/^\d{4}-\d{2}$/.test(t)) filt += `&period=lte.${t}-28`;
      const hist = await sbGetAll(`${filt}&select=id,invoice_no,customer_name,customer_ref,ship_city,ship_state,ship_zip,dealer_id,amount,period,source`, "id");
      const ctx = await loadContext(mfr);
      const res = RV.shadow(hist, { matcher: ctx.matcher, mappings: ctx.active, zipmap: ctx.zipmap });
      const nm = id => id ? ((ctx.allById.get(id) || {}).business_name || id) : null;
      for (const x of res.list) { x.booked_name = nm(x.booked); x.strict_name = nm(x.strict); }
      res.list.sort((a, b2) => ({ different: 0, held: 1, mixed_history: 2, unmatched_history: 3 }[a.outcome] - { different: 0, held: 1, mixed_history: 2, unmatched_history: 3 }[b2.outcome]));
      res.list = res.list.slice(0, 500);
      return json(200, { ok: true, manufacturer: mfr, rows: hist.length, shadow: res, read_only: true });
    }
  } catch (x) {
    return json(503, { error: "unreadable", message: "Ship-To review could not read its data just now: " + String(x.message || x).slice(0, 200) });
  }
  return json(400, { error: "unknown_action" });
};
