// HCPS Academy — A2A M1 (rev 2) external probe (browser console). Uses ONLY the PUBLIC key, as a stranger could.
// Paste into the console of a blank tab (about:blank); it asks for the public key, stores nothing, sends nothing elsewhere.
// Calls every M1 function through the public API with correctly named arguments (so "not found" can only mean the
// function is not installed, never a wrong signature). Every argument is a random id / harmless text: even a broken
// permission could only reach "record not found".
//   Before M1: every line must say NOT INSTALLED.   After M1: every line must say BLOCKED.   OPEN!! = stop and report.
(async () => {
  const REF = 'ycqmztthwldytkzyvmiv';                       // built from the ref (Netlify's secret scanner, see A1 probe)
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the public (publishable / anon) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — not the right public key; nothing was tested.`);
  const Z = '00000000-0000-0000-0000-000000000000';
  const calls = {
    // internal helpers (owner only)
    academy_op_begin: { p_op: 'probe', p_actor: 'probe' },
    academy_op_end: {},
    academy_op_audit: { p_actor_type: 'system', p_actor: 'probe', p_entity: 'probe', p_entity_id: 'probe', p_action: 'probe', p_before: null, p_after: null },
    academy_op_norm_answer: { p: '"a"' },
    academy_op_actor_staff: { p_actor: 'staff:probe@example.invalid' },
    academy_op_actor_learner: { p_actor: 'learner:' + Z, p_learner_id: Z },
    academy_op_attempt_check: { p_enrollment_id: Z, p_question_ids: [Z], p_for: 'start' },
    // the 11 operations (server role only)
    academy_op_set_training_manager: { p_actor: 'probe', p_membership_id: Z, p_make: true, p_reason: 'probe' },
    academy_op_review_external_cert: { p_actor: 'probe', p_id: Z, p_decision: 'rejected', p_evidence_type: null, p_evidence_ref: null, p_note: 'probe' },
    academy_op_issue_certificate: { p_actor: 'probe', p_attempt_id: Z, p_dealer_name: 'probe' },
    academy_op_revoke_certificate: { p_actor: 'probe', p_certificate_id: Z, p_reason: 'probe' },
    academy_op_publish_version: { p_actor: 'probe', p_version_id: Z },
    academy_op_retire_version: { p_actor: 'probe', p_version_id: Z, p_reason: 'probe' },
    academy_op_start_attempt: { p_actor: 'probe', p_enrollment_id: Z },
    academy_op_submit_attempt: { p_actor: 'probe', p_attempt_id: Z, p_answers: {} },
    academy_op_correct_attempt: { p_actor: 'probe', p_attempt_id: Z, p_score: 0, p_reason: 'probe' },
    academy_op_record_fact: { p_actor: 'probe', p_fact: {}, p_supersedes: null, p_approved_by: null },
    academy_op_withdraw_fact: { p_actor: 'probe', p_fact_id: Z, p_reason: 'probe' },
  };
  const rows = []; let open = 0, notInstalled = 0, blocked = 0;
  for (const [fn, args] of Object.entries(calls)) {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
    const b = await r.text();
    let result;
    if ((r.status === 401 || r.status === 403) && /42501|permission denied/i.test(b)) { result = 'BLOCKED'; blocked++; }
    else if (r.status === 404 && /PGRST202/.test(b)) { result = 'NOT INSTALLED'; notInstalled++; }
    else { result = 'OPEN!!'; open++; }
    rows.push({ function: fn, http: r.status, result, detail: result === 'OPEN!!' ? b.slice(0, 160) : '' });
  }
  // The guard trigger function is never callable as an RPC; a direct table write must still be refused.
  const w = await fetch(`${URL}/rest/v1/academy_certificates`, { method: 'POST', headers: H, body: '{}' }); const wb = await w.text();
  const wOk = (w.status === 401 || w.status === 403) && /42501|permission denied/i.test(wb); if (!wOk) open++; else blocked++;
  rows.push({ function: '(direct write) academy_certificates', http: w.status, result: wOk ? 'BLOCKED' : 'OPEN!!', detail: wOk ? '' : wb.slice(0, 160) });
  console.table(rows);
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled === Object.keys(calls).length ? 'M1 NOT INSTALLED — all 18 functions absent; direct write BLOCKED (key verified)'
    : notInstalled === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)`
    : `MIXED: ${notInstalled} not installed, ${blocked} blocked — M1 is partly installed; stop and send this table`);
})();
