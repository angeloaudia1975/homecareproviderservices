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

Return ONLY a JSON object with exactly these keys (use "" or [] when the notes say nothing):
{
 "meeting_summary": "2-4 plain sentences: who you met, what was covered, the outcome",
 "products_discussed": ["product or line names"],
 "dealer_interests": [], "dealer_concerns": [], "objections": [], "competitors": [],
 "pricing_requests": [], "samples_requested": [], "literature_requested": [], "training_requested": [],
 "attendees": [{"name": "dealer-side person who was in the meeting (not the rep)", "title": ""}],
 "rep_commitments": [{"text": "what the REP promised, e.g. send pricing", "due_date": "YYYY-MM-DD or \\"\\""}],
 "dealer_commitments": [{"text": "what the DEALER promised or asked for, e.g. call me Friday", "due_date": ""}],
 "follow_ups": [{"title": "short imperative task for the rep", "due_date": "", "priority": "high|normal|low", "from": "rep_commitment|dealer_commitment|request|other"}],
 "opportunities": [{"title": "e.g. 2 x PR519 lift chairs", "manufacturer_slug": "a KNOWN slug or \\"\\"", "product": "model or product code/name", "quantity": null, "est_value": null, "contact_name": "", "stage": "identified|contacted|quoted", "expected_close": ""}],
 "suggested_next_action": {"text": "", "due_date": ""},
 "interest_slugs": ["KNOWN slugs the dealer showed interest in"],
 "poor_fit_slugs": ["KNOWN slugs the rep explicitly said are NOT a fit"]
}
Rules: every rep commitment and every dealer request becomes a follow_up. Resolve relative dates against the visit date (tomorrow = the day after ${i.visitDate || "the visit"}; "Friday" = the coming Friday). Leave a date "" when none was said. est_value only when a price or total was stated. Use "quoted" only if a quote was given. No markdown, nothing outside the JSON.`;
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
    follow_ups.push({ key: V.textKey("fu", title, follow_ups.length), title, due_date: okDate(f && f.due_date),
      priority: PRI.includes(String(f && f.priority || "").toLowerCase()) ? String(f.priority).toLowerCase() : "normal",
      from: clean(f && f.from, 40) || "other" });
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
  return Object.assign(s, {
    suggested_next_action: { text: s.suggested_next_action.text, due_date: okDate(s.suggested_next_action.due_date) },
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

async function summarize(i){
  if(!i.apiKey) return { ok: false, error: "ai_unavailable", message: "AI summaries need ANTHROPIC_API_KEY set in Netlify. You can still review and approve by hand." };
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), i.timeoutMs || 22000) : null;
  let r;
  try{
    r = await i.fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl ? ctl.signal : undefined,
      headers: { "x-api-key": i.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: i.model, max_tokens: 1800, messages: [{ role: "user", content: buildPrompt(i) }] }) });
  }catch(e){
    return { ok: false, error: "ai_timeout", message: "The summary took too long. Try again, or approve by hand." };
  }finally{ if(timer) clearTimeout(timer); }
  const t = await r.text().catch(() => "");
  if(!r.ok){ let hint = ""; try{ const ej = JSON.parse(t); hint = ej && ej.error && ej.error.message ? ` (${ej.error.message})` : ""; }catch(_){}
    return { ok: false, error: "ai_error", message: "The AI service returned an error" + hint + ". Try again, or approve by hand." }; }
  let j = {}; try{ j = JSON.parse(t); }catch(_){}
  let text = ""; for(const c of ((j && j.content) || [])) if(c && typeof c.text === "string") text += c.text;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let raw = null; if(a >= 0 && b > a){ try{ raw = JSON.parse(text.slice(a, b + 1)); }catch(_){} }
  if(!raw) return { ok: false, error: "ai_empty", message: "The AI didn't return a usable summary. Try again, or approve by hand." };
  return { ok: true, raw };
}

module.exports = { buildPrompt, normalizeSuggestion, priceLookup, summarize, codeNorm };
