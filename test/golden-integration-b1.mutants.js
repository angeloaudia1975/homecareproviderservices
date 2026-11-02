/* Mutation check for test/golden-integration-b1.test.js — every mutant breaks one rule of the Golden ⇄ Partner 360
   B1 surface on the HCPS side; the test must FAIL on each one and PASS on the control. Edits the file in place and
   always restores it.   node test/golden-integration-b1.mutants.js */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['_golden_client.js','delegation lifetime not 90 s','exp: now + 90 };','exp: now + 600 };'],
  ['_golden_client.js','follows redirects with a signed request','redirect: "error"','redirect: "follow"'],
  ['_golden_client.js','any path accepted','if(!/^\\/v1\\/[a-z0-9/_-]+$/.test(String(path||""))) throw new Error("golden-client: bad path");',''],
  ['_golden_client.js','short secret treated as configured','return { kid, secret, base: base(), usable: !!kid && S2S.secretUsable(secret) };','return { kid, secret, base: base(), usable: !!kid && !!secret };'],
  ['_golden_client.js','network error reported as success','return { configured:true, ok:false, status:0, json:null, error:"golden_unreachable" };','return { configured:true, ok:true, status:200, json:{state:"account",capabilities:{}}, error:null };'],
  ['golden-proxy.js','master switch ignored','if(f.golden_p360_catalog !== true) return json(200, { ok:true, enabled:false, reason:"switched_off" });',''],
  ['golden-proxy.js','truthy switch accepted','if(f.golden_p360_catalog !== true)','if(!f.golden_p360_catalog)'],
  ['golden-proxy.js','pilot list ignored','if(!envName && !who.pilot.includes(String(c.sub_dealer)) && !who.pilot.includes(String(who.dealer_id))) return json(200, { ok:true, enabled:false, reason:"not_in_pilot" });',''],
  ['golden-proxy.js','branch sent as the organisation','return d.parent_id ? { sub_dealer: d.parent_id, sub_branch: d.id }','return d.parent_id ? { sub_dealer: d.id, sub_branch: null }'],
  ['golden-proxy.js','preview may order','order: caps.order === true && !who.preview','order: caps.order === true'],
  ['golden-proxy.js','Golden answer echoed whole','return json(200, Object.assign({ ok:true, enabled:true, available:true,\n        state:','return json(200, Object.assign({ ...g, ok:true, enabled:true, available:true,\n        state:'],
  ['golden-proxy.js','unapproved dealer accepted','if(!du || du.status !== "approved" || !du.dealer_id) return null;','if(!du || !du.dealer_id) return null;'],
  ['golden-links-api.js','reps may link accounts','if(!ADMIN.has(me.role)) return json(403, { ok:false, error:"management only" });',''],
  ['golden-links-api.js','linking switch ignored','if(f.golden_p360_links !== true) return json(503, { ok:false, error:"switched_off", message:"Golden linking is switched off." });',''],
  ['golden-links-api.js','branch may be linked','if(d[0].parent_id) return json(400','if(false) return json(400'],
  ['golden-links-api.js','manual guess without a note','if(b.method === "manual" && !note) return json(400, { ok:false, error:"a note is required for a manual proposal" });',''],
  ['golden-links-api.js','mirror written even when Golden refuses','if(!r.ok) return json(r.status && r.status < 500 ? r.status : 502,','if(false) return json(r.status && r.status < 500 ? r.status : 502,'],
  ['golden-links-api.js','proposal delegated with a dealer role','actor: me.email, role: "hcps_staff" } });','actor: me.email, role: "dealer" } });'],
  ['golden-links-api.js','refresh marks every row verified','golden_dealer_links?hcps_dealer_id=eq.${encodeURIComponent(dealerId)}&golden_link_id=eq.${encodeURIComponent(verifiedId)}`','golden_dealer_links?hcps_dealer_id=eq.${encodeURIComponent(dealerId)}`'],
  ['golden-links-api.js','other rows left verified after Golden names another link','{ golden_state: "not_verified", capabilities: null, checked_at: at }, { Prefer: "return=minimal" });\n      } else {','{ golden_state: "verified", capabilities: null, checked_at: at }, { Prefer: "return=minimal" });\n      } else {'],
  ['golden-links-api.js','any link-table failure hidden','if(!/golden_dealer_links/.test(m) || !/"code":"(PGRST205|42P01)"/.test(m)) throw e;','if(false) throw e;'],
  ['golden-links-api.js','propose asks Golden before the mirror exists','      await sbGet("golden_dealer_links?select=id&limit=1");\n',''],
  ['golden-links-api.js','missing link table not reported','links = []; linksInstalled = false;','links = [];'],
  ['golden-links-api.js','proposal pre-marked with Golden status','status: "proposed", golden_state: null,','status: g.status, golden_state: g.status,'],
  ['golden-proxy.js','Golden error code leaks to the browser','reason: branch ? "branch_not_permitted" : "golden_unavailable" }','reason: branch ? "branch_not_permitted" : r.error }'],
  ['orders-api.js','HCPS records Golden orders again','if(orders.some(o=>PRICING.isGolden(o&&(o.manufacturer_slug||o.manufacturer)))){','if(false){'],
  ['federation-api.js','sign-in links keep using the event secret','process.env.GOLDEN_SSO_SECRET||process.env.FEDERATION_SECRET','process.env.FEDERATION_SECRET||process.env.GOLDEN_SSO_SECRET'],
  ['federation-api.js','sign-in link without audience','JSON.stringify({slug:String(slug),exp,aud:"golden-sso"})','JSON.stringify({slug:String(slug),exp})'],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b1.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);
