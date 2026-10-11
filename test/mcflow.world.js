/* The Manufacturer Center Phase 6 sandbox: a COPY of Bemis (bemis-copy) as a brand-new line, beside a frozen line
   shaped like the real Bemis. Shared by test/mcflow.test.js (the walkthrough through catalog-api) and
   test/mcui.walkthrough.js (the same walkthrough through the real screens). In memory only — nothing here can
   reach the live database. */
const path=require('path'), fs=require('fs');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=process.env.SHOP_HTML||path.join(SHOPD,'public','index.html');
const GATES=require('./mc-gates.js');
const fx=require('./fixtures/bemis-copy.json');
/* The fixture keeps the storefront's storage host as {{SUPABASE_URL}}: Netlify secret scanning fails the build when the
   real project URL appears in a repo file, and the scan is not widened for tests. With MC_FIXTURE_SUPABASE_URL set to the real
   project URL the walkthrough must reproduce the live Gold Standard fingerprint (fx.real.fingerprint); without it the image
   points at the mock host and the expected fingerprint is the recorded offline one — same data, only the image host differs. */
const FIXTURE_HOST=String(process.env.MC_FIXTURE_SUPABASE_URL||'').replace(/\/+$/,'');
(function fill(o){ Object.keys(o).forEach(k=>{ const v=o[k];
  if(typeof v==='string') o[k]=v.split('{{SUPABASE_URL}}').join(FIXTURE_HOST||M.BASE); else if(v&&typeof v==='object') fill(v); }); })(fx);
fx.expectedFingerprint=FIXTURE_HOST?fx.real.fingerprint:fx.real.fingerprint_offline;
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const clone=v=>JSON.parse(JSON.stringify(v));
const html=fs.readFileSync(SHOP,'utf8');
const bemisFile=JSON.parse(fs.readFileSync(path.join(SHOPD,'public','data','bemis.json'),'utf8'));
const OB='https://ordering.test', COPY='bemis-copy', REAL='bemis';
const MFRS=JSON.parse(fs.readFileSync(path.join(SHOPD,'public','data','manufacturers.json'),'utf8'))
  .concat([{slug:COPY,name:'Bemis (walkthrough copy)',hasData:true}]);           // a new line: no freight in the file — it will come from the record
const PACKS=fx.source.rows.filter(r=>/\d+\s*\/\s*CS/i.test(String(r.case_qty_text||''))).map(r=>r.code);
const realRecords=()=>fx.source.rows.map(r=>{ const n=(String(r.case_qty_text||'').match(/(\d+)/)||[])[1];
  const pack=n&&Number(n)>1, unit=r.code==='444DISPLAY'?'Display':(pack?'Case':'Each');
  return {manufacturer:REAL,code:r.code,status:'active',base_price:r.base_price,msrp:r.msrp,map:r.map,msrp_auto:false,uom:unit,case_qty:pack?Number(n):1,
    dealer_unit_cost:r.unit_cost,msrp_basis:pack?'each':null,map_basis:pack?'each':null,source_id:5,source_file:fx.source.file_name,updated_at:'2026-10-10T19:00:00Z'}; })
  .concat([{manufacturer:REAL,code:'DO5300RD444',status:'discontinued',updated_at:'2026-10-10T19:00:00Z'}]);
const layers=slug=>({ custom:fx.custom.map(c=>Object.assign({manufacturer:slug},clone(c))),
  overrides:Object.entries(fx.overrides).map(([code,patch])=>({manufacturer:slug,code,patch:clone(patch)})) });
function world(){
  const Lc=layers(COPY), Lr=layers(REAL);
  const W=M.createWorld({ serialIds:GATES.SERIAL, tables:{
    manufacturer_meta:[{slug:COPY,record_authoritative:false,frozen:false,deferrals:[],freight_terms:null},
      {slug:REAL,record_authoritative:true,frozen:true,frozen_at:'2026-10-10T20:13:00Z',frozen_reason:'Gold Standard COMPLETE (2026-10-10)',deferrals:[{item:'enrichment_pages',note:'approved deferral'}],
       freight_terms:Object.assign(clone(fx.freight),{trace:{source_id:6,decision_id:9}})}],
    product_skus:realRecords(), custom_products:Lc.custom.concat(Lr.custom), product_overrides:Lc.overrides.concat(Lr.overrides),
    product_content:[], product_links:[], product_media:[], product_images:[],
    mfr_sources:[{id:5,manufacturer:REAL,kind:'price_list',title:fx.source.title,file_name:fx.source.file_name,status:'accepted',received_date:'2026-10-10',legacy:false,effective_date_status:'pending',manufacturer_effective_date:null},
                 {id:6,manufacturer:REAL,kind:'terms',title:'Bemis Terms of Agreement (dealer application)',status:'accepted',received_date:null,legacy:true,effective_date_status:'stated',manufacturer_effective_date:'2022-03-01'}],
    mfr_decisions:[{id:9,manufacturer:REAL,kind:'freight_terms',field:'freight',reason:'Bemis terms',decided_by:'president',decided_at:'2026-10-10T19:35:00Z',used_at:null}],
    mfr_verification_runs:[], price_imports:[], dealer_contract_prices:[], dealer_carts:[], dealers:[] }});
  W.stored=[];
  const inner=W.fetch;
  W.fetch=async(u,opts)=>{ u=String(u);
    if(u===OB+'/index.html') return {ok:true,status:200,text:async()=>html};
    if(u===OB+'/data/'+COPY+'.json') return {ok:true,status:200,json:async()=>clone(bemisFile).map(p=>Object.assign(p,p.manufacturer?{manufacturer:COPY}:{}))};
    if(u===OB+'/data/'+REAL+'.json') return {ok:true,status:200,json:async()=>clone(bemisFile)};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>clone(MFRS)};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(/\.(jpe?g|png|webp)(\?|$)/i.test(u)) return {ok:true,status:200,headers:{get:k=>k==='content-type'?'image/jpeg':null}};
    if(u.startsWith(M.BASE+'/storage/v1/object/mfr-sources/')){ W.stored.push({path:decodeURIComponent(u.slice((M.BASE+'/storage/v1/object/mfr-sources/').length)),bytes:opts&&opts.body?opts.body.length:0,upsert:opts&&opts.headers&&opts.headers['x-upsert']}); return {ok:true,status:200,json:async()=>({Key:'ok'})}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); const r=await inner(u,opts); (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return r; };
  return W; }
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
module.exports={M,ROOT,fx,OB,COPY,REAL,PACKS,world,mod,call,clone,norm};
