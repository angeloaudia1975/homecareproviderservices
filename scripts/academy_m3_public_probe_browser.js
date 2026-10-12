// HCPS Academy — A2D M3 external probe (browser console). Uses ONLY the PUBLIC key, as a stranger could.
// Paste into the console of a blank tab (about:blank); it asks for the public key, stores nothing, sends nothing elsewhere.
// Calls every callable M3 function (12 operations, 10 helpers) and M1's start-attempt (changed by M3) through the public
// API with correctly named arguments (so "not found" can only mean the function is not installed, never a wrong
// signature), then tries a direct insert, edit and delete on questions, media and fact links. Every argument is a random
// id / harmless text: even a broken permission could only reach "not found".
//   Before M3: the 22 M3 function lines say NOT INSTALLED; start-attempt and the 9 table lines say BLOCKED already.
//   After M3: every line must say BLOCKED.   OPEN!! = stop and report.
(async () => {
  const REF = 'ycqmztthwldytkzyvmiv';                       // built from the ref (Netlify's secret scanner, see A1 probe)
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the public (publishable / anon) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — not the right public key; nothing was tested.`);
  const Z = '00000000-0000-0000-0000-000000000000', A = 'staff:probe@example.invalid';
  const m3 = {
    // internal helpers (owner only)
    academy_author_text: { p: 'probe', p_what: 'probe', p_min: 0, p_max: 10 },
    academy_author_url: { p: 'https://example.invalid', p_what: 'probe', p_required: false },
    academy_author_uuid: { p: Z, p_what: 'probe' },
    academy_author_model: { p: 'PROBE' },
    academy_author_alt: { p: 'a probe description', p_what: 'probe' },
    academy_author_media_ref: { p: Z, p_kinds: ['image'] },
    academy_author_check_question: { p_version_id: Z, q: {}, p_self: Z },
    academy_author_check_media: { p_actor: A, m: {} },
    academy_author_check_blocks: { p_lesson_id: Z, p_version_id: Z, p_blocks: [] },
    academy_author_exam_draw: { p_version_id: Z, p_strict: false },
    // the 12 operations (server role only)
    academy_author_op_set_blocks: { p_actor: A, p_lesson_id: Z, p_blocks: [] },
    academy_author_op_reorder_modules: { p_actor: A, p_version_id: Z, p_order: [Z] },
    academy_author_op_reorder_lessons: { p_actor: A, p_module_id: Z, p_order: [Z] },
    academy_author_op_set_exam_distribution: { p_actor: A, p_version_id: Z, p_quotas: {} },
    academy_author_op_create_question: { p_actor: A, p_id: Z, p_version_id: Z, p_question: {} },
    academy_author_op_update_question: { p_actor: A, p_id: Z, p_changes: { prompt: 'probe' } },
    academy_author_op_set_question_status: { p_actor: A, p_id: Z, p_status: 'retired', p_reason: 'probe' },
    academy_author_op_create_media: { p_actor: A, p_id: Z, p_media: {} },
    academy_author_op_update_media: { p_actor: A, p_id: Z, p_changes: { alt_text: 'probe' } },
    academy_author_op_delete_media: { p_actor: A, p_id: Z },
    academy_author_op_link_fact: { p_actor: A, p_id: Z, p_link: {} },
    academy_author_op_unlink_fact: { p_actor: A, p_id: Z },
  };
  const calls = Object.assign({}, m3, { academy_op_start_attempt: { p_actor: 'learner:' + Z, p_enrollment_id: Z } });
  const rows = []; let open = 0, notInstalled = 0, blocked = 0;
  const refused = (r, b) => (r.status === 401 || r.status === 403) && /42501|permission denied/i.test(b);
  for (const [fn, args] of Object.entries(calls)) {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
    const b = await r.text();
    let result;
    if (refused(r, b)) { result = 'BLOCKED'; blocked++; }
    else if (r.status === 404 && /PGRST202/.test(b) && fn in m3) { result = 'NOT INSTALLED'; notInstalled++; }
    else { result = 'OPEN!!'; open++; }
    rows.push({ check: fn, http: r.status, result, detail: result === 'OPEN!!' ? b.slice(0, 160) : '' });
  }
  // Direct writes on the three tables M3 guards (insert, edit, delete), as the public key. Each edit names a column the
  // table really has: an unknown column is refused by the API before the database is asked (PGRST204), proving nothing.
  const EDIT = { academy_questions: '{"prompt":"probe"}', academy_media: '{"alt_text":"probe"}', academy_content_refs: '{"model_code":"PROBE"}' };
  for (const t of Object.keys(EDIT)) {
    for (const [how, method, path, body] of [['insert', 'POST', t, '{}'], ['edit', 'PATCH', `${t}?id=eq.${Z}`, EDIT[t]], ['delete', 'DELETE', `${t}?id=eq.${Z}`, null]]) {
      const r = await fetch(`${URL}/rest/v1/${path}`, { method, headers: Object.assign({ Prefer: 'return=minimal' }, H), body: body || undefined });
      const b = await r.text(); const ok = refused(r, b);
      if (ok) blocked++; else open++;
      rows.push({ check: `(direct ${how}) ${t}`, http: r.status, result: ok ? 'BLOCKED' : 'OPEN!!', detail: ok ? '' : b.slice(0, 160) });
    }
  }
  console.table(rows);
  const n = Object.keys(m3).length;
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled === n ? `M3 NOT INSTALLED — all ${n} M3 functions absent; start-attempt and the 9 direct writes BLOCKED (key verified)`
    : notInstalled === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)`
    : `MIXED: ${notInstalled} not installed, ${blocked} blocked — M3 is partly installed; stop and send this table`);
})();
