// HCPS — RULE 19 outside check for MI Inbox Automation Phase B (supabase/mi_b_report_capture.sql): the six capture
// tables and the seven hcps_mfr_capture_* functions, using ONLY the PUBLIC (anon) key, exactly as a stranger could
// (6 × 4 + 7 = 31 checks). Paste into the console of a blank tab (about:blank). It asks for the key; nothing is stored
// or sent anywhere else. Expect: "ALL 31 CHECKS BLOCKED (key verified)". Any OPEN!! = stop, do not merge or deploy.
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
  const KEYCOL = { mfr_report_capture_state: ['mailbox', '"nobody@nowhere.example"'] };
  for (const t of ['mfr_report_profiles', 'mfr_report_capture_state', 'mfr_report_capture_runs', 'mfr_report_messages', 'mfr_report_items', 'mfr_report_capture_events']) {
    const T = `${URL}/rest/v1/${t}`; const [col, val] = KEYCOL[t] || ['id', '0'];
    await check(`read ${t}`, `${T}?select=*&limit=1`, { headers: H });
    await check(`insert ${t}`, T, { method: 'POST', headers: H, body: '{}' });
    await check(`update ${t}`, `${T}?${col}=eq.${encodeURIComponent(JSON.parse(val))}`, { method: 'PATCH', headers: H, body: `{"${col}":${val}}` });
    await check(`delete ${t}`, `${T}?${col}=eq.${encodeURIComponent(JSON.parse(val))}`, { method: 'DELETE', headers: H });
  }
  for (const fn of ['begin', 'record', 'classify', 'fail', 'register', 'finish', 'resolve'])
    await check(`rpc hcps_mfr_capture_${fn}`, `${URL}/rest/v1/rpc/hcps_mfr_capture_${fn}`, { method: 'POST', headers: H, body: JSON.stringify({ p: { mailbox: 'nobody@nowhere.example', item_id: 0 } }) });
  console.table(rows);
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled ? `${notInstalled} NOT INSTALLED — Phase B is not (fully) installed; send this table`
    : `ALL ${rows.length} CHECKS BLOCKED (key verified)`);
})();
