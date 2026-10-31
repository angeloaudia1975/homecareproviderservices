// ============================================================================
// HCPS — one short AI email draft (subject + body) from a prompt. Used by the Phase 3 AI pre-visit heads-up.
// Thinking is turned off (Sonnet 5 thinks by default: slow, and it can use up the allowance before the email is written);
// a model that refuses the setting is asked once more without it. Returns { subject, body } or { err }. Never throws.
// `fetchImpl` lets the tests stand in for the AI service.
// ============================================================================
async function askDraft(prompt, opts){
  const o = opts || {}, key = o.key, model = o.model || "claude-sonnet-5", f = o.fetchImpl || fetch;
  if(!key) return { err: "ai_unavailable" };
  const send = thinking => f("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ model, max_tokens: o.maxTokens || 700, messages: [{ role: "user", content: prompt }] }, thinking ? { thinking } : {})) });
  try{
    let r = await send({ type: "disabled" }), t = await r.text().catch(() => "");
    if(r.status === 400 && /thinking/i.test(t)){ r = await send(null); t = await r.text().catch(() => ""); }
    if(!r.ok) return { err: `ai_status_${r.status}` };
    let j = null; try{ j = JSON.parse(t); }catch(_){}
    let text = ""; for(const c of ((j && j.content) || [])){ if(c && typeof c.text === "string") text += c.text; }
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if(s >= 0 && e > s){ try{ const obj = JSON.parse(text.slice(s, e + 1));
      const subject = String(obj.subject || "").trim(), body = String(obj.body || "").trim();
      if(subject && body) return { subject, body }; }catch(_){} }
    return { err: "ai_empty" };
  }catch(e){ return { err: "ai_unreachable" }; }
}
module.exports = { askDraft };
