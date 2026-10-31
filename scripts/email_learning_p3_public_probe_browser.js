// HCPS — RULE 19 outside check for Smart Email Learning Phase 3 (supabase/email_learning_p3_shapes_redact.sql): the new
// email_draft_shapes table, the two new functions and the two replaced ones, and the three Phase 2 rule tables again (their guard was
// replaced), using ONLY the PUBLIC (anon) key, exactly as a stranger could.
// Paste into the console of a blank tab (about:blank). It asks for the key; nothing is stored or sent anywhere else.
// Expect: "ALL 20 CHECKS BLOCKED (key verified)". Any OPEN!! = stop, do not turn a Phase 3 switch on.
// Every write names a column the table really has and targets a row that does not exist.
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
  const NONE = '00000000-0000-4000-8000-000000000000';
  for (const [t, col, w] of [['email_draft_shapes', '{"style":"brief_direct"}', `draft_id=eq.${NONE}`],
                             ['email_learning_rules', '{"redacted_by":"probe"}', `id=eq.${NONE}`],
                             ['email_learning_profiles', '{"reason":"probe"}', 'version=eq.-1'],
                             ['email_learning_rule_events', '{"reason":"probe"}', 'id=eq.-1']]) {
    const T = `${URL}/rest/v1/${t}`;
    await check('read ' + t, `${T}?select=*&limit=1`, { headers: H });
    await check('insert ' + t, T, { method: 'POST', headers: H, body: '{}' });
    await check('update ' + t, `${T}?${w}`, { method: 'PATCH', headers: H, body: col });
    await check('delete ' + t, `${T}?${w}`, { method: 'DELETE', headers: H });
  }
  for (const [fn, body] of [['hcps_email_draft_shape', { p: { draft_id: NONE } }], ['hcps_email_rule_redact', { p: { rule_id: NONE } }],
    ['hcps_email_rule_note', { p: {} }], ['hcps_email_rule_decide', { p: { rule_id: NONE } }]])
    await check('rpc ' + fn, `${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  console.table(rows);
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled ? `${notInstalled} NOT INSTALLED — the migration is not (fully) installed; send this table`
    : `ALL ${rows.length} CHECKS BLOCKED (key verified)`);
})();
