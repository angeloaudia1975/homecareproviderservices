// HCPS Academy — A2B M5 external probe (browser console). Uses ONLY the PUBLIC key, as a stranger could.
// Paste into the console of a blank tab (about:blank); it asks for the public key, stores nothing, sends nothing elsewhere.
// Calls all 21 M5 functions through the public API with correctly named arguments (so "not found" can only mean the
// function is not installed, never a wrong signature), then tries a direct read, insert, edit and delete on the two new
// tables. Every argument is a random id / an address on example.invalid: even a broken permission could only reach "not found".
//   Before M5: the 21 function lines say NOT INSTALLED (the tables do not exist yet).
//   After M5: every line must say BLOCKED.   OPEN!! = stop and report.
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
    academy_access_norm_email: { p: E },
    academy_access_is_staff: { p_email: E },
    academy_access_in_family: { p_tm_dealer: Z, p_dealer: Z },
    academy_access_actor: { p_actor: A, p_dealer: Z },
    academy_access_actor_type: { p_actor: A },
    academy_access_end_sessions: { p_learner: Z, p_reason: 'probe' },
    academy_access_new_session: { p_learner: Z, p_via: 'code', p_ip_hash: X },
    academy_access_op_request_code: { p_email: E, p_code_hash: X, p_ip_hash: X },
    academy_access_op_verify_code: { p_email: E, p_code_hash: X, p_ip_hash: X },
    academy_access_op_code_undelivered: { p_code_id: Z, p_code_hash: X },
    academy_access_op_handoff_mint: { p_auth_user_id: Z, p_code_hash: X },
    academy_access_op_handoff_redeem: { p_code_hash: X, p_ip_hash: X },
    academy_access_op_end_session: { p_actor: A, p_session_id: Z },
    academy_access_op_invite: { p_actor: A, p_dealer_id: Z, p_email: E, p_full_name: 'probe', p_role: 'learner' },
    academy_access_op_revoke_invite: { p_actor: A, p_invite_id: Z, p_reason: 'probe' },
    academy_access_op_deactivate: { p_actor: A, p_membership_id: Z, p_reason: 'probe' },
    academy_access_op_reactivate: { p_actor: A, p_learner_id: Z, p_dealer_id: Z },
    academy_access_op_set_learner_status: { p_actor: A, p_learner_id: Z, p_status: 'active', p_reason: 'probe' },
    academy_enroll_op_enroll: { p_actor: A, p_learner_id: Z, p_version_id: Z, p_due_on: null },
    academy_enroll_op_withdraw: { p_actor: A, p_enrollment_id: Z, p_reason: 'probe' },
    academy_progress_op_save: { p_actor: A, p_enrollment_id: Z, p_lesson_id: Z, p_status: 'viewed', p_resume_block: 0 },
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
  const EDIT = { academy_login_codes: '{"tries":1}', academy_sessions: '{"ended_reason":"probe"}' };   // real columns
  for (const t of ['academy_login_codes', 'academy_sessions']) {
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
  console.log(open && notInstalled === n ? `M5 NOT INSTALLED — the 21 functions and the 2 tables are absent (key verified)`
    : open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)`
    : `MIXED: ${notInstalled} not installed, ${blocked} blocked — M5 is partly installed; stop and send this table`);
})();
