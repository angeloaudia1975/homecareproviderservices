// Serverless contact-form handler. Sends via Resend using a server-side API key.
// The key is stored as a Netlify environment variable (RESEND_API_KEY) and is never
// exposed to the browser.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) };
  }

  // Honeypot: bots fill hidden fields; humans don't. Silently accept and drop.
  if (data.company_website) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const name = (data.name || "").trim();
  const email = (data.email || "").trim();
  const company = (data.company || "").trim();
  const phone = (data.phone || "").trim();
  const manufacturer = (data.manufacturer || "").trim();
  const interest = (data.interest || "").trim();
  const message = (data.message || "").trim();

  if (!name || !email || !company) {
    return { statusCode: 400, body: JSON.stringify({ error: "Name, company, and email are required." }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please enter a valid email address." }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Email service is not configured." }) };
  }

  const subject = manufacturer
    ? `Dealer inquiry: ${manufacturer} — ${company}`
    : `Dealer inquiry — ${company}`;

  const lines = [
    `Name: ${name}`,
    `Company: ${company}`,
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : null,
    manufacturer ? `Manufacturer: ${manufacturer}` : null,
    interest ? `Primary interest: ${interest}` : null,
    "",
    "Message:",
    message || "(none)"
  ].filter((l) => l !== null);

  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const html =
    `<h2>New dealer inquiry</h2>` +
    lines.map((l) => (l === "" ? "<br>" : `<p style="margin:2px 0">${esc(l)}</p>`)).join("");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "HCPS Website <info@homecareproviderservices.us>",
        to: ["info@homecareproviderservices.us"],
        reply_to: email,
        subject,
        text: lines.join("\n"),
        html
      })
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("Resend error:", res.status, detail);
      return { statusCode: 502, body: JSON.stringify({ error: "Could not send message. Please email us directly." }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Contact function error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Unexpected error. Please email us directly." }) };
  }
};
