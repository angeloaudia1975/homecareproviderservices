// ============================================================================
// HCPS Smart Email Learning — Phase 3 (part 1): turning the owner's APPROVED writing rules into prompt guidance.
//
// Owner decisions (CLAUDE.md §16): approved rules LAYER ON TOP of the AI Communication Style Guide and never replace it;
// at most 2 approved, masked examples per email type go into a prompt, never whole historical emails; nothing goes to an
// outside AI service except the generator's own prompt, which already goes there today; Phase 3 stays OFF in production
// until reviewed and switched on by the owner.
//
// It READS and BUILDS TEXT; its one write is recordShape (which version / style shaped a kept draft — best-effort, never
// changes a draft). Generators that use it: ai-email-api (Dealer 360 + visit follow-ups) and routes-api (the AI heads-up).
//
// It is active only when ALL of these hold — otherwise it answers { active:false, reason } and the caller writes the
// draft exactly as today:
//   · phase2_flags.email_learning_apply is exactly true;
//   · the person the draft is for is the ACTIVE President (Greg's and Lori's drafts are never shaped by learning);
//   · the approved set can be read (a read failure never blocks or changes a draft — it is simply not applied).
// The rules used are the CURRENT NUMBERED VERSION's snapshot (email_learning_profiles), so every shaped draft can say
// which version shaped it; version 0 (no version yet, or a reset) = no rules.
// ============================================================================
const SWITCH_APPLY = "email_learning_apply";
const MAX_RULES = 12;          // per prompt, newest-version order; more than this is a sign something is wrong
const MAX_EXAMPLES = 2;        // owner decision: at most 2 masked examples per email type
const MAX_INSTRUCTION = 300;   // = the database CHECK
// The same plain-text alphabet the database allows for rule wording (printable ASCII + typographic quotes / dashes / … → −).
const ALLOWED_TEXT = /^[\x20-\x7E‘’“”–—…→−]*$/;

// One line of wording, safe to place in a prompt: one line, plain text, no digits except a percentage, no "@", no link.
// Anything else is left out (never "fixed") — the rule was approved as stored, and a row that fails here is not used.
function cleanLine(s){
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if(t.length < 3 || t.length > MAX_INSTRUCTION) return null;
  if(!ALLOWED_TEXT.test(t) || /@/.test(t) || /\b(?:https?:\/\/|www\.)/i.test(t)) return null;
  if(/\d/.test(t.replace(/\b\d{1,3}%/g, ""))) return null;
  return t;
}

// The approved rules of a version snapshot that apply to an email type: its own type first, then "every type".
function rulesFor(snapshot, emailType){
  const list = Array.isArray(snapshot) ? snapshot : [];
  const mine = list.filter(r => r && r.email_type === emailType), all = list.filter(r => r && r.email_type === "all");
  const out = [], seen = new Set();
  for(const r of mine.concat(all)){
    const ins = cleanLine(r.instruction); if(!ins || seen.has(ins.toLowerCase())) continue;
    seen.add(ins.toLowerCase()); out.push({ id: r.id, kind: r.kind, email_type: r.email_type, instruction: ins });
    if(out.length >= MAX_RULES) break;
  }
  return out;
}

// At most MAX_EXAMPLES masked examples for this prompt, taken from the rules in use, in rule order.
function examplesFor(rules, examplesById){
  const out = [];
  for(const r of rules){
    for(const ex of (examplesById && examplesById[r.id]) || []){
      const e = cleanLine(ex); if(e && !out.includes(e)) out.push(e);
      if(out.length >= MAX_EXAMPLES) return out;
    }
  }
  return out;
}

/* The text added AFTER the style guide. Pure. The style guide stays first and wins on any conflict; facts are never
   invented to satisfy a preference. Empty string when there is nothing to add. */
function promptAddendum(rules, examples){
  if(!rules || !rules.length) return "";
  const lines = [
    "The rep's own approved writing preferences (learned from edits the rep made before sending, and approved by the rep).",
    "Apply them on top of the style guide above. If one conflicts with the style guide or with the facts you were given, follow the style guide and the facts.",
    "Never invent a name, date, time, price, product, promotion or commitment to satisfy a preference.",
  ];
  for(const r of rules) lines.push(`- ${r.instruction}`);
  if(examples && examples.length){
    lines.push("Masked examples of these edits ({name}, {dealer}, {date} and similar stand for details that were removed — never copy a placeholder into the email):");
    for(const e of examples) lines.push(`  ${e}`);
  }
  return lines.join("\n");
}

/* Read what applies to a draft. me = the verified sign-in ({ email, role }). Never throws. */
async function approvedFor(sbGet, me, emailType, flags){
  const off = reason => ({ active: false, reason, version: null, rules: [], examples: [], addendum: "" });
  try{
    if(!flags || flags[SWITCH_APPLY] !== true) return off("switch_off");
    if(!me || String(me.role || "").toLowerCase() !== "president") return off("not_president");
    const email = String(me.email || "").trim().toLowerCase();
    // Re-check the active President in staff_users at the moment of use (a stale sign-in never shapes a draft).
    const su = await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=email,role,active`);
    const u = su && su[0];
    if(!u || String(u.role || "").toLowerCase() !== "president" || u.active === false) return off("not_president");
    const v = await sbGet(`email_learning_profiles?select=version,rules&order=version.desc&limit=1`);
    const cur = v && v[0];
    if(!cur) return off("no_version");
    const rules = rulesFor(cur.rules, emailType);
    if(!rules.length) return Object.assign(off("no_rules_for_type"), { version: cur.version });
    const ids = rules.map(r => r.id).filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
    const exRows = ids.length ? await sbGet(`email_learning_rules?id=in.(${ids.join(",")})&status=eq.approved&select=id,examples`) : [];
    const byId = {}; for(const x of exRows || []) byId[x.id] = Array.isArray(x.examples) ? x.examples : [];
    // A rule whose live row is no longer approved (retired since the version was cut) is left out.
    const live = rules.filter(r => Object.prototype.hasOwnProperty.call(byId, r.id));
    if(!live.length) return Object.assign(off("no_rules_for_type"), { version: cur.version });
    const examples = examplesFor(live, byId);
    return { active: true, reason: null, version: cur.version, rules: live, examples, addendum: promptAddendum(live, examples) };
  }catch(e){ return off("unreadable"); }
}

/* Record which approved version and writing style shaped a kept draft (email_draft_shapes, Phase 3 SQL). Only for the
   President's own kept drafts; best-effort: not installed, a timeout or any error is simply nothing recorded. */
async function recordShape(me, draft_id, shape, rpc){
  try{
    const EL = require("./_email_learning.js");
    const author = EL.captureAuthor(me), id = EL.uuidOrNull(draft_id);
    if(!author || !id) return null;
    const p = { draft_id: id, author_email: author,
      profile_version: Number.isInteger(shape && shape.profile_version) && shape.profile_version > 0 ? shape.profile_version : null,
      style: shape && typeof shape.style === "string" ? shape.style : null, ai: !!(shape && shape.ai) };
    const call = rpc || EL.rpcClient();
    return await Promise.race([call("hcps_email_draft_shape", p).catch(() => null),
      new Promise(res => setTimeout(() => res(null), EL.captureMs()))]);
  }catch(e){ return null; }
}

module.exports = { recordShape, SWITCH_APPLY, MAX_RULES, MAX_EXAMPLES, cleanLine, rulesFor, examplesFor, promptAddendum, approvedFor };
