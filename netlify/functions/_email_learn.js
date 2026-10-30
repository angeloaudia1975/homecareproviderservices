// ============================================================================
// HCPS Smart Email Learning — Phase 2: LEARNING (owner decisions 2026-10-30, CLAUDE.md §16).
//
// Pure code — no AI, no network, nothing sent anywhere (owner decision 5: no email history or edit pair goes to an
// outside AI service). It compares each HCPS draft with the version the owner actually sent and turns the edits into
// candidate writing rules:
//   remove_phrase   a sentence the owner deleted
//   replace_phrase  a sentence the owner rewrote (one for one)
//   add_phrase      a sentence the owner added (at the opening, the closing or in the middle)
//   greeting        the opening line changed ("Hi {name}," → "Good morning {name},")
//   shorter/longer  the owner cut (or grew) the email by a quarter or more
//   subject         the subject line was rewritten
// Every phrase is MASKED before it is compared or stored: e-mail addresses, links, phone numbers, amounts, dates, times,
// numbers, the dealer's own name and the greeted person's name become {email} {link} {phone} {amount} {date} {time}
// {number} {dealer} {name}; any other capitalised word inside a sentence becomes {name} unless it is a known
// manufacturer / HCPS / weekday word. A phrase that still holds a digit or an "@" after masking is dropped.
// A candidate is SUGGESTED only when the same masked edit appears in 3+ different sent emails across 2+ different
// dealers (owner decision 3). It becomes ACTIVE only when the owner approves it (database: email_learning_rules).
// ============================================================================
const crypto = require("crypto");

const MIN_SENDS = 3, MIN_DEALERS = 2, MAX_EXAMPLES = 3, MAX_PHRASE = 200;
const KINDS = ["remove_phrase", "replace_phrase", "add_phrase", "greeting", "shorter", "longer", "subject"];
// Capitalised words that may stay: they identify nobody. Manufacturer names are NOT kept (they also appear inside dealer names —
// "Golden Rule Pharmacy").
const KEEP_WORDS = new Set(["I", "HCPS", "OK", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
// Ordinary words that open a sentence. Any OTHER capitalised word — at the start of a sentence or inside it — is treated as a name.
const COMMON_START = new Set(("A About Absolutely Actually After Again All Also An And Any Anything Are As Ask At Attached Based Be Because Before Best Both " +
  "Bring But By Call Can Could Can't Checking Did Do Does Don't Dropping Each Either Email Even Every Everything Feel Final Following For " +
  "From Glad Good Great Had Happy Has Have Hello Here Hey Hi Hope Hopefully How However I'd I'll I'm I've If In Is It It's Its Just Kind " +
  "Last Let Let's Looking Many May Maybe Me More Most My Next No Not Now Of On Once One Only Or Other Our Please Plus Quick Reaching Regards " +
  "Reply See Sharing Should Since Sincerely So Some Sorry Sounds Stop Stopping Sure Talk Thank Thanks That That's The Then There There's " +
  "These They This Those Today Tomorrow Unfortunately Until Usually Very Want Wanted We We'll We're We've Welcome Were What When Where " +
  "Which While Who Why Will With Would Yes Yesterday You You'll You're Your Dear Greetings Morning Afternoon Evening Cheers Warm " +
  "Visit Contact Note Remember Need Give Take Make Keep Send Share Check Try Use Order Find Join Come Go Hear Know Look Tell Write").split(" "));
const HONORIFIC = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Sr|Jr|St)\.?\s+[A-Z][\w'’-]*/g;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const GREETING = /^(hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|greetings)\b/i;

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Mask one phrase. ctx = { dealer: "Business Name" } (optional). Pure. */
function mask(text, ctx){
  let s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if(!s) return "";
  const dealer = ctx && String(ctx.dealer || "").trim();
  if(dealer && dealer.length >= 3) s = s.replace(new RegExp(escRe(dealer), "gi"), "{dealer}");
  s = s.replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, "{email}")
       .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "{link}")
       .replace(/\b[\w.+-]+\s+(?:at|\[at\]|\(at\))\s+[\w-]+\s+(?:dot|\[dot\]|\(dot\))\s+[a-z]{2,}\b/gi, "{email}")
       .replace(/\b[\w-]+\s+(?:dot|\[dot\]|\(dot\))\s+(?:com|net|org|us|biz|info|co|io|edu|gov)\b/gi, "{link}")
       .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|us|biz|info|co|io|edu|gov|health|care|shop|store|app)\b(?:\/\S*)?/gi, "{link}")
       .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "{phone}")
       .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, "{amount}")
       .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), "{date}")
       .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, "{date}")
       .replace(/\b\d{1,2}(?::\d{2})?\s?(?:a\.?m|p\.?m)\b/gi, "{time}")
       .replace(/\b\d{1,2}:\d{2}\b/g, "{time}")
       .replace(/\b\d+(?:[.,]\d+)*\b/g, "{number}");
  // Names already known for this email (the greeted person, the dealer's words), in any case: "thanks pat".
  for(const nm of (ctx && ctx.names) || []){ if(nm && nm.length >= 2) s = s.replace(new RegExp(`\\b${escRe(nm)}\\b`, "gi"), "{name}"); }
  s = s.replace(HONORIFIC, "{name}");
  // A greeting names a person: "Hi Pat," / "Good morning Pat Smith,".
  s = s.replace(/^((?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]ood\s+(?:[Mm]orning|[Aa]fternoon|[Ee]vening)|[Gg]reetings)\s+)([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)/, "$1{name}");
  // Every other capitalised word is a likely name — wherever it stands — unless it identifies nobody (KEEP_WORDS) or it is an
  // ordinary word opening a sentence or a clause after ":" ("Please", "Thanks", "We").
  s = s.replace(/(^|[.!?:;]\s+|\s)([A-Z][a-zA-Z'’-]*)/g, (m, pre, w) => {
    if(KEEP_WORDS.has(w)) return m;
    const opening = pre === "" || /[.!?:;]/.test(pre);
    return opening && COMMON_START.has(w) ? m : pre + "{name}";
  });
  s = s.replace(/(\{name\})(\s+\{name\})+/g, "$1");
  return s;
}
const norm = s => String(s || "").toLowerCase().replace(/[“”"]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").replace(/[\s.!,;:]+$/, "").trim();
// Safe to keep as non-identifying evidence: no digit, no "@", not too long, not empty, not only placeholders.
function safePhrase(s){
  const t = String(s || "");
  return t.length >= 3 && t.length <= MAX_PHRASE && !/[0-9@]/.test(t) && /[a-z]{2}/i.test(t.replace(/\{[a-z]+\}/g, ""));
}

/* The email body as units (sentences), the signature left out. Pure. */
function units(body, signature){
  let b = String(body == null ? "" : body).replace(/\r\n?/g, "\n");
  const sig = String(signature || "").trim();
  if(sig && b.trimEnd().endsWith(sig)) b = b.trimEnd().slice(0, -sig.length);
  const out = [];
  for(const line of b.split("\n")){
    const l = line.trim(); if(!l) continue;
    for(const s of l.split(/(?<!\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Sr|Jr|St)\.)(?<=[.!?])\s+(?=[A-Z"“(])/)){ const u = s.trim(); if(u) out.push(u); }
  }
  return out;
}
function lcsOps(A, B){
  const n = A.length, m = B.length;
  if(n * m > 250000) return null;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while(i < n && j < m){ if(A[i] === B[j]){ ops.push({ op: "same", a: i++, b: j++ }); } else if(L[i + 1][j] >= L[i][j + 1]) ops.push({ op: "del", a: i++ }); else ops.push({ op: "add", b: j++ }); }
  while(i < n) ops.push({ op: "del", a: i++ }); while(j < m) ops.push({ op: "add", b: j++ });
  return ops;
}
const words = s => (String(s || "").match(/[A-Za-z0-9'’]+/g) || []).length;

/* The edits of ONE draft → a list of { kind, pattern, key } (masked; each key at most once). Pure. */
function editsOf(d, ctx){
  const out = [], seen = new Set();
  const push = (kind, pattern) => {
    const k = kind + "|" + JSON.stringify(pattern, Object.keys(pattern).sort());
    if(seen.has(k)) return; seen.add(k); out.push({ kind, pattern });
  };
  const A = units(d.original_body, d.signature), B = units(d.sent_body, d.signature);
  // The person greeted in either version is a name everywhere in this email, in any case ("thanks pat").
  const names = [];
  for(const u of [A[0], B[0]]){ const g = String(u || "").match(/^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|greetings)\s+([A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)/i);
    if(g) for(const w of g[1].split(/\s+/)) if(w.length >= 2 && !COMMON_START.has(w[0].toUpperCase() + w.slice(1).toLowerCase())) names.push(w); }
  const mctx = Object.assign({}, ctx, { names: ((ctx && ctx.names) || []).concat(names) });
  const m = x => mask(x, mctx);
  const ops = lcsOps(A.map(m).map(norm), B.map(m).map(norm));
  if(ops){
    const firstSame = ops.findIndex(o => o.op === "same");
    let lastSame = -1; ops.forEach((o, i) => { if(o.op === "same") lastSame = i; });
    let i = 0;
    while(i < ops.length){
      if(ops[i].op === "same"){ i++; continue; }
      const start = i, dels = [], adds = [];
      while(i < ops.length && ops[i].op !== "same"){ if(ops[i].op === "del") dels.push(A[ops[i].a]); else adds.push(B[ops[i].b]); i++; }
      const where = firstSame < 0 || start < firstSame ? "opening" : (lastSame < 0 || start > lastSame ? "closing" : "middle");
      // The opening line of each version, when it is a greeting, is a greeting edit — not a phrase.
      let dl = dels.slice(), al = adds.slice();
      if(where === "opening" && dl.length && al.length && GREETING.test(dl[0]) && GREETING.test(al[0])){
        const f = m(dl.shift()), t = m(al.shift());
        const from = greetingForm(f), to = greetingForm(t);
        if(from && to && norm(from) !== norm(to)) push("greeting", { from, to });
      }
      if(dl.length && dl.length === al.length){
        dl.forEach((x, k) => { const f = m(x), t = m(al[k]); if(safePhrase(f) && safePhrase(t) && norm(f) !== norm(t)) push("replace_phrase", { from: f, to: t }); });
      } else {
        dl.forEach(x => { const f = m(x); if(safePhrase(f)) push("remove_phrase", { phrase: f }); });
        al.forEach(x => { const t = m(x); if(safePhrase(t)) push("add_phrase", { phrase: t, where }); });
      }
    }
  }
  const wa = words(A.join(" ")), wb = words(B.join(" "));
  if(wa >= 20 && wb > 0){
    if(wb <= wa * 0.75) push("shorter", {});
    else if(wb >= wa * 1.33) push("longer", {});
  }
  const so = m(d.original_subject), ss = m(d.sent_subject);
  if(so && ss && norm(so) !== norm(ss) && safePhrase(so) && safePhrase(ss)) push("subject", { from: so, to: ss });
  return out.map(e => Object.assign(e, { ratio: wa ? wb / wa : null }));
}
// "Hi {name}, thanks for…" → "Hi {name},"  (just the salutation).
function greetingForm(s){ const mm = String(s || "").match(/^((?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|greetings)(?:\s+\{name\})?\s*[,!—-]?)/i); return mm ? mm[1].trim() : null; }

function keyOf(scope, kind, pattern){
  const p = {}; for(const k of Object.keys(pattern).sort()) p[k] = k === "where" ? pattern[k] : norm(pattern[k]);
  return crypto.createHash("sha256").update(`${scope}|${kind}|${JSON.stringify(p)}`, "utf8").digest("hex").slice(0, 32);
}
const q = s => `“${String(s).replace(/[.!,;:\s]+$/, "")}”`;
/* The plain-English instruction a rule would add on top of the style guide (Phase 3 uses it; the owner may edit it). */
function instructionOf(kind, p, ratio){
  switch(kind){
    case "remove_phrase": return `Don't write ${q(p.phrase)}.`;
    case "replace_phrase": return `Write ${q(p.to)} instead of ${q(p.from)}.`;
    case "add_phrase": return p.where === "closing" ? `End the email with: ${q(p.phrase)}.` : p.where === "opening" ? `Start the email with: ${q(p.phrase)}.` : `Include: ${q(p.phrase)}.`;
    case "greeting": return `Open with ${q(p.to)} instead of ${q(p.from)}.`;
    case "shorter": return `Keep it shorter — you usually cut about ${Math.round(100 * (1 - (ratio || 0.7)))}% of the draft.`;
    case "longer": return `Write a fuller email — you usually add about ${Math.round(100 * ((ratio || 1.4) - 1))}% to the draft.`;
    case "subject": return `For the subject, write ${q(p.to)} instead of ${q(p.from)}.`;
  }
  return "";
}
function median(a){ const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); if(!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
function exampleOf(kind, p){
  if(kind === "replace_phrase" || kind === "greeting" || kind === "subject") return `${p.from} → ${p.to}`;
  if(kind === "remove_phrase") return `− ${p.phrase}`;
  if(kind === "add_phrase") return `+ ${p.phrase}`;
  return null;
}

/* All drafts → candidates. drafts: [{ id, email_type, dealer_id, sent_at, edited, original_subject, original_body,
   sent_subject, sent_body, signature?, dealer? }]. Only sent, edited drafts with their text are read. Each draft counts
   once per candidate. Scope = the email type, and "all" (every type together). Pure. */
function analyze(drafts){
  const by = new Map(); let scanned = 0;
  for(const d of drafts || []){
    if(!d || !d.sent_at || d.edited !== true || d.original_body == null || d.sent_body == null) continue;
    scanned++;
    const edits = editsOf(d, { dealer: d.dealer });
    for(const e of edits){
      for(const scope of [d.email_type, "all"]){
        const key = keyOf(scope, e.kind, e.pattern);
        let c = by.get(key);
        if(!c) by.set(key, c = { rule_key: key, email_type: scope, kind: e.kind, pattern: e.pattern, drafts: new Set(), dealerSet: new Set(),
          ratios: [], examples: [], first_seen: null, last_seen: null });
        if(c.drafts.has(d.id)) continue;
        c.drafts.add(d.id); if(d.dealer_id) c.dealerSet.add(d.dealer_id);
        if(e.ratio != null) c.ratios.push(e.ratio);
        const ex = exampleOf(e.kind, e.pattern); if(ex && c.examples.length < MAX_EXAMPLES && !c.examples.includes(ex)) c.examples.push(ex);
        if(!c.first_seen || d.sent_at < c.first_seen) c.first_seen = d.sent_at;
        if(!c.last_seen || d.sent_at > c.last_seen) c.last_seen = d.sent_at;
      }
    }
  }
  const all = [...by.values()].map(c => {
    const ratio = median(c.ratios);
    return { rule_key: c.rule_key, pattern_key: keyOf("*", c.kind, c.pattern), email_type: c.email_type, kind: c.kind, pattern: c.pattern, sends: c.drafts.size, dealers: c.dealerSet.size,
      examples: c.examples, first_seen: c.first_seen, last_seen: c.last_seen, instruction: instructionOf(c.kind, c.pattern, ratio),
      qualifies: c.drafts.size >= MIN_SENDS && c.dealerSet.size >= MIN_DEALERS };
  });
  // An "all types" candidate is suggested only when no single type already carries the same edit as a suggestion.
  const typed = new Set(all.filter(c => c.email_type !== "all" && c.qualifies).map(c => c.kind + "|" + JSON.stringify(c.pattern)));
  const suggestions = all.filter(c => c.qualifies && (c.email_type !== "all" || !typed.has(c.kind + "|" + JSON.stringify(c.pattern))));
  suggestions.sort((a, b) => b.sends - a.sends || b.dealers - a.dealers || a.rule_key.localeCompare(b.rule_key));
  return { scanned, candidates: all.length, suggestions };
}

// An owner-edited instruction: plain text, one line, 3–300 characters, no e-mail address or link.
function cleanInstruction(s){
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if(t.length < 3 || t.length > 300) return null;
  if(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t) || /\b(?:https?:\/\/|www\.)/i.test(t)) return null;
  return t;
}

module.exports = { MIN_SENDS, MIN_DEALERS, KINDS, mask, norm, safePhrase, units, editsOf, keyOf, instructionOf, analyze, cleanInstruction, greetingForm };
