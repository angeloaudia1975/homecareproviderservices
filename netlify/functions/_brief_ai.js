// HCPS — AI Morning Brief (Phase 2B). "What should I focus on today, and why?" at the top of the
// Command Center, written from facts that already exist and stored once per person per day
// (rep_daily_briefs). Nothing here reads the database or writes a record: rep-command-api gathers
// the facts and stores the result.
//
//   rankSignals(data)         relationship signals across a dealer set, strongest first (pure; tested)
//   briefInputs(day, signals) the facts the brief is written from, each with a short ref (pure)
//   signalsKey(inputs)        a digest of those facts: a stored brief whose key no longer matches is stale
//   ground(raw, inputs)       keeps only items that point at a real input (and quote no invented $ amount)
//   generate({inputs, fetch, apiKey, model, budgetMs})  one AI call, thinking off, one retry in budget
//   ruleHeadline(inputs)      the plain headline used when the AI's is unusable

const clean = (v, n) => { const s = (v == null ? "" : String(v)).replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : ""; };
const money = n => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const dayMs = d => Date.parse(String(d).slice(0, 10) + "T12:00:00Z");
const daysBetween = (from, to) => { const a = dayMs(from), b = dayMs(to); return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 864e5) : null; };
const shortDate = d => { const t = dayMs(d); return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : ""; };

/* dealer_carts.cart is {items:[{qty, p:{name, code, base_price}}]} (same reading as call-brief-api). */
function readCart(row){
  try{
    const items = (row && row.cart && row.cart.items) || [];
    let qty = 0, value = 0; const names = [];
    for(const it of items){ const p = (it && it.p) || {}, q = Number(it && it.qty) || 0; qty += q; value += (Number(p.base_price) || 0) * q; const n = p.name || p.code; if(n) names.push(String(n).slice(0, 60)); }
    return qty ? { items: qty, value: Math.round(value), products: names.slice(0, 3) } : null;
  }catch(e){ return null; }
}

/* ---- Relationship signals ---------------------------------------------------------------------
   One list, ranked, one entry per dealer (its strongest reason, with any others noted). For a rep and
   for the President it covers their own book; for Customer Relations every dealer (approved
   2026-10-03: her own work PLUS the strongest company-wide signals). TEST dealers never appear.
     data = { today, scope:Set|null (null = every dealer), exclude:Set, limit,
              names:{id:name}, owners:{id:rep name}, mfr:{slug:name},
              engagement[], intent[], sessions[], carts[], visits[] } */
/* Weights: a time-sensitive buying signal (an open cart) first, then promises past due, then the slower
   relationship trends; within a type, bigger and more urgent first. A long-quiet big account can still
   outrank a small, older promise. */
const W = { cart: 1000, dealer_commitment: 800, followup_overdue: 750, rep_commitment: 700, quiet: 600, decline: 500, portal: 400 };
const ACTION = {
  cart: "Call about the open cart before it goes stale",
  dealer_commitment: "Check in on what the dealer promised",
  followup_overdue: "Finish the visit follow-up",
  rep_commitment: "Deliver what was promised at the visit",
  quiet: "Reach out — find out why orders stopped",
  decline: "Ask what changed in their buying",
  portal: "Follow up on what they were looking at",
};
function rankSignals(data){
  const today = String(data.today || "").slice(0, 10);
  const inScope = id => { id = String(id || ""); if(!id) return false; if(data.exclude && data.exclude.has(id)) return false; return !data.scope || data.scope.has(id); };
  const name = id => (data.names && data.names[id]) || "";
  const owner = id => (data.owners && data.owners[id]) || "";
  const mfr = s => { const k = String(s || "").toLowerCase(); return (data.mfr && data.mfr[k]) || (k ? k.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : ""); };
  const all = [];
  const add = (type, dealer_id, why, score, amounts) => { if(!inScope(dealer_id)) return;
    all.push({ type, dealer_id: String(dealer_id), why: clean(why, 200), score: Math.round(score), amounts: (amounts || []).filter(n => Number(n) > 0).map(n => Math.round(n)) }); };

  for(const c of (data.carts || [])){
    const k = readCart(c), age = daysBetween(c.updated_at, today);
    if(!k || !k.value || age == null || age > 7 || age < 0) continue;
    add("cart", c.dealer_id, `Open portal cart ${money(k.value)} · ${k.items} item${k.items === 1 ? "" : "s"}${k.products.length ? ` (${k.products.join(", ")})` : ""}, updated ${shortDate(c.updated_at)}`,
      W.cart + Math.min(k.value / 20, 400) - age * 15, [k.value]);
  }
  const seen = {};
  for(const s of (data.sessions || [])){ const t = Date.parse(s.last_seen_at); if(Number.isFinite(t) && (!seen[s.dealer_id] || t > seen[s.dealer_id])) seen[s.dealer_id] = t; }
  const intentBy = {}; for(const i of (data.intent || [])) intentBy[i.dealer_id] = i;
  for(const id of new Set(Object.keys(seen).concat(Object.keys(intentBy)))){
    const i = intentBy[id] || {}, iAge = i.last_event_at ? daysBetween(i.last_event_at, today) : null, sAge = seen[id] ? daysBetween(new Date(seen[id]).toISOString(), today) : null;
    const browsing = iAge != null && iAge >= 0 && iAge <= 2 && Number(i.score_total) >= 10;
    const loggedIn = sAge != null && sAge >= 0 && sAge <= 1;
    if(!browsing && !loggedIn) continue;
    const what = [i.top_manufacturer ? mfr(i.top_manufacturer) : "", i.top_product || ""].filter(Boolean).join(" · ");
    const why = browsing ? `Active on the ordering portal ${iAge === 0 ? "today" : iAge === 1 ? "yesterday" : "this week"}${what ? ` — looking at ${what}` : ""}` : `Logged in to the ordering portal ${sAge === 0 ? "today" : "yesterday"}`;
    add("portal", id, why, W.portal + Math.min(Number(i.score_total) || 0, 200) - (Math.min(iAge == null ? 9 : iAge, sAge == null ? 9 : sAge)) * 20);
  }
  for(const v of (data.visits || [])){
    const s = v.summary || {}, vd = String(v.checkin_at || v.completed_at || "").slice(0, 10), by = v.rep_name || "";
    const open = v.followup_status !== "complete";
    if(open) for(const c of (s.dealer_commitments || [])){
      const due = String((c && c.due_date) || ""), late = due ? daysBetween(due, today) : null;
      if(!(late > 0) || !c.text) continue;
      add("dealer_commitment", v.dealer_id, `They said they'd "${clean(c.text, 80)}" by ${shortDate(due)} (visit ${shortDate(vd)}${by ? `, ${by}` : ""})`, W.dealer_commitment + Math.min(late, 30) * 5);
    }
    if(v.followup_status === "pending" && v.followup_due){
      const late = daysBetween(v.followup_due, today);
      if(late > 0) add("followup_overdue", v.dealer_id, `Follow-up from the ${shortDate(vd)} visit${by ? ` (${by})` : ""} was due ${shortDate(v.followup_due)}`, W.followup_overdue + Math.min(late, 30) * 5);
      for(const c of (s.rep_commitments || [])){
        const due = String((c && c.due_date) || ""), l2 = due ? daysBetween(due, today) : null;
        if(l2 > 0 && c.text) add("rep_commitment", v.dealer_id, `Promised at the ${shortDate(vd)} visit: "${clean(c.text, 80)}" by ${shortDate(due)}`, W.rep_commitment + Math.min(l2, 30) * 5);
      }
    }
  }
  for(const e of (data.engagement || [])){
    const total = Number(e.total_sales) || 0, churn = Number(e.churn_score) || 0, ms = e.months_since != null ? Number(e.months_since) : null;
    const quiet = (e.status === "at_risk" || e.status === "watch" || (e.status === "dormant" && ms != null && ms <= 9)) && total >= 1000;
    if(quiet) add("quiet", e.dealer_id, `${ms != null ? `No order in ${ms} month${ms === 1 ? "" : "s"}` : "Orders have slowed"}${e.last_period ? ` (last ${e.last_period})` : ""} · ${money(total)} lifetime`,
      W.quiet + churn * 1.5 + Math.min(total / 500, 200) - (e.status === "dormant" ? 60 : 0), [total]);
    else if(e.trend === "down" && e.status !== "dormant" && total >= 1000) add("decline", e.dealer_id, `Buying is trending down — ${money(e.recent_sales)} in the last 3 months · ${money(total)} lifetime`,
      W.decline + churn * 1.5 + Math.min(total / 1000, 150), [e.recent_sales, total]);
  }
  // One entry per dealer: its strongest reason; the others are listed under it.
  const best = {};
  for(const x of all.sort((a, z) => z.score - a.score)){
    const b = best[x.dealer_id];
    if(!b) best[x.dealer_id] = Object.assign({}, x, { also: [] });
    else if(b.also.length < 2 && !b.also.some(a => a.type === x.type) && b.type !== x.type){ b.also.push({ type: x.type, why: x.why }); b.amounts = b.amounts.concat(x.amounts); }
  }
  return Object.values(best).sort((a, z) => z.score - a.score || String(a.dealer_id).localeCompare(String(z.dealer_id))).slice(0, data.limit || 8)
    .map(x => ({ id: `sig_${x.type}_${x.dealer_id}`, type: x.type, dealer_id: x.dealer_id, dealer: name(x.dealer_id), owner: owner(x.dealer_id) || "House",
      why: x.why, also: x.also.map(a => a.why), action: ACTION[x.type], score: x.score, amounts: x.amounts }));
}

/* ---- The facts, with short refs the model can copy (T1, D2, S3 …) ----------------------------- */
function briefInputs(day, signals, opt){
  opt = opt || {};
  const refs = {}, amounts = [];
  const put = (ref, o) => { refs[ref] = o; return ref; };
  const h = day.header || {};
  const P = day.priorities || [];
  const route = day.route ? { name: day.route.name || "", stops: (day.route.stops || []).slice(0, 12).map((s, i) => ({ ref: put("R" + (i + 1), { kind: "stop", id: s.dealer_id, dealer_id: s.dealer_id, dealer: s.name }), dealer_id: s.dealer_id, dealer: s.name, place: s.place || "" })) } : null;
  const appointments = (day.appointments || []).slice(0, 8).map((a, i) => ({ ref: put("A" + (i + 1), { kind: "appointment", id: a.id, dealer_id: a.dealer_id, dealer: (P.find(p => p.kind === "appointment" && String(p.id) === String(a.id)) || {}).dealer || "", title: a.service || a.meeting_type || "Appointment" }),
    when: a.start_at, what: a.service || a.meeting_type || "Appointment", dealer_id: a.dealer_id, dealer: (P.find(p => p.kind === "appointment" && String(p.id) === String(a.id)) || {}).dealer || "" }));
  const tasks = P.filter(p => p.kind === "task").slice(0, 12).map((t, i) => ({ ref: put("T" + (i + 1), { kind: "task", id: t.id, dealer_id: t.dealer_id, dealer: t.dealer, title: t.title }), title: t.title, dealer_id: t.dealer_id, dealer: t.dealer, due: t.due, why: t.why }));
  const followups = ((day.followup_queue && day.followup_queue.visits) || []).slice(0, 8).map((f, i) => ({ ref: put("F" + (i + 1), { kind: "followup", id: f.id, dealer_id: f.dealer_id, dealer: f.dealer, title: "Visit follow-up" }),
    dealer_id: f.dealer_id, dealer: f.dealer, visit_date: f.visit_date, due: f.due, promised: (f.commitments && f.commitments.rep) || [], dealer_said: (f.commitments && f.commitments.dealer) || [] }));
  const deals = ((day.opportunities && day.opportunities.needs_attention) || []).slice(0, 8).map((o, i) => { if(o.value) amounts.push(Number(o.value));
    return { ref: put("D" + (i + 1), { kind: "deal", id: o.id, dealer_id: o.dealer_id, dealer: o.dealer, title: o.title }), title: o.title, dealer_id: o.dealer_id, dealer: o.dealer, stage: o.stage, value: Number(o.value) || 0, why: (o.why || []).join(", ") }; });
  const sig = (signals || []).map((s, i) => { for(const a of (s.amounts || [])) amounts.push(Number(a));
    return { ref: put("S" + (i + 1), { kind: "signal", id: s.id, dealer_id: s.dealer_id, dealer: s.dealer, title: s.why }), dealer_id: s.dealer_id, dealer: s.dealer, owner: s.owner, type: s.type, why: s.why, also: s.also || [], action: s.action }; });
  if(h.pipeline_weighted) amounts.push(Number(h.pipeline_weighted));
  return { date: h.date || opt.date || "", person: { name: (h.rep && h.rep.name) || "", role: opt.role || "rep" }, scope: opt.scope || "own_book", tz: opt.tz,
    route, appointments, tasks, followups, deals, signals: sig,
    counts: { open_tasks: h.open_tasks || 0, overdue: h.overdue || 0, due_today: h.due_today || 0, followups_pending: h.followups_pending || 0, deals_open: h.opportunities_open || 0, stops: h.stops || 0 },
    refs, amounts: [...new Set(amounts.filter(n => Number(n) > 0).map(n => Math.round(n)))] };
}

/* What a stored brief was written from. Same facts → same key; a task done or moved, a deal that
   changed stage, a new stop or appointment, a new or vanished signal → a different key (stale). */
function signalsKey(inputs){
  const i = inputs || {};
  const parts = [
    i.date, i.scope,
    (i.route ? i.route.stops : []).map(s => s.dealer_id).join(","),
    (i.appointments || []).map(a => a.ref && (i.refs[a.ref] || {}).id).join(","),
    (i.tasks || []).map(t => `${(i.refs[t.ref] || {}).id}:${t.due || ""}`).join(","),
    (i.followups || []).map(f => `${(i.refs[f.ref] || {}).id}:${f.due || ""}`).join(","),
    (i.deals || []).map(d => `${(i.refs[d.ref] || {}).id}:${d.stage}`).join(","),
    (i.signals || []).map(s => `${s.type}:${s.dealer_id}`).join(","),
  ].join("|");
  let h = 5381; for(let k = 0; k < parts.length; k++) h = ((h * 33) ^ parts.charCodeAt(k)) >>> 0;
  return h.toString(36) + "-" + parts.length.toString(36);
}

function ruleHeadline(i){
  const c = i.counts || {}, bits = [];
  if(c.stops) bits.push(`${c.stops} stop${c.stops === 1 ? "" : "s"} on today's route`);
  if(c.overdue) bits.push(`${c.overdue} overdue task${c.overdue === 1 ? "" : "s"}`);
  if(c.due_today) bits.push(`${c.due_today} task${c.due_today === 1 ? "" : "s"} due today`);
  if(c.followups_pending) bits.push(`${c.followups_pending} visit follow-up${c.followups_pending === 1 ? "" : "s"} pending`);
  if((i.signals || []).length) bits.push(`${i.signals.length} relationship signal${i.signals.length === 1 ? "" : "s"} to look at`);
  return bits.length ? bits.join(", ").replace(/, ([^,]*)$/, " and $1") + "." : "A clear day — nothing overdue or due today.";
}

/* ---- Prompt ------------------------------------------------------------------------------------ */
function fmtTime(iso, tz){ const t = Date.parse(String(iso || "")); if(!Number.isFinite(t)) return ""; const d = new Date(t - (Number.isFinite(Number(tz)) ? Number(tz) : 300) * 60000);
  let hh = d.getUTCHours(); const mm = String(d.getUTCMinutes()).padStart(2, "0"), ap = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12; return `${hh}:${mm} ${ap}`; }
function buildPrompt(i, retryNote){
  const L = [], weekday = Number.isFinite(dayMs(i.date)) ? new Date(dayMs(i.date)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : i.date;
  const who = i.person.role === "relations" ? "Customer Relations (works every dealer)" : i.person.role === "rep" ? "sales rep" : "the President, working his own dealer book as a sales rep";
  L.push(`TODAY: ${weekday}. Morning brief for ${i.person.name || "the rep"} — ${who}.`);
  L.push(`Scope of the relationship signals: ${i.scope === "company_wide" ? "EVERY dealer in the company" : "this person's own dealer book only"}.`);
  const sect = (h, rows) => { if(rows.length) L.push(h + "\n" + rows.join("\n")); };
  sect("ROUTE TODAY (first stop first):", i.route ? i.route.stops.map(s => `- ${s.ref} ${s.dealer}${s.place ? ` (${s.place})` : ""}`) : []);
  sect("APPOINTMENTS TODAY:", i.appointments.map(a => `- ${a.ref} ${fmtTime(a.when, i.tz)} · ${a.what}${a.dealer ? ` · ${a.dealer}` : ""}`));
  sect("TASKS (overdue, due today or high priority):", i.tasks.map(t => `- ${t.ref} "${t.title}"${t.dealer ? ` · ${t.dealer}` : ""} · ${t.why}${t.due ? ` (due ${t.due})` : ""}`));
  sect("VISIT FOLLOW-UPS WAITING:", i.followups.map(f => `- ${f.ref} ${f.dealer} · visited ${f.visit_date}${f.due ? ` · follow-up due ${f.due}` : ""}${f.promised.length ? ` · rep promised: ${f.promised.join("; ")}` : ""}${f.dealer_said.length ? ` · dealer said: ${f.dealer_said.join("; ")}` : ""}`));
  sect("DEALS NEEDING ATTENTION:", i.deals.map(d => `- ${d.ref} "${d.title}" · ${d.dealer} · ${d.stage}${d.value ? ` · ${money(d.value)}` : ""} · ${d.why}`));
  sect("RELATIONSHIP SIGNALS (ranked, strongest first):", i.signals.map(s => `- ${s.ref} ${s.dealer}${i.scope === "company_wide" ? ` (${s.owner === "House" ? "House account" : s.owner + "'s dealer"})` : ""} · ${s.why}${s.also.length ? ` · also: ${s.also.join("; ")}` : ""}`));
  const c = i.counts;
  L.push(`COUNTS: ${c.open_tasks} open tasks (${c.overdue} overdue, ${c.due_today} due today) · ${c.followups_pending} visit follow-ups pending · ${c.deals_open} open deals.`);
  const mix = i.scope === "company_wide" && i.signals.length
    ? `\nThis person works every dealer: the focus list MUST mix their own work with the strongest company-wide relationship signals — at least ${Math.min(2, i.signals.length)} focus items must be S refs.` : "";
  return `You write a short morning brief for one person at HomeCare Provider Services (HCPS), a manufacturers' rep group selling home-medical-equipment lines to DME dealers. It answers: "What should I focus on today, and why?"

Use ONLY the facts below. Never invent a dealer, person, product, number, amount, date or conversation. Every focus item and watch-out must cite exactly one ref from the lists (R1, A2, T3, F1, D2, S4 …) — copy it exactly. If something is not in the facts, leave it out.${mix}

${L.join("\n\n")}

Return ONLY a compact, minified JSON object — one line, no markdown, nothing before or after it:
{"headline":"one plain sentence, at most 25 words","focus":[{"ref":"T1","reason":"why it matters today, at most 25 words","action":"one concrete thing to do, at most 15 words"}],"watch_outs":[{"ref":"S2","text":"at most 20 words"}],"first_stop":{"ref":"R1","tip":"at most 25 words"}}
Rules: 3 to 5 focus items, most important first, no two about the same ref. 0 to 3 watch_outs, none repeating a focus item. first_stop only when there is a route today, and its ref is R1. Omit any key whose value would be empty.${retryNote ? "\n\n" + retryNote : ""}`;
}

/* ---- Reading the answer ------------------------------------------------------------------------ */
function extractJson(text){
  const t = String(text == null ? "" : text).replace(/```(?:json)?/gi, "");
  for(let start = t.indexOf("{"); start >= 0; start = t.indexOf("{", start + 1)){
    let depth = 0, inStr = false, esc = false;
    for(let k = start; k < t.length; k++){
      const c = t[k];
      if(inStr){ if(esc) esc = false; else if(c === "\\") esc = true; else if(c === "\"") inStr = false; continue; }
      if(c === "\"") inStr = true; else if(c === "{") depth++;
      else if(c === "}"){ depth--; if(depth === 0){ try{ const o = JSON.parse(t.slice(start, k + 1)); if(o && typeof o === "object" && !Array.isArray(o)) return o; }catch(_){} break; } }
    }
  }
  return null;
}
/* Dollar amounts the model wrote must be ones the facts contain (to the dollar, or rounded to $k). */
function amountsOk(text, allowed){
  const m = String(text || "").match(/\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?/g) || [];
  return m.every(s => { const k = /[kK]$/.test(s), M = /[mM]$/.test(s); let n = Number(s.replace(/[^\d.]/g, "")); if(k) n *= 1000; if(M) n *= 1e6;
    return allowed.some(a => Math.abs(a - n) <= Math.max(1, (k || M) ? a * 0.06 : 1)); });
}
/* GROUNDING. An item stays only if its ref is one of the inputs; it then carries that input's real
   id, dealer and title (the model's own wording is used only for the reason and the action). */
function ground(raw, inputs){
  const R = inputs.refs || {}, A = inputs.amounts || [];
  let dropped = 0;
  const pick = (ref) => { const k = clean(ref, 8).toUpperCase(); return R[k] ? Object.assign({ ref: k }, R[k]) : null; };
  const focus = [], used = new Set();
  for(const f of (Array.isArray(raw && raw.focus) ? raw.focus : [])){
    const g = f && pick(f.ref), reason = clean(f && f.reason, 240), action = clean(f && f.action, 140);
    if(!g || !reason || used.has(g.ref) || !amountsOk(reason + " " + action, A)){ dropped++; continue; }
    used.add(g.ref);
    focus.push({ ref: g.ref, kind: g.kind, id: g.id, dealer_id: g.dealer_id || null, dealer: g.dealer || "", title: clean(g.title, 160), reason, action });
    if(focus.length >= 5) break;
  }
  const watch_outs = [];
  for(const w of (Array.isArray(raw && raw.watch_outs) ? raw.watch_outs : [])){
    const g = w && pick(w.ref), text = clean(w && w.text, 200);
    if(!g || !text || used.has(g.ref) || !amountsOk(text, A)){ dropped++; continue; }
    used.add(g.ref); watch_outs.push({ ref: g.ref, kind: g.kind, id: g.id, dealer_id: g.dealer_id || null, dealer: g.dealer || "", text });
    if(watch_outs.length >= 3) break;
  }
  let first_stop = null;
  const fs = raw && raw.first_stop;
  if(fs && inputs.route && inputs.route.stops.length){ const tip = clean(fs.tip, 220);
    if(clean(fs.ref, 8).toUpperCase() === "R1" && tip && amountsOk(tip, A)) first_stop = { dealer_id: inputs.route.stops[0].dealer_id, dealer: inputs.route.stops[0].dealer, tip }; else dropped++; }
  let headline = clean(raw && raw.headline, 220);
  if(!headline || !amountsOk(headline, A)){ if(headline) dropped++; headline = ruleHeadline(inputs); }
  if(!focus.length) return null;
  return { headline, focus, watch_outs, first_stop, dropped };
}

/* ---- One AI call (thinking off, as in _visit_ai.js) with one retry inside the time budget ------ */
const NO_THINKING = { type: "disabled" };
const RETRY_NOTE = "IMPORTANT: your previous answer was cut off, was not valid JSON, or cited refs that are not in the lists. Answer again: minified JSON only, refs copied exactly from the lists.";
async function callOnce(i, timeoutMs, retryNote){
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs)) : null;
  const send = thinking => i.fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl ? ctl.signal : undefined,
    headers: { "x-api-key": i.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ model: i.model, max_tokens: i.maxTokens || 1500, messages: [{ role: "user", content: buildPrompt(i.inputs, retryNote) }] }, thinking ? { thinking } : {})) });
  let r, t;
  try{ r = await send(NO_THINKING); t = await r.text().catch(() => "");
    if(r.status === 400 && /thinking/i.test(t)){ r = await send(null); t = await r.text().catch(() => ""); } }
  catch(e){ return { ok: false, error: "ai_timeout", retry: false }; }
  finally{ if(timer) clearTimeout(timer); }
  if(!r.ok) return { ok: false, error: "ai_error", retry: r.status >= 500 || r.status === 429 };
  let j = {}; try{ j = JSON.parse(t); }catch(_){}
  let text = ""; for(const c of ((j && j.content) || [])) if(c && typeof c.text === "string") text += c.text;
  const raw = extractJson(text);
  if(!raw) return { ok: false, error: j && j.stop_reason === "max_tokens" ? "ai_incomplete" : "ai_empty", retry: true };
  const content = ground(raw, i.inputs);
  if(!content) return { ok: false, error: "ai_ungrounded", retry: true };
  return { ok: true, content };
}
async function generate(i){
  if(!i.apiKey) return { ok: false, error: "ai_unavailable", attempts: 0 };
  const t0 = Date.now(), budget = i.budgetMs || 20000, minRetry = i.minRetryMs || 6000;
  let res = await callOnce(i, Math.min(i.timeoutMs || budget - 1000, budget)), attempts = 1;
  const left = budget - (Date.now() - t0);
  if(!res.ok && res.retry && left >= minRetry){ res = await callOnce(i, left - 500, RETRY_NOTE); attempts = 2; }
  return Object.assign(res, { attempts });
}

/* ==== PHASE 2C · END-OF-DAY RECAP ==================================================================
   The day's numbers are counted by code (recapInputs); the AI writes only the narrative. Every number the
   narrative states is checked against those counts (checkNumbers): a number next to "visits" must be a
   visit count, next to "tasks" a task count, and so on; any other number must be one of the facts. A
   narrative that fails is retried once with the exact figures, then rejected — the card then shows the
   counted facts with a plain sentence built from them (ruleRecap). Stored as kind "eod" in
   rep_daily_briefs, beside the Morning Brief. */
const STAGE_P = { identified: 0.1, contacted: 0.3, quoted: 0.6, won: 1, lost: 0 };
function recapInputs(day, opt){
  opt = opt || {};
  const r = day._recap || {}, e = day.end_of_day || {}, h = day.header || {}, tm = day.tomorrow || {};
  const visits = r.visits || [];
  const people = [...new Set(visits.flatMap(v => v.attendees || []).map(n => clean(n, 80)).filter(Boolean))];
  const opps = r.opportunities_created || [];
  const pipeline_added = Math.round(opps.reduce((a, o) => a + (Number(o.value) || 0) * (STAGE_P[o.stage] != null ? STAGE_P[o.stage] : 0.1), 0));
  const pipeline_value = Math.round(opps.reduce((a, o) => a + (Number(o.value) || 0), 0));
  const rc = visits.reduce((a, v) => a + (v.rep_commitments || []).length, 0), dc = visits.reduce((a, v) => a + (v.dealer_commitments || []).length, 0);
  const facts = {
    visits_completed: visits.filter(v => v.status === "done").length, visits_started: visits.length,
    people_met: people.length,
    commitments: rc + dc, rep_commitments: rc, dealer_commitments: dc,
    followup_tasks_created: (r.tasks_created || []).length,
    tasks_completed: (r.tasks_completed || []).length,
    opportunities_created: opps.length, pipeline_added, pipeline_value,
    emails_sent: e.followup_emails_sent || 0, emails_drafted: e.followup_emails_drafted || 0,
    unresolved_followups: h.followups_pending || 0, open_visit_tasks: r.open_visit_tasks || 0, overdue_tasks: h.overdue || 0,
    tomorrow_stops: tm.stops || 0, tasks_due_tomorrow: (r.tasks_due_tomorrow || []).length,
  };
  // Tomorrow's priorities, in the order to do them: the route, overdue work, what falls due tomorrow.
  const tomorrow = [];
  if(tm.stops) tomorrow.push({ kind: "route", id: tm.id, dealer_id: (tm.dealers && tm.dealers[0] && tm.dealers[0].dealer_id) || null, text: `${tm.name || "Route"} — ${tm.stops} stop${tm.stops === 1 ? "" : "s"}${tm.first_stop ? `, first ${tm.first_stop}` : ""}` });
  for(const t of (r.overdue || []).slice(0, 3)) tomorrow.push({ kind: "overdue", id: t.id, dealer_id: t.dealer_id, dealer: t.dealer, text: `Overdue: ${t.title}` });
  for(const f of (r.followups_due || []).slice(0, 3)) tomorrow.push({ kind: "followup", id: f.id, dealer_id: f.dealer_id, dealer: f.dealer, text: `Visit follow-up due ${f.due}` });
  for(const t of (r.tasks_due_tomorrow || []).slice(0, 4)) tomorrow.push({ kind: "task", id: t.id, dealer_id: t.dealer_id, dealer: t.dealer, text: t.title });
  const unresolved = (r.unresolved || []).slice(0, 6);
  // Numbers that may appear because they are part of a name or title in the facts ("Route 66 Medical").
  const nameNums = []; for(const s of [].concat(visits.map(v => v.dealer), people, tomorrow.map(x => x.text + " " + (x.dealer || "")), unresolved.map(u => u.dealer), opps.map(o => o.title + " " + (o.dealer || ""))))
    for(const m of String(s || "").match(/\d[\d,]*/g) || []) nameNums.push(Number(m.replace(/,/g, "")));
  return { date: h.date || opt.date || "", person: { name: (h.rep && h.rep.name) || "", role: opt.role || "rep" }, tz: opt.tz,
    facts, people, visits: visits.slice(0, 10), opportunities: opps.slice(0, 10), tasks_completed: (r.tasks_completed || []).slice(0, 10),
    tasks_created: (r.tasks_created || []).slice(0, 10), unresolved, tomorrow, nameNums: [...new Set(nameNums)] };
}
function recapKey(i){
  const f = i.facts || {};
  const parts = [i.date, Object.keys(f).sort().map(k => k + ":" + f[k]).join(","), (i.tomorrow || []).map(t => t.kind + ":" + t.id).join(",")].join("|");
  let h = 5381; for(let k = 0; k < parts.length; k++) h = ((h * 33) ^ parts.charCodeAt(k)) >>> 0;
  return h.toString(36) + "-" + parts.length.toString(36);
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
function ruleRecap(i){
  const f = i.facts, s = [];
  s.push(f.visits_started ? `You completed ${f.visits_completed} of ${plural(f.visits_started, "visit")} today${f.people_met ? ` and met ${plural(f.people_met, "person", "people")}` : ""}.` : "No visits were logged today.");
  if(f.commitments || f.followup_tasks_created) s.push(`${plural(f.commitments, "commitment")} recorded and ${plural(f.followup_tasks_created, "follow-up task")} created.`);
  if(f.tasks_completed) s.push(`${plural(f.tasks_completed, "task")} completed.`);
  if(f.opportunities_created) s.push(`${plural(f.opportunities_created, "deal")} added${f.pipeline_added ? ` (${money(f.pipeline_added)} in weighted pipeline)` : ""}.`);
  if(f.emails_sent || f.emails_drafted) s.push(`Follow-up emails: ${f.emails_sent} sent, ${f.emails_drafted} still in draft.`);
  if(f.unresolved_followups) s.push(`${plural(f.unresolved_followups, "visit follow-up")} still open.`);
  return s.join(" ");
}

/* ---- The number check -------------------------------------------------------------------------- */
const NUMWORDS = { no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const NUMCAT = [
  [/^visits?$/, ["visits_completed", "visits_started"]],
  [/^stops?$/, ["tomorrow_stops", "visits_completed", "visits_started"]],
  [/^(people|persons?|contacts?|attendees?|buyers?|owners?|decision-?makers?)$/, ["people_met"]],
  [/^(commitments?|promises?)$/, ["commitments", "rep_commitments", "dealer_commitments"]],
  [/^(tasks?|actions?|to-?dos?)$/, ["followup_tasks_created", "tasks_completed", "tasks_due_tomorrow", "overdue_tasks", "open_visit_tasks"]],
  [/^follow-?ups?$/, ["followup_tasks_created", "unresolved_followups", "open_visit_tasks"]],
  [/^(deals?|opportunit(y|ies))$/, ["opportunities_created"]],
  [/^(emails?|drafts?)$/, ["emails_sent", "emails_drafted"]],
];
const BREAK = new Set(["and", "or", "but", "with", "while", "plus", "of", "from", "to", "for", "at", "in", "on", "by", "that", "which", "who"]);
/* Words around the number that say WHICH count it is ("completed 3 visits" is the completed count, not
   the started one). Applied when they narrow the noun's choices to something; "2 of 3 visits" keeps the
   total (3) unqualified. */
const QUAL = [
  [/^(completed|finished|done|closed|wrapped)$/, ["visits_completed", "tasks_completed"]],
  [/^(started|began|logged)$/, ["visits_started"]],
  [/^(created|added|new|opened|generated|set)$/, ["followup_tasks_created", "opportunities_created"]],
  [/^sent$/, ["emails_sent"]],
  [/^(drafted|unsent)$/, ["emails_drafted"]],
  [/^(overdue|late)$/, ["overdue_tasks"]],
  [/^(open|remain|remaining|outstanding|pending|unresolved)$/, ["unresolved_followups", "open_visit_tasks", "overdue_tasks"]],
  [/^(met|meet|meeting)$/, ["people_met"]],
];
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
function checkNumbers(text, facts, extra){
  const f = facts || {}, bad = [];
  const all = new Set(Object.values(f).filter(v => Number.isFinite(v)).map(Number).concat((extra && extra.nameNums) || []));
  const money = [f.pipeline_added, f.pipeline_value].concat((extra && extra.amounts) || []).filter(n => Number(n) > 0);
  const toks = String(text || "").replace(/([.,;:!?()])(?=\s|$)/g, " $1 ").split(/\s+/).filter(Boolean);
  // The last qualifying verb in the current sentence: "you completed 1 visit and 2 tasks" — the 2 is a
  // completed count too, even though "and" sits between them.
  let sentQual = null;
  for(let k = 0; k < toks.length; k++){
    const raw = toks[k], prev = (toks[k - 1] || "").toLowerCase(), prev2 = (toks[k - 2] || "");
    if(/^[.;!?]$/.test(raw)){ sentQual = null; continue; }
    { const w0 = raw.toLowerCase().replace(/[^a-z-]/g, ""); for(const [re, keys] of QUAL) if(w0 && re.test(w0)) sentQual = keys; }
    let val = null, isWord = false, isMoney = false;
    const mm = raw.match(/^\$\s?(\d[\d,]*(?:\.\d+)?)([kKmM])?$/);
    if(mm){ isMoney = true; val = Number(mm[1].replace(/,/g, "")) * (/[kK]/.test(mm[2] || "") ? 1000 : /[mM]/.test(mm[2] || "") ? 1e6 : 1); }
    else if(/^\d[\d,]*(\.\d+)?%$/.test(raw)){ bad.push(raw); continue; }   // percentages are not counted facts
    else if(/^\d[\d,]*(\.\d+)?$/.test(raw)) val = Number(raw.replace(/,/g, ""));
    else if(/^\d{1,2}(:\d\d)?(am|pm)?$/i.test(raw) && /:|am|pm/i.test(raw)) continue;        // a time of day
    else if(/^\d+(st|nd|rd|th)$/i.test(raw)){ bad.push(raw); continue; }
    else if(/\d/.test(raw) && !/^[A-Za-z]/.test(raw)){ val = Number(raw.replace(/[^\d.]/g, "")); }
    else if(NUMWORDS[raw.toLowerCase()] != null){ val = NUMWORDS[raw.toLowerCase()]; isWord = true; }
    if(val == null || !Number.isFinite(val)) continue;
    if(isMoney){ if(!money.some(a => Math.abs(a - val) <= Math.max(1, /[kKmM]$/.test(raw) ? a * 0.06 : 1))) bad.push(raw); continue; }
    if(!isWord && (MONTHS.test(prev) || (MONTHS.test(prev2) && prev === "the"))) continue;   // a date: "October 5"
    if(!isWord && val >= 2000 && val <= 2099) continue;                                          // a year
    // The noun this number counts: the first category noun before a clause break, within four words.
    let cat = null;
    for(let j = k + 1; j <= k + 4 && j < toks.length; j++){
      const w = toks[j].toLowerCase().replace(/[^a-z-]/g, "");
      if(!w || BREAK.has(w) || /^[.,;:!?()]$/.test(toks[j])) break;
      for(const [re, keys] of NUMCAT) if(re.test(w)) cat = keys;   // keep going: the head noun is the last one ("follow-up tasks")
    }
    if(isWord && !cat) continue;            // "one of the dealers" — a word, not a count
    if(cat && !(prev === "of" && /^\d|^(one|two|three|four|five|six|seven|eight|nine|ten)$/i.test(prev2))){
      // Narrow by the words around it: up to three before, and the noun phrase after (to the clause break).
      const norm = w => w.toLowerCase().replace(/[^a-z-]/g, ""), ctx = [];
      for(let j = k - 1; j >= Math.max(0, k - 3); j--){ const w = norm(toks[j]); if(!w || BREAK.has(w)) break; ctx.push(w); }
      for(let j = k + 1; j <= k + 5 && j < toks.length; j++){ const w = norm(toks[j]); if(!w || BREAK.has(w)) break; ctx.push(w); }
      let local = false;
      for(const [re, keys] of QUAL) if(ctx.some(w => re.test(w))){ const n = cat.filter(x => keys.includes(x)); if(n.length){ cat = n; local = true; } }
      if(!local && sentQual && (prev === "and" || prev === "plus" || prev === ",")){ const n = cat.filter(x => sentQual.includes(x)); if(n.length) cat = n; }
    }
    if(cat){ if(!cat.some(key => Number(f[key]) === val)) bad.push(raw + " " + (toks[k + 1] || "")); }
    else if(!all.has(val)) bad.push(raw);
  }
  return { ok: bad.length === 0, bad };
}

function recapPrompt(i, retryNote){
  const f = i.facts, L = [];
  const weekday = Number.isFinite(dayMs(i.date)) ? new Date(dayMs(i.date)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }) : i.date;
  L.push(`TODAY: ${weekday}. End-of-day recap for ${i.person.name || "the rep"}.`);
  L.push(`FACTS (counted by the system — the ONLY numbers you may use):
- visits completed: ${f.visits_completed} (of ${f.visits_started} started)
- people met: ${f.people_met}${i.people.length ? ` (${i.people.slice(0, 12).join(", ")})` : ""}
- commitments made: ${f.commitments} (rep ${f.rep_commitments}, dealer ${f.dealer_commitments})
- follow-up tasks created: ${f.followup_tasks_created}
- tasks completed: ${f.tasks_completed}
- deals created: ${f.opportunities_created}; estimated pipeline added: ${money(f.pipeline_added)} weighted (${money(f.pipeline_value)} face value)
- follow-up emails: ${f.emails_sent} sent, ${f.emails_drafted} drafted and not sent
- visit follow-ups still open: ${f.unresolved_followups}; open tasks from visits: ${f.open_visit_tasks}; overdue tasks: ${f.overdue_tasks}
- tomorrow: ${f.tomorrow_stops} route stops, ${f.tasks_due_tomorrow} tasks due`);
  if(i.visits.length) L.push("TODAY'S VISITS:\n" + i.visits.map(v => `- ${v.dealer}${v.status === "done" ? "" : " (not finished)"}${v.summary ? `: ${clean(v.summary, 220)}` : ""}${(v.rep_commitments || []).length ? ` · promised: ${v.rep_commitments.slice(0, 3).join("; ")}` : ""}${(v.dealer_commitments || []).length ? ` · dealer said: ${v.dealer_commitments.slice(0, 3).join("; ")}` : ""}`).join("\n"));
  if(i.opportunities.length) L.push("DEALS ADDED:\n" + i.opportunities.map(o => `- ${o.title}${o.dealer ? ` · ${o.dealer}` : ""} · ${o.stage}${o.value ? ` · ${money(o.value)}` : ""}`).join("\n"));
  if(i.tasks_completed.length) L.push("TASKS COMPLETED:\n" + i.tasks_completed.map(t => `- ${t.title}${t.dealer ? ` · ${t.dealer}` : ""}`).join("\n"));
  if(i.unresolved.length) L.push("STILL OPEN:\n" + i.unresolved.map(u => `- ${u.dealer}: ${u.text}`).join("\n"));
  if(i.tomorrow.length) L.push("TOMORROW (in order):\n" + i.tomorrow.map(t => `- ${t.text}${t.dealer && !String(t.text).includes(t.dealer) ? ` · ${t.dealer}` : ""}`).join("\n"));
  return `You write a short end-of-day recap for one person at HomeCare Provider Services (HCPS), a manufacturers' rep group selling home-medical-equipment lines to DME dealers. Write it to them ("you"), plainly, like a good sales manager would.

STRICT NUMBER RULE: every number you write must be copied exactly from FACTS, next to what it counts ("3 visits", "2 follow-up tasks"). Never add, subtract, total, average or estimate; never write a percentage. If unsure, leave the number out. Never invent a dealer, person, product, amount or promise.

${L.join("\n\n")}

Return ONLY a compact, minified JSON object — one line, nothing before or after it:
{"narrative":"3 to 5 sentences: what got done today, what came out of the visits, what is still open","tomorrow":"1 or 2 sentences: what to do first tomorrow and why"}${retryNote ? "\n\n" + retryNote : ""}`;
}
async function recapOnce(i, timeoutMs, retryNote){
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs)) : null;
  const send = thinking => i.fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl ? ctl.signal : undefined,
    headers: { "x-api-key": i.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ model: i.model, max_tokens: i.maxTokens || 1000, messages: [{ role: "user", content: recapPrompt(i.inputs, retryNote) }] }, thinking ? { thinking } : {})) });
  let r, t;
  try{ r = await send(NO_THINKING); t = await r.text().catch(() => "");
    if(r.status === 400 && /thinking/i.test(t)){ r = await send(null); t = await r.text().catch(() => ""); } }
  catch(e){ return { ok: false, error: "ai_timeout", retry: false }; }
  finally{ if(timer) clearTimeout(timer); }
  if(!r.ok) return { ok: false, error: "ai_error", retry: r.status >= 500 || r.status === 429 };
  let j = {}; try{ j = JSON.parse(t); }catch(_){}
  let text = ""; for(const c of ((j && j.content) || [])) if(c && typeof c.text === "string") text += c.text;
  const raw = extractJson(text);
  const narrative = clean(raw && raw.narrative, 1200), tomorrow = clean(raw && raw.tomorrow, 400);
  if(!narrative) return { ok: false, error: j && j.stop_reason === "max_tokens" ? "ai_incomplete" : "ai_empty", retry: true };
  const extra = { nameNums: i.inputs.nameNums, amounts: i.inputs.opportunities.map(o => o.value) };
  const chk = checkNumbers(narrative + " " + tomorrow, i.inputs.facts, extra);
  if(!chk.ok) return { ok: false, error: "numbers_mismatch", bad: chk.bad, retry: true };
  return { ok: true, content: { narrative, tomorrow_text: tomorrow } };
}
async function generateRecap(i){
  if(!i.apiKey) return { ok: false, error: "ai_unavailable", attempts: 0 };
  const t0 = Date.now(), budget = i.budgetMs || 20000, minRetry = i.minRetryMs || 6000;
  let res = await recapOnce(i, Math.min(i.timeoutMs || budget - 1000, budget)), attempts = 1;
  const left = budget - (Date.now() - t0);
  if(!res.ok && res.retry && left >= minRetry){
    const f = i.inputs.facts;
    const note = `IMPORTANT: your previous answer ${res.bad ? `stated numbers that do not match the counted facts (${res.bad.slice(0, 5).join(", ")})` : "was cut off or not valid JSON"}. Answer again, minified JSON only. Use only these exact figures, each next to what it counts: ${f.visits_completed} visits completed, ${f.people_met} people met, ${f.commitments} commitments, ${f.followup_tasks_created} follow-up tasks created, ${f.tasks_completed} tasks completed, ${f.opportunities_created} deals, ${money(f.pipeline_added)} weighted pipeline, ${f.emails_sent} emails sent, ${f.emails_drafted} drafted, ${f.unresolved_followups} follow-ups open — or leave numbers out.`;
    res = await recapOnce(i, left - 500, note); attempts = 2;
  }
  return Object.assign(res, { attempts });
}

module.exports = { rankSignals, briefInputs, signalsKey, ground, generate, buildPrompt, ruleHeadline, amountsOk, readCart, extractJson, W,
  recapInputs, recapKey, ruleRecap, checkNumbers, recapPrompt, generateRecap };
