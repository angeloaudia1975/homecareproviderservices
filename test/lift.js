/* Lift real declarations out of catalog-api.js by anchor, so the tests execute
   the shipped code rather than a paraphrase of it. */
const fs = require('fs');

/* Repo-relative by default so this runs from a clone; CATALOG_API overrides it. */
const SRC = process.env.CATALOG_API
  || require('path').join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js');

function block(src, startIdx){
  // from startIdx, find first '{' then match braces (skipping strings/comments/regex-ish)
  let i = src.indexOf('{', startIdx);
  if(i < 0) throw new Error('no brace after anchor');
  let depth = 0, inS = null, inLine = false, inBlock = false;
  for(; i < src.length; i++){
    const c = src[i], n = src[i+1], p = src[i-1];
    if(inLine){ if(c === '\n') inLine = false; continue; }
    if(inBlock){ if(c === '*' && n === '/'){ inBlock = false; i++; } continue; }
    if(inS){ if(c === '\\'){ i++; continue; } if(c === inS) inS = null; continue; }
    if(c === '/' && n === '/'){ inLine = true; i++; continue; }
    if(c === '/' && n === '*'){ inBlock = true; i++; continue; }
    if(c === '"' || c === "'" || c === '`'){ inS = c; continue; }
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0) return i; }
  }
  throw new Error('unbalanced');
}

/* One anchor form for both `function f(){}` and `const f = v => {}` / `const K = 2;`.
   A declaration whose body opens a brace before the statement's first semicolon
   is brace-matched; anything else runs to that semicolon. */
/* Skip the parameter list before looking for the body.
   `function reconcileSkus({ slug, base, ... }){` opens a brace in its own
   signature, so brace-matching from the first '{' returns the destructuring
   pattern and 63 characters of function. The body starts after the parens. */
function afterParams(src, from){
  let i = src.indexOf('(', from);
  if(i < 0) return from;
  let depth = 0;
  for(; i < src.length; i++){
    if(src[i] === '(') depth++;
    else if(src[i] === ')'){ depth--; if(depth === 0) return i; }
  }
  throw new Error('unbalanced parameter list');
}

function liftDecl(src, name){
  const re = new RegExp('^(?:function|const)\\s+' + name + '\\b', 'm');
  const m = re.exec(src);
  if(!m) throw new Error('anchor not found: ' + name);

  const isFn = src.slice(m.index, m.index + 8) === 'function';
  const arrow = isFn ? -1 : src.indexOf('=>', m.index);
  const semi  = src.indexOf(';', m.index);

  let bodyFrom;
  if(isFn)                                   bodyFrom = afterParams(src, m.index);
  else if(arrow >= 0 && (semi < 0 || arrow < semi)) bodyFrom = arrow;
  else {
    if(semi < 0) throw new Error('unterminated declaration: ' + name);
    return src.slice(m.index, semi + 1);     // plain value, e.g. a constant
  }

  const brace = src.indexOf('{', bodyFrom);
  const nextSemi = src.indexOf(';', bodyFrom);
  if(brace < 0 || (nextSemi >= 0 && nextSemi < brace))
    return src.slice(m.index, nextSemi + 1); // concise arrow body, no braces

  const end = block(src, bodyFrom);
  const tail = src.indexOf(';', end);
  return src.slice(m.index, (tail >= 0 && tail <= end + 2) ? tail + 1 : end + 1);
}
const liftFn = liftDecl, liftConst = liftDecl;

function load(source){
  const src = source !== undefined ? source : fs.readFileSync(SRC, 'utf8');
  const parts = [
    liftDecl(src, 'MSRP_MULTIPLIER'),
    liftDecl(src, 'PRICE_NOTE_OPERATIONAL'),
    liftDecl(src, 'num'),
    liftDecl(src, 'cleanTiers'),
    liftDecl(src, 'normCode'),
    liftDecl(src, 'dealerVisibleNote'),
    liftDecl(src, 'reconcileSkus'),
    liftDecl(src, 'applyResolutions'),
  ];
  const code = parts.join('\n\n') + '\n;module.exports={reconcileSkus,applyResolutions,MSRP_MULTIPLIER,cleanTiers,num};';
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
  return mod.exports;
}

module.exports = { load, liftFn, liftConst, SRC, raw: () => fs.readFileSync(SRC, 'utf8') };
