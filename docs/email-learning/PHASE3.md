# Smart Email Learning — Phase 3: applying approved rules, the AI heads-up and draft guards

Owner decisions (Angelo, 2026-10-30; CLAUDE.md §16) and his 2026-10-31 instruction: Phase 3 is built on its own branch and
PR, with an independent review and CI. **Nothing in Phase 3 changes a draft or a sent email in production until the owner has
reviewed it and switched it on.** Learned rules are never activated automatically.

## What Phase 3 covers
1. **Applying approved rules (this PR, part 1 — not wired).** `netlify/functions/_email_rules_apply.js` reads the CURRENT
   numbered version of the approved set and turns the rules for an email type (its own type first, then "every type") into a
   short block of prompt text placed AFTER the AI Communication Style Guide. The style guide stays first and wins on any
   conflict; the block forbids inventing names, dates, times, prices, products, promotions or commitments; at most 2 masked
   examples per email type, never whole historical emails. Active only when `phase2_flags.email_learning_apply` is exactly
   `true` AND the draft is the ACTIVE President's (re-checked in `staff_users` at the moment of use). A rule retired since the
   version was cut is left out; wording that is not plain text is left out (never "fixed"); any read failure = not applied,
   never an error and never a blocked draft. **No generator uses it yet** (a test fails if one does before its review).
2. **Wiring (part 2, separate review).** Dealer 360 AI emails (`ai-email-api.js`) add the block after `loadStyleGuide()`; each
   kept draft records which profile version shaped it. The fixed heads-up template stays the fallback.
3. **AI pre-visit heads-up (part 3).** The heads-up is written by AI from the same facts the fixed template uses (date,
   verified arrival time, rep, dealer, contact, optional opportunity) + the style guide + the approved rules; the fixed
   template is the fallback whenever AI is off, fails, or a guard refuses its text.
4. **Writing styles (part 3).** Professional & Friendly · Consultative Sales · Brief & Direct — a choice in the editor; the
   style never adds facts.
5. **Regenerate without losing edits (part 3).** Regenerate writes a new suggestion beside the rep's text; the rep's edits are
   never replaced unless the rep chooses the new version.
6. **No-invention guards (part 4).** A generated draft is checked against its input before it is shown: an arrival time,
   availability claim, promotion, price, purchase-history fact or commitment that the input does not contain is refused (the
   draft is regenerated once, then the fixed template is used). Pure code, tested with synthetic drafts.
7. **Route date / ETA validation (part 4).** Missing, suspicious or unverified dates / arrival times are omitted with neutral
   wording — the existing `previsitEta` / `RouteClock.outsideHours` rules stay the authority.
8. **Redact decision (Phase 2 open LOW).** A President-only "Redact" on a rule blanks its masked pattern and examples to
   placeholders (row and history kept, event logged) for the rare lowercase name or spelled-out address that masking cannot
   catch. Needs a reviewed SQL change (guard + decide), run by Angelo.

## Switches
- `email_learning_suggest` (Phase 2, daily analysis) — OFF.
- `email_learning_apply` (Phase 3) — OFF; turned on only by the owner after review. Turning it off returns every generator to
  today's behaviour at once, with no deploy.

## Tests (synthetic data only)
- `test/email-learning-p3.test.js` (part 1: switch, President-only, current version, type order, 2 examples, plain-text
  wording, retired rules, read failures, addendum wording, "no generator uses it yet").
- Mutants: `test/email-learning-p3.mutants.table.js`, run by `test/email-learning.mutants.js` (Phases 1–3).
