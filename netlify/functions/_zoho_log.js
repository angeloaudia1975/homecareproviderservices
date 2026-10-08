// Phase 2F-1 — Zoho sync failure records (security + observability). SERVER-SIDE ONLY.
//
// Every Zoho sync step that used to swallow an error now records it here as its own row in
// zoho_sync_log (result "fail"), one row per failed record, with the full reason — so nothing
// fails silently and nothing is cut to fit a summary. The run that hit it is marked "partial".
//
// Nothing secret is ever stored: redact() drops any field whose NAME looks like a credential
// (secret / token / auth / password / api key / signature / cookie) and replaces any VALUE that
// contains one of this deployment's own secrets (webhook secret, Zoho client secret, service key).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const SENSITIVE = /secret|token|auth|passw|api[-_ ]?key|signature|credential|cookie/i;
const DETAIL_MAX = 8000;   // per failed record — generous; the summary row no longer carries details
const REDACTED = "[redacted]";

function secrets(){
  // 2F-3: the webhook header secret (ZOHO_WEBHOOK_HEADER_SECRET) and, while it is still set, the retired one.
  return [process.env.ZOHO_WEBHOOK_HEADER_SECRET, process.env.ZOHO_WEBHOOK_SECRET, process.env.ZOHO_CLIENT_SECRET, process.env.SUPABASE_SERVICE_ROLE]
    .map(s => String(s || "")).filter(s => s.length >= 6);
}
// 2F-1.1: besides this deployment's own secret values, anything SHAPED like a credential is masked
// wherever it appears in text (error messages, Zoho/database replies, stack traces): an
// Authorization header value, a Zoho OAuth token (1000.<hex>.<hex>), a JWT (the Supabase keys are
// JWTs), a Supabase secret key, and the value of any secret/token/password/api-key/authorization
// pair written as name=value, name: value or "name":"value". Business text is left as it is.
const SHAPES = [
  [/\b(Bearer|Basic|Zoho-oauthtoken)\s+[A-Za-z0-9._~+\/=-]{16,}/gi, "$1 " + REDACTED],
  [/\b1000\.[0-9a-f]{16,}\.[0-9a-f]{16,}\b/gi, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/(\b[A-Za-z_-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|authorization)\b)("?\s*[=:]\s*"?)(?!\[redacted\])[^\s&"',;}\]]+/gi, "$1$2" + REDACTED],
];
function scrubString(s){
  let out = String(s);
  for(const sec of secrets()) if(out.includes(sec)) out = out.split(sec).join(REDACTED);
  for(const [re, to] of SHAPES) out = out.replace(re, to);
  return out;
}
// Deep copy with credential-named keys removed and secret values masked.
function redact(v, depth){
  depth = depth || 0;
  if(v == null) return v;
  if(typeof v === "string") return scrubString(v);
  if(typeof v !== "object") return v;
  if(depth > 8) return "[nested]";
  if(Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  const out = {};
  for(const [k, x] of Object.entries(v)){ if(SENSITIVE.test(k)) continue; out[k] = redact(x, depth + 1); }
  return out;
}
const str = v => v == null ? null : String(v);

// One failure row. Every row carries the same keys (PostgREST bulk inserts require it).
function failRow(f){
  const detail = redact(Object.assign({ phase: f.phase || null, msg: f.msg == null ? null : String(f.msg) }, f.extra || {}, f.run ? { run: f.run } : {}));
  let text = JSON.stringify(detail);
  if(text.length > DETAIL_MAX) text = JSON.stringify(Object.assign({}, detail, { msg: String(detail.msg || "").slice(0, DETAIL_MAX - 400), msg_cut: true }));
  return {
    direction: f.direction || "out",
    entity: str(f.entity) || "sync",
    entity_id: str(f.entity_id),
    dealer_id: str(f.dealer_id),
    action: str(f.action) || "sync",
    result: "fail",
    detail: text,
    zoho_id: str(f.zoho_id),
  };
}

// Insert log rows (failures or anything else). Never throws; reports what it couldn't write.
async function writeLog(rows){
  rows = (rows || []).filter(Boolean);
  let written = 0, lost = 0;
  for(let i = 0; i < rows.length; i += 200){
    const chunk = rows.slice(i, i + 200);
    try{
      const r = await fetch(`${SUPABASE_URL}/rest/v1/zoho_sync_log`, { method:"POST",
        headers:{ apikey:SERVICE_ROLE, Authorization:`Bearer ${SERVICE_ROLE}`, "content-type":"application/json", Prefer:"return=minimal" },
        body: JSON.stringify(chunk) });
      if(r.ok) written += chunk.length; else { lost += chunk.length; console.error("zoho_sync_log insert failed", r.status, scrubString(await r.text().catch(() => ""))); }
    }catch(e){ lost += chunk.length; console.error("zoho_sync_log insert failed", scrubString(String(e && e.message || e))); }
  }
  return { written, lost };
}

// A per-run collector: fail(...) records a failure; flush() writes what's collected so far.
function collector(defaults){
  const pending = [], all = [];
  return {
    fail(f){ const row = failRow(Object.assign({}, defaults || {}, f)); pending.push(row); all.push(f.phase || "sync"); },
    async flush(){ const rows = pending.splice(0, pending.length); return rows.length ? writeLog(rows) : { written:0, lost:0 }; },
    count(){ return all.length; },
    byPhase(){ const o = {}; for(const p of all) o[p] = (o[p] || 0) + 1; return o; },
  };
}

module.exports = { redact, scrubString, failRow, writeLog, collector, SENSITIVE, DETAIL_MAX };
