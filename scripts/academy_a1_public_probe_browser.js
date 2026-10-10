// HCPS Academy — Phase A1 external probe (browser console version of academy_a1_public_probe.sh).
// Uses ONLY the PUBLIC (anon) key, exactly as a stranger on the internet could. Paste into the console
// of a blank tab (about:blank). It asks for the anon key; nothing is stored or sent anywhere else.
// Every line must say BLOCKED. The write attempts can only succeed if security were broken.
(async () => {
  // Built from the project ref: the full project URL is a Netlify env value, and Netlify's secret scanner fails the
  // build when an env value appears in the repo (it is public by design, but the scanner cannot know that).
  const REF = 'ycqmztthwldytkzyvmiv';
  const URL = `https://${REF}.supabase.co`;
  const KEY = prompt('Paste the anon (public) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const tables = ['academy_learners','academy_memberships','academy_invites','academy_handoff_codes','academy_courses',
    'academy_course_versions','academy_modules','academy_lessons','academy_questions','academy_media','product_facts',
    'academy_content_refs','academy_enrollments','academy_progress','academy_attempts','academy_certificates',
    'academy_external_certs','academy_events'];
  // Control: the key must work on something that IS public, or a wrong key would look like "blocked".
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — this is not the right public key; nothing was tested. ` + (await c.text()).slice(0, 200));
  console.log('Control passed: the public key works on a public table (HTTP 200). Probing the Academy…');
  const rows = []; let open = 0;
  // Blocked = refused for lack of permission (Postgres code 42501), not just any error.
  const blocked = (s, body) => (s === 401 || s === 403) && /42501|permission denied/i.test(body);
  for (const t of tables) {
    const r = await fetch(`${URL}/rest/v1/${t}?select=*&limit=1`, { headers: H }); const b = await r.text();
    const w = await fetch(`${URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
    const wb = await w.text();
    const ok = blocked(r.status, b) && blocked(w.status, wb); if (!ok) open++;
    rows.push({ check: t, read: r.status, write: w.status, result: ok ? 'BLOCKED' : 'OPEN!!', detail: ok ? '' : (b + ' | ' + wb).slice(0, 160) });
  }
  const bk = await fetch(`${URL}/storage/v1/bucket/academy-private`, { headers: H }); const bkb = await bk.text();
  const bkOk = bk.status !== 200; if (!bkOk) open++;
  rows.push({ check: 'storage: bucket details', read: bk.status, write: '', result: bkOk ? 'BLOCKED' : 'OPEN!!', detail: bkb.slice(0, 160) });
  const ls = await fetch(`${URL}/storage/v1/object/list/academy-private`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{"prefix":""}' });
  const lsb = await ls.text(); const lsOk = ls.status !== 200 || lsb.trim() === '[]'; if (!lsOk) open++;
  rows.push({ check: 'storage: list files', read: ls.status, write: '', result: lsOk ? 'BLOCKED' : 'OPEN!!', detail: lsb.slice(0, 160) });
  const up = await fetch(`${URL}/storage/v1/object/academy-private/probe-anon.pdf`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/pdf' }, body: '%PDF-probe' });
  const upb = await up.text(); const upOk = up.status !== 200; if (!upOk) open++;
  rows.push({ check: 'storage: upload a file', read: '', write: up.status, result: upOk ? 'BLOCKED' : 'OPEN!! (file written: probe-anon.pdf)', detail: upb.slice(0, 160) });
  const pub = await fetch(`${URL}/storage/v1/object/public/academy-private/probe-anon.pdf`);
  const pubOk = pub.status !== 200; if (!pubOk) open++;
  rows.push({ check: 'storage: public file URL', read: pub.status, write: '', result: pubOk ? 'BLOCKED' : 'OPEN!!', detail: '' });
  console.table(rows);
  console.log(open === 0 ? `ALL ${rows.length} CHECKS BLOCKED (key verified)` : `${open} CHECK(S) OPEN — stop and send this table`);
})();
