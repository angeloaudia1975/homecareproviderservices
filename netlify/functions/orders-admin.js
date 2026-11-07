// HCPS admin — Order Review & Fulfillment. Staff-authenticated (service-role for DB).
// Lists dealer orders across the ordering portal and advances their status. No npm deps.
//
//   POST {action:"list", status?}                          -> { orders:[...], stats:{} }
//   POST {action:"set_status", id, status, tracking_number?, admin_notes?}  -> { ok }
//   President & Customer Relations manage; reps see their own book (read-only).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const SC = require("./_scope.js");
const AN = require("./_account_notice.js");
const AS = require("./_account_setup.js");
const PRICING = require("./_pricing.js");
const ORDERING_BASE = (process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app").replace(/\/+$/, "");
/* AN.readRows takes (method, path) like orders-api's sb(); this file reads with sbGet(path). */
const sbGet2=(m,path)=>sbGet(path);
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||500):null; };
const num=v=>{ const n=Number(v); return Number.isFinite(n)?n:0; };
/* Order statuses (owner, 2026-10-27): HCPS receives every dealer order and places it with the manufacturer itself.
   submitted = received by HCPS · placed = HCPS placed it with the manufacturer · confirmed = the manufacturer
   confirmed it (its confirmation # and the actual freight are recorded then) · shipped · completed · cancelled. */
/* pending_account_setup (owner 2026-11-06): recorded, held until HCPS has the dealer's manufacturer account; RELEASED to
   "submitted" only by the release action below (identifier on file + prices re-checked), or cancelled. */
const STATUSES=["pending_account_setup","submitted","placed","confirmed","shipped","completed","cancelled"];
const NEXT={pending_account_setup:["cancelled"],submitted:["placed","cancelled"],placed:["confirmed","cancelled"],confirmed:["shipped","cancelled"],shipped:["completed"],completed:[],cancelled:[]};
const r2=n=>Math.round(Number(n)*100)/100;

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin"};
  return null;
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    const manage = me.role==="president" || me.role==="relations";
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    // orders table present?
    try{ await sbGet("orders?select=id&limit=1"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"No orders table yet — it's created the first time a dealer submits an order on the portal."}); }

    if(b.action==="list"){
      /* Strict (C3-06): an unreadable order list is an error on screen, never "no orders". */
      let orders,dealers,OI,mfrs;
      try{
        [orders,dealers,OI,mfrs]=await Promise.all([
          sbGet("orders?select=id,dealer_id,hcps_account,manufacturer,status,po_number,notes,admin_notes,tracking_number,subtotal,freight_fee,estimated_total,submitted_at,updated_at,ship_name,ship_address,ship_city,ship_state,ship_zip,contact_name,contact_email,contact_phone,order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=500"),
          sbGet("dealers?select=id,business_name"),
          SC.ownerIndex(sbGet).catch(()=>null),           // who owns each dealer (Phase 0D) — display only
          sbGet("manufacturers?select=slug,name"),
        ]);
      }catch(e){ console.error("order list read failed",e&&e.message); return json(503,{ok:false,error:"orders_unavailable",message:"The orders could not be loaded right now — nothing is missing; please reload."}); }
      /* New manufacturer account notice (C3-06): worked out from the dealer's account numbers NOW, so it clears by itself
         once HCPS records the account. A failed read marks the notice "verify", never hides it. */
      let acctRows=null;
      const noticeDealers=(orders||[]).filter(o=>o.status!=="cancelled" && AN.noticeFor(o.manufacturer)).map(o=>o.dealer_id);
      if(noticeDealers.length){ try{ acctRows=await AN.readRows(sbGet2,noticeDealers); }catch(e){ acctRows=null; } }
      const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
      const repByName=(OI&&OI.repByName)||{};
      const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
      let list=(orders||[]).map(o=>{
        const dealer=nameById[o.dealer_id]||o.ship_name||"(unknown)";
        return {
          id:o.id, dealer_id:o.dealer_id, dealer, rep:(OI&&o.dealer_id&&OI.repOf(o.dealer_id))||repByName[dealer]||"",
          manufacturer:mfrName[o.manufacturer]||o.manufacturer||"—",
          status:o.status||"submitted", po:o.po_number||"", notes:o.notes||"", admin_notes:o.admin_notes||"",
          tracking:o.tracking_number||"", subtotal:num(o.subtotal), freight_fee:o.freight_fee==null?null:num(o.freight_fee), estimated_total:o.estimated_total==null?null:num(o.estimated_total), submitted_at:o.submitted_at, updated_at:o.updated_at,
          ship:[o.ship_address,o.ship_city,[o.ship_state,o.ship_zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
          contact:{name:o.contact_name||"",email:o.contact_email||"",phone:o.contact_phone||""},
          items:(o.order_items||[]).map(i=>({code:i.code,name:i.name,qty:i.qty,unit:num(i.unit_price),line:num(i.line_total)})),
          item_count:(o.order_items||[]).reduce((n,i)=>n+num(i.qty),0),
          account_notice:(()=>{ if(o.status===AS.STATUS) return AS.LABEL+" — record the dealer's "+(mfrName[o.manufacturer]||"manufacturer")+" account in Dealer 360, then release this order";
            if(o.status==="cancelled"||!AN.noticeFor(o.manufacturer)) return "";
            if(!acctRows) return AN.noticeFor(o.manufacturer,mfrName[o.manufacturer])+" (account status could not be checked — verify)";
            return AN.missingAccounts(acctRows,o.dealer_id,[o.manufacturer]).length?AN.noticeFor(o.manufacturer,mfrName[o.manufacturer]):""; })(),
        };
      });
      // reps see only their book
      // A rep sees only his book — and a rep with no book name sees nothing (a blank name used
      // to skip this filter and show every dealer's orders).
      if(!manage){ const sc=await SC.dealerScope(me, sbGet, OI||undefined); list=list.filter(o=>!!(o.dealer_id && sc.ids && sc.ids.has(String(o.dealer_id)))); }
      const stats={}; for(const s of STATUSES) stats[s]=0; for(const o of list) stats[o.status]=(stats[o.status]||0)+1;
      return json(200,{ok:true,orders:list,stats,role:me.role,manage});
    }

    if(b.action==="set_status"){
      if(!manage) return json(403,{error:"Not permitted"});
      const status=STATUSES.includes(b.status)?b.status:null;
      if(!b.id||!status) return json(400,{error:"id + valid status required"});
      const cur=(await sbGet(`orders?id=eq.${encodeURIComponent(b.id)}&select=id,status,subtotal,freight_fee,estimated_total,admin_notes`))[0];
      if(!cur) return json(404,{error:"order not found"});
      const from=cur.status||"submitted";
      if(!(NEXT[from]||[]).includes(status)) return json(409,{error:"not_allowed",message:`An order that is "${from}" cannot move to "${status}".`});
      const patch={status,updated_at:new Date().toISOString()};
      if("tracking_number" in b) patch.tracking_number=clean(b.tracking_number,120);
      const notes=[];
      if(status==="confirmed"){
        /* The manufacturer's confirmation: its number and the ACTUAL freight it states, recorded once with the
           order's final total. Freight is a non-negative amount in dollars and cents; nothing is guessed. */
        const conf=clean(b.mfr_confirmation,120);
        const fr=b.actual_freight===""||b.actual_freight==null?null:Number(b.actual_freight);
        if(fr!=null && !(Number.isFinite(fr) && fr>=0 && Math.abs(fr*100-Math.round(fr*100))<1e-6)) return json(400,{error:"actual_freight must be an amount of 0 or more"});
        if(fr!=null){ patch.freight_fee=r2(fr); patch.estimated_total=r2(num(cur.subtotal)+fr); }
        notes.push(`Manufacturer confirmation${conf?" #"+conf:""}${fr!=null?" · actual freight $"+r2(fr).toFixed(2)+" · final total $"+r2(num(cur.subtotal)+fr).toFixed(2):""} — recorded by ${me.email||me.name} ${new Date().toISOString().slice(0,16).replace("T"," ")} UTC`);
      }
      if(status==="placed") notes.push(`Placed with the manufacturer by ${me.email||me.name} ${new Date().toISOString().slice(0,16).replace("T"," ")} UTC`);
      const extra=clean(b.admin_notes,1000); if(extra) notes.push(extra);
      if(notes.length) patch.admin_notes=String([cur.admin_notes||"",...notes].filter(Boolean).join("\n")).slice(-4000);
      /* The status moves only from the one we read: a second click (or another person) cannot record it twice. */
      const upd=await sbSend("PATCH",`orders?id=eq.${encodeURIComponent(b.id)}&status=eq.${encodeURIComponent(from)}`,patch,{Prefer:"return=representation"});
      if(!upd||!upd.length) return json(409,{error:"changed",message:"This order was updated by someone else — reload."});
      return json(200,{ok:true,status,freight_fee:upd[0].freight_fee,estimated_total:upd[0].estimated_total,admin_notes:upd[0].admin_notes});
    }

    /* RELEASE A HELD ORDER (owner 2026-11-06): the same order the dealer submitted moves on once HCPS has the dealer's
       manufacturer account on file — nothing is re-entered. Its prices AND freight are re-checked with the server's pricing as
       it is now. Rules (review of #108):
       · a line that can't be re-priced from its code alone (sold in two families, or offering an upgrade — order_items keep
         neither) keeps its recorded checkout price; releasing it needs kept_prices_checked + a note;
       · any change (a price or the freight) needs the dealer's confirmation of EXACTLY the new figures shown: the request
         sends them back (confirmed: {lines:[{id,unit}], freight}) and anything that moved again is refused;
       · writes: first a status-guarded note on the held order (proves it is still held and records every change), then the
         line prices, then the status-guarded release — a failure part-way leaves the order HELD with the note, and a retry
         finishes it. Nothing is sent to the manufacturer here — the order becomes "submitted" and HCPS places it as usual. */
    if(b.action==="release_account_hold"){
      if(!manage) return json(403,{error:"Not permitted"});
      if(!b.id) return json(400,{error:"id required"});
      const cur=(await sbGet(`orders?id=eq.${encodeURIComponent(b.id)}&select=id,dealer_id,manufacturer,status,subtotal,freight_fee,estimated_total,admin_notes`))[0];
      if(!cur) return json(404,{error:"order not found"});
      if(cur.status!==AS.STATUS) return json(409,{error:"not_held",message:"This order is not waiting for manufacturer account setup."});
      const its=await sbGet(`order_items?order_id=eq.${encodeURIComponent(b.id)}&select=id,code,name,qty,unit_price,line_total&order=id.asc`);
      if(!Array.isArray(its)||!its.length) return json(409,{error:"no_items",message:"This order has no line items on record — check it before releasing."});
      let missing; try{ missing=await AS.missingIdentifiers((m,pth)=>sbGet(pth),cur.dealer_id,[cur.manufacturer]); }
      catch(e){ return json(503,{error:"account_unreadable",message:"The dealer's manufacturer accounts could not be read — nothing was changed."}); }
      if(missing.length) return json(409,{error:"account_not_set_up",message:"No manufacturer account is on file for this dealer yet — record it in Dealer 360 first."});
      const items=its.map(i=>({code:i.code,qty:i.qty,unit:num(i.unit_price)}));
      let priced;
      try{ const F=PRICING.remoteFiles(ORDERING_BASE);
        priced=await PRICING.priceOrders({orders:[{manufacturer_slug:cur.manufacturer,items}],dealerId:cur.dealer_id,sb:(m,pth)=>sbGet(pth),catalogFile:F.catalogFile,contentFile:F.contentFile,manufacturersFile:F.manufacturersFile}); }
      catch(e){ console.error("release pricing failed",e&&e.message); return json(503,{error:"pricing_unavailable",message:"Prices could not be checked right now — nothing was changed."}); }
      const po=(priced.orders||[])[0]||{items:[]};
      const lines=its.map((i,k)=>{ const n=(po.items||[])[k]||{}; const old=num(i.unit_price);
        /* a configured line that is now discontinued or breaks an order rule is unavailable, never kept */
        if(n.configurable && !(n.available===false && (n.rule||n.discontinued))) return {id:i.id,code:i.code,name:i.name,qty:i.qty,old_unit:old,new_unit:old,kept:true};
        return {id:i.id,code:i.code,name:i.name,qty:i.qty,old_unit:old,new_unit:n.available===false?null:(n.unit==null?null:num(n.unit))}; });
      const unavailable=lines.filter(l=>l.new_unit==null);
      if(unavailable.length) return json(409,{error:"items_unavailable",message:"Some items can no longer be priced as ordered — contact the dealer before releasing.",lines});
      const kept=lines.filter(l=>l.kept);
      const note=clean(b.note,500);
      if(kept.length && !(b.kept_prices_checked===true && note)) return json(409,{error:"manual_price_check",message:"Some lines were ordered with a configuration (price family or upgrade) the order record does not keep, so their price can't be re-checked automatically. Check those prices by hand, then release with a note.",lines});
      const changed=lines.filter(l=>!l.kept && Math.abs(l.new_unit-l.old_unit)>=0.005);
      const sub=r2(lines.reduce((t,l)=>t+l.new_unit*num(l.qty),0));
      /* Freight by the shop's rule from the re-priced lines — unless a kept line is on the order (its configuration is unknown here):
         then the recorded freight stands. */
      const oldFr=cur.freight_fee==null?null:num(cur.freight_fee);
      const newFr=(kept.length||po.freight_fee==null)?oldFr:r2(num(po.freight_fee));
      const frChanged=newFr!=null&&(oldFr==null?newFr>0:Math.abs(newFr-oldFr)>=0.005);
      const proposal={lines:changed.map(l=>({id:l.id,unit:l.new_unit})),freight:frChanged?newFr:null};
      if(changed.length||frChanged){
        const c=b.confirmed&&typeof b.confirmed==="object"?b.confirmed:null;
        const same=c&&b.dealer_confirmed===true&&note
          &&Array.isArray(c.lines)&&c.lines.length===proposal.lines.length
          &&proposal.lines.every(x=>c.lines.some(y=>String(y&&y.id)===String(x.id)&&Math.abs(num(y.unit)-x.unit)<0.005))
          &&((proposal.freight==null&&(c.freight==null))||(proposal.freight!=null&&c.freight!=null&&Math.abs(num(c.freight)-proposal.freight)<0.005));
        if(!same) return json(409,{error:"prices_changed",message:"Prices or freight changed since the dealer ordered. Confirm exactly these figures with the dealer, then release with their confirmation noted.",lines,freight:{old:oldFr,new:newFr},proposal});
      }
      const at=new Date().toISOString(), stamp=at.slice(0,16).replace("T"," ");
      const who=me.email||me.name;
      const detail=[...changed.map(l=>`${l.code} $${l.old_unit.toFixed(2)} → $${l.new_unit.toFixed(2)}`),...(frChanged?[`freight $${num(oldFr).toFixed(2)} → $${newFr.toFixed(2)}`]:[]),...kept.map(l=>`${l.code} kept at $${l.old_unit.toFixed(2)} (checked by hand)`)];
      const startNote=`Release from ${AS.LABEL} started by ${who} ${stamp} UTC`+(detail.length?` — ${detail.join("; ")}`+(note?` — dealer confirmation / check: ${note}`:""):"");
      const notes1=String([cur.admin_notes||"",startNote].filter(Boolean).join("\n")).slice(-4000);
      /* 1 — still held? record what is about to change (status-guarded; a cancelled or released order is left alone) */
      const g=await sbSend("PATCH",`orders?id=eq.${encodeURIComponent(b.id)}&status=eq.${encodeURIComponent(AS.STATUS)}`,{admin_notes:notes1,updated_at:at},{Prefer:"return=representation"});
      if(!g||!g.length) return json(409,{error:"changed",message:"This order was updated by someone else — reload."});
      /* 2 — line prices */
      for(const l of changed){
        try{ await sbSend("PATCH",`order_items?id=eq.${encodeURIComponent(l.id)}&order_id=eq.${encodeURIComponent(b.id)}`,{unit_price:l.new_unit,line_total:r2(l.new_unit*num(l.qty))},{Prefer:"return=minimal"}); }
        catch(e){ console.error("release line update failed",l.id,e&&e.message);
          return json(502,{error:"release_incomplete",message:"Some line prices could not be saved. The order is still held and the change is noted on it — release it again to finish."}); }
      }
      /* 3 — release (status-guarded) */
      const patch={status:"submitted",updated_at:at,subtotal:sub,admin_notes:String([notes1,`Released by ${who} ${stamp} UTC`].join("\n")).slice(-4000)};
      if(newFr!=null) patch.freight_fee=newFr;
      if(cur.estimated_total!=null||newFr!=null) patch.estimated_total=r2(sub+num(newFr));
      const upd=await sbSend("PATCH",`orders?id=eq.${encodeURIComponent(b.id)}&status=eq.${encodeURIComponent(AS.STATUS)}`,patch,{Prefer:"return=representation"});
      if(!upd||!upd.length) return json(409,{error:"changed",message:"This order was updated by someone else — reload."});
      return json(200,{ok:true,status:"submitted",subtotal:sub,freight_fee:newFr,changed:changed.length,kept:kept.length});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};
