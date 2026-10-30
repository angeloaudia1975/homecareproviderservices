// HCPS Smart Email Learning — Phase 2: run the analyser over the stored drafts and record the suggestions.
// Newest drafts first, so a cap (10,000) never hides the latest edits.
// Used by email-learning-api ("Look for patterns", the owner's button — it works whatever the daily switch says: it is the owner's own click) and email-learning-purge-cron (daily, only while
// phase2_flags.email_learning_suggest is exactly true). Reads only sent, edited drafts whose text is still kept (not purged);
// the analysis itself is pure code (_email_learn.js) — no AI, nothing leaves HCPS. Records ONLY qualifying suggestions
// (3+ sends across 2+ dealers; the database checks this again) through hcps_email_rule_note, which never changes the status
// or wording of a rule the owner has decided. Reads are strict: a failed read throws (nothing is recorded from a partial view).
const L = require("./_email_learn.js");

const PAGE = 1000, MAX_ROWS = 10000;
const COLS = "id,email_type,dealer_id,sent_at,edited,original_subject,original_body,sent_subject,sent_body";

async function loadDrafts(sbGet){
  const out = [];
  for(let off = 0; off < MAX_ROWS; off += PAGE){
    const rows = await sbGet(`email_drafts?select=${COLS}&sent_at=not.is.null&edited=is.true&content_purged_at=is.null&order=sent_at.desc,id.desc&limit=${PAGE}&offset=${off}`);
    out.push(...rows); if(rows.length < PAGE) return { drafts: out, capped: false };
  }
  return { drafts: out, capped: true };
}
async function dealerNames(sbGet, ids){
  const names = {}, list = [...new Set(ids.filter(Boolean))];
  for(let i = 0; i < list.length; i += 100){
    const part = list.slice(i, i + 100);
    (await sbGet(`dealers?id=in.(${part.map(encodeURIComponent).join(",")})&select=id,business_name`)).forEach(d => { names[d.id] = d.business_name; });
  }
  return names;
}
/* { apply } false = preview only. rpc(fn, p) → parsed JSON (throws on HTTP error). */
async function runAnalysis(sbGet, rpc, opts){
  const apply = !!(opts && opts.apply);
  const { drafts, capped } = await loadDrafts(sbGet);
  const names = await dealerNames(sbGet, drafts.map(d => d.dealer_id));
  drafts.forEach(d => { d.dealer = names[d.dealer_id] || null; });
  const res = L.analyze(drafts);
  const summary = { scanned: res.scanned, candidates: res.candidates, suggestions: res.suggestions.length, capped, applied: apply,
    inserted: 0, updated: 0, unchanged: 0, already_decided: 0, refused: 0 };
  if(apply){
    for(const s of res.suggestions){
      try{
        const out = await rpc("hcps_email_rule_note", { rule_key: s.rule_key, pattern_key: s.pattern_key, email_type: s.email_type, kind: s.kind, pattern: s.pattern,
          instruction: s.instruction, examples: s.examples, sends: s.sends, dealers: s.dealers, first_seen: s.first_seen, last_seen: s.last_seen });
        const st = out && out.status;
        if(st === "inserted") summary.inserted++; else if(st === "updated") summary.updated++; else if(st === "unchanged") summary.unchanged++; else if(st === "sibling_exists") summary.already_decided++; else summary.refused++;
      }catch(e){ summary.refused++; }
    }
  }
  return { summary, preview: apply ? undefined : res.suggestions.map(s => ({ email_type: s.email_type, kind: s.kind, instruction: s.instruction,
    sends: s.sends, dealers: s.dealers, examples: s.examples })) };
}
module.exports = { runAnalysis, loadDrafts, SWITCH_SUGGEST: "email_learning_suggest" };
