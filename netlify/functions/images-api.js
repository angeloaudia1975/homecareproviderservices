// HCPS admin — Image Manager backend. Service-role, server-side.
//   GET  ?manufacturer=            -> { manufacturers:[{slug,name,hasData}] }
//   GET  ?manufacturer=<slug>      -> { products:[{code,name,image}], overrides:{code:url} }
//   POST {action:"upload", manufacturer, code, filename, data(base64)} -> { url }
//   POST {action:"clear",  manufacturer, code}                          -> { ok }
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const BUCKET = "product-images";
const CORS = {"access-control-allow-origin":"*","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"content-type, authorization, x-analytics-token"};
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}
async function fetchJson(url){ const r=await fetch(url,{headers:{"cache-control":"no-cache"}}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
const EXT={"image/jpeg":"jpg","image/jpg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};

// Staff auth: email/password JWT resolved against staff_users; legacy passcode = president.
async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const sr=await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=*`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`}}); const s=sr.ok?await sr.json():[]; const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep"}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||"";
  if(need&&got===need) return {role:"president"};
  return null;
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const me = await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(me.role!=="president") return json(403,{error:"President only"});

    if(event.httpMethod==="GET"){
      const slug=(event.queryStringParameters||{}).manufacturer||"";
      if(!slug){
        const mfrs=await fetchJson(`${ORDERING_BASE}/data/manufacturers.json`).catch(()=>[]);
        return json(200,{manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name,hasData:!!m.hasData}))});
      }
      const [prods,overRows]=await Promise.all([
        fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),
        sb("GET",`product_images?manufacturer=eq.${encodeURIComponent(slug)}&select=code,url`).catch(()=>[]),
      ]);
      const overrides=Object.fromEntries((overRows||[]).map(o=>[o.code,o.url]));
      const products=(prods||[]).map(p=>({code:p.code,name:p.name,category:p.category||"",image:p.image||""}));
      return json(200,{products,overrides});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
      if(b.action==="upload"){
        if(!b.manufacturer||!b.code||!b.data) return json(400,{error:"manufacturer, code, data required"});
        const ct=(b.contentType||"image/jpeg").toLowerCase(); const ext=EXT[ct]||"jpg";
        const safe=String(b.code).replace(/[^A-Za-z0-9._-]/g,"_");
        const path=`${b.manufacturer}/${safe}.${ext}`;
        const bytes=Buffer.from(b.data,"base64");
        const up=await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,{method:"POST",
          headers:{...H(),"content-type":ct,"x-upsert":"true"},body:bytes});
        if(!up.ok) return json(500,{error:`storage ${up.status}: ${await up.text()}`});
        const url=`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}?v=${Date.now()}`;
        await sb("POST","product_images",{manufacturer:b.manufacturer,code:b.code,url,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true,url});
      }
      if(b.action==="clear"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`product_images?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
