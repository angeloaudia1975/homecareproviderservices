/* HCPS — password reset, sent by HCPS.
 *
 * Supabase will happily mail a recovery link itself, and that is what dealers were getting:
 * a bare message from a supabase.co address, with no mention of HomeCare Provider Services
 * and nothing to tell a dealer it was anything but a phishing attempt. A password email is
 * the one message a recipient is asked to trust completely, so it has to look like it came
 * from the people they do business with.
 *
 * So the link is MINTED here with the admin API and DELIVERED by us, through the same Resend
 * account and verified domain the order emails already use. Supabase never sends anything.
 *
 * POST { action:"request", email, audience:"dealer"|"staff", redirect_to }
 *   -> { ok:true, message } — always the same shape for an address that does and does not
 *      exist, so an anonymous caller cannot use this to discover who holds an account.
 *
 * THE LINK IS NEVER RETURNED TO THE CALLER. generate_link hands back a working credential —
 * anyone holding it can set that account's password. It goes to the account's own inbox and
 * nowhere else, which is the entire security model of a password reset.
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, RESEND_API_KEY, optionally HCPS_AUTH_FROM
 */
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SERVICE_ROLE   = process.env.SUPABASE_SERVICE_ROLE;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.HCPS_AUTH_FROM || "HomeCare Provider Services <hello@homecareproviderservices.us>";
const REPLY_TO = "hello@homecareproviderservices.us";
const SUPPORT_PHONE = "(855) 400-0345";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (c, o) => ({ statusCode: c,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  body: JSON.stringify(o) });

/* Only these two, and only exactly. A redirect_to is where someone lands holding a live
   recovery token, so an open list here would let anyone mint a link that delivers that token
   to a site they control. */
const PORTALS = {
  dealer: {
    label: "Partner 360",
    intro: "your HCPS Partner 360 dealer account",
    redirect: "https://hcpsonlineordering.netlify.app/reset.html",
  },
  staff: {
    label: "HCPS Sales",
    intro: "your HCPS Connect 360 staff account",
    redirect: "https://homecareproviderservices.netlify.app/admin/reset.html",
  },
};

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`,
    { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

/* Does this address hold an account of this kind? Answered here so a dealer address cannot
   trigger a staff reset, and so we never mint a link for somebody who has no business with
   the portal they asked about. The ANSWER is never revealed to the caller. */
async function accountExists(audience, email) {
  const e = encodeURIComponent(email);
  if (audience === "staff") {
    const rows = await sbGet(`staff_users?email=eq.${e}&select=email,active`);
    const s = rows && rows[0];
    return !!(s && s.active !== false);
  }
  const rows = await sbGet(`dealer_users?email=eq.${e}&select=email,status`);
  const d = rows && rows[0];
  return !!(d && String(d.status || "").toLowerCase() === "approved");
}

/* Mint a recovery link without sending Supabase's own email. */
async function generateRecoveryLink(email, redirect_to) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "recovery", email, options: { redirect_to } }),
  });
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) return { ok: false, status: r.status, error: (j.msg || j.error_description || j.error || t || "").slice(0, 200) };
  const p = (j && j.properties) || j || {};
  const link = p.action_link || p.action_link_url || null;
  if (!link) return { ok: false, status: 502, error: "no link returned" };
  return { ok: true, link };
}

function template(portal, link) {
  const L = esc(link);
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#141414">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ec">
      <tr><td style="background:#0f2440;padding:20px 26px">
        <div style="color:#fff;font-size:17px;font-weight:800;letter-spacing:.2px">HomeCare Provider Services</div>
        <div style="color:#9fb0c4;font-size:12px;margin-top:2px">${esc(portal.label)}</div></td></tr>
      <tr><td style="padding:26px">
        <div style="font-size:19px;font-weight:800;margin-bottom:10px">Reset your password</div>
        <p style="margin:0 0 16px;font-size:14.5px;line-height:1.55;color:#3c4450">
          We received a request to reset the password for ${esc(portal.intro)}.
          Choose a new one using the button below.</p>
        <p style="margin:0 0 22px"><a href="${L}"
          style="display:inline-block;background:#ef6325;color:#fff;text-decoration:none;padding:13px 22px;border-radius:9px;font-weight:700;font-size:15px">Set a new password</a></p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#6b7580">
          This link can only be used once, and expires a short time from now. If it has already
          expired, return to ${esc(portal.label)} and choose “Forgot password?” again.</p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#6b7580">
          <b>Didn't ask for this?</b> You can ignore this email — your password has not changed.
          If you'd like to tell us about it, call ${esc(SUPPORT_PHONE)}.</p>
        <p style="margin:0;font-size:12px;line-height:1.5;color:#98a1ad;word-break:break-all">
          If the button doesn't work, paste this into your browser:<br>${L}</p>
      </td></tr>
      <tr><td style="background:#fafbfc;padding:14px 26px;border-top:1px solid #eef0f3;font-size:12px;color:#8a94a6">
        HomeCare Provider Services · ${esc(SUPPORT_PHONE)} · hello@homecareproviderservices.us</td></tr>
    </table></td></tr></table></body></html>`;
  const text = `Reset your password — HomeCare Provider Services (${portal.label})

We received a request to reset the password for ${portal.intro}.

Set a new password:
${link}

This link can only be used once and expires a short time from now. If it has expired,
return to ${portal.label} and choose "Forgot password?" again.

Didn't ask for this? Ignore this email — your password has not changed.
Questions: ${SUPPORT_PHONE} or hello@homecareproviderservices.us`;
  return { subject: `Reset your ${portal.label} password`, html, text };
}

async function sendViaResend(to, built) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, reply_to: REPLY_TO,
      subject: built.subject, html: built.html, text: built.text }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, id: d.id || null,
    error: r.ok ? null : String((d && (d.message || d.name)) || r.status).slice(0, 200) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, message: "method not allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, message: "Auth service not configured." });
  if (!RESEND_API_KEY) return json(500, { ok: false, message: "Email service not configured." });

  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, message: "bad JSON" }); }
  if (b.action !== "request") return json(400, { ok: false, message: "unknown action" });

  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200, { ok: false, message: "Enter a valid email address." });

  const audience = b.audience === "staff" ? "staff" : "dealer";
  const portal = PORTALS[audience];

  /* The one message an anonymous caller ever sees on the happy path. Identical whether or
     not the address holds an account: this endpoint must not become a way to find out who
     HCPS's dealers are. */
  const generic = { ok: true, sent: true,
    message: `If that email has ${audience === "staff" ? "a staff" : "a dealer"} account, a reset link is on its way from hello@homecareproviderservices.us. Check your inbox, and your spam folder.` };

  let exists = false;
  try { exists = await accountExists(audience, email); }
  catch (e) { return json(200, { ok: false, message: "Couldn't reach the account service. Please try again." }); }
  if (!exists) return json(200, generic);          // nothing minted, nothing sent

  const g = await generateRecoveryLink(email, portal.redirect);
  if (!g.ok) {
    /* A provider failure is not a secret, and hiding it is what made this impossible to
       diagnose from the outside. Account existence stays hidden; this does not. */
    if (g.status === 429) return json(200, { ok: false, rate_limited: true,
      message: "Too many reset requests just now. Wait a few minutes and try again." });
    return json(200, { ok: false, message: `Couldn't create the reset link (${g.status}). Nothing was sent — please try again, or call ${SUPPORT_PHONE}.` });
  }

  const sent = await sendViaResend(email, template(portal, g.link));
  if (!sent.ok) return json(200, { ok: false,
    message: `Couldn't send the reset email (${sent.status}). Nothing arrived — please try again, or call ${SUPPORT_PHONE}.` });

  return json(200, generic);
};

/* Exported for the test suite; the handler above is what Netlify runs. */
exports._internals = { PORTALS, template, accountExists, generateRecoveryLink, esc };
