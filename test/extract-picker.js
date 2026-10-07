/* Pull the storefront's picker functions out of the shop page VERBATIM, in page order. */
const fs=require('fs');
const NAMES=['function groupKeyOf','function groupDisplayName','function stripProductPrefix','function variantLabel','const VARIANT_SIZE_RANK','function variantSizeRank',
 'const OPTION_COLORS','const OPTION_COLOR_COMPOUNDS','const OPTION_SIDES','function titleWord','function optionTokens','function optionAxesOf',
 'const AXIS_ORDER','function optionAxes(','function resolveVariant','function sortVariants'];
function grabDecl(src, anchor){
  const i=src.indexOf('\n'+anchor); if(i<0) throw new Error('anchor not found: '+anchor);
  const st=i+1;
  // a const ends at the first ';' at bracket depth 0; a function at its matching brace
  let j=st, depth=0, inS=null, started=false;
  for(;j<src.length;j++){ const c=src[j], n=src[j+1];
    if(inS){ if(c==='\\'){j++;continue;} if(c===inS) inS=null; continue; }
    if(c==='/'&&n==='*'){ const e=src.indexOf('*/',j+2); j=e+1; continue; }
    if(c==='/'&&n==='/'){ const e=src.indexOf('\n',j); j=e; continue; }
    if(c==='"'||c==="'"||c==='`'){ inS=c; continue; }
    if(c==='/'&&anchor.startsWith('function')&&started){ /* regex literal: skip to next unescaped / on the line */
      const prev=src.slice(Math.max(0,j-3),j).trim().slice(-1);
      if('(,=:[!&|?{};'.includes(prev)||prev===''){ let k=j+1, cls=false; for(;k<src.length;k++){ const d=src[k]; if(d==='\\'){k++;continue;} if(d==='[')cls=true; else if(d===']')cls=false; else if(d==='/'&&!cls) break; if(d==='\n') break; } j=k; continue; } }
    if(c==='('||c==='['||c==='{'){ depth++; started=true; }
    else if(c===')'||c===']'||c==='}'){ depth--; if(depth===0 && c==='}' && anchor.startsWith('function')){ return src.slice(st,j+1); } }
    else if(c===';'&&depth===0&&anchor.startsWith('const')) return src.slice(st,j+1);
  }
  throw new Error('unterminated: '+anchor);
}
function extract(src){ return NAMES.map(a=>grabDecl(src,a)).join('\n'); }
module.exports={extract,NAMES};
if(require.main===module){ const src=fs.readFileSync(process.argv[2],'utf8'); process.stdout.write(extract(src)); }
