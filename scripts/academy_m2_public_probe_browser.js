// HCPS Academy — A2C M2 external probe (browser console). Uses ONLY the PUBLIC key, as a stranger could.
// Paste into the console of a blank tab (about:blank); it asks for the public key, stores nothing, sends nothing elsewhere.
// Calls every M2 function through the public API with correctly named arguments (so "not found" can only mean the
// function is not installed, never a wrong signature), then tries a direct insert, edit and delete on each of the four
// content tables. Every argument is a random id / harmless text: even a broken permission could only reach "not found".
//   Before M2: every function line says NOT INSTALLED (the table lines say BLOCKED already: A1 grants the public key nothing).
//   After M2: every line must say BLOCKED.   OPEN!! = stop and report.
(async () => {
  const REF = 'ycqmztthwldytkzyvmiv';                       // built from the ref (Netlify's secret scanner, see A1 probe)
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the public (publishable / anon) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — not the right public key; nothing was tested.`);
  const Z = '00000000-0000-0000-0000-000000000000', A = 'staff:probe@example.invalid';
  const calls = {
    // internal helpers (owner only)
    academy_content_actor_president: { p_actor: A },
    academy_content_lock_draft: { p_version_id: Z },
    academy_content_keys: { p: {}, p_allowed: [] },
    // the 11 operations (server role only)
    academy_content_op_create_course: { p_actor: A, p_id: Z, p_course: { slug: 'probe-course', title: 'probe', course_type: 'training' } },
    academy_content_op_update_course: { p_actor: A, p_id: Z, p_changes: { title: 'probe' } },
    academy_content_op_create_version: { p_actor: A, p_id: Z, p_course_id: Z, p_settings: {} },
    academy_content_op_update_version: { p_actor: A, p_id: Z, p_changes: { pass_mark: 80 } },
    academy_content_op_move_version: { p_actor: A, p_id: Z, p_to: 'in_review' },
    academy_content_op_create_module: { p_actor: A, p_id: Z, p_version_id: Z, p_module: { title: 'probe' } },
    academy_content_op_update_module: { p_actor: A, p_id: Z, p_changes: { title: 'probe' } },
    academy_content_op_delete_module: { p_actor: A, p_id: Z },
    academy_content_op_create_lesson: { p_actor: A, p_id: Z, p_module_id: Z, p_lesson: { title: 'probe' } },
    academy_content_op_update_lesson: { p_actor: A, p_id: Z, p_changes: { title: 'probe' } },
    academy_content_op_delete_lesson: { p_actor: A, p_id: Z },
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
  // Direct writes on the four content tables (insert, edit, delete), as the public key.
  for (const t of ['academy_courses', 'academy_course_versions', 'academy_modules', 'academy_lessons']) {
    for (const [how, method, path, body] of [['insert', 'POST', t, '{}'], ['edit', 'PATCH', `${t}?id=eq.${Z}`, '{"title":"probe"}'], ['delete', 'DELETE', `${t}?id=eq.${Z}`, null]]) {
      const r = await fetch(`${URL}/rest/v1/${path}`, { method, headers: Object.assign({ Prefer: 'return=minimal' }, H), body: body || undefined });
      const b = await r.text(); const ok = refused(r, b);
      if (ok) blocked++; else open++;
      rows.push({ check: `(direct ${how}) ${t}`, http: r.status, result: ok ? 'BLOCKED' : 'OPEN!!', detail: ok ? '' : b.slice(0, 160) });
    }
  }
  console.table(rows);
  const n = Object.keys(calls).length;
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table`
    : notInstalled === n ? `M2 NOT INSTALLED — all ${n} functions absent; the 12 direct writes BLOCKED (key verified)`
    : notInstalled === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)`
    : `MIXED: ${notInstalled} not installed, ${blocked} blocked — M2 is partly installed; stop and send this table`);
})();
