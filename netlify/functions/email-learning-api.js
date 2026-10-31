// HCPS Smart Email Learning — owner page API.
// Phase 1 (read only):
//   POST {action:"status"}                            switches, installed, counts per email type, learning summary
//   POST {action:"list", type?, only?, before?, limit?} captured drafts, newest first — no email text
//   POST {action:"get", id}                           one draft: original and sent version + line comparison
// Phase 2 (learning; owner decisions 3 + versions — CLAUDE.md §16):
//   POST {action:"rules", status?}                    learned rules (masked evidence only)
//   POST {action:"analyze", dry_run?}                 look for repeated edits now (pure code, no AI); dry_run = preview only
//   POST {action:"decide", rule_id, decision, reason, instruction?, expected_version, expected_status}   approve | reject | retire | edit
//        expected_status = the rule's status on the owner's screen (a stale screen is refused: version_conflict)
//   POST {action:"versions"}                          every version of the approved set
//   POST {action:"rollback", to_version, reason, expected_version}   0 = reset (no approved rule)
//   POST {action:"redact", rule_id, reason, expected_version, expected_status}   Phase 3: remove a rule's evidence for good
// President only (owner decision: the learning record and its dashboard are the owner's). The person deciding is always the
// verified sign-in, never the request. Approved rules change NO email in Phase 2: applying them to drafts is Phase 3.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sbGet(path){ const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() });
  if(!r.ok){ const e = new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; } return r.json(); }
const EL = require("./_email_learning.js");
const RUN = require("./_email_learn_run.js");
const LEARN = require("./_email_learn.js");
async function rpc(fn, p){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, H()), body: JSON.stringify({ p }) });
  const t = await r.text();
  if(!r.ok){ const e = new Error(`rpc ${fn} ${r.status}: ${t.slice(0, 200)}`); e.status = r.status; e.body = t; throw e; }
  return t ? JSON.parse(t) : null;
}
const RULE_COLS = "id,email_type,kind,pattern,instruction,suggested_instruction,examples,sends,dealers,first_seen,last_seen,status,decided_at,decided_by,decision_reason,updated_at";
const DECIDE_HTTP = { decided: 200, president_only: 403, version_conflict: 409, not_allowed: 409, not_found: 404, reason_required: 422, bad_instruction: 422, redacted: 409 };
// "Not installed" = the Phase 2 table or function is missing — never any other database error (a column error stays a 500).
const rulesInstalled = e => !(e && (/PGRST205|PGRST202/.test(String(e.message))
  || (/relation "public\.email_learning_|function public\.hcps_email_(rule|profile)_\w+\(.*\) does not exist|Could not find the (table|function) 'public\.(email_learning_|hcps_email_(rule|profile)_)/i.test(String(e.message)))));
const { flags } = require("./_flags.js");

async function whoami(event){
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if(!tok) return null;
  try{ const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if(r.ok){ const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase();
      if(email){ const s = await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=email,role,active,name`).catch(() => []); const su = s && s[0];
        if(su && su.active !== false) return { role: su.role || "rep", email, name: su.name || email }; } } }catch(e){}
  return null;
}
const notInstalled = e => e && (e.status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(String(e.message)));
const COLS = "id,created_at,email_type,template,generator,dealer_id,sent_at,edited,recipient_count,content_purged_at,content_expires_at";

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const me = await whoami(event); if(!me) return json(401, { error: "sign_in_required" });
    if(String(me.role).toLowerCase() !== "president") return json(403, { error: "president_only", message: "Email Learning is the owner's page." });
    let b = {}; try{ b = JSON.parse(event.body || "{}"); }catch(e){ return json(400, { error: "bad_json" }); }

    if(b.action === "status"){
      const f = await flags(sbGet);
      let rows = [];
      try{ rows = await sbGet(`email_drafts?select=email_type,sent_at,edited&order=created_at.desc&limit=5000`); }
      catch(e){ if(notInstalled(e)) return json(200, { ok: true, installed: false, capture_on: f[EL.SWITCH] === true, types: EL.EMAIL_TYPES }); throw e; }
      const by = {}; let sent = 0, edited = 0;
      for(const r of rows){ const t = by[r.email_type] = by[r.email_type] || { drafts: 0, sent: 0, edited: 0 };
        t.drafts++; if(r.sent_at){ t.sent++; sent++; if(r.edited){ t.edited++; edited++; } } }
      let learning = { installed: false, suggest_on: f[RUN.SWITCH_SUGGEST] === true };
      try{
        const rr = await sbGet(`email_learning_rules?select=status&limit=5000`);
        const v = await sbGet(`email_learning_profiles?select=version&order=version.desc&limit=1`);
        const c = s => rr.filter(x => x.status === s).length;
        learning = Object.assign(learning, { installed: true, suggested: c("suggested"), approved: c("approved"), rejected: c("rejected"), retired: c("retired"),
          version: (v[0] && v[0].version) || 0, applied_to_emails: f.email_learning_apply === true });   // Phase 3, behind its own switch
      }catch(e){ if(rulesInstalled(e)) throw e; }
      // Phase 3 switches (each off unless exactly true) — shown so the owner sees what shapes his drafts.
      const phase3 = { apply: f.email_learning_apply === true, ai_headsup: f.email_ai_headsup === true, styles: f.email_styles === true };
      return json(200, { ok: true, installed: true, capture_on: f[EL.SWITCH] === true, types: EL.EMAIL_TYPES, phase3,
        totals: { drafts: rows.length, sent, edited, capped: rows.length >= 5000 }, by_type: by, learning,
        thresholds: { sends: LEARN.MIN_SENDS, dealers: LEARN.MIN_DEALERS } });
    }

    if(b.action === "list"){
      const limit = Math.max(1, Math.min(100, parseInt(b.limit, 10) || 50));
      const filt = [];
      if(b.type){ if(!EL.EMAIL_TYPES.includes(String(b.type))) return json(400, { error: "bad_type" }); filt.push(`email_type=eq.${encodeURIComponent(b.type)}`); }
      if(b.only === "sent") filt.push("sent_at=not.is.null"); else if(b.only === "edited") filt.push("edited=is.true");
      // Cursor = the last row's (created_at, id): rows sharing a timestamp are never skipped.
      if(b.before){ const c = String(b.before).split("|"), t = Date.parse(c[0]), cid = EL.uuidOrNull(c[1]);
        if(!Number.isFinite(t) || !cid) return json(400, { error: "bad_before" });
        const at = new Date(t).toISOString(); filt.push(`or=(created_at.lt.${at},and(created_at.eq.${at},id.lt.${cid}))`); }
      let rows;
      try{ rows = await sbGet(`email_drafts?select=${COLS},original_subject,sent_subject&${filt.join("&")}${filt.length ? "&" : ""}order=created_at.desc,id.desc&limit=${limit}`); }
      catch(e){ if(notInstalled(e)) return json(503, { error: "not_installed", message: "The Email Learning table isn't installed yet." }); throw e; }
      const ids = [...new Set(rows.map(r => r.dealer_id).filter(Boolean))];
      const names = {};
      if(ids.length){ try{ (await sbGet(`dealers?id=in.(${ids.map(encodeURIComponent).join(",")})&select=id,business_name`)).forEach(d => { names[d.id] = d.business_name; }); }catch(e){} }
      const out = rows.map(r => ({ id: r.id, created_at: r.created_at, email_type: r.email_type, template: r.template, generator: r.generator,
        dealer_id: r.dealer_id, dealer: names[r.dealer_id] || null, sent_at: r.sent_at, edited: r.edited, recipient_count: r.recipient_count,
        purged: !!r.content_purged_at, subject: r.content_purged_at ? null : (r.sent_subject || r.original_subject) }));   // what you sent, else the draft's
      const last = rows[rows.length - 1];
      return json(200, { ok: true, rows: out, next_before: rows.length === limit ? `${last.created_at}|${last.id}` : null });
    }

    if(b.action === "get"){
      const id = EL.uuidOrNull(b.id); if(!id) return json(400, { error: "bad_id" });
      let rows;
      try{ rows = await sbGet(`email_drafts?id=eq.${id}&select=${COLS},author_email,original_subject,original_body,sent_subject,sent_body`); }
      catch(e){ if(notInstalled(e)) return json(503, { error: "not_installed" }); throw e; }
      const r = rows && rows[0]; if(!r) return json(404, { error: "not_found" });
      let dealer = null;
      if(r.dealer_id){ try{ const d = await sbGet(`dealers?id=eq.${r.dealer_id}&select=business_name`); dealer = (d && d[0] && d[0].business_name) || null; }catch(e){} }
      return json(200, { ok: true, draft: Object.assign({}, r, { dealer }),
        diff: r.sent_at && !r.content_purged_at ? { subject_changed: r.original_subject !== r.sent_subject, body: EL.lineDiff(r.original_body, r.sent_body) } : null });
    }
    // ---- Phase 2 -------------------------------------------------------------------------------------------
    const p2 = fn => fn().catch(e => { if(!rulesInstalled(e)) return json(503, { error: "not_installed", message: "Learning (Phase 2) isn't installed yet." }); throw e; });
    if(b.action === "rules") return p2(async () => {
      const st = b.status ? String(b.status) : "";
      if(st && !["suggested","approved","rejected","retired"].includes(st)) return json(400, { error: "bad_status" });
      const q = cols => sbGet(`email_learning_rules?select=${cols}${st ? `&status=eq.${st}` : ""}&order=status.asc,sends.desc,updated_at.desc&limit=500`);
      // Phase 3 adds the redaction columns; before its SQL runs they don't exist (the page then offers no Redact).
      let rows, redactReady = true;
      try{ rows = await q(RULE_COLS + ",redacted_at,redacted_by"); }
      catch(e){ if(!/42703|redacted_(at|by)/.test(String(e.message))) throw e; rows = await q(RULE_COLS); redactReady = false; }
      const v = await sbGet(`email_learning_profiles?select=version&order=version.desc&limit=1`);
      return json(200, { ok: true, rules: rows, version: (v[0] && v[0].version) || 0, redact_ready: redactReady });
    });
    if(b.action === "analyze") return p2(async () => {
      await sbGet(`email_learning_rules?select=id&limit=1`);   // installed?
      const out = await RUN.runAnalysis(sbGet, rpc, { apply: b.dry_run !== true });
      return json(200, Object.assign({ ok: true }, out));
    });
    if(b.action === "decide") return p2(async () => {
      const id = EL.uuidOrNull(b.rule_id); if(!id) return json(400, { error: "bad_id" });
      if(!["approve","reject","retire","edit"].includes(String(b.decision))) return json(400, { error: "bad_decision" });
      const reason = String(b.reason == null ? "" : b.reason).replace(/\s+/g, " ").trim();
      if(reason.length < 3 || reason.length > 500) return json(422, { error: "reason_required", message: "Give a short reason (3–500 characters)." });
      let instruction;
      if(b.instruction != null && String(b.instruction).trim() !== ""){
        instruction = LEARN.cleanInstruction(b.instruction);
        if(!instruction) return json(422, { error: "bad_instruction", message: "The wording must be 3–300 characters, with no email address, link or number (a percentage is fine)." });
      }
      if(b.decision === "edit" && !instruction) return json(422, { error: "bad_instruction", message: "Write the new wording." });
      const ev = parseInt(b.expected_version, 10); if(!Number.isFinite(ev) || ev < 0) return json(400, { error: "bad_version" });
      const es = String(b.expected_status || ""); if(!["suggested","approved","rejected","retired"].includes(es)) return json(400, { error: "bad_status" });
      const out = await rpc("hcps_email_rule_decide", { rule_id: id, decision: b.decision, by: me.email, reason, instruction, expected_version: ev, expected_status: es });
      const code = DECIDE_HTTP[out && out.status] || 500;
      return json(code, Object.assign({ ok: code === 200 }, out, code === 409 && out.status === "version_conflict" ? { message: "Something changed since you opened this page — reload and try again." } : {}));
    });
    if(b.action === "versions") return p2(async () => {
      const rows = await sbGet(`email_learning_profiles?select=version,created_at,created_by,action,reason,rule_id,from_version,rules&order=version.desc&limit=200`);
      return json(200, { ok: true, versions: rows, version: (rows[0] && rows[0].version) || 0 });
    });
    if(b.action === "rollback") return p2(async () => {
      const to = parseInt(b.to_version, 10), ev = parseInt(b.expected_version, 10);
      if(!Number.isFinite(to) || to < 0 || !Number.isFinite(ev) || ev < 0) return json(400, { error: "bad_version" });
      const reason = String(b.reason == null ? "" : b.reason).replace(/\s+/g, " ").trim();
      if(reason.length < 3 || reason.length > 500) return json(422, { error: "reason_required", message: "Give a short reason (3–500 characters)." });
      const out = await rpc("hcps_email_profile_rollback", { to_version: to, by: me.email, reason, expected_version: ev });
      const code = out && (out.status === "rolled_back" || out.status === "reset") ? 200 : (DECIDE_HTTP[out && out.status] || 500);
      return json(code, Object.assign({ ok: code === 200 }, out));
    });
    /* Phase 3: Redact. The active President removes a rule's stored evidence for good (masked pattern, examples, both wordings,
       and the same wording in its events and version snapshots); an approved rule is retired in a new version. The row stays,
       so the edit is never suggested, refreshed, approved or restored again. Checked again in the database. */
    if(b.action === "redact"){
      const id = EL.uuidOrNull(b.rule_id); if(!id) return json(400, { error: "bad_id" });
      const reason = String(b.reason == null ? "" : b.reason).replace(/\s+/g, " ").trim();
      if(reason.length < 3 || reason.length > 500) return json(422, { error: "reason_required", message: "Give a short reason (3–500 characters)." });
      const ev = parseInt(b.expected_version, 10); if(!Number.isFinite(ev) || ev < 0) return json(400, { error: "bad_version" });
      const es = String(b.expected_status || ""); if(!["suggested","approved","rejected","retired"].includes(es)) return json(400, { error: "bad_status" });
      let out;
      try{ out = await rpc("hcps_email_rule_redact", { rule_id: id, by: me.email, reason, expected_version: ev, expected_status: es }); }
      catch(e){
        if(/PGRST202|hcps_email_rule_redact/.test(String(e.message))) return json(503, { error: "redact_not_installed", message: "Redact needs the Phase 3 database update (email_learning_p3_shapes_redact.sql)." });
        throw e;
      }
      const code = out && out.status === "redacted" && out.ok ? 200 : (DECIDE_HTTP[out && out.status] || 500);
      return json(code, Object.assign({ ok: code === 200 }, out, code === 409 && out.status === "version_conflict" ? { message: "Something changed since you opened this page — reload and try again." } : {}));
    }
    return json(400, { error: "unknown_action" });
  }catch(e){ console.error("email-learning-api", String(e && e.message || e).slice(0, 300)); return json(500, { error: "server_error", message: "Email Learning couldn't load just now." }); }
};
