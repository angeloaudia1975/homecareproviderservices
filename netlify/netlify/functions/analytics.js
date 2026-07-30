// HCPS admin analytics — reads monthly_sales from Supabase (service_role, server-side)
// and returns an aggregated fact "cube" the admin page slices for all its reports:
// per-line history, dealer line-mix, product detail, and order cadence. No npm deps.
//
// Netlify env vars required:
//   SUPABASE_URL             e.g. https://YOUR-PROJECT.supabase.co
//   SUPABASE_SERVICE_ROLE    the secret service_role key (NOT the publishable key)
//   ANALYTICS_TOKEN          (optional) shared passcode; if set, the page must send it
//
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const json = (code, obj) => ({
  statusCode: code,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(obj),
});

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

// Supabase/PostgREST caps each response at ~1000 rows regardless of ?limit,
// so page through with limit/offset until a short page comes back.
async function sbGetAll(base) {
  const PAGE = 1000;
  let from = 0, out = [];
  for (;;) {
    const sep = base.includes("?") ? "&" : "?";
    const rows = await sbGet(`${base}${sep}order=id&limit=${PAGE}&offset=${from}`);
    out = out.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const MONTH = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const label = (p) => { const [y,m] = p.split("-"); return `${MONTH[parseInt(m,10)-1]} ${y}`; };

exports.handler = async (event) => {
  try {
    const need = process.env.ANALYTICS_TOKEN;
    if (need) {
      const got = event.headers["x-analytics-token"] || (event.queryStringParameters||{}).token || "";
      if (got !== need) return json(401, { error: "unauthorized" });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)" });

    const mfrs = await sbGet("manufacturers?select=slug,name");
    const mfrName = Object.fromEntries(mfrs.map(m => [m.slug, m.name]));
    // Optional (present after the dealer_directory migration): saved rep/account assignments + rep list.
    let assignments = [], repTable = [];
    try { assignments = await sbGet("dealer_directory?select=dealer_name,rep_name,hcps_account"); } catch (e) { assignments = []; }
    try { repTable = (await sbGet("reps?select=name")).map(x => x.name); } catch (e) { repTable = []; }
    const rows = await sbGetAll("monthly_sales?select=manufacturer,period,customer_name,rep_name,product_code,product_name,qty,amount,commission");

    // Aggregate to a cube: one row per (period, line, rep, dealer, product).
    const cube = new Map();
    const periods = new Set(), lines = new Set(), reps = new Set();
    const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    for (const r of rows) {
      const period = (r.period || "").slice(0,10); if (!period) continue;
      const line = mfrName[r.manufacturer] || r.manufacturer || "(unknown)";
      const rep  = r.rep_name || "Unassigned";
      const dealer = r.customer_name || "(unknown)";
      const prod = (r.product_code || "").trim();
      const pname = (r.product_name || "").trim();
      periods.add(period); lines.add(line); reps.add(rep);
      const key = [period, line, rep, dealer, prod, pname].join("|~|");
      const cur = cube.get(key) || { period, line, rep, dealer, product: prod, productName: pname, sales: 0, comm: 0, qty: 0, recs: 0 };
      cur.sales += Number(r.amount) || 0;
      cur.comm  += Number(r.commission) || 0;
      cur.qty   += Number(r.qty) || 0;
      cur.recs  += 1;
      cube.set(key, cur);
    }
    const facts = [...cube.values()].map(f => ({ ...f, sales: money(f.sales), comm: money(f.comm) }));
    const periodList = [...periods].sort();

    return json(200, {
      generatedAt: new Date().toISOString(),
      latestPeriod: periodList[periodList.length - 1] || null,
      periods: [{ key: "all", label: "All periods" }, ...periodList.map(p => ({ key: p, label: label(p) }))],
      lines: [...lines].sort(),
      reps: [...reps].sort(),
      repOptions: [...new Set([...repTable, ...reps])].filter(Boolean).sort(),
      assignments,
      facts,
    });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
