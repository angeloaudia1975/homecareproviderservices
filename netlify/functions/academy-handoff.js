/* HCPS Academy — Partner 360 entry (A2A shell). The single-use entry code is built in A2B, after its security review
   is approved. Until then:
     GET/POST {action:"status"} -> {enabled:false}   (Partner 360 shows no Training button)
     anything else              -> 403 flag_off       (nothing is minted or redeemed)
   Partner 360's origin is allowed to read the status answer; nothing here creates or accepts any credential. */
const A = require('./_academy.js');
const OPTS = { origins: A.SITE_ORIGINS.concat(A.PARTNER360_ORIGINS) };

exports.handler = A.handler(async event => {
  const b = event.httpMethod === 'GET' ? Object.assign({}, event.queryStringParameters || {}) : A.body(event);
  if (String(b.action || 'status') === 'status') return A.respond(event, 200, { enabled: false }, OPTS);
  return A.respond(event, 403, { error: 'flag_off', message: 'Academy entry from Partner 360 is not available yet.' }, OPTS);
}, OPTS);
