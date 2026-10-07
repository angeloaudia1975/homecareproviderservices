// HCPS admin — Product Images backend (Phase 2.4: a view over ONE image authority).
//
// THE IMAGE AUTHORITY
//   A product that has an enrichment page: product_content.images_gallery (ordered, exactly
//   one entry primary:true) — product_content.image always equals that primary. A SKU that
//   genuinely needs its own photo (a colour, say) carries product_content.skus[i].image.
//   A SKU no page claims: the catalog layer — product_overrides.patch.image (catalog-file
//   products) or custom_products.image (added products).
//   product_images is LEGACY: it is no longer written, and migrate_legacy moves its rows
//   into the authority above (dry run first; collisions are reported, never auto-resolved).
//
//   GET  ?manufacturer=            -> { manufacturers:[{slug,name,hasData}] }
//   GET  ?manufacturer=<slug>      -> { products:[{code,name,category,page_key,page_skus,
//                                       image,source,sku_image,legacy}] }
//   POST {action:"upload", manufacturer, code, scope?, filename, contentType, data} -> { url, wrote }
//        scope: "product" (the page's primary photo) | "sku" (this SKU only). Required when
//        the SKU's page lists more than one SKU.
//   POST {action:"clear", manufacturer, code, scope?}                -> { ok, cleared }
//   POST {action:"migrate_legacy", manufacturer?, apply?, decisions?} -> plan / result
//        decisions: { "<code>": "keep_enrichment" | "primary" | "gallery" | "sku" }
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const BUCKET = "product-images";
const CORS = {"access-control-allow-origin":"*","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"content-type, authorization, x-analytics-token"};
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const enc=encodeURIComponent;

/* Strict: a failed read throws. Nothing here may read "could not read" as "nothing there". */
async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}
async function fetchJson(url){ const r=await fetch(url,{headers:{"cache-control":"no-cache"}}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
/* The deployed catalog file: 404 = this line has no file (an empty layer); anything else throws. */
async function catalogFile(mfr){
  const r=await fetch(`${ORDERING_BASE}/data/${enc(mfr)}.json`,{headers:{"cache-control":"no-cache"}});
  if(r.status===404) return [];
  if(!r.ok) throw new Error(`catalog file for ${mfr}: HTTP ${r.status}`);
  const j=await r.json(); if(!Array.isArray(j)) throw new Error(`catalog file for ${mfr} is not a list`); return j;
}
const EXT={"image/jpeg":"jpg","image/jpg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};
const LIVE=["published","active"];
const up=c=>String(c==null?"":c).trim().toUpperCase();
const str=v=>String(v==null?"":v).trim();

// Staff auth: email/password JWT resolved against staff_users; legacy passcode = president.
async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const sr=await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=*`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`}}); const s=sr.ok?await sr.json():[]; const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||"";
  if(need&&got===need) return {role:"president",email:"passcode"};
  return null;
}

/* ── PURE: the one image rule ──────────────────────────────────────────────────────────
   Which page owns a SKU — the same answer the storefront gives: the first LIVE page that
   lists it, else the first page of any status that lists it. */
function pageIndex(pages){
  const idx={};
  (pages||[]).forEach(p=>(Array.isArray(p.skus)?p.skus:[]).forEach(sx=>{
    const c=up(sx&&(sx.sku||sx.code)); if(!c) return;
    const cur=idx[c];
    if(!cur || (LIVE.includes(p.status)&&!LIVE.includes(cur.status))) idx[c]=p;
  }));
  return idx;
}
/* A gallery with exactly one primary, and the image that follows from it. Pure. A gallery with
   no primary takes the entry matching the page's image, else its first entry; extra primaries
   are demoted. Returns {gallery, image}. */
function normalizeGallery(gallery, image){
  const g=(Array.isArray(gallery)?gallery:[]).filter(x=>x&&str(x.url)).map(x=>Object.assign({},x));
  if(!g.length) return { gallery:[], image:str(image)||null };
  let i=g.findIndex(x=>x.primary===true);
  if(i<0){ i=g.findIndex(x=>str(x.url)===str(image)); if(i<0) i=0; }
  g.forEach((x,k)=>{ x.primary=(k===i); });
  return { gallery:g, image:g[i].url };
}
/* What a dealer sees for one SKU, and where it comes from. Pure, and the SAME precedence the
   storefront applies: SKU photo → page primary → catalog layer → static file. */
function resolveImage({code, page, override, custom, base}){
  const c=up(code);
  if(page){
    const sx=(page.skus||[]).find(s=>up(s&&(s.sku||s.code))===c);
    if(sx && str(sx.image)) return { url:str(sx.image), source:"sku" };
    const n=normalizeGallery(page.images_gallery, page.image);
    if(n.image) return { url:n.image, source:"page" };
  }
  if(override && str(override.image)) return { url:str(override.image), source:"catalog-override" };
  if(custom && str(custom.image)) return { url:str(custom.image), source:"catalog-added" };
  if(base && str(base.image)) return { url:str(base.image), source:"catalog-file" };
  return { url:"", source:"none" };
}
/* The migration plan for legacy product_images rows. Pure — decides, writes nothing. */
function planLegacy({legacy, pages, overrides, custom, base, decisions}){
  const idx=pageIndex(pages);
  const om={}; (overrides||[]).forEach(o=>{ om[up(o.code)]=o.patch||{}; });
  const cm={}; (custom||[]).forEach(r=>{ cm[up(r.code)]=r; });
  const bm={}; (base||[]).forEach(r=>{ bm[up(r.code)]=r; });
  const dec=decisions||{};
  return (legacy||[]).map(r=>{
    const k=up(r.code), url=str(r.url), page=idx[k]||null, pa=om[k]||{};
    const row={code:r.code, url, page_key:page?page.page_key:null};
    if(!page){
      const cur=str(pa.image)||(cm[k]?str(cm[k].image):"");
      if(cur && cur!==url) return Object.assign(row,{class:"shadowed", action:"none",
        why:"the catalog layer already supplies a different photo, which is what dealers see"});
      if(cur===url) return Object.assign(row,{class:"already_there", action:"none"});
      return Object.assign(row,{class:"catalog_fallback", action:cm[k]?"set_added_image":"set_override_image",
        why:"no enrichment page claims this SKU; the upload is what dealers see today"});
    }
    const n=normalizeGallery(page.images_gallery, page.image);
    const onPage=n.gallery.some(g=>str(g.url)===url) || str(page.image)===url
              || (page.skus||[]).some(s=>str(s&&s.image)===url);
    if(onPage) return Object.assign(row,{class:"already_there", action:"none"});
    if(!n.image) return Object.assign(row,{class:"page_has_no_image", action:"set_primary",
      why:"the page has no photo; this upload becomes its primary"});
    const d=dec[r.code]||dec[k];
    const allowed={keep_enrichment:"none", primary:"set_primary", gallery:"add_gallery", sku:"set_sku_image"};
    if(d && allowed[d]) return Object.assign(row,{class:"collision", decision:d, action:allowed[d], current:n.image,
      page_skus:(page.skus||[]).length});
    return Object.assign(row,{class:"collision", action:"needs_decision", current:n.image,
      page_skus:(page.skus||[]).length,
      why:"the page already has an approved primary photo; dealers see that one today"});
  });
}

/* ── Writers ─────────────────────────────────────────────────────────────────────────── */
async function logHistory(mfr, pageKey, actor, summary, before, after){
  try{ await sb("POST","product_content_history",[{manufacturer:mfr, page_key:pageKey, action:"image",
    actor:actor||"HCPS admin", summary, before:before?[before]:[], after:after?[after]:[], at:new Date().toISOString()}],
    {Prefer:"return=minimal"}); }catch(e){ /* history is best-effort, as in product-content.js */ }
}
async function getPage(mfr, pageKey){
  const rows=await sb("GET",`product_content?manufacturer=eq.${enc(mfr)}&page_key=eq.${enc(pageKey)}&select=*`);
  return (rows&&rows[0])||null;
}
async function patchPage(mfr, pageKey, patch){
  const rows=await sb("PATCH",`product_content?manufacturer=eq.${enc(mfr)}&page_key=eq.${enc(pageKey)}`,
    Object.assign({},patch,{updated_at:new Date().toISOString()}),{Prefer:"return=representation"});
  return (rows&&rows[0])||null;
}
async function writePagePrimary(mfr, page, url, actor){
  const before=await getPage(mfr, page.page_key);
  const g=(Array.isArray(before.images_gallery)?before.images_gallery:[]).filter(x=>x&&x.url!==url);
  /* The new photo goes first as primary; normalizeGallery keeps the first primary and demotes the rest. */
  const n=normalizeGallery([{url, primary:true, caption:"", source:"product-images"}].concat(g), url);
  const after=await patchPage(mfr, page.page_key, {images_gallery:n.gallery, image:n.image});
  await logHistory(mfr, page.page_key, actor, "Primary photo set from Product Images", before, after);
}
async function addGallery(mfr, page, url, actor){
  const before=await getPage(mfr, page.page_key);
  const g=(Array.isArray(before.images_gallery)?before.images_gallery:[]).map(x=>Object.assign({},x));
  if(!g.some(x=>x&&x.url===url)) g.push({url, primary:false, caption:"", source:"product-images"});
  const n=normalizeGallery(g, before.image);
  const after=await patchPage(mfr, page.page_key, {images_gallery:n.gallery, image:n.image});
  await logHistory(mfr, page.page_key, actor, "Photo added to the gallery from Product Images", before, after);
}
async function writeSkuImage(mfr, page, code, url, actor){
  const before=await getPage(mfr, page.page_key);
  let hit=false;
  const skus=(Array.isArray(before.skus)?before.skus:[]).map(s=>{
    if(up(s&&(s.sku||s.code))!==up(code)) return s; hit=true;
    const o=Object.assign({},s); if(url) o.image=url; else delete o.image; return o; });
  if(!hit) throw new Error(`SKU ${code} is not on ${page.page_key}`);
  const after=await patchPage(mfr, page.page_key, {skus});
  await logHistory(mfr, page.page_key, actor, url?`Photo for SKU ${code} set from Product Images`:`Photo for SKU ${code} removed`, before, after);
}
async function writeCatalogImage(mfr, code, url, isAdded){
  if(isAdded){
    await sb("PATCH",`custom_products?manufacturer=eq.${enc(mfr)}&code=eq.${enc(code)}`,{image:url||null,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
    return;
  }
  const ex=await sb("GET",`product_overrides?manufacturer=eq.${enc(mfr)}&code=eq.${enc(code)}&select=patch`);
  const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});
  if(url) patch.image=url; else delete patch.image;
  await sb("POST","product_overrides?on_conflict=manufacturer,code",{manufacturer:mfr,code,patch,updated_at:new Date().toISOString()},
    {Prefer:"resolution=merge-duplicates,return=minimal"});
}
async function lineData(mfr){
  const [base,custom,overrides,pages]=await Promise.all([
    catalogFile(mfr),
    sb("GET",`custom_products?manufacturer=eq.${enc(mfr)}&select=code,name,category,image,active`),
    sb("GET",`product_overrides?manufacturer=eq.${enc(mfr)}&select=code,patch`),
    sb("GET",`product_content?manufacturer=eq.${enc(mfr)}&select=page_key,name,status,image,images_gallery,skus&limit=5000`),
  ]);
  return {base:base||[], custom:custom||[], overrides:overrides||[], pages:pages||[]};
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const me = await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(me.role!=="president") return json(403,{error:"President only"});
    const actor=me.email||"president";

    if(event.httpMethod==="GET"){
      const slug=(event.queryStringParameters||{}).manufacturer||"";
      if(!slug){
        const mfrs=await fetchJson(`${ORDERING_BASE}/data/manufacturers.json`).catch(()=>[]);
        return json(200,{manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name,hasData:!!m.hasData}))});
      }
      let L, legacy;
      try{ L=await lineData(slug);
           legacy=await sb("GET",`product_images?manufacturer=eq.${enc(slug)}&select=code,url`); }
      catch(e){ return json(503,{error:"layer_unreadable", message:String((e&&e.message)||e).slice(0,300)}); }
      const idx=pageIndex(L.pages);
      const om={}; L.overrides.forEach(o=>{ om[up(o.code)]=o.patch||{}; });
      const cm={}; L.custom.forEach(r=>{ cm[up(r.code)]=r; });
      const lm={}; (legacy||[]).forEach(r=>{ lm[up(r.code)]=r.url; });
      const rows=L.base.map(p=>({code:String(p.code),name:p.name,category:p.category||"",base:p,added:false}));
      const have=new Set(rows.map(r=>up(r.code)));
      L.custom.forEach(c=>{ if(!have.has(up(c.code))) rows.push({code:String(c.code),name:c.name,category:c.category||"",custom:c,added:true}); });
      const products=rows.filter(r=>(om[up(r.code)]||{}).active!==false && !(r.custom&&r.custom.active===false)).map(r=>{
        const page=idx[up(r.code)]||null;
        const res=resolveImage({code:r.code, page, override:om[up(r.code)], custom:r.custom||cm[up(r.code)], base:r.base});
        const sx=page?(page.skus||[]).find(s=>up(s&&(s.sku||s.code))===up(r.code)):null;
        return { code:r.code, name:(sx&&sx.name)||r.name, category:r.category, added:r.added,
          page_key:page?page.page_key:null, page_name:page?page.name:null, page_skus:page?(page.skus||[]).length:0,
          image:res.url, source:res.source, sku_image:(sx&&str(sx.image))||null, legacy:lm[up(r.code)]||null };
      });
      return json(200,{products, legacy_rows:(legacy||[]).length});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
      const mfr=str(b.manufacturer), code=str(b.code);

      if(b.action==="upload"){
        if(!mfr||!code||!b.data) return json(400,{error:"manufacturer, code, data required"});
        let L; try{ L=await lineData(mfr); }catch(e){ return json(503,{error:"layer_unreadable", message:String((e&&e.message)||e).slice(0,300)}); }
        const page=pageIndex(L.pages)[up(code)]||null;
        let scope=b.scope||(page && (page.skus||[]).length===1 ? "product" : null);
        if(page && !scope) return json(409,{error:"scope_required", page_key:page.page_key, page_name:page.name, page_skus:(page.skus||[]).length,
          message:`${code} is one of ${(page.skus||[]).length} SKUs on "${page.name||page.page_key}". Use this photo for the whole product, or for this SKU only?`});
        const ct=(b.contentType||"image/jpeg").toLowerCase(); const ext=EXT[ct]||"jpg";
        const safe=code.replace(/[^A-Za-z0-9._-]/g,"_");
        const path=`${mfr}/${safe}-${Date.now()}.${ext}`;
        const stored=await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,{method:"POST",
          headers:{...H(),"content-type":ct,"x-upsert":"true"},body:Buffer.from(b.data,"base64")});
        if(!stored.ok) return json(500,{error:`storage ${stored.status}: ${await stored.text()}`});
        const url=`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
        let wrote;
        if(page && scope==="sku"){ await writeSkuImage(mfr, page, code, url, actor); wrote="sku"; }
        else if(page){ await writePagePrimary(mfr, page, url, actor); wrote="page_primary"; }
        else { const added=L.custom.some(c=>up(c.code)===up(code)) && !L.base.some(p=>up(p.code)===up(code));
               await writeCatalogImage(mfr, code, url, added); wrote=added?"added_product":"catalog_override"; }
        return json(200,{ok:true,url,wrote,page_key:page?page.page_key:null});
      }

      if(b.action==="clear"){
        if(!mfr||!code) return json(400,{error:"manufacturer, code required"});
        let L; try{ L=await lineData(mfr); }catch(e){ return json(503,{error:"layer_unreadable", message:String((e&&e.message)||e).slice(0,300)}); }
        const page=pageIndex(L.pages)[up(code)]||null;
        if(page){
          const sx=(page.skus||[]).find(s=>up(s&&(s.sku||s.code))===up(code));
          if(sx && str(sx.image)){ await writeSkuImage(mfr, page, code, null, actor); return json(200,{ok:true,cleared:"sku"}); }
          return json(409,{error:"page_photo", page_key:page.page_key, message:
            `${code}'s photo is the product's own photo on "${page.name||page.page_key}". Remove or reorder product photos in Product Content Enrichment, where the gallery is managed.`});
        }
        const added=L.custom.some(c=>up(c.code)===up(code)) && !L.base.some(p=>up(p.code)===up(code));
        await writeCatalogImage(mfr, code, null, added);
        return json(200,{ok:true,cleared:added?"added_product":"catalog_override"});
      }

      if(b.action==="migrate_legacy"){
        const slugs=mfr?[mfr]:[...new Set(((await sb("GET","product_images?select=manufacturer&limit=10000"))||[]).map(r=>r.manufacturer))];
        const report=[];
        for(const s of slugs){
          let L, legacy;
          try{ L=await lineData(s); legacy=await sb("GET",`product_images?manufacturer=eq.${enc(s)}&select=code,url`); }
          catch(e){ return json(503,{error:"layer_unreadable", manufacturer:s, message:String((e&&e.message)||e).slice(0,300)}); }
          const plan=planLegacy({legacy, pages:L.pages, overrides:L.overrides, custom:L.custom, base:L.base, decisions:b.decisions});
          const done=[];
          if(b.apply===true){
            const idx=pageIndex(L.pages);
            for(const p of plan){
              if(p.action==="none"||p.action==="needs_decision") continue;
              try{
                const page=p.page_key?idx[up(p.code)]:null;
                if(p.action==="set_override_image") await writeCatalogImage(s,p.code,p.url,false);
                else if(p.action==="set_added_image") await writeCatalogImage(s,p.code,p.url,true);
                else if(p.action==="set_primary") await writePagePrimary(s,page,p.url,actor);
                else if(p.action==="add_gallery") await addGallery(s,page,p.url,actor);
                else if(p.action==="set_sku_image") await writeSkuImage(s,page,p.code,p.url,actor);
                done.push({code:p.code, action:p.action, ok:true});
              }catch(e){ done.push({code:p.code, action:p.action, ok:false, error:String((e&&e.message)||e).slice(0,200)}); }
            }
          }
          const by={}; plan.forEach(p=>{ by[p.class]=(by[p.class]||0)+1; });
          report.push({manufacturer:s, rows:plan.length, by_class:by, plan, applied:b.apply===true?done:null});
        }
        return json(200,{ok:true, dry_run:b.apply!==true, report,
          note:"Legacy product_images rows are not deleted; the table is kept read-only for one release."});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
exports._pure = { pageIndex, normalizeGallery, resolveImage, planLegacy };
