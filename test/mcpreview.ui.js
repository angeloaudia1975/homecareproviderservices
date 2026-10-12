/* Manufacturer Center Release C — the Dealer Preview screen, clicked through in Chromium against the REAL catalog-api
   and product-content handlers on the Release B sandbox (enriched: 3 Ready pages, 4 held back). Overview → Continue
   Product Enrichment → 5 · Dealer Preview → "Preview Bemis as Dealer" → summary tiles → a Ready card (Round + Elongated:
   pick each option, add to cart → the cart wording) → a held card (staff-only note) → Today → phone width. Proves on the
   way: the preview sent nothing but reads, the sandbox is byte-identical, every card image has a placeholder fallback.
   Screenshots to MCUI_OUT (default ./mcui-shots). Needs Playwright; skipped without it. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const {S,M,world,PC,call,withWin}=require('./mcenrich.world.js');
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
  const C=S.mod(W); P=PC(W);
  const before=JSON.stringify(W.db), calls=[];
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
  const shot=async name=>{ n++; await page.screenshot({path:path.join(OUT,'preview-'+String(n).padStart(2,'0')+'-'+name+'.png'),fullPage:true}); };
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  /* draft photos are not served in the sandbox: every image must fall back to the placeholder, never a broken icon */
  await page.route(/supabase|toiletseats|\.jpg|\.png/,r=>r.fulfill({status:404,body:''}));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo'})); }catch(e){} });
  try{
    await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
    await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Continue Product Enrichment'}).click();
    await page.waitForSelector('text=Review Issues (');
    check(await page.locator('text=Held back for source review (4)').count()===1,'Review Issues: 4 held back, their issues listed (not blocking)');
    await shot('issues-held');
    await page.locator('.enst',{hasText:'5 · Dealer Preview'}).click();
    await page.locator('#pvgo').click(); await page.waitForSelector('text=as a dealer would see it',{timeout:120000});
    const tiles=await page.locator('.pvtile').allTextContents();
    check(/3\s*enriched pages ready/.test(tiles[0]) && /4\s*products\/pages held back/.test(tiles[1]) && /9 \/ 9\s*active SKUs accounted for/.test(tiles[2]) && /0\s*missing/.test(tiles[3]) && /0\s*duplicates/.test(tiles[4]) && /0\s*commercial changes/.test(tiles[5]),'summary tiles: 3 ready · 4 held · 9/9 accounted · 0 missing · 0 duplicates · 0 commercial changes ('+tiles.join(' | ')+')');
    check(await page.locator('text=All checks pass').count()>=1,'all proof checks pass');
    check(await page.locator('.pvcard img').count()===0 && await page.locator('.pvcard .pvph').count()===await page.locator('.pvcard').count(),'every card shows a photo or the "No image" placeholder — never a broken image');
    await shot('preview-proposed');
    const seatCard=page.locator('.pvcard',{hasText:'Clean Shield'}); check(await seatCard.count()===1,'Round + Elongated: one card');
    await seatCard.click(); await page.waitForSelector('.pvdetail select');
    const opts=await page.locator('.pvdetail select option').allTextContents(); check(opts.length===2 && opts.some(o=>/Round/.test(o)) && opts.some(o=>/Elongated/.test(o)),'two options: '+opts.join(' / '));
    for(const want of ['Round','Elongated']){
      const v=await page.locator('.pvdetail select option',{hasText:want}).getAttribute('value'); await page.locator('.pvdetail select').selectOption(v);
      await page.locator('.pvdetail button',{hasText:'Add to cart (preview only)'}).click();
      const cart=await page.locator('.pvcart').textContent(); check(new RegExp(want).test(cart)&&/Unit \$/.test(cart)&&/nothing was added/.test(cart),want+': the cart line ('+cart.replace(/\s+/g,' ').slice(0,160)+')');
    }
    check(await page.locator('.pvdetail .pvstaff').count()===0,'an enriched page has no staff note');
    await shot('detail-round-elongated');
    await page.locator('.pvcard',{hasText:'Steadfast'}).click(); await page.waitForSelector('.pvdetail');
    check(/STAFF ONLY/.test(await page.locator('.pvdetail').textContent()) && /enrichment held for source review/.test(await page.locator('.pvdetail').textContent()),'a held product shows the staff-only note on its current catalog card');
    await shot('detail-held');
    await page.locator('.pvtog button',{hasText:'Today'}).click();
    check(await page.locator('.pvstaff').count()===0,'Today: exactly what dealers see now — no staff notes');
    await shot('preview-today');
    await page.locator('.pvtog button',{hasText:'Proposed'}).click();
    await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(300);
    const wide=await page.evaluate(()=>[...document.querySelectorAll('#line *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1&&!e.closest('table,details,.tabscroll')).slice(0,5).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));
    check(wide.length===0,'the preview fits a 390px phone (wider: '+(wide.join('; ')||'none')+')');
    await page.locator('.pvcard',{hasText:'Rise'}).click(); await page.waitForSelector('.pvdetail'); await shot('phone-detail');
    const writes=calls.filter(c=>c.fn==='product-content' && c.action!=='enrich_plan' && c.action!=='enrich_preview');
    check(!writes.length,'the screen sent nothing but reads ('+calls.map(c=>c.action).filter((v,i,a)=>a.indexOf(v)===i).join(', ')+')');
    check(JSON.stringify(W.db)===before,'the sandbox is byte-identical after the preview');
    check(!fails.some(f=>/page error/.test(f)),'no script errors');
  }catch(e){ fails.push(String(e&&e.stack||e)); console.log('FAIL '+(e&&e.stack||e)); }
  await browser.close(); server.close();
  console.log(`mc dealer preview screen: ${fails.length?'FAILED ('+fails.length+')':'ALL PASS'}`); process.exit(fails.length?1:0);
})().catch(e=>{ console.log('FAIL '+(e&&e.stack||e)); process.exit(1); });
