/* TEMPORARY DIAGNOSTIC — NEVER MERGE TO MAIN. Copy to netlify/functions/academy-ip-echo.js on a throwaway branch only
   (see README.md). Answers which client-address headers Netlify's edge delivered to a function, so the A2B activation
   gate can prove from the REAL edge that a visitor cannot set x-nf-client-connection-ip. Returns header values only
   for the address-related headers; no secrets, no body, no storage. */
const NAMES = ['x-nf-client-connection-ip', 'x-forwarded-for', 'client-ip', 'x-real-ip', 'x-nf-request-id', 'x-country'];
exports.handler = async event => {
  const h = event.headers || {};
  const seen = Object.fromEntries(NAMES.map(n => [n, h[n] == null ? null : String(h[n]).slice(0, 200)]));
  return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-nf-client-connection-ip, x-forwarded-for, client-ip, x-real-ip' }, body: JSON.stringify(seen) };
};
