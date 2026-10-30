// ============================================================================
// HCPS Smart Email Learning — Phase 1: CAPTURE (owner decision 2026-10-30, CLAUDE.md §16).
//
// When an HCPS generator writes a dealer email draft, the draft AS WRITTEN is kept; when that same
// draft is then sent successfully through Outlook (Graph answered 202), the version actually sent
// is kept beside it. Nothing here writes, changes, delays or re-sends an email, and a capture
// failure never changes what the rep sees or what is sent: every call is best-effort and returns
// null / a status instead of throwing.
//
// Who is captured (owner decision 2): only the President's own drafts and sends — role
// "president" in staff_users. Greg's and Lori's emails are not captured.
// When: only while phase2_flags.email_learning_capture is exactly true (off = nothing is stored).
// Where: public.email_drafts (supabase/email_learning_p1_capture.sql), RULE 19 locked; written only
// by hcps_email_draft_create / hcps_email_draft_record_send (security definer, service_role only).
// Content is kept 12 months (owner decision 4); the purge keeps no identifying text.
// Learning itself (comparison, suggestions, approved rules) is Phase 2 — nothing is learned here.
// ============================================================================
const { flagOn } = require("./_flags.js");

const SWITCH = "email_learning_capture";
const EMAIL_TYPES = ["previsit_headsup","visit_followup","follow_up","dormant_account","product_intro",
  "reorder_reminder","cross_sell","portal_activation","campaign"];
// The generator's template → the email type its preferences will belong to.
const TYPE_OF_TEMPLATE = {
  previsit: "previsit_headsup", previsit_headsup: "previsit_headsup",
  visit_followup: "visit_followup", follow_up: "follow_up", dormant_account: "dormant_account",
  new_product: "product_intro", product_opportunity: "product_intro", reorder_reminder: "reorder_reminder",
  cross_sell: "cross_sell", portal_activation: "portal_activation",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBJECT = 300, MAX_BODY = 20000;

function emailType(template){ return TYPE_OF_TEMPLATE[String(template||"").toLowerCase()] || null; }
// Owner decision 2: the President's own emails only.
function captureAuthor(me){
  const email = String((me && me.email) || "").trim().toLowerCase();
  return me && String(me.role || "").toLowerCase() === "president" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
const uuidOrNull = v => { const s = String(v == null ? "" : v).trim(); return UUID_RE.test(s) ? s.toLowerCase() : null; };
// The draft exactly as the editor shows it: body, then the signature after a blank line.
function asShown(body, signature){
  const b = String(body == null ? "" : body), s = String(signature == null ? "" : signature).trim();
  return s ? `${b}\n\n${s}` : b;
}

function rpcClient(){
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  return async (fn, p) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ p }) });
    const t = await r.text();
    if (!r.ok) throw new Error(`rpc ${fn} ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
}

/* Keep a freshly generated draft. Returns its id, or null when nothing was kept (switch off, not
   the President, unknown type, no table yet, any error). Never throws. */
async function recordDraft(sbGet, me, d, rpc){
  try{
    const author = captureAuthor(me); if(!author) return null;
    const type = d && (d.email_type || emailType(d.template)); if(!type || !EMAIL_TYPES.includes(type)) return null;
    const subject = String((d && d.subject) || "").trim(), body = String((d && d.body) || "");
    if(!subject || !body.trim() || subject.length > MAX_SUBJECT || body.length > MAX_BODY) return null;
    if(!(await flagOn(sbGet, SWITCH))) return null;
    const out = await (rpc || rpcClient())("hcps_email_draft_create", { author_email: author, dealer_id: uuidOrNull(d.dealer_id),
      email_type: type, template: String(d.template || type).slice(0, 60), generator: String(d.generator || "").slice(0, 40), subject, body });
    return out && out.ok && uuidOrNull(out.id) ? out.id : null;
  }catch(e){ return null; }
}

/* After Outlook accepted the email: keep what was sent beside its draft. The database checks the
   draft belongs to this sender and dealer and was not already recorded. Returns a status string;
   never throws, never changes the send's answer. */
async function recordSend(sbGet, me, s, rpc){
  try{
    const id = uuidOrNull(s && s.draft_id); if(!id) return "no_draft";
    const author = captureAuthor(me); if(!author) return "not_captured";
    const subject = String((s && s.subject) || "").trim(), body = String((s && s.body) || "");
    if(!subject || subject.length > MAX_SUBJECT || body.length > MAX_BODY) return "too_large";
    if(!(await flagOn(sbGet, SWITCH))) return "switch_off";
    const out = await (rpc || rpcClient())("hcps_email_draft_record_send", { draft_id: id, author_email: author,
      dealer_id: uuidOrNull(s.dealer_id), subject, body, recipient_count: Math.max(1, Math.min(50, parseInt(s.recipient_count, 10) || 1)) });
    return (out && out.status) || "unknown";
  }catch(e){ return "error"; }
}

/* Line diff for the owner's page (LCS over lines; small emails). Pure. */
function lineDiff(a, b){
  const A = String(a == null ? "" : a).split("\n"), B = String(b == null ? "" : b).split("\n");
  const n = A.length, m = B.length; if(n * m > 250000) return [{ op: "note", text: "Too long to compare line by line." }];
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while(i < n && j < m){ if(A[i] === B[j]){ out.push({ op: "same", text: A[i] }); i++; j++; } else if(L[i + 1][j] >= L[i][j + 1]) out.push({ op: "del", text: A[i++] }); else out.push({ op: "add", text: B[j++] }); }
  while(i < n) out.push({ op: "del", text: A[i++] }); while(j < m) out.push({ op: "add", text: B[j++] });
  return out;
}

module.exports = { SWITCH, EMAIL_TYPES, TYPE_OF_TEMPLATE, emailType, captureAuthor, asShown, uuidOrNull, recordDraft, recordSend, lineDiff, rpcClient };
