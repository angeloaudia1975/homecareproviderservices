/* Manufacturer Center Release B — the Product Enrichment screens, clicked through in Chromium against the REAL
   catalog-api and product-content handlers running on the Release B sandbox (test/mcenrich.world.js; no window yet).
   Overview → Continue Product Enrichment (Bemis only) → approve the enrichment window (dry run first) → Products →
   Run Auto-Enrich → Review Issues → resolve one issue. Proves on the way: every product-content write carried the
   window, nothing commercial was sent, no Bemis page became visible, the commercial master did not change, and the
   screens fit a phone. Screenshots to MCUI_OUT (default ./mcui-shots). Needs Playwright; skipped without it. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const {S,M,ROOT,world,PC}=require('./mcenrich.world.js');
const E=require(path.join(ROOT,'_enrich.js')), MC=require(path.join(ROOT,'_mc.js'));
const ADMIN=path.join(__dirname,'..','src','admin');
const OUT=process.env.MCUI_OUT||path.join(process.cwd(),'mcui-shots'); fs.mkdirSync(OUT,{recursive:true});
const W=world({noWindow:true}); const P=PC(W); const C=S.mod(W);
const COMMERCIAL=['product_skus','product_overrides','custom_products','product_media','product_links'];
const snapC=()=>JSON.stringify(COMMERCIAL.map(k=>[k,(W.db[k]||[]).map(({code_norm,...x})=>x)]));
const before=snapC();
const calls=[];
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname==='/.netlify/functions/catalog-api'||u.pathname==='/.netlify/functions/product-content'){
    let body=''; for await (const ch of req) body+=ch;
    const b=body?JSON.parse(body):{}; const fn=u.pathname.split('/').pop(); calls.push(Object.assign({fn},b));
    const r=fn==='catalog-api'?await S.call(C,b):await M.call(P,b,{headers:{'x-admin-token':'cat'}});
    res.writeHead(r.status,{'content-type':'application/json'}); res.end(JSON.stringify(r.body)); return; }
  if(u.pathname.startsWith('/.netlify/functions/')){ res.writeHead(200,{'content-type':'application/json'}); res.end('{}'); return; }
  const f=path.join(ADMIN,path.basename(u.pathname));
  if(u.pathname.startsWith('/admin/')&&fs.existsSync(f)){ res.writeHead(200,{'content-type':f.endsWith('.css')?'text/css':(f.endsWith('.js')?'text/javascript':'text/html')}); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end(''); });
let page, n=0; const shots=[];
async function shot(name){ n++; const file=path.join(OUT,'enrich-'+String(n).padStart(2,'0')+'-'+name+'.png'); await page.screenshot({path:file,fullPage:true}); shots.push(file); }
async function waitToast(re){ await page.waitForFunction(r=>new RegExp(r).test(document.querySelector('#toast').textContent)&&document.querySelector('#toast').classList.contains('show'),re.source,{timeout:180000}); }
const fails=[]; const check=(c,w)=>{ if(!c){ fails.push(w); console.log('FAIL '+w); } else console.log('ok   '+w); };
(async()=>{
  await new Promise(r=>server.listen(0,r)); const base='http://127.0.0.1:'+server.address().port;
  const browser=await pw.chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{});
  page=await browser.newPage({viewport:{width:1360,height:900}});
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo'})); }catch(e){} });
  await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
  check(await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Continue Product Enrichment'}).count()===1,'overview: Bemis offers Continue Product Enrichment');
  check(await page.locator('tr',{hasText:'bemis-copy'}).locator('button',{hasText:'Continue Product Enrichment'}).count()===0,'overview: a line without the approved deferral does not (no other manufacturer starts)');
  await shot('overview');
  await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Continue Product Enrichment'}).click();
  await page.waitForSelector('text=active SKUs become'); await shot('products-window-needed');
  check(/7 product pages/.test(await page.locator('#enbody h3').first().textContent()),'Products: 9 active SKUs become 7 product pages');
  check(await page.locator('text=Left out automatically').count()===1,'Products: the retired SKU is named as left out');
  /* the window: dry run first, then approval */
  await page.locator('button',{hasText:'Review what the window allows'}).click(); await page.waitForSelector('text=Dry run — this would be recorded');
  check(!W.db.mfr_decisions.some(d=>d.kind==='enrichment_window'),'window dry run recorded nothing'); await shot('window-dry-run');
  await page.locator('button',{hasText:'Approve enrichment window'}).click(); await waitToast(/Enrichment window #\d+ opened/);
  const win=W.db.mfr_decisions.find(d=>d.kind==='enrichment_window'&&!d.used_at); check(!!win && win.manufacturer==='bemis','the window is recorded for Bemis');
  await page.waitForSelector('text=is open');
  /* Auto-Enrich */
  await page.locator('.enst',{hasText:'3 · Auto-Enrich'}).click(); await page.waitForSelector('#enrun');
  await page.locator('#enrun').click(); await waitToast(/Auto-Enrich finished/); await page.waitForTimeout(400);
  await page.locator('.enst',{hasText:'3 · Auto-Enrich'}).click(); await page.waitForSelector('text=Enrichment finished'); await shot('auto-enrich-results');
  const rows=W.db.product_content.filter(r=>r.manufacturer==='bemis');
  check(rows.length===7 && rows.every(r=>!E.isVisibleRow(r)),'7 drafts, every one hidden');
  const pcw=calls.filter(c=>c.fn==='product-content' && MC.PC_WRITE_ACTIONS.has(c.action));
  check(pcw.length>0 && pcw.every(c=>c.enrichment_window&&String(c.enrichment_window.decision_id)===String(win.id)),'every product-content write carried the window ('+pcw.length+' writes)');
  check(!calls.some(c=>c.fn==='catalog-api'&&MC.isCommercialAction(c)),'nothing commercial was sent');
  check(snapC()===before,'commercial master, catalog layer, media and links unchanged');
  /* Review Issues */
  await page.locator('.enst',{hasText:'4 · Review Issues'}).click(); await page.waitForSelector('text=Review Issues (');
  const nCards=await page.locator('.enissue').count(); check(nCards>=4,'Review Issues lists the open issues ('+nCards+' cards)');
  check(await page.locator('text=pages ready — nothing to review').count()===1,'ready pages are listed, not asked about');
  await shot('review-issues');
  const card=page.locator('.enissue',{hasText:'Where should it appear'}).first();
  await card.locator('button',{hasText:'Its own page'}).click(); await card.locator('input[id^="v_reason_"]').fill('Dealers browse displays with the other bath products');
  await shot('resolve-grouping'); await card.locator('button',{hasText:'Record this decision'}).click(); await waitToast(/Recorded/);
  await page.waitForTimeout(400);
  const d=W.db.mfr_decisions.filter(x=>x.kind==='content_resolution'); check(d.length===1 && d[0].hcps_value.choice==='own_page' && d[0].reason,'the resolution is recorded with its reason');
  check(await page.locator('.enissue',{hasText:'Where should it appear'}).count()===0,'the grouping issue closed');
  await shot('review-issues-after');
  /* phone */
  await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(300);
  const over=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  const wide=await page.evaluate(()=>[...document.querySelectorAll('#line *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1&&!e.closest('.card[style*=overflow],table,.tabscroll')).slice(0,5).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));
  const wideAll=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1&&!e.closest('#line')&&!e.closest('table')).slice(0,4).map(e=>(e.id||e.tagName)+'.'+String(e.className).slice(0,30)+' '+Math.round(e.getBoundingClientRect().right)));
  console.log('     (outside the enrichment screens, wider than the phone: '+(wideAll.join('; ')||'none')+')');
  await shot('review-issues-phone'); check(wide.length===0,'the enrichment screens fit a 390px phone (wider: '+(wide.join('; ')||'none')+'; page overflow '+over+'px)');
  check(!fails.some(f=>/page error/.test(f)),'no script errors');
  await browser.close(); server.close();
  console.log('shots: '+shots.length+' in '+OUT);
  console.log(`mc enrichment screens: ${fails.length?'FAILED ('+fails.length+')':'ALL PASS'}`); process.exit(fails.length?1:0);
})().catch(e=>{ console.log('FAIL '+(e&&e.stack||e)); try{ server.close(); }catch(_){} process.exit(1); });
