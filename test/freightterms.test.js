/* Manufacturer Center Phase 5 (approved 2026-10-10): freight terms as data.
   PRECEDENCE — a line's freight rule is
     1. manufacturer_meta.freight_terms, when present AND valid (its "trace" is dropped);
     2. otherwise the line's manufacturers.json "freight" entry, exactly as before;
     3. otherwise no rule.
   The record replaces the file entry WHOLE; fields are never mixed. A missing, empty, unreadable or
   malformed record never wipes a rule — the file stands. The storefront (loadManufacturers) and the
   server (_pricing.lineProducts, which runs the storefront's own freightTermsFor) pick identically.
   Proven here for Climbing Steps, Strongback, Ovation and Bemis at every freight boundary, in the cart,
   on the server, in the stored order and in both emails. Through the real code. */
const path=require('path'), fs=require('fs'), vm=require('vm');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=process.env.SHOP_HTML||path.join(SHOPD,'public','index.html');
const MFRS=path.join(SHOPD,'public','data','manufacturers.json');
const SUBMIT=process.env.SUBMIT_JS||path.join(SHOPD,'netlify','functions','submit-order.js');
const EX=require(path.join(ROOT,'_extract.js'));
const OB='https://ordering.test';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const clone=v=>JSON.parse(JSON.stringify(v));
const html=fs.readFileSync(SHOP,'utf8');
const mfrs=JSON.parse(fs.readFileSync(MFRS,'utf8'));
const FROZEN=['climbing-steps','strongback-mobility','ovation-medical','bemis'];
const fileOf=s=>(mfrs.find(m=>m.slug===s)||{}).freight||null;
/* The record as the Phase 1 backfill wrote it: the file entry plus its trace. */
const recordOf=s=>Object.assign(clone(fileOf(s)),{trace:{decision_id:1,carried_from:'manufacturers.json 2026-10-10'}});

/* The storefront's own functions, verbatim. */
function shop(freightBySlug){
  const code=['function validFreightTerms','function freightTermsFor','function computeFreight','function freightRowsHtml'].map(a=>EX.grabDecl(html,a)).join('\n');
  const ctx={ mfrInfo:s=>({slug:s,freight:freightBySlug?freightBySlug[s]:fileOf(s)}), unitPrice:p=>Number(p.base_price),
    linesSubtotal:L=>L.reduce((n,l)=>n+Number(l.p.base_price)*l.qty,0),
    money:n=>'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}), esc:s=>String(s).replace(/&/g,'&amp;') };
  vm.createContext(ctx); vm.runInContext(code+';this.validFreightTerms=validFreightTerms;this.freightTermsFor=freightTermsFor;this.computeFreight=computeFreight;this.freightRowsHtml=freightRowsHtml;',ctx); return ctx; }
const S0=shop();
const words=h=>String(h).replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();

/* Every boundary cart per frozen line, and what dealers must see — unchanged. */
const CASES={
  'climbing-steps':[ [[{p:{base_price:0.01,brand:'x'},qty:1}],0,/FREE freight/], [[{p:{base_price:100,brand:'x'},qty:1}],0,/FREE freight/], [[{p:{base_price:5000,brand:'x'},qty:1}],0,/FREE freight/] ],
  'strongback-mobility':[
    [[{p:{base_price:20,category:'Accessories'},qty:1}],15,/\$15\.00 freight/],
    [[{p:{base_price:20,category:'Accessories'},qty:3},{p:{base_price:9,category:'Accessories'},qty:2}],15,/\$15\.00 freight/],
    [[{p:{base_price:20,category:'Accessories'},qty:1},{p:{base_price:497,category:'Wheelchairs'},qty:1}],15,/\$15\.00 freight/],
    [[{p:{base_price:497,category:'Wheelchairs'},qty:2}],0,/FREE freight/] ],
  'ovation-medical':[ [[{p:{base_price:19.95,brand:'Ovation'},qty:1}],0,/actual freight/], [[{p:{base_price:5000,brand:'Ovation'},qty:3}],0,/actual freight/] ],
  'bemis':[ [[{p:{base_price:499.99,brand:'BEMIS'},qty:1}],40,/\$40\.00 shipping & handling/], [[{p:{base_price:500,brand:'BEMIS'},qty:1}],0,/Prepaid freight/], [[{p:{base_price:500.01,brand:'BEMIS'},qty:1}],0,/Prepaid freight/] ] };

(async()=>{
await t('every manufacturers.json freight rule passes validation (each could move to the record unchanged)',async()=>{
  for(const m of mfrs) if(m.freight) ok(S0.validFreightTerms(m.freight),m.slug+' rule rejected');
});
await t('precedence: valid record terms are used WHOLE, trace dropped, no file field leaks in',async()=>{
  const file={summary:'file',groups:[{label:'F',brandKeywords:['*'],freeAt:100,flatUnder:9,freeLabel:'File words'}],elseActual:false,otherLabel:'FILE ONLY'};
  const rec={summary:'rec',groups:[{label:'R',brandKeywords:['*'],freeAt:0}],elseActual:false,trace:{decision_id:7}};
  const r=S0.freightTermsFor(file,rec);
  eq([r.source,r.invalid],['record',false]); eq(r.freight,{summary:'rec',groups:[{label:'R',brandKeywords:['*'],freeAt:0}],elseActual:false});
  ok(!('trace' in r.freight)&&!('otherLabel' in r.freight),'no trace, no file fields'); eq('trace' in rec,true,'the record itself is not mutated');
});
await t('precedence: no record → the file rule exactly; neither → no rule',async()=>{
  for(const s of FROZEN){ const r=S0.freightTermsFor(fileOf(s),null); eq([r.source,r.invalid],['file',false]); eq(r.freight,fileOf(s)); }
  eq(S0.freightTermsFor(undefined,undefined),{freight:null,source:'none',invalid:false});
  eq(S0.freightTermsFor(null,{}),{freight:null,source:'none',invalid:true},'an invalid record on a line with no file rule stays without a rule');
});
await t('missing or invalid record data never wipes a rule: every bad shape falls back to the file, flagged invalid',async()=>{
  const g=o=>({summary:'x',groups:[Object.assign({label:'All',brandKeywords:['*'],freeAt:500,flatUnder:40},o)],elseActual:false});
  const BAD={ 'empty object':{}, 'array':[], 'string':'free', 'number':0, 'true':true,
    'groups not a list':{groups:'all'}, 'no groups and not actual':{groups:[],elseActual:false}, 'groups missing':{summary:'x'},
    'group without a label':g({label:''}), 'group label not text':g({label:5}), 'group with no selector':{groups:[{label:'A',freeAt:1}]},
    'empty brand list':g({brandKeywords:[]}), 'blank brand keyword':g({brandKeywords:['']}), 'categories not a list':g({categories:'Accessories'}),
    'threshold as text':g({freeAt:'500'}), 'negative fee':g({flatUnder:-40}), 'NaN fee':g({flatFee:NaN}), 'infinite threshold':g({freeAt:Infinity}),
    'label word not text':g({freeLabel:1}), 'elseActual not boolean':{groups:[],elseActual:'yes'}, 'elseActual as text beside a valid group':Object.assign(g({}),{elseActual:'false'}), 'summary not text':{groups:[],elseActual:true,summary:3},
    'unknown mode':{mode:'by_weight',groups:[]}, 'per-item with a negative threshold':{mode:'per_item',threshold:-1}, 'group is null':{groups:[null]} };
  for(const s of FROZEN) for(const [name,bad] of Object.entries(BAD)){
    const r=S0.freightTermsFor(fileOf(s),bad);
    eq([r.source,r.invalid],['file',true],s+' / '+name); eq(r.freight,fileOf(s),s+' / '+name+' must keep the file rule');
  }
});
await t('valid shapes are accepted: free-at-0, category flat fee, actual-only (no threshold), per-item',async()=>{
  for(const ok1 of [{groups:[{label:'A',brandKeywords:['*'],freeAt:0}]},{groups:[{label:'Acc',categories:['Accessories'],flatFee:15}]},
                    {groups:[],elseActual:true,actualNote:'Confirmed by HCPS.'},{mode:'per_item',threshold:2500,summary:'s'}])
    ok(S0.validFreightTerms(ok1),JSON.stringify(ok1));
});
await t('all four frozen lines: the backfilled record gives the SAME rule, fee, rows and cart words as the file at every boundary',async()=>{
  const eff={}; for(const s of FROZEN){ const r=S0.freightTermsFor(fileOf(s),recordOf(s)); eq(r.source,'record',s); eq(r.freight,fileOf(s),s+' rule'); eff[s]=r.freight; }
  const SR=shop(eff);
  for(const s of FROZEN) for(const [lines,fee,re] of CASES[s]){
    const a=S0.computeFreight(s,clone(lines)), b=SR.computeFreight(s,clone(lines));
    eq(clone(b),clone(a),s+' rows'); eq(b.fee,fee,s+' fee'); const w=words(SR.freightRowsHtml(b));
    eq(w,words(S0.freightRowsHtml(a)),s+' words'); ok(re.test(w),s+': '+w);
  }
});
await t('special cases, exactly: Climbing Steps free on every order; Strongback $15 once with accessories, $0 models only; Ovation confirmed by HCPS with no threshold; Bemis $40 under $500, Prepaid freight at $500+',async()=>{
  const eff={}; for(const s of FROZEN) eff[s]=S0.freightTermsFor(fileOf(s),recordOf(s)).freight; const SR=shop(eff);
  eq(SR.computeFreight('climbing-steps',[{p:{base_price:0.01,brand:'x'},qty:1}]).rows.map(r=>r.status),['free']);
  const sb=SR.computeFreight('strongback-mobility',[{p:{base_price:20,category:'Accessories'},qty:4},{p:{base_price:9,category:'Accessories'},qty:1},{p:{base_price:497,category:'Wheelchairs'},qty:1}]);
  eq([sb.fee,sb.rows.filter(r=>r.status==='flat').length],[15,1],'one $15 per order');
  const ov=SR.computeFreight('ovation-medical',[{p:{base_price:5000,brand:'Ovation'},qty:1}]);
  eq([ov.fee,ov.rows.map(r=>r.status),ov.rows.some(r=>r.freeAt)],[0,['actual'],false]); ok(/confirmed by HCPS/.test(ov.actualNote),ov.actualNote);
  eq(eff['ovation-medical'].groups,[],'no invented threshold'); eq(eff['climbing-steps'].groups[0].freeAt,0);
  const bm=[499.99,500,500.01].map(v=>SR.computeFreight('bemis',[{p:{base_price:v,brand:'BEMIS'},qty:1}]));
  eq(bm.map(f=>f.fee),[40,0,0]); eq(bm.map(f=>f.rows[0].status),['flat','free','free']);
  eq([bm[0].rows[0].flatLabel,bm[1].rows[0].freeLabel],['shipping & handling','Prepaid freight']);
});

/* The storefront's loading step, verbatim: what the cart actually reads. */
async function loaded(metaRows, metaFails){
  const a=html.indexOf('\nasync function loadManufacturers(){'); ok(a>=0,'loadManufacturers not found');
  const code=html.slice(a+1, html.indexOf('\n}\n',a)+3)+'\n'+EX.grabDecl(html,'function validFreightTerms')+'\n'+EX.grabDecl(html,'function freightTermsFor');
  const warns=[];
  const ctx={ state:{}, CONFIG:{SUPABASE_URL:'https://sb.test',SUPABASE_ANON:'anon'}, console:{warn:m=>warns.push(m),log(){},error(){}}, JSON, Object, Array,
    fetch:async u=>{ u=String(u); if(u==='./data/manufacturers.json') return {ok:true,json:async()=>clone(mfrs)};
      if(u.startsWith('https://sb.test/rest/v1/manufacturer_meta')){ if(metaFails) throw new Error('offline'); ok(/select=[^&]*freight_terms/.test(u),'meta read must select freight_terms: '+u); return {ok:true,json:async()=>clone(metaRows)}; }
      throw new Error('unexpected '+u); } };
  vm.createContext(ctx); vm.runInContext(code+';this.go=loadManufacturers;',ctx); await ctx.go();
  return { by:s=>ctx.state.manufacturers.find(m=>m.slug===s), warns };
}
await t('storefront load: valid record → record rule; missing/invalid record or an unreadable table → the file rule, never empty',async()=>{
  const bemisRec=Object.assign(recordOf('bemis'),{groups:[Object.assign(clone(fileOf('bemis').groups[0]),{freeAt:600})]});
  let L=await loaded([{slug:'bemis',freight_terms:bemisRec},{slug:'climbing-steps',freight_terms:{}},{slug:'strongback-mobility',freight_terms:null}]);
  eq([L.by('bemis').freightSource,L.by('bemis').freight.groups[0].freeAt,'trace' in L.by('bemis').freight],['record',600,false],'valid record wins');
  eq([L.by('climbing-steps').freightSource,L.by('climbing-steps').freight],['file',fileOf('climbing-steps')],'invalid record → file');
  ok(L.warns.some(w=>/climbing-steps/.test(w)),'invalid record is reported in the console');
  eq([L.by('strongback-mobility').freightSource,L.by('strongback-mobility').freight],['file',fileOf('strongback-mobility')],'null → file');
  eq(L.by('ovation-medical').freight,fileOf('ovation-medical'),'no meta row → file');
  L=await loaded(null,true);
  for(const s of FROZEN) eq(L.by(s).freight,fileOf(s),s+': unreadable table must leave the file rule');
});

/* The server: orders-api prices with _pricing.lineProducts → the storefront's freightTermsFor + computeFreight. */
function world(slug, terms, products){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'live'}}],
    manufacturers:[{slug,name:slug}], manufacturer_meta:[terms===undefined?{slug}:{slug,freight_terms:terms}],
    dealers:[{id:'d1',parent_id:null,is_test:false}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}], dealer_manufacturers:require('./p0-entitle.js')('d1'),
    dealer_contract_prices:[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    custom_products:products.map(p=>Object.assign({manufacturer:slug,active:true},p)),
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[] }});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>clone(mfrs)};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(u.startsWith('https://api.resend.com')){ W.calls.push({url:u,method:'POST',body:JSON.parse(opts.body)}); return {ok:true,status:200,json:async()=>({id:'m'})}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(url,opts); };
  return W; }
const mod=W=>M.load('orders-api.js',W,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{authorization:'Bearer dealer'}});
const SRV={
  'climbing-steps':{products:[{code:'CS1',name:'Step',brand:'x',category:'Steps',base_price:100}],carts:[[['CS1',1]],[['CS1',50]]]},
  'strongback-mobility':{products:[{code:'A1',name:'Acc',category:'Accessories',base_price:20},{code:'A2',name:'Acc2',category:'Accessories',base_price:9},{code:'W1',name:'Chair',category:'Wheelchairs',base_price:497}],
    carts:[[['A1',1]],[['A1',3],['A2',2]],[['A1',1],['W1',1]],[['W1',2]]]},
  'ovation-medical':{products:[{code:'O1',name:'Brace',brand:'Ovation',category:'Braces',base_price:19.95}],carts:[[['O1',1]],[['O1',300]]]},
  'bemis':{products:[{code:'B1',name:'Seat',brand:'BEMIS',category:'Bath Safety',base_price:499.99},{code:'B2',name:'Seat',brand:'BEMIS',category:'Bath Safety',base_price:500},{code:'B3',name:'Seat',brand:'BEMIS',category:'Bath Safety',base_price:500.01}],
    carts:[[['B1',1]],[['B2',1]],[['B3',1]]]} };
const priceOf=(s,code)=>SRV[s].products.find(p=>p.code===code).base_price;
const orderOf=(s,cart)=>[{manufacturer_slug:s,manufacturer_name:s,po:'P',items:cart.map(([code,qty])=>({code,qty,unit:priceOf(s,code)}))}];
const brow=(s,cart,freight)=>shop({[s]:freight}).computeFreight(s,cart.map(([code,qty])=>({p:Object.assign({},SRV[s].products.find(p=>p.code===code)),qty})));
await t('server = browser at every boundary, with the record, with no record and with an invalid record (same fee, same rows)',async()=>{
  for(const s of FROZEN) for(const cart of SRV[s].carts){
    const want=brow(s,cart,fileOf(s));
    for(const [label,terms] of [['record',recordOf(s)],['no record',undefined],['null record',null],['invalid record',{groups:'all'}]]){
      const C=mod(world(s,terms,SRV[s].products));
      const pc=await call(C,{action:'price_check',orders:orderOf(s,cart)}); const po=((pc.body||{}).orders||[])[0]||{};
      eq([pc.status,po.freight_fee,po.estimated_total],[200,want.fee,Math.round((want.itemsTotal+want.fee)*100)/100],s+' '+JSON.stringify(cart)+' '+label+' price check');
      const r=await call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:orderOf(s,cart)}); const o=((r.body||{}).orders||[])[0]||{};
      ok(r.status===200&&Array.isArray(o.freight_lines),s+' '+label+' HTTP '+r.status+' '+JSON.stringify(r.body).slice(0,300));
      eq([o.freight_fee,clone(o.freight_lines)],[want.fee,clone(want.rows)],s+' '+JSON.stringify(cart)+' '+label+' recorded order');
    }
  }
});
await t('the server reads the record: a changed valid rule moves the server AND the cart together (proves the record is the source)',async()=>{
  const rec=Object.assign(recordOf('bemis'),{groups:[Object.assign(clone(fileOf('bemis').groups[0]),{freeAt:600})]});
  const r=await call(mod(world('bemis',rec,SRV.bemis.products)),{action:'price_check',orders:orderOf('bemis',[['B2',1]])});
  const eff=S0.freightTermsFor(fileOf('bemis'),rec).freight; const b=brow('bemis',[['B2',1]],eff);
  eq([r.body.orders[0].freight_fee,b.fee],[40,40],'$500 is under the record\'s $600 threshold on both sides');
});
await t('dealer confirmation and HCPS email words are identical with the record and with the file, on every line',async()=>{
  const SUB=require(SUBMIT);
  const run=async(s,cart,terms)=>{ const W=world(s,terms,SRV[s].products); const C=mod(W);
    const r=await call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:orderOf(s,cart)}); eq(r.status,200,JSON.stringify(r.body).slice(0,300));
    const mail=W.calls.find(x=>/resend/.test(x.url)); const o=r.body.orders[0];   // the server's recorded order, as submit-order receives it
    const freightLine=String(mail.body.text).split('\n').filter(l=>/Freight/.test(l)).join(' | ');
    const m=SUB._buildEmail({business:'B',email:'b@x.com'},{manufacturer_name:s,manufacturer_slug:s,po:'P',items:cart.map(([code,qty])=>({code,name:code,qty,unit:priceOf(s,code)})),
      items_count:1,items_subtotal:o.subtotal,estimated_total:o.estimated_total,freight_fee:o.freight_fee,freight_lines:clone(o.freight_lines||[]),freight_note:brow(s,cart,fileOf(s)).actualNote||''});
    return {dealer:freightLine, hcps:String(m.text).split('\n').filter(l=>/Freight|freight/.test(l)).join(' | '), fee:o.freight_fee}; };
  /* What each boundary cart must say — exactly today's words (dealer confirmation | HCPS email). */
  const WANT={'climbing-steps':[[/Freight: Free/,/Freight: FREE/],[/Freight: Free/,/Freight: FREE/]],
    'strongback-mobility':[[/Freight: \$15\.00/,/Freight: \$15\.00 flat/],[/Freight: \$15\.00/,/Freight: \$15\.00 flat/],[/Freight: \$15\.00/,/Freight: \$15\.00 flat/],[/Freight: Free/,/Freight: FREE/]],
    'ovation-medical':[[/^$/,/actual freight \(confirmed by manufacturer\)/],[/^$/,/actual freight \(confirmed by manufacturer\)/]],   // dealer: no freight line (amount unknown, confirmed by HCPS)
    'bemis':[[/Freight: \$40\.00 shipping & handling/,/Freight: \$40\.00 shipping & handling/],[/Freight: Prepaid freight/,/Freight: Prepaid freight/],[/Freight: Prepaid freight/,/Freight: Prepaid freight/]]};
  for(const s of FROZEN) for(let i=0;i<SRV[s].carts.length;i++){ const cart=SRV[s].carts[i];
    const a=await run(s,cart,undefined), b=await run(s,cart,recordOf(s));
    eq(b,a,s+' '+JSON.stringify(cart)); ok(WANT[s][i][0].test(b.dealer),s+' '+i+' dealer: '+b.dealer); ok(WANT[s][i][1].test(b.hcps),s+' '+i+' HCPS: '+b.hcps);
  }
});

console.log(`freight terms: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
