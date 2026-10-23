/* P0 SECURITY (2026-10-23, issue #2) — COMMERCIAL FIELDS NEVER SHIP IN A PUBLIC FILE.

   The static catalog files (public/data/<slug>.json) used to carry every dealer price: base
   price, quantity breaks, Access4U's dealer / tier prices, MAP, MSRP, price notes that spell the
   breaks out in dollars, Corsicana's per-item shipping charges. Anyone could download them.

   They are now split in two:
     · the PUBLIC file keeps everything that is not commercial (code, name, category, image,
       description, group, family, HCPCS, UOM, pack size, attributes, links …);
     · the COMMERCIAL overlay — one entry per row, keyed by part number + its occurrence on the
       line (Access4U sells SR3 and PRK twice, in two ramp families) — lives in a private table
       (catalog_file_commercial, RLS on, no policies, service role only) and reaches a dealer only
       through the signed-in, entitlement-checked catalog-layers function.

   restoreCatalogFile() puts the two halves back together. It is the SAME text in three places:
   this module, the storefront page (public/index.html, inside the engine the server copies
   verbatim) and the admin site's copy of this module. test/p0commercial.test.js fails the moment
   the page and this module differ.
   THIS FILE is the admin site's copy of homecareproviderservicesordering/netlify/functions/
   _catalog_commercial.js — never edit it here; test/pricing-parity.test.js fails if the two differ
   anywhere but this paragraph.

   Restoring is strict and the overlay is the only source of commercial facts: a commercial key
   still present on a public row is DROPPED, never trusted, so a stale public copy can never
   reach a dealer. A missing or extra row is a mismatch (thrown), never "no price".
   Pure: no I/O. */

const CATALOG_COMMERCIAL_KEYS=["base_price","tiers","dealer_price","tier_prices","msrp","map","price_note","unit_cost","shipping"];

/* Each row's stable key: its part number and which occurrence of that part number it is. */
function catalogRowKeys(rows){
  const seen={};
  return (rows||[]).map(r=>{ const c=String(r&&r.code!=null?r.code:''); const n=seen[c]=(seen[c]||0)+1; return c+'#'+(n-1); });
}

/* Split a full catalog file into its public half and its commercial overlay. The overlay keeps
   the row's original key order, so restoring gives back the file byte for byte. */
function splitCatalogFile(rows){
  if(!Array.isArray(rows)) throw new Error('catalog file is not a list');
  const keys=catalogRowKeys(rows), pub=[], overlay=[];
  rows.forEach((r,i)=>{
    const p={}, f={}, order=Object.keys(r||{});
    order.forEach(k=>{ if(CATALOG_COMMERCIAL_KEYS.indexOf(k)>=0) f[k]=r[k]; else p[k]=r[k]; });
    pub.push(p); overlay.push({k:keys[i], order, f});
  });
  return { public: pub, overlay };
}

function restoreCatalogFile(rows, overlay){
  if(!Array.isArray(rows)) throw new Error('catalog_file_mismatch: the public catalog file is not a list');
  if(!Array.isArray(overlay) || overlay.length!==rows.length)
    throw new Error('catalog_file_mismatch: '+rows.length+' public row(s), '+(Array.isArray(overlay)?overlay.length:'no')+' commercial row(s)');
  const by={};
  overlay.forEach(o=>{ if(o && o.k!=null) by[String(o.k)]=o; });
  if(Object.keys(by).length!==overlay.length) throw new Error('catalog_file_mismatch: the commercial rows are not one per catalog row');
  const seen={};
  return rows.map(r=>{
    const c=String(r&&r.code!=null?r.code:''); const n=seen[c]=(seen[c]||0)+1; const k=c+'#'+(n-1);
    const o=by[k];
    if(!o) throw new Error('catalog_file_mismatch: no commercial row for '+k);
    const f=(o.f && typeof o.f==='object') ? o.f : {};
    const out={};
    (Array.isArray(o.order)?o.order:[]).forEach(key=>{
      if(CATALOG_COMMERCIAL_KEYS.indexOf(key)>=0){ if(key in f) out[key]=f[key]; }
      else if(r && key in r) out[key]=r[key];
    });
    Object.keys(r||{}).forEach(key=>{ if(!(key in out) && CATALOG_COMMERCIAL_KEYS.indexOf(key)<0) out[key]=r[key]; });
    Object.keys(f).forEach(key=>{ if(!(key in out) && CATALOG_COMMERCIAL_KEYS.indexOf(key)>=0) out[key]=f[key]; });
    return out;
  });
}

/* Does anything in this value carry a commercial key, at any depth? Used by the static-asset scan
   and by the seed tool's refusal to publish a file that still holds prices. */
function commercialKeysIn(v, path, out){
  out=out||[]; path=path||'';
  if(Array.isArray(v)) v.forEach((x,i)=>commercialKeysIn(x, path+'['+i+']', out));
  else if(v && typeof v==='object') Object.keys(v).forEach(k=>{
    if(CATALOG_COMMERCIAL_KEYS.indexOf(k)>=0) out.push(path+'.'+k);
    commercialKeysIn(v[k], path+'.'+k, out);
  });
  return out;
}

module.exports = { CATALOG_COMMERCIAL_KEYS, catalogRowKeys, splitCatalogFile, restoreCatalogFile, commercialKeysIn };
