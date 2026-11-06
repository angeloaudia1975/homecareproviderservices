// C3-07 Stage 4 — SAVED CUSTOMER QUOTES: save, reopen, print / PDF and email a dealer-branded customer quote
// (owner directive 2026-11-05; pricing choices D3; locations D2).
//
//   POST + Bearer <dealer JWT>:
//     {action:"quote_list"}                                       -> {ok, quotes:[…]}            (newest first, ≤ 200)
//     {action:"quote_get", id}                                    -> {ok, quote}
//     {action:"quote_save", id?, updated_at?, header:{…}, lines:[…]}  -> {ok, quote}           (id + updated_at = edit; a stale edit → 409)
//     {action:"quote_delete", id}                                 -> {ok}
//     {action:"quote_render", id? | header+lines}                 -> {ok, html}                  (print / Save as PDF; sends nothing)
//     {action:"quote_email", id, to, message?}                    -> {ok, sent_to}               (saved quotes only; limits below)
//     {action:"default_retail", manufacturer, code}               -> {ok, price, label, source}   (official MSRP or HCPS calculated retail)
//
// PRICES: each line's customer price comes from its basis, resolved HERE on HCPS's records (_quote_doc.js): verified MSRP,
// the dealer's saved retail price, or a one-time price. A dealer cost, tier, contract price or MAP is never read.
// BRANDING: the dealer's name, address, phone, email, website and logo come from HCPS's own dealer record — never the request.
// EMAIL: one recipient per send, reply-to = the signed-in dealer user's own address, limits per dealer / recipient recorded
// atomically before sending (_send_limit.js, same rules as brochures), and only a SAVED quote can be sent (what was sent
// is on record). Strict reads: a store that can't be read answers 503 — never a quote with silently missing prices.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE, RESEND_API_KEY, HCPS_MAIL_FROM.

const AC = require("./_account_center.js");
const DOC = require("./_quote_doc.js");
const GR = require("./_golden_retail.js");
const RP = require("./_retail_price.js");
const { flags: readFlags } = require("./_flags.js");
const SEND = require("./_send_limit.js");
const SC = require("./_storefront_catalog.js");
const PR = require("./_pricing.js");
const ORDERING_BASE = (process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app").replace(/\/+$/, "");
const FILES = PR.remoteFiles(ORDERING_BASE);
const CATALOG_FILE = { "ohio-medical": "gce" };
async function sbAllQ(base) { let from = 0, out = []; for (;;) { const rows = await sb("GET", `${base}&limit=1000&offset=${from}`); out = out.concat(rows || []); if (!rows || rows.length < 1000) return out; from += 1000; } }
const DEPS = () => ({ sb, sbAll: sbAllQ, catalogFile: (slug) => FILES.catalogFile(CATALOG_FILE[slug] || slug), contentFile: FILES.contentFile });
/* C3-07 owner directive 2026-11-06 15:23 CT: the customer's default retail for one line — official MSRP, else HCPS
   calculated retail (2 × STANDARD dealer cost) when the line's advertising rules allow it. One catalog read per line. */
async function defaultsFor(mfrs) {
  const setting = await sb("GET", "app_settings?key=eq.advertising_policies&select=value").then((r) => (r && r[0] && r[0].value) || null);
  const out = new Map(), list = [...new Set(mfrs)].filter((m) => m !== "golden-technologies" && m !== "golden");
  /* review fix: lines read 4 at a time (each is one catalog file + its layers), never one after another */
  for (let i = 0; i < list.length; i += 4) {
    const part = await Promise.all(list.slice(i, i + 4).map((m) => SC.lineDefaults(DEPS(), m, { setting }).then((r) => [m, r.items])));
    for (const [m, items] of part) out.set(m, items);
  }
  return out;
}
const crypto = require("crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const MAIL_FROM_ADDR = (String(process.env.HCPS_MAIL_FROM || "orders@homecareproviderservices.us").match(/<([^>]+)>/) || [null, process.env.HCPS_MAIL_FROM || "orders@homecareproviderservices.us"])[1];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" };
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;   // one plain address — no display name / brackets (the send limit counts real recipients)
const MISSING = (e) => { const m = String(e && e.message); return /PGRST205|42P01/.test(m) && /dealer_saved_quotes/.test(m); };
const NOT_YET = "Saved quotes open shortly.";
const SEL = "id,dealer_id,location_id,quote_no,title,customer_name,customer_email,customer_phone,valid_for,notes,lines,status,sent_count,sent_at,created_at,updated_at";

async function sb(method, path, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function sbOpt(path) { try { return await sb("GET", path); } catch (e) { if (/42703|PGRST204/.test(String(e.message))) return null; throw e; } }
async function dealerFromToken(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, ""); if (!tok) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
  if (!ur.ok) return null;
  const u = await ur.json();
  const rows = await sb("GET", `dealer_users?uid=eq.${enc(u.id)}&select=status,dealer_id,email`);
  const du = rows && rows[0];
  if (!du || du.status !== "approved" || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, email: String(du.email || u.email || "").trim(), uid: u.id };
}
function newQuoteNo(now) {
  const d = now || new Date();
  let ymd;   // the dealer's day (Chicago), the same date the quote prints
  try { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "2-digit", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value])); ymd = p.year + p.month + p.day; }
  catch (e) { ymd = String(d.getUTCFullYear() % 100).padStart(2, "0") + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); }
  const A = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; const b = crypto.randomBytes(4);
  return `Q${ymd}-${[...b].map((x) => A[x % A.length]).join("")}`;
}
const pub = (q, names) => q && ({ id: q.id, quote_no: q.quote_no, location_id: q.location_id, location_name: (names && names.get(String(q.location_id))) || "",
  title: q.title || "", customer_name: q.customer_name || "", customer_email: q.customer_email || "", customer_phone: q.customer_phone || "",
  valid_for: q.valid_for || "30 days", notes: q.notes || "", lines: Array.isArray(q.lines) ? q.lines : [], status: q.status, sent_count: q.sent_count || 0,
  sent_at: q.sent_at, created_at: q.created_at, updated_at: q.updated_at });

/* Price lookups for a set of lines, read in batches (strict: a failed read throws → 503). */
async function priceLookups(owner, locationId, lines) {
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
  const msrpLines = lines.filter((l) => l.basis === "msrp" && !l.upgrade && l.mfr !== "golden-technologies" && l.mfr !== "golden");
  const retailLines = lines.filter((l) => l.basis === "retail");
  const msrp = new Map(), retail = new Map();
  if (msrpLines.length) {   /* official MSRP, else HCPS calculated retail (labelled "Retail price" on the quote) */
    const defs = await defaultsFor(msrpLines.map((l) => l.mfr));
    for (const l of msrpLines) { const d = (defs.get(l.mfr) || new Map()).get(String(l.sku)); msrp.set(l.mfr + "|" + l.sku, d && d.price != null ? { price: d.price, calc: d.source === "calculated" } : null); }
  }
  if (retailLines.length) {
    const codes = [...new Set(retailLines.map((l) => l.code))].map((c) => `"${String(c).replace(/[\\"]/g, "")}"`).map(enc).join(",");
    const rows = await sb("GET", `dealer_retail_prices?dealer_id=eq.${enc(owner)}&code=in.(${codes})&select=manufacturer,code,location_id,price`);
    for (const r of rows || []) {   // the location's own price wins over the company default
      const key = r.manufacturer + "|" + r.code, own = String(r.location_id || "") === String(locationId);
      if (r.location_id == null && !retail.has(key)) retail.set(key, num(r.price));
      if (own) retail.set(key, num(r.price));
    }
  }
  /* Golden (C3-07 P4): Golden's MSRP for the item / configuration, else HCPS calculated retail — read from Golden on the
     server for THIS location, once per distinct configuration; a Golden read that fails prints "Price on request". */
  const goldenLines = lines.filter((l) => l.basis === "msrp" && (l.mfr === "golden-technologies" || l.mfr === "golden"));
  const golden = new Map();
  if (goldenLines.length) {
    const sbGet = (p) => sb("GET", p);
    const [f, pset] = await Promise.all([readFlags(sbGet), sb("GET", "app_settings?key=eq.advertising_policies&select=value")]);
    const pol = RP.policiesFrom(pset && pset[0] && pset[0].value, { "golden-technologies": "map" })["golden-technologies"];
    const ctx = {};   // one gate check + one catalog read for the whole quote
    for (const code of [...new Set(goldenLines.map((l) => l.code))].slice(0, 30)) {
      try { golden.set(code, await GR.retailFor(sbGet, locationId, code, f, pol, ctx)); } catch (e) { console.error("golden retail failed", e && e.message); golden.set(code, null); }
    }
  }
  return { msrp: async (m, s) => msrp.get(m + "|" + s) ?? null, retail: async (m, c) => retail.get(m + "|" + c) ?? null, golden: async (c) => golden.get(c) || null };
}
async function dealerBrand(did) {
  const d = await sb("GET", `dealers?id=eq.${enc(did)}&select=id,parent_id,business_name,address,city,state,zip,phone,email`);
  const self = d && d[0]; if (!self) return null;
  for (const col of ["website", "logo_url"]) { const r = await sbOpt(`dealers?id=eq.${enc(did)}&select=${col}`); self[col] = (r && r[0] && r[0][col]) || null; }
  if (!self.logo_url && self.parent_id) { const r = await sbOpt(`dealers?id=eq.${enc(self.parent_id)}&select=logo_url`); self.logo_url = (r && r[0] && r[0].logo_url) || null; }
  return self;
}
function today(tz) { try { return new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "long", day: "numeric" }); } catch (e) { return new Date().toISOString().slice(0, 10); } }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: "not configured" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "bad JSON" }); }
  let who; try { who = await dealerFromToken(event); } catch (e) { return json(503, { ok: false, error: "Please try again in a moment." }); }
  if (!who) return json(401, { ok: false, error: "Please sign in again." });
  const did = who.dealer_id;

  // Which locations' quotes this login may see / change (D2) — the same rule as Account Center and retail prices.
  let visible, self;
  try {
    const d = await sb("GET", `dealers?id=eq.${enc(did)}&select=id,parent_id,business_name`); self = d && d[0];
    if (!self) return json(404, { ok: false, error: "Account not found." });
    const root = self.parent_id || self.id;
    const fq = `dealers?or=(id.eq.${enc(root)},parent_id.eq.${enc(root)})&select=id,parent_id,business_name`;
    let family = await sbOpt(fq + ",active&limit=200"); if (family == null) family = await sb("GET", fq + "&limit=200");
    family = (family || []).filter((x) => x.active !== false || String(x.id) === String(did));   // closed locations are not listed (the login's own always is)
    let scopeRow = null;
    try { const s = await sb("GET", `dealer_user_scope?uid=eq.${enc(who.uid)}&select=scope,locations`); scopeRow = (s && s[0]) || null; }
    catch (e) { if (!/PGRST205|42P01/.test(String(e.message))) throw e; }
    visible = AC.visibleLocations(did, family, scopeRow);
  } catch (e) { console.error("quote scope read failed", e && e.message); return json(503, { ok: false, error: "Your quotes could not be loaded just now — please try again." }); }
  const headOffice = !self.parent_id;
  const owner = String(self.parent_id || self.id);
  const names = new Map(visible.map((v) => [String(v.id), v.business_name || ""]));
  const mayRead = (loc) => names.has(String(loc));
  const mayWrite = (loc) => mayRead(loc) && (headOffice || String(loc) === String(did));
  const by = who.email || "dealer";
  const load = async (id) => {
    if (!UUID.test(String(id || ""))) return { status: 404, error: "That quote isn't available." };
    const r = await sb("GET", `dealer_saved_quotes?id=eq.${enc(id)}&dealer_id=eq.${enc(owner)}&select=${SEL}`);
    const q = r && r[0]; if (!q || !mayRead(q.location_id)) return { status: 404, error: "That quote isn't available." };
    return { q };
  };

  try {
    /* C3-07 2026-11-06: a brochure's default customer price, read on the server for the signed-in dealer (brochure.js calls
       this server-to-server): official MSRP, else HCPS calculated retail under the line's advertising rules. Never the cost. */
    if (b.action === "default_retail") {
      /* one {manufacturer, code} (brochures) or items:[…] ≤ 500 (My Retail Prices / quote builder); only lines this dealer's
         company is authorized for, never Golden (its own rule), never a hidden or discontinued product (review fix) */
      const ask = (Array.isArray(b.items) ? b.items.slice(0, 500) : [{ manufacturer: b.manufacturer, code: b.code }])
        .map((x) => ({ m: String((x && x.manufacturer) || "").toLowerCase(), code: String((x && x.code) || "").trim() }))
        .filter((x) => /^[a-z0-9-]{2,60}$/.test(x.m) && x.code && x.code.length <= 60 && !/\|u=/.test(x.code) && x.m !== "golden-technologies" && x.m !== "golden");
      const fam = [...names.keys()].concat([owner]).map(enc).join(",");
      const dm = ask.length ? await sb("GET", `dealer_manufacturers?dealer_id=in.(${fam})&active=eq.true&select=manufacturer`) : [];
      const allowed = new Set((dm || []).map((r) => r.manufacturer));
      const defs = await defaultsFor(ask.filter((x) => allowed.has(x.m)).map((x) => x.m));
      const items = ask.map((x) => { const d = allowed.has(x.m) ? (defs.get(x.m) || new Map()).get(x.code) : null;
        return { manufacturer: x.m, code: x.code, price: d && d.price != null ? d.price : null, label: d && d.price != null ? d.label : null, source: d ? d.source : "none" }; });
      if (Array.isArray(b.items)) return json(200, { ok: true, items });
      const one = items[0] || { price: null, label: null, source: "none" };
      return json(200, { ok: true, price: one.price, label: one.label, source: one.source });
    }
    if (b.action === "quote_list") {
      const locs = [...names.keys()].map(enc).join(",");
      const rows = await sb("GET", `dealer_saved_quotes?dealer_id=eq.${enc(owner)}&location_id=in.(${locs})&select=${SEL}&order=updated_at.desc&limit=200`);
      return json(200, { ok: true, head_office: headOffice, quotes: (rows || []).map((q) => Object.assign(pub(q, names), { lines: undefined, line_count: Array.isArray(q.lines) ? q.lines.length : 0 })) });
    }
    if (b.action === "quote_get") {
      const L = await load(b.id); if (L.error) return json(L.status, { ok: false, error: L.error });
      /* the saved-retail prices that apply at the QUOTE's location (a head office opening a branch quote sees what that
         branch's document will print, not its own company price) */
      const c = DOC.cleanLines(L.q.lines); const retail = {};
      if (!c.error && c.lines.some((l) => l.basis === "retail")) {
        const lk = await priceLookups(owner, L.q.location_id, c.lines.filter((l) => l.basis === "retail"));
        for (const l of c.lines) if (l.basis === "retail") { const v = await lk.retail(l.mfr, l.code); if (v != null) retail[l.mfr + "|" + l.code] = v; }
      }
      return json(200, { ok: true, quote: pub(L.q, names), can_edit: mayWrite(L.q.location_id), retail_at_location: retail, own_location: String(L.q.location_id) === String(did) });
    }
    if (b.action === "quote_save") {
      const h = DOC.cleanHeader(b.header); if (h.error) return json(400, { ok: false, error: h.error });
      const c = DOC.cleanLines(b.lines); if (c.error) return json(400, { ok: false, error: c.error });
      const lines = c.lines.map((l) => ({ mfr: l.mfr, code: l.code, sku: l.sku, name: l.name, option: l.option, mfrName: l.mfrName, qty: l.qty, basis: l.basis, unit: l.unit, image: l.image }));
      const at = new Date().toISOString();
      const row = Object.assign({}, h.header, { lines, updated_by: by, updated_at: at });
      for (const k of ["title", "customer_name", "customer_email", "customer_phone", "notes"]) if (!row[k]) row[k] = null;
      if (b.id) {
        const L = await load(b.id); if (L.error) return json(L.status, { ok: false, error: L.error });
        if (!mayWrite(L.q.location_id)) return json(403, { ok: false, error: "You can't change that location's quotes." });
        if (!b.updated_at) return json(400, { ok: false, error: "Reload the quote before saving." });
        const up = await sb("PATCH", `dealer_saved_quotes?id=eq.${enc(b.id)}&dealer_id=eq.${enc(owner)}&updated_at=eq.${enc(b.updated_at)}`, row, { Prefer: "return=representation" });
        if (!(up && up.length)) return json(409, { ok: false, error: "This quote was changed somewhere else — reopen it to see the latest version." });
        return json(200, { ok: true, quote: pub(up[0], names) });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ins = await sb("POST", "dealer_saved_quotes", Object.assign({ id: require("crypto").randomUUID(), dealer_id: owner, location_id: did, quote_no: newQuoteNo(), status: "draft", created_by: by, created_at: at }, row), { Prefer: "return=representation" });
          return json(200, { ok: true, quote: pub(ins && ins[0], names) });
        } catch (e) { if (e.status === 409 && attempt < 2) continue; throw e; }   // a quote number collision: draw another
      }
      return json(503, { ok: false, error: "That could not be completed just now — please try again." });
    }
    if (b.action === "quote_delete") {
      const L = await load(b.id); if (L.error) return json(L.status, { ok: false, error: L.error });
      if (!mayWrite(L.q.location_id)) return json(403, { ok: false, error: "You can't delete that location's quotes." });
      await sb("DELETE", `dealer_saved_quotes?id=eq.${enc(b.id)}&dealer_id=eq.${enc(owner)}`, null, { Prefer: "return=minimal" });
      return json(200, { ok: true });
    }
    if (b.action === "quote_render" || b.action === "quote_email") {
      let header, lines, quote_no = "", locationId = did, saved = null;
      if (b.id) {
        const L = await load(b.id); if (L.error) return json(L.status, { ok: false, error: L.error });
        saved = L.q; quote_no = saved.quote_no; locationId = saved.location_id;
        header = DOC.cleanHeader(saved).header; const c = DOC.cleanLines(saved.lines); if (c.error) return json(400, { ok: false, error: c.error }); lines = c.lines;
      } else {
        if (b.action === "quote_email") return json(400, { ok: false, error: "Save the quote before emailing it." });
        const h = DOC.cleanHeader(b.header); if (h.error) return json(400, { ok: false, error: h.error }); header = h.header;
        const c = DOC.cleanLines(b.lines); if (c.error) return json(400, { ok: false, error: c.error }); lines = c.lines;
      }
      if (!lines.length) return json(400, { ok: false, error: "Add at least one product." });
      const [brand, priced] = await Promise.all([dealerBrand(locationId), DOC.resolvePrices(lines, await priceLookups(owner, locationId, lines))]);
      if (!brand) return json(404, { ok: false, error: "Account not found." });
      const date = today();
      if (b.action === "quote_render") return json(200, { ok: true, html: DOC.renderQuote({ dealer: brand, header, lines: priced, quote_no, date, forEmail: false }) });

      // ---- email: a saved quote, one recipient, the dealer's own reply-to, limits recorded before sending ----
      if (!mayWrite(saved.location_id)) return json(403, { ok: false, error: "You can't send that location's quotes." });
      const to = String(b.to || "").trim().slice(0, 200);
      if (!EMAIL_RE.test(to)) return json(400, { ok: false, error: "Enter a valid email address." });
      if (!process.env.RESEND_API_KEY) return json(503, { ok: false, error: "Email is not set up on this site yet." });
      const lim = await SEND.reserve({ url: SUPABASE_URL, key: SERVICE_ROLE, dealer_id: owner, kind: "quote", to });   // limits per company, not per branch login
      if (!lim.ok) return json(lim.status || 429, { ok: false, error: lim.error });
      const note = String(b.message || "").slice(0, 2000);
      const html = DOC.renderQuote({ dealer: brand, header, lines: priced, quote_no, date, forEmail: true });
      const intro = note ? `<div style="max-width:8in;margin:0 auto 18px;font-family:Helvetica,Arial,sans-serif;font-size:11pt;color:#1e2732;white-space:pre-wrap">${note.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>` : "";
      const fromName = String(brand.business_name || "Your provider").replace(/["<>\r\n]/g, "").slice(0, 70);
      const subject = `Quote ${quote_no} from ${fromName}`;
      let res;
      try {
        res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: `"${fromName.replace(/["\\]/g, "")} via HCPS" <${MAIL_FROM_ADDR}>`, to: [to], reply_to: EMAIL_RE.test(who.email) ? who.email : undefined, subject, html: html.replace("<body>", () => "<body>" + intro) }) });
      } catch (e) { res = null; }
      if (!res || !res.ok) {
        console.error("quote email refused by the provider", res && res.status);
        await SEND.markFailed({ url: SUPABASE_URL, key: SERVICE_ROLE, id: lim.id });
        return json(502, { ok: false, error: "Could not send that quote — please try again." });
      }
      try {   // what was sent is on the quote's record; a failure here never un-sends the email
        await sb("PATCH", `dealer_saved_quotes?id=eq.${enc(saved.id)}&dealer_id=eq.${enc(owner)}`, { status: "sent", sent_at: new Date().toISOString(), sent_count: (saved.sent_count || 0) + 1, customer_email: saved.customer_email || to }, { Prefer: "return=minimal" });
      } catch (e) { console.error("quote sent but not marked", e && e.message); }
      console.log("quote emailed", JSON.stringify({ dealer_id: did, quote: saved.quote_no, to_domain: to.split("@")[1] || "" }));
      return json(200, { ok: true, sent_to: to });
    }
  } catch (e) {
    if (MISSING(e)) return json(503, { ok: false, error: NOT_YET });
    console.error("quotes failed", e && e.message);
    return json(503, { ok: false, error: "That could not be completed just now — please try again." });
  }
  return json(400, { ok: false, error: "unknown action" });
};
module.exports._newQuoteNo = newQuoteNo;
