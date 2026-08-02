// HCPS admin — Featured Products backend. Service-role, server-side.
//   GET  (no param)              -> { featured:[{manufacturer,code,name,note,rank,active}], manufacturers:[{slug,name,hasData}] }
//   GET  ?manufacturer=<slug>    -> { products:[{code,name,image,category}], featured:{code:{note,rank,active}} }
//   POST {action:"set",   manufacturer, code, name, note, rank, active} -> { ok }
//   POST {action:"unset", manufacturer, code}                           -> { ok }
//   POST {action:"reorder", items:[{manufacturer,code,rank}]}           -> { ok }
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const CORS = {"access-control-allow-origin":"*","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"content-type, x-analytics-token"};
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}
async function fetchJson(url){ const r=await fetch(url,{headers:{"cache-control":"no-cache"}}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    const need=process.env.ANALYTICS_TOKEN;
    if(need){const got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||""; if(got!==need) return json(401,{error:"unauthorized"});}
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});

    if(event.httpMethod==="GET"){
      const slug=(event.queryStringParameters||{}).manufacturer||"";
      if(!slug){
        const [feat,mfrs]=await Promise.all([
          sb("GET","featured_products?select=manufacturer,code,name,note,rank,active&order=rank.asc").catch(()=>[]),
          fetchJson(`${ORDERING_BASE}/data/manufacturers.json`).catch(()=>[]),
        ]);
        return json(200,{featured:feat||[],manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name,hasData:!!m.hasData}))});
      }
      const [prods,featRows,custom,overRows,imgRows]=await Promise.all([
        fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),
        sb("GET",`featured_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,note,rank,active`).catch(()=>[]),
        sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,name,category,image,active`).catch(()=>[]),
        sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(slug)}&select=code,patch`).catch(()=>[]),
        sb("GET",`product_images?manufacturer=eq.${encodeURIComponent(slug)}&select=code,url`).catch(()=>[]),
      ]);
      const featured=Object.fromEntries((featRows||[]).map(f=>[f.code,{note:f.note,rank:f.rank,active:f.active}]));
      const over=Object.fromEntries((overRows||[]).map(o=>[o.code,o.patch||{}]));
      const imgs=Object.fromEntries((imgRows||[]).map(i=>[i.code,i.url]));
      // catalog products with any admin edits/hides applied, then admin-added (custom) products
      let products=(prods||[]).map(p=>{const o=over[p.code]||{};
        return {code:p.code,name:o.name||p.name,category:o.category||p.category||"",image:o.image||imgs[p.code]||p.image||"",hidden:o.active===false};})
        .filter(p=>!p.hidden);
      const have=new Set(products.map(p=>p.code));
      (custom||[]).forEach(c=>{ if(c.active===false||have.has(c.code)) return;
        products.push({code:c.code,name:c.name,category:c.category||"",image:c.image||imgs[c.code]||"",added:true}); });
      return json(200,{products,featured});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
      if(b.action==="set"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        const row={manufacturer:b.manufacturer,code:String(b.code),name:b.name||null,note:b.note||null,
          rank:Number.isFinite(+b.rank)?+b.rank:0,active:b.active!==false,updated_at:new Date().toISOString()};
        await sb("POST","featured_products",row,{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="unset"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`featured_products?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="reorder"){
        const items=Array.isArray(b.items)?b.items:[];
        for(const it of items){
          if(!it.manufacturer||!it.code) continue;
          await sb("PATCH",`featured_products?manufacturer=eq.${encodeURIComponent(it.manufacturer)}&code=eq.${encodeURIComponent(it.code)}`,
            {rank:+it.rank||0,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
        }
        return json(200,{ok:true});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
