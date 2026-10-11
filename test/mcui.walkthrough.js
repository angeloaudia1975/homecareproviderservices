/* Manufacturer Center Phase 6 — the dry walkthrough through the REAL screens. Serves src/admin/manufacturer-center.html
   with its real scripts, answers its catalog-api calls with the real catalog-api running against the in-memory
   sandbox (test/mcflow.world.js: a copy of Bemis as a new line, beside a frozen Bemis-shaped line), and clicks
   through the whole workflow in Chromium, saving a screenshot of each step to MCUI_OUT (default ./mcui-shots).
   Proves on the way that a frozen line opens read-only (no write control on any step).
   Needs Playwright (PLAYWRIGHT=path to the package, or require('playwright')); skipped without it. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const S=require('./mcflow.world.js');
const ADMIN=path.join(__dirname,'..','src','admin');
const OUT=process.env.MCUI_OUT||path.join(process.cwd(),'mcui-shots'); fs.mkdirSync(OUT,{recursive:true});
const W=S.world(), C=S.mod(W);
const REAL_BEFORE=JSON.stringify([W.db.manufacturer_meta.filter(m=>m.slug===S.REAL),W.db.product_skus.filter(r=>r.manufacturer===S.REAL).map(({code_norm,...x})=>x),
  W.db.product_overrides.filter(r=>r.manufacturer===S.REAL),W.db.custom_products.filter(r=>r.manufacturer===S.REAL)]);
const calls=[];
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname==='/.netlify/functions/catalog-api'){
    let body=''; for await (const ch of req) body+=ch;
    const b=body?JSON.parse(body):{}; calls.push({action:b.action,manufacturer:b.manufacturer,dry_run:b.dry_run===true});
    const r=await S.call(C,b); res.writeHead(r.status,{'content-type':'application/json'}); res.end(JSON.stringify(r.body)); return; }
  if(u.pathname.startsWith('/.netlify/functions/')){ res.writeHead(200,{'content-type':'application/json'}); res.end('{}'); return; }
  const f=path.join(ADMIN,path.basename(u.pathname));
  if(u.pathname.startsWith('/admin/')&&fs.existsSync(f)){ res.writeHead(200,{'content-type':f.endsWith('.css')?'text/css':(f.endsWith('.js')?'text/javascript':'text/html')}); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end(''); });
const shots=[]; let page, n=0;
async function shot(name){ n++; const file=path.join(OUT,String(n).padStart(2,'0')+'-'+name+'.png'); await page.screenshot({path:file,fullPage:true}); shots.push(file); }
async function waitToast(re){ await page.waitForFunction(r=>new RegExp(r).test(document.querySelector('#toast').textContent)&&document.querySelector('#toast').classList.contains('show'),re.source,{timeout:120000}); }
async function clickText(text, scope){ await page.locator((scope||'#line')+' button',{hasText:text}).first().click(); }
const fails=[]; const check=(c,w)=>{ if(!c){ fails.push(w); console.log('FAIL '+w); } else console.log('ok   '+w); };
(async()=>{
  await new Promise(r=>server.listen(0,r)); const base='http://127.0.0.1:'+server.address().port;
  const browser=await pw.chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{});
  page=await browser.newPage({viewport:{width:1360,height:900}});
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo Audia'})); }catch(e){} });
  await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center'); await shot('overview');

  /* A frozen line opens read-only on every step. */
  await page.locator('tr',{hasText:'bemis'}).filter({hasNotText:'copy'}).locator('button',{hasText:'Open'}).click();
  await page.waitForSelector('#wfbody .rob'); await shot('frozen-bemis-verify');
  for(const tab of ['1 · Sources','2 · Match & decide','3 · Structure & content','4 · Commercial & freight','5 · Stage','6 · Verify & activate','History']){
    await page.locator('.tabs.wf button',{hasText:tab}).click(); await page.waitForTimeout(300); await page.waitForFunction(()=>!/Matching|Reading|Preparing/.test(document.querySelector('#wfbody').textContent),null,{timeout:60000});
    const writes=await page.locator('#wfbody button').evaluateAll(bs=>bs.map(b=>b.textContent.trim()).filter(t=>/dry run|\(writes\)|Approve|Register|Accept|Import|Decide|Preview|Write|Activate/i.test(t)));
    check(writes.length===0,'frozen Bemis · '+tab+': no write control ('+(writes.join(', ')||'none')+')');
    if(tab==='4 · Commercial & freight') await shot('frozen-bemis-commercial');
  }
  await page.locator('.tabs.wf button',{hasText:'Decisions'}).click(); await page.waitForTimeout(200);
  check(await page.locator('#wfbody button',{hasText:'Record regression_fix decision'}).count()===1,'frozen Bemis · Decisions: the regression_fix path is the one control offered');
  await shot('frozen-bemis-decisions');

  /* The copy of Bemis, start to finish. */
  await page.locator('tr',{hasText:'bemis-copy'}).locator('button',{hasText:'Open'}).click(); await page.waitForSelector('#rg_title');
  await page.fill('#rg_title',S.fx.source.title); await page.fill('#rg_rec',S.fx.source.received_date); await page.fill('#rg_note','Walkthrough copy of the Bemis list');
  await page.setInputFiles('#rg_file',{name:'bemis-price-list-2026.csv',mimeType:'text/csv',buffer:Buffer.from('code,base_price\n7YR05310TSS,109.98\n')});
  await clickText('Check registration (dry run)'); await page.waitForSelector('text=Dry run — would register'); await shot('source-register-dry-run');
  await clickText('Register source (writes)'); await waitToast(/registered as received/);
  await page.fill('input[id^="accr_"]','Checked against the PDF; all 9 SKUs present'); await clickText('Check acceptance (dry run)'); await page.waitForSelector('text=Accept source (writes)');
  await shot('source-accept-dry-run'); await clickText('Accept source (writes)'); await waitToast(/accepted/);
  await clickText('Import rows…'); await page.waitForSelector('#imp_text');
  const tsv=['Model Number\tItem Description\tDealer Cost Per Unit\tMaster Case Qty\tDealer Master Case Cost\tMSRP\tMAP']
    .concat(S.fx.source.rows.map(r=>[r.code,r.description,r.unit_cost,r.case_qty_text||'',r.raw['Dealer Master Case Cost']==null?r.base_price:r.raw['Dealer Master Case Cost'],r.msrp,r.map].join('\t'))).join('\n');
  await page.fill('#imp_text',tsv); await clickText('Check import (dry run)'); await page.waitForSelector('text=rows would be added as received'); await shot('source-import-dry-run');
  await clickText('Import rows (writes)'); await waitToast(/imported as received/); await shot('sources-done');

  await page.locator('.tabs.wf button',{hasText:'2 · Match & decide'}).click(); await page.waitForSelector('text=needs a decision:'); await shot('match-before-decisions');
  const decide=async(code,scope,hv,reason)=>{ await page.locator('#wfbody tr',{hasText:code}).locator('button',{hasText:'Decide'}).click(); await page.waitForSelector('#dc_hv');
    await page.selectOption('#dc_scope',scope); await page.fill('#dc_hv',JSON.stringify(hv)); await page.fill('#dc_reason',reason);
    await clickText('Check decision (dry run)'); await page.waitForSelector('text=Dry run — would record'); if(code==='7YR05310TSS') await shot('decision-dry-run');
    await clickText('Record decision (writes)'); await waitToast(/Decision #\d+ recorded/); await page.waitForSelector('text=needs a decision:'); };
  await decide('7YR05310TSS','packs',{uom:'Case',msrp_basis:'each',map_basis:'each'},'Bemis quotes dealer price per master case and MSRP/MAP per piece');
  await decide('7YE82350TC','sku',{uom:'Each',case_qty:1},'No master case quantity: Steadfast is sold singly');
  await decide('444DISPLAY','sku',{uom:'Display',case_qty:1},'One floor display program per order');
  await page.waitForSelector('text=ready to stage: 9'); await shot('match-after-decisions');

  await page.locator('.tabs.wf button',{hasText:'3 · Structure & content'}).click(); await page.waitForSelector('text=Open Structure Map'); await shot('structure-content');

  await page.locator('.tabs.wf button',{hasText:'4 · Commercial & freight'}).click(); await page.waitForSelector('#fr_terms');
  await page.fill('#fr_terms',JSON.stringify(S.fx.freight,null,1)); await clickText('Preview (dry run)'); await page.waitForSelector('#wfbody .gatebox'); await shot('freight-dry-run-approval-1');
  await page.fill('#fr_reason','Matches the Bemis terms of agreement'); await clickText('Approve exactly this plan'); await page.waitForSelector('text=Write freight terms (writes)');
  await clickText('Write freight terms (writes)'); await waitToast(/Freight terms stored/); await page.waitForSelector('text=from the record'); await shot('freight-from-record');

  await page.locator('.tabs.wf button',{hasText:'5 · Stage'}).click(); await clickText('Dry run'); await page.waitForSelector('#wfbody .gatebox'); await shot('stage-dry-run-approval-1');
  await page.fill('#st_reason','All 9 SKUs as decided'); await clickText('Approve exactly this plan'); await page.waitForSelector('text=Write staged records (writes)'); await shot('stage-approved');
  await clickText('Write staged records (writes)'); await waitToast(/records staged/);

  await page.waitForSelector('text=Run pre-activation verification'); await clickText('Run pre-activation verification'); await waitToast(/Verification passed/);
  await page.waitForSelector('#act_reason'); await shot('pre-verification-approval-2');
  await page.fill('#act_reason','Pre-activation run passed'); await clickText('Approve activation'); await page.waitForSelector('text=Activation dry run');
  await clickText('Activation dry run'); await page.waitForSelector('text=Activate (writes)'); await shot('activation-dry-run');
  await clickText('Activate (writes)'); await waitToast(/Verification passed/); await page.waitForTimeout(400); await shot('activated-post-verification');

  await page.locator('.tabs.wf button',{hasText:'History'}).click(); await page.waitForSelector('.cmpk');
  const boxes=page.locator('.cmpk'); await boxes.nth(0).check(); await boxes.nth(1).check(); await clickText('Compare the two ticked runs'); await page.waitForSelector('text=Run #'); await shot('history-compare');
  await page.locator('.tabs.wf button',{hasText:'Decisions'}).click(); await page.waitForTimeout(300); await shot('decisions-log');

  const meta=W.db.manufacturer_meta.find(m=>m.slug===S.COPY), runs=W.db.mfr_verification_runs.filter(r=>r.manufacturer===S.COPY);
  check(meta.record_authoritative===true,'the copy is activated');
  check(runs.length===2&&runs[1].phase==='post'&&runs[1].result==='pass','pre and post runs saved, post passes');
  check(runs[1].fingerprint===S.fx.real.fingerprint,'post-activation fingerprint = real Bemis Gold Standard ('+runs[1].fingerprint+')');
  const writes=calls.filter(c=>!c.dry_run&&!/^(mc_overview|mc_line|mc_match|mc_structure|mc_commercial|mc_compare_runs|mc_run|mc_verify)$/.test(c.action));
  check(writes.every((w,i)=>w.action==='mc_approve_gate'||calls.slice(0,calls.indexOf(w)).some(c=>c.action===w.action&&c.dry_run)),'every write button ran its dry run first ('+writes.length+' writes)');
  check(!calls.some(c=>c.manufacturer===S.REAL&&!c.dry_run&&!/^(mc_line|mc_match|mc_structure|mc_commercial|mc_verify|mc_run)$/.test(c.action)),'no write was sent for the frozen line');
  check(JSON.stringify([W.db.manufacturer_meta.filter(m=>m.slug===S.REAL),W.db.product_skus.filter(r=>r.manufacturer===S.REAL).map(({code_norm,...x})=>x),
    W.db.product_overrides.filter(r=>r.manufacturer===S.REAL),W.db.custom_products.filter(r=>r.manufacturer===S.REAL)])===REAL_BEFORE,'the frozen line is unchanged');
  fs.writeFileSync(path.join(OUT,'calls.json'),JSON.stringify(calls,null,1));
  await browser.close(); server.close();
  console.log(`mc ui walkthrough: ${shots.length} screens, ${fails.length} failed`); process.exit(fails.length?1:0);
})().catch(async e=>{ console.log('FAIL walkthrough stopped: '+(e&&e.message||e)); try{ await shot('stopped-here'); }catch(_){} process.exit(1); });
