// ============================================================================
// HCPS — the pre-visit heads-up email: the fixed template, the Phase 3 checks of its date and arrival time, and the Phase 3
// AI version (CLAUDE.md §16). Pure apart from the injected AI call; used by routes-api previsit_draft.
//
// Facts a heads-up may carry — and nothing else: the rep's name, HomeCare Provider Services, the dealer contact's first
// name, the stop's DATE, the estimated ARRIVAL time (with its zone) and, when the rep typed one, an opportunity to show.
// No purchase history, account data, price, promotion, stock or commitment: the heads-up is the same short note for a
// dealer in the rep's book and for one outside it (PR #71 access rules: reading this draft opens nothing new).
//
// Phase 3 checks (on when a Phase 3 heads-up switch is on; off = today's behaviour):
//   · the date must be a real calendar date, not in the past (America/Chicago) and not more than 120 days ahead;
//   · the arrival time must carry a known US time zone, and must not already have passed on that date;
//   · a date or time that fails is LEFT OUT with a warning and the email says it neutrally ("soon" / no time) — never a guess.
// The AI version is written from those checked facts + the AI Communication Style Guide + the chosen writing style + the
// owner's approved rules; it must keep the date and time it was given, call the time an estimate, and pass the
// no-invention guards (one rewrite). Anything else → the fixed template is used, with a warning.
// ============================================================================
const DG = require("./_draft_guards.js");

const TERRITORY_TZ = "America/Chicago";
const MAX_AHEAD_DAYS = 120;
/* Each label is read through its region's real clock on that date (review L4): a summer time labelled "EST" is still
   Eastern wall time, so the "already passed" check is never an hour off. */
const ZONE_TZ = { EST: "America/New_York", EDT: "America/New_York", ET: "America/New_York", CST: "America/Chicago", CDT: "America/Chicago",
  CT: "America/Chicago", MST: "America/Denver", MDT: "America/Denver", MT: "America/Denver", PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles", PT: "America/Los_Angeles" };

function prettyDate(iso){
  const p = String(iso).split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}
function chicagoToday(now){ return new Intl.DateTimeFormat("en-CA", { timeZone: TERRITORY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now)); }
const isRealDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if(!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const dayNumber = iso => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);

/* The stop's date, checked: returns the ISO date to use, or "" with a warning. */
function checkDate(raw, warnings, now){
  const iso = String(raw == null ? "" : raw).trim();
  if(!iso) return "";
  if(!isRealDate(iso)){ warnings.push("The visit date couldn't be read, so the email doesn't name a day."); return ""; }
  const today = chicagoToday(now == null ? Date.now() : now), diff = dayNumber(iso) - dayNumber(today);
  if(diff < 0){ warnings.push(`The visit date (${prettyDate(iso)}) has already passed, so the email doesn't name a day or time. Check the route's date in the planner.`); return ""; }
  if(diff > MAX_AHEAD_DAYS){ warnings.push(`The visit date (${prettyDate(iso)}) is more than ${MAX_AHEAD_DAYS} days away and looks wrong, so the email doesn't name a day or time.`); return ""; }
  return iso;
}
// The UTC offset in minutes of an IANA zone at an instant.
function zoneOffset(tz, ms){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000;
}
/* The arrival time (already cleaned by routes-api previsitEta), checked against its zone and date. Returns it, or "". */
function checkEta(eta, iso, warnings, now){
  const t = String(eta || "").trim(); if(!t) return "";
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)(?: ([A-Z]{2,5}))?$/.exec(t);
  if(!m){ warnings.push("The arrival time couldn't be read, so it was left out."); return ""; }
  if(!m[4] || !Object.prototype.hasOwnProperty.call(ZONE_TZ, m[4])){
    warnings.push(`The arrival time (${t}) has no time zone HCPS can confirm, so it was left out of this email.`); return ""; }
  if(!iso){ warnings.push(`The arrival time (${t}) was left out because the email doesn't name a day.`); return ""; }
  const mins = ((+m[1]) % 12 + (m[3] === "PM" ? 12 : 0)) * 60 + (+m[2]);
  const [y, mo, d] = iso.split("-").map(Number), wall = Date.UTC(y, mo - 1, d) + mins * 60000;
  const off = zoneOffset(ZONE_TZ[m[4]], wall);
  const at = wall - off * 60000;
  if(at <= (now == null ? Date.now() : now)){ warnings.push(`The estimated arrival (${t} on ${prettyDate(iso)}) has already passed, so it was left out.`); return ""; }
  return t;
}

/* The fixed heads-up (the template every heads-up used before Phase 3, and its fallback). */
function templateDraft(f){
  const greet = f.first ? `Hi ${f.first},` : "Hi there,";
  const when = f.when ? prettyDate(f.when) : "";
  const arrive = f.eta
    ? `I expect to be in your area${when ? ` on ${when}` : ""} around ${f.eta}`
    : (when ? `I'm planning to be in your area on ${when}` : "I'm planning to be in your area soon");
  const oppLine = f.opp ? `\n\nWhile I'm there I'd also like to show you ${f.opp} — I think it could be a good fit for your business.` : "";
  const body = `${greet}\n\nThis is ${f.repName} with HomeCare Provider Services. ${arrive}, and I'd love to stop by for a few minutes to review how things are going and make sure your lines and pricing are set up the way you need.${oppLine}\n\nThe arrival time is an estimate — I'll be moving between accounts that day — but I'll do my best to reach you close to then. If a different time works better, just reply and let me know.\n\nLooking forward to seeing you.`;
  const subject = `HCPS will be in your area${when ? ` — ${when}` : ""}`;
  return { subject, body };
}

function promptFor(f, styleGuide, extra, avoid){
  const when = f.when ? prettyDate(f.when) : "";
  return `You write short, professional emails for HomeCare Provider Services (HCPS), a manufacturers' rep group that sells home-medical-equipment lines to durable-medical-equipment (DME) dealers.

${styleGuide}
${extra ? `\n${extra}\n` : ""}
Write ONE short pre-visit heads-up from the rep (${f.repName}) to a dealer contact${f.first ? ` named ${f.first}` : ""}: the rep plans to stop by for a few minutes.

These are the ONLY facts you may use:
- Rep: ${f.repName}, HomeCare Provider Services
- ${when ? `Visit day: ${when}` : "Visit day: not confirmed — say only that the rep plans to be in the area soon; name no day or date"}
- ${f.eta ? `Estimated arrival: ${f.eta} — an estimate; the rep moves between accounts that day` : "Arrival time: not confirmed — name no time"}
${f.opp ? `- Something the rep would like to show while there: ${f.opp}\n` : ""}- Purpose: a short visit to review how things are going and make sure their lines and pricing are set up the way they need

Rules:
- Greeting: "Hi ${f.first || "there"},".
${when ? `- Say the visit day exactly as "${when}".\n` : ""}${f.eta ? `- Give the arrival exactly as "around ${f.eta}" and say it is an estimate.\n` : ""}- Invite them to reply if a different time works better.
- Never add a date, time, time zone, price, percentage, product, promotion, stock or shipping claim, purchase history, account detail or commitment that is not in the facts above.
- Do NOT include a signature or sign-off block (it is added separately). No emojis. 2 to 4 short paragraphs.
${avoid || ""}
Return ONLY a JSON object with exactly these keys:
  "subject": <= 60 characters${when ? `, naming "${when}"` : ""}
  "body": the email body as plain text with real line breaks between paragraphs (no HTML, no signature)
Do not include markdown or any text outside the JSON.`;
}

// What the guards may treat as given.
function factsOf(f){
  return { source: [f.repName, "HomeCare Provider Services", f.first || "", f.opp || "", f.when ? prettyDate(f.when) : "", f.when || "",
      "review how things are going and make sure your lines and pricing are set up the way you need"],
    dates: f.when ? [f.when] : [], times: f.eta ? [f.eta] : [], history: false, weekdays: true };
}
// The facts the AI version must keep: the day, the time and the word "estimate".
function missingFacts(d, f){
  const text = `${d.subject}\n${d.body}`, out = [];
  if(f.when && !DG._x.dates(text).some(x => x.key === (() => { const [, mo, dd] = f.when.split("-").map(Number); return `${mo}-${dd}`; })()))
    out.push({ kind: "missing", text: prettyDate(f.when), label: "the visit day" });
  if(f.eta){
    const want = DG._x.times(f.eta)[0];
    if(!DG._x.times(text).some(x => want && x.key === want.key)) out.push({ kind: "missing", text: f.eta, label: "the estimated arrival" });
    if(!/\bestimat|approximate/i.test(text)) out.push({ kind: "missing", text: "estimate", label: "that the arrival time is an estimate" });
  }
  return out;
}
function verdict(d, f, findBanned){
  const g = DG.check(d, factsOf(f)), miss = missingFacts(d, f);
  const banned = (findBanned ? findBanned(`${d.subject}\n${d.body}`) : []).map(x => ({ kind: "banned", text: x, label: "phrase the style guide forbids" }));
  return g.problems.concat(miss, banned);
}

/* The AI heads-up. ask(prompt) → { subject, body } | { err }. Returns { ok:true, subject, body } or { ok:false, reason }. */
async function aiDraft(f, { ask, styleGuide, extra, findBanned }){
  let d = await ask(promptFor(f, styleGuide, extra));
  if(!d || d.err) return { ok: false, reason: (d && d.err) || "ai_error" };
  let probs = verdict(d, f, findBanned);
  if(probs.length){
    const note = `IMPORTANT: your previous draft had problems: ${probs.slice(0, 10).map(p => p.kind === "missing" ? `it left out ${p.label} ("${p.text}")` : `"${p.text}" (${p.label})`).join("; ")}. Rewrite it using only the facts above.`;
    const r = await ask(promptFor(f, styleGuide, extra, note));
    if(!r || r.err) return { ok: false, reason: "guard_refused", problems: probs };
    d = r; probs = verdict(d, f, findBanned);
    if(probs.length) return { ok: false, reason: "guard_refused", problems: probs };
  }
  return { ok: true, subject: d.subject, body: d.body };
}

module.exports = { TERRITORY_TZ, MAX_AHEAD_DAYS, prettyDate, chicagoToday, checkDate, checkEta, templateDraft, promptFor, factsOf, missingFacts, verdict, aiDraft };
