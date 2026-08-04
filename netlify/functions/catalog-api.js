// HCPS admin — Catalog backend: manufacturer logos, custom products, and product
// "More Information" links. Service-role, server-side. All stored as Supabase overrides
// so the portal picks them up with NO site redeploy.
//   GET                                  -> { manufacturers:[{slug,name,hasData,logo_url}] }
//   GET ?manufacturer=<slug>             -> { products:[{code,name,...,image}], custom:[...], links:{code:{label,url}} }
//   POST {action:"save_logo", slug, url}        -> { ok }
//   POST {action:"clear_logo", slug}            -> { ok }
//   POST {action:"upload", slot, filename, contentType, data(base64)} -> { url }   (image or PDF)
//   POST {action:"save_product", manufacturer, product:{code,name,category,base_price,msrp,image,description,active}} -> { ok }
//   POST {action:"delete_product", manufacturer, code}   -> { ok }
//   POST {action:"save_link", manufacturer, code, label, url}  -> { ok }
//   POST {action:"clear_link", manufacturer, code}            -> { ok }
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const BUCKET = "product-images";   // reuse existing public bucket
const CORS = {"access-control-allow-origin":"*","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"content-type, x-analytics-token"};
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const EXT={"image/jpeg":"jpg","image/jpg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","application/pdf":"pdf"};

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}
async function fetchJson(url){ const r=await fetch(url,{headers:{"cache-control":"no-cache"}}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
const num=v=>{ if(v===""||v==null) return null; const n=Number(v); return isFinite(n)?n:null; };
// normalize a quantity-break tier list to [{min_qty:int>=1, price:number}], sorted ascending
const cleanTiers=t=>{ if(!Array.isArray(t)) return null;
  const out=t.map(r=>({min_qty:Math.max(1,parseInt(r.min_qty??r.minQty??1,10)||1),price:num(r.price)}))
    .filter(r=>r.price!=null).sort((a,b)=>a.min_qty-b.min_qty);
  return out.length?out:null; };

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    const need=process.env.ANALYTICS_TOKEN;
    if(need){const got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||""; if(got!==need) return json(401,{error:"unauthorized"});}
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});

    if(event.httpMethod==="GET"){
      const slug=(event.queryStringParameters||{}).manufacturer||"";
      if(!slug){
        const [mfrs,meta]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/manufacturers.json`).catch(()=>[]),
          sb("GET","manufacturer_meta?select=slug,logo_url,active").catch(()=>[]),
        ]);
        const lm=Object.fromEntries((meta||[]).map(o=>[o.slug,o.logo_url]));
        const am=Object.fromEntries((meta||[]).map(o=>[o.slug,o.active]));
        return json(200,{manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name,hasData:!!m.hasData,logo_url:lm[m.slug]||"",active:am[m.slug]!==false}))});
      }
      const [prods,custom,links]=await Promise.all([
        fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),
        sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,name,category,base_price,msrp,image,description,active,tiers,price_note`).catch(()=>[]),
        sb("GET",`product_links?manufacturer=eq.${encodeURIComponent(slug)}&select=code,label,url`).catch(()=>[]),
      ]);
      const [overRows,featRows]=await Promise.all([
        sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(slug)}&select=code,patch`).catch(()=>[]),
        sb("GET",`featured_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,active`).catch(()=>[]),
      ]);
      const linkMap=Object.fromEntries((links||[]).map(l=>[l.code,{label:l.label||"More Information",url:l.url}]));
      const overrides=Object.fromEntries((overRows||[]).map(o=>[o.code,o.patch||{}]));
      const featured=(featRows||[]).filter(f=>f.active!==false).map(f=>f.code);
      // full catalog fields so the editor can show + edit everything (incl. tiers)
      const products=(prods||[]).map(p=>({code:p.code,name:p.name,category:p.category||"",image:p.image||"",
        base_price:p.base_price,msrp:p.msrp,description:p.description||"",tiers:p.tiers||null,price_note:p.price_note||"",group:p.group||""}));
      return json(200,{products,custom:custom||[],links:linkMap,overrides,featured});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

      if(b.action==="upload"){
        if(!b.data) return json(400,{error:"data required"});
        const ct=(b.contentType||"image/jpeg").toLowerCase(); const ext=EXT[ct]||"bin";
        const slot=String(b.slot||"file").replace(/[^A-Za-z0-9._-]/g,"_");
        const path=`catalog/${slot}-${Date.now()}.${ext}`;
        const bytes=Buffer.from(b.data,"base64");
        const up=await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,{method:"POST",
          headers:{...H(),"content-type":ct,"x-upsert":"true"},body:bytes});
        if(!up.ok) return json(500,{error:`storage ${up.status}: ${await up.text()}`});
        return json(200,{ok:true,url:`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`});
      }

      if(b.action==="save_logo"){
        if(!b.slug) return json(400,{error:"slug required"});
        await sb("POST","manufacturer_meta?on_conflict=slug",{slug:b.slug,logo_url:b.url||null,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="clear_logo"){
        if(!b.slug) return json(400,{error:"slug required"});
        await sb("POST","manufacturer_meta?on_conflict=slug",{slug:b.slug,logo_url:null,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      // Turn a whole manufacturer on/off on the ordering platform (no redeploy). Removed
      // manufacturers disappear from the tabs, the dealer-home cards, and the line count.
      if(b.action==="set_active"){
        if(!b.slug) return json(400,{error:"slug required"});
        await sb("POST","manufacturer_meta?on_conflict=slug",{slug:b.slug,active:b.active!==false,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }

      if(b.action==="save_product"){
        const p=b.product||{}; const mfr=b.manufacturer||p.manufacturer;
        if(!mfr||!p.code||!String(p.name||"").trim()) return json(400,{error:"manufacturer, code and name are required"});
        await sb("POST","custom_products?on_conflict=manufacturer,code",{
          manufacturer:mfr, code:String(p.code).trim(), name:String(p.name).trim(),
          category:p.category||null, base_price:num(p.base_price), msrp:num(p.msrp),
          image:p.image||null, description:p.description||null,
          tiers:cleanTiers(p.tiers), price_note:p.price_note||null,
          active:p.active===false?false:true, updated_at:new Date().toISOString()
        },{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }

      // Edit a STANDARD catalog product without a redeploy: store only the changed fields as
      // an override the portal merges over the deployed catalog JSON.
      if(b.action==="save_override"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        const p=b.patch||{}; const patch={};
        if(p.name!=null) patch.name=String(p.name);
        if(p.category!=null) patch.category=String(p.category);
        if(p.description!=null) patch.description=String(p.description);
        if(p.price_note!=null) patch.price_note=String(p.price_note);
        if("base_price" in p) patch.base_price=num(p.base_price);
        if("msrp" in p) patch.msrp=num(p.msrp);
        if("tiers" in p) patch.tiers=cleanTiers(p.tiers);
        if("active" in p) patch.active=(p.active!==false);
        if("image" in p && p.image) patch.image=String(p.image);
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:b.manufacturer,code:String(b.code).trim(),patch,updated_at:new Date().toISOString()},
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="clear_override"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`product_overrides?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }

      // Feature / unfeature a product straight from the Catalog editor (writes the same
      // featured_products table the Featured page uses).
      if(b.action==="set_featured"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        let rank=0; try{ const ex=await sb("GET",`featured_products?select=rank&order=rank.desc&limit=1`); rank=(ex&&ex[0]&&(+ex[0].rank+1))||0; }catch(e){}
        await sb("POST","featured_products",{manufacturer:b.manufacturer,code:String(b.code),name:b.name||null,rank,active:true,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="unset_featured"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`featured_products?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="delete_product"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`custom_products?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }

      if(b.action==="save_link"){
        if(!b.manufacturer||!b.code||!String(b.url||"").trim()) return json(400,{error:"manufacturer, code and url are required"});
        await sb("POST","product_links?on_conflict=manufacturer,code",{
          manufacturer:b.manufacturer, code:String(b.code).trim(),
          label:String(b.label||"More Information").trim()||"More Information", url:String(b.url).trim(),
          updated_at:new Date().toISOString()
        },{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="clear_link"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`product_links?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }

      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
