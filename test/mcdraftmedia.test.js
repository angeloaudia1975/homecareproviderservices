/* Manufacturer Center Release B, gate 1 — draft media through the REAL handlers (product-content, images-api)
   against the in-memory PostgREST fake. The database rule itself is proven in test/mc-draft-media.pg.test.js.
   Here: under the line's open window an upload / file / rehost is filed under product-content/<line>/drafts/
   w<window>/<page>/ and never overwrites (x-upsert false); without a window nothing changes; a rehost of
   someone else's HCPS file is copied again, not reused; a window is refused on any line but its own (frozen or
   not), across several lines, on images-api, and once closed; and the functions' copy of the rule matches. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const MC=require(path.join(ROOT,'_mc.js'));
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const NOW='2026-10-11T12:00:00Z';
function seed(){ return {
  manufacturer_meta:[{slug:'bemis',frozen:true,frozen_at:NOW},{slug:'ovation-medical',frozen:true,frozen_at:NOW},{slug:'pedifix',frozen:false}],
  product_content:[{id:'pc1',manufacturer:'ovation-medical',page_key:'gen2',name:'Gen 2',status:'published',disabled:false,skus:[{sku:'61000-210'}],images_gallery:[],image:null},
    {id:'pc2',manufacturer:'pedifix',page_key:'p1',name:'PediFix',status:'pending_review',disabled:false,skus:[{sku:'P1'}],images_gallery:[],image:null},
    {id:'pc3',manufacturer:'bemis',page_key:'assurance',name:'Assurance draft',status:'pending_review',disabled:false,skus:[{sku:'7YR05310TSS'}],images_gallery:[],image:null,draft_window:13}],
  product_content_history:[], product_content_sources:[], product_overrides:[], custom_products:[], product_media:[], product_links:[], product_images:[], product_related:[],
  product_skus:[{manufacturer:'bemis',code:'7YR05310TSS',status:'active',base_price:109.98}],
  mfr_decisions:[{id:13,manufacturer:'bemis',kind:'enrichment_window',field:'enrichment_window',reason:'Bemis product pages',decided_by:'Angelo',used_at:null},
    {id:15,manufacturer:'ovation-medical',kind:'enrichment_window',field:'enrichment_window',reason:'closed',decided_by:'Angelo',used_at:NOW}],
  staff_users:[{email:'angelo@hcps.us',role:'president',active:true}] }; }
function world(){
  const W=M.createWorld({tables:seed()}); W.tokens['pres']='angelo@hcps.us';
  const inner=W.fetch; W.stored=[];
  W.fetch=async(u,o)=>{ u=String(u);
    if(u.includes('/storage/v1/object/')){ W.stored.push({url:u, upsert:(o&&o.headers&&(o.headers['x-upsert']||o.headers['X-Upsert']))||null});
      return {ok:true,status:200,headers:{get:()=>'image/jpeg'},text:async()=>'{}',json:async()=>({}),arrayBuffer:async()=>new ArrayBuffer(4)}; }
    if(/^https:\/\/(www\.)?(toiletseats|elsewhere)\./.test(u)) return {ok:true,status:200,headers:{get:()=>'image/jpeg'},arrayBuffer:async()=>new ArrayBuffer(8),text:async()=>''};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,text:async()=>'',json:async()=>null};
    return inner(u,o); };
  return W;
}
const load=(W,f)=>M.load(f,W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const asPres=(C,b)=>M.call(C,b,{token:'pres'});
const asCat=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const WIN={enrichment_window:{decision_id:13}};
const snapDb=W=>JSON.stringify(Object.keys(W.db).sort().map(k=>[k,W.db[k]]));

(async()=>{
await t('the functions\' copy of the image rule: only a copy filed under this line\'s window folder passes',async()=>{
  const H='https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/';
  ok(MC.isDraftMediaUrl(H+'bemis/drafts/w13/assurance/1-a.jpg','bemis',13),'own folder');
  for(const u of [H+'bemis/drafts/w130/a.jpg', H+'bemis/drafts/w1/a.jpg', H+'ovation-medical/drafts/w13/a.jpg', H+'bemis/assurance/a.jpg', H+'bemis/drafts/w13/a.jpg?x=1',
                  'https://www.toiletseats.com/a.jpg', '/assets/products/bemis/a.jpg', 'https://evil.test/storage/v1/object/public/product-content/bemis/drafts/w13/a.jpg'])
    ok(!MC.isDraftMediaUrl(u,'bemis',13),'refused: '+u);
  eq(MC.draftMediaPrefix('bemis',13),'bemis/drafts/w13/');
  eq(MC.rowMediaUrls({image:'/a.jpg',images_gallery:[{url:'https://x/b.jpg'}],skus:[{sku:'S',image:'https://x/c.jpg',images:['//d']}],options:{Shape:['Round',{label:'E',image:'https://x/e.jpg'}]},description:'https://not/inspected'}),
     ['/a.jpg','https://x/b.jpg','https://x/c.jpg','//d','https://x/e.jpg']);
});
await t('under the Bemis window: an uploaded photo, a file and a rehost land in bemis/drafts/w13/<page>/ and never overwrite',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  const a=await asPres(C,Object.assign({action:'upload_image',manufacturer:'bemis',page_key:'assurance',filename:'seat.jpg',content_type:'image/jpeg',content_base64:'AAAA'},WIN));
  eq(a.status,200,JSON.stringify(a.body)); ok(/\/product-content\/bemis\/drafts\/w13\/assurance\/\d+-seat\.jpg$/.test(a.body.url),a.body.url);
  const f=await asPres(C,Object.assign({action:'upload_file',manufacturer:'bemis',page_key:'assurance',filename:'spec.pdf',content_type:'application/pdf',content_base64:'AAAA'},WIN));
  eq(f.status,200,JSON.stringify(f.body)); ok(/\/product-content\/bemis\/drafts\/w13\/assurance\/docs\//.test(f.body.url),f.body.url);
  const r=await asPres(C,Object.assign({action:'rehost',manufacturer:'bemis',page_key:'assurance',source_url:'https://www.toiletseats.com/media/assurance.jpg'},WIN));
  eq(r.status,200,JSON.stringify(r.body)); ok(/\/product-content\/bemis\/drafts\/w13\/assurance\/rehost\/\d+-assurance\.jpg$/.test(r.body.url),r.body.url);
  eq(W.stored.length,3); ok(W.stored.every(x=>x.upsert==='false'),'never overwrite under a window: '+JSON.stringify(W.stored));
});
await t('a page key with path characters stays inside the window folder',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  const a=await asPres(C,Object.assign({action:'upload_image',manufacturer:'bemis',page_key:'../../ovation-medical/gen2',filename:'x.jpg',content_type:'image/jpeg',content_base64:'AAAA'},WIN));
  eq(a.status,200,JSON.stringify(a.body)); ok(/\/product-content\/bemis\/drafts\/w13\/[A-Za-z0-9._-]+\/\d+-x\.jpg$/.test(a.body.url) && !/\/\.\.\//.test(a.body.url),a.body.url);
});
await t('a rehost of an HCPS file from another folder is copied into the window\'s folder, not reused; its own copy is reused',async()=>{
  const W=world();
  const other='https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/ovation-medical/gen2/1-a.jpg';
  const own='https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/bemis/drafts/w13/assurance/1-a.jpg';
  W.fetch=(f=>async(u,o)=>{ if(String(u).startsWith('https://abcdefghijklmnop.supabase.co/storage/v1/object/public/')) return {ok:true,status:200,headers:{get:()=>'image/jpeg'},arrayBuffer:async()=>new ArrayBuffer(8)}; return f(u,o); })(W.fetch);
  const C=load(W,'product-content.js');
  const r1=await asPres(C,Object.assign({action:'rehost',manufacturer:'bemis',page_key:'assurance',source_url:other},WIN));
  eq(r1.status,200,JSON.stringify(r1.body)); ok(!r1.body.skipped && /\/bemis\/drafts\/w13\//.test(r1.body.url),JSON.stringify(r1.body));
  const r2=await asPres(C,Object.assign({action:'rehost',manufacturer:'bemis',page_key:'assurance',source_url:own},WIN));
  eq([r2.status,r2.body.skipped,r2.body.url],[200,true,own]);
});
await t('without a window nothing changes: an unfrozen line still uploads to <line>/<page>/ as before',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  const a=await asPres(C,{action:'upload_image',manufacturer:'pedifix',page_key:'p1',filename:'x.jpg',content_type:'image/jpeg',content_base64:'AAAA'});
  eq(a.status,200); ok(/\/product-content\/pedifix\/p1\/\d+-x\.jpg$/.test(a.body.url),a.body.url); eq(W.stored[0].upsert,'true');
});
await t('the Bemis window is refused on every other line — frozen or not — and across several lines; nothing is written',async()=>{
  for(const b of [{action:'upload_image',manufacturer:'ovation-medical',page_key:'gen2',filename:'x.jpg',content_type:'image/jpeg',content_base64:'AAAA'},
                  {action:'save_fields',manufacturer:'ovation-medical',page_key:'gen2',patch:{image:'x'}},
                  {action:'upload_image',manufacturer:'pedifix',page_key:'p1',filename:'x.jpg',content_type:'image/jpeg',content_base64:'AAAA'},
                  {action:'set_meta',manufacturer:'pedifix',page_key:'p1',patch:{name:'x'}},
                  {action:'upsert',manufacturer:'bemis',rows:[{manufacturer:'bemis',page_key:'a',name:'x'},{manufacturer:'pedifix',page_key:'b',name:'y'}]}]){
    const W=world(); const C=load(W,'product-content.js'); const before=snapDb(W);
    const r=await asPres(C,Object.assign({},b,WIN));
    eq(r.status,423,b.action+' '+b.manufacturer+': '+JSON.stringify(r.body)); ok(/enrichment_window_invalid|line_frozen/.test(r.body.error),r.body.error);
    eq(snapDb(W),before); eq(W.stored.length,0); }
});
await t('a window never spans several lines, even unfrozen ones (a window left on a line that was later unfrozen)',async()=>{
  const W=world(); W.db.manufacturer_meta.push({slug:'gce',frozen:false});
  W.db.mfr_decisions.push({id:16,manufacturer:'pedifix',kind:'enrichment_window',field:'enrichment_window',reason:'left from when PediFix was frozen',decided_by:'Angelo',used_at:null});
  const C=load(W,'product-content.js'); const before=snapDb(W);
  const r=await asPres(C,{action:'upsert',manufacturer:'pedifix',rows:[{manufacturer:'pedifix',page_key:'a',name:'x'},{manufacturer:'gce',page_key:'b',name:'y'}],enrichment_window:{decision_id:16}});
  eq([r.status,r.body.error],[423,'enrichment_window_invalid'],JSON.stringify(r.body)); eq(snapDb(W),before);
});
await t('a closed window is refused; a junk window id is refused',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  W.db.mfr_decisions[0].used_at=NOW;
  const r=await asPres(C,Object.assign({action:'upload_image',manufacturer:'bemis',page_key:'assurance',filename:'x.jpg',content_type:'image/jpeg',content_base64:'AAAA'},WIN));
  eq([r.status,r.body.error],[423,'enrichment_window_invalid']); ok(/closed/.test(r.body.message),r.body.message); eq(W.stored.length,0);
  const r2=await asPres(C,{action:'upload_image',manufacturer:'pedifix',page_key:'p1',filename:'x.jpg',content_type:'image/jpeg',content_base64:'AAAA',enrichment_window:{decision_id:'x'}});
  eq([r2.status,r2.body.error],[400,'enrichment_window_incomplete']);
});
await t('publishing through the window is refused before anything is written (set_status, bulk, upsert)',async()=>{
  for(const b of [{action:'set_status',page_key:'assurance',status:'published'},{action:'set_status',page_key:'assurance',status:'active'},
                  {action:'bulk',page_keys:['assurance'],patch:{status:'discontinued'}},{action:'upsert',rows:[{manufacturer:'bemis',page_key:'assurance',status:'published'}]}]){
    const W=world(); const C=load(W,'product-content.js'); const before=snapDb(W);
    const r=await asPres(C,Object.assign({manufacturer:'bemis'},b,WIN)); eq([r.status,r.body.error],[423,'outside_enrichment_window'],JSON.stringify(r.body)); eq(snapDb(W),before); }
});
await t('images-api never takes a window (catalog-layer images): refused 423 before any file is stored',async()=>{
  for(const b of [{action:'upload',manufacturer:'bemis',code:'7YR05310TSS',filename:'a.jpg',contentType:'image/jpeg',data:'AAAA'},{action:'clear',manufacturer:'bemis',code:'7YR05310TSS'},
                  {action:'upload',manufacturer:'pedifix',code:'P1',filename:'a.jpg',contentType:'image/jpeg',data:'AAAA'}]){
    const W=world(); const C=load(W,'images-api.js'); const before=snapDb(W);
    const r=await asCat(C,Object.assign({},b,WIN)); eq([r.status,r.body.error],[423,'outside_enrichment_window'],JSON.stringify(r.body)); eq(snapDb(W),before); eq(W.stored.length,0); }
});
await t('the database\'s draft-media refusal reads as a plain 423 with its message',async()=>{
  const W=world();
  W.fetch=(f=>async(u,o)=>{ if(/product_content\?/.test(String(u)) && o && o.method==='PATCH') return {ok:false,status:400,headers:{get:()=>null},
      text:async()=>'{"code":"P0001","message":"line_frozen: bemis — under an enrichment window every image on a draft must be a copy in HCPS storage made under this window (product-content/bemis/drafts/w13/...). Refused: https://m/x.jpg"}',
      json:async()=>({code:'P0001',message:'line_frozen: bemis — under an enrichment window every image on a draft must be a copy in HCPS storage made under this window (product-content/bemis/drafts/w13/...). Refused: https://m/x.jpg'})}; return f(u,o); })(W.fetch);
  const C=load(W,'product-content.js');
  const r=await asPres(C,Object.assign({action:'save_fields',manufacturer:'bemis',page_key:'assurance',patch:{image:'https://m/x.jpg'}},WIN));
  eq([r.status,r.body.error],[423,'line_frozen'],JSON.stringify(r.body)); ok(/copy in HCPS storage/.test(r.body.message) && /Nothing was changed/.test(r.body.message),r.body.message);
});
console.log(`mc draft media (functions): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
