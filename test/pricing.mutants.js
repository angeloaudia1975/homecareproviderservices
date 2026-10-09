const fs=require('fs'),{execFileSync}=require('child_process');
const path=require('path'),os=require('os');
const A=path.join(__dirname,'..','netlify','functions'), MD=fs.mkdtempSync(path.join(os.tmpdir(),'mutp-')); 
for(const f of ['_pricing.js','_shop_engine.js','orders-api.js','_platform.js']) fs.copyFileSync(A+'/'+f,MD+'/'+f);
const M=[
 ['_pricing.js','disabled pages read', 'if (/^product_content\\?/.test(path)) path += "&disabled=eq.false";', ''],
 ['_pricing.js','branch row loses to master', '(a.dealer_id === dealerId ? 1 : 0) - (b.dealer_id === dealerId ? 1 : 0)', '(b.dealer_id === dealerId ? 1 : 0) - (a.dealer_id === dealerId ? 1 : 0)'],
 ['_pricing.js','master contract not inherited', 'const ids = [dealerId]; if (rec && rec.parent_id) ids.push(rec.parent_id);', 'const ids = [dealerId];'],
 ['_pricing.js','failed layer forgiven like the shop does', 'if (failures.length) throw new Error("layer_unreadable: "', 'if (false) throw new Error("layer_unreadable: "'],
 ['_pricing.js','authoritative despite parity error', '  if (m.record_resync_error)\n    return { authoritative: false, note: "the record', '  if (false)\n    return { authoritative: false, note: "the record'],
 ['_pricing.js','record never authoritative', 'const authoritative = migrated && auth.authoritative;', 'const authoritative = false;'],
 ['_pricing.js','family ignored', 'const pick = fam != null ? same.filter(x => String(x.family || "") === fam) : same;', 'const pick = same.slice(0,1);'],
 ['_pricing.js','cart family not pooled', 'if (p) cart.set(slug + "::" + p.code + "::" + oi + "::" + ii, { p, qty });', ''],
 ['_pricing.js','no change ever reported', 'const diff = l.client == null || Math.abs(unit - l.client) >= 0.005;', 'const diff = false;'],
 ['_pricing.js','unavailable line not a change', 'changed = true;\n      o.items.push({ code: l.code, qty: l.qty, available: false', 'o.items.push({ code: l.code, qty: l.qty, available: false'],
 ['_pricing.js','golden priced as HCPS', 'filter(s => s && !isGolden(s))', 'filter(s => s)'],
 ['_pricing.js','missing content file is an error', 'if (j == null) return { ok: false, status: 404, json: async () => null };', 'if (j == null) throw new Error("no content");'],
 ['_pricing.js','catalog file 5xx read as empty', 'if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);', 'if (!r.ok) return empty;'],
 ['_pricing.js','contract prices not passed to engine', 'prices: contract || {} };', 'prices: {} };'],
 ['orders-api.js','create saves changed totals', 'if(priced.changed) return json(409', 'if(false) return json(409'],
 ['orders-api.js','create stores browser prices', '      orders=priced.orders;', ''],
 ['orders-api.js','pricing failure ignored in create', 'catch(e){ console.error("order pricing failed",e&&e.message); return json(503', 'catch(e){ priced={changed:false,orders}; } if(0) return json(503'],
 ['orders-api.js','stored subtotal from browser', 'o.estimated_total):num(o.subtotal),', 'o.estimated_total):num(o.items_subtotal),'],
 ['orders-api.js','order kept without its lines', 'try{ await sb("DELETE",`orders?id=eq.${encodeURIComponent(oid)}`,null,{Prefer:"return=minimal"}); }', 'try{ }'],
 ['orders-api.js','failed lines still confirmed', 'failed.push({manufacturer_slug:slug,error:"order_not_recorded"}); continue;\n          }', '}'],
 ['orders-api.js','nothing saved reported as success', 'if(!saved) return json(503,{ok:false,status:"record_failed"', 'if(false) return json(503,{ok:false,status:"record_failed"'],
 ['orders-api.js','flag ignores dealer scope', '&dealer_id=eq.${encodeURIComponent(who.dealer_id)}`,{admin_notes:note}', '`,{admin_notes:note}'],
 ['_pricing.js','discontinued sold', 'if (!l.p || l.p._discontinued) {', 'if (!l.p) {'],
];
let surv=0;
for(const [file,n,f,t] of M){ const src=fs.readFileSync(A+'/'+file,'utf8').replace(/\r\n/g,'\n'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  fs.writeFileSync(MD+'/'+file,src.replace(f,t));
  let k=false; try{execFileSync('node',[path.join(__dirname,'pricing.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})});}catch(e){k=true;}
  fs.copyFileSync(A+'/'+file,MD+'/'+file);
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k)surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);
