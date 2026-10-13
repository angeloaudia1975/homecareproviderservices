/* The screens for Angelo's 2026-10-12 fixes, clicked through in Chromium against the REAL catalog-api and product-content
   handlers on the Release B sandbox:
     · Approve Content & Images: a saved President edit stays visible next to Current and Auto-Enrich Proposed, with the
       choice publication would use; Edit starts from the saved edit; choosing Use proposed over it shows the warning
       ("You already have a President-edited version for this section. Choosing Use Proposed will replace that selection
       for publication. Continue?") and records nothing until confirmed; Cancel records nothing; after confirming, the
       edited text is still shown (kept, not active);
     · the overview, the line header and History show the newest finalized Gold Standard PASS as the status, with a later
       failed run as history underneath;
     · Decisions → Correct a published page: the correction dry run (live now → after, plan number, 9/9, 0 missing),
       Approve → Carry out → Finalize, through the screen;
     · fits a 390px phone; no script error. Screenshots to MCUI_OUT (default ./mcui-shots). Needs Playwright. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const {S,M,world,PC,call,withWin,approvePages}=require('./mcenrich.world.js');
const ADMIN=path.join(__dirname,'..','src','admin');
const OUT=process.env.MCUI_OUT||path.join(process.cwd(),'mcui-shots'); fs.mkdirSync(OUT,{recursive:true});
const fails=[]; const check=(c,w)=>{ if(!c){ fails.push(w); console.log('FAIL '+w); } else console.log('ok   '+w); };
const WARN='You already have a President-edited version for this section. Choosing Use Proposed will replace that selection for publication. Continue?';
const EDIT_DESC='Raised toilet seat is elevated 3" to make sitting and standing easier. Wide, comfortable ring designed to eliminate pressure points.';
(async()=>{
  const W=world(); let P=PC(W);
  const plan0=(await call(P,{action:'enrich_plan'})).body;
  for(const p of plan0.pages){ await call(P,withWin({action:'enrich_page',page_key:p.page_key})); for(let i=0;i<10;i++){ const im=await call(P,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  const seat=plan0.pages.find(p=>p.skus.some(s=>s.code==='7YR05310TSS')).page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']]) await call(P,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'x'}));
  await call(P,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(P,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  const plan=(await call(P,{action:'enrich_plan'})).body;
  for(const p of plan.pages.filter(p=>p.status!=='ready')) await call(P,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold'}));
  /* the President's saved edits on Assurance (description, specs) */
  await call(P,{action:'approval_record',selections:[{page_key:seat,area:'description',choice:'edit',value:{text:EDIT_DESC}},{page_key:seat,area:'specs',choice:'edit',value:{items:[{label:'Material',value:'Plastic'}]}}]});
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
  const shot=async name=>{ n++; await page.screenshot({path:path.join(OUT,'correction-'+String(n).padStart(2,'0')+'-'+name+'.png'),fullPage:true}); };
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  await page.route(/supabase|toiletseats|ordering\.test|db\.test|\.jpg|\.png/,r=>r.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#cde"/></svg>'}));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo'})); }catch(e){} });
  const approvals=()=>W.db.mfr_decisions.filter(d=>d.kind==='content_approval');
  try{
    /* ── 1. the approval screen ── */
    await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
    await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Continue Product Enrichment'}).click();
    await page.waitForSelector('text=Review Issues (');
    await page.locator('.enst',{hasText:'5 · Approve Content & Images'}).click();
    await page.waitForSelector('.appages',{timeout:120000});
    await page.locator('.appg',{hasText:'Clean Shield'}).click();
    const desc=page.locator('.aparea').filter({has:page.locator('h4',{hasText:/^Description$/})});
    let t=await desc.textContent();
    check(await desc.locator('.apcol h5',{hasText:'Current dealer view'}).count()===1 && await desc.locator('.apcol h5',{hasText:'Proposed by Auto-Enrich'}).count()===1 && await desc.locator('.apcol h5',{hasText:'President edited'}).count()===1,'Description: Current · Auto-Enrich Proposed · President edited, side by side');
    check(/Selected for publication: President edited version \(#\d+\)/.test(t),'which one publication would use: the President edited version');
    check((await desc.locator('.apcol.ed').textContent()).includes('Wide, comfortable ring designed to eliminate pressure points.'),'the edited text is on screen');
    check(await desc.locator('textarea').inputValue()===EDIT_DESC,'Edit is selected and starts from the saved edit');
    await shot('three-columns');
    const n0=approvals().length;
    await desc.locator('input[type=radio][value=use_proposed]').check();
    t=await desc.textContent();
    check(t.replace(/\s+/g,' ').includes(WARN),'choosing Use proposed over a saved edit shows the warning, word for word');
    check(await desc.locator('button',{hasText:'Save choice'}).isDisabled(),'Save choice is disabled until confirmed');
    check(approvals().length===n0,'nothing recorded by choosing');
    await shot('warning'); await desc.screenshot({path:path.join(OUT,'correction-el-warning.png')});
    await desc.locator('.apwarn button',{hasText:'Cancel'}).click();
    check(await desc.locator('.apwarn').count()===0 && approvals().length===n0,'Cancel: no warning, nothing recorded');
    check(/Selected for publication: President edited version/.test(await desc.textContent()),'still the edited version for publication');
    await desc.locator('input[type=radio][value=use_proposed]').check();
    await desc.locator('.apwarn button',{hasText:'Continue'}).click();
    await page.waitForSelector('.aparea:has(h4:text-is("Description")) >> text=Selected for publication: Auto-Enrich proposed');
    const last=approvals().slice(-1)[0]; check(approvals().length===n0+1 && last.hcps_value.area==='description' && last.hcps_value.choice==='use_proposed','after explicit confirmation: Use proposed recorded (#'+last.id+')');
    const ed=page.locator('.aparea').filter({has:page.locator('h4',{hasText:/^Description$/})}).locator('.apcol.ed');
    check(await ed.count()===1 && (await ed.textContent()).includes('kept, not the active choice') && (await ed.textContent()).includes('eliminate pressure points.'),'the edited text is still shown — kept, not active');
    await page.locator('.aparea').filter({has:page.locator('h4',{hasText:/^Description$/})}).locator('input[type=radio][value=edit]').check();
    check(await page.locator('.aparea').filter({has:page.locator('h4',{hasText:/^Description$/})}).locator('textarea').inputValue()===EDIT_DESC,'choosing Edit again starts from the saved edit');
    await shot('after-confirm');
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(300);
    const wide=await page.evaluate(()=>[...document.querySelectorAll('#line *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1&&!e.closest('table,details,.tabscroll,[style*=overflow]')).slice(0,5).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));
    check(wide.length===0,'the approval screen (three columns, warning) fits a 390px phone (wider: '+(wide.join('; ')||'none')+')');
    await shot('phone');
    await page.setViewportSize({width:1360,height:900});

    /* ── 2. publish + finalize (the real handlers), then a later failed attempt ── */
    await approvePages(P,'proposed');
    const d=(await call(P,{action:'publish_plan'})).body; const a=(await call(P,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
    for(let i=0;i<20;i++){ const r=await call(P,{action:'publish_promote',decision_id:a}); if(!r.body.remaining) break; }
    const x=await call(P,{action:'publish_execute',decision_id:a}); check(x.status===200,'(setup) published');
    const f=await S.call(C,{action:'mc_publish_finalize',manufacturer:S.REAL,decision_id:a}); check(f.status===200,'(setup) finalized as the Gold Standard');
    W.db.mfr_verification_runs.forEach((r,i)=>{ if(!r.run_at) r.run_at=new Date(Date.UTC(2026,9,13,3,0,0)+i*1000).toISOString(); });
    W.db.mfr_verification_runs.push({id:9999,manufacturer:S.REAL,phase:'release',result:'fail',checks:[],fingerprint:null,run_at:'2026-10-14T01:00:00Z',run_by:'test'});
    await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
    const row=page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'});
    const rt=await row.textContent();
    check(/Gold Standard · pass/.test(rt) && !/\bfail\b/i.test(rt.replace(/later attempt[s]? failed/,'')),'overview: Gold Standard · pass is the status (not the later fail)');
    check(/History: 1 later attempt failed and was rolled back — Gold Standard unchanged/.test(rt),'overview: the later failed run is history underneath');
    await shot('overview-gold-standard'); await row.screenshot({path:path.join(OUT,'correction-el-overview-row.png')});
    await row.locator('button',{hasText:'Open'}).click(); await page.waitForSelector('.gsban');
    check(/Current Gold Standard: PASS/.test(await page.locator('.gsban').first().textContent()),'line header: Current Gold Standard: PASS');
    await page.locator('.tabs.wf button',{hasText:'History'}).click(); await page.waitForSelector('tr.gsrow');
    check(await page.locator('tr.gsrow',{hasText:'Current Gold Standard'}).count()===1,'History: the Gold Standard run is marked');
    check(await page.locator('tr',{hasText:'9999'}).locator('text=history').count()===1,'History: the later failed run is labelled history');
    await shot('history'); await page.locator('.gsban').first().screenshot({path:path.join(OUT,'correction-el-banner.png')});

    /* ── 3. the correction, through the screen ── */
    const rf=(await S.call(C,{action:'mc_record_decision',manufacturer:S.REAL,kind:'regression_fix',field:'page:'+seat,reason:'Restore the President-approved Assurance text',hcps_value:{scope:'content_correction',page_key:seat,areas:['description','specs'],page_name:'Assurance'}})).body.decision.id;
    const eds=approvals().filter(x=>x.field==='page:'+seat&&x.hcps_value.choice==='edit');
    await call(P,{action:'correction_record',regression_fix_id:rf,corrections:['description','specs'].map(ar=>({area:ar,from_decision:eds.find(e=>e.hcps_value.area===ar).id}))});
    await page.goto(base+'/admin/manufacturer-center.html#line=bemis&tab=decisions'); await page.reload(); await page.waitForSelector('.corrcard');
    await page.locator('.corrcard button',{hasText:'Open correction'}).click(); await page.waitForSelector('.corrcard >> text=ready to approve',{timeout:120000});
    const ct=await page.locator('.corrcard').textContent();
    check(/SKUs 9\/9/.test(ct) && /missing 0/.test(ct) && /duplicates 0/.test(ct) && /commercial changes 0/.test(ct),'correction dry run: 9/9 SKUs, 0 missing, 0 duplicates, 0 commercial changes');
    check(/Live now/.test(ct) && /After the correction/.test(ct) && ct.includes('eliminate pressure points.'),'live now → after the correction, with the President\'s text');
    check(/identical/.test(ct),'photos, card image, title, documents: identical');
    await shot('correction-dry-run'); await page.locator('.corrcard').screenshot({path:path.join(OUT,'correction-el-dry-run.png')});
    await page.locator('#corr_reason').fill('Restore the President-approved Assurance text');
    await page.locator('.corrcard button',{hasText:'Approve exactly this correction'}).click(); await page.waitForSelector('.corrcard >> text=Approved as decision');
    await page.locator('.corrcard button',{hasText:'Carry out the correction'}).click(); await page.waitForSelector('.corrcard >> text=Correction carried out',{timeout:120000});
    const row2=W.db.product_content.find(r=>r.page_key===seat); check(row2.description===EDIT_DESC && row2.specs.length===1,'the live page now carries the President\'s text');
    check(W.db.mfr_decisions.find(z=>z.id===rf).used_at,'the regression fix is spent');
    await shot('correction-carried-out');
    W.db.mfr_verification_runs.forEach((r,i)=>{ if(!r.run_at) r.run_at=new Date(Date.UTC(2026,9,14,2,0,0)+i*1000).toISOString(); });
    await page.locator('.corrcard button',{hasText:'Finalize (new Gold Standard)'}).first().click();
    await page.waitForFunction(()=>/Current Gold Standard: PASS/.test(document.body.innerText)&&!document.querySelector('.corrcard button.warn'),null,{timeout:120000}).catch(()=>{});
    const gs=W.db.mfr_verification_runs.filter(r=>r.result==='pass'&&r.phase==='post').slice(-1)[0];
    check(gs && gs.checks.some(c=>c.id==='publication'&&c.detail&&c.detail.correction&&c.detail.correction.regression_fix===rf),'finalized: a new Gold Standard run records the correction');
    await shot('finalized');
    check(!fails.some(x=>/page error/.test(x)),'no script errors');
  }catch(e){ fails.push(String(e&&e.stack||e)); console.log('FAIL '+(e&&e.stack||e)); await shot('failure').catch(()=>{}); }
  await browser.close(); server.close();
  console.log(`mc saved edits, Gold Standard status & correction screens: ${fails.length?'FAILED ('+fails.length+')':'ALL PASS'}`); process.exit(fails.length?1:0);
})().catch(e=>{ console.log('FAIL '+(e&&e.stack||e)); process.exit(1); });
