// HCPS admin — Portal Home content backend (hero banner + promo tiles). Service-role.
//   GET                                             -> { home:{hero,tiles} }
//   POST {action:"save", home:{hero,tiles}}         -> { ok }
//   POST {action:"upload", slot, filename, contentType, data(base64)} -> { url }
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
// Portal reads portal_content?key=eq.home directly via the anon key (public-read RLS).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = "product-images";   // reuse the existing public bucket, under a portal-home/ prefix
const CORS = {"access-control-allow-origin":"*","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"content-type, x-analytics-token"};
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const EXT={"image/jpeg":"jpg","image/jpg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    const need=process.env.ANALYTICS_TOKEN;
    if(need){const got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||""; if(got!==need) return json(401,{error:"unauthorized"});}
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});

    if(event.httpMethod==="GET"){
      const rows=await sb("GET","portal_content?key=eq.home&select=value").catch(()=>[]);
      const home=(rows&&rows[0]&&rows[0].value)||{hero:{},tiles:[]};
      return json(200,{home});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

      if(b.action==="upload"){
        if(!b.data) return json(400,{error:"data required"});
        const ct=(b.contentType||"image/jpeg").toLowerCase(); const ext=EXT[ct]||"jpg";
        const slot=String(b.slot||"img").replace(/[^A-Za-z0-9._-]/g,"_");
        const path=`portal-home/${slot}-${Date.now()}.${ext}`;
        const bytes=Buffer.from(b.data,"base64");
        const up=await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,{method:"POST",
          headers:{...H(),"content-type":ct,"x-upsert":"true"},body:bytes});
        if(!up.ok) return json(500,{error:`storage ${up.status}: ${await up.text()}`});
        const url=`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
        return json(200,{ok:true,url});
      }

      if(b.action==="save"){
        const home=b.home&&typeof b.home==="object"?b.home:{};
        if(!home.hero||typeof home.hero!=="object") home.hero={};
        if(!Array.isArray(home.tiles)) home.tiles=[];
        home.tiles=home.tiles.slice(0,12);   // sane cap
        await sb("POST","portal_content?on_conflict=key",
          {key:"home",value:home,updated_at:new Date().toISOString()},
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }

      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
