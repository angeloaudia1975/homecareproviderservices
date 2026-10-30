# Smart Email Learning — Phase 1: capture

Owner decisions (Angelo, 2026-10-30): Phases 1–3 approved; learn from **his own sent emails only**; suggestion threshold
3 sends across 2+ dealers, approved by him before it is active; email text kept **12 months**, then only masked,
non-identifying evidence; Phase 4 (sending edit pairs to an outside AI) **deferred**; the HCPS Communication Style Guide
stays the base; one PR per phase with independent review and CI.

## What Phase 1 does

| Where | Change |
|---|---|
| `routes-api` `previsit_draft` | keeps the heads-up as written (body + signature, exactly as the editor shows it); answers `draft_id` |
| `ai-email-api` `draft` | keeps the AI draft (visit follow-up, follow-up, re-engagement, product introduction, …); answers `draft_id` |
| `routes-api` `visit_email_save` | stores the `draft_id` with the saved follow-up, so a reopened draft still pairs with its original |
| `email-sync-api` `send` | **after Outlook answered 202**, keeps exactly what was sent beside its draft (recipient **count** only, never an address) |
| Scheduled Routes / Dealer 360 editors | carry the `draft_id` through Save draft, reopening and Send; nothing on screen changes |
| `/admin/email-learning.html` | owner-only, read-only page: each draft beside what was sent, with a line comparison |

Nothing is learned and no future email changes in Phase 1. Capture never changes a draft, a send, a recipient or Outlook;
a capture failure is swallowed (the draft / send answers exactly as before), and capture gives up after 2.5 s so a slow
database can never hold up the answer to a send Outlook already accepted (no reason to send twice). It runs only when **all** hold:
`phase2_flags.email_learning_capture` is exactly `true` · the signed-in user is the President · the email came from an HCPS
generator (a `draft_id`). Greg's and Lori's emails are never captured.

## Database (Angelo runs it; Claude never does)

`supabase/email_learning_p1_capture.sql` — sha256 `fdc174f7e5fca15cebf64d60fc74917be15c358ad2be2c04cfff0fe831c2f059`
- one table `email_drafts` (RULE 19: RLS on, no policies, anon/authenticated nothing, service_role SELECT only)
- `hcps_email_draft_create` / `hcps_email_draft_record_send` / `hcps_email_draft_purge_expired` (security definer,
  service_role only); a guard trigger refuses every other write (owner included), any change to the original, a second
  recorded send, and any DELETE / TRUNCATE
- `content_expires_at` = 12 months; the purge clears all text of both versions. It runs daily from
  `email-learning-purge-cron` (netlify.toml, ~22:17 CT), whatever the capture switch says; before the migration it does nothing.
  The record then keeps only its type, dates, dealer id and edited flag. Phase 2 stores its masked evidence before a purge.
- 7 install checks at the end (every `ok` must be true); it does **not** turn the switch on

Postcheck (read-only): `supabase/email_learning_p1_postcheck.sql` — sha256 `e23c7246bb2b3375398a528cb3c027af6ac739d62c5f4ddcef018a450fbcf4c0`.
Expected code fingerprint (row 2): `f8d609ba82970e7a2c0e4f09299ba17a` when pasted into the SQL editor (Windows line endings),
`853c4a62d482cd18028e4494563aa6f9` with Unix line endings — both reproduced locally from the committed file.

**Production (verified 2026-10-30 ~15:57 CT):** installed fingerprint `126886da53e09d2c282c3b8b950ae969`. Per function, four match the
committed file exactly (Windows paste); `hcps_email_draft_guard` is 2205 characters instead of 2218 — the copy Angelo pasted lacked the
one comment line `  -- UPDATE` inside the guard (13 characters with CR+LF). Reproduced exactly locally (committed file minus that line,
CRLF → `126886da…`, guard md5 `d205a95992ea8e71b7e3bf84a54c213a`). Logic identical; accepted, not reinstalled. Lesson: a comment line
inside a function body is part of its fingerprint — the pasted copy must be the committed file byte for byte.
Postcheck at that time: 4 functions, RLS on / 0 policies, 0 public grants, 2 guard triggers, switch `false`, 0 / 0 / 0 drafts;
public-key probe 8/8 BLOCKED (run 2026-10-30 from the ordering site's public key). PR #69 merged (main b555ab6) and live.

Rollback: `supabase/email_learning_p1_capture_rollback.sql` — sha256 `a046c0e102ba6234600fcdeaa4de36c0ead0b5f7d1db538e31dc68dcd2eec2b8`.
Turn the switch off first. It refuses while any draft is stored (removing the owner's email text is its own decision).

Outside check after install: `scripts/email_learning_p1_public_probe_browser.js` (public key only; expect ALL 8 BLOCKED).

## Rollout order

1. PR review + CI green → merge (code is inert: no table, switch absent).
2. Angelo runs the migration (all 7 checks true) → postcheck → public-key probe (8/8 BLOCKED).
3. Angelo turns capture on: `update app_settings set value = value || '{"email_learning_capture": true}' where key = 'phase2_flags';`
4. Live check: one heads-up opened and sent by Angelo appears on Email Learning with both versions.
OFF line: `update app_settings set value = value || '{"email_learning_capture": false}' where key = 'phase2_flags';`

## Tests (synthetic data only — no real email content in development or CI)

- `test/email-learning-p1.pg.test.js` — the migration in real Postgres (19): install checks, RULE 19, the guard (owner,
  forged marker, service_role), author / dealer / once rules, purge only after expiry, second run, rollback.
- `test/email-learning-p1.test.js` — the real handlers on the mock world (30; incl. a hanging database, ties in paging, the purge job): who/when is captured, exact text kept,
  capture failure never breaks a draft or send, a failed Outlook send records nothing, owner page President-only, read-only.
- `test/email-learning-p1.ui.js` — Chromium (9): heads-up save → reopen → send pairs with ONE draft; Dealer 360 composer;
  Greg and switch-off keep nothing; owner page desktop + phone.
- `test/email-learning.mutants.js` — 26 mutants (19 JS, 7 SQL), all killed; control survives.
- pg-safeupdate is not installed in the dev container, so the safe-update rule is checked statically (every UPDATE carries a
  WHERE clause; no DELETE).

## Next phases (not built here)

- **Phase 2** — masking + comparison (`_email_learning` analyzer), suggestions at 3 sends / 2+ dealers, the owner dashboard
  (approve / edit / reject / retire, examples, versions, rollback / reset), masked evidence table, scheduled purge.
- **Phase 3** — `loadStylePack` (style guide + approved rules + ≤2 approved examples per type) in every generator; AI heads-up
  with the fixed template as fallback; writing styles (Professional & Friendly · Consultative Sales · Brief & Direct);
  Regenerate that keeps the rep's edits; strict no-invention guards (arrival times, availability, promotions, pricing,
  purchase history, commitments); route date / ETA validation (missing, suspicious or unverified → omitted, neutral wording);
  switch `email_learning_apply` + `previsit_ai`, each turned on only by Angelo after review.

## Independent review (2026-10-30, separate reviewer agent, no blockers)

Fixed before the PR: capture time limit after a send (medium); retention purge scheduled now instead of Phase 2 (medium);
a saved follow-up always sends its `draft_id` so new text never pairs with an old, unrelated draft (low); owner list pages on
(created_at, id) (low); list no longer reads email bodies (low); a server error answers a plain message (nit). Remaining:
pg-safeupdate cannot be built in the dev container, so the safe-update rule is checked statically (as noted above).
