// ============================================================================
// HCPS AI Communication Style Guide — ONE source of truth for how every AI email
// generator writes to dealers. Imported by ai-email-api.js (Dealer 360 composer)
// and campaign-api.js (Automated Campaigns); any future generator should import it
// too, so the rules are maintained in exactly one place.
//
// The default guide lives here in code. It can be OVERRIDDEN live (no redeploy) by
// storing text in app_settings under key 'ai_style_guide' as {"text":"..."} — use
// loadStyleGuide(sbGet) to read the effective guide (override if present, else default).
//
// Source guideline: "10 Phrases That Reek of Desperation (and what to say instead)",
// adapted to HCPS's B2B DME-dealer context. The goal: automated dealer emails should
// sound like a knowledgeable rep bringing a real, specific business opportunity —
// confident, helpful, relevant, value-driven — never desperate, apologetic,
// repetitive, or generically sales-y.
// ============================================================================

// The "Don't say / Say instead" pairs. Kept structured so the same list drives BOTH
// the prompt text the model reads AND the post-generation safety check.
const RULES = [
  { avoid: "Just checking in",            instead: "Lead with a specific insight relevant to this dealer (a line they buy, a dormant line, a regional trend)." },
  { avoid: "Following up on my follow-up", instead: "Give a NEW reason for the contact — something that changed or is newly available since last time." },
  { avoid: "Are you still interested",     instead: "Introduce a new benefit or opportunity worth exploring." },
  { avoid: "This will only take 5 minutes",instead: "State the specific value the dealer gets (e.g. 'a 3-line margin comparison on your top category')." },
  { avoid: "Sorry to bother you",          instead: "Open directly with a solution to a dealer problem or need." },
  { avoid: "Haven't heard back",           instead: "Explain what's new or what has changed since you last talked." },
  { avoid: "I know you're busy, but",      instead: "Deliver one quick, useful takeaway up front." },
  { avoid: "Let me know if",               instead: "Offer a clear next step or a simple either/or choice." },
  { avoid: "What would it take to earn your business", instead: "Make a recommendation based on the dealer's goals and history." },
  { avoid: "Is there any reason you wouldn't", instead: "Frame the clear, specific win for them." },
];

// Extra desperate/weak openers and filler to avoid, beyond the ten headline pairs.
const EXTRA_AVOID = [
  "we've missed you", "we have missed you", "we miss you",
  "hope this email finds you well", "hope you're doing well", "hope all is well",
  "quick question", "circle back", "circling back", "touching base", "reaching out to see",
  "wanted to reach out", "just wanted to", "just following up", "any interest",
  "at your earliest convenience", "no worries if not", "no pressure",
];

// The instruction block injected into every generator's prompt.
const STYLE_GUIDE = `HCPS AI COMMUNICATION STYLE GUIDE (apply to every dealer email)

VOICE: Write like a knowledgeable HCPS sales rep bringing this specific dealer a useful business opportunity — confident, helpful, relevant, and value-driven. Never sound desperate, apologetic, repetitive, or like a generic automated sales sequence.

EVERY MESSAGE MUST CARRY A REAL REASON. Ground the email in what we actually know about THIS dealer from Dealer 360 — purchase history, the manufacturer lines they buy, products purchased, how long they've been inactive on a line, regional trends, new products/promotions we now carry, and crossover (cross-sell) opportunities. Lead with that specific reason or insight; do not send a message whose only purpose is to ask whether they're "still interested."

DON'T SAY  →  SAY INSTEAD:
${RULES.map((r,i)=>`${i+1}. Don't say "${r.avoid}…"  →  ${r.instead}`).join("\n")}

ALSO AVOID: generic filler and weak openers such as ${EXTRA_AVOID.slice(0,10).map(s=>`"${s}"`).join(", ")}, and similar.

OPENERS: The first sentence states the specific, relevant insight or benefit for this dealer — never a check-in, an apology, or a "just" opener.
CTA: Close with a clear next step or a simple either/or choice the dealer can act on — not an open-ended "let me know if…".
HONESTY: Use only facts and numbers we actually have; never invent sales figures, dates, products, or promotions.`;

// Return the effective guide: the app_settings override if an admin has set one,
// otherwise the default above. Never throws — falls back to the default on any error.
async function loadStyleGuide(sbGet){
  try{
    const r = await sbGet("app_settings?key=eq.ai_style_guide&select=value");
    const t = r && r[0] && r[0].value && (typeof r[0].value==="string" ? r[0].value : r[0].value.text);
    if(t && String(t).trim()) return String(t).trim();
  }catch(e){}
  return STYLE_GUIDE;
}

// Post-generation safety net: return the banned phrases that slipped into a draft
// (case-insensitive substring match). Callers can regenerate once when this is non-empty.
function findBanned(text){
  const hay = String(text||"").toLowerCase();
  const hits = [];
  for(const r of RULES){ if(hay.includes(r.avoid.toLowerCase())) hits.push(r.avoid); }
  for(const p of EXTRA_AVOID){ if(hay.includes(p.toLowerCase())) hits.push(p); }
  return [...new Set(hits)];
}

module.exports = { STYLE_GUIDE, RULES, EXTRA_AVOID, loadStyleGuide, findBanned };
