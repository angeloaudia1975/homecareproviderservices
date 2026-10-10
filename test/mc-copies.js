/* Regenerates (or, with --check, verifies) the two verbatim copies Manufacturer Center verification
   runs on the server:
     netlify/functions/_shop_render.js  ← homecareproviderservicesordering/public/index.html
     netlify/functions/_hcps_email.js   ← homecareproviderservicesordering/netlify/functions/submit-order.js
   Never edit those files by hand: change the storefront and re-run  node test/mc-copies.js  */
const fs=require('fs'), path=require('path');
const EX=require(path.join(__dirname,'..','netlify','functions','_extract.js'));
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const OUT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const HEAD={
  render:`/* THE STOREFRONT'S PRODUCT-CARD AND FREIGHT-BOX WORDS, VERBATIM (Manufacturer Center, 2026-10-10).
   SOURCE is the exact text of Partner 360's money / esc / packOf / packNote / tierLadder /
   PRICE_NOTE_* / dealerPriceNote / priceHtml / freightRowsHtml, copied from
   homecareproviderservicesordering/public/index.html by test/mc-copies.js. mc_verify renders every
   product card and freight box with THIS text, and re-extracts it from the live storefront page on
   every run: a mismatch fails the verification. Never edit here — change the shop and re-copy. */
`,
  email:`/* THE HCPS ORDER EMAIL BUILDER, VERBATIM (Manufacturer Center, 2026-10-10).
   SOURCE is the exact text of submit-order.js from "const r2" through buildEmail (pure functions —
   no handler, no network), copied by test/mc-copies.js so mc_verify can render the email HCPS
   receives without sending anything. test/mcverify.test.js fails if the ordering site's file and
   this copy differ. Never edit here — change submit-order.js and re-copy. */
`};
function build(){
  const html=fs.readFileSync(path.join(SHOPD,'public','index.html'),'utf8');
  const sub=fs.readFileSync(path.join(SHOPD,'netlify','functions','submit-order.js'),'utf8');
  return {
    '_shop_render.js': HEAD.render+'module.exports = { SOURCE: '+JSON.stringify(EX.extractRender(html))+' };\n',
    '_hcps_email.js':  HEAD.email+'module.exports = { SOURCE: '+JSON.stringify(EX.extractHcpsEmail(sub))+' };\n'};
}
module.exports={build};
if(require.main===module){
  const want=build(); let bad=0;
  for(const [f,txt] of Object.entries(want)){ const p=path.join(OUT,f);
    if(process.argv.includes('--check')){ const have=fs.existsSync(p)?fs.readFileSync(p,'utf8'):''; if(have!==txt){ console.log('STALE '+f); bad++; } else console.log('ok    '+f); }
    else { fs.writeFileSync(p,txt); console.log('wrote '+f); } }
  process.exit(bad?1:0);
}
