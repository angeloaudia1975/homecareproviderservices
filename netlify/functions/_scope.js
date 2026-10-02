// HCPS rep/role data scoping — the single source of truth for "which dealers may this staff
// member see". Keeps the Sales Rep Portal's access rules consistent across every endpoint.
//
//   president / admin / owner -> ALL dealers, ALL commissions, full team reporting (management)
//   relations  -> ALL dealers (a Relations Manager works the whole territory operationally —
//                 accounts, notes, tasks, health, map), BUT only their OWN commissions, and NO
//                 team-performance leaderboard. Ranking + pay stay private; management-only.
//   rep        -> ONLY their assigned dealers (dealer_directory.rep_name === their rep_name),
//                 and only their OWN commissions
//
// Two tiers: seesAllDealers (operational reach = management + relations) is separate from isAdmin
// / seesAllCommissions (team performance + pay = management only). Keep them distinct.
//
// Dealer assignment is read from dealer_directory (dealer_name -> rep_name), matched to dealers by
// the same dnorm() the rest of the app uses, and extended across a dealer family (an owned HQ's
// branches, and the HQ of an owned branch). Pass the calling function's own `sbGet`.

const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
function dnorm(n){ return String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim(); }

function roleOf(me){ return String((me&&me.role)||"").toLowerCase(); }
// Management roles: full team performance, all commissions, admin queues. ONE definition.
const ADMIN_ROLES = new Set(["president","admin","owner"]);
function isAdmin(me){ return ADMIN_ROLES.has(roleOf(me)); }
// Operational dealer reach: management PLUS a Relations Manager (works the whole territory).
function seesAllDealers(me){ return isAdmin(me) || roleOf(me)==="relations"; }
// Commissions/pay stay management-only — a Relations Manager sees only their own.
function seesAllCommissions(me){ return isAdmin(me); }

// Resolve the caller's dealer scope. Returns { isAll, ids:Set<id>|null, repName }.
// isAll === true  -> no filtering (president / relations).
// isAll === false -> `ids` is the exact set of dealer_ids the rep may see (may be empty).
async function dealerScope(me, sbGet){
  const repName=String((me&&me.rep_name)||"").trim();
  if(seesAllDealers(me)) return { isAll:true, ids:null, repName };
  const ids=new Set();
  if(repName){
    try{
      // rep_name is now stored directly on the dealer (the durable source of truth). Load it tolerantly:
      // if the column isn't present yet, fall back to matching the legacy name-keyed directory.
      let dealers;
      try{ dealers=await sbGet("dealers?select=id,business_name,parent_id,rep_name&limit=100000"); }
      catch(e){ dealers=await sbGet("dealers?select=id,business_name,parent_id&limit=100000"); }
      const rn=repName.toLowerCase();
      // Primary: the explicit assignment stored on the dealer.
      const explicit=new Map(); // id -> lowercased assigned rep (blank if none)
      for(const d of (dealers||[])){
        const er=String(d.rep_name||"").trim().toLowerCase();
        explicit.set(d.id, er);
        if(er===rn) ids.add(d.id);
      }
      // Back-compat: honor the legacy directory for any dealer that has no stored rep yet.
      try{
        const dir=await sbGet("dealer_directory?select=dealer_name,rep_name&limit=100000");
        const mine=new Set();
        for(const x of (dir||[])){ if(String(x.rep_name||"").trim().toLowerCase()===rn) mine.add(dnorm(x.dealer_name)); }
        for(const d of (dealers||[])){ if(!explicit.get(d.id) && mine.has(dnorm(d.business_name))) ids.add(d.id); }
      }catch(e){}
      // Keep a dealer family together — but never pull in a member explicitly assigned to a DIFFERENT rep
      // (branches are assigned independently, so an explicit assignment always wins).
      for(const d of (dealers||[])){ const er=explicit.get(d.id)||""; if(d.parent_id && ids.has(d.parent_id) && (er===""||er===rn)) ids.add(d.id); }
      for(const d of (dealers||[])){ if(d.parent_id && ids.has(d.id)){ const per=explicit.get(d.parent_id)||""; if(per===""||per===rn) ids.add(d.parent_id); } }
    }catch(e){}
  }
  return { isAll:false, ids, repName };
}

/* ── Record-level authorization (Phase 0) ─────────────────────────────────────────────
   Every endpoint that reads or changes something belonging to a dealer asks ONE question,
   through these helpers, instead of each file inventing its own rule. Knowing a record's id
   is never enough: the record is looked up first, then its dealer (or its direct owner) is
   checked against the caller. Browser-side hiding is not authorization. */

// Which of these dealer ids is the caller NOT allowed to work? [] means all are allowed.
async function dealersOutsideScope(me, dealerIds, sbGet){
  const ids=[...new Set((dealerIds||[]).map(x=>String(x==null?"":x).trim()).filter(Boolean))];
  if(!ids.length || seesAllDealers(me)) return [];
  const sc=await dealerScope(me, sbGet);
  return ids.filter(id=>!(sc.ids && sc.ids.has(id)));
}
async function canAccessDealer(me, dealerId, sbGet){
  if(!dealerId) return false;
  return (await dealersOutsideScope(me, [dealerId], sbGet)).length===0;
}
/* Look a record up by id and decide whether the caller may act on it.
     opts.dealerId    — the dealer the request claims the record belongs to; must match
     opts.ownerFields — columns naming a person (email or rep name) who owns the record directly,
                        e.g. a task's assigned_rep; that person may act on it even off their book
     opts.select      — extra columns the caller wants back
   Returns {ok:true,row} or {ok:false,status,error}. */
async function authorizeRecord(me, table, id, sbGet, opts){
  opts=opts||{};
  const rid=String(id==null?"":id).trim(); if(!rid) return {ok:false,status:400,error:"id required"};
  const cols=[...new Set(["id","dealer_id"].concat(opts.ownerFields||[], opts.select||[]))];
  let rows; try{ rows=await sbGet(`${table}?id=eq.${encodeURIComponent(rid)}&select=${cols.join(",")}&limit=1`); }
  catch(e){ return {ok:false,status:500,error:"lookup failed"}; }
  const row=rows&&rows[0]; if(!row) return {ok:false,status:404,error:"not found"};
  if(opts.dealerId!=null && String(row.dealer_id==null?"":row.dealer_id)!==String(opts.dealerId))
    return {ok:false,status:403,error:"That record doesn't belong to this dealer."};
  if(seesAllDealers(me)) return {ok:true,row};
  const myEmail=String((me&&me.email)||"").trim().toLowerCase(), myRep=String((me&&me.rep_name)||"").trim().toLowerCase();
  for(const f of (opts.ownerFields||[])){
    const v=String(row[f]==null?"":row[f]).trim().toLowerCase(); if(!v) continue;
    if((myEmail && v===myEmail) || (myRep && v===myRep)) return {ok:true,row};
  }
  if(row.dealer_id && await canAccessDealer(me, row.dealer_id, sbGet)) return {ok:true,row};
  return {ok:false,status:403,error:"Not your record"};
}

module.exports = { dnorm, roleOf, isAdmin, seesAllDealers, seesAllCommissions, dealerScope,
                   dealersOutsideScope, canAccessDealer, authorizeRecord };
