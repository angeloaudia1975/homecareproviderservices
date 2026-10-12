/* The Release B sandbox: the Phase 6 world (test/mcflow.world.js — a frozen Bemis-shaped line with its real catalog
   file) plus an open enrichment window and the manufacturer's pages from test/fixtures/mfr-pages. Shared by
   test/mcenrich.test.js and test/mcenrich.ui.js. In memory only. */
const path=require('path'), fs=require('fs');
const S=require('./mcflow.world.js');
const M=S.M, ROOT=S.ROOT;
const FX=path.join(__dirname,'fixtures','mfr-pages');
const PAGES={
  'https://www.toiletseats.com/p/4-5-inch-raised-toilet-seat-with-dual-lock-and-security-arms':'rise.html',
  'https://www.toiletseats.com/assurance':'assurance.html',
  'https://www.toiletseats.com/for-trade-professionals/shop-products/clean-shield-elongated-closed-front-plastic-raised-toilet-seat-in-white-never-loosens-and-super-grip-bumpers-2':'assurance-seat.html',
  'https://www.toiletseats.com/p/clean-shield-elongated-closed-front-plastic-raised-toilet-seat-in-white-with-support-arms-never-loosens-super-grip-bumpers-2':'assurance-seat-arms.html',
  'https://www.toiletseats.com/p/clean-shield-elongated-closed-front-plastic-raised-toilet-seat-in-white-with-personal-wash-bidet':'assurance-bidet.html',
  'https://www.toiletseats.com/bemis-assist':'assist.html',
  'https://www.toiletseats.com/p/assist-standard-height-premium-toilet-seat-support-arms':'assist-product.html',
  'https://www.toiletseats.com/p/elongated-open-front-plastic-elevated-toilet-seat-with-3-inch-lift-in-white-never-loosens':'steadfast.html'};
const bytes=(seed)=>{ const b=Buffer.alloc(/__Fill/.test(seed)?9000:4096); for(let i=0;i<b.length;i++) b[i]=(i*31+seed.length*7+seed.charCodeAt(i%seed.length))&255; return b; };
const WIN=50;
function world(opts){
  opts=opts||{};
  const W=S.world();
  ['product_content_sources','product_content_history'].forEach(k=>{ if(!W.db[k]) W.db[k]=[]; });
  if(!opts.noWindow) W.db.mfr_decisions.push({id:WIN,manufacturer:S.REAL,kind:'enrichment_window',field:'enrichment_window',reason:'Bemis product pages (Release B)',decided_by:'Angelo',decided_at:'2026-10-11T18:00:00Z',used_at:null,hcps_value:{scope:'content_drafts'}});
  W.store=[]; W.fetched=[]; W.blob={}; W.rpcs=[];
  /* Release D: the two publication functions, as supabase/mc_release_d_publication.sql defines them (the SQL itself is
     proven in Postgres by test/mc-publication.pg.test.js; this mirrors its rules on the in-memory tables). */
  const canonJ=v=>v&&typeof v==='object'?(Array.isArray(v)?'['+v.map(canonJ).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonJ(v[k])).join(',')+'}'):JSON.stringify(v===undefined?null:v);
  /* (the SQL requires https://<project>.supabase.co; the sandbox's project lives at M.BASE) */
  const LIVE_RE=slug=>new RegExp('^'+M.BASE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/storage/v1/object/public/product-content/'+slug+'/live/[^?#\\s]+$');
  const strings=v=>{ const out=[]; const w=x=>{ if(typeof x==='string') out.push(x); else if(Array.isArray(x)) x.forEach(w); else if(x&&typeof x==='object') Object.values(x).forEach(w); }; w(v); return out; };
  const rpcErr=m=>({ok:false,status:400,headers:{get:()=>'application/json'},text:async()=>JSON.stringify({code:'P0001',message:m}),json:async()=>({code:'P0001',message:m})});
  const rpcOk=j=>({ok:true,status:200,headers:{get:()=>'application/json'},text:async()=>JSON.stringify(j),json:async()=>j});
  function rpcPublish(b){ const d=W.db.mfr_decisions.find(x=>x.id===Number(b.p_decision));
    if(!d||d.kind!=='content_publication') return rpcErr('publication_refused: not a content_publication');
    if(d.used_at) return rpcErr('publication_refused: decision '+d.id+' is already spent');
    if(!d.hcps_value||d.hcps_value.plan_hash!==b.p_plan_hash) return rpcErr('publication_refused: the plan hash does not match the approved dry run');
    if(!(W.db.manufacturer_meta||[]).some(m=>m.slug===d.manufacturer&&m.frozen)) return rpcErr('publication_refused: not frozen');
    const pages=d.hcps_value.pages||[]; if(!pages.length) return rpcErr('publication_refused: the approval names no pages');
    const rows=pages.map(k=>W.db.product_content.find(r=>r.manufacturer===d.manufacturer&&r.page_key===k));
    for(let i=0;i<pages.length;i++){ const r=rows[i], k=pages[i]; if(!r) return rpcErr('publication_refused: page '+k+' no longer exists');
      if(canonJ(r)!==canonJ(d.hcps_value.before[k])) return rpcErr('publication_refused: page '+k+' changed after the dry run');
      const a=d.hcps_value.after[k]; if(!a) return rpcErr('publication_refused: no approved content for page '+k);
      const bad=strings([a.image,a.images_gallery,a.skus]).find(u=>/^\s*(https?:|\/\/|\/)/i.test(u)&&(!LIVE_RE(d.manufacturer).test(u)||/\/drafts\//.test(u)));
      if(bad) return rpcErr('publication_refused: page '+k+' would point at an image that is not a live copy: '+bad); }
    if(W.failPublishAt){ const k=W.failPublishAt; W.failPublishAt=null; return rpcErr('publication_refused: forced failure at '+k); }
    rows.forEach((r,i)=>{ const a=d.hcps_value.after[pages[i]]; Object.assign(r,{status:'published',disabled:false,draft_window:null,published_at:new Date().toISOString(),image:a.image,images_gallery:a.images_gallery,skus:a.skus,reviewed_by:String(b.p_by||'').slice(0,80)}); });
    d.used_at=new Date().toISOString(); d.used_by=String(b.p_by||'').slice(0,80);
    W.rpcs.push({fn:'publish',decision:d.id,pages}); return rpcOk({ok:true,decision:d.id,published:pages.length,pages}); }
  function rpcRollback(b){ const d=W.db.mfr_decisions.find(x=>x.id===Number(b.p_decision));
    if(!d||d.kind!=='content_publication') return rpcErr('rollback_refused: not a content_publication');
    if(!d.used_at) return rpcErr('rollback_refused: never carried out');
    if((W.db.mfr_verification_runs||[]).some(r=>r.manufacturer===d.manufacturer&&r.result==='pass'&&(r.checks||[]).some(c=>c&&c.id==='publication'&&c.detail&&Number(c.detail.decision)===d.id))) return rpcErr('rollback_refused: Gold Standard');
    (d.hcps_value.pages||[]).forEach(k=>{ const r=W.db.product_content.find(x=>x.manufacturer===d.manufacturer&&x.page_key===k), bf=d.hcps_value.before[k];
      if(r) ['status','disabled','draft_window','published_at','image','images_gallery','skus','reviewed_by'].forEach(f=>{ r[f]=bf[f]===undefined?null:JSON.parse(JSON.stringify(bf[f])); }); });
    W.rpcs.push({fn:'rollback',decision:d.id}); return rpcOk({ok:true,decision:d.id,restored:(d.hcps_value.pages||[]).length}); }
  const inner=W.fetch;
  W.fetch=async(u,o)=>{ const s=String(u), method=((o&&o.method)||'GET').toUpperCase();
    if(s.startsWith(M.BASE+'/rest/v1/rpc/mfr_content_publish')) return rpcPublish(JSON.parse(o.body||'{}'));
    if(s.startsWith(M.BASE+'/rest/v1/rpc/mfr_content_publication_rollback')) return rpcRollback(JSON.parse(o.body||'{}'));
    if(s.startsWith(M.BASE+'/storage/v1/object/product-content/')){ const pth=decodeURIComponent(s.slice((M.BASE+'/storage/v1/object/product-content/').length));
      W.store.push({path:pth,upsert:o&&o.headers&&o.headers['x-upsert'],bytes:o&&o.body?o.body.length:0,method});
      if(W.failUpload && pth.indexOf(W.failUpload)>=0) return {ok:false,status:500,headers:{get:()=>null},text:async()=>'{}',json:async()=>({})};
      if(W.blob[pth] && o&&o.headers&&o.headers['x-upsert']==='false') return {ok:false,status:400,headers:{get:()=>null},text:async()=>'{"error":"Duplicate"}',json:async()=>({error:'Duplicate'})};
      if(o&&o.body) W.blob[pth]={body:Buffer.from(o.body),type:(o.headers&&o.headers['content-type'])||'image/jpeg'};
      return {ok:true,status:200,headers:{get:()=>null},text:async()=>'{}',json:async()=>({})}; }
    if(/^https:\/\/www\.toiletseats\.com\//.test(s)){
      W.fetched.push(s);
      const key=s.split(/[?#]/)[0].replace(/\/+$/,'');
      if(/\.(jpe?g|png)$/i.test(key)){ if(opts.brokenImage && key.indexOf(opts.brokenImage)>=0) return {ok:false,status:404,headers:{get:()=>'text/html'}};
        if(opts.htmlImage && key.indexOf(opts.htmlImage)>=0) return {ok:true,status:200,url:s,headers:{get:()=>'text/html; charset=utf-8'},arrayBuffer:async()=>Buffer.from('<html>not a photo</html>'.repeat(80))};
        return {ok:true,status:200,url:s,headers:{get:k=>/content-type/i.test(k)?'image/jpeg':null},arrayBuffer:async()=>bytes(key)}; }
      if(/\.pdf$/i.test(key)) return {ok:true,status:200,headers:{get:()=>'application/pdf'},text:async()=>''};
      const f=PAGES[key]; if(!f) return {ok:false,status:404,headers:{get:()=>'text/html'},text:async()=>'not found'};
      return {ok:true,status:200,url:s,headers:{get:k=>/content-type/i.test(k)?'text/html; charset=utf-8':null},text:async()=>fs.readFileSync(path.join(FX,f),'utf8')}; }
    if(s.startsWith(M.BASE+'/storage/v1/object/public/') && method==='GET'){   // a photo already in HCPS storage (the catalog's current one)
      const k=s.split('?')[0]; const bp=decodeURIComponent(k.slice((M.BASE+'/storage/v1/object/public/product-content/').length));
      if(k.indexOf('/public/product-content/')>=0 && W.blob[bp]) return {ok:true,status:200,url:s,headers:{get:h=>/content-type/i.test(h)?W.blob[bp].type:null},arrayBuffer:async()=>W.blob[bp].body};
      if(/\/public\/product-content\/[^/]+\/live\//.test(k)) return {ok:false,status:400,url:s,headers:{get:()=>'application/json'},arrayBuffer:async()=>Buffer.from('{"error":"not_found"}')};
      return {ok:true,status:200,url:s,headers:{get:h=>/content-type/i.test(h)?'image/jpeg':null},arrayBuffer:async()=>bytes(k)}; }
    if(s.startsWith(S.OB+'/assets/products/')){
      const code=s.split('/').pop().replace(/\.[a-z]+$/i,'');
      const same=(code==='7YR05310TSS'||code==='7YE05310TSS')?'assurance-shared-photo':code;   // the two shapes share one file today
      return {ok:true,status:200,url:s,headers:{get:k=>/content-type/i.test(k)?'image/jpeg':null},arrayBuffer:async()=>bytes(same)}; }
    return inner(u,o); };
  return W;
}
const PC=W=>M.load('product-content.js',W,{CONTENT_ADMIN_TOKEN:'cat',ANALYTICS_TOKEN:'pass',ORDERING_BASE:S.OB},ROOT);   // (loading sets the world's fetch globally: one world at a time)
const call=(C,b)=>M.call(C,Object.assign({manufacturer:S.REAL},b),{headers:{'x-admin-token':'cat'}});
const withWin=b=>Object.assign({enrichment_window:{decision_id:WIN}},b);
module.exports={S,M,ROOT,FX,PAGES,WIN,world,PC,call,withWin,bytes};
