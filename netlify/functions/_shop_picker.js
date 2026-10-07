/* THE STOREFRONT'S PICKER, VERBATIM (Phase 2.6).
   Every function below is copied character for character from Partner 360's public/index.html
   (homecareproviderservicesordering), so the structure audit builds a product's options exactly
   the way a dealer's page does. Do not edit here: change the storefront, then re-copy. The test
   test/picker-parity.test.js fails the moment the two drift apart. */
/* ---- BEGIN VERBATIM ---- */
function groupKeyOf(p){ return p._pageKey || p.group || p.code; }
function groupDisplayName(p){ if(!p) return '';
  /* The approved page name first. The group string is an internal catalog key that happens to
     be human-readable; it is not what anyone reviewed, and where the two disagree the reviewed
     name is the one that should reach a dealer. */
  if(p._encPage) return p._encPage;
  const g=String(p.group||''); const i=g.indexOf('::');
  if(i>=0){ const n=g.slice(i+2).trim(); if(n) return n; } return p._gname || p.name || p.code || ''; }
function stripProductPrefix(name, gn){
  if(!gn) return String(name||'');
  const parts=String(name||'').split(/\s+/);
  const words=s=>{ const out=[];
    String(s||'').split(/\s+/).forEach((w,i)=>{ const n=w.toLowerCase().replace(/[^a-z0-9]/g,'');
      if(n) out.push({n:n,i:i}); });
    return out; };
  const N=words(name), G=words(gn);
  let k=0; while(k<N.length && k<G.length && N[k].n===G[k].n) k++;
  if(!k) return String(name||'');
  return parts.slice(N[k-1].i+1).join(' ');
}
function variantLabel(v){ const gn=groupDisplayName(v); let lbl=String(v.name||'').trim();
  lbl=stripProductPrefix(lbl, gn);
  lbl=lbl.replace(/^[\s,;:·–—-]+/,'').trim();
  /* Two places can describe one option: the authored option field and whatever trails the
     product name. Take the one that CONTAINS the other, so neither a colour nor a size is
     ever silently dropped; when they genuinely disagree, show both rather than pick a
     winner and hide the conflict from the dealer buying it. */
  const opt=String(v._skuOption||'').trim();
  if(!opt) return lbl || String(v.code||'');
  if(!lbl) return opt;
  const n=x=>x.toLowerCase().replace(/[^a-z0-9]/g,'');
  const a=n(opt), b=n(lbl);
  if(a===b || a.indexOf(b)>=0) return opt;
  if(b.indexOf(a)>=0) return lbl;
  /* VARIANT 1 THEN VARIANT 2. The name/description is what a dealer recognises the item by
     ("X-Small", "Dark Blue"); the authored size is the measurement that confirms the choice
     ("9"- 11""). Reading them the other way round led with a number nobody shops by, so the
     arm sling's picker opened on "9"- 11" · X-Small". One line, identity first. */
  return lbl+' · '+opt; }
const VARIANT_SIZE_RANK=[["xxsmall",0],["xx-small",0],["2xs",0],["xxs",0],
  ["x-small",1],["xsmall",1],["extra small",1],["xs",1],
  ["small",2],["s",2],["medium",3],["med",3],["m",3],
  ["x-large",5],["xlarge",5],["extra large",5],["xl",5],
  ["xx-large",6],["xxlarge",6],["2xl",6],["xxl",6],
  ["3xl",7],["4xl",8],["5xl",9],
  /* Spelled-out forms must appear BEFORE "large" below. "3X-Large" folds to "3x large", which
     contains "large" but not "3xl", so without these three it scored 4 — the same rank as
     Large — and the Neoprene Knee Support picker read Small, Medium, 3X-Large, 4X-Large,
     Large, X-Large, XX-Large. */
  ["3x-large",7],["4x-large",8],["5x-large",9],
  ["large",4],["lg",4],["l",4],
  ["universal",10],["one size",10],["osfa",10]];
function variantSizeRank(label){
  /* Both sides are folded the same way, so "X-Small", "x small" and "xsmall" are one token
     and a hyphen can never decide where an option sorts. */
  const fold=x=>' '+String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()+' ';
  const t=fold(label);
  for(const [word,rank] of VARIANT_SIZE_RANK){ if(t.indexOf(fold(word))>=0) return rank; }
  return 50;
}
const OPTION_COLORS=['black','blue','grey','gray','red','white','pink','navy','tan','beige',
  'green','purple','orange','camo','teal','charcoal','silver','gold','brown','yellow','ivory'];
const OPTION_COLOR_COMPOUNDS=['dark blue','light blue','royal blue','sky blue','navy blue',
  'dark grey','dark gray','light grey','light gray','hot pink','forest green','olive green'];
const OPTION_SIDES=['left','right','universal','bilateral'];
function titleWord(w){ return String(w||'').replace(/\b[a-z]/g,c=>c.toUpperCase()); }
function optionTokens(label){
  return String(label||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean);
}
function optionAxesOf(label){
  const raw=String(label||'').trim();
  if(!raw) return {};
  const toks=optionTokens(raw);
  let color='', side='';
  const flat=' '+toks.join(' ')+' ';
  for(const cc of OPTION_COLOR_COMPOUNDS){
    if(flat.indexOf(' '+cc+' ')>=0){ color=cc.replace('gray','grey'); break; } }
  toks.forEach(t=>{ const c=(t==='gray')?'grey':t;
    if(!color && OPTION_COLORS.indexOf(c)>=0) color=c;
    if(!side && OPTION_SIDES.indexOf(c)>=0 && c!=='universal') side=c; });
  /* Cut the recognised words OUT OF THE ORIGINAL TEXT rather than rebuilding from the folded
     tokens, so what is left keeps the spelling a person typed — "X-Small", not "X Small". */
  const cutWord=(str,w)=>w?str.replace(new RegExp('(^|[^A-Za-z0-9])'+w+'(?![A-Za-z0-9])','ig'),'$1'):str;
  /* A compound is cut as a phrase with flexible spacing, so "Dark  Blue" and "Dark Blue" both
     go, and nothing of the colour is left behind to be mistaken for a size. */
  const colorPat = !color ? ''
    : (color.indexOf(' ')>=0 ? color.replace(/\s+/g,'\\s+').replace('grey','gr[ae]y')
                             : (color==='grey'?'gr[ae]y':color));
  let rest=cutWord(raw, colorPat);
  rest=cutWord(rest, side);
  /* Cutting a recognised word out of the middle of a bracket leaves the bracket behind:
     "X-Small (Left)" minus the side is "X-Small ()", which is what the Classic Wrist Brace
     and Thumb Spica pickers were offering. Empty brackets go before the edges are trimmed. */
  rest=rest.replace(/\(\s*\)/g,'').replace(/\[\s*\]/g,'').replace(/\{\s*\}/g,'');
  rest=rest.replace(/^[\s,;:·\u2013\u2014-]+/,'').replace(/[\s,;:·\u2013\u2014-]+$/,'').replace(/\s{2,}/g,' ').trim();
  const out={};
  if(rest && variantSizeRank(rest)<50) out.Size=rest;
  else if(rest && !color && !side) out.Variant=rest;
  else if(rest) out.Size=rest;
  if(color) out.Color=titleWord(color);
  if(side) out.Side=titleWord(side);
  return out;
}
const AXIS_ORDER=['Size','Color','Side','Variant'];
function optionAxes(variants){
  const seen={}, order=[];
  (variants||[]).forEach(v=>{ const ax=optionAxesOf(variantLabel(v));
    Object.keys(ax).forEach(k=>{ if(!seen[k]){seen[k]=[];order.push(k);} 
      if(seen[k].indexOf(ax[k])<0) seen[k].push(ax[k]); }); });
  /* ONE PRODUCT, ONE AXIS NAME. optionAxesOf decides "Size" or "Variant" per SKU, from whether
     that SKU's text happens to contain a recognisable size word. Two SKUs of the SAME product
     can therefore land on different axes — "0637, 4XL" reads as Size, "30”-48”" reads as
     Variant — and each sits alone on its own axis varying in nothing, so the picker vanishes
     completely. That is what the Nu-Form 0637 card did: two buyable SKUs, no way to choose
     between them. Merged here, in the one place that can see the whole variant set. */
  if(seen.Size && seen.Variant){
    seen.Variant.forEach(v=>{ if(seen.Size.indexOf(v)<0) seen.Size.push(v); });
    delete seen.Variant;
    const vi=order.indexOf('Variant'); if(vi>=0) order.splice(vi,1);
  }
  const keys=order.slice().sort((a,b)=>{
    const ia=AXIS_ORDER.indexOf(a), ib=AXIS_ORDER.indexOf(b);
    return (ia<0?99:ia)-(ib<0?99:ib) || order.indexOf(a)-order.indexOf(b); });
  const varying={}, fixed={};
  keys.forEach(k=>{ const vals=seen[k];
    if(k==='Size') vals.sort((x,y)=>variantSizeRank(x)-variantSizeRank(y)||x.localeCompare(y));
    else vals.sort((x,y)=>x.localeCompare(y));
    (vals.length>1?varying:fixed)[k]=vals; });
  return {varying:varying, fixed:fixed, keys:keys};
}
function resolveVariant(variants, want, changed){
  const list=variants||[];
  const axOf=v=>optionAxesOf(variantLabel(v));
  const exact=list.find(v=>{ const a=axOf(v);
    return Object.keys(want).every(k=>String(a[k]||'')===String(want[k]||'')); });
  if(exact) return exact;
  if(changed){ const near=list.find(v=>String(axOf(v)[changed]||'')===String(want[changed]||''));
    if(near) return near; }
  return list[0]||null;
}
function sortVariants(list){
  return list.map((v,i)=>({v:v,i:i,l:variantLabel(v)}))
    .sort((a,b)=>{ const ra=variantSizeRank(a.l), rb=variantSizeRank(b.l);
      if(ra!==rb) return ra-rb;
      const c=a.l.localeCompare(b.l,undefined,{numeric:true,sensitivity:'base'});
      return c || a.i-b.i; })
    .map(x=>x.v);
}
/* ---- END VERBATIM ---- */
module.exports = { groupKeyOf, groupDisplayName, stripProductPrefix, variantLabel, variantSizeRank,
  optionAxesOf, optionAxes, resolveVariant, sortVariants };
