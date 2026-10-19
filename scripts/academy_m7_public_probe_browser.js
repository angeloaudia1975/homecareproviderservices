// HCPS Academy — A2F M7 external probe (browser console). Uses ONLY the PUBLIC key, as a stranger could.
// Paste into the console of a blank tab (about:blank); it asks for the public key, stores nothing, sends nothing elsewhere.
// Calls the 5 M7 functions through the public API with correctly named arguments (so "not found" can only mean the
// function is not installed, never a wrong signature), then tries a direct read, insert, edit and delete on
// academy_certificates. Every argument is a random id / a number that cannot exist: even a broken permission could only reach "not found".
//   Before M7: the 5 function lines say NOT INSTALLED (the 4 table lines say BLOCKED already).
//   After M7: all 9 lines must say BLOCKED.   OPEN!! = stop and report.
(async () => {
  const REF = 'ycqmztthwldytkzyvmiv';                       // built from the ref (Netlify's secret scanner, see A1 probe)
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the public (publishable / anon) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — not the right public key; nothing was tested.`);
  const Z = '00000000-0000-0000-0000-000000000000', A = 'staff:probe@example.invalid', E = 'probe@example.invalid', X = '0'.repeat(64);
  const calls = {
    academy_cert_president: { p_actor: A },
    academy_cert_view: { c: null },
    academy_cert_op_claim: { p_actor: 'learner:' + Z, p_attempt_id: Z },
    academy_cert_op_revoke: { p_actor: A, p_certificate_id: Z, p_reason: 'public-key probe' },
    academy_cert_op_verify: { p_number: 'HCPS-ZZZZ-ZZZZ' },
  };
  const rows = []; let open = 0, notInstalled = 0, blocked = 0;
  const refused = (r, b) => (r.status === 401 || r.status === 403) && /42501|permission denied/i.test(b);
  for (const [fn, args] of Object.entries(calls)) {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
    const b = await r.text();
    let result;
    if (refused(r, b)) { result = 'BLOCKED'; blocked++; }
    else if (r.status === 404 && /PGRST202/.test(b)) { result = 'NOT INSTALLED'; notInstalled++; }
    else { result = 'OPEN!!'; open++; }
    rows.push({ check: fn, http: r.status, result, detail: result === 'OPEN!!' ? b.slice(0, 160) : '' });
  }
  const EDIT = { academy_certificates: '{"dealer_name":"probe"}' };   // a real column
  for (const t of ['academy_certificates']) {
    for (const [how, method, path, body] of [['read', 'GET', `${t}?select=id&limit=1`, null], ['insert', 'POST', t, '{}'],
         ['edit', 'PATCH', `${t}?id=eq.${Z}`, EDIT[t]], ['delete', 'DELETE', `${t}?id=eq.${Z}`, null]]) {
      const r = await fetch(`${URL}/rest/v1/${path}`, { method, headers: Object.assign({ Prefer: 'return=minimal' }, H), body: body || undefined });
      const b = await r.text(); const ok = refused(r, b);
      if (ok) blocked++; else open++;
      rows.push({ check: `(direct ${how}) ${t}`, http: r.status, result: ok ? 'BLOCKED' : 'OPEN!!', detail: ok ? '' : b.slice(0, 160) });
    }
  }
  console.table(rows);
  const n = Object.keys(calls).length;
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled === n ? `M7 NOT INSTALLED — the 5 functions are absent; the 4 table checks BLOCKED (key verified)`
    : notInstalled === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)`
    : `MIXED: ${notInstalled} not installed, ${blocked} blocked — M7 is partly installed; stop and send this table`);
})();
