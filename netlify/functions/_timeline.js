/* Phase 2D — the Dealer 360 Relationship Timeline (crm-api `timeline`).

   ONE chronological history per dealer, built at read time from the stores that already exist. No
   activity table, no writer change, nothing written by reading it. Kept out of crm-api so the source
   readers, the "appears once" folding and the Golden milestone rules can be tested alone.

   Sources (each read for this dealer with a date bound and a row cap, all in parallel):
     visit     dealer_visit_reports (completed), with attendees and the tasks/deals it created
               — folds its visit note, its `visit` activity row (ref_type visit_report, or the
                 unlinked legacy row written at the same moment)
     call      call_outcomes — folds its call note (note_id) and its `call` activity row
     note      dealer_notes
     email     email_messages (synced Outlook) and email_sends (engine / visit mail)
               — folds the matching `email` / `campaign` activity rows
     task      dealer_tasks added / completed / dismissed
     deal      opportunities added (stage changes arrive with 2E)
     order     portal orders · Golden federation_orders (one entry per order) · monthly_sales as one
               line per month — folds the Golden order activity rows
     appt      service_requests — folds its `meeting` activity rows
     portal    HCPS ordering portal (dealer_sessions, intent_events, dealer_carts) and Golden portal
               (`golden` activity rows), reduced to ONE line per portal per day, plus milestones of
               their own: first sign-in ever, a sign-in after 30+ days away, a cart left open over
               $500 (approved 2026-10-03), and any order (an order event)
     other     every remaining dealer_activity row (logged touches, line activated, dealer added …)

   Paging: newest first, 50 a page; `before` is the cursor. A source that hits its row cap is complete
   only down to its oldest row (a day-grouped source down to its oldest WHOLE day), so a page never
   shows anything at or below the "floor" where some source may be incomplete; the next page starts
   just above it. Nothing is skipped and nothing repeats from one page to the next. */
const PAGE = 50;
const CAP = 60;                 // rows per one-row-per-event source (>= PAGE, so a page is always exact)
// Supabase returns at most 1000 rows per read (PostgREST max-rows), so no cap may exceed it — a read
// that comes back with 1000 rows is treated as cut off, never as complete.
const ROLL_CAP = 1000;          // rows per day-grouped source (portal events, email opens/clicks)
const SALES_CAP = 1000;
const SIGNIN_CAP = 200;
const CART_MILESTONE = 500;     // approved: a cart left open over $500 is its own event
const AWAY_DAYS = 30;           // approved: a sign-in after 30+ days away is its own event
const FOLD_MS = 2 * 60 * 1000;
const CATS = ["all", "visits", "calls", "emails", "tasks", "deals", "orders", "portal", "notes"];

const clean = (v, n) => { const s = (v == null ? "" : String(v)).replace(/\s+/g, " ").trim(); return s ? (s.length > (n || 300) ? s.slice(0, (n || 300) - 1).replace(/\s+\S*$/, "") + "…" : s) : ""; };
const ms = v => { const t = Date.parse(String(v || "")); return Number.isFinite(t) ? t : null; };
const iso = t => new Date(t).toISOString();
const money = n => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const low = s => String(s == null ? "" : s).trim().toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
// The person's own day (tz = the browser's getTimezoneOffset(), minutes; Eastern 240/300).
const dayKey = (t, tz) => new Date(t - tz * 60000).toISOString().slice(0, 10);
const dayStart = (t, tz) => Date.parse(dayKey(t, tz) + "T00:00:00Z") + tz * 60000;
const cartValue = c => { const items = (c && c.items) || []; let n = 0, v = 0; for(const it of items){ const q = Number(it.qty) || 0; n += q; v += (Number(it.p && it.p.base_price) || 0) * q; } return { items: n, value: Math.round(v) }; };

/* ---- reading ------------------------------------------------------------------------------------ */
async function read(sbGet, did, opt){
  const before = opt.before, B = encodeURIComponent(iso(before)), tz = opt.tz;
  const D = encodeURIComponent(did);
  const rollEnd = dayStart(before, tz) + 86400000;                       // whole days, so a day line is complete
  const RE = encodeURIComponent(iso(rollEnd));
  const want = new Set(opt.cat === "all" ? CATS : [opt.cat]);
  const on = (...c) => c.some(x => want.has(x));
  // kind: simple = one row per event (cap >= PAGE) · roll = grouped by day · months = monthly sales ·
  // meta = only used to judge milestones. col = the row's time.
  const q = (label, path, cap, kind, col) => sbGet(path).then(rows => ({ label, rows: rows || [], cap, kind, col }), () => ({ label, rows: [], cap, kind, col, failed: true }));
  const S = (label, table, filters, select, col, cap) => q(label, `${table}?dealer_id=eq.${D}${filters ? "&" + filters : ""}&${col}=lt.${B}&select=${select}&order=${col}.desc&limit=${cap || CAP}`, cap || CAP, "simple", col);
  const ROLL = (label, table, filters, select, col) => q(label, `${table}?dealer_id=eq.${D}${filters ? "&" + filters : ""}&${col}=lt.${RE}&select=${select}&order=${col}.desc&limit=${ROLL_CAP}`, ROLL_CAP, "roll", col);
  const jobs = [];
  if(on("visits")){
    jobs.push(S("visits", "dealer_visit_reports", "completed_at=not.is.null", "id,rep_name,rep_email,checkin_at,completed_at,approved_at,summary,visit_note_id,followup_status,duration_min", "checkin_at"));
    jobs.push(S("appts", "service_requests", "", "id,service,meeting_type,start_at,created_at,status,rep_name", "start_at"));
  }
  if(on("calls")) jobs.push(S("calls", "call_outcomes", "", "id,rep_name,outcome,manufacturer,talked_to,rep_notes,next_step,follow_up_on,note_id,called_at", "called_at"));
  if(on("visits", "calls", "notes")) jobs.push(S("notes", "dealer_notes", "", "id,kind,body,author_name,author_email,created_at", "created_at"));
  // Every non-Golden activity row: what is folded into a visit/call/email/appointment above, and
  // everything else (logged touches, system events) shown as it is.
  jobs.push(S("activity", "dealer_activity", "kind=neq.golden", "*", "created_at", CAP * 2));
  if(on("emails")){
    jobs.push(S("emails", "email_messages", "", "id,direction,subject,snippet,from_address,from_name,mailbox_upn,sent_at,received_at", "received_at"));
    jobs.push(S("sends", "email_sends", "", "id,template,contact_email,sent_at", "sent_at"));
    jobs.push(ROLL("engage", "intent_events", "event_type=in.(email_open,email_click)", "event_type,occurred_at", "occurred_at"));
  }
  if(on("tasks")){
    jobs.push(S("tasks_new", "dealer_tasks", "", "id,title,status,due_date,priority,assigned_rep,origin_type,source,created_at", "created_at"));
    jobs.push(S("tasks_done", "dealer_tasks", "status=in.(done,dismissed)", "id,title,status,assigned_rep,completed_by,done_at", "done_at"));
  }
  if(on("deals")) jobs.push(S("deals", "opportunities", "", "id,title,stage,status,value,owner_rep,origin_type,created_at", "created_at"));
  // Golden orders are read for the Portal view too, so their purchase rows fold the same way everywhere.
  if(on("orders", "portal")) jobs.push(S("gorders", "federation_orders", "", "event_id,external_order_id,order_total,line_count,status,occurred_at", "occurred_at"));
  if(on("orders")){
    jobs.push(S("orders", "orders", "", "id,manufacturer,status,subtotal,po_number,submitted_at", "submitted_at"));
    // A month's line sits at noon on its first day, so it belongs before the cursor when that is earlier.
    jobs.push(q("sales", `monthly_sales?dealer_id=eq.${D}&period=lte.${iso(before - 12 * 3600000 - 1).slice(0, 10)}&select=period,manufacturer,amount&order=period.desc&limit=${SALES_CAP}`, SALES_CAP, "months", "period"));
  }
  if(on("orders", "portal")) jobs.push(ROLL("golden", "dealer_activity", "kind=eq.golden", "id,subject,detail,created_at", "created_at"));
  if(on("portal")){
    jobs.push(ROLL("sessions", "dealer_sessions", "", "uid,login_at", "login_at"));
    jobs.push(ROLL("portal_ev", "intent_events", "source=eq.ordering&event_type=in.(product_view,product_view_repeat,pricing_view,order_page,order_started)", "event_type,occurred_at", "occurred_at"));
    jobs.push(S("carts", "dealer_carts", "", "uid,cart,updated_at", "updated_at", 20));
    // Golden sign-ins on their own, for the milestones (first ever, back after 30+ days).
    jobs.push(q("gold_signins", `dealer_activity?dealer_id=eq.${D}&kind=eq.golden&subject=eq.${encodeURIComponent("Signed in to the Golden portal")}&created_at=lt.${RE}&select=id,created_at&order=created_at.desc&limit=${SIGNIN_CAP}`, SIGNIN_CAP, "meta", "created_at"));
  }
  const res = await Promise.all(jobs);
  const raw = {}; for(const r of res) raw[r.label] = r;
  // Visit details for the visits shown: attendees, and the tasks / deals each one created.
  const vids = ((raw.visits && raw.visits.rows) || []).map(v => v.id).filter(Boolean);
  if(vids.length){
    const inl = vids.map(encodeURIComponent).join(",");
    const [parts, vt, vo] = await Promise.all([
      sbGet(`dealer_visit_participants?visit_report_id=in.(${inl})&select=visit_report_id,name_snapshot,attended`).catch(() => []),
      sbGet(`dealer_tasks?origin_type=eq.visit_report&origin_id=in.(${inl})&select=id,origin_id,status`).catch(() => []),
      sbGet(`opportunities?origin_type=eq.visit_report&origin_id=in.(${inl})&select=id,origin_id`).catch(() => []),
    ]);
    raw.visit_parts = parts || []; raw.visit_tasks = vt || []; raw.visit_opps = vo || [];
  }
  return raw;
}

/* ---- building ----------------------------------------------------------------------------------- */
function build(raw, opt){
  const before = opt.before, tz = opt.tz, cat = opt.cat || "all";
  const R = k => (raw[k] && raw[k].rows) || [];
  const ev = [];
  const add = (e) => { if(e.t == null || !(e.t < before)) return; ev.push(e); };
  const folded = new Set();             // activity / note ids shown inside another entry
  const near = (a, b, w) => a != null && b != null && Math.abs(a - b) <= (w || FOLD_MS);

  const notes = R("notes"), acts = R("activity");
  const actT = a => ms(a.created_at), noteT = n => ms(n.created_at);

  // Visits — one entry each, with what came out of it.
  const parts = raw.visit_parts || [], vt = raw.visit_tasks || [], vo = raw.visit_opps || [];
  for(const v of R("visits")){
    const t = ms(v.checkin_at) || ms(v.completed_at), done = ms(v.completed_at);
    if(v.visit_note_id) folded.add("n:" + v.visit_note_id);
    for(const a of acts) if(a.kind === "visit" && ((a.ref_type === "visit_report" && String(a.ref_id) === String(v.id)) || (!a.ref_id && (near(actT(a), done) || near(actT(a), t))))) folded.add("a:" + a.id);
    for(const n of notes) if(n.kind === "visit" && !folded.has("n:" + n.id) && (near(noteT(n), done) || near(noteT(n), t))) folded.add("n:" + n.id);
    const who = parts.filter(p => String(p.visit_report_id) === String(v.id) && p.attended !== false).map(p => p.name_snapshot).filter(Boolean);
    const nt = vt.filter(x => String(x.origin_id) === String(v.id)).length, no = vo.filter(x => String(x.origin_id) === String(v.id)).length;
    const s = (v.summary && typeof v.summary === "object") ? v.summary : {};
    const bits = [who.length ? "With " + who.join(", ") : "", nt ? plural(nt, "task") : "", no ? plural(no, "deal") : "", v.followup_status === "pending" ? "follow-up open" : v.followup_status === "complete" ? "follow-up done" : ""].filter(Boolean);
    add({ id: "visit:" + v.id, cat: "visits", kind: "visit", t, title: `Visit${v.rep_name ? " — " + v.rep_name : ""}${v.duration_min != null ? ` · ${v.duration_min} min` : ""}`,
      detail: clean(s.meeting_summary, 400), meta: bits.join(" · "), who: v.rep_name || v.rep_email || "", ref: { type: "visit_report", id: v.id } });
  }
  // Appointments — folds the meeting activity rows written when it was booked / scheduled / completed.
  for(const r of R("appts")){
    const t = ms(r.start_at), made = ms(r.created_at);
    for(const a of acts) if(a.kind === "meeting" && (near(actT(a), made, 10 * 60000) || (actT(a) != null && t != null && dayKey(actT(a), tz) === dayKey(t, tz)))) folded.add("a:" + a.id);
    add({ id: "appt:" + r.id, cat: "visits", kind: "appt", t, title: `Appointment — ${clean(r.meeting_type || r.service || "Meeting", 80)}`, meta: [r.status ? String(r.status) : "", r.rep_name || ""].filter(Boolean).join(" · "), who: r.rep_name || "" });
  }
  // Calls — folds the call note and the call activity row.
  for(const c of R("calls")){
    const t = ms(c.called_at);
    if(c.note_id) folded.add("n:" + c.note_id);
    const a = acts.find(x => x.kind === "call" && !folded.has("a:" + x.id) && near(actT(x), t, 5 * 60000)); if(a) folded.add("a:" + a.id);
    const lab = String(c.outcome || "").replace(/_/g, " ");
    add({ id: "call:" + c.id, cat: "calls", kind: "call", t, title: `Call — ${lab || "logged"}${c.manufacturer ? " · " + clean(c.manufacturer, 40) : ""}`,
      detail: clean([c.talked_to ? "Talked to " + c.talked_to : "", c.rep_notes].filter(Boolean).join(". "), 400),
      meta: [c.next_step ? "Next: " + clean(c.next_step, 80) : "", c.follow_up_on ? "follow up " + c.follow_up_on : ""].filter(Boolean).join(" · "), who: c.rep_name || "" });
  }
  // Emails — a synced message or an engine/visit send, each once.
  const msgs = R("emails"), sends = R("sends");
  for(const m of msgs){
    const t = ms(m.received_at) || ms(m.sent_at), out = m.direction === "outbound";
    if(out) for(const a of acts) if(a.kind === "email" && !folded.has("a:" + a.id) && low(a.subject) && low(a.subject) === low(m.subject) && near(actT(a), t, 15 * 60000)) folded.add("a:" + a.id);
    add({ id: "email:" + m.id, cat: "emails", kind: out ? "email_out" : "email_in", t, title: `${out ? "Email sent" : "Email received"}: ${clean(m.subject, 120) || "(no subject)"}`,
      detail: clean(m.snippet, 200), who: out ? (m.mailbox_upn || "") : (m.from_name || m.from_address || "") });
  }
  const SENT_SUBJ = { visit_followup: /^visit follow-up sent/i, visit_notice: /^upcoming-visit notice sent/i };
  for(const s of sends){
    const t = ms(s.sent_at);
    for(const a of acts){ if(folded.has("a:" + a.id) || !(a.kind === "campaign" || a.kind === "email") || !near(actT(a), t, 10 * 60000)) continue;
      if(a.contact_email && s.contact_email && low(a.contact_email) !== low(s.contact_email)) continue;
      const re = SENT_SUBJ[s.template];
      if(a.kind === "campaign" ? new RegExp(String(s.template || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(a.subject || "") || /^auto email/i.test(a.subject || "") : (re ? re.test(a.subject || "") : false)) { folded.add("a:" + a.id); break; } }
    const nice = String(s.template || "email").replace(/_/g, " ");
    add({ id: "send:" + s.id, cat: "emails", kind: "send", t, title: `Email sent: ${nice}`, meta: s.contact_email ? "to " + s.contact_email : "", who: "HCPS" });
  }
  // Email engagement (opens / clicks) — one line a day.
  dayLines(R("engage"), x => ms(x.occurred_at), tz, (day, rows, t) => {
    const o = rows.filter(r => r.event_type === "email_open").length, c = rows.length - o;
    add({ id: "engage:" + day, cat: "emails", kind: "engage", t, title: "Email engagement", meta: [o ? plural(o, "open") : "", c ? plural(c, "click") : ""].filter(Boolean).join(", ") });
  });
  // Tasks — added, completed, dismissed.
  for(const k of R("tasks_new")) add({ id: "task-new:" + k.id, cat: "tasks", kind: "task_new", t: ms(k.created_at), title: `Task added: ${clean(k.title, 140)}`,
    meta: [k.due_date ? "due " + k.due_date : "", k.priority === "high" ? "high priority" : "", k.origin_type === "visit_report" ? "from a visit" : k.source === "auto" ? "automatic" : ""].filter(Boolean).join(" · "), who: k.assigned_rep || "" });
  for(const k of R("tasks_done")) add({ id: "task-done:" + k.id, cat: "tasks", kind: k.status === "dismissed" ? "task_dismissed" : "task_done", t: ms(k.done_at),
    title: `Task ${k.status === "dismissed" ? "dismissed" : "completed"}: ${clean(k.title, 140)}`, who: k.completed_by || k.assigned_rep || "" });
  // Deals added.
  for(const o of R("deals")) add({ id: "deal:" + o.id, cat: "deals", kind: "deal", t: ms(o.created_at), title: `Deal added: ${clean(o.title, 140)}`,
    meta: [o.stage || "", Number(o.value) ? money(o.value) : "", o.origin_type === "visit_report" ? "from a visit" : ""].filter(Boolean).join(" · "), who: o.owner_rep || "" });
  // Orders: portal, Golden (one entry per order), and monthly sales as one line per month.
  for(const o of R("orders")) add({ id: "order:" + o.id, cat: "orders", kind: "order", t: ms(o.submitted_at), title: `Portal order${o.manufacturer ? " — " + clean(o.manufacturer, 60) : ""}${Number(o.subtotal) ? " · " + money(o.subtotal) : ""}`,
    meta: [o.po_number ? "PO " + clean(o.po_number, 40) : "", o.status || ""].filter(Boolean).join(" · "), who: "Dealer (ordering portal)" });
  const gby = new Map();
  for(const g of R("gorders")){ const k = g.external_order_id ? "x:" + g.external_order_id : "e:" + g.event_id, t = ms(g.occurred_at); const cur = gby.get(k);
    if(!cur) gby.set(k, { first: t, last: t, status: g.status, total: Number(g.order_total) || 0, lines: Number(g.line_count) || 0, ext: g.external_order_id || "" });
    else { if(t < cur.first) cur.first = t; if(t >= cur.last){ cur.last = t; cur.status = g.status || cur.status; } cur.total = cur.total || Number(g.order_total) || 0; cur.lines = cur.lines || Number(g.line_count) || 0; } }
  const gold = R("golden"), gorders = [...gby.entries()];
  const goldOrderRow = s => /^(placed an order|order completed)/i.test(s || ""), goldBuyRow = s => /^purchased /i.test(s || "");
  for(const [k, g] of gorders){
    for(const a of gold){ const at = ms(a.created_at);
      if(goldOrderRow(a.subject) && ((g.ext && String(a.subject).includes("#" + g.ext)) || near(at, g.first, 10 * 60000) || near(at, g.last, 10 * 60000))) folded.add("g:" + a.id);
      else if(goldBuyRow(a.subject) && near(at, g.first, 86400000)) folded.add("g:" + a.id); }
    add({ id: "gorder:" + k, cat: "orders", kind: "gorder", t: g.first, title: `Golden order${g.total ? " · " + money(g.total) : ""}${g.ext ? ` (#${clean(g.ext, 40)})` : ""}`,
      meta: [g.lines ? plural(g.lines, "line") : "", g.status === "completed" ? "completed" : "placed"].filter(Boolean).join(" · "), who: "Dealer (Golden portal)" });
  }
  // Golden order rows with no federation order behind them still show — once each.
  for(const a of gold) if(goldOrderRow(a.subject) && !folded.has("g:" + a.id)){ folded.add("g:" + a.id);
    add({ id: "gact:" + a.id, cat: "orders", kind: "gorder", t: ms(a.created_at), title: clean(a.subject, 140), who: "Dealer (Golden portal)" }); }
  const months = new Map();
  for(const r of R("sales")){ const m = String(r.period || "").slice(0, 7); if(!m) continue; const x = months.get(m) || { amt: 0, lines: new Set() }; x.amt += Number(r.amount) || 0; if(r.manufacturer) x.lines.add(r.manufacturer); months.set(m, x); }
  const salesTrunc = raw.sales && raw.sales.rows.length >= raw.sales.cap;
  const salesOldest = salesTrunc ? [...months.keys()].sort()[0] : null;
  for(const [m, x] of months){ if(m === salesOldest) continue;            // a month cut off by the cap is shown on the next page
    const t = Date.parse(m + "-01T12:00:00Z"), label = new Date(t).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    add({ id: "sales:" + m, cat: "orders", kind: "sales", t, title: `${label} sales · ${money(x.amt)}`, meta: [...x.lines].slice(0, 6).map(s => s.replace(/[-_]+/g, " ")).join(", "), who: "Sales reports" }); }

  // Portal — one line per portal per day, plus milestones.
  const signGold = a => /^signed in to the golden portal/i.test(a.subject || "");
  const cartGold = a => /^abandoned cart/i.test(a.subject || "");
  const signalGold = a => /^golden follow-up signal/i.test(a.subject || "");
  const amt = s => { const m = /\$([\d,]+(?:\.\d+)?)/.exec(String(s || "")); return m ? Number(m[1].replace(/,/g, "")) : 0; };
  // Sign-in milestones from a run of sign-ins, oldest first. The oldest one is "first ever" only when
  // the run is the whole history (it didn't hit its cap); otherwise its predecessor is unknown.
  const signMilestones = (times, whole, emit) => { for(let i = 0; i < times.length; i++){ const t = times[i].t;
    if(i === 0){ if(whole) emit("first", times[i]); continue; }
    if(t - times[i - 1].t >= AWAY_DAYS * 86400000) emit("back", times[i], Math.floor((t - times[i - 1].t) / 86400000)); } };
  let goldFirstAt = null;               // the first Golden sign-in, when this page knows it
  if(cat === "all" || cat === "portal"){
    // Golden.
    const gRows = gold.filter(a => !folded.has("g:" + a.id) && !goldOrderRow(a.subject));
    const gs = R("gold_signins").map(a => ({ id: a.id, t: ms(a.created_at) })).filter(x => x.t != null).sort((x, y) => x.t - y.t);
    signMilestones(gs, !!raw.gold_signins && raw.gold_signins.rows.length < raw.gold_signins.cap, (k, x, days) => { folded.add("g:" + x.id); if(k === "first") goldFirstAt = x.t;
      add({ id: `ms:gold-${k}:${x.id}`, cat: "portal", kind: "milestone", t: x.t, title: k === "first" ? "First sign-in to the Golden portal" : `Back on the Golden portal after ${days} days`, who: "Dealer (Golden portal)" }); });
    for(const a of gRows) if(cartGold(a) && amt(a.subject) > CART_MILESTONE){ folded.add("g:" + a.id); add({ id: "ms:gold-cart:" + a.id, cat: "portal", kind: "milestone", t: ms(a.created_at), title: `Golden cart left open · ${money(amt(a.subject))}`, who: "Dealer (Golden portal)" }); }
    for(const a of gRows) if(signalGold(a)){ folded.add("g:" + a.id); add({ id: "gsig:" + a.id, cat: "portal", kind: "portal", t: ms(a.created_at), title: clean(a.subject, 140), detail: clean(a.detail, 200), who: "Golden portal" }); }
    dayLines(gRows.filter(a => !folded.has("g:" + a.id)), a => ms(a.created_at), tz, (day, rows, t) => {
      const c = { sign: 0, view: 0, click: 0, cart: 0, buy: 0, other: 0 };
      for(const a of rows){ const s = a.subject || ""; if(signGold(a)) c.sign++; else if(/^viewed/i.test(s)) c.view++; else if(/^clicked/i.test(s)) c.click++; else if(/^added .* to cart|^added an item/i.test(s) || cartGold(a)) c.cart++; else if(goldBuyRow(s)) c.buy++; else c.other++; }
      add({ id: "golden:" + day, cat: "portal", kind: "golden", t, title: "Golden portal",
        meta: [c.sign ? plural(c.sign, "sign-in") : "", c.view ? plural(c.view, "product viewed", "products viewed") : "", c.click ? plural(c.click, "click") : "", c.cart ? `${c.cart} added to cart` : "", c.buy ? `${c.buy} purchased` : "", c.other ? plural(c.other, "other event") : ""].filter(Boolean).join(", ") });
    });
    // HCPS ordering portal.
    const ses = R("sessions").map(x => ({ id: x.uid + "|" + x.login_at, t: ms(x.login_at) })).filter(x => x.t != null).sort((x, y) => x.t - y.t);
    const ms_ = new Set();
    signMilestones(ses, !!raw.sessions && raw.sessions.rows.length < raw.sessions.cap, (k, x, days) => { ms_.add(x.id);
      add({ id: `ms:portal-${k}:${x.t}`, cat: "portal", kind: "milestone", t: x.t, title: k === "first" ? "First sign-in to the HCPS ordering portal" : `Back on the ordering portal after ${days} days`, who: "Dealer (ordering portal)" }); });
    const plain = ses.filter(x => !ms_.has(x.id)).map(x => ({ k: "sign", t: x.t }));
    for(const e of R("portal_ev")) plain.push({ k: e.event_type, t: ms(e.occurred_at) });
    dayLines(plain, x => x.t, tz, (day, rows, t) => {
      const n = k => rows.filter(r => k.includes(r.k)).length;
      const s = n(["sign"]), v = n(["product_view", "product_view_repeat"]), p = n(["pricing_view"]), o = n(["order_page", "order_started"]);
      add({ id: "portal:" + day, cat: "portal", kind: "portal", t, title: "HCPS ordering portal", meta: [s ? plural(s, "sign-in") : "", v ? plural(v, "product viewed", "products viewed") : "", p ? plural(p, "pricing view") : "", o ? plural(o, "order page visit") : ""].filter(Boolean).join(", ") });
    });
    for(const c of R("carts")){ const k = cartValue(c.cart); if(k.value > CART_MILESTONE)
      add({ id: "ms:cart:" + (c.uid || "") + ":" + c.updated_at, cat: "portal", kind: "milestone", t: ms(c.updated_at), title: `Ordering-portal cart left open · ${money(k.value)}`, meta: plural(k.items, "item"), who: "Dealer (ordering portal)" }); }
  }

  // Notes not folded into a visit or a call.
  for(const n of notes){ if(folded.has("n:" + n.id)) continue;
    // A legacy logged touch writes a note and an activity row together — show it once.
    for(const a of acts) if(!folded.has("a:" + a.id) && a.kind === (n.kind || "note") && near(actT(a), noteT(n))) folded.add("a:" + a.id);
    const k = n.kind || "note";
    add({ id: "note:" + n.id, cat: k === "visit" ? "visits" : k === "call" ? "calls" : "notes", kind: "note", t: noteT(n), title: `${k === "note" ? "Note" : k.charAt(0).toUpperCase() + k.slice(1) + " note"}`,
      detail: clean(n.body, 400), who: n.author_name || n.author_email || "" }); }
  // Every other activity row, as it is (logged touches, line activated, dealer added …).
  const ACAT = { visit: "visits", meeting: "visits", call: "calls", email: "emails", campaign: "emails", note: "notes" };
  for(const a of acts){ if(folded.has("a:" + a.id)) continue;
    const firstGold = /^activated — first golden sign-in/i.test(a.subject || "");
    // The federation writer's "Activated — first Golden sign-in" row IS that milestone: shown once.
    if(firstGold && goldFirstAt != null && Math.abs(actT(a) - goldFirstAt) <= 86400000) continue;
    add({ id: "act:" + a.id, cat: firstGold ? "portal" : (ACAT[a.kind] || "other"), kind: firstGold ? "milestone" : (a.kind || "system"), t: actT(a), title: clean(a.subject || a.kind, 160), detail: clean(a.detail, 300), who: a.actor || a.actor_email || "" }); }

  // ---- the page ----
  // The floor: at or below it some source may be incomplete (it hit its cap), so those entries wait for
  // the next page, which starts just above it.
  let floor = -Infinity;
  for(const r of Object.values(raw)){
    if(!r || !r.rows || !r.kind || r.kind === "meta" || r.rows.length < r.cap) continue;
    const ts = r.rows.map(x => ms(x[r.col])).filter(x => x != null); if(!ts.length) continue;
    const oldest = Math.min(...ts), newest = Math.max(...ts);
    if(r.kind === "simple") floor = Math.max(floor, oldest);
    // A day-grouped source: its oldest day may be cut short, so it is complete from the next day on
    // (unless every row is from that one day — then that day is shown as far as it goes).
    if(r.kind === "roll"){ const f = dayStart(oldest, tz) + 86400000; floor = Math.max(floor, f > newest ? oldest : f - 1); }
    if(r.kind === "months") floor = Math.max(floor, Date.parse(String(r.rows.map(x => x.period).sort()[0]).slice(0, 7) + "-01T12:00:00Z"));
  }
  let list = ev.filter(e => e.t > floor);
  if(cat !== "all") list = list.filter(e => e.cat === cat);
  list.sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : 1));
  let page = list.slice(0, PAGE), next = null;
  if(list.length > PAGE){ const cut = page[page.length - 1].t; page = list.filter(e => e.t >= cut); next = cut; }   // never split a millisecond
  else if(floor > -Infinity) next = floor + 1;                              // times are whole ms: "> floor" then "< floor + 1"
  return { events: page.map(e => ({ id: e.id, cat: e.cat, kind: e.kind, at: iso(e.t), title: e.title, detail: e.detail || "", meta: e.meta || "", who: e.who || "", ref: e.ref || null })),
    next_before: next == null ? null : iso(next) };
}
// Group rows by the person's local day; the line's time is the latest row of that day.
function dayLines(rows, tOf, tz, emit){
  const by = new Map();
  for(const r of rows){ const t = tOf(r); if(t == null) continue; const k = dayKey(t, tz); const g = by.get(k) || { rows: [], t: -Infinity }; g.rows.push(r); if(t > g.t) g.t = t; by.set(k, g); }
  for(const [k, g] of by) emit(k, g.rows, g.t);
}

async function timeline(sbGet, opt){
  const before = ms(opt.before) || Date.now();
  const tz = Number.isFinite(Number(opt.tz)) ? Math.max(-840, Math.min(840, Number(opt.tz))) : 300;
  const cat = CATS.includes(opt.filter) ? opt.filter : "all";
  const raw = await read(sbGet, String(opt.dealer_id), { before, tz, cat });
  return Object.assign({ filter: cat, page_size: PAGE }, build(raw, { before, tz, cat }));
}
module.exports = { timeline, build, read, PAGE, CAP, ROLL_CAP, CATS, CART_MILESTONE, AWAY_DAYS };
