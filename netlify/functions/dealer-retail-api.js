// C3-07 Stage 4 — a dealer's SAVED RETAIL PRICES (owner directive 2026-11-05; D2 / D3 2026-11-05 15:20 CT).
//
// The dealer's own selling price for a product, used on the dealer's quotes and brochures — one of the three customer
// pricing choices (verified MSRP · saved dealer retail · one-time quote price). A company default (location_id null) and,
// optionally, a different price per location. Never reads or writes a wholesale price, MAP, tier, freight or order; never
// shown publicly here (public display is Stage 7, under the D3 MAP rules).
//
//   POST + Bearer <dealer JWT>:
//     {action:"retail_list"}                                   -> {ok, head_office, locations:[{id,name,is_self}], prices:[{manufacturer,code,location_id,price,updated_at}]}
//     {action:"retail_set", rows:[{manufacturer,code,price|null,location_id?}]}  (≤ 500; price null = remove)
//                                                               -> {ok, saved, removed, unchanged}
//     {action:"retail_history", manufacturer, code}            -> {ok, history:[…]}  (newest first, 50)
//
// Who may set what (D2): a head-office login sets the company default and any location it may see; a branch login sets
// only its own location's price. Strict reads: a store that can't be read answers 503, never a partial answer.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE.

const AC = require("./_account_center.js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" };
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const MAX_ROWS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sb(method, path, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}
async function dealerFromToken(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, ""); if (!tok) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
  if (!ur.ok) return null;
  const u = await ur.json();
  const rows = await sb("GET", `dealer_users?uid=eq.${enc(u.id)}&select=status,dealer_id,email`);
  const du = rows && rows[0];
  if (!du || du.status !== "approved" || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, email: du.email || "", uid: u.id };
}
/* "not installed yet" = the Stage 4 table itself (or Stage 3's scope table) is missing — nothing broader */
const MISSING = (e) => { const m = String(e && e.message); return /PGRST205|42P01/.test(m) && /dealer_retail_price|dealer_user_scope/.test(m); };
// Every row, past PostgREST's 1000-row cap (strict: a failed page throws).
async function getAll(path) {
  const out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const page = await sb("GET", `${path}${path.includes("?") ? "&" : "?"}order=id.asc&limit=1000&offset=${off}`);
    out.push(...(page || [])); if (!page || page.length < 1000) break;
  }
  return out;
}

// Normalise one requested row. Returns {row} or {error}.
function cleanRow(x) {
  if (!x || typeof x !== "object") return { error: "bad row" };
  const manufacturer = String(x.manufacturer || "").trim().toLowerCase();
  const code = String(x.code == null ? "" : x.code).replace(/[\u0000-\u001f]/g, "").trim();
  if (!/^[a-z0-9-]{2,60}$/.test(manufacturer)) return { error: "Unknown manufacturer." };
  if (!code || code.length > 60) return { error: "Each row needs its part number." };
  let location_id = x.location_id == null || x.location_id === "" ? null : String(x.location_id);
  if (location_id && !UUID.test(location_id)) return { error: "Unknown location." };
  let price = x.price;
  if (price === null || price === "") price = null;
  else {
    price = Number(String(price).replace(/[$,\s]/g, ""));
    if (!isFinite(price) || price <= 0 || price > 1000000) return { error: `Price for ${code} must be more than $0.` };
    price = Math.round(price * 100) / 100;
  }
  return { row: { manufacturer, code, location_id, price } };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: "not configured" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "bad JSON" }); }
  let who; try { who = await dealerFromToken(event); } catch (e) { return json(503, { ok: false, error: "Please try again in a moment." }); }
  if (!who) return json(401, { ok: false, error: "Please sign in again." });
  const did = who.dealer_id;

  // The locations this login may price (D2).
  let visible, self;
  let scopeRestricted = false;   // a head office HCPS narrowed to "own" or a list may not change the whole company's default
  try {
    const d = await sb("GET", `dealers?id=eq.${enc(did)}&select=id,parent_id,business_name`); self = d && d[0];
    if (!self) return json(404, { ok: false, error: "Account not found." });
    const root = self.parent_id || self.id;
    const family = await sb("GET", `dealers?or=(id.eq.${enc(root)},parent_id.eq.${enc(root)})&select=id,parent_id,business_name&limit=200`);
    let scopeRow = null;
    try { const s = await sb("GET", `dealer_user_scope?uid=eq.${enc(who.uid)}&select=scope,locations`); scopeRow = (s && s[0]) || null; } catch (e) { if (!MISSING(e)) throw e; }
    visible = AC.visibleLocations(did, family, scopeRow);
    scopeRestricted = !!(scopeRow && scopeRow.scope !== "company");
  } catch (e) { console.error("retail scope read failed", e && e.message); return json(503, { ok: false, error: "Your prices could not be loaded just now — please try again." }); }
  const headOffice = !self.parent_id;
  const visibleIds = new Set(visible.map((v) => String(v.id)));
  // The company the prices belong to: a head office's own id; a branch writes under its company's head office so the
  // company default and the branch override sit together (one dealer_id per company).
  const owner = String(self.parent_id || self.id);
  // A branch login may only price its own location; a head office the company default (null) and its visible locations.
  const mayWrite = (loc) => loc == null ? (headOffice && !scopeRestricted) : (visibleIds.has(String(loc)) && (headOffice || String(loc) === String(did)));
  const mayRead = (loc) => loc == null || visibleIds.has(String(loc));

  if (b.action === "retail_list") {
    let rows;
    try { rows = await getAll(`dealer_retail_prices?dealer_id=eq.${enc(owner)}&select=id,manufacturer,code,location_id,price,updated_at`); }
    catch (e) { if (MISSING(e)) return json(503, { ok: false, error: "Saved retail prices open shortly." }); return json(503, { ok: false, error: "Your prices could not be loaded just now — please try again." }); }
    return json(200, { ok: true, head_office: headOffice, self_id: did,
      locations: visible.map((v) => ({ id: v.id, name: v.business_name || "", is_self: String(v.id) === String(did) })),
      prices: (rows || []).filter((r) => mayRead(r.location_id)).sort((a, b) => (a.manufacturer + a.code).localeCompare(b.manufacturer + b.code)).map((r) => ({ manufacturer: r.manufacturer, code: r.code, location_id: r.location_id, price: Number(r.price), updated_at: r.updated_at })) });
  }

  if (b.action === "retail_set") {
    const input = Array.isArray(b.rows) ? b.rows : [];
    if (!input.length) return json(400, { ok: false, error: "Nothing to save." });
    if (input.length > MAX_ROWS) return json(400, { ok: false, error: `At most ${MAX_ROWS} prices at a time.` });
    const rows = []; const seen = new Set();
    for (let i = 0; i < input.length; i++) {
      const c = cleanRow(input[i]); if (c.error) return json(400, { ok: false, error: `Row ${i + 1}: ${c.error}` });
      if (!headOffice && c.row.location_id == null) c.row.location_id = String(did);     // a branch prices its own location
      if (!mayWrite(c.row.location_id)) return json(403, { ok: false, error: `Row ${i + 1}: you can't set prices for that location.` });
      const k = [c.row.manufacturer, c.row.code, c.row.location_id || ""].join("|");
      if (seen.has(k)) return json(400, { ok: false, error: `Row ${i + 1}: ${c.row.code} is listed twice.` }); seen.add(k);
      rows.push(c.row);
    }
    let current;
    try {
      const mfrs = [...new Set(rows.map((r) => r.manufacturer))];
      current = await getAll(`dealer_retail_prices?dealer_id=eq.${enc(owner)}&manufacturer=in.(${mfrs.map(enc).join(",")})&select=id,manufacturer,code,location_id,price`);
    } catch (e) { if (MISSING(e)) return json(503, { ok: false, error: "Saved retail prices open shortly." }); return json(503, { ok: false, error: "Could not save just now — please try again." }); }
    const curBy = new Map((current || []).map((r) => [[r.manufacturer, r.code, r.location_id || ""].join("|"), r]));
    let saved = 0, removed = 0, unchanged = 0; const hist = [], by = who.email || "dealer", at = new Date().toISOString();
    try {
      for (const r of rows) {
        const cur = curBy.get([r.manufacturer, r.code, r.location_id || ""].join("|"));
        if (r.price == null) {
          if (!cur) { unchanged++; continue; }
          const del = await sb("DELETE", `dealer_retail_prices?id=eq.${cur.id}&dealer_id=eq.${enc(owner)}&price=eq.${cur.price}`, null, { Prefer: "return=representation" });
          if (!(del && del.length)) throw new Error("changed by someone else");   // another save got there first
          hist.push({ dealer_id: owner, location_id: r.location_id, manufacturer: r.manufacturer, code: r.code, old_price: Number(cur.price), new_price: null, changed_by: by, changed_at: at }); removed++; continue;
        }
        if (cur && Number(cur.price) === r.price) { unchanged++; continue; }
        if (cur) { const up = await sb("PATCH", `dealer_retail_prices?id=eq.${cur.id}&dealer_id=eq.${enc(owner)}&price=eq.${cur.price}`, { price: r.price, updated_by: by, updated_at: at }, { Prefer: "return=representation" });
          if (!(up && up.length)) throw new Error("changed by someone else"); }   // the old price in history is the one actually replaced
        else await sb("POST", "dealer_retail_prices", { dealer_id: owner, location_id: r.location_id, manufacturer: r.manufacturer, code: r.code, price: r.price, updated_by: by, updated_at: at }, { Prefer: "return=minimal" });
        hist.push({ dealer_id: owner, location_id: r.location_id, manufacturer: r.manufacturer, code: r.code, old_price: cur ? Number(cur.price) : null, new_price: r.price, changed_by: by, changed_at: at }); saved++;
      }
    } catch (e) {
      console.error("retail save failed part-way", e && e.message);
      let hOk = true; if (hist.length) { try { await sb("POST", "dealer_retail_price_history", hist, { Prefer: "return=minimal" }); } catch (x) { hOk = false; console.error("retail history not recorded", x && x.message); } }
      return json(503, { ok: false, error: `Saved ${saved + removed} of ${rows.length} — the rest could not be saved just now. Please try again.`, saved, removed, history_recorded: hOk });
    }
    let hOk = true;
    if (hist.length) { try { await sb("POST", "dealer_retail_price_history", hist, { Prefer: "return=minimal" }); } catch (e) { hOk = false; console.error("retail history not recorded", e && e.message); } }
    return json(200, { ok: true, saved, removed, unchanged, history_recorded: hOk });
  }

  if (b.action === "retail_history") {
    const c = cleanRow({ manufacturer: b.manufacturer, code: b.code, price: null });
    if (c.error) return json(400, { ok: false, error: c.error });
    let h;
    try { h = await sb("GET", `dealer_retail_price_history?dealer_id=eq.${enc(owner)}&manufacturer=eq.${enc(c.row.manufacturer)}&code=eq.${enc(c.row.code)}&select=location_id,old_price,new_price,changed_by,changed_at&order=changed_at.desc&limit=50`); }
    catch (e) { return json(503, { ok: false, error: "History could not be loaded just now." }); }
    /* who changed it is shown to a head office only — a branch sees when and what, not staff emails */
    return json(200, { ok: true, history: (h || []).filter((r) => mayRead(r.location_id)).map((r) => headOffice ? r : Object.assign({}, r, { changed_by: null })) });
  }
  return json(400, { ok: false, error: "unknown action" });
};
module.exports._cleanRow = cleanRow;
