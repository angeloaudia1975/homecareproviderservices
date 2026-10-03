// HCPS rep/role data scoping — the single source of truth for "which dealers may this staff
// member see". Keeps the Sales Rep Portal's access rules consistent across every endpoint.
//
//   president / admin / owner -> ALL dealers, ALL commissions, full team reporting (management)
//   relations  -> ALL dealers, NO management powers (policy approved 2026-10-02, Phase 0K).
//                 HAS: Dealer 360 for every dealer (notes, contacts, tasks, timeline, dealer email),
//                 routes they own, visit actions, opportunities/pipeline, company-wide dealer
//                 analytics, Command Center 360, Dealer Manager (non-structural), marketing tools
//                 (Audiences, Campaign Studio, CardChamp).
//                 DOES NOT HAVE: user management, View-as, Go Live / platform mode, app settings,
//                 secrets or integration credentials, engine configuration, sales or commission
//                 import, team performance or anyone else's pay — OWN performance and commission only.
//   rep        -> ONLY the dealers they own, and only their OWN commissions
//
// Two tiers: seesAllDealers (operational reach = management + relations) is separate from isAdmin
// / seesAllCommissions (team performance + pay = management only). Keep them distinct.
//
// WHO OWNS A DEALER (Phase 0D). One answer, in this order:
//   1. dealers.rep_email — the authoritative owner, the same email the rep signs in with.
//   2. dealers.rep_name  — only when rep_email is empty (names that match no staff user, e.g. House).
//   3. dealer_directory  — the legacy name-keyed list, only when the dealer row names nobody.
// A dealer family stays together (an owned HQ's branches, the HQ of an owned branch), except that a
// branch or HQ explicitly owned by someone else keeps its own owner. Every endpoint asks here —
// ownerIndex() for "who owns this dealer", dealerScope() for "which dealers may this user work" —
// and every owner change goes through setDealerOwner(). Pass the calling function's own sbGet/sbSend.

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

const low=s=>String(s==null?"":s).trim().toLowerCase();

// Read every row, 1000 at a time. The Data API returns at most 1000 rows per request no matter
// what limit is asked for, so a single read silently stops at 1000. `path` must not carry its own
// order/limit/offset.
async function getAll(sbGet, path, orderCol){
  const PAGE=1000, sep=path.includes("?")?"&":"?"; let out=[];
  for(let off=0; off<500000; off+=PAGE){
    const rows=await sbGet(`${path}${sep}order=${orderCol||"id"}&limit=${PAGE}&offset=${off}`);
    if(!Array.isArray(rows)) break; out=out.concat(rows); if(rows.length<PAGE) break;
  }
  return out;
}

// Dealer rows with their owner columns, tolerating a database that predates rep_email / rep_name.
async function loadDealers(sbGet){
  for(const cols of ["id,business_name,parent_id,rep_name,rep_email","id,business_name,parent_id,rep_name","id,business_name,parent_id"]){
    try{ return await getAll(sbGet, `dealers?select=${cols}`, "id"); }catch(e){}
  }
  return [];
}

/* Who owns each dealer. Returns
     byId     Map(dealer id -> { id, name, parent_id, email, rep, source, explicit })
                email    the owner's sign-in email ("" if none). Stored rep_email, else the email of
                         the staff member whose rep name matches.
                rep      the owner's display name ("" if none) — the staff member's rep name for a
                         stored email, else dealers.rep_name, else the directory's name.
                source   "email" | "name" | "directory" | ""
                explicit true when the dealer row itself names an owner (email or name)
     repByName {business or sales name -> rep}: the directory for names that match no dealer (raw
               sales customer names), overridden by every dealer's real owner. A drop-in for the
               old `repByName` maps built from dealer_directory.
     repOf(id), emailOf(id), staff */
async function ownerIndex(sbGet){
  const [dealers, dir, staff]=await Promise.all([
    loadDealers(sbGet),
    getAll(sbGet, "dealer_directory?select=dealer_name,rep_name", "dealer_name").catch(()=>[]),
    sbGet("staff_users?select=email,name,rep_name,active").catch(()=>[]),
  ]);
  const repByEmail={}, emailByRep={};
  for(const s of (staff||[])){ const e=low(s.email); if(!e) continue; const rn=String(s.rep_name||s.name||"").trim();
    repByEmail[e]=rn; const k=low(s.rep_name); if(k) emailByRep[k]=(k in emailByRep && emailByRep[k]!==e)?"":e; }   // ambiguous name -> no email
  const dirExact={}, dirNorm={};
  for(const x of (dir||[])){ const r=String(x.rep_name||"").trim(); if(!r||!x.dealer_name) continue;
    dirExact[x.dealer_name]=r; const k=dnorm(x.dealer_name); (dirNorm[k]=dirNorm[k]||new Set()).add(r); }
  const byId=new Map();
  for(const d of (dealers||[])){
    const storedEmail=low(d.rep_email), storedRep=String(d.rep_name||"").trim();
    let email="", rep="", source="";
    if(storedEmail){ email=storedEmail; rep=repByEmail[storedEmail]||storedRep; source="email"; }
    else if(storedRep){ rep=storedRep; email=emailByRep[low(storedRep)]||""; source="name"; }
    else {
      const ex=dirExact[d.business_name]; const ns=dirNorm[dnorm(d.business_name)];
      const r=ex || (ns && ns.size===1 ? [...ns][0] : "");
      if(r){ rep=r; email=emailByRep[low(r)]||""; source="directory"; }
    }
    byId.set(String(d.id), { id:d.id, name:d.business_name||"", parent_id:d.parent_id||null, email, rep, source,
      explicit:!!(storedEmail||storedRep), storedEmail, storedRep, dirReps:dirNorm[dnorm(d.business_name)]||null });
  }
  const repByName=Object.assign({}, dirExact);
  for(const o of byId.values()){ if(!o.name) continue; if(o.rep) repByName[o.name]=o.rep; else delete repByName[o.name]; }
  return { byId, repByName, staff:staff||[], dealers:dealers||[],
    repOf:id=>((byId.get(String(id))||{}).rep||""), emailOf:id=>((byId.get(String(id))||{}).email||"") };
}

// Does this dealer belong directly (not through its family) to this staff member?
function ownsDirectly(o, myEmail, myRep){
  if(!o) return false;
  if(o.storedEmail) return !!myEmail && o.storedEmail===myEmail;            // the authoritative owner
  if(o.storedRep)   return !!myRep && low(o.storedRep)===myRep;              // a name with no email yet
  // Legacy directory: any directory row for this dealer's name naming the rep (old rule).
  return !!myRep && !!o.dirReps && [...o.dirReps].some(r=>low(r)===myRep);
}

// Resolve the caller's dealer scope. Returns { isAll, ids:Set<id>|null, repName }.
// isAll === true  -> no filtering (president / relations).
// isAll === false -> `ids` is the exact set of dealer_ids the rep may see (may be empty).
async function dealerScope(me, sbGet, idx){
  const repName=String((me&&me.rep_name)||"").trim();
  if(seesAllDealers(me)) return { isAll:true, ids:null, repName };
  const ids=new Set();
  const myEmail=low(me&&me.email), myRep=low(repName);
  if(!myEmail && !myRep) return { isAll:false, ids, repName };
  try{
    const index=idx||await ownerIndex(sbGet);
    for(const o of index.byId.values()) if(ownsDirectly(o, myEmail, myRep)) ids.add(String(o.id));
    // Keep a dealer family together — but never pull in a member explicitly owned by someone else
    // (branches are assigned independently, so an explicit assignment always wins).
    const mineOrOpen=o=>!o.explicit || ownsDirectly(o, myEmail, myRep);
    for(const o of index.byId.values()) if(o.parent_id && ids.has(String(o.parent_id)) && mineOrOpen(o)) ids.add(String(o.id));
    for(const o of index.byId.values()) if(o.parent_id && ids.has(String(o.id))){ const p=index.byId.get(String(o.parent_id)); if(p && mineOrOpen(p)) ids.add(String(p.id)); }
  }catch(e){}
  return { isAll:false, ids, repName };
}

/* The ONE way to change who owns dealers. Writes dealers.rep_email + dealers.rep_name and the legacy
   dealer_directory together, so no reader can disagree, then hands the dealers' open work to the new
   owner: open tasks and open opportunities that were the previous owner's (or nobody's) move with
   the dealer. Work assigned to a third person stays with them. Clearing the owner moves nothing.
     deps = { sbGet, sbSend }  (the calling function's own helpers; sbSend(method, path, body, headers))
   Returns { ok, updated, rep, email, moved:{ tasks, opportunities } }. */
async function setDealerOwner(dealerIds, repName, deps){
  const { sbGet, sbSend }=deps;
  const ids=[...new Set((dealerIds||[]).map(x=>String(x==null?"":x).trim()).filter(Boolean))];
  const rep=String(repName==null?"":repName).trim()||null;
  const idx=await ownerIndex(sbGet);
  let email=null;
  if(rep){ const matches=(idx.staff||[]).filter(s=>s.email && low(s.rep_name)===low(rep)); if(matches.length===1) email=low(matches[0].email); }
  const before=ids.map(id=>idx.byId.get(id)).filter(Boolean);
  const enc=a=>a.map(encodeURIComponent).join(",");
  for(let i=0;i<ids.length;i+=100){
    const chunk=enc(ids.slice(i,i+100));
    try{ await sbSend("PATCH",`dealers?id=in.(${chunk})`,{rep_name:rep,rep_email:email},{Prefer:"return=minimal"}); }
    catch(e){ if(!/PGRST204|rep_email/.test(String(e&&e.message||e))) throw e;           // column not added yet
      await sbSend("PATCH",`dealers?id=in.(${chunk})`,{rep_name:rep},{Prefer:"return=minimal"}); }
  }
  const now=new Date().toISOString();
  const dirRows=before.filter(o=>o.name).map(o=>({dealer_name:o.name,rep_name:rep,updated_at:now}));
  if(dirRows.length) await sbSend("POST","dealer_directory",dirRows,{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
  const moved={tasks:0,opportunities:0};
  if(rep){
    const byPrev=new Map();   // previous owner's name -> dealer ids
    for(const o of before){ const p=o.rep||""; if(low(p)===low(rep)) continue; if(!byPrev.has(p)) byPrev.set(p,[]); byPrev.get(p).push(String(o.id)); }
    const move=async(table, col, chunk, prev, body)=>{
      const who=prev?`${col}=eq.${encodeURIComponent(prev)}`:`${col}=is.null`;
      const r=await sbSend("PATCH",`${table}?dealer_id=in.(${chunk})&status=eq.open&${who}&select=id`,body,{Prefer:"return=representation"}).catch(()=>null);
      return Array.isArray(r)?r.length:0;
    };
    for(const [prev, dids] of byPrev){
      for(let i=0;i<dids.length;i+=100){
        const chunk=enc(dids.slice(i,i+100));
        for(const p of (prev?[prev,""]:[""])){            // the previous owner's, and nobody's
          moved.tasks+=await move("dealer_tasks","assigned_rep",chunk,p,{assigned_rep:rep});
          moved.opportunities+=await move("opportunities","owner_rep",chunk,p,{owner_rep:rep});
        }
      }
    }
  }
  return { ok:true, updated:ids.length, rep, email, moved };
}

// Find a dealer by its name (exact first, then the shared normalisation when exactly one matches).
async function dealerIdByName(name, sbGet, idx){
  const nm=String(name||"").trim(); if(!nm) return null;
  const index=idx||await ownerIndex(sbGet);
  let exact=null; const norm=[]; const k=dnorm(nm);
  for(const o of index.byId.values()){ if(o.name===nm){ exact=String(o.id); break; } if(dnorm(o.name)===k) norm.push(String(o.id)); }
  return exact || (norm.length===1 ? norm[0] : null);
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
  catch(e){
    // opts.optional: owner columns a database may not have yet (e.g. dealer_tasks.assigned_email
    // before supabase/phase0_task_owner_email.sql) — ask again without them.
    const opt=new Set(opts.optional||[]); const base=cols.filter(c=>!opt.has(c));
    if(base.length===cols.length) return {ok:false,status:500,error:"lookup failed"};
    try{ rows=await sbGet(`${table}?id=eq.${encodeURIComponent(rid)}&select=${base.join(",")}&limit=1`); }
    catch(e2){ return {ok:false,status:500,error:"lookup failed"}; }
  }
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

/* MY SALES WORKSPACE (President dual role). A management user who also carries a dealer book can
   switch his working sales views to that book: the page sends the header `x-hcps-workspace: mine`
   and the read endpoints then answer exactly as they would for a sales rep with his email.
   - Honored for management roles only; anyone else sending the header gets their normal answer.
   - It only NARROWS what a list shows. Authorization never reads it: every write and record check
     still uses the caller's real role, so President permissions are unchanged in the workspace.
   - The book is the same resolver a rep gets (dealers.rep_email first, then rep_name, then the
     legacy directory, families kept together) — no second ownership model. */
function workspaceMine(event, me){
  const h=(event&&event.headers)||{};
  const v=h["x-hcps-workspace"]!=null ? h["x-hcps-workspace"] : h["X-HCPS-Workspace"];
  return low(v)==="mine" && isAdmin(me);
}
// The caller's own dealer book, resolved as if they were a rep (used only inside the workspace).
async function ownBook(me, sbGet, idx){ return dealerScope(Object.assign({}, me, {role:"rep"}), sbGet, idx); }

module.exports = { dnorm, roleOf, isAdmin, seesAllDealers, seesAllCommissions, dealerScope,
                   dealersOutsideScope, canAccessDealer, authorizeRecord,
                   getAll, ownerIndex, setDealerOwner, dealerIdByName, workspaceMine, ownBook };
