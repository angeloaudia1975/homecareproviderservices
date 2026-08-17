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
      const dealers=await sbGet("dealers?select=id,business_name,parent_id&limit=100000");
      const dir=await sbGet("dealer_directory?select=dealer_name,rep_name&limit=100000");
      const rn=repName.toLowerCase();
      const mine=new Set();
      for(const x of (dir||[])){ if(String(x.rep_name||"").trim().toLowerCase()===rn) mine.add(dnorm(x.dealer_name)); }
      for(const d of (dealers||[])){ if(mine.has(dnorm(d.business_name))) ids.add(d.id); }
      // keep a dealer family together: branches of an owned HQ, and the HQ of an owned branch
      for(const d of (dealers||[])){ if(d.parent_id && ids.has(d.parent_id)) ids.add(d.id); }
      for(const d of (dealers||[])){ if(d.parent_id && ids.has(d.id)) ids.add(d.parent_id); }
    }catch(e){}
  }
  return { isAll:false, ids, repName };
}

module.exports = { dnorm, roleOf, isAdmin, seesAllDealers, seesAllCommissions, dealerScope };
