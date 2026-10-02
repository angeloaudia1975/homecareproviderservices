// HCPS — the ONE way to create tasks (Phase 1).
//
// Every writer used to build its own dealer_tasks row: who it is assigned to, its env, its priority
// spelling, which keys a bulk insert carries. This helper does it once, for visits, Log-a-touch and
// manual tasks alike, and adds the link back to where a task came from:
//
//   origin_type  'visit_report' (or another source later: 'call', 'appointment')
//   origin_id    that record's id
//   origin_key   which approved suggestion this task is (stable per suggestion)
//
// The database holds a unique index on (origin_type, origin_id, origin_key), and rows that carry an
// origin are inserted with "ignore duplicates" — so the same approval sent twice (a double tap, the
// offline outbox, a lost response retried) creates each task once. Rows without an origin are
// ordinary inserts, as before.
//
//   createTasks(list, ctx) -> { created:[rows], skipped:n }
//   ctx = { sbGet, sbSend, me, source?, reason?, env?, origin?:{type,id}, created_by? }

const UP = require("./_upsert.js");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = ["low", "normal", "high"];
const KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const clean = (v, n) => { const s = (v == null ? "" : String(v)).trim(); return s ? s.slice(0, n) : null; };
const low = v => String(v == null ? "" : v).trim().toLowerCase();
const OPTIONAL = ["origin_type", "origin_id", "origin_key", "ai_generated", "updated_at", "assigned_email"];

/* One task row. Every row built for one call has the SAME keys (PostgREST refuses a bulk insert whose
   rows differ — PGRST102), so optional values are present as null rather than left out. */
function taskRow(t, ctx){
  t = t || {}; ctx = ctx || {};
  const me = ctx.me || {};
  const assignedRep = clean(t.assigned_rep, 120);
  const myRep = String(me.rep_name || "").trim();
  // Assigned to the caller unless someone else is named. A task for someone else gets its email from
  // the database (hcps_staff_email_for, Phase 0I) — the name decides, never a guess here.
  const forMe = !assignedRep || low(assignedRep) === low(myRep);
  const now = new Date().toISOString();
  const row = {
    dealer_id: clean(t.dealer_id || ctx.dealer_id, 80),
    title: clean(t.title, 200),
    detail: clean(t.detail, 2000),
    due_date: ISO.test(String(t.due_date || "")) ? String(t.due_date) : null,
    priority: PRIORITIES.includes(low(t.priority)) ? low(t.priority) : "normal",
    source: clean(t.source || ctx.source, 40) || "manual",
    reason: clean(t.reason || ctx.reason, 80),
    assigned_rep: assignedRep || (myRep || null),
    assigned_email: forMe ? (low(clean(t.assigned_email, 200) || me.email) || null) : (low(t.assigned_email) || null),
    created_by: clean(ctx.created_by, 200) || me.name || me.email || null,
    status: "open",
    updated_at: now,
  };
  if(ctx.env !== undefined) row.env = ctx.env == null ? null : String(ctx.env);
  if(ctx.origin){
    const key = clean(t.origin_key || t.key, 80);
    row.origin_type = clean(ctx.origin.type, 40);
    row.origin_id = clean(ctx.origin.id, 80);
    row.origin_key = key && KEY_RE.test(key) ? key : null;
    row.ai_generated = !!t.ai_generated;
  }
  return row;
}

async function createTasks(list, ctx){
  const rows = (list || []).map(t => taskRow(t, ctx)).filter(r => r.dealer_id && r.title);
  if(!rows.length) return { created: [], skipped: 0 };
  const keyed = !!ctx.origin && rows.every(r => r.origin_type && r.origin_id && r.origin_key);
  if(keyed){
    try{
      const ins = await ctx.sbSend("POST", "dealer_tasks?on_conflict=origin_type,origin_id,origin_key", rows,
                                   { Prefer: "resolution=ignore-duplicates,return=representation" });
      const created = Array.isArray(ins) ? ins : [];
      return { created, skipped: rows.length - created.length };
    }catch(e){
      // No unique index yet (migration not run): check what exists, then insert only the rest.
      if(!/42P10|ON CONFLICT/i.test(String(e && e.message || e))) throw e;
      const have = await ctx.sbGet(`dealer_tasks?origin_type=eq.${encodeURIComponent(rows[0].origin_type)}&origin_id=eq.${encodeURIComponent(rows[0].origin_id)}&select=origin_key`).catch(() => []);
      const seen = new Set((have || []).map(x => String(x.origin_key)));
      const fresh = rows.filter(r => !seen.has(String(r.origin_key)));
      if(!fresh.length) return { created: [], skipped: rows.length };
      const ins = await ctx.sbSend("POST", "dealer_tasks", fresh, { Prefer: "return=representation" });
      const created = Array.isArray(ins) ? ins : [];
      return { created, skipped: rows.length - created.length };
    }
  }
  // Ordinary tasks. Works on a database without the Phase 0I / Phase 1 columns too.
  const ins = await UP.sendTolerant(ctx.sbSend, "POST", "dealer_tasks", rows, OPTIONAL, { Prefer: "return=representation" });
  return { created: Array.isArray(ins) ? ins : [], skipped: 0 };
}

module.exports = { createTasks, taskRow, PRIORITIES, KEY_RE };
