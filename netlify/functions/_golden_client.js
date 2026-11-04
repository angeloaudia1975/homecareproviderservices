// HCPS → Golden signed server-to-server client (contract golden-commerce-v1, docs/contracts/).
// The ONLY way HCPS code calls Golden's /v1 API. Builds the request with the shared signing module
// (_golden_s2s.js, pinned by docs/contracts/golden-commerce-v1.lock.json) and never sends a dealer, account,
// branch, price or total of its own: who is acting travels only as the signed delegation.
// Env (Netlify, set by Angelo — never in the repo, never shown in chat):
//   GOLDEN_P360_KEY_ID   the key id Golden knows (integration_clients.kid)
//   GOLDEN_P360_SECRET   the shared secret (≥ 32 bytes; Golden holds the same value in HCPS_P360_KEYS)
//   GOLDEN_API_BASE      optional; default https://goldenonlineordering.netlify.app
// Preview environment (env:"preview"; Partner 360 deploy previews only — golden-proxy decides who may use it):
//   GOLDEN_P360_TEST_KEY_ID / GOLDEN_P360_TEST_SECRET  a SEPARATE test key that only Golden deploy previews accept
//   GOLDEN_TEST_API_BASE  must be a Golden deploy-preview address (https://deploy-preview-<n>--goldenonlineordering.netlify.app);
//                         anything else is ignored, so the test key can never be sent to production Golden.
//   The test key must differ from the production key (same id or same secret → treated as not configured).
// Not configured → { configured:false } and NO network call. Timeouts and network failures come back as
// { ok:false, status:0, error:"golden_unreachable" } — callers show "Golden not available", never stale data.
"use strict";
const S2S = require("./_golden_s2s.js");

const TIMEOUT_MS = 8000;
const base = () => String(process.env.GOLDEN_API_BASE || "https://goldenonlineordering.netlify.app").replace(/\/+$/, "");
const PREVIEW_BASE_RE = /^https:\/\/deploy-preview-\d+--goldenonlineordering\.netlify\.app$/;
function creds(envName){
  if(envName === "preview"){
    const kid = process.env.GOLDEN_P360_TEST_KEY_ID || "", secret = process.env.GOLDEN_P360_TEST_SECRET || "";
    const b = String(process.env.GOLDEN_TEST_API_BASE || "").replace(/\/+$/, "");
    const distinct = kid !== (process.env.GOLDEN_P360_KEY_ID || "") && secret !== (process.env.GOLDEN_P360_SECRET || "");
    return { kid, secret, base: PREVIEW_BASE_RE.test(b) ? b : "", usable: !!kid && S2S.secretUsable(secret) && PREVIEW_BASE_RE.test(b) && distinct };
  }
  const kid = process.env.GOLDEN_P360_KEY_ID || "", secret = process.env.GOLDEN_P360_SECRET || "";
  return { kid, secret, base: base(), usable: !!kid && S2S.secretUsable(secret) };
}
function configured(envName){ return creds(envName).usable; }

// delegation: { sub_dealer, sub_branch?, actor?, role }  → iat/exp/aud added here (90-second lifetime)
// idempotencyKey: Stage 4 order routes only (contract §6) — sent as the Idempotency-Key header, a UUID v4.
async function call({ method = "GET", path, query, body, delegation, env, idempotencyKey }){
  const c = creds(env);
  if(!c.usable) return { configured:false, ok:false, status:0, error:"golden_not_configured" };
  if(!/^\/v1\/[A-Za-z0-9/_-]+$/.test(String(path||""))) throw new Error("golden-client: bad path");
  const q = query || {};
  const bodyStr = body == null ? "" : JSON.stringify(body);
  let d = null;
  if(delegation){
    const now = Math.floor(Date.now()/1000);
    d = { sub_dealer: delegation.sub_dealer, sub_branch: delegation.sub_branch || null, actor: delegation.actor ? String(delegation.actor).slice(0,128) : null,
          role: delegation.role, aud: S2S.AUDIENCE, iat: now, exp: now + 90 };
  }
  const headers = S2S.sign({ kid: c.kid, secret: c.secret, method, path, query: q, body: bodyStr, delegation: d });
  if(bodyStr) headers["content-type"] = "application/json";
  if(idempotencyKey != null){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(idempotencyKey))) throw new Error("golden-client: bad idempotency key");
    headers["Idempotency-Key"] = String(idempotencyKey);
  }
  const qs = S2S.canonicalQuery(q);
  const ctrl = new AbortController(); const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(c.base + path + (qs ? "?" + qs : ""), { method, headers, body: bodyStr || undefined, signal: ctrl.signal, redirect: "error" });
    let json = null; try{ json = await r.json(); }catch(e){ json = null; }
    return { configured:true, ok: r.ok, status: r.status, json, error: r.ok ? null : ((json && json.error && json.error.code) || ("http_" + r.status)) };
  }catch(e){
    return { configured:true, ok:false, status:0, json:null, error:"golden_unreachable" };
  }finally{ clearTimeout(timer); }
}

module.exports = { call, configured, base, PREVIEW_BASE_RE };
