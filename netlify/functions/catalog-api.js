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
/* THE JOIN, AND THE STATUS DERIVED FROM IT, LIVE IN ONE FILE — the same one the shop's rules
   are tested against. The admin used to have no way to answer "what will a dealer actually
   see", because the only code that knew how a catalog SKU meets an enrichment page lived
   inside the shop's page file. Importing it here is what makes the tools one system. */
const JOIN = require("./_catalog-join.js");

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

/* ─────────────────────── Duplicate detection & merge ───────────────────────
   The Product Catalog is the master record. Two mechanisms were quietly creating a
   second copy of a product instead of improving the first:

     1. save_product always upserted into custom_products without ever asking whether
        that SKU already existed as a standard catalog product. Publishing an enriched
        SKU that was already in the catalog therefore produced two rows.
     2. The unique index is (manufacturer, code) and Postgres compares codes literally,
        so "MP-P09" and "mp-p09" are two different products to the database and one
        product to a human. Every duplicate in the catalog today is that pair.

   normCode is the join a person actually means: case-folded, punctuation-stripped. It
   is used to FIND duplicates and to block new ones — never to merge anything on its
   own, because two records that look alike can still be a genuinely different variant.
   That call stays with a person. */
const normCode = c => String(c||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const normName = n => String(n||"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();

// Everything hanging off one SKU. This is what makes a delete or a merge safe to judge:
// nothing is removed without first showing what points at it.
/* THE SAME QUESTION FOR MANY CODES, IN FIVE QUERIES INSTEAD OF FIVE PER CODE.
   connectionsFor is five reads. record_detail asked it for up to 60 codes, so every time
   the catalog reloaded it fired THREE HUNDRED queries — and the catalog reloaded after
   every single edit. That is the wait: not the render, not the page, but a fan-out that
   grew with the size of the duplicate queue. Asked once for the whole list it is five
   reads regardless of how many codes are in it. */
async function connectionsForMany(mfr, codes){
  const list=[...new Set((codes||[]).map(c=>String(c||"").trim()).filter(Boolean))];
  const out={}; list.forEach(c=>{ out[c]={links:0,media:0,featured:0,has_override:false,override:null,orders:0}; });
  if(!list.length) return out;
  const e=encodeURIComponent;
  // PostgREST in.() needs each value quoted — codes carry dots, dashes and spaces.
  const inList="("+list.map(c=>'"'+String(c).replace(/"/g,'\\"')+'"').join(",")+")";
  const q=`manufacturer=eq.${e(mfr)}&code=in.${e(inList)}`;
  const [links,media,feat,ovr,items]=await Promise.all([
    sb("GET",`product_links?${q}&select=code`).catch(()=>[]),
    sb("GET",`product_media?${q}&select=code`).catch(()=>[]),
    sb("GET",`featured_products?${q}&select=code`).catch(()=>[]),
    sb("GET",`product_overrides?${q}&select=code,patch`).catch(()=>[]),
    // order_items is not scoped by manufacturer — a code is a code there.
    sb("GET",`order_items?code=in.${e(inList)}&select=code&limit=5000`).catch(()=>[]),
  ]);
  const bump=(rows,key)=>(rows||[]).forEach(r=>{ const c=String(r.code||""); if(out[c]) out[c][key]++; });
  bump(links,"links"); bump(media,"media"); bump(feat,"featured"); bump(items,"orders");
  (ovr||[]).forEach(r=>{ const c=String(r.code||""); if(out[c]){ out[c].has_override=!!r.patch; out[c].override=r.patch||null; } });
  return out;
}
async function connectionsFor(mfr, code){
  const e=encodeURIComponent, q=`manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`;
  const [links,media,feat,ovr,items]=await Promise.all([
    sb("GET",`product_links?${q}&select=code`).catch(()=>[]),
    sb("GET",`product_media?${q}&select=id`).catch(()=>[]),
    sb("GET",`featured_products?${q}&select=code`).catch(()=>[]),
    sb("GET",`product_overrides?${q}&select=patch`).catch(()=>[]),
    // Order history is the one connection that must never be rewritten — an order says
    // what was actually bought. It is counted so a merge can warn, not migrated.
    sb("GET",`order_items?code=eq.${e(code)}&select=id&limit=200`).catch(()=>[]),
  ]);
  const patch=(ovr&&ovr[0]&&ovr[0].patch)||null;
  return {
    links:(links||[]).length, media:(media||[]).length, featured:(feat||[]).length,
    has_override:!!patch, override:patch||null, orders:(items||[]).length,
  };
}

/* Group a manufacturer's products by normalised code and by normalised name, and return
   only the groups holding more than one distinct record. Evidence is spelled out per
   group so the review screen can say WHY, rather than asking someone to trust a flag. */
function duplicateGroups(base, custom, overrides){
  const rec=[];
  (base||[]).forEach(p=>rec.push({code:String(p.code), name:p.name||"", category:p.category||"",
    base_price:p.base_price, msrp:p.msrp, image:p.image||"", group:p.group||"", kind:"catalog"}));
  (custom||[]).forEach(p=>rec.push({code:String(p.code), name:p.name||"", category:p.category||"",
    base_price:p.base_price, msrp:p.msrp, image:p.image||"", group:"", kind:"added", active:p.active}));
  const groups=[];
  const byCode={};
  rec.forEach(r=>{ const k=normCode(r.code); if(!k) return; (byCode[k]=byCode[k]||[]).push(r); });
  Object.keys(byCode).forEach(k=>{
    const members=byCode[k];
    if(members.length<2) return;
    const literal=new Set(members.map(m=>m.code));
    const reasons=[];
    /* Two shapes hide behind "same code". Two DIFFERENT spellings of one SKU are two
       records and merge one into the other. ONE spelling appearing in both the catalog
       file and the added table is not two products at all — it is one product stored in
       two layers, and there is no loser to retire. They are resolved by different actions,
       so the group says which it is rather than leaving the screen to guess. */
    const sameCode = literal.size===1;
    if(sameCode) reasons.push("the same SKU exists as both a catalog product and an added product");
    else reasons.push(`the same SKU written differently: ${[...literal].join(" / ")}`);
    const names=new Set(members.map(m=>normName(m.name)).filter(Boolean));
    if(names.size===1 && members.every(m=>m.name)) reasons.push("identical product name");
    groups.push({ key:"code:"+k, match:"sku", confidence:"high",
      same_code:sameCode, code:sameCode?members[0].code:null, reasons, members });
  });
  /* Same name, unrelated codes — a weaker signal, so it is offered for review only.

     AND THE MOST IMPORTANT EXCLUSION IN THIS FILE. Some lines are one SKU per product
     (a wheelchair). Others sell ONE product in many sizes and sides, each with its own
     SKU and — necessarily — THE SAME NAME. On those lines every size of every product
     matches this rule, and merging any of them would collapse a six-size product into
     one orderable item and take the rest off the portal.

     The catalog already records which SKUs are sizes of one product: the `group` field,
     which is exactly what the portal uses to build a "6 sizes / options" card. So a pair
     that shares a group is never a duplicate — it is the product working as intended —
     and is not offered for merging at all. */
  const byName={};
  rec.forEach(r=>{ const n=normName(r.name); if(!n||n.length<6) return; (byName[n]=byName[n]||[]).push(r); });
  Object.keys(byName).forEach(n=>{
    const members=byName[n];
    if(members.length<2) return;
    if(new Set(members.map(m=>normCode(m.code))).size<2) return;   // already caught by code
    const groupsSeen=new Set(members.map(m=>String(m.group||"").trim()).filter(Boolean));
    if(groupsSeen.size===1 && members.every(m=>String(m.group||"").trim()))
      return;                       // every one of them is a size of the same product
    groups.push({ key:"name:"+n, match:"name", confidence:"review",
      variant_group_split: groupsSeen.size>1,
      reasons:[groupsSeen.size>1
        ? `identical product name, but these sit in ${groupsSeen.size} different catalog groups — check the grouping before merging anything`
        : "identical product name on different SKUs — may be a real variant"], members });
  });
  const ov=overrides||{};
  groups.forEach(g=>g.members.forEach(m=>{
    const o=ov[m.code]||{};
    m.disposition=o.disposition||null; m.merged_into=o.merged_into||null;
    m.retired=(o.active===false)||(m.active===false);
    m.layers_merged=!!o.layers_merged_at;
  }));
  /* A group whose duplicate has already been merged or retired is settled. So is a
     same-code pair that has been consolidated: its two layers now resolve to one record.
     It cannot be settled by retiring a member the way a two-code merge is — both members
     share one code, so deactivating "the loser" would take the product itself off Partner
     360. The consolidation stamp is what closes it. */
  /* AND — the omission that made this queue impossible to empty. A same-code pair could
     only be settled by consolidating it. So a SKU the manufacturer had discontinued, that
     had been hidden and marked not-for-sale, still came back as an open duplicate every
     time, forever. There was no answer to it except to merge a product that no longer
     exists into itself. A retired or dispositioned code is settled: the product is off
     Partner 360 and there is nothing left to decide about it. */
  return groups.filter(g=>{
    if(g.same_code) return !g.members.some(m=>m.layers_merged || m.retired || m.disposition);
    return g.members.filter(m=>!m.merged_into && !m.retired && !m.disposition).length>1;
  });
}

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

/* ── ONE MASTER RECORD, RESOLVED ONCE ──────────────────────────────────────────
   The five layers, applied server-side in the same order the catalog screen applies them:
   deployed catalog file → custom_products → product_overrides. A custom row REPLACES a base
   row with the same code (it is the same product, added later), and the override patch sits
   on top of whichever one won. Doing this on the server is what lets every tool — and every
   audit — start from an identical list instead of each rebuilding its own. */
async function resolveCatalog(slug){
  const e=encodeURIComponent;
  const [base,custom,overRows,mediaRows]=await Promise.all([
    fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),
    sb("GET",`custom_products?manufacturer=eq.${e(slug)}&select=code,name,category,base_price,msrp,image,description,active,tiers,price_note`).catch(()=>[]),
    sb("GET",`product_overrides?manufacturer=eq.${e(slug)}&select=code,patch`).catch(()=>[]),
    sb("GET",`product_media?manufacturer=eq.${e(slug)}&select=code`).catch(()=>[]),
  ]);
  const over=Object.fromEntries((overRows||[]).map(o=>[o.code,o.patch||{}]));
  const mediaCount={}; (mediaRows||[]).forEach(r=>{ mediaCount[r.code]=(mediaCount[r.code]||0)+1; });
  const map=new Map();
  const put=(p,kind)=>{ const o=over[p.code]||{}; map.set(String(p.code), Object.assign({},p,o,{kind})); };
  (base||[]).forEach(p=>put(p,"catalog"));
  (custom||[]).forEach(p=>put(p,"custom"));
  return [...map.values()].map(p=>({
    code:String(p.code||""), name:p.name||"", group:p.group||"",
    category:p.category||"", subcategory:p.subcategory||"",
    image:p.image||"", description:p.description||"",
    price:(p.base_price===""||p.base_price==null)?null:Number(p.base_price),
    tiers:Array.isArray(p.tiers)?p.tiers:[],
    active:p.active!==false,
    media_count:mediaCount[p.code]||0,
    // A category typed directly in the admin is a decision; the subcategory map fills the
    // answer, it does not overrule one.
    category_from_override:Object.prototype.hasOwnProperty.call(over[p.code]||{},"category"),
    kind:p.kind,
  }));
}

/* ALL pages, every status — the admin has to see drafts. The shop's live gate is applied
   inside the join, so "written" and "visible" stay two separate, reportable facts. */
async function loadPages(slug){
  const rows=await sb("GET",`product_content?manufacturer=eq.${encodeURIComponent(slug)}&select=page_key,name,status,subcategory,description,features,images_gallery,image,skus,variant_group`).catch(()=>[]);
  const pages={}; (rows||[]).forEach(r=>{ if(r&&r.page_key) pages[r.page_key]=r; });
  return pages;
}

async function loadMeta(slug){
  const rows=await sb("GET",`manufacturer_meta?slug=eq.${encodeURIComponent(slug)}&select=slug,enriched_only,category_order,category_map`).catch(()=>[]);
  return (rows&&rows[0])||{};
}

async function sweepManufacturer(slug){
  const [products,pages,meta]=await Promise.all([resolveCatalog(slug),loadPages(slug),loadMeta(slug)]);
  const categoryMap=(meta.category_map&&typeof meta.category_map==="object")?meta.category_map:null;
  // The dealer-facing headings are the ordered list if one is set, otherwise whatever the
  // subcategory map actually points at. With neither, the rule stays quiet rather than
  // flagging every product on a line nobody has organised yet.
  const dealerCategories=Array.isArray(meta.category_order)&&meta.category_order.length
    ? meta.category_order.map(String)
    : (categoryMap?[...new Set(Object.values(categoryMap).map(String))]:[]);
  return JOIN.sweep({products,pages,categoryMap,dealerCategories,
    enrichedOnly:meta.enriched_only===true});
}

/* ── PRODUCT CREATED → … → APPEARS CORRECTLY IN PARTNER 360 ────────────────────
   The ten steps, each one an assertion against real data rather than a screenshot. A step
   that fails names the products that failed it, capped to a readable sample, so the next
   action is obvious instead of another hunt. */
async function flowTest(slug, sample){
  const swept=await sweepManufacturer(slug);
  const rows=swept.rows, cat=rows.filter(r=>r.source==="catalog");
  const names=list=>list.slice(0,sample).map(r=>r.code);
  const step=(id,name,pass,detail,offenders)=>({id,name,pass:!!pass,detail,
    offenders:offenders?names(offenders):[], offender_count:offenders?offenders.length:0});

  const unlinked=cat.filter(r=>r.unlinked);
  const orphanPage=rows.filter(r=>r.no_catalog_row);
  const unpriced=cat.filter(r=>r.status==="needs_pricing");
  const uncategorised=rows.filter(r=>r.status==="needs_category");
  const imageless=rows.filter(r=>r.status==="needs_images");
  const dupes=rows.filter(r=>r.status==="possible_duplicate");
  const ready=rows.filter(r=>r.status==="ready_to_publish");
  const live=rows.filter(r=>r.status==="published");
  const claimedNotVisible=cat.filter(r=>r.page_key&&!r.visible&&r.active);

  const steps=[
    step(1,"Product created", cat.length>0,
      `${cat.length} catalog SKU(s) resolved through all five price layers.`),
    step(2,"Appears in Catalog", cat.length>0,
      `${cat.length} SKU(s) in the master list.`),
    step(3,"Appears in Enrichment", unlinked.length===0,
      unlinked.length?`${unlinked.length} catalog SKU(s) have no enrichment page.`
                     :"Every catalog SKU is claimed by an enrichment page.", unlinked),
    step(4,"Categorized in Structure Map", uncategorised.length===0,
      uncategorised.length?`${uncategorised.length} SKU(s) have no dealer-facing category or an unmapped subcategory.`
                          :"Every SKU resolves to a dealer-facing category.", uncategorised),
    step(5,"Pricing attached", unpriced.length===0,
      unpriced.length?`${unpriced.length} SKU(s) have no price and no tier.`
                     :"Every SKU carries a price or a quantity break.", unpriced),
    step(6,"Images / documents attached", imageless.length===0,
      imageless.length?`${imageless.length} SKU(s) have no image on the SKU or its page.`
                      :"Every SKU has at least one image.", imageless),
    step(7,"Duplicate check", dupes.length===0,
      dupes.length?`${dupes.length} SKU(s) share a part number with another and are unsettled.`
                  :"No unsettled duplicate part numbers.", dupes),
    step(8,"Preview", orphanPage.length===0,
      orphanPage.length?`${orphanPage.length} SKU(s) are listed on a page but have no catalog record, so preview shows what cannot be sold.`
                       :"Every previewed SKU has a catalog record behind it.", orphanPage),
    step(9,"Publish", ready.length===0,
      ready.length?`${ready.length} SKU(s) are complete and waiting to be published.`
                  :"Nothing is sitting finished-but-unpublished.", ready),
    step(10,"Appears correctly in Partner 360", claimedNotVisible.length===0 && live.length>0,
      claimedNotVisible.length?`${claimedNotVisible.length} SKU(s) have a page but are still not visible to dealers.`
        :(live.length?`${live.length} SKU(s) are live and visible.`:"Nothing is live on this line yet."),
      claimedNotVisible),
  ];
  const firstFail=steps.find(s=>!s.pass);
  return {ok:true, slug, sample, counts:swept.counts, total:swept.total,
    enriched_only:swept.enriched_only, percent_published:swept.percent_published,
    steps, passed:steps.filter(s=>s.pass).length, of:steps.length,
    next_step:firstFail?firstFail.name:null,
    next_action:firstFail?firstFail.detail:"The whole flow passes for this line."};
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
          sb("GET","manufacturer_meta?select=slug,logo_url,enriched_only,category_order,category_map").catch(()=>[]),
        ]);
        const lm=Object.fromEntries((logos||[]).map(o=>[o.slug,o.logo_url]));
        const em=Object.fromEntries((logos||[]).map(o=>[o.slug,o.enriched_only===true]));
        const co=Object.fromEntries((logos||[]).map(o=>[o.slug,Array.isArray(o.category_order)?o.category_order:null]));
        const cmp=Object.fromEntries((logos||[]).map(o=>[o.slug,(o.category_map&&typeof o.category_map==="object")?o.category_map:null]));
        return json(200,{manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name,hasData:!!m.hasData,
          logo_url:lm[m.slug]||"", enriched_only:!!em[m.slug], category_order:co[m.slug]||null,
          category_map:cmp[m.slug]||null}))});
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
      return json(200,{products,custom:custom||[],links:linkMap,overrides,featured,media,
        ordering_base:ORDERING_BASE});
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
        /* THE DUPLICATE GUARD. This endpoint used to upsert into custom_products with no
           question asked, so publishing an enriched SKU that already existed in the catalog
           produced a second, independent product — which is every duplicate now in the
           catalog. A write under the SAME literal code is an update and always allowed. A
           write under a DIFFERENT spelling of a code that already exists (MP-P09 vs mp-p09)
           is refused, and the caller is told what it collided with so it can enrich that
           record instead. Pass allow_duplicate:true only for a genuinely different variant. */
        const codeIn=String(p.code).trim();
        if(b.allow_duplicate!==true){
          const nk=normCode(codeIn);
          const [baseAll,customAll]=await Promise.all([
            fetchJson(`${ORDERING_BASE}/data/${mfr}.json`).catch(()=>[]),
            sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(mfr)}&select=code,name`).catch(()=>[]),
          ]);
          const clash=[]
            .concat((baseAll||[]).map(x=>({code:String(x.code),name:x.name||"",kind:"catalog"})))
            .concat((customAll||[]).map(x=>({code:String(x.code),name:x.name||"",kind:"added"})))
            .find(x=>x.code!==codeIn && normCode(x.code)===nk);
          if(clash){
            const conn=await connectionsFor(mfr,clash.code).catch(()=>null);
            return json(409,{error:"duplicate_sku", code:codeIn, existing:clash, connections:conn,
              message:`SKU "${codeIn}" is the same item as "${clash.code}", which is already in the catalog. `
                    + `Enrich that record instead of creating a second copy — or resend with allow_duplicate:true if this really is a different model.`});
          }
        }
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
        /* THE COLLISION IS AN ANSWER, NOT A REFUSAL.
           This checked custom_products only, so renaming a product onto a code that exists
           in the DEPLOYED CATALOG FILE was not caught at all — it created an added row that
           silently shadowed a real catalog product, which is one more way a second copy of
           one product got made. Both layers are checked now.

           And a collision is reported as data. Someone renumbering a part almost always
           means "this is the same item as that one" — so the screen is given the record that
           was hit and everything attached to it, and can offer to merge into it. Refusing
           with a bare string left them stuck with two records and no way forward. */
        const eN=encodeURIComponent;
        const [baseAll,customAll]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${mfr}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${eN(mfr)}&select=code,name,base_price,active`).catch(()=>[]),
        ]);
        const hit=[]
          .concat((baseAll||[]).map(x=>({code:String(x.code),name:x.name||"",price:x.base_price,kind:"catalog"})))
          .concat((customAll||[]).map(x=>({code:String(x.code),name:x.name||"",price:x.base_price,kind:"added"})))
          .find(x=>normCode(x.code)===normCode(newCode));
        if(hit){
          const conn=await connectionsFor(mfr,hit.code).catch(()=>null);
          return json(409,{error:"sku_in_use", old_code:oldCode, new_code:newCode,
            existing:hit, connections:conn,
            same_spelling: hit.code===newCode,
            message:`SKU "${newCode}" already belongs to "${hit.name||hit.code}". `
                  + `If that is the same item, merge ${oldCode} into it instead of renumbering.`});
        }
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
        /* The grouping key. This is what makes several SKUs render as ONE product card with
           a size picker instead of one card per size, and until now it existed only in the
           deployed catalog file — so a wrong group could not be fixed without a redeploy.
           Storing it as an override makes grouping correctable from the admin, live. */
        if(p.group!=null) patch.group=String(p.group).slice(0,200);
        /* Subcategory is the second level a dealer browses by. It was recorded only during
           enrichment, so a product without an enrichment record could not be filed under one
           at all — and the few that slip through are exactly the ones that go missing from
           the shop's filters. Editable here for the same reason category is. */
        if(p.subcategory!=null) patch.subcategory=String(p.subcategory).slice(0,120);
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
          /* Deletion is the last resort, not the default. These are the states a
             questionable record can be put into instead — every one reversible, none
             of which loses pricing, orders, images or published content. */
          const ALLOWED=["","do_not_list","discontinued","not_offered","ignore","archived","possible_duplicate","disabled"];
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
      // base_price / msrp / map / msrp_auto / price_note / tiers. A code that's already a custom product
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
          /* Quantity-break ladder from an imported price list. Every other layer already
             carried tiers — custom_products has the column, product_overrides.patch is
             jsonb, and Partner 360 reads and applies them at checkout — so this importer
             was the single place a manufacturer's price breaks stopped. cleanTiers
             validates and sorts; an empty ladder resolves to null, which clears the
             breaks rather than leaving a stale one behind a new base price. */
          if("tiers" in r) f.tiers=cleanTiers(r.tiers);
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

      /* SET ONE GROUP ACROSS SEVERAL SKUS — "these are sizes of one product".
         The group is what Partner 360 uses to fold SKUs into a single card with a size
         picker, so this is the answer to a set of same-named codes that are NOT duplicates
         but siblings. It writes to the OVERRIDE layer for every code, including added
         products: custom_products has no group column, which is why an added product's
         group was silently dropped before. One read, one upsert for the whole set. */
      if(b.action==="set_group"){
        const mfr=b.manufacturer;
        const codes=Array.isArray(b.codes)?[...new Set(b.codes.map(c=>String(c).trim()).filter(Boolean))]:[];
        const group=(b.group==null)?"":String(b.group).trim().slice(0,160);
        if(!mfr||!codes.length) return json(400,{error:"manufacturer, codes[] required"});
        if(codes.length>200) return json(400,{error:"too_many"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const ovAll=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`).catch(()=>[]);
        const ovBy={}; (ovAll||[]).forEach(r=>{ ovBy[String(r.code)]=r.patch||{}; });
        const rows=codes.map(code=>({manufacturer:mfr,code,
          patch:Object.assign({},ovBy[code]||{},{group}), updated_at:now}));
        await sb("POST","product_overrides?on_conflict=manufacturer,code",rows,
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true,codes:codes.length,group});
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
      /* Deleting used to remove the custom_products row and nothing else, leaving that
         SKU's links, images, featured placement and override behind as orphans pointing at
         a product that no longer exists — and taking with it any record of a SKU that had
         been ordered. So a delete now REFUSES while anything is connected, and names what.
         Retiring (merge, or active:false) is the reversible answer; force:true is the
         deliberate exception, and it cleans up the connected rows rather than orphaning them. */
      if(b.action==="delete_product"){
        if(!b.manufacturer||!b.code) return json(400,{error:"manufacturer, code required"});
        const mfr=b.manufacturer, code=String(b.code).trim(), e=encodeURIComponent;
        const conn=await connectionsFor(mfr,code).catch(()=>null);
        if(conn && b.force!==true){
          const held=[];
          if(conn.orders)   held.push(`${conn.orders} order line${conn.orders===1?"":"s"}`);
          if(conn.links)    held.push("a More Information link");
          if(conn.media)    held.push(`${conn.media} image/document${conn.media===1?"":"s"}`);
          if(conn.featured) held.push("a Featured placement");
          if(conn.has_override) held.push("saved catalog edits");
          if(held.length) return json(409,{error:"in_use", code, connections:conn,
            message:`"${code}" still has ${held.join(", ")}. Deleting would break them. `
                  + `Merge it into the product it duplicates, or disable it — both are reversible.`});
        }
        if(b.force===true){
          for(const tbl of ["product_links","product_media","featured_products","product_overrides"]){
            try{ await sb("DELETE",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,null,{Prefer:"return=minimal"}); }catch(err){}
          }
        }
        await sb("DELETE",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true,forced:b.force===true});
      }

      /* DELETE MANY, WITHOUT EVER FORCING.
         Same guards as the single delete, checked per code, and nothing is forced past
         them. A record that still has order lines, media, links, a Featured placement or
         saved catalog edits is refused and named — deleting it would leave those pointing
         at nothing, and order lines in particular are what commission and sales reporting
         are built from. Only added products are deletable at all; a standard catalog
         product lives in the deployed file and is not ours to remove. */
      if(b.action==="delete_products_bulk"){
        const mfr=b.manufacturer;
        const codes=[...new Set((Array.isArray(b.codes)?b.codes:[]).map(c=>String(c||"").trim()).filter(Boolean))];
        if(!mfr||!codes.length) return json(400,{error:"manufacturer and codes required"});
        if(codes.length>200) return json(400,{error:"too_many", message:"Send at most 200 codes per call."});
        const e=encodeURIComponent;
        const [custom,connAll]=await Promise.all([
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&select=code`).catch(()=>[]),
          connectionsForMany(mfr,codes).catch(()=>({})),
        ]);
        const isAdded=new Set((custom||[]).map(x=>String(x.code)));
        const deleted=[], refused=[];
        for(const code of codes){
          if(!isAdded.has(code)){ refused.push({code, reason:"a standard catalog product — it can be hidden, not deleted"}); continue; }
          const conn=connAll[code]||null;
          if(conn){
            const held=[];
            if(conn.orders)   held.push(`${conn.orders} order line${conn.orders===1?"":"s"}`);
            if(conn.links)    held.push("a More Information link");
            if(conn.media)    held.push(`${conn.media} image/document${conn.media===1?"":"s"}`);
            if(conn.featured) held.push("a Featured placement");
            if(conn.has_override) held.push("saved catalog edits");
            if(held.length){ refused.push({code, reason:held.join(", "), connections:conn}); continue; }
          }
          try{
            await sb("DELETE",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,null,{Prefer:"return=minimal"});
            deleted.push(code);
          }catch(err){ refused.push({code, reason:"the delete did not complete — try it on its own"}); }
        }
        return json(200,{ok:true, deleted, refused, requested:codes.length});
      }

      /* Full provenance for every record in a duplicate group: what the catalog says,
         what the ENRICHMENT record says, and everything that would be at risk if it were
         removed. This exists because a merge screen that shows only two product names
         cannot answer the question a person is actually asking — "which of these is the
         one I approved, and what breaks if I get this wrong?" */
      if(b.action==="record_detail"){
        const mfr=b.manufacturer; if(!mfr) return json(400,{error:"manufacturer required"});
        const codes=[...new Set((Array.isArray(b.codes)?b.codes:[]).map(c=>String(c).trim()).filter(Boolean))].slice(0,60);
        if(!codes.length) return json(400,{error:"codes required"});
        const e=encodeURIComponent;
        const connAll=await connectionsForMany(mfr,codes).catch(()=>({}));
        const [base,custom,ovRows,content]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${e(mfr)}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&select=*`).catch(()=>[]),
          sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch,updated_at`).catch(()=>[]),
          /* The approved record. The title a person signed off lives HERE — custom_products
             only ever held a snapshot of the enrichment PAGE name at publish time, which is
             why merged records kept showing a generic family name instead of the specific
             title that was approved. Always resolve the enriched title live. */
          sb("GET",`product_content?manufacturer=eq.${e(mfr)}&select=page_key,name,family,category,subcategory,skus,status,disabled,image,images_gallery,updated_at,published_at&limit=5000`).catch(()=>[]),
        ]);
        const baseBy={}; (base||[]).forEach(p=>{ baseBy[String(p.code)]=p; });
        const custBy={}; (custom||[]).forEach(p=>{ custBy[String(p.code)]=p; });
        const ovBy={};   (ovRows||[]).forEach(o=>{ ovBy[String(o.code)]={patch:o.patch||{},updated_at:o.updated_at}; });

        /* SKU → enrichment page. A page can carry several SKUs; the per-SKU entry may hold
           its own name, and that is more specific than the page name when it exists. */
        const encBy={};
        (content||[]).forEach(pc=>{
          (Array.isArray(pc.skus)?pc.skus:[]).forEach(sk=>{
            const c=String((sk&&(sk.sku||sk.code))||sk||"").trim(); if(!c) return;
            const skuName=String((sk&&sk.name)||"").trim();
            encBy[c.toUpperCase()]={ page_key:pc.page_key,
              title:(skuName||pc.name||""), page_title:pc.name||"", sku_title:skuName,
              family:pc.family||"", category:pc.category||"", subcategory:pc.subcategory||"",
              status:pc.status||"", disabled:!!pc.disabled,
              image:pc.image||"", gallery:(pc.images_gallery||[]).length,
              updated_at:pc.updated_at||null, published_at:pc.published_at||null,
              sku_status:(sk&&sk.status)||"", sku_disabled:!!(sk&&sk.disabled), size:(sk&&sk.size)||"" };
          });
        });

        const out=[];
        for(const code of codes){
          const bp=baseBy[code], cp=custBy[code], ov=(ovBy[code]||{}).patch||{}, ovAt=(ovBy[code]||{}).updated_at||null;
          const enc=encBy[String(code).toUpperCase()]||null;
          const conn=connAll[code]||null;
          const first=(...v)=>{ for(const x of v){ if(x!=null&&x!=="") return x; } return null; };
          const currentTitle=first(ov.name, cp&&cp.name, bp&&bp.name) || code;
          const price=first(ov.base_price, cp&&cp.base_price, bp&&bp.base_price);
          const active=(ov.active===false)?false:(cp?(cp.active!==false):true);
          const disposition=ov.disposition||null;
          const merged_into=ov.merged_into||null;
          /* "Visible in Partner 360" is the same test the portal applies: it exists, it is
             not retired, not merged away, and carries a price a dealer could order at. */
          const published = active && !merged_into
            && !["do_not_list","not_offered","discontinued","archived"].includes(String(disposition||""))
            && price!=null && Number(price)>0;
          const warnings=[];
          if(enc && enc.title && enc.title!==currentTitle)
            warnings.push({level:"info", text:`This record contains newer enriched content — the approved title is “${enc.title}”.`});
          if(conn && conn.orders)
            warnings.push({level:"high", text:`This SKU has ${conn.orders} historical order line${conn.orders===1?"":"s"}. Merging keeps them; deleting would orphan them.`});
          if(published)
            warnings.push({level:"high", text:"This product is currently published in Partner 360 — dealers can see and order it right now."});
          if(String(disposition||"")==="discontinued" || /discontinu/i.test(String(enc&&enc.sku_status||"")))
            warnings.push({level:"info", text:"This item may be discontinued."});
          if(conn && (conn.media||conn.links))
            warnings.push({level:"info", text:`${conn.media} image/document${conn.media===1?"":"s"} and ${conn.links} link${conn.links===1?"":"s"} are attached to this record.`});
          out.push({
            code,
            current_title: currentTitle,
            enriched_title: enc ? enc.title : null,
            enriched_page_key: enc ? enc.page_key : null,
            enriched_page_title: enc ? enc.page_title : null,
            manufacturer: mfr,
            family: first(enc&&enc.family, bp&&bp.group) || "",
            group: first(ov.group, bp&&bp.group) || "",
            category: first(ov.category, enc&&enc.category, cp&&cp.category, bp&&bp.category) || "",
            subcategory: (enc&&enc.subcategory) || "",
            source: cp ? (enc ? "added by enrichment" : "added manually") : (bp ? "standard catalog product" : "override only"),
            is_catalog: !!bp, is_added: !!cp, has_enrichment: !!enc,
            date_added: first(cp&&cp.created_at, cp&&cp.updated_at),
            date_updated: first(ov.updated_at, ovAt, cp&&cp.updated_at),
            date_enriched: enc ? enc.updated_at : null,
            date_published: enc ? enc.published_at : null,
            enrichment_status: enc ? enc.status : null,
            partner360_visible: published,
            has_pricing: price!=null && Number(price)>0,
            price: price!=null ? Number(price) : null,
            /* Per-layer prices, because one SKU can be priced in the catalog and unpriced
               as an added record — which is exactly what the review screen shows side by
               side. A single effective number would hide the difference the person is
               being asked to judge. */
            layer_prices: {
              catalog: (bp && bp.base_price!=null && bp.base_price!=="") ? Number(bp.base_price) : null,
              added:   (cp && cp.base_price!=null && cp.base_price!=="") ? Number(cp.base_price) : null,
              override:(ov.base_price!=null && ov.base_price!=="") ? Number(ov.base_price) : null,
            },
            /* Per-layer titles, for the same reason as per-layer prices. When one SKU sits
               in both the catalog file and the added table, the two layers can carry two
               different names — and a screen that shows only the effective one cannot
               explain why the same product appears twice. */
            layer_titles: {
              catalog: (bp && bp.name) || null,
              added:   (cp && cp.name) || null,
              override:(ov.name!=null && ov.name!=="") ? String(ov.name) : null,
              approved: enc ? (enc.title||null) : null,
            },
            layers_merged_at: ov.layers_merged_at || null,
            has_orders: !!(conn && conn.orders), order_lines: (conn&&conn.orders)||0,
            images: (conn&&conn.media)||0, links: (conn&&conn.links)||0,
            featured: !!(conn&&conn.featured),
            sku_active: active,
            disposition, merged_into,
            size: enc ? enc.size : "",
            preview_url: `${ORDERING_BASE}/?product=${e(code)}&mfr=${e(mfr)}`,
            warnings,
            /* Safe to delete only when nothing at all points at this record. Anything else
               should be merged, disabled or archived — all reversible, none of which lose data. */
            safe_to_delete: !!(conn && !conn.orders && !conn.media && !conn.links && !conn.featured && !conn.has_override && !bp),
          });
        }
        /* The enriched master: the record a person actually approved. Preferred over
           whichever row happens to be newest or priced, because approval is a decision
           and the others are just storage. */
        const withEnc=out.filter(r=>r.has_enrichment);
        const master = withEnc.find(r=>r.enrichment_status==="approved" || r.enrichment_status==="published")
                    || withEnc[0] || out.find(r=>r.is_catalog) || out[0] || null;
        return json(200,{ok:true, records:out, master_code: master?master.code:null});
      }

      /* Every suspected duplicate for one manufacturer, with its evidence and the records
         connected to each side. Read-only — it never changes anything, which is the point:
         the queue exists so a person decides. */
      if(b.action==="duplicate_scan"){
        const mfr=b.manufacturer; if(!mfr) return json(400,{error:"manufacturer required"});
        const [base,custom,ovRows]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${mfr}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(mfr)}&select=code,name,category,base_price,msrp,active,image`).catch(()=>[]),
          sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(mfr)}&select=code,patch`).catch(()=>[]),
        ]);
        const overrides=Object.fromEntries((ovRows||[]).map(o=>[o.code,o.patch||{}]));
        const groups=duplicateGroups(base,custom,overrides);
        // Connections only for the codes actually in a group — a full-catalog join would be
        // hundreds of round trips for information nobody is looking at.
        const codes=[...new Set(groups.flatMap(g=>g.members.map(m=>m.code)))].slice(0,200);
        /* THIS LINE WAS THE WAIT. It used to be a sequential `for` loop calling
           connectionsFor once per code — five queries each, awaited one code at a time, for
           up to two hundred codes. A thousand round trips in single file, measured at 7 to
           12 seconds on the live site, and it ran on every page load and after every merge.
           The same answer for every code costs five queries in total. */
        const conn=await connectionsForMany(mfr,codes).catch(()=>({}));
        groups.forEach(g=>g.members.forEach(m=>{ m.connections=conn[m.code]||null; }));
        return json(200,{ok:true,groups,scanned:(base||[]).length+(custom||[]).length});
      }

      /* Merge two records into one. The winner keeps its own code; the loser is RETIRED,
         never deleted, and stamped merged_into so the decision is auditable and reversible
         and so anything still holding the old code can be pointed at the right product.

         Pricing, tiers, links, media and featured placement move to the winner — those are
         catalog facts about one SKU. Order history does NOT move: an order records what was
         actually bought under the code it was bought under, and rewriting that would falsify
         history. The count is reported instead so the person merging can see the exposure. */
      /* CONSOLIDATE THE LAYERS OF ONE SKU.
         merge_products is the wrong tool when both "duplicates" carry the SAME code: there
         is no loser to retire, because retiring it would retire the product. What actually
         happened is that a SKU already present in the deployed catalog file was published
         again into custom_products, so one product now exists in two layers with two names.

         This resolves it the way the rule says it must: the APPROVED enrichment record is
         the master, older layers are folded INTO it, and nothing newer is overwritten by
         anything older. The result is written as an override, which is the only layer that
         beats both of the others, so afterwards there is exactly one effective title, one
         price, one category — no redeploy, and both underlying layers are left intact and
         recoverable. */
      if(b.action==="merge_layers"){
        const mfr=b.manufacturer, code=String(b.code||"").trim();
        if(!mfr||!code) return json(400,{error:"manufacturer and code are required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const [base,custom,ovRows,content]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${e(mfr)}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=*`).catch(()=>[]),
          sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=patch`).catch(()=>[]),
          sb("GET",`product_content?manufacturer=eq.${e(mfr)}&select=name,skus,status,category,subcategory,image&limit=5000`).catch(()=>[]),
        ]);
        const bp=(base||[]).find(x=>String(x.code)===code)||null;
        const cp=(custom&&custom[0])||null;
        if(!bp&&!cp) return json(404,{error:`${code} not found in this catalog`});
        const ov=Object.assign({},(ovRows&&ovRows[0]&&ovRows[0].patch)||{});

        /* The approved title, read live from the enrichment record. custom_products only
           ever stored a snapshot of the page name at publish time, which is why a
           consolidated record could still show a generic family name instead of the
           specific title someone signed off. */
        let approved=null, approvedStatus=null;
        const want=code.toUpperCase();
        for(const row of (content||[])){
          const hit=(Array.isArray(row.skus)?row.skus:[]).find(sk=>
            String((sk&&(sk.sku||sk.code))||sk||"").trim().toUpperCase()===want);
          if(hit){ approved=String((hit&&hit.name)||row.name||"").trim()||null; approvedStatus=row.status||null; break; }
        }

        /* Newest wins for the title; oldest fills the gaps for everything else. An explicit
           keep.* from the review screen beats both — that is a person's decision. */
        const keep=b.keep||{};
        const first=(...v)=>{ for(const x of v){ if(x!=null&&x!=="") return x; } return null; };
        const patch=Object.assign({},ov);
        const carried=[];
        const set=(k,v)=>{ if(v!=null&&v!==""&&patch[k]!==v){ patch[k]=v; carried.push(k); } };

        const title = (keep.name!=null&&keep.name!=="") ? String(keep.name)
                    : first(approved, ov.name, cp&&cp.name, bp&&bp.name);
        set("name", title);

        ["base_price","msrp","map","tiers","price_note","image","description","category"].forEach(k=>{
          if(keep[k]!=null&&keep[k]!==""){ set(k,keep[k]); return; }
          if(ov[k]!=null&&ov[k]!=="") return;                     // already decided — leave it
          set(k, first(cp&&cp[k], bp&&bp[k]));                    // added layer first, then catalog
        });

        patch.layers_merged_at=now;
        patch.layers_merged_by=b.reviewer?String(b.reviewer).slice(0,80):null;
        patch.active=true;                                        // consolidating never hides a product
        delete patch.disposition;                                 // it is not a duplicate any more

        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code,patch,updated_at:now},
          {Prefer:"resolution=merge-duplicates,return=minimal"});

        /* Keep the added row's own name in step, so anything reading that layer directly
           shows the approved title too rather than the stale publish-time snapshot. */
        if(cp && title && cp.name!==title){
          await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,
            {name:title,updated_at:now},{Prefer:"return=minimal"}).catch(()=>{});
        }
        return json(200,{ok:true,code,title:title||null,approved_title:approved,
          enrichment_status:approvedStatus,carried,
          layers:{catalog:!!bp,added:!!cp,override:Object.keys(ov).length>0}});
      }

      /* "THIS ISN'T SOLD ANY MORE." One button, one answer, and the SKU stops appearing
         in every queue at once.

         A discontinued part needed three separate actions before this — hide it, record a
         decision about it, and then still resolve it as a duplicate — and the duplicate
         never actually cleared. What a person means by "it's gone" is one thing:
           · it comes off Partner 360, so no dealer can see or order it;
           · it stops counting as an open price, an unassigned code or a duplicate;
           · anything that points at it — orders above all — keeps working.
         So: retire the code, and delete the added row underneath it ONLY when nothing is
         attached to it. If something is attached, the row stays and stays retired, which
         is the same outcome for everyone except the order history that still needs it.
         Reversible: restore_sku brings it back. */
      if(b.action==="discontinue_sku"){
        const mfr=b.manufacturer, code=String(b.code||"").trim();
        if(!mfr||!code) return json(400,{error:"manufacturer and code are required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const reason=["discontinued","not_offered","do_not_list","archived"].includes(String(b.reason||""))
          ? String(b.reason) : "discontinued";
        const [conn,cust]=await Promise.all([
          connectionsFor(mfr,code).catch(()=>null),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=code`).catch(()=>[]),
        ]);
        const ex=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=patch`).catch(()=>[]);
        const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});
        patch.active=false;
        patch.disposition=reason;
        patch.disposition_note=b.note?String(b.note).slice(0,300):"No longer available from the manufacturer.";
        patch.disposition_at=now;
        patch.disposition_by=b.reviewer?String(b.reviewer).slice(0,80):null;
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code,patch,updated_at:now},{Prefer:"resolution=merge-duplicates,return=minimal"});
        const hadAdded=!!(cust&&cust.length);
        const held=[];
        if(conn){
          if(conn.orders)   held.push(`${conn.orders} order line${conn.orders===1?"":"s"}`);
          if(conn.links)    held.push("a More Information link");
          if(conn.media)    held.push(`${conn.media} image/document${conn.media===1?"":"s"}`);
          if(conn.featured) held.push("a Featured placement");
        }
        let removedAdded=false;
        if(hadAdded && !held.length){
          try{ await sb("DELETE",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,null,{Prefer:"return=minimal"});
               removedAdded=true; }catch(err){}
        } else if(hadAdded){
          try{ await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,
                 {active:false,updated_at:now},{Prefer:"return=minimal"}); }catch(err){}
        }
        return json(200,{ok:true,code,reason,removed_added:removedAdded,kept_because:held});
      }

      /* CONSOLIDATE MANY AT ONCE.
         merge_layers is written for one code and re-reads the whole deployed catalog file
         and the whole enrichment table every time it runs. That is fine once; run it 237
         times and it is 474 heavy reads and 237 function invocations for what is really one
         decision repeated. This does the same work with the shared data read ONCE and the
         result written as a single upsert, which is the difference between a morning of
         clicking and a few seconds.

         It only ever touches a code that exists in BOTH layers — that is what makes it one
         SKU recorded twice rather than a judgement about two products. Anything else is
         skipped and named in the reply, never guessed at. */
      if(b.action==="merge_layers_bulk"){
        const mfr=b.manufacturer;
        const codes=[...new Set((Array.isArray(b.codes)?b.codes:[]).map(c=>String(c||"").trim()).filter(Boolean))];
        if(!mfr||!codes.length) return json(400,{error:"manufacturer and codes required"});
        if(codes.length>200) return json(400,{error:"too_many", message:"Send at most 200 codes per call."});
        const e=encodeURIComponent, now=new Date().toISOString();
        const [base,customAll,ovAll,content]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${e(mfr)}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&select=*`).catch(()=>[]),
          sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`).catch(()=>[]),
          sb("GET",`product_content?manufacturer=eq.${e(mfr)}&select=name,skus,status&limit=5000`).catch(()=>[]),
        ]);
        const baseBy={}; (base||[]).forEach(x=>{ baseBy[String(x.code)]=x; });
        const custBy={}; (customAll||[]).forEach(x=>{ custBy[String(x.code)]=x; });
        const ovBy={};   (ovAll||[]).forEach(x=>{ ovBy[String(x.code)]=(x.patch||{}); });
        // The approved title for every SKU, built in one pass instead of once per code.
        const approvedBy={};
        (content||[]).forEach(row=>{ (Array.isArray(row.skus)?row.skus:[]).forEach(sk=>{
          const c=String((sk&&(sk.sku||sk.code))||sk||"").trim().toUpperCase(); if(!c||approvedBy[c]) return;
          approvedBy[c]=String((sk&&sk.name)||row.name||"").trim()||null; }); });

        const first=(...v)=>{ for(const x of v){ if(x!=null&&x!=="") return x; } return null; };
        const rows=[], merged=[], skipped=[], renames=[];
        for(const code of codes){
          const bp=baseBy[code]||null, cp=custBy[code]||null;
          if(!bp||!cp){ skipped.push({code, reason: (!bp&&!cp) ? "not in this catalog"
            : (!cp ? "only in the catalog file — nothing to consolidate"
                   : "only an added record — nothing to consolidate")}); continue; }
          const ov=Object.assign({},ovBy[code]||{});
          if(ov.layers_merged_at){ skipped.push({code, reason:"already consolidated"}); continue; }
          const patch=Object.assign({},ov);
          const set=(k,v)=>{ if(v!=null&&v!==""&&patch[k]!==v) patch[k]=v; };
          const title=first(approvedBy[code.toUpperCase()], ov.name, cp&&cp.name, bp&&bp.name);
          set("name", title);
          ["base_price","msrp","map","tiers","price_note","image","description","category"].forEach(k=>{
            if(ov[k]!=null&&ov[k]!=="") return;                   // already decided — leave it
            set(k, first(cp&&cp[k], bp&&bp[k]));
          });
          patch.layers_merged_at=now;
          patch.layers_merged_by=b.reviewer?String(b.reviewer).slice(0,80):null;
          patch.active=true;
          delete patch.disposition;
          rows.push({manufacturer:mfr,code,patch,updated_at:now});
          merged.push(code);
          if(cp && title && cp.name!==title) renames.push({code,title});
        }
        if(rows.length){
          // One upsert for the whole selection.
          await sb("POST","product_overrides?on_conflict=manufacturer,code",rows,
            {Prefer:"resolution=merge-duplicates,return=minimal"});
        }
        // Names have to go one at a time — each is a different value — but only where the
        // added layer is genuinely out of step with the approved title.
        let renamed=0;
        for(const r of renames){
          try{ await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(r.code)}`,
                 {name:r.title,updated_at:now},{Prefer:"return=minimal"}); renamed++; }catch(err){}
        }
        return json(200,{ok:true,merged:merged.length,codes:merged,skipped,renamed});
      }

      /* Undo a consolidation: the stamp is removed so the pair is reviewable again. The
         values it wrote are LEFT in place — pulling a live title or price back out from
         under Partner 360 is a bigger change than the one being undone. */
      if(b.action==="unmerge_layers"){
        const mfr=b.manufacturer, code=String(b.code||"").trim();
        if(!mfr||!code) return json(400,{error:"manufacturer and code required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const ex=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=patch`).catch(()=>[]);
        const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});
        delete patch.layers_merged_at; delete patch.layers_merged_by;
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code,patch,updated_at:now},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true,code});
      }

      /* MANY MERGES, ONE DECISION EACH.
         Choosing which of two records survives is a judgement and stays per pair — but
         once every winner is picked, running them should not mean waiting for a full
         merge round trip twenty times over. The shared reads happen once; each pair then
         costs only its own writes. Every pair is re-verified here rather than trusted from
         the screen: a winner and loser that are the same code, or a code that no longer
         exists, is skipped and named. */
      if(b.action==="merge_products_bulk"){
        const mfr=b.manufacturer;
        const pairs=(Array.isArray(b.pairs)?b.pairs:[])
          .map(p=>({winner:String((p&&p.winner)||"").trim(), loser:String((p&&p.loser)||"").trim()}))
          .filter(p=>p.winner&&p.loser);
        if(!mfr||!pairs.length) return json(400,{error:"manufacturer and pairs required"});
        if(pairs.length>25) return json(400,{error:"too_many", message:"Send at most 25 pairs per call."});
        const e=encodeURIComponent, now=new Date().toISOString();
        const [base,custom,ovAll,content]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${e(mfr)}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&select=*`).catch(()=>[]),
          sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`).catch(()=>[]),
          sb("GET",`product_content?manufacturer=eq.${e(mfr)}&select=name,skus&limit=5000`).catch(()=>[]),
        ]);
        const findB=c=>(base||[]).find(x=>String(x.code)===c);
        const findC=c=>(custom||[]).find(x=>String(x.code)===c);
        const ovOf=c=>{ const r=(ovAll||[]).find(x=>String(x.code)===c); return (r&&r.patch)||{}; };
        const approvedBy={};
        (content||[]).forEach(row=>{ (Array.isArray(row.skus)?row.skus:[]).forEach(sk=>{
          const c=String((sk&&(sk.sku||sk.code))||sk||"").trim().toUpperCase(); if(!c||approvedBy[c]) return;
          approvedBy[c]=String((sk&&sk.name)||row.name||"").trim()||null; }); });
        const first=(...v)=>{ for(const x of v){ if(x!=null&&x!=="") return x; } return null; };
        const done=[], skipped=[];
        for(const {winner:win,loser:lose} of pairs){
          if(win===lose){ skipped.push({winner:win,loser:lose,reason:"one SKU in two layers — consolidate it instead"}); continue; }
          const winB=findB(win), winC=findC(win), loseB=findB(lose), loseC=findC(lose);
          if(!winB&&!winC){ skipped.push({winner:win,loser:lose,reason:`${win} is not in this catalog`}); continue; }
          if(!loseB&&!loseC){ skipped.push({winner:win,loser:lose,reason:`${lose} is not in this catalog`}); continue; }
          const loseOv=ovOf(lose), winOv=ovOf(win);
          if(loseOv.merged_into){ skipped.push({winner:win,loser:lose,reason:`${lose} was already merged`}); continue; }
          const loseVal=k=>first(loseOv[k], loseC&&loseC[k], loseB&&loseB[k]);
          const winVal =k=>first(winOv[k],  winC&&winC[k],  winB&&winB[k]);
          const carry={};
          ["base_price","msrp","map","tiers","price_note","image","description","category"].forEach(k=>{
            if(winVal(k)==null||winVal(k)===""){ const v=loseVal(k); if(v!=null&&v!=="") carry[k]=v; }
          });
          // The approved title wins, exactly as in the single merge.
          const appr=approvedBy[String(win).toUpperCase()];
          if(appr) carry.name=appr;
          else if(winVal("name")==null||winVal("name")===""){ const v=loseVal("name"); if(v) carry.name=v; }
          try{
            if(Object.keys(carry).length){
              if(winC){ await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(win)}`,
                          Object.assign({},carry,{updated_at:now}),{Prefer:"return=minimal"}); }
              else { await sb("POST","product_overrides?on_conflict=manufacturer,code",
                       {manufacturer:mfr,code:win,patch:Object.assign({},winOv,carry),updated_at:now},
                       {Prefer:"resolution=merge-duplicates,return=minimal"}); }
            }
            // Re-point what belongs to the SKU. Order history is never moved.
            const moved={links:0,media:0,featured:0};
            for(const [tbl,key] of [["product_links","links"],["product_media","media"],["featured_products","featured"]]){
              try{
                const rows=await sb("GET",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(lose)}&select=*`).catch(()=>[]);
                if(!rows||!rows.length) continue;
                if(tbl!=="product_media"){
                  const winHas=await sb("GET",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(win)}&select=code&limit=1`).catch(()=>[]);
                  if(winHas&&winHas.length) continue;
                }
                await sb("PATCH",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(lose)}`,{code:win},{Prefer:"return=minimal"});
                moved[key]=rows.length;
              }catch(err){}
            }
            const retire=Object.assign({},loseOv,{active:false, merged_into:win, merged_at:now,
              merged_by:b.reviewer?String(b.reviewer).slice(0,80):null});
            await sb("POST","product_overrides?on_conflict=manufacturer,code",
              {manufacturer:mfr,code:lose,patch:retire,updated_at:now},
              {Prefer:"resolution=merge-duplicates,return=minimal"});
            if(loseC) await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(lose)}`,
              {active:false,updated_at:now},{Prefer:"return=minimal"}).catch(()=>{});
            done.push({winner:win,loser:lose,carried:Object.keys(carry),carried_values:carry,
              winner_is_added:!!winC,moved});
          }catch(err){ skipped.push({winner:win,loser:lose,reason:"the merge did not complete — try this pair on its own"}); }
        }
        return json(200,{ok:true,merged:done.length,done,skipped});
      }

      if(b.action==="merge_products"){
        const mfr=b.manufacturer, win=String(b.winner||"").trim(), lose=String(b.loser||"").trim();
        if(!mfr||!win||!lose) return json(400,{error:"manufacturer, winner and loser are required"});
        if(win===lose) return json(400,{error:"same_code",
          message:`${win} is one SKU stored in two layers, not two products. Consolidate it instead of merging.`});
        const e=encodeURIComponent, now=new Date().toISOString();
        const [base,custom]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${mfr}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&select=*`).catch(()=>[]),
        ]);
        const findB=c=>(base||[]).find(x=>String(x.code)===c);
        const findC=c=>(custom||[]).find(x=>String(x.code)===c);
        const winB=findB(win), winC=findC(win), loseB=findB(lose), loseC=findC(lose);
        if(!winB&&!winC) return json(404,{error:`winner ${win} not found`});
        if(!loseB&&!loseC) return json(404,{error:`loser ${lose} not found`});
        const ovAll=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`).catch(()=>[]);
        const ovOf=c=>{ const r=(ovAll||[]).find(x=>String(x.code)===c); return (r&&r.patch)||{}; };
        const loseOv=ovOf(lose), winOv=ovOf(win);
        // Effective value of a field on the losing record, across its layers.
        const first=(...v)=>{ for(const x of v){ if(x!=null&&x!=="") return x; } return null; };
        const loseVal=k=>first(loseOv[k], loseC&&loseC[k], loseB&&loseB[k]);
        const winVal =k=>first(winOv[k],  winC&&winC[k],  winB&&winB[k]);
        /* Carry a field only where the winner has nothing. A merge fills the winner's gaps
           from the record being retired; it never overwrites a value someone chose. Explicit
           `keep` entries from the review screen win over both. */
        const keep=b.keep||{};
        const carry={};
        ["base_price","msrp","map","tiers","price_note","image","description","category","name"].forEach(k=>{
          if(keep[k]!=null&&keep[k]!==""){ carry[k]=keep[k]; return; }
          if(winVal(k)==null||winVal(k)===""){ const v=loseVal(k); if(v!=null&&v!=="") carry[k]=v; }
        });
        /* THE APPROVED TITLE WINS. custom_products only ever stored a snapshot of the
           enrichment page name at publish time, so a merge that kept "whatever the winner
           already had" preserved a stale generic family name and discarded the specific
           title someone approved — which is exactly what made merged records unrecognisable.
           The enrichment record is the source of truth for the name, and it is read live.
           An explicit keep.name from the review screen still overrides it. */
        if(keep.name==null||keep.name===""){
          try{
            const pc=await sb("GET",`product_content?manufacturer=eq.${e(mfr)}&select=name,skus,status&limit=5000`).catch(()=>[]);
            const want=String(win).toUpperCase();
            for(const row of (pc||[])){
              const hit=(Array.isArray(row.skus)?row.skus:[]).find(sk=>
                String((sk&&(sk.sku||sk.code))||sk||"").trim().toUpperCase()===want);
              if(hit){
                const t=String((hit&&hit.name)||row.name||"").trim();
                if(t){ carry.name=t; break; }
              }
            }
          }catch(err){ /* no enrichment record — leave the name as it was */ }
        }
        let applied=false;
        if(Object.keys(carry).length){
          if(winC){ await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(win)}`,
                      Object.assign({},carry,{updated_at:now}),{Prefer:"return=minimal"}); }
          else { const merged=Object.assign({},winOv,carry);
                 await sb("POST","product_overrides?on_conflict=manufacturer,code",
                   {manufacturer:mfr,code:win,patch:merged,updated_at:now},
                   {Prefer:"resolution=merge-duplicates,return=minimal"}); }
          applied=true;
        }
        // Re-point what belongs to the SKU. Best-effort per table; a unique clash on the
        // winner's own row is expected and simply means the winner already has one.
        const moved={links:0,media:0,featured:0};
        for(const [tbl,key] of [["product_links","links"],["product_media","media"],["featured_products","featured"]]){
          try{
            const rows=await sb("GET",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(lose)}&select=*`).catch(()=>[]);
            if(!rows||!rows.length) continue;
            const winHas=await sb("GET",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(win)}&select=code&limit=1`).catch(()=>[]);
            if(tbl!=="product_media" && winHas && winHas.length) continue;   // one row per code; winner keeps its own
            await sb("PATCH",`${tbl}?manufacturer=eq.${e(mfr)}&code=eq.${e(lose)}`,{code:win},{Prefer:"return=minimal"});
            moved[key]=rows.length;
          }catch(err){ /* a clash leaves the loser's row where it is; nothing is destroyed */ }
        }
        const orders=await sb("GET",`order_items?code=eq.${e(lose)}&select=id&limit=500`).catch(()=>[]);
        /* Retire the loser. A custom row is deactivated (not deleted) so its history and any
           late-arriving reference still resolve; a standard catalog product is hidden with an
           override, which is the only way to retire one without a redeploy. */
        const retire=Object.assign({},loseOv,{active:false,merged_into:win,merged_at:now,
          disposition:"archived",
          merged_by:b.reviewer?String(b.reviewer).slice(0,80):null});
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code:lose,patch:retire,updated_at:now},
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        if(loseC) await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(lose)}`,
          {active:false,updated_at:now},{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true,winner:win,loser:lose,carried:Object.keys(carry),carried_values:carry,
          winner_is_added:!!winC,applied,moved,
          orders_referencing_loser:(orders||[]).length});
      }

      /* Undo a merge: the retired record comes back and the stamp is cleared. Carried values
         are left on the winner — un-carrying them would silently change a live price. */
      if(b.action==="unmerge_product"){
        const mfr=b.manufacturer, code=String(b.code||"").trim();
        if(!mfr||!code) return json(400,{error:"manufacturer and code required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const ex=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=patch`).catch(()=>[]);
        const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});
        delete patch.merged_into; delete patch.merged_at; delete patch.merged_by; patch.active=true;
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code,patch,updated_at:now},{Prefer:"resolution=merge-duplicates,return=minimal"});
        await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,
          {active:true,updated_at:now},{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true,restored:code});
      }

      /* Per-line listing mode. On a finished line the enrichment record is the catalogue,
         so a SKU no published page lists is not offered to dealers. Off by default — most
         lines have no enrichment pages at all, and gating those would empty them. */
      /* The order categories appear in on Partner 360 — one list, used by both the filter and
         the page, so the two can never drift apart. */
      /* subcategory → category for a line. Category is DERIVED from this, so filing a product
         is a single subcategory edit in enrichment rather than a second edit here. */
      /* A PINNED CATEGORY BEATS THE MAP, WHICH IS HOW ONE SUBCATEGORY ENDS UP IN TWO PLACES.
         The dealer-facing category is derived from the subcategory through category_map. But a
         `category` written onto a product's override layer wins over that map, by design — it is
         someone's explicit decision about one product. Three hundred of them written by a bulk
         pass are not that; they are a snapshot of an older structure that now silently overrules
         the map, which is why "Thumb Spicas" appears under two headings and why retired names
         like "Pneumatic Walkers" still show up.

         This removes ONLY the category key from each override. Price, MSRP, tiers, group, name,
         disposition and everything else on that layer are untouched. */
      if(b.action==="clear_derived_categories"){
        const mfr=String(b.manufacturer||"").trim();
        if(!mfr) return json(400,{error:"manufacturer required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const ovAll=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`).catch(()=>[]);
        /* `only` narrows it to the pins holding one doomed heading in place — used when a
           category is being emptied, so the rest of the pins are left exactly as they are. */
        const only=(b.only==null||b.only==="")?null:String(b.only).trim();
        const hits=(ovAll||[]).filter(r=>r.patch && r.patch.category!=null && r.patch.category!==""
          && (only===null || String(r.patch.category).trim()===only));
        if(b.preview===true)
          return json(200,{ok:true,preview:true,count:hits.length,
            sample:hits.slice(0,10).map(r=>({code:String(r.code),category:r.patch.category}))});
        if(!hits.length) return json(200,{ok:true,cleared:0});
        const rows=hits.map(r=>{ const patch=Object.assign({},r.patch); delete patch.category;
          return {manufacturer:mfr, code:String(r.code), patch, updated_at:now}; });
        // One upsert for all of them.
        for(let i=0;i<rows.length;i+=200){
          await sb("POST","product_overrides?on_conflict=manufacturer,code",rows.slice(i,i+200),
            {Prefer:"resolution=merge-duplicates,return=minimal"});
        }
        return json(200,{ok:true,cleared:rows.length});
      }

      if(b.action==="set_category_map"){
        const slug=String(b.manufacturer||"").trim();
        if(!slug) return json(400,{error:"manufacturer required"});
        const src=(b.map&&typeof b.map==="object"&&!Array.isArray(b.map))?b.map:null;
        if(!src) return json(400,{error:"map must be an object of subcategory -> category"});
        const out={}; let n=0;
        for(const k of Object.keys(src)){
          const sub=String(k||"").trim().slice(0,120);
          const cat=String(src[k]==null?"":src[k]).trim().slice(0,120);
          if(!sub||!cat) continue;
          out[sub]=cat; if(++n>=200) break;
        }
        await sb("POST","manufacturer_meta?on_conflict=slug",
          {slug, category_map:Object.keys(out).length?out:null},
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true,manufacturer:slug,pairs:Object.keys(out).length,map:out});
      }

      /* WHICH SKUs NO ENRICHMENT PAGE CLAIMS.
         Identity is declared now — a page owns a SKU because its SKU list or variant group says
         so, never because the two share a photograph. That makes an unclaimed SKU visible instead
         of silently mis-filed, and this is the queue for it. */
      /* RETIRE A SKU FROM THE LINE. The reversible half of resolving a link-audit row: the
         product stops being offered and is stamped with why, while its price, images, links and
         order history stay exactly where they are. This is the right move for almost everything
         in that queue — a SKU nobody claims is usually a SKU that should not be sold, not one
         that should be erased. delete_product remains for the genuinely empty records. */
      if(b.action==="retire_sku"){
        const mfr=b.manufacturer, code=String(b.code||"").trim();
        if(!mfr||!code) return json(400,{error:"manufacturer and code are required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const ex=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=patch`).catch(()=>[]);
        const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});
        patch.active=false;
        patch.disposition=["do_not_list","discontinued","not_offered","archived"].includes(String(b.reason||""))
          ? String(b.reason) : "not_offered";
        patch.disposition_note=b.note?String(b.note).slice(0,300):"Retired from the link audit — no enrichment record claims this SKU.";
        patch.disposition_at=now;
        patch.disposition_by=b.reviewer?String(b.reviewer).slice(0,80):null;
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code,patch,updated_at:now},{Prefer:"resolution=merge-duplicates,return=minimal"});
        await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,
          {active:false,updated_at:now},{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true,code,disposition:patch.disposition});
      }

      /* Undo the above. */
      if(b.action==="restore_sku"){
        const mfr=b.manufacturer, code=String(b.code||"").trim();
        if(!mfr||!code) return json(400,{error:"manufacturer and code are required"});
        const e=encodeURIComponent, now=new Date().toISOString();
        const ex=await sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}&select=patch`).catch(()=>[]);
        const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});
        patch.active=true; delete patch.disposition; delete patch.disposition_note;
        delete patch.disposition_at; delete patch.disposition_by;
        await sb("POST","product_overrides?on_conflict=manufacturer,code",
          {manufacturer:mfr,code,patch,updated_at:now},{Prefer:"resolution=merge-duplicates,return=minimal"});
        await sb("PATCH",`custom_products?manufacturer=eq.${e(mfr)}&code=eq.${e(code)}`,
          {active:true,updated_at:now},{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true,code});
      }

      if(b.action==="link_audit"){
        const mfr=b.manufacturer; if(!mfr) return json(400,{error:"manufacturer required"});
        const e=encodeURIComponent;
        const [base,custom,ovRows,content]=await Promise.all([
          fetchJson(`${ORDERING_BASE}/data/${e(mfr)}.json`).catch(()=>[]),
          sb("GET",`custom_products?manufacturer=eq.${e(mfr)}&select=code,name,active`).catch(()=>[]),
          sb("GET",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`).catch(()=>[]),
          sb("GET",`product_content?manufacturer=eq.${e(mfr)}&select=page_key,name,status,skus,variant_group`).catch(()=>[]),
        ]);
        const ov={}; (ovRows||[]).forEach(o=>{ ov[String(o.code)]=o.patch||{}; });
        const live=[];
        const seen=new Set();
        (base||[]).forEach(x=>{ const c=String(x.code); if((ov[c]||{}).active===false) return;
          seen.add(c); live.push({code:c,name:(ov[c]||{}).name||x.name||"",group:(ov[c]||{}).group||x.group||""}); });
        (custom||[]).forEach(x=>{ const c=String(x.code); if(seen.has(c)) return;
          if(x.active===false||(ov[c]||{}).active===false) return;
          live.push({code:c,name:(ov[c]||{}).name||x.name||"",group:(ov[c]||{}).group||""}); });

        const LIVE=["published","active"];
        const pubPages=(content||[]).filter(r=>LIVE.includes(r.status));
        const bySku={}, byGroup={};
        pubPages.forEach(r=>{
          (Array.isArray(r.skus)?r.skus:[]).forEach(sk=>{
            const c=String((sk&&(sk.sku||sk.code))||sk||"").trim().toUpperCase();
            if(c && !bySku[c]) bySku[c]=r; });
          String(r.variant_group||"").split("|").forEach(g=>{ g=g.trim(); if(g&&!byGroup[g]) byGroup[g]=r; });
        });
        const e2=encodeURIComponent;
        const [lnkRows,medRows,featRows,ordRows]=await Promise.all([
          sb("GET",`product_links?manufacturer=eq.${e2(mfr)}&select=code`).catch(()=>[]),
          sb("GET",`product_media?manufacturer=eq.${e2(mfr)}&select=code`).catch(()=>[]),
          sb("GET",`featured_products?manufacturer=eq.${e2(mfr)}&select=code,active`).catch(()=>[]),
          sb("GET",`order_items?select=code&limit=5000`).catch(()=>[]),
        ]);
        const cnt=(rows,f)=>{ const m={}; (rows||[]).forEach(r=>{ if(f&&!f(r)) return;
          const c=String(r.code||""); if(c) m[c]=(m[c]||0)+1; }); return m; };
        const nLink=cnt(lnkRows), nMed=cnt(medRows), nFeat=cnt(featRows,r=>r.active!==false), nOrd=cnt(ordRows);
        const isCustom=new Set((custom||[]).map(x=>String(x.code)));
        const unlinked=[], linked=[];
        live.forEach(p=>{
          const hit=bySku[p.code.toUpperCase()] || (p.group?byGroup[p.group]:null);
          if(hit) linked.push({code:p.code,page:hit.name||hit.page_key});
          else {
            const o=ov[p.code]||{};
            const price=(o.base_price!=null&&o.base_price!=="")?Number(o.base_price):null;
            unlinked.push({code:p.code,name:p.name,group:p.group,
              orders:nOrd[p.code]||0, media:nMed[p.code]||0, links:nLink[p.code]||0,
              featured:!!nFeat[p.code], has_override:Object.keys(o).length>0,
              price, added:isCustom.has(p.code),
              /* Safe to delete outright only when nothing at all points at it AND it is a record
                 someone added — a product from the deployed catalog file cannot be deleted, only
                 retired, because the file rebuilds it on the next deploy. */
              safe_delete: isCustom.has(p.code) && !(nOrd[p.code]||nMed[p.code]||nLink[p.code]||nFeat[p.code])});
          }
        });
        // SKUs a page lists that no live catalog product matches
        const liveSet=new Set(live.map(p=>p.code.toUpperCase()));
        const dangling=[];
        pubPages.forEach(r=>(Array.isArray(r.skus)?r.skus:[]).forEach(sk=>{
          const c=String((sk&&(sk.sku||sk.code))||sk||"").trim();
          if(c && !liveSet.has(c.toUpperCase())) dangling.push({code:c,page:r.name||r.page_key}); }));
        /* The page list rides along so the screen can suggest where each unlinked SKU probably
           belongs. A suggestion is only ever a shortcut to the right page — attaching a SKU is
           still a decision made in the enrichment tool, where that record lives. */
        const norm=t=>String(t||"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
        const pageList=pubPages.map(r=>({page_key:r.page_key,name:r.name||r.page_key,n:(Array.isArray(r.skus)?r.skus:[]).length}));
        const scored=(nm)=>{
          const w=norm(nm).split(" ").filter(x=>x.length>2);
          let best=null,bs=0;
          pageList.forEach(pg=>{ const pw=new Set(norm(pg.name).split(" "));
            let hit=0; w.forEach(x=>{ if(pw.has(x)) hit++; });
            const sc=w.length?hit/w.length:0;
            if(sc>bs){ bs=sc; best=pg; } });
          return bs>=0.5?{page:best.name,page_key:best.page_key,score:Math.round(bs*100)}:null;
        };
        unlinked.forEach(u=>{ u.suggested=scored(u.name); });
        return json(200,{ok:true, manufacturer:mfr,
          live_skus:live.length, published_pages:pubPages.length,
          linked:linked.length, unlinked, dangling, pages:pageList});
      }

      if(b.action==="set_category_order"){
        const slug=String(b.manufacturer||"").trim();
        if(!slug) return json(400,{error:"manufacturer required"});
        const list=Array.isArray(b.order)?b.order:null;
        if(!list) return json(400,{error:"order must be an array"});
        const clean=[]; const seen=new Set();
        for(const raw of list){
          const v=String(raw==null?"":raw).trim().slice(0,120);
          if(!v) continue; const k=v.toLowerCase();
          if(seen.has(k)) continue; seen.add(k); clean.push(v);
          if(clean.length>=60) break;
        }
        await sb("POST","manufacturer_meta?on_conflict=slug",
          {slug, category_order:clean.length?clean:null},
          {Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true,manufacturer:slug,order:clean});
      }

      if(b.action==="set_listing_mode"){
        const slug=String(b.manufacturer||"").trim();
        if(!slug) return json(400,{error:"manufacturer required"});
        const on=b.enriched_only===true;
        await sb("POST","manufacturer_meta?on_conflict=slug",
          {slug, enriched_only:on},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true,manufacturer:slug,enriched_only:on});
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

      /* ── THE COMPLETION BOARD ────────────────────────────────────────────────
         Every catalog SKU on a line, with a status derived from what already exists.
         Nothing is stored, so nothing can go stale and nobody has to remember to set a
         flag. This is the answer to "a product in the catalog should appear in enrichment
         with the correct status" — it appears because this reads the catalog, not because
         a second record was created for it. */
      if(b.action==="status_sweep"){
        const slug=String(b.manufacturer||"").trim();
        if(!slug) return json(400,{error:"manufacturer required"});
        const swept=await sweepManufacturer(slug);
        // The rows are large; the board only needs them when it is showing the list.
        if(b.counts_only) return json(200,{ok:true,slug,counts:swept.counts,total:swept.total,
          catalog_total:swept.catalog_total,no_catalog_row:swept.no_catalog_row,
          enriched_only:swept.enriched_only,percent_published:swept.percent_published});
        return json(200,Object.assign({ok:true,slug},swept));
      }

      /* ── THE END-TO-END FLOW TEST ────────────────────────────────────────────
         Ten steps, one manufacturer, run against real data and reported pass/fail. The
         point is not that it passes — it is that when it does not, it names the step and
         the products that broke it, so a line can be proven finished before the next one
         is started. */
      if(b.action==="flow_test"){
        const slug=String(b.manufacturer||"").trim();
        if(!slug) return json(400,{error:"manufacturer required"});
        return json(200,await flowTest(slug, Math.max(1, Math.min(50, parseInt(b.sample,10)||5))));
      }

      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};
