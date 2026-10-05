/* Phase 2E — the Conversion report (pipeline-api `conversion`), computed from the existing deals
   (`opportunities`) and their recorded history (`opportunity_events`). Pure: the caller loads the rows
   for exactly the deals the person may see, this only counts. No commission figures, ever.

   History started with one BASELINE entry per deal that existed then: a baseline is where a deal stood,
   not a move. So moves, closes and "entered Quoted" count only created/change entries; time in a stage
   is measured only for stages whose ENTRY was recorded (a stage that started at the baseline is left
   out — how long it had already lasted is unknown).

   Possible order match (approved rule, never attribution): an order for the SAME dealer and the SAME
   manufacturer within 120 days AFTER the deal was created. The manufacturer must be known for certain:
   the deal's manufacturer slug, or a free-text line that equals exactly one manufacturer's slug or name.
   Anything else stays unmatched. */
const STAGES = ["identified", "contacted", "quoted", "won", "lost"];
const STAGE_PROB = { identified: 0.1, contacted: 0.3, quoted: 0.6, won: 1, lost: 0 };
const OPEN_STAGES = ["identified", "contacted", "quoted"];
const MATCH_DAYS = 120;
const DAY = 86400000;

const ms = v => { const t = typeof v === "number" ? v : v instanceof Date ? v.getTime() : Date.parse(String(v || "")); return Number.isFinite(t) ? t : null; };
const low = s => String(s == null ? "" : s).trim().toLowerCase();
const mnorm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const median = a => { if(!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const round1 = n => n == null ? null : Math.round(n * 10) / 10;
const prob = o => o.probability != null && o.probability !== "" ? Number(o.probability) : (STAGE_PROB[o.stage] || 0);
const fromVisit = o => o.origin_type === "visit_report" || o.source === "visit";

// The manufacturer a deal is about, only when it is certain.
function manufacturerOf(o, mfrs){
  const bySlug = new Map((mfrs || []).map(m => [String(m.slug), m]));
  if(o.manufacturer && bySlug.has(String(o.manufacturer))) return String(o.manufacturer);
  const n = mnorm(o.line);
  if(!n) return null;
  const hits = (mfrs || []).filter(m => mnorm(m.slug) === n || mnorm(m.name) === n);
  return hits.length === 1 ? String(hits[0].slug) : null;
}

function compute(d){
  const from = ms(d.from), to = ms(d.to), inRange = t => t != null && t >= from && t < to;
  const opps = d.opps || [], mfrs = d.mfrs || [];
  const mName = Object.fromEntries(mfrs.map(m => [m.slug, m.name || m.slug]));
  const byOpp = new Map();
  for(const e of (d.events || [])){ const k = String(e.opportunity_id); if(!byOpp.has(k)) byOpp.set(k, []); byOpp.get(k).push(e); }
  for(const list of byOpp.values()) list.sort((a, b) => (ms(a.changed_at) - ms(b.changed_at)) || ((a.kind === "baseline" || a.kind === "created") ? -1 : 1));
  const firstEvent = [...byOpp.values()].map(l => ms(l[0] && l[0].changed_at)).filter(x => x != null);
  const baselines = (d.events || []).filter(e => e.kind === "baseline").map(e => ms(e.changed_at)).filter(x => x != null);

  // Per group (everyone / a rep / a manufacturer) the same counters.
  const blank = () => ({ created: 0, from_visits: 0, added_value: 0, added_weighted: 0, entered_quoted: 0, won: 0, won_value: 0, lost: 0, lost_value: 0, open: 0, open_value: 0, open_weighted: 0 });
  const total = blank(), reps = new Map(), makers = new Map();
  const repKey = o => low(o.owner_email) || low(o.owner_rep) || "(none)";
  const repLabel = o => o.owner_rep || o.owner_email || "No owner";
  const grp = (map, key, label) => { if(!map.has(key)) map.set(key, Object.assign({ key, label }, blank())); return map.get(key); };
  const groupsOf = o => { const m = manufacturerOf(o, mfrs);
    return [total, grp(reps, repKey(o), repLabel(o)), grp(makers, m || "(none)", m ? (mName[m] || m) : "No manufacturer recorded")]; };
  const movement = new Map(), segs = {};

  for(const o of opps){
    const G = groupsOf(o), evs = byOpp.get(String(o.id)) || [];
    // Created in the period (from the deal itself: reliable whether or not history covers it).
    if(inRange(ms(o.created_at))){
      const created = evs.find(e => e.kind === "created");
      const p = STAGE_PROB[(created && created.to_stage) || o.stage] || 0, v = Number(o.value) || 0;
      for(const g of G){ g.created++; if(fromVisit(o)) g.from_visits++; g.added_value += v; g.added_weighted += v * p; }
    }
    // Where it stands now.
    if(o.status === "open" || (!o.status && OPEN_STAGES.includes(o.stage))){ for(const g of G){ g.open++; g.open_value += Number(o.value) || 0; g.open_weighted += (Number(o.value) || 0) * prob(o); } }
    // Moves and closes — recorded ones only (a baseline is a starting point, not a move).
    for(const e of evs){
      if(e.kind === "baseline" || !inRange(ms(e.changed_at))) continue;
      if(e.kind === "change" && e.from_stage !== e.to_stage){ const k = (e.from_stage || "?") + "→" + (e.to_stage || "?"); movement.set(k, (movement.get(k) || 0) + 1); }
      if(e.to_stage === "quoted" && e.from_stage !== "quoted") for(const g of G) g.entered_quoted++;
      if((e.to_status === "won" || e.to_status === "lost") && e.from_status !== e.to_status) for(const g of G){ g[e.to_status]++; g[e.to_status + "_value"] += Number(e.value) || 0; }
    }
    // Time in stage: stage segments whose entry was recorded and whose exit falls in the period.
    let cur = null;
    for(const e of evs){
      const t = ms(e.changed_at); if(t == null) continue;
      if(!cur){ cur = { stage: e.to_stage, start: t, known: e.kind !== "baseline" }; continue; }
      if(e.to_stage !== cur.stage){
        if(cur.known && OPEN_STAGES.includes(cur.stage) && inRange(t)) (segs[cur.stage] = segs[cur.stage] || []).push((t - cur.start) / DAY);
        cur = { stage: e.to_stage, start: t, known: true };
      }
    }
  }
  const out = g => Object.assign({}, g, { added_value: Math.round(g.added_value), added_weighted: Math.round(g.added_weighted), won_value: Math.round(g.won_value), lost_value: Math.round(g.lost_value),
    open_value: Math.round(g.open_value), open_weighted: Math.round(g.open_weighted), win_rate: (g.won + g.lost) ? Math.round(1000 * g.won / (g.won + g.lost)) / 10 : null });
  const sortG = m => [...m.values()].map(out).sort((a, b) => (b.open_weighted + b.won_value + b.added_value) - (a.open_weighted + a.won_value + a.added_value) || String(a.label).localeCompare(String(b.label)));

  // Possible order matches for deals created in the period.
  const orders = (d.orders || []).map(r => ({ dealer_id: String(r.dealer_id || ""), m: String(r.manufacturer || ""), t: ms(r.submitted_at), amount: Number(r.subtotal) || 0, source: "portal order" }));
  // A sales-report line: its order date when it has one, else its month — which must then be a LATER
  // month than the deal's (a same-month line can't be shown to come after the deal).
  const sales = (d.sales || []).map(r => ({ dealer_id: String(r.dealer_id || ""), m: String(r.manufacturer || ""), t: ms(r.order_date) != null ? ms(r.order_date) : ms(String(r.period || "").slice(0, 10) + "T00:00:00Z"), monthOnly: ms(r.order_date) == null, amount: Number(r.amount) || 0, source: "sales report" }));
  const considered = opps.filter(o => inRange(ms(o.created_at)) && o.dealer_id);
  const matches = [], unmatchedMfr = []; let noOrder = 0;
  for(const o of considered){
    const m = manufacturerOf(o, mfrs), c = ms(o.created_at);
    if(!m){ unmatchedMfr.push(o.id); continue; }
    const startMonth = Date.UTC(new Date(c).getUTCFullYear(), new Date(c).getUTCMonth() + 1, 1);
    const hits = orders.concat(sales).filter(x => x.dealer_id === String(o.dealer_id) && x.m === m && x.t != null
      && (x.monthOnly ? x.t >= startMonth : x.t > c) && x.t <= c + MATCH_DAYS * DAY).sort((a, b) => a.t - b.t);
    if(!hits.length){ noOrder++; continue; }
    matches.push({ opportunity_id: o.id, title: o.title || "", dealer_id: o.dealer_id, dealer: o.dealer_name || "", manufacturer: mName[m] || m,
      created_at: o.created_at, owner: repLabel(o), possible_orders: hits.length,
      first: { source: hits[0].source, date: new Date(hits[0].t).toISOString().slice(0, 10), amount: Math.round(hits[0].amount) } });
  }
  return {
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    history_since: baselines.length ? new Date(Math.min(...baselines)).toISOString() : (firstEvent.length ? new Date(Math.min(...firstEvent)).toISOString() : null),
    totals: out(total),
    movement: [...movement.entries()].map(([k, n]) => ({ from: k.split("→")[0], to: k.split("→")[1], count: n }))
      .sort((a, b) => STAGES.indexOf(a.from) - STAGES.indexOf(b.from) || STAGES.indexOf(a.to) - STAGES.indexOf(b.to)),
    time_in_stage: OPEN_STAGES.map(s => ({ stage: s, median_days: round1(median(segs[s] || [])), measured: (segs[s] || []).length })),
    by_rep: sortG(reps), by_manufacturer: sortG(makers),
    possible_matches: { window_days: MATCH_DAYS, considered: considered.length, matched: matches.length, no_order_found: noOrder,
      manufacturer_unknown: unmatchedMfr.length, list: matches.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 100) },
  };
}

module.exports = { compute, manufacturerOf, STAGES, STAGE_PROB, MATCH_DAYS };
