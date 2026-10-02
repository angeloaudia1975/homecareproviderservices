// HCPS — Visit Intelligence helpers shared by routes-api (the visit), crm-api (Dealer 360) and
// rep-command-api (the Command Center). Pure functions plus one database helper (follow-up status).

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, n) => { const s = (v == null ? "" : String(v)).replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : ""; };
const cleanText = (v, n) => { const s = (v == null ? "" : String(v)).trim(); return s ? s.slice(0, n) : ""; };

/* The sections of approved meeting intelligence, in the order the review screen shows them. */
const LIST_SECTIONS = [
  ["products_discussed", "Products discussed"],
  ["dealer_interests", "Dealer interests"],
  ["dealer_concerns", "Dealer concerns"],
  ["objections", "Objections"],
  ["competitors", "Competitors mentioned"],
  ["pricing_requests", "Pricing requests"],
  ["samples_requested", "Samples requested"],
  ["literature_requested", "Literature requested"],
  ["training_requested", "Training requested"],
];
const COMMIT_SECTIONS = [["rep_commitments", "Rep commitments"], ["dealer_commitments", "Dealer commitments"]];

const strList = (v, max, len) => (Array.isArray(v) ? v : (v == null || v === "" ? [] : String(v).split(/\r?\n/)))
  .map(x => clean(typeof x === "object" && x ? (x.text || x.title || x.name || "") : x, len || 240)).filter(Boolean).slice(0, max || 15);
const commitList = v => (Array.isArray(v) ? v : []).map(x => {
  const o = (x && typeof x === "object") ? x : { text: x };
  const text = clean(o.text, 240); if(!text) return null;
  return { text, due_date: ISO.test(String(o.due_date || "")) ? String(o.due_date) : "" };
}).filter(Boolean).slice(0, 15);

/* What the server stores as the APPROVED summary — whatever the client sends, trimmed to known
   sections with bounded sizes. Nothing outside this shape is kept. */
function normalizeSummary(s){
  s = (s && typeof s === "object") ? s : {};
  const out = { meeting_summary: cleanText(s.meeting_summary, 3000) };
  for(const [k] of LIST_SECTIONS) out[k] = strList(s[k]);
  for(const [k] of COMMIT_SECTIONS) out[k] = commitList(s[k]);
  const na = (s.suggested_next_action && typeof s.suggested_next_action === "object") ? s.suggested_next_action : { text: s.suggested_next_action };
  out.suggested_next_action = { text: clean(na.text, 300), due_date: ISO.test(String(na.due_date || "")) ? String(na.due_date) : "" };
  return out;
}

/* The Dealer 360 note / timeline text for an approved visit. Led by the summary, then only the
   sections that have something in them — a reader scanning the Notes card sees what happened. */
function summaryNoteBody(summary, opts){
  const s = normalizeSummary(summary); opts = opts || {};
  const L = [];
  if(s.meeting_summary) L.push(s.meeting_summary);
  if(opts.attendees && opts.attendees.length) L.push("Attendees: " + opts.attendees.join(", "));
  for(const [k, label] of LIST_SECTIONS) if(s[k].length) L.push(`${label}: ${s[k].join("; ")}`);
  for(const [k, label] of COMMIT_SECTIONS) if(s[k].length) L.push(`${label}: ${s[k].map(c => c.text + (c.due_date ? ` (by ${c.due_date})` : "")).join("; ")}`);
  if(s.suggested_next_action.text) L.push(`Next action: ${s.suggested_next_action.text}${s.suggested_next_action.due_date ? ` (by ${s.suggested_next_action.due_date})` : ""}`);
  return L.join("\n") || null;
}

/* ---- People ---------------------------------------------------------------------------- */
const nameKey = n => String(n == null ? "" : n).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
/* Match a heard name to the dealer's contacts. Exact full name first; then first + last; then a
   first name that only ONE contact has. Anything ambiguous stays unmatched for the rep to pick. */
function matchContact(name, contacts){
  const k = nameKey(name); if(!k) return null;
  const list = (contacts || []).filter(c => c && c.name);
  const exact = list.filter(c => nameKey(c.name) === k);
  if(exact.length === 1) return { contact: exact[0], how: "exact" };
  const parts = k.split(" ");
  if(parts.length >= 2){
    const fl = list.filter(c => { const p = nameKey(c.name).split(" "); return p[0] === parts[0] && p[p.length - 1] === parts[parts.length - 1]; });
    if(fl.length === 1) return { contact: fl[0], how: "first_last" };
  } else {
    const f = list.filter(c => nameKey(c.name).split(" ")[0] === parts[0]);
    if(f.length === 1) return { contact: f[0], how: "first_name" };
  }
  return null;
}

/* A stable key for a suggestion from its text, so analysing the same notes twice offers the same
   suggestions with the same keys (and an approval replay hits the same unique index rows). */
function textKey(prefix, text, i){
  let h = 5381; const s = String(text || "").toLowerCase();
  for(let j = 0; j < s.length; j++) h = ((h << 5) + h + s.charCodeAt(j)) >>> 0;
  return `${prefix}_${i}_${h.toString(36)}`.slice(0, 80);
}

/* ---- Follow-up status ---------------------------------------------------------------------
   none     approved with nothing to follow up
   pending  at least one linked task still open, or a linked opportunity still open at the stage
            it was approved at (nobody has moved it yet)
   complete every linked task is done or dismissed and every linked deal has moved or closed
   A rep's manual setting (followup_manual) is left alone. Returns { id: status }. */
async function recomputeFollowup(ids, deps){
  const { sbGet, sbSend } = deps;
  const list = [...new Set((ids || []).map(x => String(x || "").trim()).filter(Boolean))];
  const out = {};
  for(let i = 0; i < list.length; i += 80){
    const part = list.slice(i, i + 80); const inl = part.map(encodeURIComponent).join(",");
    const [reports, tasks, opps] = await Promise.all([
      sbGet(`dealer_visit_reports?id=in.(${inl})&select=id,summary,approved_at,followup_status,followup_manual,followup_completed_at,followup_due`).catch(() => []),
      sbGet(`dealer_tasks?origin_type=eq.visit_report&origin_id=in.(${inl})&select=id,origin_id,status,due_date`).catch(() => []),
      sbGet(`opportunities?origin_type=eq.visit_report&origin_id=in.(${inl})&select=id,origin_id,origin_key,status,stage`).catch(() => []),
    ]);
    for(const r of (reports || [])){
      if(!r.approved_at){ continue; }
      if(r.followup_manual){ out[r.id] = r.followup_status || "pending"; continue; }
      const T = (tasks || []).filter(t => String(t.origin_id) === String(r.id));
      const O = (opps || []).filter(o => String(o.origin_id) === String(r.id));
      const approvedStage = {};
      for(const o of ((r.summary && r.summary.opportunities) || [])) if(o && o.key) approvedStage[o.key] = o.stage || "identified";
      const openT = T.filter(t => t.status === "open");
      const openO = O.filter(o => o.status === "open" && String(o.stage) === String(approvedStage[o.origin_key] || "identified"));
      const status = (!T.length && !O.length) ? "none" : ((openT.length || openO.length) ? "pending" : "complete");
      const due = openT.map(t => t.due_date).filter(d => ISO.test(String(d || ""))).sort()[0] || null;
      out[r.id] = status;
      if(status !== r.followup_status || (due || null) !== (r.followup_due || null)){
        const patch = { followup_status: status, followup_due: due,
          followup_completed_at: status === "complete" ? (r.followup_completed_at || new Date().toISOString()) : null };
        try{ await sbSend("PATCH", `dealer_visit_reports?id=eq.${encodeURIComponent(r.id)}&followup_manual=not.is.true`, patch, { Prefer: "return=minimal" }); }catch(e){}
      }
    }
  }
  return out;
}

/* A client timestamp for an action done offline (arrived / ended), used only when it is plausible:
   not in the future (2 min of clock skew allowed) and not older than 36 hours. */
function clientTime(v, nowMs){
  const now = nowMs || Date.now(); if(!v) return null;
  const t = Date.parse(String(v)); if(!Number.isFinite(t)) return null;
  if(t > now + 2 * 60000 || t < now - 36 * 3600000) return null;
  return new Date(t).toISOString();
}

module.exports = { LIST_SECTIONS, COMMIT_SECTIONS, normalizeSummary, summaryNoteBody, nameKey, matchContact,
                   textKey, recomputeFollowup, clientTime, strList };
