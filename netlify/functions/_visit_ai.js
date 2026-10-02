// HCPS — Meeting Intelligence (Phase 1). Turns what the rep typed and dictated at a dealer visit into
// SUGGESTED structure: a summary, what was discussed, who attended, commitments, follow-up actions
// and opportunities. Nothing here writes a CRM record — the rep reviews, edits and approves on the
// Visit Summary screen, and only routes-api visit_approve creates tasks, deals and contacts.
//
//   summarize({ transcript, notes, visitDate, weekday, dealerName, repName, contacts, mfrs, products,
//               fetch, apiKey, model, catalogBase, timeoutMs })  -> { ok, suggestion } | { ok:false, error, message }
//   normalizeSuggestion(raw, ctx)  (pure; tested)
//   priceLookup(opps, mfrs, deps)  (catalog base price × quantity when the model is known)

const V = require("./_visits.js");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const STAGES = ["identified", "contacted", "quoted"];
const PRI = ["high", "normal", "low"];
const clean = (v, n) => { const s = (v == null ? "" : String(v)).replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : ""; };
const num = v => { if(v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? n : null; };
const codeNorm = s => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");

function buildPrompt(i){
  const mfrList = (i.mfrs || []).map(m => `- ${m.name} [${m.slug}]`).join("\n") || "(none on file)";
  const prodList = (i.products || []).slice(0, 120).map(p => `- ${p}`).join("\n") || "(none on file)";
  const people = (i.contacts || []).slice(0, 40).map(c => `- ${c.name}${c.title ? ` — ${c.title}` : ""}`).join("\n") || "(none on file)";
  return `You turn a sales rep's notes from a dealer visit into structured meeting intelligence for HomeCare Provider Services (HCPS), a manufacturers' rep group selling home-medical-equipment lines to DME dealers.

The rep reviews and approves everything before any record is created, so suggest only what the notes support. Never invent people, products, quantities, prices, dates or promises. Transcription can mis-hear brand and product names — correct them to the known lists below when the match is clear.

Visit: ${i.dealerName || "the dealer"}, ${i.weekday || ""} ${i.visitDate || ""}. Rep: ${i.repName || "the HCPS rep"}.

KNOWN MANUFACTURERS (name [slug]):
${mfrList}

PRODUCTS THIS DEALER HAS BOUGHT (for spelling):
${prodList}

PEOPLE ON FILE AT THIS DEALER (name — title):
${people}

TYPED NOTES:
"""${String(i.notes || "").slice(0, 6000)}"""

DICTATION (transcript):
"""${String(i.transcript || "").slice(0, 12000)}"""

${i.part === "actions" ? ACTIONS_SPEC(i) : i.part === "meeting" ? MEETING_SPEC : MEETING_SPEC + "\n" + ACTIONS_SPEC(i)}${i.retryNote ? `\n\n${i.retryNote}` : ""}`;
}
/* The answer is asked for in two halves that run AT THE SAME TIME — what happened (summary, lists,
   attendees) and what happens next (commitments, follow-ups, deals). Each half is about half the
   output, so the whole summary arrives in roughly half the time; long dictations no longer run
   into the function's time limit. */
const COMPACT = `Return ONLY a compact, minified JSON object — one line, no indentation, no markdown, nothing before or after it.
Keep it short: list items are short phrases (under 12 words), at most 8 items per list, and OMIT any key whose value would be empty.`;
const MEETING_SPEC = `${COMPACT}
This answer covers WHAT HAPPENED. Keys (all optional except meeting_summary):
{"meeting_summary":"2-4 plain sentences: who you met, what was covered, the outcome","products_discussed":["product or line names"],"dealer_interests":[],"dealer_concerns":[],"objections":[],"competitors":[],"pricing_requests":[],"samples_requested":[],"literature_requested":[],"training_requested":[],"attendees":[{"name":"dealer-side person who was in the meeting (not the rep)","title":""}],"interest_slugs":["KNOWN slugs the dealer showed interest in"],"poor_fit_slugs":["KNOWN slugs the rep explicitly said are NOT a fit"]}`;
const ACTIONS_SPEC = i => `${COMPACT}
This answer covers WHAT HAPPENS NEXT. Keys (all optional):
{"rep_commitments":[{"text":"what the REP promised, e.g. send pricing","due_date":"YYYY-MM-DD"}],"dealer_commitments":[{"text":"what the DEALER promised or asked for","due_date":""}],"follow_ups":[{"title":"short imperative task for the rep","due_date":"","priority":"high|normal|low","from":"rep_commitment|dealer_commitment|request|other"}],"opportunities":[{"title":"e.g. 2 x PR519 lift chairs","manufacturer_slug":"a KNOWN slug","product":"model or product code/name","quantity":null,"est_value":null,"contact_name":"","stage":"identified|contacted|quoted","expected_close":""}],"suggested_next_action":{"text":"","due_date":""}}
Rules: every rep commitment and every dealer request becomes a follow_up — one follow_up per separate action, and never the same action twice. suggested_next_action is the single most important next step; leave it out when that step is already a follow_up. Each distinct deal is its own opportunity. Resolve relative dates against the visit date (tomorrow = the day after ${i.visitDate || "the visit"}; "Friday" = the coming Friday). Leave a date out when none was said. est_value only when a price or total was stated. Use "quoted" only if a quote was given.`;

/* ---- Reading the model's answer -------------------------------------------------------------
   The first complete JSON object in the text (code fences and any stray words around it are
   ignored). Braces inside strings are skipped, so a summary that mentions "{" can't confuse it. */
function extractJson(text){
  const t = String(text == null ? "" : text).replace(/```(?:json)?/gi, "");
  for(let start = t.indexOf("{"); start >= 0; start = t.indexOf("{", start + 1)){
    let depth = 0, inStr = false, esc = false;
    for(let k = start; k < t.length; k++){
      const c = t[k];
      if(inStr){ if(esc) esc = false; else if(c === "\\") esc = true; else if(c === "\"") inStr = false; continue; }
      if(c === "\"") inStr = true;
      else if(c === "{") depth++;
      else if(c === "}"){ depth--; if(depth === 0){ try{ const o = JSON.parse(t.slice(start, k + 1)); if(o && typeof o === "object" && !Array.isArray(o)) return o; }catch(_){} break; } }
    }
  }
  return null;
}
/* Is this a summary the review screen can show? A non-empty meeting summary, and every list the
   screen reads is a list (or absent). Anything else is treated as a failed attempt. */
const LIST_KEYS = ["products_discussed", "dealer_interests", "dealer_concerns", "objections", "competitors", "pricing_requests",
  "samples_requested", "literature_requested", "training_requested", "attendees", "rep_commitments", "dealer_commitments",
  "follow_ups", "opportunities", "interest_slugs", "poor_fit_slugs"];
function validRaw(raw, part){
  if(!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if(part !== "actions" && (typeof raw.meeting_summary !== "string" || !raw.meeting_summary.trim())) return false;
  for(const k of LIST_KEYS) if(raw[k] != null && !Array.isArray(raw[k])) return false;
  if(raw.suggested_next_action != null && typeof raw.suggested_next_action !== "object" && typeof raw.suggested_next_action !== "string") return false;
  return true;
}

/* ---- Near-duplicate actions --------------------------------------------------------------------
   "Send PR-535 pricing and the Golden catalog" and "Send PR-535 pricing and Golden catalog to the
   dealer" are one piece of work. Compared on their meaningful words; a different date (both set)
   keeps them apart. */
const STOP = new Set("a an and the to for of on in at by with from this that their them they our your you it its is be will please re dealer customer store".split(" "));
function actionWords(s){ return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w && !STOP.has(w))); }
function sameAction(a, b){
  const A = actionWords(a && (a.title || a.text)), B = actionWords(b && (b.title || b.text));
  if(!A.size || !B.size) return false;
  const da = String((a && a.due_date) || ""), db = String((b && b.due_date) || "");
  if(da && db && da !== db) return false;
  let inter = 0; for(const w of A) if(B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return inter / Math.min(A.size, B.size) >= 0.75 || inter / union >= 0.6;
}

/* Pure: whatever came back, in the exact shape the review screen expects, with stable keys,
   validated dates and stages, attendees matched to contacts and opportunities matched to
   known manufacturers. */
function normalizeSuggestion(raw, ctx){
  raw = (raw && typeof raw === "object") ? raw : {}; ctx = ctx || {};
  const s = V.normalizeSummary(raw);
  const visitDate = ISO.test(String(ctx.visitDate || "")) ? ctx.visitDate : null;
  const okDate = d => ISO.test(String(d || "")) && (!visitDate || String(d) >= visitDate) ? String(d) : "";
  const slugs = new Set((ctx.mfrs || []).map(m => m.slug));
  const nameBySlug = {}; for(const m of (ctx.mfrs || [])) nameBySlug[m.slug] = m.name;

  const attendees = []; const seen = new Set();
  for(const a of (Array.isArray(raw.attendees) ? raw.attendees : [])){
    const name = clean(a && (a.name || a), 120); const k = V.nameKey(name);
    if(!name || seen.has(k)) continue; seen.add(k);
    const m = V.matchContact(name, ctx.contacts || []);
    attendees.push({ key: V.textKey("at", k, attendees.length), name, title: clean(a && a.title, 120),
      contact_id: m ? m.contact.id : null, matched_name: m ? m.contact.name : null, match: m ? m.how : null });
    if(attendees.length >= 15) break;
  }

  const follow_ups = [];
  for(const f of (Array.isArray(raw.follow_ups) ? raw.follow_ups : [])){
    const title = clean(f && (f.title || f.text || f), 200); if(!title) continue;
    const item = { key: V.textKey("fu", title, follow_ups.length), title, due_date: okDate(f && f.due_date),
      priority: PRI.includes(String(f && f.priority || "").toLowerCase()) ? String(f.priority).toLowerCase() : "normal",
      from: clean(f && f.from, 40) || "other" };
    // A repeat of an earlier follow-up is still shown, but unticked — the rep decides.
    const twin = follow_ups.find(x => !x.dup_of && sameAction(x, item));
    if(twin){ item.dup_of = twin.key; item.dup_title = twin.title; }
    follow_ups.push(item);
    if(follow_ups.length >= 15) break;
  }

  const opportunities = [];
  for(const o of (Array.isArray(raw.opportunities) ? raw.opportunities : [])){
    const title = clean(o && (o.title || o), 200); if(!title) continue;
    const slug = slugs.has(String(o && o.manufacturer_slug || "")) ? String(o.manufacturer_slug) : "";
    const contactName = clean(o && o.contact_name, 120);
    const m = contactName ? V.matchContact(contactName, ctx.contacts || []) : null;
    opportunities.push({ key: V.textKey("op", title, opportunities.length), title,
      manufacturer: slug, manufacturer_name: slug ? nameBySlug[slug] : "",
      product: clean(o && o.product, 160), quantity: num(o && o.quantity), value: num(o && o.est_value),
      value_source: num(o && o.est_value) != null ? "stated" : "",
      contact_name: contactName, contact_id: m ? m.contact.id : null,
      stage: STAGES.includes(String(o && o.stage || "").toLowerCase()) ? String(o.stage).toLowerCase() : "identified",
      expected_close: okDate(o && o.expected_close) });
    if(opportunities.length >= 10) break;
  }

  const keep = arr => (Array.isArray(arr) ? arr : []).map(x => String(x || "").trim()).filter(x => slugs.has(x));
  const next = { text: s.suggested_next_action.text, due_date: okDate(s.suggested_next_action.due_date) };
  // The next action is usually one of the follow-ups again; then it is offered unticked.
  if(next.text){ const twin = follow_ups.find(f => !f.dup_of && sameAction(f, next)); if(twin){ next.duplicate_of = twin.key; next.dup_title = twin.title; } }
  return Object.assign(s, {
    suggested_next_action: next,
    attendees, follow_ups, opportunities,
    interest_slugs: [...new Set(keep(raw.interest_slugs))], poor_fit_slugs: [...new Set(keep(raw.poor_fit_slugs))],
  });
}

/* "2 × PR519": when the model is in a published catalog, its dealer price × quantity is the estimate.
   Only fills a value the notes did not state; never overrides the rep's number. */
async function priceLookup(opps, deps){
  const need = (opps || []).filter(o => o.value == null && o.product && o.manufacturer);
  if(!need.length) return opps;
  const bySlug = {};
  for(const slug of [...new Set(need.map(o => o.manufacturer))]){
    try{ const rows = await deps.loadCatalog(slug); bySlug[slug] = Array.isArray(rows) ? rows : []; }catch(e){ bySlug[slug] = []; }
  }
  for(const o of need){
    const want = codeNorm(o.product); if(!want) continue;
    const hit = (bySlug[o.manufacturer] || []).find(p => codeNorm(p.code) === want)
             || (bySlug[o.manufacturer] || []).find(p => want.length >= 4 && codeNorm(p.code).startsWith(want));
    const unit = hit ? Number(hit.base_price) : NaN;
    if(Number.isFinite(unit) && unit > 0){
      o.unit_price = unit; o.product_name = clean(hit.name, 160);
      o.value = Math.round(unit * (o.quantity || 1) * 100) / 100; o.value_source = "catalog";
    }
  }
  return opps;
}

/* One request to the model. { ok, raw } or { ok:false, error, message, retry } — `retry` says a
   second try is worthwhile (cut off, not JSON, wrong shape, or the service was busy). */
const MAX_TOKENS = 4096;
async function callOnce(i, timeoutMs){
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs)) : null;
  let r;
  try{
    r = await i.fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl ? ctl.signal : undefined,
      headers: { "x-api-key": i.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: i.model, max_tokens: i.maxTokens || MAX_TOKENS, messages: [{ role: "user", content: buildPrompt(i) }] }) });
  }catch(e){
    return { ok: false, error: "ai_timeout", message: "The summary took too long.", retry: false };
  }finally{ if(timer) clearTimeout(timer); }
  const t = await r.text().catch(() => "");
  if(!r.ok){ let hint = ""; try{ const ej = JSON.parse(t); hint = ej && ej.error && ej.error.message ? ` (${ej.error.message})` : ""; }catch(_){}
    return { ok: false, error: "ai_error", message: "The AI service returned an error" + hint + ".", retry: r.status >= 500 || r.status === 429 }; }
  let j = {}; try{ j = JSON.parse(t); }catch(_){}
  let text = ""; for(const c of ((j && j.content) || [])) if(c && typeof c.text === "string") text += c.text;
  const raw = extractJson(text);
  if(!raw) return { ok: false, error: j && j.stop_reason === "max_tokens" ? "ai_incomplete" : "ai_empty", message: "The AI's answer was cut off or unreadable.", retry: true };
  if(!validRaw(raw, i.part)) return { ok: false, error: "ai_invalid", message: "The AI's answer was missing parts of the summary.", retry: true };
  return { ok: true, raw };
}
/* The summary, with ONE automatic retry when the first answer is incomplete or the wrong shape.
   Everything fits inside the function's time budget: the retry only runs if there is room for it.
   i.forceFirstInvalid (QA only — see routes-api) throws the first answer away to prove the retry. */
const ACTION_KEYS = ["rep_commitments", "dealer_commitments", "follow_ups", "opportunities", "suggested_next_action"];
const RETRY_NOTE = "IMPORTANT: your previous answer was cut off or was not valid JSON. Answer again with a SHORTER summary: minified JSON only, at most 5 items per list, short phrases.";
async function summarize(i){
  if(!i.apiKey) return { ok: false, error: "ai_unavailable", attempts: 0, message: "AI summaries need ANTHROPIC_API_KEY set in Netlify. You can still review and approve by hand." };
  // Netlify ends a function at ~26 s; the rest of visit_analyze needs a second or two of that.
  const t0 = Date.now(), budget = i.budgetMs || 22000, minRetry = i.minRetryMs || 6000;
  const firstWait = Math.min(i.timeoutMs || 17000, budget);
  /* One half, with its single retry. The QA switch discards the first "what happened" answer. */
  async function half(part){
    const p = Object.assign({}, i, { part });
    let res = await callOnce(p, firstWait), attempts = 1, forced = false;
    if(res.ok && part === "meeting" && i.forceFirstInvalid){ res = { ok: false, error: "ai_invalid", message: "First answer discarded for a test.", retry: true }; forced = true; }
    const left = budget - (Date.now() - t0);
    if(!res.ok && res.retry && left >= minRetry){
      res = await callOnce(Object.assign(p, { retryNote: RETRY_NOTE }), left - 500);
      attempts = 2;
    }
    return Object.assign(res, { attempts, forced });
  }
  const [meeting, actions] = await Promise.all([half("meeting"), half("actions")]);
  const attempts = Math.max(meeting.attempts, actions.attempts), forced = meeting.forced;
  if(!meeting.ok) return { ok: false, error: meeting.error, attempts, forced,
    message: (meeting.message || "The AI couldn't summarize this visit.") + " Your notes are saved — try the AI again, or fill in the summary yourself." };
  // Each half only supplies its own keys, so a stray key in one answer can't overwrite the other.
  // What happened came back but what happens next did not: show what we have, and say so.
  const raw = {};
  for(const [k, v] of Object.entries(meeting.raw || {})) if(!ACTION_KEYS.includes(k)) raw[k] = v;
  if(actions.ok) for(const k of ACTION_KEYS) if(actions.raw[k] != null) raw[k] = actions.raw[k];
  return { ok: true, raw, attempts, forced, partial: actions.ok ? null : "actions" };
}

module.exports = { buildPrompt, normalizeSuggestion, priceLookup, summarize, codeNorm, extractJson, validRaw, sameAction };
