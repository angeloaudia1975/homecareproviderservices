// HCPS Dealer Business Hub — Phase 3: dealer productivity tools.
// Dealer-scoped, gated by the caller's Supabase Auth JWT. Service-role, server-side only.
//
//   POST + Bearer <jwt>, one of:
//     {action:"favorites_list"}                                  -> { favorites:[{manufacturer,code}] }
//     {action:"favorites_toggle", manufacturer, code}           -> { favorited:bool }
//     {action:"branding_get"}                                    -> { logo_url }
//     {action:"branding_set", logo_url}                          -> { ok, logo_url }
//     {action:"pricing_request", manufacturer, code, product,
//             current_price, quantity, competitor_note}          -> { ok }  (stores + emails HCPS)
//
// Tables (see PHASE3 notes for the SQL):
//   favorites(dealer_id uuid, manufacturer text, code text, created_at, PK(dealer_id,manufacturer,code))
//   pricing_requests(id, dealer_id, manufacturer, code, product, current_price, quantity, competitor_note, status, created_at)
//   dealers.logo_url text   (added column; used for portal + quote branding)
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE, RESEND_API_KEY (optional — pricing-request email).

const RETIRED = require("./_retired_lines.js");
const AC = require("./_account_center.js");
const crypto = require("crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function sb(method, path, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return j;
}

// Resolve caller JWT -> approved dealer {dealer_id, email, dealer:{name,hcps_account}}. Mirrors orders-api.
async function dealerFromToken(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, ""); if (!tok) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
  if (!ur.ok) return null;
  const u = await ur.json();
  const rows = await sb("GET", `dealer_users?uid=eq.${u.id}&select=status,dealer_id,email`);
  const du = rows && rows[0];
  if (!du || du.status !== "approved" || !du.dealer_id) return null;
  let dealer = null;
  try { const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(du.dealer_id)}&select=business_name,hcps_account`); if (d && d[0]) dealer = { name: d[0].business_name || "", hcps_account: d[0].hcps_account || "" }; } catch (e) {}
  return { dealer_id: du.dealer_id, email: du.email, dealer, uid: u.id };
}

// A read that may name a column/table this stage's SQL adds: before the SQL runs, answer with the fallback read
// (never an empty result that looks like data). Any other failure throws (strict).
const MISSING = (e) => /42P01|42703|PGRST20[45]|does not exist|Could not find/i.test(String(e && e.message));
async function sbOpt(path, fallbackPath) {
  try { return await sb("GET", path); }
  catch (e) { if (!MISSING(e)) throw e; return fallbackPath ? sb("GET", fallbackPath) : null; }
}
const SUPA_PUBLIC = () => `${SUPABASE_URL}/storage/v1/object/public/dealer-logos/`;

// ---- pricing-request notification (best-effort, transactional) ----
const MAIL_FROM = process.env.HCPS_MAIL_FROM || "HCPS Partner Portal <orders@homecareproviderservices.us>";
const PRICING_TO = process.env.PRICING_REQUEST_TO || process.env.ORDER_TO || "orders@homecareproviderservices.us";
async function sendMail({ to, subject, html, text, reply_to }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error("RESEND_API_KEY not set — skipping pricing-request email:", subject); return { ok: false, skipped: true }; }
  const payload = { from: MAIL_FROM, to: String(to).split(",").map((s) => s.trim()).filter(Boolean), subject, html, text };
  if (reply_to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(reply_to))) payload.reply_to = reply_to;
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { ok: res.ok };
  } catch (e) { return { ok: false }; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)" });
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
    let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }

    const who = await dealerFromToken(event);
    if (!who) return json(200, { ok: false, status: "unauthorized" });
    const did = who.dealer_id;

    // ---- favorites ----
    if (b.action === "favorites_list") {
      let favs = [];
      try { favs = await sb("GET", `favorites?dealer_id=eq.${encodeURIComponent(did)}&select=manufacturer,code&order=created_at.desc`); } catch (e) { favs = []; }
      return json(200, { ok: true, favorites: (favs || []).map((f) => ({ manufacturer: f.manufacturer, code: f.code })) });
    }
    if (b.action === "favorites_toggle") {
      const manufacturer = String(b.manufacturer || "").trim();
      const code = String(b.code || "").trim();
      if (!manufacturer || !code) return json(400, { error: "manufacturer and code required" });
      // is it there?
      let exists = [];
      try { exists = await sb("GET", `favorites?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(manufacturer)}&code=eq.${encodeURIComponent(code)}&select=code`); } catch (e) { exists = []; }
      if (exists && exists.length) {
        try { await sb("DELETE", `favorites?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(manufacturer)}&code=eq.${encodeURIComponent(code)}`, null, { Prefer: "return=minimal" }); } catch (e) {}
        return json(200, { ok: true, favorited: false });
      }
      try { await sb("POST", "favorites", { dealer_id: did, manufacturer, code }, { Prefer: "resolution=merge-duplicates,return=minimal" }); } catch (e) { return json(200, { ok: false, error: "save_failed" }); }
      return json(200, { ok: true, favorited: true });
    }

    // ---- branding ----
    if (b.action === "branding_get") {
      let logo = null;
      try { const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=logo_url,website`); if (d && d[0]) logo = d[0].logo_url || null; } catch (e) {}
      return json(200, { ok: true, logo_url: logo });
    }
    if (b.action === "branding_set") {
      const url = String(b.logo_url || "").trim();
      // Accept an https image URL or a data: URL (small inline logo). Reject anything else.
      if (url && !/^https:\/\//i.test(url) && !/^data:image\//i.test(url)) return json(400, { error: "logo_url must be an https image URL or a data:image URL" });
      try { await sb("PATCH", `dealers?id=eq.${encodeURIComponent(did)}`, { logo_url: url || null }, { Prefer: "return=minimal" }); } catch (e) { return json(200, { ok: false, error: "save_failed (is the logo_url column present?)" }); }
      return json(200, { ok: true, logo_url: url || null });
    }

    // ---- C3-07 Stage 3: Dealer Account Management Center ----
    if (b.action === "account_center") {
      let self, family, contacts, addrs, dms, claims, access, lines, metas, pending, scopeRow;
      try {
        const dsel = "id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,parent_id,golden_status";
        const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=${dsel}`);
        self = d && d[0]; if (!self) return json(404, { ok: false, error: "Account not found." });
        /* Columns that a database may not have yet (website / logo_url / default_ship_key — added by the Stage 3 SQL):
           each read on its own, so one missing column never hides the account (live check 2026-11-05: no logo_url). */
        for (const col of ["website", "logo_url", "default_ship_key"]) {
          const r = await sbOpt(`dealers?id=eq.${encodeURIComponent(did)}&select=${col}`, null);
          self[col] = (r && r[0] && r[0][col]) || null;
        }
        const root = self.parent_id || self.id;
        const fq = `dealers?or=(id.eq.${encodeURIComponent(root)},parent_id.eq.${encodeURIComponent(root)})&select=id,business_name,contact_name,phone,email,address,city,state,zip,parent_id,golden_status`;
        family = await sbOpt(fq + ",active&limit=200", fq + "&limit=200");
        family = (family || []).filter((x) => x.active !== false || String(x.id) === String(did));   // closed locations are not listed (the login's own always is)
        scopeRow = await sbOpt(`dealer_user_scope?uid=eq.${encodeURIComponent(who.uid)}&select=scope,locations`, null);
        scopeRow = (scopeRow && scopeRow[0]) || null;
      } catch (e) { console.error("account center read failed", e && e.message); return json(503, { ok: false, error: "Your account details could not be loaded just now — please try again." }); }
      const visible = AC.visibleLocations(did, family, scopeRow);
      const ids = visible.map((x) => x.id); const inIds = ids.map(encodeURIComponent).join(",");
      try {
        [contacts, addrs, dms, claims, access, lines, metas, pending] = await Promise.all([
          sb("GET", `dealer_contacts?dealer_id=eq.${encodeURIComponent(did)}&select=id,name,title,email,phone&order=name.asc&limit=50`),
          sb("GET", `dealer_addresses?dealer_id=eq.${encodeURIComponent(did)}&select=addr_key,label,address,city,state,zip,pri`),
          sbOpt(`dealer_manufacturers?dealer_id=in.(${inIds})&select=dealer_id,manufacturer,account_ref,active,verified_at,verified_ref`, `dealer_manufacturers?dealer_id=in.(${inIds})&select=dealer_id,manufacturer,account_ref,active`),
          sbOpt(`dealer_account_claims?dealer_id=in.(${inIds})&status=in.(pending,verified)&select=dealer_id,manufacturer,account_ref,status,created_at&order=created_at.asc`, null),
          sb("GET", `dealer_access_requests?dealer_id=in.(${inIds})&status=eq.new&select=dealer_id,manufacturer`),
          sb("GET", `manufacturers?select=slug,name&order=name.asc`),
          sb("GET", `manufacturer_meta?select=slug,active`),
          sb("GET", `dealer_change_requests?dealer_id=eq.${encodeURIComponent(did)}&status=eq.pending&select=created_at,changes&order=created_at.desc&limit=10`),
        ]);
      } catch (e) { console.error("account center read failed", e && e.message); return json(503, { ok: false, error: "Your account details could not be loaded just now — please try again." }); }
      const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug));
      const L = (lines || []).filter((m) => m && m.slug && !RETIRED.isRetiredLine(m.slug) && !off.has(m.slug)).map((m) => ({ slug: m.slug, name: m.name || m.slug }));
      if (!L.some((m) => m.slug === "golden-technologies" || m.slug === "golden")) L.unshift({ slug: "golden-technologies", name: "Golden Technologies" });
      const key = (r) => String(r.dealer_id) + "|" + String(r.manufacturer);
      const dmBy = new Map((dms || []).map((r) => [key(r), r])), acBy = new Set((access || []).map(key));
      const clBy = new Map((claims || []).filter((r) => r.status === "pending").map((r) => [key(r), r]));
      const vcBy = new Map((claims || []).filter((r) => r.status === "verified").map((r) => [key(r), r]));   // newest last wins
      const locations = visible.map((loc) => ({
        id: loc.id, name: loc.business_name || "", city: loc.city || "", state: loc.state || "", is_self: String(loc.id) === String(did),
        /* a head office manages its company's locations (D2): their address and main contact, changed through HCPS approval */
        address: loc.address || "", zip: loc.zip || "", contact_name: loc.contact_name || "", phone: loc.phone || "", email: loc.email || "",
        can_request: String(loc.id) === String(did) || !self.parent_id,
        accounts: L.map((m) => Object.assign({ slug: m.slug, name: m.name }, AC.accountStatus({ slug: m.slug, dm: dmBy.get(loc.id + "|" + m.slug) || null,
          claim: clBy.get(loc.id + "|" + m.slug) || null, verifiedClaim: vcBy.get(loc.id + "|" + m.slug) || null, accessOpen: acBy.has(loc.id + "|" + m.slug), goldenStatus: loc.golden_status }))),
      }));
      const addresses = [{ key: "main", label: "Business address", address: self.address || "", city: self.city || "", state: self.state || "", zip: self.zip || "" }]
        .concat((addrs || []).map((a) => ({ key: a.addr_key, label: a.label || "", address: a.address || "", city: a.city || "", state: a.state || "", zip: a.zip || "" })));
      return json(200, { ok: true,
        company: { business_name: self.business_name || "", hcps_account: self.hcps_account || "", contact_name: self.contact_name || "", email: self.email || "",
          phone: self.phone || "", website: self.website || "", logo_url: self.logo_url || null, default_ship_key: self.default_ship_key || null, head_office: !self.parent_id },
        contacts: (contacts || []).map((c) => ({ id: c.id, name: c.name || "", title: c.title || "", email: c.email || "", phone: c.phone || "" })),
        addresses, locations, pending: (pending || []).map((p) => ({ created_at: p.created_at, changes: p.changes || {} })),
        scope: visible.length > 1 ? "company" : "own" });
    }
    if (b.action === "account_change_request") {
      const v = AC.validateChanges(b.changes);
      if (v.error) return json(400, { ok: false, error: v.error });
      /* C3-07 Stage 3 (D2): a head office may send a change for one of its company's locations it can see; a branch login only
         for itself. The request is filed on the TARGET location, so HCPS's approval applies it there. */
      let target = did;
      if (b.location_id != null && String(b.location_id) !== String(did)) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(b.location_id))) return json(400, { ok: false, error: "Unknown location." });
        let selfRow, fam, scopeRow;
        try {
          const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=id,parent_id`); selfRow = d && d[0];
          if (!selfRow) return json(404, { ok: false, error: "Account not found." });
          const root = selfRow.parent_id || selfRow.id;
          const fq = `dealers?or=(id.eq.${encodeURIComponent(root)},parent_id.eq.${encodeURIComponent(root)})&select=id,business_name,parent_id`;
          fam = await sbOpt(fq + ",active&limit=200", fq + "&limit=200");
          fam = (fam || []).filter((x) => x.active !== false || String(x.id) === String(did));
          scopeRow = await sbOpt(`dealer_user_scope?uid=eq.${encodeURIComponent(who.uid)}&select=scope,locations`, null);
          scopeRow = (scopeRow && scopeRow[0]) || null;
        } catch (e) { return json(503, { ok: false, error: "Your changes could not be sent right now — please try again." }); }
        const vis = AC.visibleLocations(did, fam, scopeRow);
        if (selfRow.parent_id || !vis.some((x) => String(x.id) === String(b.location_id))) return json(403, { ok: false, error: "You can send changes only for your own location." });
        target = String(b.location_id);
      }
      let open;
      try { open = await sb("GET", `dealer_change_requests?dealer_id=eq.${encodeURIComponent(target)}&status=eq.pending&select=id&limit=6`); }
      catch (e) { return json(503, { ok: false, error: "Your changes could not be sent right now — please try again." }); }
      if ((open || []).length >= 5) return json(429, { ok: false, error: "You have 5 changes waiting for HCPS — they'll be reviewed shortly before you can send more." });
      try { await sb("POST", "dealer_change_requests", { dealer_id: target, uid: who.uid, email: who.email, changes: v.changes, status: "pending", created_at: new Date().toISOString() }, { Prefer: "return=minimal" }); }
      catch (e) { console.error("change request not recorded", e && e.message); return json(503, { ok: false, error: "Your changes could not be sent right now — please try again." }); }
      return json(200, { ok: true, message: "Sent to HCPS for approval — your account updates once approved." });
    }
    if (b.action === "default_ship_set") {
      let addrs, self;
      try {
        addrs = await sb("GET", `dealer_addresses?dealer_id=eq.${encodeURIComponent(did)}&select=addr_key`);
        self = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=address`);
      } catch (e) { return json(503, { ok: false, error: "Could not save just now — please try again." }); }
      const keys = ((self && self[0] && self[0].address) ? ["main"] : []).concat((addrs || []).map((a) => a.addr_key).filter(Boolean));
      const k = AC.validDefaultShip(b.key, keys);
      if (!k) return json(400, { ok: false, error: "Choose one of your addresses on file." });
      try { await sb("PATCH", `dealers?id=eq.${encodeURIComponent(did)}`, { default_ship_key: k }, { Prefer: "return=minimal" }); }
      catch (e) { if (MISSING(e)) return json(503, { ok: false, error: "Default ship-to opens shortly." }); return json(503, { ok: false, error: "Could not save just now — please try again." }); }
      return json(200, { ok: true, default_ship_key: k });
    }
    if (b.action === "logo_upload") {
      const raw = String(b.data || "").replace(/^data:image\/(jpeg|png);base64,/i, "");
      if (raw.length > Math.ceil(AC.MAX_LOGO * 4 / 3) + 8 || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) return json(400, { ok: false, error: "The logo must be a JPEG or PNG of 1 MB or less." });
      const buf = Buffer.from(raw, "base64");
      const kind = AC.sniffLogo(buf);
      if (kind.error) return json(400, { ok: false, error: kind.error });
      const sha = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
      const path = `${did}/${sha}.${kind.ext}`;
      let up;
      try {
        up = await fetch(`${SUPABASE_URL}/storage/v1/object/dealer-logos/${path}`, { method: "POST",
          headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "content-type": kind.type, "x-upsert": "false", "cache-control": "max-age=31536000" }, body: buf });
      } catch (e) { return json(503, { ok: false, error: "The logo could not be uploaded just now — please try again." }); }
      if (!up.ok) {
        const t = await up.text().catch(() => "");
        if (!(up.status === 409 || /already exists|Duplicate/i.test(t))) { console.error("logo upload failed", up.status, t.slice(0, 200)); return json(503, { ok: false, error: "The logo could not be uploaded just now — please try again." }); }
      }
      const url = SUPA_PUBLIC() + path;
      let prev = null; try { const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=logo_url`); prev = d && d[0] && d[0].logo_url; } catch (e) {}
      try { await sb("PATCH", `dealers?id=eq.${encodeURIComponent(did)}`, { logo_url: url }, { Prefer: "return=minimal" }); }
      catch (e) { return json(503, { ok: false, error: "The logo was uploaded but could not be saved — please try again." }); }
      /* Keep one logo per dealer: the previous upload (only ever a file in this dealer's own folder) is removed. */
      const own = SUPA_PUBLIC() + did + "/";
      if (prev && prev !== url && prev.startsWith(own) && /^[0-9a-f]{32}\.(jpg|png)$/.test(prev.slice(own.length))) {
        try { await fetch(`${SUPABASE_URL}/storage/v1/object/dealer-logos/${did}/${prev.slice(own.length)}`, { method: "DELETE", headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } }); } catch (e) {}
      }
      return json(200, { ok: true, logo_url: url });
    }
    if (b.action === "account_claim") {
      const slug = String(b.manufacturer || "").trim().toLowerCase();
      if (!/^[a-z0-9-]{2,60}$/.test(slug) || RETIRED.isRetiredLine(slug) || slug === "golden" || slug === "golden-technologies") return json(400, { ok: false, error: "This line can't be added here." });
      const ref = AC.validAccountRef(b.account_ref);
      if (!ref) return json(400, { ok: false, error: "Enter the account number exactly as the manufacturer shows it (letters, numbers, - . / #)." });
      const note = String(b.note || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300) || null;
      let mfr, dm, open, self;
      try {
        const m = await sb("GET", `manufacturers?slug=eq.${encodeURIComponent(slug)}&select=slug,name`); mfr = m && m[0];
        const r = await sb("GET", `dealer_manufacturers?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(slug)}&select=account_ref`); dm = r && r[0];
        open = await sb("GET", `dealer_account_claims?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(slug)}&status=eq.pending&select=id&limit=1`);
        const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=business_name,hcps_account,rep_email`); self = (d && d[0]) || {};
      } catch (e) { if (MISSING(e)) return json(503, { ok: false, error: "Adding account numbers opens shortly." }); return json(503, { ok: false, error: "Could not send just now — please try again." }); }
      if (!mfr) return json(400, { ok: false, error: "This line can't be added here." });
      if (dm && String(dm.account_ref || "").trim().toUpperCase() === ref.toUpperCase()) return json(200, { ok: true, already_on_file: true });
      if ((open || []).length) return json(200, { ok: true, already: true });
      try { await sb("POST", "dealer_account_claims", { dealer_id: did, manufacturer: slug, account_ref: ref, note, status: "pending", submitted_email: who.email || null }, { Prefer: "return=minimal" }); }
      catch (e) { if (/23505|duplicate key/i.test(String(e && e.message))) return json(200, { ok: true, already: true }); return json(503, { ok: false, error: "Could not send just now — please try again." }); }
      const dn = self.business_name || (who.dealer || {}).name || "Dealer";
      const to = ["angelo@homecareproviderservices.us"].concat(self.rep_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(self.rep_email) && !/^angelo@/i.test(self.rep_email) ? [self.rep_email] : []);
      await sendMail({ to: to.join(","), subject: `Manufacturer account to verify — ${dn} — ${mfr.name || slug}`,
        html: `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px"><h2 style="color:#2B4071;margin:0 0 8px">Manufacturer account to verify</h2>
          <p style="font-size:13.5px">${esc(dn)}${self.hcps_account ? " · " + esc(self.hcps_account) : ""} says it has a <b>${esc(mfr.name || slug)}</b> account. Verify it in Connect 360 → Dealer Manager → Account changes. Verifying does not turn on ordering.</p></div>`,
        text: `Manufacturer account to verify\n\n${dn} says it has a ${mfr.name || slug} account. Verify it in Connect 360 → Dealer Manager → Account changes. Verifying does not turn on ordering.`,
        reply_to: who.email }).catch(() => {});
      return json(200, { ok: true, saved: true });
    }

    // ---- volume-pricing request ----
    if (b.action === "pricing_request") {
      const row = {
        dealer_id: did,
        manufacturer: String(b.manufacturer || "").trim() || null,
        code: String(b.code || "").trim() || null,
        product: String(b.product || "").trim() || null,
        current_price: b.current_price != null ? num(b.current_price) : null,
        quantity: b.quantity != null ? Math.round(num(b.quantity)) : null,
        competitor_note: String(b.competitor_note || "").trim() || null,
        status: "new",
      };
      let saved = true;
      try { await sb("POST", "pricing_requests", row, { Prefer: "return=minimal" }); } catch (e) { saved = false; /* table may not exist yet; still email */ }
      const d = who.dealer || {};
      const subject = `Volume pricing request — ${d.name || "Dealer"} — ${row.product || row.code || row.manufacturer || "product"}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
        <h2 style="color:#2B4071;margin:0 0 8px">Volume pricing request</h2>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer</td><td><b>${esc(d.name || "—")}</b>${d.hcps_account ? " · " + esc(d.hcps_account) : ""}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Product</td><td>${esc(row.product || "—")} ${row.code ? "(#" + esc(row.code) + ")" : ""}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Manufacturer</td><td>${esc(row.manufacturer || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Current price</td><td>${row.current_price != null ? "$" + row.current_price : "—"}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Anticipated quantity / volume</td><td>${row.quantity != null ? row.quantity : "—"}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">Competitive context</td><td>${esc(row.competitor_note || "—")}</td></tr>
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin-top:14px">Submitted from the HCPS Dealer Business Hub. Reply to reach the dealer.</p></div>`;
      const text = `Volume pricing request\n\nDealer: ${d.name || "—"} ${d.hcps_account ? "(" + d.hcps_account + ")" : ""}\nProduct: ${row.product || "—"} ${row.code ? "(#" + row.code + ")" : ""}\nManufacturer: ${row.manufacturer || "—"}\nCurrent price: ${row.current_price != null ? "$" + row.current_price : "—"}\nAnticipated quantity: ${row.quantity != null ? row.quantity : "—"}\nCompetitive context: ${row.competitor_note || "—"}`;
      try { await sendMail({ to: PRICING_TO, subject, html, text, reply_to: who.email }); } catch (e) {}
      return json(200, { ok: true, saved });
    }

    // ---- showroom layout (persist the dealer's floor plan) ----
    if (b.action === "showroom_get") {
      let layout = null;
      try { const s = await sb("GET", `showrooms?dealer_id=eq.${encodeURIComponent(did)}&select=layout&limit=1`); if (s && s[0]) layout = s[0].layout || null; } catch (e) {}
      return json(200, { ok: true, layout });
    }
    if (b.action === "showroom_save") {
      const layout = (b.layout && typeof b.layout === "object") ? b.layout : null;
      try { await sb("POST", "showrooms", { dealer_id: did, layout, updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" }); }
      catch (e) { return json(200, { ok: false, error: "save_failed (is the showrooms table present?)" }); }
      return json(200, { ok: true });
    }

    // ---- manufacturer literature request ----
    if (b.action === "literature_request") {
      const manufacturer = String(b.manufacturer || "").trim();
      const items = Array.isArray(b.items) ? b.items.filter((x) => x && x.material && num(x.qty) > 0).map((x) => ({ material: String(x.material).slice(0, 120), qty: Math.round(num(x.qty)) })) : [];
      if (!manufacturer || !items.length) return json(400, { error: "manufacturer and at least one material required" });
      const row = { dealer_id: did, manufacturer, items, ship_to: String(b.ship_to || "").trim() || null, note: String(b.note || "").trim() || null, status: "new" };
      let saved = true;
      try { await sb("POST", "literature_requests", row, { Prefer: "return=minimal" }); } catch (e) { saved = false; }
      const d = who.dealer || {};
      const list = items.map((i) => `${i.qty} × ${esc(i.material)}`).join("<br>");
      const subject = `Literature request — ${d.name || "Dealer"} — ${manufacturer}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
        <h2 style="color:#2B4071;margin:0 0 8px">Manufacturer literature request</h2>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer</td><td><b>${esc(d.name || "—")}</b>${d.hcps_account ? " · " + esc(d.hcps_account) : ""}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Manufacturer</td><td>${esc(manufacturer)}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">Materials</td><td>${list}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Ship to</td><td>${esc(row.ship_to || "—")}</td></tr>
          ${row.note ? `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">Note</td><td>${esc(row.note)}</td></tr>` : ""}
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin-top:14px">Submitted from the HCPS Dealer Business Hub. Reply to reach the dealer.</p></div>`;
      const text = `Literature request\n\nDealer: ${d.name || "—"}\nManufacturer: ${manufacturer}\nMaterials:\n${items.map((i) => `  ${i.qty} x ${i.material}`).join("\n")}\nShip to: ${row.ship_to || "—"}${row.note ? `\nNote: ${row.note}` : ""}`;
      try { await sendMail({ to: PRICING_TO, subject, html, text, reply_to: who.email }); } catch (e) {}
      return json(200, { ok: true, saved });
    }

    // ---- request ordering access to a line the dealer can browse but not order (C3-06 closeout) ----
    /* Records the request and tells HCPS staff. It NEVER grants access, opens an account or changes a price:
       staff review it and, if approved, turn the line on in the dealer's Ordering Access grid. A line the dealer
       already carries, an unknown, switched-off or retired line, Golden (its own platform), or a dealer with an
       ordering grid (it has no browse-only lines) is not requested. One open request per dealer + line. */
    if (b.action === "access_request") {
      const slug = String(b.manufacturer || "").trim().toLowerCase();
      if (!/^[a-z0-9-]{2,60}$/.test(slug)) return json(400, { ok: false, error: "Unknown manufacturer." });
      if (RETIRED.isRetiredLine(slug)) return json(400, { ok: false, error: "This line is not offered." });
      if (slug === "golden" || slug === "golden-technologies") return json(400, { ok: false, error: "Golden Technologies is ordered on the Golden platform." });
      let mfr, rows, self, meta, open;
      try {
        const m = await sb("GET", `manufacturers?slug=eq.${encodeURIComponent(slug)}&select=slug,name`);
        mfr = m && m[0];
        const mm = await sb("GET", `manufacturer_meta?slug=eq.${encodeURIComponent(slug)}&select=active`);
        meta = mm && mm[0];
        rows = await sb("GET", `dealer_manufacturers?dealer_id=eq.${encodeURIComponent(did)}&active=eq.true&select=manufacturer`);
        const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(did)}&select=business_name,hcps_account,contact_name,phone,city,state,rep_email`);
        self = (d && d[0]) || {};
        /* one open request per dealer + line (unique index dealer_access_requests_open_uk); the table is required —
           without a readable record nothing is sent, so the button can never be used to send unlimited email */
        open = await sb("GET", `dealer_access_requests?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(slug)}&status=eq.new&select=id&limit=1`);
      } catch (e) { console.error("access request read failed", e && e.message); return json(503, { ok: false, error: "Your request could not be sent right now — please try again or call HCPS." }); }
      if (!mfr || (meta && meta.active === false)) return json(400, { ok: false, error: "This line is not offered." });
      const carried = (rows || []).map((r) => String(r.manufacturer));
      if (carried.includes(slug)) return json(200, { ok: true, already_carried: true });
      /* Only a dealer that browses by territory (no ordering grid of its own) has browse-only lines; a dealer with a
         grid sees exactly the lines it carries, so it has nothing to request here. */
      if (carried.some((s) => s !== "golden" && s !== "golden-technologies")) return json(400, { ok: false, error: "Ask your HCPS rep about adding this line." });
      if ((open || []).length) return json(200, { ok: true, already: true });
      try {
        await sb("POST", "dealer_access_requests", { dealer_id: did, manufacturer: slug, requested_by: who.email || null, status: "new" }, { Prefer: "return=minimal" });
      } catch (e) {
        if (/23505|duplicate key/i.test(String(e && e.message))) return json(200, { ok: true, already: true });   // a simultaneous request won
        console.error("access request not recorded", e && e.message);
        return json(503, { ok: false, error: "Your request could not be sent right now — please try again or call HCPS." });
      }
      const nm = mfr.name || slug, dn = self.business_name || (who.dealer || {}).name || "Dealer";
      const to = ["angelo@homecareproviderservices.us"].concat(self.rep_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(self.rep_email) && !/^angelo@/i.test(self.rep_email) ? [self.rep_email] : []);
      const where = [self.city, self.state].filter(Boolean).join(", ");
      const subject = `Ordering access request — ${dn} — ${nm}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
        <h2 style="color:#2B4071;margin:0 0 8px">Ordering access request</h2>
        <p style="font-size:13.5px;color:#374151">A dealer can see this line on Partner 360 but is not set up to order it. <b>Nothing has been granted.</b> To approve: open the manufacturer account if needed, then turn the line on in the dealer's Ordering Access grid (Dealer 360).</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Manufacturer</td><td><b>${esc(nm)}</b></td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer</td><td><b>${esc(dn)}</b>${self.hcps_account ? " · " + esc(self.hcps_account) : ""}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Location</td><td>${esc(where || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Requested by</td><td>${esc(who.email || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Contact / phone</td><td>${esc(self.contact_name || "—")} · ${esc(self.phone || "—")}</td></tr>
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin-top:14px">Sent from Partner 360. Recorded in dealer_access_requests. Reply to reach the dealer.</p></div>`;
      const text = `Ordering access request (nothing has been granted)\n\nManufacturer: ${nm}\nDealer: ${dn}${self.hcps_account ? " (" + self.hcps_account + ")" : ""}\nLocation: ${where || "—"}\nRequested by: ${who.email || "—"}\nContact / phone: ${self.contact_name || "—"} · ${self.phone || "—"}\n\nTo approve: open the manufacturer account if needed, then turn the line on in the dealer's Ordering Access grid (Dealer 360).`;
      const sent = await sendMail({ to: to.join(","), subject, html, text, reply_to: who.email });
      if (!(sent && sent.ok)) {
        /* Nobody at HCPS was told: close the stored ask (so it never blocks a new one) and say so — never "sent". */
        try { await sb("PATCH", `dealer_access_requests?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(slug)}&status=eq.new`,
          { status: "closed", staff_note: "notification email failed — dealer asked to try again or call", decided_at: new Date().toISOString(), decided_by: "system" }, { Prefer: "return=minimal" }); } catch (e) {}
        return json(503, { ok: false, error: "Your request could not be sent right now — please try again or call HCPS at 937-626-5141." });
      }
      return json(200, { ok: true, saved: true, notified: true });
    }

    // ---- tracking request (ask the manufacturer to send shipment tracking to the dealer/HCPS) ----
    if (b.action === "tracking_request") {
      const manufacturer = String(b.manufacturer || "").trim();          // slug or name
      const row = {
        dealer_id: did, order_ref: String(b.order_ref || "").trim() || null,
        manufacturer: manufacturer || null, po: String(b.po || "").trim() || null,
        summary: String(b.summary || "").trim() || null, status: "requested",
      };
      let saved = true;
      try { await sb("POST", "tracking_requests", row, { Prefer: "return=minimal" }); } catch (e) { saved = false; }
      // manufacturer contact, if the column exists
      let mfrContact = null, mfrDisplay = manufacturer;
      try { const m = await sb("GET", `manufacturers?slug=eq.${encodeURIComponent(manufacturer)}&select=name,contact_email`); if (m && m[0]) { mfrContact = m[0].contact_email || null; mfrDisplay = m[0].name || manufacturer; } } catch (e) {}
      const d = who.dealer || {};
      /* Never to a manufacturer (owner, 2026-10-27): HCPS asks the manufacturer for tracking itself. */
      const to = "angelo@homecareproviderservices.us";
      const subject = `Tracking request — ${row.po ? "PO " + row.po + " — " : ""}${d.name || "Dealer"} — ${mfrDisplay}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
        <h2 style="color:#2B4071;margin:0 0 8px">Shipment tracking request</h2>
        <p style="font-size:13.5px;color:#374151">A dealer asked for shipment tracking on the order below. This request went to HCPS only — nothing was sent to the manufacturer.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Manufacturer</td><td>${esc(mfrDisplay || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">PO</td><td>${esc(row.po || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Order</td><td>${esc(row.order_ref || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer</td><td><b>${esc(d.name || "—")}</b>${d.hcps_account ? " · " + esc(d.hcps_account) : ""}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer email</td><td>${esc(who.email || "—")}</td></tr>
          ${row.summary ? `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">Items</td><td>${esc(row.summary)}</td></tr>` : ""}
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin-top:14px">Requested via the HCPS Dealer Business Hub.</p></div>`;
      const text = `Shipment tracking request (dealer → HCPS only; nothing was sent to the manufacturer).\n\nManufacturer: ${mfrDisplay || "—"}\nPO: ${row.po || "—"}\nOrder: ${row.order_ref || "—"}\nDealer: ${d.name || "—"}\nDealer email: ${who.email || "—"}${row.summary ? `\nItems: ${row.summary}` : ""}`;
      try { await sendMail({ to, subject, html, text, reply_to: who.email }); } catch (e) {}
      return json(200, { ok: true, saved, sent_to: "hcps" });
    }

    // ---- account setup center (credit apps, resale cert, per-line terms) — NO card storage ----
    if (b.action === "account_get") {
      let resale = null, applications = [], terms = [];
      try { const r = await sb("GET", `resale_certs?dealer_id=eq.${encodeURIComponent(did)}&select=reference,state,status,updated_at&limit=1`); if (r && r[0]) resale = r[0]; } catch (e) {}
      try { applications = await sb("GET", `credit_applications?dealer_id=eq.${encodeURIComponent(did)}&select=manufacturer,requested_terms,status,created_at&order=created_at.desc`); } catch (e) { applications = []; }
      try { terms = await sb("GET", `dealer_terms?dealer_id=eq.${encodeURIComponent(did)}&select=manufacturer,terms`); } catch (e) { terms = []; }
      return json(200, { ok: true, resale, applications: applications || [], terms: terms || [] });
    }
    if (b.action === "resale_cert_set") {
      const reference = String(b.reference || "").trim();
      const state = String(b.state || "").trim() || null;
      try { await sb("POST", "resale_certs", { dealer_id: did, reference: reference || null, state, status: reference ? "on_file" : "pending", updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" }); }
      catch (e) { return json(200, { ok: false, error: "save_failed (is the resale_certs table present?)" }); }
      return json(200, { ok: true });
    }
    /* The old generic credit form (C3-07 Stage 3 + owner decision D5, 2026-11-05): it stored EIN and bank details as plain
       text and EMAILED them — both forbidden by D5 (financial applications stored privately, President-only, encrypted,
       audited; contents never in email or logs). It is closed. Manufacturer applications move to the Digital Account
       Setup Center (Stage 5), which signs the manufacturer's own application. Applications already on file stay listed. */
    if (b.action === "credit_application") {
      return json(410, { ok: false, error: "Manufacturer credit applications are moving to the new Account Setup Center. Until it opens, call HCPS at 937-626-5141 and we'll send you the manufacturer's application." });
    }

    return json(400, { error: "unknown action" });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
