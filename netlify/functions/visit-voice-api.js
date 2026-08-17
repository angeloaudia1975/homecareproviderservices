// HCPS — Scheduled Routes voice visit notes. Rep speaks a summary after a dealer visit; this
// endpoint (1) transcribes the audio with Deepgram (brand names boosted with the dealer's own
// manufacturer/product vocabulary) and (2) has Claude turn the transcript into structured CRM
// fields the rep reviews before saving. NOTHING is written to the CRM here — the mobile page
// pre-fills the visit form, the rep edits, and the existing visit_report_save does the write.
//
//   POST {action:"transcribe", dealer_id, audio_base64, mime?}  -> { ok, transcript, fields, structured }
//   POST {action:"structure",  dealer_id, transcript }          -> { ok, transcript, fields, structured }
//        (structure = skip Deepgram; use text from the device's own dictation)
//
// Env: DEEPGRAM_API_KEY (speech-to-text), ANTHROPIC_API_KEY (structuring), HCPS_AI_MODEL.
// Auth: staff who may access the dealer (management/relations = all; rep = own book).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DG_KEY = process.env.DEEPGRAM_API_KEY || "";
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.HCPS_AI_MODEL || "claude-sonnet-5";

const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
const { dealerScope, isAdmin } = require("./_scope.js");

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,rep_name,name,active`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } } }catch(e){}
  }
  return null;
}

// Deepgram transcription. Nova-3 with keyterm prompting so proprietary brand/product names come
// through clean. Accepts raw audio bytes (the recorded blob).
async function deepgramTranscribe(buf, mime, keyterms){
  const qs=new URLSearchParams({model:"nova-3",smart_format:"true",punctuate:"true"});
  let url="https://api.deepgram.com/v1/listen?"+qs.toString();
  for(const k of (keyterms||[]).slice(0,90)){ const t=String(k||"").trim(); if(t) url+="&keyterm="+encodeURIComponent(t); }
  const r=await fetch(url,{method:"POST",headers:{Authorization:"Token "+DG_KEY,"Content-Type":mime||"audio/webm"},body:buf});
  const j=await r.json().catch(()=>null);
  if(!r.ok){ const m=(j&&(j.err_msg||j.error||j.reason))||`HTTP ${r.status}`; throw new Error("deepgram: "+String(m).slice(0,180)); }
  const alt=j&&j.results&&j.results.channels&&j.results.channels[0]&&j.results.channels[0].alternatives&&j.results.channels[0].alternatives[0];
  return (alt&&alt.transcript)||"";
}

async function structure(transcript, mfrs, products){
  const mfrList=mfrs.map(m=>`- ${m.name} [${m.slug}]`).join("\n");
  const prodList=products.slice(0,120).map(p=>`- ${p}`).join("\n");
  const prompt=`You convert a sales rep's spoken dealer-visit summary into structured CRM data for HomeCare Provider Services (HCPS), a manufacturers' rep group selling home-medical-equipment lines to DME dealers.

The rep dictated this after leaving the dealer. Transcription can mis-hear proprietary brand/product names — correct them to the KNOWN lists below when a close match is clear (e.g. "bongo rx" -> BongoRx, "ergo steel" -> ErgoSteel, "core sicana" -> Corsicana). Never invent facts, numbers, products, or names that aren't in the transcript.

KNOWN MANUFACTURERS (name [slug]):
${mfrList||"(none on file)"}

PRODUCTS THIS DEALER HAS BOUGHT (for name correction):
${prodList||"(none on file)"}

TRANSCRIPT:
"""${transcript}"""

Return ONLY a JSON object with exactly these keys (use "" or [] when unknown):
  "purpose": short purpose of the visit,
  "manufacturers": array of manufacturer display names discussed,
  "products": array of product names presented/shown,
  "interest": array of products or lines the dealer showed interest in,
  "concerns": dealer questions/concerns/objections (string),
  "competitive": competitive info mentioned (string),
  "opportunities": array of concrete opportunities (e.g. "2 ErgoSteel chairs — needs pricing"),
  "followups": array of follow-up actions promised or needed (each becomes a task),
  "notes": any other useful context (string),
  "next_action": the single most important next step (string),
  "next_action_date": a date in YYYY-MM-DD if the rep named one (e.g. "next Tuesday" -> that date relative to today ${new Date().toISOString().slice(0,10)}), else "",
  "manufacturers_slugs": array of KNOWN slugs for manufacturers discussed,
  "interest_slugs": array of KNOWN slugs the dealer showed interest in,
  "poor_fit_slugs": array of KNOWN slugs the rep explicitly said are NOT a good fit for this dealer (only when clearly stated).
Do not include markdown or any text outside the JSON.`;
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
    headers:{"x-api-key":AI_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
    body:JSON.stringify({model:AI_MODEL,max_tokens:1200,messages:[{role:"user",content:prompt}]})});
  const t=await r.text(); if(!r.ok){ let hint=""; try{ const ej=JSON.parse(t); hint=ej&&ej.error&&ej.error.message?` (${ej.error.message})`:""; }catch(_){}
    throw new Error(`ai_error${hint}`); }
  let j={}; try{ j=JSON.parse(t); }catch(_){}
  // Concatenate every text block — newer models may emit a reasoning block before the text one.
  let text=""; for(const c of ((j&&j.content)||[])){ if(c&&typeof c.text==="string") text+=c.text; }
  const s=text.indexOf("{"), e=text.lastIndexOf("}");
  if(s<0||e<0) return null;
  try{ return JSON.parse(text.slice(s,e+1)); }catch(_){ return null; }
}

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
    const dealerId=String(b.dealer_id||"").trim(); if(!dealerId) return json(400,{error:"dealer_id required"});
    // Access: management/relations anywhere; a rep only for their own book.
    if(!isAdmin(me)){
      const sc=await dealerScope(me, sbGet);
      if(!sc.isAll && !(sc.ids && sc.ids.has(dealerId))) return json(403,{error:"Not your dealer"});
    }

    // Dealer vocabulary for brand-name accuracy (keyterms + Claude correction context).
    let mfrs=[]; try{ mfrs=await sbGet("manufacturers?select=slug,name"); }catch(e){ mfrs=[]; }
    mfrs=(mfrs||[]).filter(m=>m&&m.slug);
    let products=[];
    try{ const rows=await sbGet(`monthly_sales?dealer_id=eq.${encodeURIComponent(dealerId)}&select=product_name&limit=600`);
      products=[...new Set((rows||[]).map(r=>String(r.product_name||"").trim()).filter(Boolean))]; }catch(e){ products=[]; }
    const keyterms=[...new Set([].concat(mfrs.map(m=>m.name), products))].filter(Boolean);

    let transcript = String(b.transcript||"").trim();

    if(b.action==="transcribe"){
      if(!DG_KEY) return json(200,{ok:false,error:"deepgram_unavailable",message:"Voice transcription isn't enabled yet — add DEEPGRAM_API_KEY in Netlify and redeploy. You can still type notes."});
      const b64=String(b.audio_base64||"").replace(/^data:[^;]+;base64,/,"");
      if(!b64) return json(400,{error:"audio_base64 required"});
      let buf; try{ buf=Buffer.from(b64,"base64"); }catch(e){ return json(400,{error:"bad audio"}); }
      if(!buf.length) return json(400,{error:"empty audio"});
      try{ transcript=await deepgramTranscribe(buf, b.mime||"audio/webm", keyterms); }
      catch(e){ return json(200,{ok:false,error:"transcribe_failed",message:String(e.message||e)}); }
      if(!transcript.trim()) return json(200,{ok:false,error:"no_speech",message:"Didn't catch any speech — try recording again, closer and a bit slower."});
    } else if(b.action!=="structure"){
      return json(400,{error:"unknown action"});
    }
    if(!transcript.trim()) return json(400,{error:"transcript required"});

    if(!AI_KEY) return json(200,{ok:true,transcript,fields:{notes:transcript},structured:{},message:"Transcribed. AI structuring is off (set ANTHROPIC_API_KEY) — dropped the transcript into notes."});
    let obj=null; try{ obj=await structure(transcript, mfrs, products); }
    catch(e){ return json(200,{ok:true,transcript,fields:{notes:transcript},structured:{},message:"Transcribed, but couldn't auto-structure — review the transcript in notes. ("+String(e.message||e)+")"}); }
    if(!obj) return json(200,{ok:true,transcript,fields:{notes:transcript},structured:{},message:"Transcribed; auto-structuring returned nothing usable — transcript is in notes."});

    const arr=v=>Array.isArray(v)?v.filter(Boolean):(v?[String(v)]:[]);
    const str=v=>v==null?"":String(v);
    const fields={
      purpose:str(obj.purpose), manufacturers:arr(obj.manufacturers).join(", "), products:arr(obj.products).join(", "),
      interest:arr(obj.interest).join(", "), concerns:str(obj.concerns), competitive:str(obj.competitive),
      opportunities:arr(obj.opportunities).join("\n"), followups:arr(obj.followups).join("\n"),
      notes:str(obj.notes), next_action:str(obj.next_action),
      next_action_date:(/^\d{4}-\d{2}-\d{2}$/.test(str(obj.next_action_date))?obj.next_action_date:"")
    };
    const structured={
      manufacturers_slugs:arr(obj.manufacturers_slugs), interest_slugs:arr(obj.interest_slugs), poor_fit_slugs:arr(obj.poor_fit_slugs)
    };
    return json(200,{ok:true, transcript, fields, structured});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};
