// ============================================================================
// HCPS Smart Email Learning — Phase 3: the no-invention guards for AI-written email drafts (CLAUDE.md §16).
//
// Pure code, no AI, nothing leaves HCPS. Before a generated draft is shown, every claim of these kinds is checked against
// what the generator was GIVEN (its "source": the facts in its prompt):
//   time        an arrival / clock time ("around 11:30 AM")             → must be a time the source holds
//   zone        a time zone ("CST", "Eastern")                         → must be a zone the source holds
//   date        a calendar date ("October 6", "10/6", "2026-10-06")    → must be a date the source holds
//   weekday     a day name ("Tuesday")  — only when facts.weekdays is true (the heads-up): must be the weekday of a source
//               date, or named in it. Elsewhere a day name is a proposed next step ("Would Tuesday or Thursday suit?").
//   price       a dollar amount                                        → the same amount must be in the source
//   percent     a percentage                                           → the same percentage must be in the source
//   promotion   a discount / promo / free freight / sale / rebate …    → the source must speak of one
//   availability stock, shipping times, lead times, back-orders        → the source must speak of it
//   history     "your last order", "you've been buying" …              → only when the generator was given purchase history
//   commitment  a guarantee, promise, warranty, price match, "I'll bring" → the same word must be in the source
// A draft with any finding is regenerated once naming them; if the second draft still has findings the caller does not
// present it as checked (the heads-up uses the fixed template; Dealer 360 shows the findings to the rep before sending).
// The rules over-flag rather than under-flag: a false finding costs one rewrite, a missed one reaches a dealer.
// ============================================================================
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const ZONE_GROUP = { est:"eastern", edt:"eastern", et:"eastern", eastern:"eastern", cst:"central", cdt:"central", ct:"central", central:"central",
  mst:"mountain", mdt:"mountain", mt:"mountain", mountain:"mountain", pst:"pacific", pdt:"pacific", pt:"pacific", pacific:"pacific" };

const clean = s => String(s == null ? "" : s).normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");

// ---- extractors (each returns [{ key, text }]) ----
const TIME_RE = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])\.?\s?m\b\.?|\b(noon|midnight)\b/gi;
function times(s){
  const out = [];
  for(const m of clean(s).matchAll(TIME_RE)){
    if(m[4]){ out.push({ key: m[4].toLowerCase() === "noon" ? "12:00p" : "12:00a", text: m[0] }); continue; }
    out.push({ key: `${+m[1]}:${m[2] || "00"}${m[3].toLowerCase()}`, text: m[0].trim() });
  }
  return out;
}
const ZONE_RE = /\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|ET|CT|MT|PT)\b|\b(Eastern|Central|Mountain|Pacific)(?:\s+(?:Standard|Daylight))?\s+Time\b/g;
function zones(s){ const out = []; for(const m of clean(s).matchAll(ZONE_RE)) out.push({ key: ZONE_GROUP[(m[1] || m[2]).toLowerCase()], text: m[0] }); return out; }

const MONTH_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g;
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const SLASH_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const monthIndex = w => MONTHS.findIndex(m => m.startsWith(w.toLowerCase().slice(0, 3)));
function dates(s){
  const t = clean(s), out = [];
  for(const m of t.matchAll(MONTH_RE)){ const mo = monthIndex(m[1]) + 1, d = +m[2]; if(d >= 1 && d <= 31) out.push({ key: `${mo}-${d}`, year: m[3] ? +m[3] : null, text: m[0] }); }
  for(const m of t.matchAll(ISO_RE)){ const mo = +m[2], d = +m[3]; if(mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push({ key: `${mo}-${d}`, year: +m[1], text: m[0] }); }
  for(const m of t.matchAll(SLASH_RE)){ const mo = +m[1], d = +m[2]; if(mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push({ key: `${mo}-${d}`, year: m[3] ? +m[3] : null, text: m[0] }); }
  return out;
}
const WEEKDAY_RE = /\b(Sun|Mon|Tues?|Wed(?:nes)?|Thu(?:rs?)?|Fri|Sat(?:ur)?)day\b/gi;
function weekdays(s){ const out = []; for(const m of clean(s).matchAll(WEEKDAY_RE)){ const w = m[0].toLowerCase(); out.push({ key: WEEKDAYS.find(x => x.startsWith(w.slice(0, 3))), text: m[0] }); } return out; }
// The weekday of an ISO date (a calendar date: computed at noon UTC, no time zone involved).
function weekdayOf(y, mo, d){ const t = Date.UTC(y, mo - 1, d, 12); return Number.isFinite(t) ? WEEKDAYS[new Date(t).getUTCDay()] : null; }

const MONEY_RE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k|K|thousand|million|M)?\b|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|USD)\b/g;
function moneyKey(n, unit){
  let v = Number(String(n).replace(/,/g, "")); if(!Number.isFinite(v)) return null;
  if(unit){ const u = unit.toLowerCase(); v *= (u === "k" || u === "thousand") ? 1000 : 1000000; }
  return String(Math.round(v * 100) / 100);
}
function prices(s){ const out = []; for(const m of clean(s).matchAll(MONEY_RE)){ const k = moneyKey(m[1] || m[3], m[2]); if(k != null) out.push({ key: k, text: m[0].trim() }); } return out; }
const PCT_RE = /\b(\d{1,3}(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi;
function percents(s){ const out = []; for(const m of clean(s).matchAll(PCT_RE)) out.push({ key: String(+m[1]), text: m[0] }); return out; }

// ---- word families: a claim of the family needs the family in the source ----
const FAMILIES = {
  promotion: { label: "promotion or discount",
    re: /\b(promo(?:tion|tional|tions|s)?|discount(?:s|ed|ing)?|special (?:offer|pricing|price|deal)s?|rebates?|coupons?|free (?:shipping|freight|delivery|samples?|trial|gift|units?)|limited[- ]time|on sale|clearance|percent off|introductory (?:price|pricing|offer)|bonus (?:units?|offer))\b|\b\d{1,3}(?:\.\d+)?\s?% off/gi },
  availability: { label: "stock or shipping claim",
    re: /\b(in stock|out of stock|back in stock|stocked|on hand|inventory|available (?:today|immediately|right away)|ships? (?:today|tomorrow|same[- ]day|next[- ]day|within|in \d)|same[- ]day (?:shipping|delivery)|next[- ]day (?:shipping|delivery)|lead times?|back[- ]?order(?:s|ed)?|ready to ship|in short supply|selling out|sold out)\b/gi },
  history: { label: "purchase-history claim",
    re: /\b(you(?:'ve| have)? (?:ordered|purchased|bought|reordered)|you(?:'ve| have)? been (?:ordering|buying|purchasing)|your (?:last|recent|latest|previous|past|most recent) (?:order|purchase|shipment)s?|(?:you|your team) (?:order|buy|purchase|reorder)s? (?:regularly|often|every|each|monthly|weekly)|(?:you|your team) (?:usually|typically|normally) (?:order|buy|purchase|reorder)|you(?:'re| are) (?:due|overdue) (?:for|to)|since your last order|time to reorder)\b/gi },
  commitment: { label: "commitment",
    re: /\b(guarantee[sd]?|guaranteeing|promise[sd]?|promising|warrant(?:y|ies|ied)|price[- ]match(?:ing)?|lock(?:ed)? in (?:the |your |a )?(?:price|pricing|rate)|waive[sd]?|i(?:'ll| will) bring|we(?:'ll| will) bring|i(?:'ll| will) (?:have|get) (?:it|them|that|those) (?:to you|delivered|shipped)|risk[- ]free|no[- ]obligation)\b/gi },
};
// The word that has to appear in the source for a commitment to be allowed ("guaranteed" needs "guarantee").
const COMMIT_ROOT = [[/guarantee/i, /guarantee/i], [/promis/i, /promis/i], [/warrant/i, /warrant/i], [/price[- ]match/i, /price[- ]match/i],
  [/lock/i, /lock/i], [/waive/i, /waive/i], [/bring/i, /bring/i], [/(?:have|get) (?:it|them|that|those)/i, /deliver|ship|send/i],
  [/risk[- ]free/i, /risk[- ]free/i], [/obligation/i, /obligation/i]];

function familyHits(s, fam){ const out = []; for(const m of clean(s).matchAll(FAMILIES[fam].re)) out.push(m[0]); return out; }

// What the source allows. facts = { source: string|string[], dates?: [...], times?: [...], zones?: [...], history?: bool }
function allowed(facts){
  const src = clean([].concat(facts && facts.source || []).concat(facts && facts.dates || []).concat(facts && facts.times || [])
    .concat(facts && facts.zones || []).filter(x => x != null).join("\n"));
  const ds = dates(src), dkeys = new Set(ds.map(d => d.key)), wd = new Set(weekdays(src).map(w => w.key));
  for(const d of ds){ if(d.year){ const [mo, day] = d.key.split("-").map(Number); const w = weekdayOf(d.year, mo, day); if(w) wd.add(w); } }
  return {
    src, dates: dkeys, weekdays: wd,
    times: new Set(times(src).map(t => t.key)), zones: new Set(zones(src).map(z => z.key)),
    prices: new Set(prices(src).map(p => p.key)), percents: new Set(percents(src).map(p => p.key)),
    families: Object.fromEntries(Object.keys(FAMILIES).map(f => [f, familyHits(src, f).length > 0])),
    history: !!(facts && facts.history), strictWeekdays: !!(facts && facts.weekdays),
  };
}

/* Check a draft. Returns { ok, problems: [{ kind, text, label }] } — one entry per distinct claim. */
function check(draft, facts){
  const text = clean(`${draft && draft.subject || ""}\n${draft && draft.body || ""}`);
  const A = allowed(facts), problems = [], seen = new Set();
  const add = (kind, t, label) => { const k = kind + "|" + t.toLowerCase(); if(seen.has(k)) return; seen.add(k); problems.push({ kind, text: t, label }); };
  for(const t of times(text)) if(!A.times.has(t.key)) add("time", t.text, "arrival or clock time");
  for(const z of zones(text)) if(!A.zones.has(z.key)) add("zone", z.text, "time zone");
  for(const d of dates(text)) if(!A.dates.has(d.key)) add("date", d.text, "date");
  if(A.strictWeekdays) for(const w of weekdays(text)) if(!A.weekdays.has(w.key)) add("weekday", w.text, "day of the week");
  for(const p of prices(text)) if(!A.prices.has(p.key)) add("price", p.text, "dollar amount");
  for(const p of percents(text)) if(!A.percents.has(p.key)) add("percent", p.text, "percentage");
  if(!A.families.promotion) for(const h of familyHits(text, "promotion")) add("promotion", h, FAMILIES.promotion.label);
  if(!A.families.availability) for(const h of familyHits(text, "availability")) add("availability", h, FAMILIES.availability.label);
  if(!A.history) for(const h of familyHits(text, "history")) add("history", h, FAMILIES.history.label);
  for(const h of familyHits(text, "commitment")){
    const root = COMMIT_ROOT.find(([re]) => re.test(h));
    if(!root || !root[1].test(A.src)) add("commitment", h, FAMILIES.commitment.label);
  }
  return { ok: problems.length === 0, problems };
}

// The note added to the prompt for the one rewrite.
function rewriteNote(problems){
  if(!problems || !problems.length) return "";
  return "IMPORTANT: your previous draft stated things the facts above do not support: "
    + problems.slice(0, 12).map(p => `"${p.text}" (${p.label})`).join(", ")
    + ". Rewrite the email without them. Use only the facts given: never add a date, time, time zone, price, percentage, promotion, stock or shipping claim, purchase history or commitment that is not in them.";
}
// What the rep is told when a draft still holds findings after the rewrite.
function warningsFor(problems){
  return (problems || []).slice(0, 8).map(p => `Check before sending: “${p.text}” (${p.label}) isn't in what HCPS knows for this email — confirm it or take it out.`);
}

module.exports = { check, allowed, rewriteNote, warningsFor, weekdayOf, _x: { times, zones, dates, weekdays, prices, percents, familyHits } };
