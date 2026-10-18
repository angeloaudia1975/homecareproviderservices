// A2B activation gate — client-IP proof on the REAL Netlify edge (browser console, on the throwaway deploy preview).
// Paste into the console of https://deploy-preview-<N>--homecareproviderservices.netlify.app/ (same origin, so the
// forged headers really reach Netlify). PASS = x-nf-client-connection-ip is the same real address in every row and
// never equals any forged value.
(async () => {
  const U = '/.netlify/functions/academy-ip-echo';
  const FORGED = '203.0.113.66';
  const tries = [
    ['no extra headers', {}],
    ['forged x-nf-client-connection-ip', { 'x-nf-client-connection-ip': FORGED }],
    ['forged x-forwarded-for', { 'x-forwarded-for': FORGED }],
    ['forged client-ip + x-real-ip', { 'client-ip': FORGED, 'x-real-ip': FORGED }],
    ['all forged together', { 'x-nf-client-connection-ip': FORGED, 'x-forwarded-for': FORGED, 'client-ip': FORGED }],
  ];
  const rows = [];
  for (const [name, headers] of tries) {
    const r = await fetch(U, { headers, cache: 'no-store' }); const j = await r.json();
    rows.push({ test: name, http: r.status, 'x-nf-client-connection-ip': j['x-nf-client-connection-ip'], 'x-forwarded-for': j['x-forwarded-for'], 'client-ip': j['client-ip'] });
  }
  console.table(rows);
  const real = rows[0]['x-nf-client-connection-ip'];
  const ok = real && !String(real).includes(FORGED) && rows.every(x => x['x-nf-client-connection-ip'] === real);
  console.log(ok ? `PASS — Netlify sets x-nf-client-connection-ip itself (${real}); a visitor cannot change it`
                 : 'FAIL — the client-address header can be influenced by the visitor; do NOT activate learner sign-in. Send this table.');
})();
