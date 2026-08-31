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
const CORS = {"access-control-allow-origin":"*","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"content-type, authorization, x-analytics-token"};
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
        const [mfrs,logos]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/manufacturers.json`).catch(()=>[]),
          sb("GET","manufacturer_meta?select=slug,logo_url").catch(()=>[]),
        ]);
        const lm=Object.fromEntries((logos||[]).map(o=>[o.slug,o.logo_url]));
        return json(200,{manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name,hasData:!!m.hasData,logo_url:lm[m.slug]||""}))});
      }
      const [prods,custom,links]=await Promise.all([
        fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),
        sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,name,category,base_price,msrp,map,msrp_auto,image,description,active,tiers,price_note,updated_at`).catch(()=>[]),
        sb("GET",`product_links?manufacturer=eq.${encodeURIComponent(slug)}&select=code,label,url`).catch(()=>[]),
      ]);
      const [overRows,featRows,mediaRows]=await Promise.all([
        sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(slug)}&select=code,patch,updated_at`).catch(()=>[]),
        sb("GET",`featured_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,active`).catch(()=>[]),
        sb("GET",`product_media?manufacturer=eq.${encodeURIComponent(slug)}&select=id,code,kind,url,title,sort&order=sort`).catch(()=>[]),
      ]);
      const linkMap=Object.fromEntries((links||[]).map(l=>[l.code,{label:l.label||"More Information",url:l.url}]));
      const overrides=Object.fromEntries((overRows||[]).map(o=>[o.code,Object.assign({},o.patch||{},{_updated_at:o.updated_at||null})]));
      const featured=(featRows||[]).filter(f=>f.active!==false).map(f=>f.code);
      // media gallery keyed by product code (additional images, videos, brochures, links)
      const media={}; for(const r of (mediaRows||[])){ (media[r.code]=media[r.code]||[]).push({id:r.id,kind:r.kind,url:r.url,title:r.title||"",sort:r.sort||0}); }
      // full catalog fields so the editor can show + edit everything (incl. tiers)
      const products=(prods||[]).map(p=>({code:p.code,name:p.name,category:p.category||"",image:p.image||"",
        base_price:p.base_price,msrp:p.msrp,description:p.description||"",tiers:p.tiers||null,price_note:p.price_note||"",group:p.group||""}));
      return json(200,{products,custom:custom||[],links:linkMap,overrides,featured,media});
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

      if(b.action==="save_product"){
        const p=b.product||{}; const mfr=b.manufacturer||p.manufacturer;
        if(!mfr||!p.code||!String(p.name||"").trim()) return json(400,{error:"manufacturer, code and name are required"});
        await sb("POST","custom_products?on_conflict=manufacturer,code",{
          manufacturer:mfr, code:String(p.code).trim(), name:String(p.name).trim(),
          category:p.category||null, base_price:num(p.base_price), msrp:num(p.msrp),
          map:num(p.map), msrp_auto:p.msrp_auto===true,
          image:p.image||null, description:p.description||null,
          tiers:cleanTiers(p.tiers), price_note:p.price_note||null,
          active:p.active===false?false:true, updated_at:new Date().toISOString()
        },{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }

      // Rename a product's SKU/code. A standard catalog product can't be renamed in place — its
      // code is the join key into the deployed catalog JSON — so a rename forks it into a
      // custom_products row under the NEW code carrying every field, re-points its link / media /
      // featured rows to the new code, and retires the OLD code (hides the catalog original with
      // an active:false override, or deletes the old row if it was already a custom product).
      if(b.action==="rename_code"){
        const mfr=b.manufacturer, oldCode=String(b.old_code||"").trim(), newCode=String(b.new_code||"").trim();
        const p=b.product||{};
        if(!mfr||!oldCode||!newCode) return json(400,{error:"manufacturer, old_code and new_code are required"});
        if(oldCode===newCode) return json(400,{error:"new_code matches old_code"});
        // don't clobber an existing added product that already uses the new code
        const clash=await sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(mfr)}&code=eq.${encodeURIComponent(newCode)}&select=code`).catch(()=>[]);
        if(clash&&clash.length) return json(409,{error:`SKU "${newCode}" is already in use`});
        // 1) create the product under the new code with all fields carried from the client
        await sb("POST","custom_products?on_conflict=manufacturer,code",{
          manufacturer:mfr, code:newCode, name:String(p.name||"").trim()||newCode,
          category:p.category||null, base_price:num(p.base_price), msrp:num(p.msrp),
          image:p.image||null, description:p.description||null,
          tiers:cleanTiers(p.tiers), price_note:p.price_note||null,
          active:p.active===false?false:true, updated_at:new Date().toISOString()
        },{Prefer:"resolution=merge-duplicates,return=minimal"});
        // 2) move link / media / featured rows from the old code to the new code (best-effort)
        for(const tbl of ["product_links","product_media","featured_products"]){
          try{ await sb("PATCH",`${tbl}?manufacturer=eq.${encodeURIComponent(mfr)}&code=eq.${encodeURIComponent(oldCode)}`,{code:newCode},{Prefer:"return=minimal"}); }catch(e){}
        }
        // 3) retire the old code
        if(b.was_custom){
          try{ await sb("DELETE",`custom_products?manufacturer=eq.${encodeURIComponent(mfr)}&code=eq.${encodeURIComponent(oldCode)}`,null,{Prefer:"return=minimal"}); }catch(e){}
          try{ await sb("DELETE",`product_overrides?manufacturer=eq.${encodeURIComponent(mfr)}&code=eq.${encodeURIComponent(oldCode)}`,null,{Prefer:"return=minimal"}); }catch(e){}
        }else{
          await sb("POST","product_overrides?on_conflict=manufacturer,code",
            {manufacturer:mfr,code:oldCode,patch:{active:false},updated_at:new Date().toISOString()},
            {Prefer:"resolution=merge-duplicates,return=minimal"});
        }
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
        if("map" in p) patch.map=num(p.map);
        if("msrp_auto" in p) patch.msrp_auto=(p.msrp_auto===true);
        if("tiers" in p) patch.tiers=cleanTiers(p.tiers);
        if("active" in p) patch.active=(p.active!==false);
        if("image" in p && p.image) patch.image=String(p.image);
        /* Price Check disposition. A manufacturer price list always carries codes HCPS
           will never list — retired items, accessories we don't stock, kit components.
           Without a way to say so, those sit in the "unassigned pricing" queue forever
           and Price Check can never legitimately reach 100%. Recording the decision
           (with who and when) turns an unresolved error into an auditable choice.
           '' clears it and the code returns to the queue. */
        if("disposition" in p){
          const ALLOWED=["","do_not_list","discontinued","not_offered","ignore"];
          const d=String(p.disposition||"").trim();
          if(ALLOWED.indexOf(d)<0) return json(400,{error:"unknown disposition"});
          if(d){ patch.disposition=d;
                 patch.disposition_note=p.disposition_note!=null?String(p.disposition_note).slice(0,300):null;
                 patch.disposition_at=new Date().toISOString();
                 patch.disposition_by=p.disposition_by?String(p.disposition_by).slice(0,80):null; }
          else { patch.disposition=null; patch.disposition_note=null; patch.disposition_at=null; patch.disposition_by=null; }
        }
        // Provenance from an imported price list — which file, and the date it takes effect.
        if(p.case_qty!=null) patch.case_qty=num(p.case_qty);
        if(p.effective_date!=null) patch.effective_date=String(p.effective_date).slice(0,40);
        if(p.source_file!=null) patch.source_file=String(p.source_file).slice(0,160);
        /* A base+custom duplicate that has been deliberately reconciled. The surviving
           values are written here (the layer the portal reads), and the stamp records
           that the pair was settled on purpose rather than merely repriced. */
        if("merged_at" in p){ patch.merged_at=p.merged_at?String(p.merged_at).slice(0,40):null;
          patch.merged_by=p.merged_by?String(p.merged_by).slice(0,80):((patch.merged_at&&b.reviewer)?String(b.reviewer).slice(0,80):null); }

        /* MERGE, don't replace. Callers send only the fields they are changing — a
           disposition, one settled price, a corrected MSRP — and the row's patch is the
           single jsonb blob holding all of them. Writing it wholesale would silently drop
           every override this caller didn't happen to send: recording "do not list" would
           erase the product's overridden name and price. bulk_price already reads-then-merges
           for exactly this reason; save_override has to do the same. Pass replace:true to
           overwrite the whole patch deliberately. */
        const enc1=encodeURIComponent, codeK=String(b.code).trim();
        let merged=patch;
        if(b.replace!==true){
          const ex=await sb("GET",`product_overrides?manufacturer=eq.${enc1(b.manufacturer)}&code=eq.${enc1(codeK)}&select=patch`).catch(()=>[]);
          merged=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{},patch);
        }
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:b.manufacturer,code:codeK,patch:merged,updated_at:new Date().toISOString()},
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="clear_override"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        await sb("DELETE",`product_overrides?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }

      // Apply pricing to many codes at once — powers the pricelist importer, bulk edits, and
      // auto-MSRP generation from the Price Check audit. Each row carries a code and any of
      // base_price / msrp / map / msrp_auto / price_note. A code that's already a custom product
      // is PATCHed; a code with create:true (or a name) that isn't in the catalog yet is created
      // as a custom product; any other code (a standard/base catalog item) gets a merged override.
      if(b.action==="bulk_price"){
        const mfr=b.manufacturer; const rows=Array.isArray(b.rows)?b.rows:[];
        if(!mfr||!rows.length) return json(400,{error:"manufacturer and rows required"});
        const enc=encodeURIComponent;
        const cust=await sb("GET",`custom_products?manufacturer=eq.${enc(mfr)}&select=code`).catch(()=>[]);
        const customCodes=new Set((cust||[]).map(r=>String(r.code)));
        /* Fields an imported price row can carry. Case quantity and effective date are
           real facts from the manufacturer's sheet, but only the override layer stores
           arbitrary keys (its patch is jsonb) — a custom_products row has fixed columns.
           So they are also folded into price_note, which every layer already carries and
           every surface already displays. That way the information survives wherever the
           code happens to live, instead of existing for some codes and not others. */
        const priceFields=(r)=>{ const f={};
          ["base_price","msrp","map"].forEach(k=>{ if(k in r) f[k]=num(r[k]); });
          if("msrp_auto" in r) f.msrp_auto=(r.msrp_auto===true);
          const bits=[];
          if(r.effective_date!=null&&String(r.effective_date).trim()) bits.push("eff. "+String(r.effective_date).trim().slice(0,30));
          if(r.case_qty!=null&&String(r.case_qty).trim()) bits.push("case qty "+String(r.case_qty).trim().slice(0,12));
          if(r.source_file!=null&&String(r.source_file).trim()) bits.push(String(r.source_file).trim().slice(0,80));
          if(r.price_note!=null) f.price_note=String(r.price_note);
          else if(bits.length) f.price_note=bits.join(" · ");
          return f; };
        let applied=0, created=0, failed=0; const now=new Date().toISOString();
        for(const r of rows){
          const code=String(r.code||"").trim(); if(!code) continue;
          const pf=priceFields(r);
          try{
            if(customCodes.has(code)){
              await sb("PATCH",`custom_products?manufacturer=eq.${enc(mfr)}&code=eq.${enc(code)}`,
                Object.assign({},pf,{updated_at:now}),{Prefer:"return=minimal"});
              applied++;
            } else if(r.create===true || (r.name!=null && String(r.name).trim())){
              await sb("POST","custom_products?on_conflict=manufacturer,code",
                Object.assign({manufacturer:mfr,code,name:String(r.name||code).trim(),category:r.category||null,active:true,updated_at:now},pf),
                {Prefer:"resolution=merge-duplicates,return=minimal"});
              customCodes.add(code); created++;
            } else {
              const ex=await sb("GET",`product_overrides?manufacturer=eq.${enc(mfr)}&code=eq.${enc(code)}&select=patch`).catch(()=>[]);
              const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{},pf);
              await sb("POST","product_overrides?on_conflict=manufacturer,code",
                {manufacturer:mfr,code,patch,updated_at:now},{Prefer:"resolution=merge-duplicates,return=minimal"});
              applied++;
            }
          }catch(e){ failed++; }
        }
        return json(200,{ok:true,applied,created,failed});
      }
      // Set the shop CATEGORY for a set of SKU codes so the ordering platform re-files them —
      // this is what makes an accepted category in the Catalog Review actually move the product on
      // Partner 360. Custom products are PATCHed in place (other fields preserved); standard catalog
      // products get a product_overrides patch with category MERGED into any existing override.
      if(b.action==="set_category"){
        const mfr=b.manufacturer;
        const codes=Array.isArray(b.codes)?[...new Set(b.codes.map(c=>String(c).trim()).filter(Boolean))]:[];
        const category=(b.category==null||b.category==="")?null:String(b.category).trim();
        if(!mfr||!codes.length) return json(400,{error:"manufacturer, codes[] required"});
        const cust=await sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(mfr)}&select=code`).catch(()=>[]);
        const isCustom=new Set((cust||[]).map(r=>String(r.code)));
        let custN=0, ovN=0;
        for(const code of codes){
          if(isCustom.has(code)){
            await sb("PATCH",`custom_products?manufacturer=eq.${encodeURIComponent(mfr)}&code=eq.${encodeURIComponent(code)}`,{category,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
            custN++;
          } else {
            const ex=await sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(mfr)}&code=eq.${encodeURIComponent(code)}&select=patch`).catch(()=>[]);
            const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{},{category});
            await sb("POST","product_overrides?on_conflict=manufacturer,code",{manufacturer:mfr,code,patch,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
            ovN++;
          }
        }
        return json(200,{ok:true,custom:custN,overrides:ovN,codes:codes.length});
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

      // ---- product media gallery (additional images / videos / brochures / links) ----
      if(b.action==="add_media"){
        const kind=String(b.kind||"").trim(); const url=String(b.url||"").trim();
        if(!b.manufacturer||!b.code||!url) return json(400,{error:"manufacturer, code, url required"});
        if(!["image","video","brochure","link"].includes(kind)) return json(400,{error:"kind must be image|video|brochure|link"});
        let sort=0; try{ const ex=await sb("GET",`product_media?manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}&select=sort&order=sort.desc&limit=1`); sort=(ex&&ex[0]&&(+ex[0].sort+1))||0; }catch(e){}
        const ins=await sb("POST","product_media",{manufacturer:b.manufacturer,code:String(b.code).trim(),kind,url,title:(b.title!=null?String(b.title):null),sort},{Prefer:"return=representation"});
        return json(200,{ok:true,item:ins&&ins[0]});
      }
      if(b.action==="update_media"){
        if(!b.id) return json(400,{error:"id required"});
        const patch={}; if(b.title!=null) patch.title=String(b.title); if(b.sort!=null) patch.sort=parseInt(b.sort,10)||0;
        if(!Object.keys(patch).length) return json(400,{error:"nothing to update"});
        await sb("PATCH",`product_media?id=eq.${encodeURIComponent(b.id)}`,patch,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="delete_media"){
        if(!b.id) return json(400,{error:"id required"});
        await sb("DELETE",`product_media?id=eq.${encodeURIComponent(b.id)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="reorder_media"){
        const ids=Array.isArray(b.ids)?b.ids:[];
        for(let i=0;i<ids.length;i++){ try{ await sb("PATCH",`product_media?id=eq.${encodeURIComponent(ids[i])}`,{sort:i},{Prefer:"return=minimal"}); }catch(e){} }
        return json(200,{ok:true});
      }

      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
