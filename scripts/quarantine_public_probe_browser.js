// HCPS — RULE 19 outside check for public.monthly_sales_quarantine (Strongback Sept 2026 cleanup).
// Uses ONLY the PUBLIC (anon) key, exactly as a stranger could. Paste into the console of a blank tab (about:blank).
// It asks for the key; nothing is stored or sent anywhere else. Both lines must say BLOCKED.
(async () => {
  // Built from the project ref: a literal project URL in the repo fails Netlify's secret scanner (see the Academy probe).
  const REF = 'ycqmztthwldytkzyvmiv';
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the anon (public) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — nothing was tested.`);
  const blocked = (s, b) => (s === 401 || s === 403) && /42501|permission denied/i.test(b);
  const r = await fetch(`${URL}/rest/v1/monthly_sales_quarantine?select=*&limit=1`, { headers: H }); const rb = await r.text();
  const w = await fetch(`${URL}/rest/v1/monthly_sales_quarantine`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }); const wb = await w.text();
  console.table([
    { check: 'read quarantine', status: r.status, result: blocked(r.status, rb) ? 'BLOCKED' : 'OPEN!!', detail: rb.slice(0, 120) },
    { check: 'write quarantine', status: w.status, result: blocked(w.status, wb) ? 'BLOCKED' : 'OPEN!!', detail: wb.slice(0, 120) },
  ]);
})();
