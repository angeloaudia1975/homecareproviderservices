// HCPS Academy — A2E M6 external probe (browser console). Uses ONLY the PUBLIC key, as a stranger could.
// Paste into the console of a blank tab (about:blank); it asks for the public key, stores nothing, sends nothing elsewhere.
// Calls the 9 callable M6 functions (the 10th is a trigger function, which the API cannot call at all) through the public API with correctly named arguments (so "not found" can only mean the
// function is not installed, never a wrong signature), then tries a direct read, insert, edit and delete on
// academy_attempts. Every argument is a random id / an address on example.invalid: even a broken permission could only reach "not found".
//   Before M6: the 9 function lines say NOT INSTALLED (the 4 table lines say BLOCKED already).
//   After M6: all 13 lines must say BLOCKED.   OPEN!! = stop and report.
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
    academy_exam_enrollment: { p_actor: A, p_enrollment_id: Z },
    academy_exam_clean_answers: { p_answers: {}, p_ids: [Z] },
    academy_exam_expire: { p_learner: Z },
    academy_exam_limits: { p_learner: Z, p_enrollment: null, p_now: '2026-01-01T00:00:00Z' },
    academy_exam_op_status: { p_actor: A, p_enrollment_id: Z },
    academy_exam_op_start: { p_actor: A, p_enrollment_id: Z },
    academy_exam_op_view: { p_actor: A, p_attempt_id: Z },
    academy_exam_op_save: { p_actor: A, p_attempt_id: Z, p_answers: {} },
    academy_exam_op_submit: { p_actor: A, p_attempt_id: Z, p_answers: {} },
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
  const EDIT = { academy_attempts: '{"draft_answers":{}}' };   // a real column
  for (const t of ['academy_attempts']) {
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
    : notInstalled === n ? `M6 NOT INSTALLED — the 9 functions are absent; the 4 table checks BLOCKED (key verified)`
    : notInstalled === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)`
    : `MIXED: ${notInstalled} not installed, ${blocked} blocked — M6 is partly installed; stop and send this table`);
})();
