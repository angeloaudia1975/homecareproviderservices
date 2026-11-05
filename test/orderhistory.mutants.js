// Mutants for order history totals: each must make test/orderhistory.test.js fail.
const fs=require('fs'), path=require('path'), os=require('os'), {execFileSync}=require('child_process');
const HIST=path.join(__dirname,'..','netlify','functions','order-history-api.js');
const SHOP=path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html');
const M=[
 [HIST,'freight columns not read','subtotal,freight_fee,estimated_total,submitted_at','subtotal,submitted_at'],
 [HIST,'total ignores stored total','last.total = o.estimated_total != null ? round2(o.estimated_total) : round2(last.cost + (last.freight || 0));','last.total = last.cost;'],
 [HIST,'freight dropped','last.freight = o.freight_fee == null ? null : round2(o.freight_fee);','last.freight = null;'],
 [HIST,'cost becomes total (spend would include freight)','lines: items, cost: round2(o.subtotal != null ? o.subtotal : items.reduce((s, i) => s + i.line, 0)),','lines: items, cost: round2(o.estimated_total != null ? o.estimated_total : (o.subtotal != null ? o.subtotal : items.reduce((s, i) => s + i.line, 0))),'],
 [HIST,'recent loses total','cost: o.cost, freight: o.freight, total: o.total,','cost: o.cost,'],
 [SHOP,'My Orders back to rounded merchandise','<td class="n tnum">${cents(orderTotal(o))}${freightNote(o)}</td><td>${statPill(o.status)}</td>','<td class="n tnum">${money(o.cost)}</td><td>${statPill(o.status)}</td>'],
 [SHOP,'footer sums merchandise','const total=HISTORY.reduce((s,o)=>s+orderTotal(o),0);','const total=HISTORY.reduce((s,o)=>s+(Number(o.cost)||0),0);'],
 [SHOP,'no freight note','const freightNote=o=>(o&&Number(o.freight)>0)?','const freightNote=o=>false?'],
 [SHOP,'total rounded','const cents=n=>"$"+(Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});','const cents=n=>"$"+Math.round(Number(n)||0).toLocaleString();'],
 /* C3-06 */
 [HIST,'orders read swallowed again','order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=1000`);','order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=1000`).catch(() => []);'],
 [HIST,'sales read swallowed again','product_code,product_name,qty,amount&order=period.desc`);','product_code,product_name,qty,amount&order=period.desc`).catch(() => []);'],
 [HIST,'no PO / tracking','po: o.po_number || "", tracking: o.tracking_number || "",','po: "", tracking: "",'],
 [HIST,'notice never shown','AN.noticeFor(slug) && acct && AN.missingAccounts(acct, dealerId, [slug]).length)','false)'],
 [HIST,'notice guessed when the rows are unreadable','AN.noticeFor(slug) && acct && AN.missingAccounts','AN.noticeFor(slug) && (!acct || AN.missingAccounts'],
 [HIST,'failure answer without ok:false','return json(500, { ok: false, error:','return json(500, { error:'],
 [SHOP,'tracking not shown','(o.tracking?`<div class="m">Tracking','(false?`<div class="m">Tracking'],
 [SHOP,'Request tracking shown on a tracked order','!=="delivered"&&!o.tracking;','!=="delivered";'],
 [SHOP,'notice not shown to the dealer','(o.account_notice?`<div class="m"','(false?`<div class="m"'],
];
let surv=0;
for(const [file,n,f,to] of M){
  const src=fs.readFileSync(file,'utf8'); const c=src.split(f).length-1;
  if(c!==1){ console.log(`BAD ANCHOR(${c}) ${n}`); surv++; continue; }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oh-')), tmp=path.join(dir,path.basename(file)); fs.writeFileSync(tmp,src.replace(f,to));
  if(file===HIST) fs.copyFileSync(path.join(path.dirname(HIST),'_account_notice.js'),path.join(dir,'_account_notice.js'));   // its helper, beside it
  const env=Object.assign({},process.env, file===HIST?{HIST_FILE:tmp}:{SHOP_FILE:tmp});
  let k=false; try{ execFileSync('node',[path.join(__dirname,'orderhistory.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++;
}
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);
