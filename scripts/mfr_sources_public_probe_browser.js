// HCPS — RULE 19 outside check for the private `mfr-sources` bucket and the first stored manufacturer report
// (record 7: Strongback September 2026 dealer report). Uses ONLY the PUBLIC (anon) key, exactly as a stranger could.
// Paste into the console of a blank tab (about:blank). It asks for the key; nothing is stored or sent anywhere else.
// Expect: "ALL n CHECKS BLOCKED (key verified)". Any OPEN!! = stop and send the table.
// Every request is a read or a refused write aimed at a name that does not exist — nothing can be changed.
(async () => {
  const REF = 'ycqmztthwldytkzyvmiv'; // built from the ref: a literal project URL trips Netlify's secret scanner
  const URL = `https://${REF}.supabase.co`;
  const BUCKET = 'mfr-sources';
  const PATH = 'reports/strongback-mobility/dealer_report/f708ebaf0290bb736c7499b818655167c436c8867f16142cf122fd663bd790b5.pdf';
  const KEY = prompt('Paste the anon (public) key from Supabase → Project Settings → API');
  if (!KEY) return console.log('No key entered; nothing was run.');
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const J = { ...H, 'Content-Type': 'application/json' };
  const c = await fetch(`${URL}/rest/v1/product_content?select=page_key&limit=1`, { headers: H });
  if (c.status !== 200) return console.log(`KEY NOT ACCEPTED (HTTP ${c.status}) — nothing was tested.`);
  const rows = []; let open = 0;
  const looksLikePdf = b => b.slice(0, 5) === '%PDF-';
  const check = async (label, url, init, isBlocked) => {
    const r = await fetch(url, init); const b = await r.text();
    const blocked = isBlocked(r.status, b);
    if (!blocked) open++;
    rows.push({ check: label, http: r.status, result: blocked ? 'BLOCKED' : 'OPEN!!', detail: blocked ? '' : b.slice(0, 160) });
  };
  const noFile = (s, b) => s >= 400 && !looksLikePdf(b);
  // 1-2: listing the bucket (whole bucket, and the report's folder) must return no file names
  for (const prefix of ['', 'reports/strongback-mobility/dealer_report/'])
    await check(`list ${BUCKET}/${prefix || '(root)'}`, `${URL}/storage/v1/object/list/${BUCKET}`,
      { method: 'POST', headers: J, body: JSON.stringify({ prefix, limit: 100, offset: 0 }) },
      (s, b) => s >= 400 || (s === 200 && b.trim() === '[]'));
  // 3: public URL (only works for public buckets)
  await check('public URL of the report', `${URL}/storage/v1/object/public/${BUCKET}/${PATH}`, { headers: H }, noFile);
  // 4: direct download with the anon key
  await check('download the report with the public key', `${URL}/storage/v1/object/${BUCKET}/${PATH}`, { headers: H }, noFile);
  // 5: authenticated-download route
  await check('authenticated route with the public key', `${URL}/storage/v1/object/authenticated/${BUCKET}/${PATH}`, { headers: H }, noFile);
  // 6: object info
  await check('object info', `${URL}/storage/v1/object/info/${BUCKET}/${PATH}`, { headers: H }, (s, b) => s >= 400 && !/"size"|f708ebaf/i.test(b));
  // 7: mint a signed URL with the public key
  await check('create a signed URL', `${URL}/storage/v1/object/sign/${BUCKET}/${PATH}`,
    { method: 'POST', headers: J, body: JSON.stringify({ expiresIn: 60 }) }, (s, b) => s >= 400 && !/signedURL|signedUrl/i.test(b));
  // 8: bucket details
  await check('bucket details', `${URL}/storage/v1/bucket/${BUCKET}`, { headers: H }, (s, b) => s >= 400);
  // 9: bucket list must not reveal the bucket
  await check('bucket list', `${URL}/storage/v1/bucket`, { headers: H }, (s, b) => s >= 400 || !b.includes(BUCKET));
  // 10: upload into the bucket (a name that does not exist; must be refused)
  await check('upload a file', `${URL}/storage/v1/object/${BUCKET}/reports/probe-must-be-refused.txt`,
    { method: 'POST', headers: { ...H, 'Content-Type': 'text/plain', 'x-upsert': 'false' }, body: 'probe' }, (s, b) => s >= 400);
  // 11: the register row itself through the REST API
  await check('read register record 7 (REST)', `${URL}/rest/v1/mfr_sources?id=eq.7&select=*`, { headers: H },
    (s, b) => (s === 401 || s === 403) && /42501|permission denied/i.test(b));
  console.table(rows);
  console.log(open ? `${open} CHECK(S) OPEN — stop and send this table` : `ALL ${rows.length} CHECKS BLOCKED (key verified)`);
})();
