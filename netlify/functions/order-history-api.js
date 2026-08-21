// HCPS Dealer Business Hub — Phase 1: consolidated order history + dashboard summary.
// Dealer-scoped, gated by the caller's Supabase Auth JWT. Reads ONLY the caller's own data.
//
//   POST {action:"summary"}  + Bearer <jwt>
//       -> { ok, dealer, ytd, allTime, byManufacturer[], monthly[], recent[] }   (dashboard shell)
//   POST {action:"history", limit?, year?}  + Bearer <jwt>
//       -> { ok, dealer, orders[] }   (full consolidated list — My Orders)
//
// Consolidates two sources on the SAME Supabase the portal already uses:
//   • monthly_sales   — imported sales history (2025→), source "imported"
//   • orders/order_items — portal orders saved by orders-api (and future Golden), source "portal"/"golden"
// No new tables, no writes. Service-role, server-side only.  ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE.

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
const round2 = (n) => Math.round(num(n) * 100) / 100;

async function sb(method, path, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return j;
}
// PostgREST caps a response at ~1000 rows; page through until a short page returns.
async function sbAll(base) {
  const PAGE = 1000; let from = 0, out = [];
  for (;;) {
    const sep = base.includes("?") ? "&" : "?";
    const rows = await sb("GET", `${base}${sep}limit=${PAGE}&offset=${from}`);
    out = out.concat(rows || []);
    if (!rows || rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// Resolve the caller's JWT to an APPROVED dealer (or null). Mirrors orders-api / dealer-auth.
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
  try {
    const d = await sb("GET", `dealers?id=eq.${encodeURIComponent(du.dealer_id)}&select=business_name,hcps_account`);
    if (d && d[0]) dealer = { name: d[0].business_name || "", hcps_account: d[0].hcps_account || "" };
  } catch (e) {}
  return { dealer_id: du.dealer_id, email: du.email, dealer };
}

// period "2025-03-01" | "2025-03" -> {ym:"2025-03", year:"2025"}
function ym(period) { const s = String(period || "").slice(0, 7); return { ym: s, year: s.slice(0, 4) }; }

// Build the consolidated, normalized order list for one dealer.
async function consolidate(dealerId, mfrName) {
  const out = [];

  // 1) Imported sales history (monthly_sales) — grouped per (period, manufacturer) into one record.
  let ms = [];
  try {
    ms = await sbAll(`monthly_sales?dealer_id=eq.${encodeURIComponent(dealerId)}&select=manufacturer,period,product_code,product_name,qty,amount&order=period.desc`);
  } catch (e) { ms = []; }
  const groups = new Map();
  for (const r of ms) {
    const p = ym(r.period); if (!p.ym) continue;
    const slug = r.manufacturer || "";
    const key = `${p.ym}|${slug}`;
    let g = groups.get(key);
    if (!g) { g = { id: `MS-${p.ym}-${slug || "x"}`, date: p.ym + "-01", ym: p.ym, source: "imported", status: "delivered", manufacturer: slug, manufacturerName: mfrName[slug] || slug || "—", lines: [], cost: 0, units: 0 }; groups.set(key, g); }
    const qty = Math.round(num(r.qty)), amt = round2(r.amount);
    g.lines.push({ code: r.product_code || "", name: r.product_name || (r.product_code || "Item"), qty, cost: amt, line: amt });
    g.cost = round2(g.cost + amt); g.units += qty;
  }
  for (const g of groups.values()) out.push(g);

  // 2) Portal / Golden orders (orders + order_items).
  let ord = [];
  try {
    ord = await sb("GET", `orders?dealer_id=eq.${encodeURIComponent(dealerId)}&select=id,manufacturer,status,po_number,subtotal,submitted_at,env,order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=1000`);
  } catch (e) { ord = []; }
  for (const o of (ord || [])) {
    const slug = o.manufacturer || "";
    // Golden-synced orders (once federation writes them) are tagged via env/source; default portal.
    const source = (o.env && String(o.env).toLowerCase().includes("golden")) ? "golden" : "portal";
    const items = (o.order_items || []).map((i) => ({ code: i.code || "", name: i.name || (i.code || "Item"), qty: Math.round(num(i.qty)), cost: num(i.unit_price), line: num(i.line_total) }));
    out.push({
      id: o.id, date: o.submitted_at || null, ym: ym(o.submitted_at).ym, source,
      status: o.status || "submitted", manufacturer: slug, manufacturerName: mfrName[slug] || slug || "—",
      lines: items, cost: round2(o.subtotal != null ? o.subtotal : items.reduce((s, i) => s + i.line, 0)),
      units: items.reduce((s, i) => s + i.qty, 0),
    });
  }

  // newest first
  out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return out;
}

function aggregate(list) {
  const year = String(new Date().getFullYear());
  const ytd = { year, spend: 0, units: 0, orders: 0 };
  const all = { spend: 0, units: 0, orders: 0, sinceYear: null };
  const byMfr = new Map();
  const monthly = {}; // current-year YYYY-MM -> spend
  let minYear = null;
  for (const o of list) {
    const y = String(o.ym || "").slice(0, 4);
    if (y && (minYear === null || y < minYear)) minYear = y;
    all.spend = round2(all.spend + o.cost); all.units += o.units; all.orders += 1;
    if (y === year) {
      ytd.spend = round2(ytd.spend + o.cost); ytd.units += o.units; ytd.orders += 1;
      monthly[o.ym] = round2((monthly[o.ym] || 0) + o.cost);
    }
    const m = byMfr.get(o.manufacturer) || { slug: o.manufacturer, name: o.manufacturerName, spend: 0, units: 0 };
    m.spend = round2(m.spend + o.cost); m.units += o.units; byMfr.set(o.manufacturer, m);
  }
  all.sinceYear = minYear;
  const byManufacturer = [...byMfr.values()].sort((a, b) => b.spend - a.spend);
  const monthlyArr = Object.keys(monthly).sort().map((k) => ({ month: k, spend: monthly[k] }));
  return { ytd, allTime: all, byManufacturer, monthly: monthlyArr };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)" });
    if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
    let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }

    const who = await dealerFromToken(event);
    if (!who) return json(200, { ok: false, status: "unauthorized" });

    let mfrName = {};
    try { const ms = await sb("GET", "manufacturers?select=slug,name"); for (const m of (ms || [])) mfrName[m.slug] = m.name || m.slug; } catch (e) {}

    const list = await consolidate(who.dealer_id, mfrName);

    if (b.action === "history") {
      const year = b.year ? String(b.year) : null;
      const limit = Math.min(500, Math.max(1, Number(b.limit) || 200));
      let rows = year ? list.filter((o) => String(o.ym || "").slice(0, 4) === year) : list;
      rows = rows.slice(0, limit);
      return json(200, { ok: true, dealer: who.dealer, count: rows.length, orders: rows });
    }

    // default: dashboard summary
    const agg = aggregate(list);
    const recent = list.slice(0, 8).map((o) => ({
      id: o.id, date: o.date, source: o.source, status: o.status,
      manufacturer: o.manufacturer, manufacturerName: o.manufacturerName,
      itemsCount: o.lines.length, units: o.units, cost: o.cost,
      preview: o.lines.slice(0, 3).map((l) => l.name),
    }));
    return json(200, { ok: true, dealer: who.dealer, ...agg, recent });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
