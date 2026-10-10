/* VERBATIM COPIES OF THE STOREFRONT, CHECKED AT RUN TIME (Manufacturer Center, 2026-10-10).
   The server already prices with the shop's own engine (_shop_engine.js, a verbatim copy of
   index.html). Verification needs two more things from the same page: the words a dealer reads on
   a product card and in the freight box (_shop_render.js). Both copies are made by the functions
   below, and mc_verify re-runs them against the LIVE storefront page: if the deployed page no
   longer matches the copy the server holds, the verification fails instead of passing on stale
   code. test/extract-engine.js and test/extract-picker.js are the originals these mirror;
   test/mcverify.test.js holds the two to the same output. */
function grabDecl(src, anchor){
  const i=src.indexOf('\n'+anchor); if(i<0) throw new Error('anchor not found: '+anchor);
  const st=i+1;
  let j=st, depth=0, inS=null, started=false;
  for(;j<src.length;j++){ const c=src[j], n=src[j+1];
    if(inS){ if(c==='\\'){j++;continue;} if(c===inS) inS=null; continue; }
    if(c==='/'&&n==='*'){ const e=src.indexOf('*/',j+2); j=e+1; continue; }
    if(c==='/'&&n==='/'){ const e=src.indexOf('\n',j); j=e; continue; }
    if(c==='"'||c==="'"||c==='`'){ inS=c; continue; }
    if(c==='/'&&anchor.startsWith('function')&&started){
      const prev=src.slice(Math.max(0,j-3),j).trim().slice(-1);
      if('(,=:[!&|?{};'.includes(prev)||prev===''){ let k=j+1, cls=false; for(;k<src.length;k++){ const d=src[k]; if(d==='\\'){k++;continue;} if(d==='[')cls=true; else if(d===']')cls=false; else if(d==='/'&&!cls) break; if(d==='\n') break; } j=k; continue; } }
    if(c==='('||c==='['||c==='{'){ depth++; started=true; }
    else if(c===')'||c===']'||c==='}'){ depth--; if(depth===0 && c==='}' && anchor.startsWith('function')){ return src.slice(st,j+1); } }
    else if(c===';'&&depth===0&&anchor.startsWith('const')) return src.slice(st,j+1);
  }
  throw new Error('unterminated: '+anchor);
}
function slice(src, a, b){ const i=src.indexOf(a), j=src.indexOf(b, i); if(i<0||j<0) throw new Error('anchor not found: '+(i<0?a:b)); return src.slice(i,j); }
/* Identical to test/extract-engine.js. */
function extractEngine(src){
  const pricing=['function familyQty','function tierQty','function contractPrice','function unitPrice','function linesSubtotal','function computeFreight'].map(a=>grabDecl(src,a)).join('\n');
  const startA=src.indexOf('/* Pure. The same rule as images-api.js')>=0?'/* Pure. The same rule as images-api.js':'async function mergeCatalogEdits(slug, prods){';
  const merge=slice(src, startA, 'async function loadProducts(slug){');
  const color=slice(src, 'const COLOR_SUFFIX=', '/* ---------- render tabs');
  return pricing+'\n'+merge+'\n'+color;
}
/* The card and freight-box words: priceHtml and everything it reads, plus freightRowsHtml. */
const RENDER_DECLS=['const money = n','const esc = s','function packOf','function packNote','function tierLadder',
  'const PRICE_NOTE_OPERATIONAL','const PRICE_NOTE_VOLUME','const PRICE_NOTE_TIERISH','const PRICE_NOTE_MAP',
  'function dealerPriceNote','function priceHtml','function freightRowsHtml'];
/* The render constants are one-line declarations whose regexes hold quote characters, so they are
   taken whole-line; the functions are taken by brace matching as everywhere else. */
function grabLine(src, anchor){ const i=src.indexOf('\n'+anchor); if(i<0) throw new Error('anchor not found: '+anchor); const e=src.indexOf('\n',i+1); return src.slice(i+1,e<0?src.length:e); }
function extractRender(src){ return RENDER_DECLS.map(a=>a.startsWith('const')?grabLine(src,a):grabDecl(src,a)).join('\n'); }
/* The cart line a dealer reads for a pack SKU ("1 × Case = 2 each"): it is written inline in
   renderCart, so the exact template is located and returned for the check to compare. */
const CART_PACK_TEMPLATE='${packOf(p)?`${qty} × ${esc(packOf(p).label)} = ${qty*packOf(p).n} each · `:""}';
module.exports={grabDecl, extractEngine, extractRender, RENDER_DECLS, CART_PACK_TEMPLATE};
/* The HCPS order email builder from the ordering site's submit-order.js: everything from the money
   helpers through buildEmail (all pure — no network, no handler). */
function extractHcpsEmail(src){ return slice(src, 'const r2 = (n) =>', 'async function sendEmail('); }
module.exports.extractHcpsEmail = extractHcpsEmail;
