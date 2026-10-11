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
  'https://www.toiletseats.com/p/assist-standard-height-premium-toilet-seat-support-arms':'assist-product.html'};
const bytes=(seed)=>{ const b=Buffer.alloc(4096); for(let i=0;i<b.length;i++) b[i]=(i*31+seed.length*7+seed.charCodeAt(i%seed.length))&255; return b; };
const WIN=50;
function world(opts){
  opts=opts||{};
  const W=S.world();
  ['product_content_sources','product_content_history'].forEach(k=>{ if(!W.db[k]) W.db[k]=[]; });
  if(!opts.noWindow) W.db.mfr_decisions.push({id:WIN,manufacturer:S.REAL,kind:'enrichment_window',field:'enrichment_window',reason:'Bemis product pages (Release B)',decided_by:'Angelo',decided_at:'2026-10-11T18:00:00Z',used_at:null,hcps_value:{scope:'content_drafts'}});
  W.store=[]; W.fetched=[];
  const inner=W.fetch;
  W.fetch=async(u,o)=>{ const s=String(u), method=((o&&o.method)||'GET').toUpperCase();
    if(s.startsWith(M.BASE+'/storage/v1/object/product-content/')){ W.store.push({path:decodeURIComponent(s.slice((M.BASE+'/storage/v1/object/product-content/').length)),upsert:o&&o.headers&&o.headers['x-upsert'],bytes:o&&o.body?o.body.length:0,method});
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
      const k=s.split('?')[0]; return {ok:true,status:200,url:s,headers:{get:h=>/content-type/i.test(h)?'image/jpeg':null},arrayBuffer:async()=>bytes(k)}; }
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
