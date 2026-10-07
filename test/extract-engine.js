/* Pull the storefront's product + pricing engine out of the shop page VERBATIM: the four
   pricing functions, the whole catalog merge through applyMasterPrices, and the colour/MSRP
   fallbacks. The server runs exactly this text, so a price it computes is the shop's price. */
const fs=require('fs'), path=require('path');
const {grabDecl}=require(path.join(__dirname,'extract-picker.js'));
function slice(src, a, b){ const i=src.indexOf(a), j=src.indexOf(b, i); if(i<0||j<0) throw new Error('anchor not found: '+(i<0?a:b)); return src.slice(i,j); }
function extract(src){
  const pricing=['function familyQty','function tierQty','function contractPrice','function unitPrice'].map(a=>grabDecl(src,a)).join('\n');
  const startA=src.indexOf('/* Pure. The same rule as images-api.js')>=0?'/* Pure. The same rule as images-api.js':'async function mergeCatalogEdits(slug, prods){';
  const merge=slice(src, startA, 'async function loadProducts(slug){');
  const color=slice(src, 'const COLOR_SUFFIX=', '/* ---------- render tabs');
  return pricing+'\n'+merge+'\n'+color;
}
module.exports={extract};
if(require.main===module) process.stdout.write(extract(fs.readFileSync(process.argv[2],'utf8')));
