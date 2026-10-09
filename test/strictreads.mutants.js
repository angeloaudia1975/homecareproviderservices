const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const M=[
 ['featured-api.js','featured list lenient', 'sb("GET",`featured_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,note,rank,active`),', 'sb("GET",`featured_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,note,rank,active`).catch(()=>[]),'],
 ['featured-api.js','featured pages lenient', 'select=page_key,status,image,images_gallery,skus&limit=5000`),', 'select=page_key,status,image,images_gallery,skus&limit=5000`).catch(()=>[]),'],
 ['featured-api.js','featured file lenient', '          catalogFile(slug),', '          fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),'],
 ['featured-api.js','404 treated as an error', '  if(r.status===404) return [];\n  if(!r.ok) throw new Error(`catalog file for ${slug}', '  if(!r.ok) throw new Error(`catalog file for ${slug}'],
 ['featured-api.js','overview lenient', '            sb("GET","featured_products?select=manufacturer,code,name,note,rank,active&order=rank.asc"),', '            sb("GET","featured_products?select=manufacturer,code,name,note,rank,active&order=rank.asc").catch(()=>[]),'],
 ['dealer-auth.js','contract read swallowed again', 'active=eq.true&select=dealer_id,manufacturer,code,price`);\n      if(!Array.isArray(pr))', 'active=eq.true&select=dealer_id,manufacturer,code,price`).catch(()=>[]);\n      if(!Array.isArray(pr))'],
 ['dealer-auth.js','unknown shown as none', 'prices:pricesUnavailable?null:prices,pricesUnavailable};', 'prices,pricesUnavailable:false};'],
 ['dealer-auth.js','flag dropped from preview', 'dealer,lines,access,prices,\n        ...(pricesUnavailable?{prices_unavailable:true}:{})});\n    }\n\n    // ---- persistent cart', 'dealer,lines,access,prices});\n    }\n\n    // ---- persistent cart'],
 ['dealers-api.js','contract editor lenient', 'try{ rows=await sbGet(`dealer_contract_prices?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&select=manufacturer,code,name,price,note,active&order=manufacturer,code`); }', 'try{ rows=await sbGet(`dealer_contract_prices?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&select=manufacturer,code,name,price,note,active&order=manufacturer,code`).catch(()=>[]); }'],
];
let surv=0;
for(const [file,n,f,t] of M){ const src=fs.readFileSync(path.join(DIR,file),'utf8').replace(/\r\n/g,'\n'); const c=src.split(f).length-1;
  if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'str-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'strictreads.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);
