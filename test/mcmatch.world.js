/* The four frozen lines exactly as production holds them (test/fixtures/mc-live-frozen.json + Bemis's price list
   rows from test/fixtures/bemis-copy.json), for the Phase 6 Match correction: shared by test/mcmatch.live.test.js
   (rules and server paths) and test/mcmatch.ui.js (the real screens). In memory only. */
const path=require('path'), fs=require('fs');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const MC=require(path.join(ROOT,'_mc.js'));
const L=require('./fixtures/mc-live-frozen.json');
const fx=require('./fixtures/bemis-copy.json');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering','public','data');
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const clone=v=>JSON.parse(JSON.stringify(v));
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const PACKS=['7YA04505T','7YA05313BLK','7YA05313GRY','7YA06303TWA','7YA0AS100','7YE05310TSS','7YR05310TSS'], SINGLES=['7YE82350TC','444DISPLAY'];
/* Bemis source #5 rows in the stored price_imports shape (raw keeps "Master Case Qty" as written). Both stored
   forms are tested: parsed_case_qty left empty (read from raw, as on production) and filled at import. */
const bemisRows=parsed=>fx.source.rows.map(r=>({manufacturer:'bemis',code:r.code,description:r.description,base_price:r.base_price,msrp:r.msrp,map:r.map,tiers:null,
  raw:Object.assign({},r.raw,{'Master Case Qty':r.case_qty_text||null}),source_id:5,parsed_case_qty:parsed?MC.parseCaseQty(r.case_qty_text):null,parsed_unit_cost:r.unit_cost}));
const bemisMatch=(parsed,decisions)=>MC.matchLine({sourceRows:bemisRows(parsed),records:clone(L.bemis_records),storefrontCodes:L.bemis_records.map(r=>r.code),
  decisions:decisions||clone(L.decisions.bemis),normCode:norm,source:L.sources.bemis[0]});
/* A legacy line's records at its live counts by status (the three sample rows are real; the rest are stand-ins). */
const legacyRecords=slug=>{ const R=L.legacy_records[slug], out=R.sample.map(([code,status,uom,cq])=>({manufacturer:slug,code,status,uom,case_qty:cq,base_price:status==='active'?10:null}));
  const left=Object.assign({},R.by_status); out.forEach(r=>{ left[r.status]--; });
  Object.entries(left).forEach(([status,n])=>{ for(let i=0;i<n;i++) out.push({manufacturer:slug,code:slug.slice(0,3).toUpperCase()+'-'+status.slice(0,2)+'-'+i,status,uom:status==='active'?'Each':null,case_qty:null,base_price:status==='active'?10:null}); });
  ok(out.length===R.count,'record count '+slug); return out; };
const LEGACY=['climbing-steps','strongback-mobility','ovation-medical'];

const ROWS=[].concat(bemisRows(false)), META=Object.keys(L.fingerprints).map(slug=>({slug,record_authoritative:true,frozen:true,frozen_at:'2026-10-10T23:51:38Z',frozen_reason:'Gold Standard COMPLETE',deferrals:[],freight_terms:null}));
function world(){
  const skus=clone(L.bemis_records).map(r=>Object.assign({manufacturer:'bemis',updated_at:'2026-10-10T19:00:00Z'},r)).concat(...LEGACY.map(s=>legacyRecords(s).map(r=>Object.assign({updated_at:'2026-10-10T19:00:00Z'},r))));
  const sources=[].concat(...Object.entries(L.sources).map(([slug,a])=>a.map(s=>Object.assign({manufacturer:slug},clone(s)))));
  const W=M.createWorld({ tables:{ manufacturer_meta:clone(META), product_skus:skus, mfr_sources:sources, mfr_decisions:[].concat(...Object.values(clone(L.decisions))),
    price_imports:clone(ROWS), custom_products:[], product_overrides:[], product_content:[], product_links:[], product_media:[], product_images:[], mfr_verification_runs:[], catalog_file_commercial:[] }});
  const inner=W.fetch;
  W.fetch=async(u,o)=>{ u=String(u);
    const d=u.match(/^https:\/\/ordering\.test\/data\/([a-z0-9-]+)\.json/); if(d){ const f=path.join(SHOPD,d[1]+'.json'); if(fs.existsSync(f)){ const j=require('./p0-fullfile.js').fullFile(d[1]);   /* P0: full file, as the server restores it */ return {ok:true,status:200,json:async()=>j,text:async()=>JSON.stringify(j)}; } return {ok:false,status:404,json:async()=>null,text:async()=>''}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(u,o); };
  return W; }
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:'https://ordering.test'},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
module.exports={M,ROOT,MC,L,fx,norm,clone,PACKS,SINGLES,LEGACY,bemisRows,bemisMatch,legacyRecords,world,mod,call};
