-- ============================================================================
-- OPTIONAL — seed the HCPS AI Communication Style Guide into app_settings so it can
-- be edited live (no redeploy). Both AI email generators read this key first via
-- loadStyleGuide() and fall back to the identical default baked into _ai_style.js.
-- Edit the text between the $guide$ markers (or this row later) to change the rules
-- in ONE place. Idempotent: re-running overwrites the row.
-- ============================================================================
insert into app_settings (key, value, updated_at)
values (
  'ai_style_guide',
  jsonb_build_object('text', $guide$HCPS AI COMMUNICATION STYLE GUIDE (apply to every dealer email)

VOICE: Write like a knowledgeable HCPS sales rep bringing this specific dealer a useful business opportunity — confident, helpful, relevant, and value-driven. Never sound desperate, apologetic, repetitive, or like a generic automated sales sequence.

EVERY MESSAGE MUST CARRY A REAL REASON. Ground the email in what we actually know about THIS dealer from Dealer 360 — purchase history, the manufacturer lines they buy, products purchased, how long they've been inactive on a line, regional trends, new products/promotions we now carry, and crossover (cross-sell) opportunities. Lead with that specific reason or insight; do not send a message whose only purpose is to ask whether they're "still interested."

DON'T SAY  →  SAY INSTEAD:
1. Don't say "Just checking in…"  →  Lead with a specific insight relevant to this dealer (a line they buy, a dormant line, a regional trend).
2. Don't say "Following up on my follow-up…"  →  Give a NEW reason for the contact — something that changed or is newly available since last time.
3. Don't say "Are you still interested…"  →  Introduce a new benefit or opportunity worth exploring.
4. Don't say "This will only take 5 minutes…"  →  State the specific value the dealer gets (e.g. 'a 3-line margin comparison on your top category').
5. Don't say "Sorry to bother you…"  →  Open directly with a solution to a dealer problem or need.
6. Don't say "Haven't heard back…"  →  Explain what's new or what has changed since you last talked.
7. Don't say "I know you're busy, but…"  →  Deliver one quick, useful takeaway up front.
8. Don't say "Let me know if…"  →  Offer a clear next step or a simple either/or choice.
9. Don't say "What would it take to earn your business…"  →  Make a recommendation based on the dealer's goals and history.
10. Don't say "Is there any reason you wouldn't…"  →  Frame the clear, specific win for them.

ALSO AVOID: generic filler and weak openers such as "we've missed you", "we have missed you", "we miss you", "hope this email finds you well", "hope you're doing well", "hope all is well", "quick question", "circle back", "circling back", "touching base", and similar.

OPENERS: The first sentence states the specific, relevant insight or benefit for this dealer — never a check-in, an apology, or a "just" opener.
CTA: Close with a clear next step or a simple either/or choice the dealer can act on — not an open-ended "let me know if…".
HONESTY: Use only facts and numbers we actually have; never invent sales figures, dates, products, or promotions.$guide$),
  now()
)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- To revert to the code default, delete the row:
--   delete from app_settings where key = 'ai_style_guide';
