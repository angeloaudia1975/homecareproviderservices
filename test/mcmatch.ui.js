/* Manufacturer Center Phase 6 CORRECTION — the real Match & decide screen on the four frozen lines shaped exactly
   like production (test/mcmatch.world.js). Bemis: every SKU "matches the record", no "needs a decision", no
   "HOLD", 0 proposed changes. Climbing Steps, Strongback, Ovation: the legacy-source label, no decision queue.
   Every line stays read-only and the page sends only reads. Needs Playwright (PLAYWRIGHT=path to the package,
   or require('playwright')); skipped without it. */
const http=require('http'), path=require('path'), fs=require('fs');
let pw; try{ pw=require(process.env.PLAYWRIGHT||'playwright'); }catch(e){ console.log('SKIP: Playwright not installed'); process.exit(0); }
const S=require('./mcmatch.world.js');
const ADMIN=path.join(__dirname,'..','src','admin');
const W=S.world(), C=S.mod(W);
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
const snap=()=>JSON.stringify(Object.keys(W.db).sort().map(k=>[k,W.db[k].map(r=>{ const x=Object.assign({},r); delete x.code_norm; return x; })]));
const fails=[]; const check=(c,w)=>{ if(!c){ fails.push(w); console.log('FAIL '+w); } else console.log('ok   '+w); };
(async()=>{
  await new Promise(r=>server.listen(0,r)); const base='http://127.0.0.1:'+server.address().port;
  const browser=await pw.chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{});
  const page=await browser.newPage({viewport:{width:1360,height:900}});
  page.on('pageerror',e=>fails.push('page error: '+e.message));
  await page.addInitScript(()=>{ try{ localStorage.setItem('hcps_staff_token','walkthrough'); localStorage.setItem('hcps_staff_profile',JSON.stringify({email:'angelo@homecareproviderservices.org',role:'president',name:'Angelo Audia'})); }catch(e){} });
  const before=snap();
  try{
    await page.goto(base+'/admin/manufacturer-center.html'); await page.waitForSelector('text=Manufacturer Center');
    for(const slug of ['bemis'].concat(S.LEGACY)){
      await page.locator('tr',{hasText:slug}).locator('button',{hasText:'Open'}).first().click(); await page.waitForSelector('#wfbody .rob');
      await page.locator('.tabs.wf button',{hasText:'2 · Match & decide'}).click();
      await page.waitForFunction(()=>!/Matching|Reading|Preparing/.test(document.querySelector('#wfbody').textContent),null,{timeout:60000});
      const txt=(await page.locator('#wfbody').textContent()).replace(/\s+/g,' ');
      const writes=await page.locator('#wfbody button').evaluateAll(bs=>bs.map(b=>b.textContent.trim()).filter(t=>/dry run|\(writes\)|Approve|Register|Accept|Import|Decide|Preview|Write|Activate/i.test(t)));
      check(/Read-only — this line is frozen/.test(txt)&&!writes.length,slug+' · Match: read-only, no write control');
      if(slug==='bemis'){
        check(/matches the record: 9/.test(txt)&&/record would change: 0/.test(txt)&&/needs a decision: 0/.test(txt)&&/proposed changes \(new or different\): 0/.test(txt),'bemis · Match: 9 match the record, 0 change, 0 need a decision, 0 proposed changes');
        check(!/HOLD/.test(txt),'bemis · Match: no "HOLD" anywhere');
        check(await page.locator('#wfbody tr.needrow').count()===0,'bemis · Match: no row flagged for a decision');
      } else {
        check(txt.includes('Accepted legacy source — row-level source data not stored; Match comparison unavailable.'),slug+' · Match: legacy-source label shown');
        check(!/on record, not in source/.test(txt)&&/needs a decision: 0/.test(txt)&&/proposed changes: 0/.test(txt),slug+' · Match: no "not in source" queue, 0 decisions, 0 proposed changes');
        check(new RegExp('not compared \\(legacy source\\): '+S.L.legacy_records[slug].by_status.active).test(txt),slug+' · Match: '+S.L.legacy_records[slug].by_status.active+' active SKUs listed as not compared');
      }
      await page.screenshot({path:path.join(process.env.MCUI_OUT||process.cwd(),'mcmatch-'+slug+'.png'),fullPage:true}).catch(()=>{});
    }
    check(!calls.some(c=>!/^(mc_overview|mc_line|mc_match|whoami|mc_sources)$/.test(c.action)),'the page sent only reads ('+[...new Set(calls.map(c=>c.action))].join(', ')+')');
    check(snap()===before,'nothing written');
  }catch(e){ fails.push(String(e&&e.message||e).slice(0,400)); console.log('FAIL '+String(e&&e.message||e).slice(0,400)); }
  await browser.close(); server.close();
  console.log(`mc match screens on live frozen lines: ${fails.length?fails.length+' failed':'all passed'}`); process.exit(fails.length?1:0);
})();
