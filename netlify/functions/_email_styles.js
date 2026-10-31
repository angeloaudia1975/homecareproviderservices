// ============================================================================
// HCPS Smart Email Learning — Phase 3: the three writing styles a rep can pick in an email editor.
//
// Owner decision (CLAUDE.md §16): Professional & Friendly · Consultative Sales · Brief & Direct. A style changes HOW an
// email is written — tone, length, structure — never WHAT it says: it adds no fact, product, price, date, promotion or
// commitment. The AI Communication Style Guide stays first and wins on any conflict.
//
// Off unless phase2_flags.email_styles is exactly true; off = today's drafts, word for word (no style text in any prompt).
// ============================================================================
const SWITCH_STYLES = "email_styles";
const DEFAULT_STYLE = "professional_friendly";
const STYLES = {
  professional_friendly: {
    label: "Professional & Friendly",
    instruction: "Warm, courteous and professional. Plain, friendly sentences; 2 to 4 short paragraphs.",
  },
  consultative: {
    label: "Consultative Sales",
    instruction: "A trusted advisor: connect the reason for writing to the dealer's own business, and close with one clear, low-pressure next step. Ask at most one question. Never more persuasive than the facts allow.",
  },
  brief_direct: {
    label: "Brief & Direct",
    instruction: "Short and to the point: at most 3 short sentences in the body after the greeting, no pleasantries beyond the greeting.",
  },
};
// The key the caller asked for, or the default. Anything unknown is the default — never an error, never free text.
function styleKey(raw){ const k = String(raw == null ? "" : raw).trim().toLowerCase(); return Object.prototype.hasOwnProperty.call(STYLES, k) ? k : DEFAULT_STYLE; }
// The prompt text for a style (placed after the style guide and before any learned preference).
function styleBlock(key){
  const s = STYLES[styleKey(key)];
  return `Writing style for this email — ${s.label}: ${s.instruction} The style changes only how the email reads; it never adds a fact, product, price, date, promotion or commitment.`;
}
// What an editor shows in its style picker.
function styleList(){ return Object.keys(STYLES).map(k => ({ key: k, label: STYLES[k].label })); }

module.exports = { SWITCH_STYLES, DEFAULT_STYLE, STYLES, styleKey, styleBlock, styleList };
