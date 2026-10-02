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

${i.part === "meeting" ? MEETING_SPEC : i.part === "commitments" ? COMMITMENTS_SPEC(i) : i.part === "followups" ? FOLLOWUPS_SPEC(i) : i.part === "deals" ? DEALS_SPEC : MEETING_SPEC + "\n" + COMMITMENTS_SPEC(i) + "\n" + FOLLOWUPS_SPEC(i) + "\n" + DEALS_SPEC}${i.retryNote ? `\n\n${i.retryNote}` : ""}`;
}
/* The answer is asked for in four parts that run AT THE SAME TIME — what happened (summary, lists,
   attendees), the commitments (who promised what), the follow-ups (tasks, next action) and the deals
   (opportunities). Each part is a fraction of the output, so the whole summary arrives in a fraction
   of the time; long dictations no longer run into the function's time limit. The parts never see
   each other's answers — crossCheck() compares them afterwards and flags anything that disagrees. */
const COMPACT = `Return ONLY a compact, minified JSON object — one line, no indentation, no markdown, nothing before or after it.
Keep it short: list items are short phrases (under 12 words), at most 8 items per list, and OMIT any key whose value would be empty.`;
const MEETING_SPEC = `${COMPACT}
This answer covers WHAT HAPPENED. Keys (all optional except meeting_summary):
{"meeting_summary":"2-4 plain sentences: who you met, what was covered, the outcome","products_discussed":["product or line names"],"dealer_interests":[],"dealer_concerns":[],"objections":[],"competitors":[],"pricing_requests":[],"samples_requested":[],"literature_requested":[],"training_requested":[],"attendees":[{"name":"dealer-side person who was in the meeting (not the rep)","title":""}],"interest_slugs":["KNOWN slugs the dealer showed interest in"],"poor_fit_slugs":["KNOWN slugs the rep explicitly said are NOT a fit"]}`;
const DATE_RULE = i => `Resolve relative dates against the visit date (tomorrow = the day after ${i.visitDate || "the visit"}; "Friday" = the coming Friday). Leave a date out when none was said.`;
const COMMITMENTS_SPEC = i => `${COMPACT}
This answer covers the COMMITMENTS: who promised what. Keys (all optional):
{"rep_commitments":[{"text":"what the REP promised, e.g. send pricing","due_date":"YYYY-MM-DD"}],"dealer_commitments":[{"text":"what the DEALER promised or asked for","due_date":""}]}
Rules: only promises and requests actually in the notes. ${DATE_RULE(i)}`;
const FOLLOWUPS_SPEC = i => `${COMPACT}
This answer covers WHAT HAPPENS NEXT: the follow-ups. Keys (all optional):
{"follow_ups":[{"title":"short imperative task for the rep","due_date":"","priority":"high|normal|low","from":"rep_commitment|dealer_commitment|request|other"}],"suggested_next_action":{"text":"","due_date":""}}
Rules: every rep commitment and every dealer request becomes a follow_up — one follow_up per separate action, and never the same action twice. Do not invent tasks the notes don't support. suggested_next_action is the single most important next step; leave it out when that step is already a follow_up. ${DATE_RULE(i)}`;
const DEALS_SPEC = `${COMPACT}
This answer covers the DEALS: products this dealer may buy. Keys (all optional):
{"opportunities":[{"title":"e.g. 2 x PR519 lift chairs","manufacturer_slug":"a KNOWN slug","product":"model or product code/name","quantity":null,"est_value":null,"contact_name":"","stage":"identified|contacted|quoted","expected_close":""}]}
Rules: each distinct deal is its own opportunity; tasks (send pricing, call back) are NOT opportunities. quantity only when a number was said. est_value only when a price or total was stated. Use "quoted" only if a quote was given. No deal discussed → {}.`;

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
  if((!part || part === "meeting") && (typeof raw.meeting_summary !== "string" || !raw.meeting_summary.trim())) return false;
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
function sameAction(a, b, ignoreDates){
  const A = actionWords(a && (a.title || a.text)), B = actionWords(b && (b.title || b.text));
  if(!A.size || !B.size) return false;
  const da = String((a && a.due_date) || ""), db = String((b && b.due_date) || "");
  if(!ignoreDates && da && db && da !== db) return false;
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
/* Thinking is OFF for these calls. Claude Sonnet 5 thinks by default (adaptive thinking) — that made a
   structured extraction like this one slow and was what used up the output allowance on long notes.
   A model that doesn't accept the setting answers 400; that call is then made once without it. */
const NO_THINKING = { type: "disabled" };
async function callOnce(i, timeoutMs){
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs)) : null;
  const send = thinking => i.fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl ? ctl.signal : undefined,
    headers: { "x-api-key": i.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ model: i.model, max_tokens: i.maxTokens || MAX_TOKENS, messages: [{ role: "user", content: buildPrompt(i) }] }, thinking ? { thinking } : {})) });
  let r, t;
  try{
    r = await send(NO_THINKING); t = await r.text().catch(() => "");
    if(r.status === 400 && /thinking/i.test(t)){ r = await send(null); t = await r.text().catch(() => ""); }
  }catch(e){
    return { ok: false, error: "ai_timeout", message: "The summary took too long.", retry: false };
  }finally{ if(timer) clearTimeout(timer); }
  if(!r.ok){ let hint = ""; try{ const ej = JSON.parse(t); hint = ej && ej.error && ej.error.message ? ` (${ej.error.message})` : ""; }catch(_){}
    return { ok: false, error: "ai_error", message: "The AI service returned an error" + hint + ".", retry: r.status >= 500 || r.status === 429 }; }
  let j = {}; try{ j = JSON.parse(t); }catch(_){}
  let text = ""; for(const c of ((j && j.content) || [])) if(c && typeof c.text === "string") text += c.text;
  const tokens = j && j.usage && Number.isFinite(j.usage.output_tokens) ? j.usage.output_tokens : undefined;
  const raw = extractJson(text);
  if(!raw) return { ok: false, error: j && j.stop_reason === "max_tokens" ? "ai_incomplete" : "ai_empty", message: "The AI's answer was cut off or unreadable.", retry: true, tokens };
  if(!validRaw(raw, i.part)) return { ok: false, error: "ai_invalid", message: "The AI's answer was missing parts of the summary.", retry: true, tokens };
  return { ok: true, raw, tokens };
}
/* The summary, with ONE automatic retry when the first answer is incomplete or the wrong shape.
   Everything fits inside the function's time budget: the retry only runs if there is room for it.
   i.forceFirstInvalid (QA only — see routes-api) throws the first answer away to prove the retry. */
const PART_KEYS = { commitments: ["rep_commitments", "dealer_commitments"], followups: ["follow_ups", "suggested_next_action"], deals: ["opportunities"] };
const ACTION_KEYS = PART_KEYS.commitments.concat(PART_KEYS.followups, PART_KEYS.deals);
const PARTS = ["meeting", "commitments", "followups", "deals"];
// What the review screen calls each later part when it is missing.
const SECTION = { commitments: "commitments", followups: "follow_ups", deals: "opportunities" };
const PART_OF = { commitments: "commitments", follow_ups: "followups", opportunities: "deals" };
const RETRY_NOTE = "IMPORTANT: your previous answer was cut off or was not valid JSON. Answer again with a SHORTER summary: minified JSON only, at most 5 items per list, short phrases.";
async function summarize(i){
  if(!i.apiKey) return { ok: false, error: "ai_unavailable", attempts: 0, message: "AI summaries need ANTHROPIC_API_KEY set in Netlify. You can still review and approve by hand." };
  // Netlify ends a function at ~26 s; the rest of visit_analyze needs a second or two of that.
  const t0 = Date.now(), budget = i.budgetMs || 22000, minRetry = i.minRetryMs || 6000;
  // A part that times out is not retried, so each part may use the whole budget on its first try;
  // a part that fails FAST (cut off, wrong shape) still has room for its one retry.
  const firstWait = Math.min(i.timeoutMs || budget - 1000, budget);
  /* i.only — run just these parts (Try AI again after a partial summary); the rest are not asked.
     i.forceFail — QA only (see routes-api): these parts fail on purpose, without calling the AI. */
  const want = Array.isArray(i.only) && i.only.length ? PARTS.filter(p => i.only.includes(p)) : PARTS;
  const forceFail = new Set(Array.isArray(i.forceFail) ? i.forceFail : []);
  /* One part, with its single retry. The QA switch discards the first "what happened" answer. */
  async function half(part){
    const p = Object.assign({}, i, { part }), s0 = Date.now();
    if(forceFail.has(part)) return { ok: false, error: "qa_forced", message: "This part failed on purpose for a test.", retry: false, attempts: 1, forced: true, ms: 0 };
    let res = await callOnce(p, firstWait), attempts = 1, forced = false;
    if(res.ok && part === "meeting" && i.forceFirstInvalid){ res = { ok: false, error: "ai_invalid", message: "First answer discarded for a test.", retry: true }; forced = true; }
    const left = budget - (Date.now() - t0);
    if(!res.ok && res.retry && left >= minRetry){
      res = await callOnce(Object.assign(p, { retryNote: RETRY_NOTE }), left - 500);
      attempts = 2;
    }
    return Object.assign(res, { attempts, forced, ms: Date.now() - s0 });
  }
  const results = {};
  await Promise.all(want.map(async part => { results[part] = await half(part); }));
  const parts = {};
  for(const part of want){ const r = results[part]; parts[part] = { ok: !!r.ok, attempts: r.attempts, ms: r.ms, tokens: r.tokens, error: r.ok ? undefined : r.error }; }
  const attempts = Math.max(...want.map(p => results[p].attempts)), forced = !!(results.meeting && results.meeting.forced);
  const meeting = results.meeting;
  if(meeting && !meeting.ok) return { ok: false, error: meeting.error, attempts, forced, parts,
    message: (meeting.message || "The AI couldn't summarize this visit.") + " Your notes are saved — try the AI again, or fill in the summary yourself." };
  // Each part only supplies its own keys, so a stray key in one answer can't overwrite another.
  // What happened came back but a later part did not: show what we have, and say which is missing.
  const raw = {};
  if(meeting) for(const [k, v] of Object.entries(meeting.raw || {})) if(!ACTION_KEYS.includes(k)) raw[k] = v;
  for(const part of ["commitments", "followups", "deals"]){ const res = results[part];
    if(res && res.ok) for(const k of PART_KEYS[part]) if(res.raw[k] != null) raw[k] = res.raw[k]; }
  const missing = want.filter(p => p !== "meeting" && !results[p].ok).map(p => SECTION[p]);
  return { ok: true, raw, attempts, forced, parts, partial: missing.length ? missing : null };
}

/* ---- Do the parts agree? -----------------------------------------------------------------------
   The four parts are separate requests and never see each other's answers, so they can disagree:
   one says 2 chairs and another 4, a deal names someone who wasn't at the meeting, a follow-up is
   due on a different day than the promise it came from. These checks are plain comparisons — no
   extra AI call — and nothing is changed or chosen: the item is marked for the rep (item.review)
   and the review screen lists what to look at before approving (sug.checks). */
const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const GENERIC = new Set("chair chairs lift lifts unit units model models power transport product products item items line lines new the and for with set sets pair pairs box boxes case cases".split(" "));
const REQ_GENERIC = new Set("request requested asked ask wants want need needs info information details detail more about".split(" "));
const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
const singular = w => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
/* Model numbers: "PR-535", "PR519", "G 2000". Not "Oct 16" and not "in 30 days". */
function modelCodes(s){
  const out = []; const re = /\b([A-Za-z]{1,4})[- ]?(\d{2,5})\b/g; let m;
  while((m = re.exec(String(s == null ? "" : s)))){
    const letters = m[1], digits = m[2], joined = m[0].indexOf(" ") < 0;
    if(MONTH.test(letters)) continue;
    if(letters !== letters.toUpperCase() && !(joined && digits.length >= 3)) continue;
    out.push({ code: (letters + digits).toLowerCase(), digits, text: m[0] });
  }
  return out;
}
/* What identifies a deal's product in someone else's sentence: its model number and its
   distinctive words (MaxiComfort, Excursion, rollator) — never generic ones like "chairs". */
function productTokens(o, mfrWords){
  const t = new Set(modelCodes(`${o.product || ""} ${o.title || ""}`).map(c => c.code));
  const add = w => { w = w.toLowerCase().replace(/[^a-z0-9]/g, ""); if(w.length >= 4 && !GENERIC.has(w) && !mfrWords.has(w) && !/^\d+$/.test(w)) t.add(singular(w)); };
  for(const w of String(o.product || "").split(/\s+/)) add(w);
  for(const w of String(o.title || "").split(/\s+/)) if(/^[A-Z]/.test(w)) add(w);
  return t;
}
/* "2 PR-535 chairs", "six Excursion transport chairs": a number and the words just after it. */
function quantitiesIn(text){
  const words = String(text == null ? "" : text).replace(/(\d),(\d)/g, "$1$2").split(/\s+/).filter(Boolean);
  const out = [];
  for(let k = 0; k < words.length; k++){
    if(/^\$/.test(words[k])) continue;
    const w = words[k].toLowerCase().replace(/[^a-z0-9]/g, "");
    const n = /^\d{1,4}x?$/.test(w) ? parseInt(w, 10) : NUMWORD[w];
    if(!n) continue;
    // the words that belong to this number: up to four, stopping at the next number, at "and"/"or",
    // or after a comma — "20 walkers and 12 rollators" is 20 walkers, not 20 rollators
    const after = [];
    for(const a of words.slice(k + 1, k + 5)){
      const la = a.toLowerCase().replace(/[^a-z0-9]/g, "");
      if(/^\d+x?$/.test(la) && la !== "x" || NUMWORD[la] || ["and", "or", "plus", "vs", "versus"].includes(la)) break;
      after.push(a); if(/[,;:.]$/.test(a)) break;
    }
    const toks = new Set(modelCodes(after.join(" ")).map(c => c.code));
    for(const a of after){ const lw = a.toLowerCase().replace(/[^a-z0-9]/g, ""); if(lw) toks.add(singular(lw)); }
    out.push({ n, toks, phrase: [words[k]].concat(after).join(" ") });
  }
  return out;
}
const SAY = { "the summary": "says", "the follow-ups": "say", "the commitments": "say" };
function crossCheck(sug, ctx){
  ctx = ctx || {};
  const checks = [];
  const flag = (item, kind, message, section) => { if(!item.review) item.review = message; checks.push({ kind, section, key: item.key, message }); };
  const fus = sug.follow_ups || [], opps = sug.opportunities || [], na = sug.suggested_next_action || {};
  for(const x of fus.concat(opps)) delete x.review;
  delete na.review;
  const missing = new Set(Array.isArray(sug.partial) ? sug.partial : []);
  const notesText = `${ctx.notes || ""}\n${ctx.transcript || ""}`;
  const mfrWords = new Set();
  for(const m of (ctx.mfrs || [])) for(const w of String(m.name || "").toLowerCase().split(/\s+/)) if(w) mfrWords.add(w);
  const commits = (sug.rep_commitments || []).concat(sug.dealer_commitments || []);
  const meetingTexts = [sug.meeting_summary].concat(sug.products_discussed || [], sug.pricing_requests || [], sug.samples_requested || [],
    sug.dealer_interests || [], sug.literature_requested || [], sug.training_requested || []);
  const fuTexts = fus.map(f => f.title).concat(na.text ? [na.text] : []);
  const commitTexts = commits.map(c => c.text);

  // 1. Quantity — a deal's quantity against the number another part gives the same product.
  for(const o of opps){
    if(o.quantity == null) continue;
    const toks = productTokens(o, mfrWords); if(!toks.size) continue;
    let hit = null;
    for(const [label, texts] of [["the summary", meetingTexts], ["the follow-ups", fuTexts], ["the commitments", commitTexts]]){
      for(const t of texts){ for(const q of quantitiesIn(t)){
        if(q.n === o.quantity || ![...q.toks].some(x => toks.has(x))) continue;
        // another deal for the same product with that quantity explains the other number
        if(opps.some(p => p !== o && p.quantity === q.n && [...productTokens(p, mfrWords)].some(x => toks.has(x)))) continue;
        hit = { label, n: q.n, text: q.phrase }; break;
      } if(hit) break; }
      if(hit) break;
    }
    if(hit) flag(o, "quantity", `Quantity: this deal says ${o.quantity}, ${hit.label} ${SAY[hit.label]} ${hit.n} (“${clean(hit.text, 60)}”). Check before approving.`, "opportunities");
  }
  // 2. Product / model — a model number that isn't in the notes was misheard or made up somewhere.
  if(notesText.trim()){
    const inNotes = d => new RegExp(`(^|\\D)${d}(\\D|$)`).test(notesText);
    const firstBad = s => modelCodes(s).find(c => !inNotes(c.digits));
    for(const o of opps){ const c = firstBad(`${o.product || ""} ${o.title || ""}`); if(c) flag(o, "model", `Model “${c.text}” isn't in your notes — check the product before approving.`, "opportunities"); }
    for(const f of fus){ const c = firstBad(f.title); if(c) flag(f, "model", `Model “${c.text}” isn't in your notes — check it.`, "follow_ups"); }
    if(na.text){ const c = firstBad(na.text); if(c) flag(na, "model", `Model “${c.text}” isn't in your notes — check it.`, "next_action"); }
    const c = firstBad(meetingTexts.filter(Boolean).join(" \n "));
    if(c) checks.push({ kind: "model", section: "summary", message: `The summary mentions “${c.text}”, which isn't in your notes — check it.` });
  }
  // 3. Contact — a deal's contact should be someone at the meeting or on file.
  const people = (sug.attendees || []).map(a => V.nameKey(a.name)).filter(Boolean);
  for(const o of opps){
    if(!o.contact_name || o.contact_id) continue;
    const k = V.nameKey(o.contact_name), first = k.split(" ")[0];
    if(people.some(p => p === k || p.split(" ")[0] === first)) continue;
    flag(o, "contact", `Contact “${o.contact_name}” isn't among the attendees or the contacts on file — check it.`, "opportunities");
  }
  // 4. Promised date — a follow-up and the promise it comes from should be due the same day.
  for(const f of fus){
    if(!f.due_date) continue;
    const c = (sug.rep_commitments || []).find(c => c.due_date && c.due_date !== f.due_date && sameAction(c, f, true));
    if(c) flag(f, "date", `Date: you promised “${clean(c.text, 60)}” by ${c.due_date}; this follow-up is due ${f.due_date}.`, "follow_ups");
  }
  if(na.text && na.due_date && !na.duplicate_of){
    const f = fus.find(f => f.due_date && f.due_date !== na.due_date && sameAction(f, na, true));
    if(f) flag(na, "date", `Date: the next action is the follow-up “${clean(f.title, 60)}” with a different date (${na.due_date} vs ${f.due_date}).`, "next_action");
  }
  // 5. Requested follow-up — what the dealer asked for should have a follow-up.
  if(!missing.has("follow_ups")){
    const fuWords = fus.map(f => new Set([...actionWords(f.title)].map(singular)));
    for(const r of [].concat(sug.pricing_requests || [], sug.samples_requested || [], sug.literature_requested || [], sug.training_requested || [])){
      const words = [...actionWords(r)].map(singular).filter(w => !REQ_GENERIC.has(w));
      if(!words.length || fuWords.some(fw => words.some(w => fw.has(w)))) continue;
      checks.push({ kind: "request", section: "follow_ups", message: `Asked for “${clean(r, 60)}” — no follow-up covers it. Add one if it's needed.` });
    }
  }
  sug.checks = checks;
  return sug;
}
/* Try AI again after a partial summary asks only for the missing parts. Their sections replace
   the empty ones; everything that already came back — summary, attendees, lists and the other
   sections — is kept exactly as it was. */
function mergeParts(stored, fresh, parts){
  const out = Object.assign({}, stored);
  for(const part of parts) for(const k of PART_KEYS[part]) out[k] = fresh[k];
  return out;
}

module.exports = { buildPrompt, normalizeSuggestion, priceLookup, summarize, codeNorm, extractJson, validRaw, sameAction,
                   crossCheck, mergeParts, modelCodes, quantitiesIn, PARTS, PART_OF, SECTION };
