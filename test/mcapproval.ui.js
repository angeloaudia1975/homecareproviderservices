/* Approve Content & Images (2026-10-12) — the screen, clicked through in Chromium against the REAL catalog-api and
   product-content handlers on the Release B sandbox (enriched: 3 Ready pages, 4 held; NO selection recorded — where the
   real Bemis stands after the #531 rollback). Overview → Continue Product Enrichment → 5 · Approve Content & Images:
     · every Ready page waits for approval; nothing is pre-selected; each area shows Current dealer view vs Proposed;
       the four SKUs #531 changed show their current catalog photo next to the suggestion;
     · Assist: a suggested photo picked for the option, a gallery chosen and reordered, the description edited, the rest
       kept current with one click → Approved; every click recorded as a content_approval decision;
     · Dealer Preview: "Current Dealer View" / "Approved New Dealer View" and the note that switching selects nothing;
     · Publish dry run: Assist only (the others wait), and only the photos that were picked;
     · fits a 390px phone; no script error. Screenshots to MCUI_OUT (default ./mcui-shots). Needs Playwright. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const {S,M,world,PC,call,withWin}=require('./mcenrich.world.js');
const ADMIN=path.join(__dirname,'..','src','admin');
const OUT=process.env.MCUI_OUT||path.join(process.cwd(),'mcui-shots'); fs.mkdirSync(OUT,{recursive:true});
const fails=[]; const check=(c,w)=>{ if(!c){ fails.push(w); console.log('FAIL '+w); } else console.log('ok   '+w); };
/* the sandbox's photos are not real files: each is drawn as a labelled tile so the screenshots show which photo is where */
const tileSvg=u=>{ const name=decodeURIComponent(String(u).split('?')[0].split('/').pop()); const cur=/\/assets\/products\//.test(u);
  let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; const hue=cur?140:(h%360);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="hsl(${hue},45%,${cur?88:92}%)"/><rect x="60" y="90" width="280" height="200" rx="90" fill="hsl(${hue},35%,${cur?55:70}%)"/>
    <text x="200" y="340" font-size="22" text-anchor="middle" font-family="Arial" fill="#223">${cur?'CURRENT · ':''}${name.replace(/^\d+-\d+-/,'').slice(0,26).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text></svg>`; };
(async()=>{
  const W=world(); let P=PC(W);
  const plan0=(await call(P,{action:'enrich_plan'})).body;
  for(const p of plan0.pages){ await call(P,withWin({action:'enrich_page',page_key:p.page_key})); for(let i=0;i<10;i++){ const im=await call(P,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  const seat=plan0.pages.find(p=>p.skus.some(s=>s.code==='7YR05310TSS')).page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']]) await call(P,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'official top view'}));
  await call(P,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(P,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  const plan=(await call(P,{action:'enrich_plan'})).body;
  for(const p of plan.pages.filter(p=>p.status!=='ready')) await call(P,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold'}));
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
  const shot=async name=>{ n++; await page.screenshot({path:path.join(OUT,'approval-'+String(n).padStart(2,'0')+'-'+name+'.png'),fullPage:true}); };
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  await page.route(/supabase|toiletseats|ordering\.test|db\.test|\.jpg|\.png/,r=>r.fulfill({status:200,contentType:'image/svg+xml',body:tileSvg(r.request().url())}));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo'})); }catch(e){} });
  const recorded=()=>W.db.mfr_decisions.filter(d=>d.kind==='content_approval');
  try{
    await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
    await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Continue Product Enrichment'}).click();
    await page.waitForSelector('text=Review Issues (');
    await page.locator('.enst',{hasText:'5 · Approve Content & Images'}).click();
    await page.waitForSelector('.appages',{timeout:120000});
    check(await page.locator('.appg').count()===3,'three Ready pages to approve');
    check(await page.locator('text=Waiting for President Content Approval').count()===1,'the open page waits for the President');
    check(await page.locator('.aparea input[type=radio]:checked').count()===0,'NOTHING is pre-selected');
    check(await page.locator('text=if you make no selection, dealers keep today\'s content and photos').count()===1,'the rule is on screen: no selection = keep current');
    check(await page.locator('.apcol.cur h5',{hasText:'Current dealer'}).count()>=5,'every area shows the current dealer view next to the proposal');
    const assist=await page.locator('.apopt').first().textContent(); check(/7YA0AS100/.test(assist) && /Not chosen — keeps today's/.test(assist),'Assist option photo: not chosen, keeps today\'s');
    check((await page.locator('.apopt img').first().getAttribute('src')).endsWith('/assets/products/bemis/7YA0AS100.jpg'),'the current dealer photo shown is the original catalog photo');
    await shot('assist-waiting');
    await page.locator('.appg',{hasText:'Clean Shield'}).click();
    const opts=await page.locator('.apopt').allTextContents(); check(opts.length===2 && /7YR05310TSS/.test(opts.join()) && /7YE05310TSS/.test(opts.join()),'Assurance: one row per option (Round, Elongated)');
    check(await page.locator('.aparea').filter({has:page.locator('h4',{hasText:/^Grouping$/})}).locator('text=Not chosen').count()===1,'Assurance grouping: not chosen — stays two cards');
    const cardArea=page.locator('.aparea',{hasText:'Catalog card / default image'});
    check(await cardArea.count()===1,'Assurance (grouped): a Catalog card / default image area');
    const cardText=await cardArea.textContent();
    check(/Use Round option image/.test(cardText) && /Use Elongated option image/.test(cardText) && /Choose another approved image/.test(cardText) && /No image/.test(cardText),'card choices: Round option image · Elongated option image · another approved image · No image');
    check(await cardArea.locator('input[type=radio]:checked').count()===0 && /Not chosen — required for a grouped page/.test(cardText),'the card image is NOT pre-selected and is required');
    await shot('assurance-waiting');
    await page.locator('.appg',{hasText:'Assist'}).click();
    /* the option photo: pick a suggestion */
    await page.locator('.apopt input[type=radio]').nth(1).check();
    const sugg=page.locator('.apopt .apthumbs > div').filter({has:page.locator('.tag',{hasText:'suggested'})}).first(); await sugg.click();
    await page.locator('.apopt button',{hasText:'Save choice'}).click(); await page.waitForSelector('.apopt >> text=✓ Use this image');
    let d=recorded().slice(-1)[0]; check(d && d.hcps_value.area==='option_image' && d.hcps_value.choice==='use_image' && /\/drafts\/w\d+\//.test(d.hcps_value.url),'option photo recorded: use this image ('+(d&&d.hcps_value.url||'').split('/').pop()+')');
    const pickedOpt=d.hcps_value.url;
    /* the gallery: choose two suggestions, put the second first */
    const gal=page.locator('.aparea',{hasText:'Images — main photo'});
    await gal.locator('input[type=radio][value=custom]').check();
    const boxes=gal.locator('.dry .apthumbs').last().locator('.apimg').filter({has:page.locator('.tag',{hasText:'suggested'})});
    await boxes.nth(0).locator('input[type=checkbox]').check(); await boxes.nth(1).locator('input[type=checkbox]').check();
    await gal.locator('.dry .apthumbs').first().locator('.apimg').nth(1).locator('button',{hasText:'◀'}).click();
    await shot('assist-choosing-gallery');
    await gal.locator('button',{hasText:'Save choice'}).click(); await page.waitForSelector('.aparea:has-text("Images — main photo") >> text=✓ Choose photos');
    d=recorded().slice(-1)[0]; check(d && d.hcps_value.area==='images' && d.hcps_value.choice==='custom' && d.hcps_value.value.gallery.length===2,'gallery recorded: 2 photos in the chosen order');
    const galPicked=d.hcps_value.value.gallery.map(g=>g.url);
    /* the description: edited */
    const desc=page.locator('.aparea',{hasText:'Description'}).filter({hasNotText:'Short description'});
    await desc.locator('input[type=radio][value=edit]').check(); await desc.locator('textarea').fill('Regular-height Assist seat with built-in arms — approved wording.');
    await desc.locator('button',{hasText:'Save choice'}).click(); await page.waitForSelector('text=✓ Edit');
    d=recorded().slice(-1)[0]; check(d && d.hcps_value.area==='description' && d.hcps_value.choice==='edit' && /approved wording/.test(d.hcps_value.value.text),'description edit recorded');
    /* everything else: Keep current, explicitly */
    await page.locator('button',{hasText:'Keep current for the'}).click(); await page.waitForSelector('text=Approved — ready to publish');
    check(await page.locator('.apchip.wait').count()===0,'Assist: every area approved (Title ✓ … Option images ✓)');
    check(recorded().every(x=>x.decided_by && x.reason && x.hcps_value.basis),'every choice recorded with who, why and what was on screen');
    await shot('assist-approved');
    await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(300);
    const wide=await page.evaluate(()=>[...document.querySelectorAll('#line *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1&&!e.closest('table,details,.tabscroll,[style*=overflow]')).slice(0,5).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));
    check(wide.length===0,'the approval screen fits a 390px phone (wider: '+(wide.join('; ')||'none')+')');
    await shot('assist-approved-phone'); await page.setViewportSize({width:1360,height:900});
    /* Dealer Preview */
    await page.locator('.enst',{hasText:'6 · Dealer Preview'}).click(); await page.locator('#pvgo').click(); await page.waitForSelector('text=as a dealer would see it',{timeout:120000});
    check(await page.locator('.pvtog button',{hasText:'Current Dealer View'}).count()===1 && await page.locator('.pvtog button',{hasText:'Approved New Dealer View'}).count()===1,'the views are named Current Dealer View / Approved New Dealer View');
    check(await page.locator('text=Preview only — switching views does not select content or images.').count()===1,'the note: switching views selects nothing');
    const assistImg=await page.locator('.pvcard',{hasText:'Assist'}).locator('img').getAttribute('src');
    check(assistImg===pickedOpt,'Approved New Dealer View: Assist shows the photo picked for its option ('+String(assistImg).split('/').pop()+')');
    const riseImg=await page.locator('.pvcard',{hasText:'Rise'}).locator('img').getAttribute('src');
    check(/\/assets\/products\/bemis\/7YA04505T\.jpg$/.test(riseImg),'Rise (not decided) shows its current catalog photo');
    await shot('preview-approved-view');
    /* Publish dry run */
    await page.locator('.enst',{hasText:'7 · Publish & Verify'}).click(); await page.locator('#pubdry').click(); await page.waitForSelector('text=Publication dry run',{timeout:120000});
    check(await page.locator('text=Pages that will be published (1)').count()===1,'only Assist is published');
    check(await page.locator('text=Waiting for your content & image approval — not published (2)').count()===1,'Assurance and Rise wait for approval, on their current cards');
    const pl=calls.filter(c=>c.action==='publish_plan').length; const dry=(await call(P,{action:'publish_plan'})).body;
    const from=dry.ready.flatMap(r=>r.promote.map(x=>x.from)).sort(), allowed=new Set(galPicked.concat([pickedOpt]));
    check(from.length>0 && from.every(u=>allowed.has(u)),'only the photos the President picked are copied ('+from.map(u=>u.split('/').pop()).join(', ')+')');
    check(pl>=1,'(dry run requested by the screen)');
    await shot('publish-dry-run');
    check(!calls.some(c=>c.fn==='product-content'&&/^publish_(approve|promote|execute)$/.test(c.action)),'nothing approved or published');
    check(calls.filter(c=>c.fn==='product-content'&&!/^(enrich_plan|enrich_preview|approval_state|approval_record|publish_plan)$/.test(c.action)).length===0,'the screen wrote nothing but the President\'s selections');
    check(!fails.some(f=>/page error/.test(f)),'no script errors');
  }catch(e){ fails.push(String(e&&e.stack||e)); console.log('FAIL '+(e&&e.stack||e)); await shot('failure').catch(()=>{}); }
  await browser.close(); server.close();
  console.log(`mc content & image approval screen: ${fails.length?'FAILED ('+fails.length+')':'ALL PASS'}`); process.exit(fails.length?1:0);
})().catch(e=>{ console.log('FAIL '+(e&&e.stack||e)); process.exit(1); });
