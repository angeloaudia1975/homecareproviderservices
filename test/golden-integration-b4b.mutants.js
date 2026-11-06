/* Mutation check for test/golden-integration-b4b.test.js — each mutant breaks one rule of the B4b ship-to / validate-only
   surface on the HCPS side; the test must FAIL on each and PASS on the control.   node test/golden-integration-b4b.mutants.js */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','answer for another quote accepted','if(String(q.quote_hash) !== String(sentHash)) return null;',''],
  ['golden-proxy.js','answer lines not all-or-nothing','if(raw.length > QUOTE_MAX_LINES || raw.length !== q.lines.length || raw.some(l => !l || !lineSkuOk(l))) return null;','if(raw.length > QUOTE_MAX_LINES) return null;'],
  ['golden-proxy.js','request_id passed through unchecked','const reqId = v => (typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v)) ? v : null;','const reqId = v => v || null;'],
  ['golden-proxy.js','invisible characters allowed','  if(TXT_INVISIBLE.test(t)) return null;\n',''],
  ['golden-proxy.js','staff view-as token on the production ordering path','if(who.preview && (action === "validate_order" || action === "history" || action === "order")) return json(403','if(who.preview && (action === "history" || action === "order")) return json(403'],
  ['golden-proxy.js','CRLF notes refused','(multiline ? v.replace(/\\r\\n?/g, "\\n") : v)','v'],
  ['golden-proxy.js','Golden internal error not mapped to a retry','internal:"temporarily_unavailable", prices_not_visible:"prices_not_visible",','prices_not_visible:"prices_not_visible",'],
  ['golden-proxy.js','Call for Quote validation not named','freight_quote_required:"freight_quote_required", freight_quote_ack_required:','freight_quote_ack_required:'],
  ['golden-proxy.js','checkout switch ignored','if((action === "validate_order" || ordering) && f.golden_p360_checkout !== true) return','if(false) return'],
  ['golden-proxy.js','idempotency key not required','if(typeof b.idempotency_key !== "string" || !IDEM_RE.test(b.idempotency_key)) return json(400','if(false) return json(400'],
  ['golden-proxy.js','markup allowed in notes','if(multiline ? /[<>\\u0000-\\u0009\\u000B-\\u001F\\u007F]/.test(t) : TXT_BAD.test(t)) return null;','if(!multiline && TXT_BAD.test(t)) return null;'],
  ['golden-proxy.js','more names than units','raw.reference_names.length > l.qty','raw.reference_names.length > 99'],
  ['golden-proxy.js','phone not checked','!/^[0-9+().\\- xX]{7,30}$/.test(phone) ||',''],
  ['golden-proxy.js','prices_changed shown as valid','valid:false, reason:"prices_changed"','valid:true, reason:"prices_changed"'],
  ['golden-proxy.js','ordering_enabled not checked','|| typeof g.ordering_enabled !== "boolean") return null;',') return null;'],
  ['golden-proxy.js','Golden ordering flag shown without the HCPS switch','v.ordering_enabled = v.ordering_enabled === true && hcpsOrdering;','v.ordering_enabled = v.ordering_enabled === true;'],
  ['golden-proxy.js','unknown fields from Golden passed','order: { po_number: str(o.po_number, 30) || ""','order: { ...o, po_number: str(o.po_number, 30) || ""'],
  ['golden-proxy.js','desk address passed','golden_order: { recipient: go.recipient === "test_recipient" ? "test_recipient" : "golden_order_desk", recipient_configured','golden_order: { recipient: go.to || "golden_order_desk", to: go.to, recipient_configured'],
  ['golden-proxy.js','ship-to ids unchecked','const cleanShip = x => (x && typeof x === "object" && SHIP_ID_RE.test(String(x.id)))','const cleanShip = x => (x && typeof x === "object")'],
  ['golden-proxy.js','validation not sent as POST','method: (action === "quote" || action === "validate_order" || ordering) ? "POST" : "GET"','method: (action === "quote" || ordering) ? "POST" : "GET"'],
  ['golden-proxy.js','Golden message echoed as the field','        const field = FIELD_RE.test(msg) ? msg : "order";\n        return json(200, Object.assign({ ok:true, enabled:true, available:true, valid:false','        const field = msg || "order";\n        return json(200, Object.assign({ ok:true, enabled:true, available:true, valid:false'],
  ['_golden_client.js','key not sent','    headers["Idempotency-Key"] = String(idempotencyKey);','    void 0;'],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b4b.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);
