// HCPS ordering portal — order persistence + history (service-role, server-side).
// Dealers reach ONLY their own orders, gated by their Supabase Auth JWT.
//   POST {action:"create", orders:[...], dealer:{...}}  + Bearer <jwt>  -> saves orders+items
//   POST {action:"list"}                                 + Bearer <jwt>  -> {orders:[{...,items:[]}]}
// The email to HCPS is still sent by submit-order.js; this only records the order so the
// dealer's dashboard can show history and reorder.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,
    headers:{...H(),"content-type":"application/json",...(extra||{})},
    body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); const j=t?JSON.parse(t):null;
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return j;
}
const num = (v)=>{ const n=Number(v); return Number.isFinite(n)?n:0; };

// Resolve the caller's JWT to an APPROVED dealer_id (or null).
async function dealerFromToken(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,""); if(!tok) return null;
  const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
  if(!ur.ok) return null;
  const u=await ur.json();
  const rows=await sb("GET",`dealer_users?uid=eq.${u.id}&select=status,dealer_id,email`);
  const du=rows&&rows[0];
  if(!du||du.status!=="approved"||!du.dealer_id) return null;
  return {dealer_id:du.dealer_id,email:du.email};
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    const who=await dealerFromToken(event);
    if(!who) return json(200,{ok:false,status:"unauthorized"});   // not signed in / not approved

    if(b.action==="create"){
      const orders=Array.isArray(b.orders)?b.orders:[];
      if(!orders.length) return json(400,{error:"no orders"});
      const d=b.dealer||{};
      // validate manufacturer slugs against the real table so the FK-free text stays clean
      let known=new Set();
      try{ known=new Set((await sb("GET","manufacturers?select=slug")).map(m=>m.slug)); }catch(e){}
      let saved=0;
      for(const o of orders){
        const slug=o.manufacturer_slug||o.manufacturer||null;
        const row={
          dealer_id:who.dealer_id,
          hcps_account:d.account||null,
          manufacturer:(slug&&known.has(slug))?slug:null,
          status:"submitted",
          po_number:o.po||null,
          notes:o.notes||null,
          ship_name:d.business||null, ship_address:d.address||null, ship_city:d.city||null,
          ship_state:d.state||null, ship_zip:d.zip||null,
          contact_name:d.contact||null, contact_email:d.email||null, contact_phone:d.phone||null,
          subtotal:num(o.items_subtotal!=null?o.items_subtotal:o.estimated_total),
        };
        let ins;
        try{ ins=await sb("POST","orders",row,{Prefer:"return=representation"}); }
        catch(e){ continue; }  // best-effort: skip a bad order, keep going
        const oid=ins&&ins[0]&&ins[0].id; if(!oid) continue;
        const items=(o.items||[]).map(it=>({
          order_id:oid, code:it.code||null, name:it.name||null,
          qty:Math.max(1,Math.round(num(it.qty))||1),
          unit_price:num(it.unit), line_total:Math.round(num(it.unit)*num(it.qty)*100)/100,
        }));
        if(items.length){ try{ await sb("POST","order_items",items,{Prefer:"return=minimal"}); }catch(e){} }
        saved++;
      }
      return json(200,{ok:true,saved});
    }

    if(b.action==="list"){
      const rows=await sb("GET",
        `orders?dealer_id=eq.${who.dealer_id}&select=id,manufacturer,status,po_number,notes,subtotal,submitted_at,order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=25`);
      const orders=(rows||[]).map(o=>({
        id:o.id, manufacturer:o.manufacturer||"", status:o.status||"submitted",
        po:o.po_number||"", notes:o.notes||"", subtotal:num(o.subtotal),
        submitted_at:o.submitted_at,
        items:(o.order_items||[]).map(i=>({code:i.code,name:i.name,qty:i.qty,unit:num(i.unit_price),line:num(i.line_total)})),
        items_count:(o.order_items||[]).reduce((n,i)=>n+num(i.qty),0),
      }));
      return json(200,{ok:true,orders});
    }

    return json(400,{error:"unknown action"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
