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
  return { dealer_id: du.dealer_id, email: du.email, dealer };
}

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
      const to = mfrContact || PRICING_TO;
      const subject = `Tracking request — ${row.po ? "PO " + row.po + " — " : ""}${d.name || "Dealer"} — ${mfrDisplay}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
        <h2 style="color:#2B4071;margin:0 0 8px">Shipment tracking request</h2>
        <p style="font-size:13.5px;color:#374151">Please provide shipment/tracking information for the order below — sent directly to the dealer, and to HCPS (${esc(PRICING_TO)}) so we can sync it to the dealer's order history.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Manufacturer</td><td>${esc(mfrDisplay || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">PO</td><td>${esc(row.po || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Order</td><td>${esc(row.order_ref || "—")}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer</td><td><b>${esc(d.name || "—")}</b>${d.hcps_account ? " · " + esc(d.hcps_account) : ""}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer email</td><td>${esc(who.email || "—")}</td></tr>
          ${row.summary ? `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">Items</td><td>${esc(row.summary)}</td></tr>` : ""}
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin-top:14px">Requested via the HCPS Dealer Business Hub.</p></div>`;
      const text = `Shipment tracking request\n\nPlease send tracking for this order to the dealer and to HCPS (${PRICING_TO}).\n\nManufacturer: ${mfrDisplay || "—"}\nPO: ${row.po || "—"}\nOrder: ${row.order_ref || "—"}\nDealer: ${d.name || "—"}\nDealer email: ${who.email || "—"}${row.summary ? `\nItems: ${row.summary}` : ""}`;
      try { await sendMail({ to, subject, html, text, reply_to: who.email }); } catch (e) {}
      return json(200, { ok: true, saved, sent_to: mfrContact ? "manufacturer" : "hcps" });
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
    if (b.action === "credit_application") {
      const manufacturer = String(b.manufacturer || "").trim();
      if (!manufacturer) return json(400, { error: "manufacturer required" });
      const row = {
        dealer_id: did, manufacturer,
        legal_name: String(b.legal_name || "").trim() || null,
        ein: String(b.ein || "").trim() || null,
        years_in_business: b.years_in_business != null ? String(b.years_in_business).slice(0, 12) : null,
        bank_ref: String(b.bank_ref || "").trim() || null,
        trade_refs: String(b.trade_refs || "").trim() || null,
        requested_terms: String(b.requested_terms || "").trim() || null,
        note: String(b.note || "").trim() || null,
        status: "submitted",
      };
      let saved = true;
      try { await sb("POST", "credit_applications", row, { Prefer: "return=minimal" }); } catch (e) { saved = false; }
      // include whether a resale cert is already on file, so HCPS can forward it with the app
      let resaleNote = "not on file";
      try { const r = await sb("GET", `resale_certs?dealer_id=eq.${encodeURIComponent(did)}&select=reference,status&limit=1`); if (r && r[0] && r[0].status === "on_file") resaleNote = "on file" + (r[0].reference ? " (" + r[0].reference + ")" : ""); } catch (e) {}
      const d = who.dealer || {};
      const subject = `Credit application — ${d.name || "Dealer"} — ${manufacturer}`;
      const F = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td>${esc(v || "—")}</td></tr>`;
      const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
        <h2 style="color:#2B4071;margin:0 0 8px">Manufacturer credit application</h2>
        <table style="border-collapse:collapse;font-size:14px">
          ${F("Dealer", (d.name || "—") + (d.hcps_account ? " · " + d.hcps_account : ""))}
          ${F("Manufacturer / line", manufacturer)}
          ${F("Legal business name", row.legal_name)}
          ${F("EIN / Tax ID", row.ein)}
          ${F("Years in business", row.years_in_business)}
          ${F("Bank reference", row.bank_ref)}
          ${F("Trade references", row.trade_refs)}
          ${F("Requested terms", row.requested_terms)}
          ${F("Resale certificate", resaleNote)}
          ${row.note ? F("Note", row.note) : ""}
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin-top:14px">Submitted from the HCPS Dealer Business Hub. Reply to reach the dealer. HCPS forwards this to the manufacturer with the dealer's resale certificate. (No payment/card data is collected by HCPS.)</p></div>`;
      const text = `Manufacturer credit application\n\nDealer: ${d.name || "—"}\nManufacturer: ${manufacturer}\nLegal name: ${row.legal_name || "—"}\nEIN: ${row.ein || "—"}\nYears in business: ${row.years_in_business || "—"}\nBank ref: ${row.bank_ref || "—"}\nTrade refs: ${row.trade_refs || "—"}\nRequested terms: ${row.requested_terms || "—"}\nResale cert: ${resaleNote}${row.note ? `\nNote: ${row.note}` : ""}`;
      try { await sendMail({ to: PRICING_TO, subject, html, text, reply_to: who.email }); } catch (e) {}
      return json(200, { ok: true, saved });
    }

    return json(400, { error: "unknown action" });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
