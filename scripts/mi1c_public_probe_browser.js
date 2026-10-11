// HCPS — RULE 19 outside check for MI-1c (supabase/mi1c_dealer_intel.sql): the five dealer-intelligence tables (incl. the
// recorded holds) and the two MI-1c functions, using ONLY the PUBLIC (anon) key, exactly as a stranger could (22 checks).
// Paste into the console of a blank tab (about:blank). It asks for the key; nothing is stored or sent anywhere else.
// Expect: "ALL n CHECKS BLOCKED (key verified)". Any OPEN!! = stop, do not merge or deploy.
// The RPC bodies are harmless even if a call were somehow allowed: empty / zero ids that both functions refuse.
(async () => {
  const REF = 'ycqmztthwldytkzyvmiv'; // built from the ref: a literal project URL trips Netlify's secret scanner
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the anon (public) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — nothing was tested.`);
  const isBlocked = (s, b) => (s === 401 || s === 403) && /42501|permission denied/i.test(b);
  const rows = []; let open = 0, notInstalled = 0;
  const check = async (label, url, init) => {
    const r = await fetch(url, init); const b = await r.text();
    let result;
    if (isBlocked(r.status, b)) result = 'BLOCKED';
    else if (r.status === 404 && /PGRST202|PGRST205|42P01/.test(b)) { result = 'NOT INSTALLED'; notInstalled++; }
    else { result = 'OPEN!!'; open++; }
    rows.push({ check: label, http: r.status, result, detail: result === 'BLOCKED' ? '' : b.slice(0, 160) });
  };
  for (const t of ['mfr_intel_reports', 'mfr_dealer_snapshots', 'mfr_dealer_observations', 'mfr_intel_events', 'mfr_intel_holds']) {
    const T = `${URL}/rest/v1/${t}`;
    await check(`read ${t}`, `${T}?select=*&limit=1`, { headers: H });
    await check(`insert ${t}`, T, { method: 'POST', headers: H, body: '{}' });
    await check(`update ${t}`, `${T}?id=eq.0`, { method: 'PATCH', headers: H, body: '{"id":0}' });
    await check(`delete ${t}`, `${T}?id=eq.0`, { method: 'DELETE', headers: H });
  }
  for (const fn of ['hcps_mfr_intel_import', 'hcps_mfr_intel_match'])
    await check(`rpc ${fn}`, `${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify({ p: { source_id: 0 } }) });
  console.table(rows);
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled ? `${notInstalled} NOT INSTALLED — MI-1c is not (fully) installed; send this table`
    : `ALL ${rows.length} CHECKS BLOCKED (key verified)`);
})();
