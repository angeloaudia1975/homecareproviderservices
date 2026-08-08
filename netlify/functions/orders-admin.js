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
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||500):null; };
const num=v=>{ const n=Number(v); return Number.isFinite(n)?n:0; };
const STATUSES=["submitted","confirmed","shipped","completed","cancelled"];

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
      const [orders,dealers,dir,mfrs]=await Promise.all([
        sbGet("orders?select=id,dealer_id,hcps_account,manufacturer,status,po_number,notes,admin_notes,tracking_number,subtotal,submitted_at,updated_at,ship_name,ship_address,ship_city,ship_state,ship_zip,contact_name,contact_email,contact_phone,order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=500").catch(()=>[]),
        sbGet("dealers?select=id,business_name").catch(()=>[]),
        sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
      ]);
      const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
      const repByName={}; for(const x of dir) repByName[x.dealer_name]=x.rep_name||"";
      const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
      let list=(orders||[]).map(o=>{
        const dealer=nameById[o.dealer_id]||o.ship_name||"(unknown)";
        return {
          id:o.id, dealer_id:o.dealer_id, dealer, rep:repByName[dealer]||"",
          manufacturer:mfrName[o.manufacturer]||o.manufacturer||"—",
          status:o.status||"submitted", po:o.po_number||"", notes:o.notes||"", admin_notes:o.admin_notes||"",
          tracking:o.tracking_number||"", subtotal:num(o.subtotal), submitted_at:o.submitted_at, updated_at:o.updated_at,
          ship:[o.ship_address,o.ship_city,[o.ship_state,o.ship_zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
          contact:{name:o.contact_name||"",email:o.contact_email||"",phone:o.contact_phone||""},
          items:(o.order_items||[]).map(i=>({code:i.code,name:i.name,qty:i.qty,unit:num(i.unit_price),line:num(i.line_total)})),
          item_count:(o.order_items||[]).reduce((n,i)=>n+num(i.qty),0),
        };
      });
      // reps see only their book
      if(!manage && me.rep_name){ const rn=me.rep_name.toLowerCase(); list=list.filter(o=>String(o.rep||"").toLowerCase()===rn); }
      const stats={}; for(const s of STATUSES) stats[s]=0; for(const o of list) stats[o.status]=(stats[o.status]||0)+1;
      return json(200,{ok:true,orders:list,stats,role:me.role,manage});
    }

    if(b.action==="set_status"){
      if(!manage) return json(403,{error:"Not permitted"});
      const status=STATUSES.includes(b.status)?b.status:null;
      if(!b.id||!status) return json(400,{error:"id + valid status required"});
      const patch={status,updated_at:new Date().toISOString()};
      if("tracking_number" in b) patch.tracking_number=clean(b.tracking_number,120);
      if("admin_notes" in b) patch.admin_notes=clean(b.admin_notes,1000);
      await sbSend("PATCH",`orders?id=eq.${encodeURIComponent(b.id)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true,status});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};
