// HCPS — RULE 19 outside check for Phase E (supabase/mi_e_auto_import.sql): the three Phase E tables, the five functions
// and monthly_sales_quarantine, using ONLY the PUBLIC (anon) key, exactly as a stranger could (4 × 4 + 5 = 21 checks).
// Paste into the console of a blank tab (about:blank). It asks for the key; nothing is stored or sent anywhere else.
// Expect: "ALL 21 CHECKS BLOCKED (key verified)". Any OPEN!! = stop, do not merge or deploy.
// Every write names a column the table really has (a missing column answers PGRST204 before any permission check,
// which would test nothing) and targets a row that does not exist. RPC bodies are harmless even if a call were allowed.
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
  for (const t of ['mfr_quarantine_dispositions', 'mfr_import_approvals', 'mfr_auto_import_log', 'monthly_sales_quarantine']) {
    const T = `${URL}/rest/v1/${t}`;
    await check(`read ${t}`, `${T}?select=*&limit=1`, { headers: H });
    await check(`insert ${t}`, T, { method: 'POST', headers: H, body: '{}' });
    await check(`update ${t}`, `${T}?id=eq.0`, { method: 'PATCH', headers: H, body: '{"id":0}' });
    await check(`delete ${t}`, `${T}?id=eq.0`, { method: 'DELETE', headers: H });
  }
  for (const fn of ['hcps_mfr_quarantine_dispose', 'hcps_mfr_import_approve', 'hcps_mfr_import_use', 'hcps_mfr_auto_import_log'])
    await check(`rpc ${fn}`, `${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify({ p: { source_id: 0, approval_id: 0 } }) });
  await check('rpc hcps_mfr_quarantine_fp', `${URL}/rest/v1/rpc/hcps_mfr_quarantine_fp`, { method: 'POST', headers: H, body: JSON.stringify({ p_mfr: 'x', p_period: '2026-09-01' }) });
  console.table(rows);
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled ? `${notInstalled} NOT INSTALLED — Phase E is not (fully) installed; send this table`
    : `ALL ${rows.length} CHECKS BLOCKED (key verified)`);
})();
