/* Manufacturer Center Release D — the Publish & Verify screen (dry run → Approve & Publish → Finalize), derived from the Release C screen test, clicked through in Chromium against the REAL catalog-api
   and product-content handlers on the Release B sandbox (enriched: 3 Ready pages, 4 held back). Overview → Continue
   Product Enrichment → 5 · Dealer Preview → "Preview Bemis as Dealer" → summary tiles → a Ready card (Round + Elongated:
   pick each option, add to cart → the cart wording) → a held card (staff-only note) → Today → phone width. Proves on the
   way: the preview sent nothing but reads, the sandbox is byte-identical, every card image has a placeholder fallback.
   Screenshots to MCUI_OUT (default ./mcui-shots). Needs Playwright; skipped without it. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const {S,M,world,PC,call,withWin,approvePages}=require('./mcenrich.world.js');
const ADMIN=path.join(__dirname,'..','src','admin');
const OUT=process.env.MCUI_OUT||path.join(process.cwd(),'mcui-shots'); fs.mkdirSync(OUT,{recursive:true});
const fails=[]; const check=(c,w)=>{ if(!c){ fails.push(w); console.log('FAIL '+w); } else console.log('ok   '+w); };
(async()=>{
  const W=world(); let P=PC(W);
  /* the Release B end state: enrich every page, give Round / Elongated their own photos, hold the rest */
  const plan0=(await call(P,{action:'enrich_plan'})).body;
  for(const p of plan0.pages){ await call(P,withWin({action:'enrich_page',page_key:p.page_key})); for(let i=0;i<10;i++){ const im=await call(P,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  const seat=plan0.pages.find(p=>p.skus.some(s=>s.code==='7YR05310TSS')).page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']]) await call(P,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'official top view'}));
  await call(P,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(P,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  const plan=(await call(P,{action:'enrich_plan'})).body;
  for(const p of plan.pages.filter(p=>p.status!=='ready')) await call(P,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold'}));
  /* (2026-10-12) the President's content & image approval: here every proposal taken (test/mcapproval.ui.js covers the screen) */
  await approvePages(P,'proposed');
  const C=S.mod(W); P=PC(W);
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x');
    if(u.pathname==='/.netlify/functions/catalog-api'||u.pathname==='/.netlify/functions/product-content'){
      let body=''; for await (const ch of req) body+=ch; const b=body?JSON.parse(body):{}; const fn=u.pathname.split('/').pop(); calls.push(Object.assign({fn},b));
      const r=fn==='catalog-api'?await S.call(C,b):await M.call(P,b,{headers:{'x-admin-token':'cat'}});
      res.writeHead(r.status,{'content-type':'application/json'}); res.end(JSON.stringify(r.body)); return; }
    if(u.pathname.startsWith('/.netlify/functions/')){ res.writeHead(200,{'content-type':'application/json'}); res.end('{}'); return; }
    const f=path.join(ADMIN,path.basename(u.pathname));
    if(u.pathname.startsWith('/admin/')&&fs.existsSync(f)){ res.writeHead(200,{'content-type':f.endsWith('.css')?'text/css':(f.endsWith('.js')?'text/javascript':'text/html')}); res.end(fs.readFileSync(f)); return; }
    res.writeHead(404); res.end(''); });
  await new Promise(r=>server.listen(0,r)); const base='http://127.0.0.1:'+server.address().port;
  const browser=await pw.chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{});
  const page=await browser.newPage({viewport:{width:1360,height:900}}); let n=0;
  const shot=async name=>{ n++; await page.screenshot({path:path.join(OUT,'publish-'+String(n).padStart(2,'0')+'-'+name+'.png'),fullPage:true}); };
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  /* draft photos are not served in the sandbox: every image must fall back to the placeholder, never a broken icon */
  await page.route(/supabase|toiletseats|\.jpg|\.png/,r=>r.fulfill({status:404,body:''}));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo'})); }catch(e){} });
  try{
    await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
    await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Continue Product Enrichment'}).click();
    await page.waitForSelector('text=Review Issues (');
    await page.locator('.enst',{hasText:'7 · Publish & Verify'}).click();
    await page.locator('#pubdry').click(); await page.waitForSelector('text=Publication dry run',{timeout:120000});
    const tiles=await page.locator('.pvtile').allTextContents();
    check(/9 → 8/.test(tiles[0]) && /9 \/ 9/.test(tiles[1]) && /^3/.test(tiles[2].trim()) && /^4/.test(tiles[3].trim()) && /^0/.test(tiles[4].trim()) && /^0/.test(tiles[5].trim()) && /^0/.test(tiles[6].trim()),'dry run tiles: '+tiles.join(' | '));
    check(await page.locator('text=Pages that will be published (3)').count()===1 && await page.locator('text=Held — not published (4)').count()===1,'3 pages to publish, 4 held listed');
    check(await page.locator('text=Same picture, one live copy').count()>=1,'the Assurance duplicate photo is shown as one live copy');
    check(await page.locator('td code',{hasText:'bemis/live/'}).count()>0,'every photo promotion listed with its live path');
    check(!calls.some(c=>c.fn==='product-content'&&/^publish_(approve|promote|execute)$/.test(c.action)),'the dry run sent no write');
    await shot('publish-dry-run');
    await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(300);
    const wide=await page.evaluate(()=>[...document.querySelectorAll('#line *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1&&!e.closest('table,details,.tabscroll,[style*=overflow]')).slice(0,5).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));
    check(wide.length===0,'the dry run fits a 390px phone (wider: '+(wide.join('; ')||'none')+')');
    await shot('publish-dry-run-phone'); await page.setViewportSize({width:1360,height:900});
    await page.locator('#pub_reason').fill('Release D — publish the three Ready Bemis pages');
    await page.locator('button',{hasText:'Approve & Publish'}).click();
    await page.waitForSelector('text=published, final verification pending',{timeout:180000});
    check(W.db.product_content.filter(r=>r.status==='published').length===3,'3 pages published');
    check(await page.locator('text=Finalize — make this the Gold Standard').count()===1,'finalize offered after publishing');
    await shot('published-pending-finalize');
    await page.locator('button',{hasText:'Finalize — make this the Gold Standard'}).click();
    await page.waitForSelector('text=published · Gold Standard',{timeout:180000});
    check((W.db.mfr_verification_runs||[]).some(r=>r.result==='pass'&&r.phase==='post'),'Gold Standard run saved');
    check(W.db.mfr_decisions.find(d=>d.kind==='enrichment_window').used_at,'window spent');
    await shot('gold-standard');
    check(!fails.some(f=>/page error/.test(f)),'no script errors');
  }catch(e){ fails.push(String(e&&e.stack||e)); console.log('FAIL '+(e&&e.stack||e)); }
  await browser.close(); server.close();
  console.log(`mc publish & verify screen: ${fails.length?'FAILED ('+fails.length+')':'ALL PASS'}`); process.exit(fails.length?1:0);
})().catch(e=>{ console.log('FAIL '+(e&&e.stack||e)); process.exit(1); });
