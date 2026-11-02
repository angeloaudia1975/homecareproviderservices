// HCPS → Golden signed server-to-server client (contract golden-commerce-v1, docs/contracts/).
// The ONLY way HCPS code calls Golden's /v1 API. Builds the request with the shared signing module
// (_golden_s2s.js, pinned by docs/contracts/golden-commerce-v1.lock.json) and never sends a dealer, account,
// branch, price or total of its own: who is acting travels only as the signed delegation.
// Env (Netlify, set by Angelo — never in the repo, never shown in chat):
//   GOLDEN_P360_KEY_ID   the key id Golden knows (integration_clients.kid)
//   GOLDEN_P360_SECRET   the shared secret (≥ 32 bytes; Golden holds the same value in HCPS_P360_KEYS)
//   GOLDEN_API_BASE      optional; default https://goldenonlineordering.netlify.app
// Not configured → { configured:false } and NO network call. Timeouts and network failures come back as
// { ok:false, status:0, error:"golden_unreachable" } — callers show "Golden not available", never stale data.
"use strict";
const S2S = require("./_golden_s2s.js");

const TIMEOUT_MS = 8000;
const base = () => String(process.env.GOLDEN_API_BASE || "https://goldenonlineordering.netlify.app").replace(/\/+$/, "");
function configured(){ return !!process.env.GOLDEN_P360_KEY_ID && S2S.secretUsable(process.env.GOLDEN_P360_SECRET || ""); }

// delegation: { sub_dealer, sub_branch?, actor?, role }  → iat/exp/aud added here (90-second lifetime)
async function call({ method = "GET", path, query, body, delegation }){
  if(!configured()) return { configured:false, ok:false, status:0, error:"golden_not_configured" };
  if(!/^\/v1\/[a-z0-9/_-]+$/.test(String(path||""))) throw new Error("golden-client: bad path");
  const q = query || {};
  const bodyStr = body == null ? "" : JSON.stringify(body);
  let d = null;
  if(delegation){
    const now = Math.floor(Date.now()/1000);
    d = { sub_dealer: delegation.sub_dealer, sub_branch: delegation.sub_branch || null, actor: delegation.actor ? String(delegation.actor).slice(0,128) : null,
          role: delegation.role, aud: S2S.AUDIENCE, iat: now, exp: now + 90 };
  }
  const headers = S2S.sign({ kid: process.env.GOLDEN_P360_KEY_ID, secret: process.env.GOLDEN_P360_SECRET, method, path, query: q, body: bodyStr, delegation: d });
  if(bodyStr) headers["content-type"] = "application/json";
  const qs = S2S.canonicalQuery(q);
  const ctrl = new AbortController(); const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(base() + path + (qs ? "?" + qs : ""), { method, headers, body: bodyStr || undefined, signal: ctrl.signal, redirect: "error" });
    let json = null; try{ json = await r.json(); }catch(e){ json = null; }
    return { configured:true, ok: r.ok, status: r.status, json, error: r.ok ? null : ((json && json.error && json.error.code) || ("http_" + r.status)) };
  }catch(e){
    return { configured:true, ok:false, status:0, json:null, error:"golden_unreachable" };
  }finally{ clearTimeout(timer); }
}

module.exports = { call, configured, base };
