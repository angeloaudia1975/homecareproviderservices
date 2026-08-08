// HCPS email unsubscribe — PUBLIC (no auth). The link in every re-engagement email points
// here; clicking it records an opt-out so we never email that contact again. Records to the
// email_optout table (service-role) and returns a simple confirmation page.
//   GET /.netlify/functions/unsubscribe?e=<email>&d=<dealer_id>
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

function page(title, msg){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;background:#eef1f4;color:#1b2733;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .c{background:#fff;border:1px solid #e2e6ea;border-radius:16px;padding:34px 30px;max-width:460px;text-align:center;box-shadow:0 10px 30px rgba(16,38,63,.08)}
  .m{width:46px;height:46px;border-radius:12px;background:#F5821F;color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
  h1{font-size:21px;margin:0 0 8px;color:#10263f}p{color:#41576b;font-size:14px;line-height:1.6;margin:0}</style></head>
  <body><div class="c"><div class="m">H</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}
const html = (code, body)=>({statusCode:code,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"},body});

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return html(500,page("Something went wrong","Please try again later."));
    const q=event.queryStringParameters||{};
    const email=String(q.e||"").trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return html(400,page("Invalid link","This unsubscribe link is missing a valid email address."));
    const row={ email, dealer_id:(q.d&&/^[0-9a-f-]{10,}$/i.test(q.d))?q.d:null, reason:"one-click unsubscribe" };
    try{
      await fetch(`${SUPABASE_URL}/rest/v1/email_optout?on_conflict=email`,{method:"POST",
        headers:{...H(),"content-type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},
        body:JSON.stringify(row)});
    }catch(e){}
    return html(200,page("You're unsubscribed","You won't receive any more marketing emails from HomeCare Provider Services at this address. Order confirmations and account emails are unaffected. If this was a mistake, just reply to any HCPS email and we'll add you back."));
  }catch(e){ return html(500,page("Something went wrong","Please try again later.")); }
};
