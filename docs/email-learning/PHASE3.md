# Smart Email Learning — Phase 3: applying approved rules, the AI heads-up, styles, Regenerate, guards and Redact

Owner decisions (Angelo, 2026-10-30; CLAUDE.md §16) and his instructions of 2026-10-31 (11:32 and 14:02 CT): Phase 3 is built
on its own branch and PR, with an independent exact-head review and CI. **Nothing in Phase 3 changes a draft or a sent email
in production until the owner has reviewed it and switched it on.** Learned rules are never activated automatically, and the
AI heads-up is not switched on without his final authorization. Separate from the Scheduled Routes security work; every
PR #71 route-access and recipient rule is unchanged (tests below).

## Switches (all OFF; on only when exactly `true` in `app_settings.phase2_flags`)
| Switch | What it turns on | Off = |
|---|---|---|
| `email_learning_apply` | the owner's approved writing rules in his own AI drafts (Dealer 360, visit follow-ups, and the AI heads-up) | no rule in any prompt |
| `email_styles` | the writing-style picker + Regenerate in the editors; the no-invention guards on Dealer 360 / follow-up drafts; the heads-up date / time checks | today's editors and prompts, word for word |
| `email_ai_headsup` | the AI pre-visit heads-up (fixed template as fallback); the heads-up date / time checks; Regenerate in the heads-up | the fixed template exactly as before |
| `email_learning_suggest` (Phase 2) | daily analysis | stays OFF |

Turning a switch off returns that feature to today's behaviour at once, with no deploy.

## What is built
1. **Approved rules → prompts** (`_email_rules_apply.js`). The CURRENT numbered version's rules for the email type (its own
   type first, then "every type"), at most 2 masked examples, placed AFTER the AI Communication Style Guide, which wins on any
   conflict; the block forbids inventing facts. Only the ACTIVE President's drafts (re-checked in `staff_users`); a read
   failure = not applied. Used by `ai-email-api` and `routes-api` only, each through `approvedFor` (test-enforced).
   `recordShape` keeps which version / style shaped a kept draft (`email_draft_shapes`, best-effort, President's own drafts).
2. **AI pre-visit heads-up** (`_headsup.js`, `routes-api previsit_draft`). Written from the same facts the template uses and
   nothing else: rep, HCPS, the contact's first name, the checked day, the checked arrival time, the rep's typed opportunity —
   never account data, purchase history or prices (the heads-up reads no more of the dealer than the template). It must keep
   the day and time it was given, call the time an estimate, pass the guards and the style guide's banned phrases — one
   rewrite, then the fixed template with a warning. An AI failure never blocks the heads-up.
3. **Writing styles** (`_email_styles.js`): Professional & Friendly (default) · Consultative Sales · Brief & Direct. A style
   changes how the email reads, never what it says. An unknown key is the default.
4. **Regenerate without losing edits.** Field app (heads-up and visit follow-up): Regenerate writes a SUGGESTION in a box
   below; the rep's subject and message are untouched until "Use this version"; "Back to my previous text" restores them.
   Dealer 360: a regenerate over EDITED text is a suggestion (Keep my text / Use this version); unedited text is replaced as
   before. The draft id AND the warnings always follow the text in the editor, so a send pairs with the draft it came from;
   "Back to my previous text" swaps (the other version stays one tap away), so nothing is lost. The editor still
   closes only on an explicit action (2026-10-30 rule).
5. **No-invention guards** (`_draft_guards.js`, pure, no AI). Every time (incl. 24-hour, "11.30am", "3 o'clock", spelled
   out), zone, date, (heads-up: weekday incl. "Thurs.", and relative days "tomorrow" / "next week" / "the 5th"), dollar amount
   (incl. "bucks" and amounts in words),
   percentage, promotion, stock / shipping claim, purchase-history claim and commitment (guarantee, warranty, price match,
   "I'll bring", risk-free …) must be in what the generator was given. One rewrite naming the findings; then: heads-up →
   template; Dealer 360 / follow-up → shown with "Check before sending: …" for each remaining finding. They over-flag rather
   than under-flag. Purchase history is allowed only when the draft was given the account's history (never a visit-only
   follow-up).
6. **Date / ETA validation** (heads-up, with either heads-up switch on): the day must be a real date from today (Chicago) to
   120 days ahead; the arrival time must carry a known US zone (EST/EDT/CST/CDT/MST/MDT/PST/PDT/ET/CT/MT/PT), must name a day,
   and must not already have passed (each label read through its region's real clock on that date). Anything else is left out with a warning and neutral wording. `previsitEta` (7 AM – 7 PM)
   and `RouteClock.outsideHours` stay the first locks.
7. **Redact** (President only; `hcps_email_rule_redact`, owner page "Redact…"). Removes a rule's masked pattern, examples and
   both wordings for good — also in its events and every version snapshot (which keeps id / type / kind + `"redacted":true`).
   An approved rule is retired in a new version; a suggested one is rejected. The row and its key stay, so the edit is never
   suggested, refreshed (note), approved, edited or restored (decide / rollback) again, and the analyser leaves it out of
   previews too. The page offers Redact only after the Phase 3 SQL is installed. Kept on purpose (review L1): the owner's own
   free-text decision reasons, and the rule's `rule_key` / `pattern_key` (truncated SHA-256 of the masked pattern, readable
   only by the server role) — without the key the same edit would be suggested again. The emails themselves stay in
   `email_drafts` until the 12-month purge (Redact is about rule evidence).

## SQL (Angelo runs it; NOT run yet)
`supabase/email_learning_p3_shapes_redact.sql` — adds `email_draft_shapes` (RULE 19 locked) + `hcps_email_draft_shape`, the
redaction columns + constraint, `hcps_email_rule_redact`, and replaces the Phase 2 guard / note / decide (one added refusal
each). Needs Phases 1 + 2. Safe to run twice. Rollback `…_rollback.sql` refuses after any redaction or shape row and otherwise
restores the Phase 2 functions byte for byte. Read-only `email_learning_p3_postcheck.sql`; outside probe
`scripts/email_learning_p3_public_probe_browser.js` (20 checks, expect ALL BLOCKED). **The Phase 2 postcheck's row 2 changes
after this migration, by design** — use the Phase 3 postcheck. Code works before the SQL: shapes are best-effort (skipped),
Redact answers 503 "needs the Phase 3 database update", the rules list falls back without the redaction columns.

## Release record
- `email_learning_p3_shapes_redact.sql` sha256 `e3754e83fe81b01b897e7d3acf5d6605974db0122f7a950494f6e9d85f8a894e`
  (8 install checks); rollback `b5187ef3…ec2a`; postcheck `604843b2…5c23`; probe `ace7e2d5…de83` (20 checks).
- Expected postcheck row 2 (10 functions): **`a36686c04ff4aaf806d65b10980edaa5`** when pasted from Windows into the SQL
  editor (CRLF, the way Phases 1 and 2 were installed) / `2006d5024c4a1cd5c44922683d4cf3a8` with Unix line endings.
- **INSTALLED + VERIFIED 2026-10-31 / 2026-11-01 (run by Angelo):** install checks 8/8 true; postcheck rows 1, 3–7 ok
  (10 functions, RLS 4 / 0 policies, 0 public grants, 8 guard triggers, switches absent, 0 shapes / 0 redacted). Row 2 =
  **`051fd88d0462523f5b4c691dbf05a8e9`** — accepted: per-function md5 shows 8 of 10 functions equal the Windows-paste
  install exactly; `hcps_email_rule_note` and `hcps_email_rule_redact` lack only their whole-line `--` comments (4 lines),
  and removing exactly those lines from the committed CRLF bodies reproduces both function md5s and `051fd88d…` locally.
  Logic identical (same pattern as Phase 1). Public-key probe (storefront publishable key, accepted on a public table
  first): ALL 20 BLOCKED (401). Never rerun or roll back. All three Phase 3 switches stay OFF until Angelo authorizes them.

## Tests (synthetic data only)
- `test/email-learning-p3.test.js` — rules applied (switch, President, version, order, examples, plain text, retired,
  failures, addendum, only ai-email-api + routes-api through approvedFor, recordShape).
- `test/email-learning-p3.guards.test.js` — guards, styles, heads-up date / time checks, AI heads-up rewrite / fallback.
- `test/email-learning-p3.flow.test.js` — the real handlers: all off = today word for word (old heads-up template copied from
  d0f7449); each switch exactly true only; styles; learned rules President-only; guards rewrite + warnings; AI heads-up use /
  fallback / failure; PR #71 refusals with every switch on; the heads-up prompt carries no account data; Redact API.
- `test/email-learning-p3.pg.test.js` — the migration in Postgres 16 (+ second run, RULE 19, guard, Redact everywhere,
  Phase 2 still works, rollback refusal + byte-for-byte rollback).
- `test/email-learning-p3.ui.js` — Chromium, desktop 1280 + phone 390: editors off / on, Regenerate / Keep / Use / Back, ids,
  touch targets, no horizontal scroll, Dealer 360 suggestion.
- Mutants: `test/email-learning-p3.mutants.table.js` (JS + SQL), run by `test/email-learning.mutants.js` (Phases 1–3).
- Regressions kept green: Phase 1 / 2 suites, `email-editor.qa.js`, `sr-access`, `sr-routes-api`, `sr-workflow`, `sr-eta` and
  the Scheduled Routes browser suites.

## Owner actions to switch Phase 3 on (each separately, after review)
1. Run `email_learning_p3_shapes_redact.sql` → postcheck → probe (only needed for shapes + Redact; the switches work without it).
2. Turn on, one at a time: `email_styles` → `email_learning_apply` → `email_ai_headsup` (final authorization required).
