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

   Each overlay entry also carries `h`, its public row's identity fingerprint, and the stored record
   carries the line's identity (catalogIdentity of the public file): a commercial row is applied only
   to the exact public row it was made for, and only the record whose identity equals the deployed
   file's is used (P0 review, 2026-10-23 — never a positional match across versions).

   restoreCatalogFile() puts the two halves back together. It — with the identity helpers above it —
   is the SAME text in three places: this module, the storefront page (public/index.html, inside the engine the server copies
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
/* ROW IDENTITY (P0 review, 2026-10-23). A commercial row is attached to a public row ONLY when the
   public row is exactly the row it was made for: every commercial entry carries `h`, the SHA-256 of
   its public row's non-commercial fields (canonical JSON, keys sorted), and the whole line carries
   its identity — the SHA-256 of those fingerprints in file order. A reordered duplicate part number,
   a changed name / family / group / image with the same part numbers and row count, a public file
   newer or older than the commercial record, or an entry with no fingerprint: refused, never matched
   by position. Pure JS (sync, no crypto API) so the browser, the server engine copy and the tools
   compute the same value. */
function catalogSha256(str){
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const m=new TextEncoder().encode(String(str)), l=m.length, n=((l+9+63)>>6)<<6, b=new Uint8Array(n);
  b.set(m); b[l]=0x80;
  const dv=new DataView(b.buffer); dv.setUint32(n-8,Math.floor(l/0x20000000)); dv.setUint32(n-4,(l*8)>>>0);
  const H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w=new Array(64);
  for(let o=0;o<n;o+=64){
    for(let i=0;i<16;i++) w[i]=dv.getUint32(o+i*4);
    for(let i=16;i<64;i++){ const x=w[i-15], y=w[i-2];
      w[i]=(w[i-16]+(((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3))+w[i-7]+(((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10)))|0; }
    let a=H[0],c1=H[1],c2=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(let i=0;i<64;i++){
      const t1=(h+(((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)))+((e&f)^(~e&g))+K[i]+w[i])|0;
      const t2=((((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)))+((a&c1)^(a&c2)^(c1&c2)))|0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c2; c2=c1; c1=a; a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+c1)|0; H[2]=(H[2]+c2)|0; H[3]=(H[3]+d)|0; H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  return H.map(x=>('00000000'+(x>>>0).toString(16)).slice(-8)).join('');
}
function catalogCanon(v){
  if(Array.isArray(v)) return '['+v.map(catalogCanon).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+catalogCanon(v[k])).join(',')+'}';
  return JSON.stringify(v===undefined?null:v);
}
/* A row's identity fingerprint: its non-commercial fields only (the public half — the same value
   whether the row still carries prices or not). */
function catalogRowPrint(r){
  const p={};
  if(r && typeof r==='object' && !Array.isArray(r)) Object.keys(r).forEach(k=>{ if(CATALOG_COMMERCIAL_KEYS.indexOf(k)<0) p[k]=r[k]; });
  return catalogSha256(catalogCanon(p));
}
/* A catalog file's identity (its version): the fingerprints of its rows, in file order. */
function catalogIdentity(rows){
  return catalogSha256((Array.isArray(rows)?rows:[]).map(catalogRowPrint).join('\n'));
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
    if(typeof o.h!=='string' || !/^[0-9a-f]{64}$/.test(o.h)) throw new Error('catalog_file_mismatch: the commercial row for '+k+' has no identity fingerprint');
    if(catalogRowPrint(r)!==o.h) throw new Error('catalog_file_mismatch: '+k+' is not the catalog row its commercial row was made for');
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
    pub.push(p); overlay.push({k:keys[i], h:catalogRowPrint(r), order, f});
  });
  return { public: pub, overlay };
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

/* Is this stored commercial record internally sound? Every entry has a key, an identity fingerprint,
   a key order and its fields; the keys are one per row; and the record's identity_sha256 is exactly the
   SHA-256 of its fingerprints in order (the database trigger checks the same). Used by catalog-layers
   and the admin server before a record is ever applied. */
function validOverlayRecord(rec){
  if(!rec || typeof rec!=='object' || !Array.isArray(rec.rows)) return false;
  if(typeof rec.identity_sha256!=='string' || !/^[0-9a-f]{64}$/.test(rec.identity_sha256)) return false;
  const keys=new Set();
  for(const o of rec.rows){
    if(!o || typeof o.k!=='string' || keys.has(o.k)) return false;
    if(typeof o.h!=='string' || !/^[0-9a-f]{64}$/.test(o.h)) return false;
    if(!Array.isArray(o.order) || !o.f || typeof o.f!=='object' || Array.isArray(o.f)) return false;
    keys.add(o.k);
  }
  return catalogSha256(rec.rows.map(o=>o.h).join('\n'))===rec.identity_sha256;
}

/* The one record of this line that belongs to THIS public file: the row whose identity equals the
   file's identity. Several versions may be stored side by side (the next one is seeded before the
   storefront that publishes it is deployed); a file with no matching version is NOT priced. */
function recordForFile(rows, recs){
  const id=catalogIdentity(rows);
  const list=Array.isArray(recs)?recs:[];
  return { identity: id, record: list.find(r=>r && r.identity_sha256===id) || null, versions: list.length };
}

module.exports = { CATALOG_COMMERCIAL_KEYS, catalogSha256, catalogCanon, catalogRowPrint, catalogIdentity,
  catalogRowKeys, splitCatalogFile, restoreCatalogFile, commercialKeysIn, validOverlayRecord, recordForFile };
