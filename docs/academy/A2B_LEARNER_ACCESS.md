# HCPS Academy — A2B Learner Accounts and Access (M5 + application code)

Status: built on branch `academy/a2b-learner-access`, draft PR. **M5 is NOT run in production.** All six learner-related
switches stay OFF; the Golden course stays an unpublished draft. Nothing here invites a dealer or starts the pilot.

## What it does

| # | Requirement | Where |
|---|---|---|
| 1 | Academy-only email sign-in, single-use 6-digit codes: 10-minute life, 5 tries, 3 per address / 15 min, 10 per day, 10 per network address / 15 min, 25 tries per network address / 15 min | `academy_access_op_request_code`, `_verify_code`; `_academy_learner.js` PUBLIC |
| 2 | Partner 360 → Academy handoff: 32-byte single-use code, 60 s, 10 per 10 min, in the URL fragment (never a query string) | `academy-handoff.js` mint, `academy_access_op_handoff_mint` / `_redeem` |
| 3 | Training Manager invitations for their own dealership (dealer + its direct branches) only; only HCPS appoints Training Managers | `academy_access_op_invite`, `academy_access_in_family` |
| 4 | Learner accounts never reach ordering, pricing or HCPS admin: the Academy cookie is read only by `academy-api`; no Supabase session is created; HCPS staff addresses never get a learner code | `_academy_session.js`, `learnerActor` |
| 5 | Enrollment only into a PUBLISHED course version (never a draft; a TEST course only at a TEST dealer); progress saved per screen, resume on reopen | `academy_enroll_op_enroll`, `academy_progress_op_save`, `lesson-player.js startAt` |
| 6 | Session row per sign-in (cookie v2 carries its id); sign-out, ending access and suspension close it at once; every operation is atomic with its `academy_events` row (M1 `academy_op_begin/audit/end`) | `academy_sessions`, `academy_access_end_sessions` |
| 7 | Mobile-first sign-in, course list, lesson and team screens (`/academy/`) | `src/academy/` |

Code and IP values are stored only as HMAC-SHA-256 keyed with `ACADEMY_SESSION_SECRET` (`keyedHash(purpose, value)`).
The server role loses INSERT / UPDATE / DELETE on the eight learner-side tables; the 13 operations are SECURITY DEFINER,
pinned search path, executable by `service_role` only; the 7 helpers by the owner only. RULE 19: the two new tables have
RLS on, no policies, nothing for anon / authenticated.

Switches: `academy_learner` (whole learner API), `academy_invites` (invitations, TM and staff), `academy_learner` +
`academy_handoff` (Partner 360 entry). Emails go out only when `RESEND_API_KEY` and `ACADEMY_MAIL_FROM` are set
(sender and wording are Angelo's decision H — not set).

## Files

- `supabase/academy_a2b_m5_learner_access.sql` — migration (preconditions: M1, M2, M4 installed; `dealer_users`,
  `dealers.is_test` present; M5 absent; no learner records). Ends with 8 install checks.
- `supabase/academy_a2b_m5_learner_access_rollback.sql` — refused while any learner-side row exists.
- `supabase/academy_a2b_m5_preflight.sql` — read-only; `ready_for_m5` must be true before; outside-the-Academy and M1–M4 fingerprints must be identical after (sha256 `3c3cd8f7cdda94ca086e2c1725483c20952fc4547ab79c723d420835959c1f19`).
- `supabase/academy_a2b_m5_postcheck.sql` — read-only; M5 fingerprint, rights, new tables, learner rows 0, switches.
- `scripts/academy_m5_public_probe_browser.js` — public key only; 22 functions + 8 direct table checks = 30, all BLOCKED.
- `docs/academy/ip-verify/` — activation gate 1: proves on Netlify's real edge that a visitor cannot set `x-nf-client-connection-ip` (throwaway deploy preview, never merged).

| File | sha256 |
|---|---|
| migration (as committed, LF) | `71ce248b91df443577f492a445ad8694b69d5533ab75357acb41e851ff5fa9ae` |
| migration pasted with Windows line endings | `5a881d18e3bea70ef2c1f6b3cfbcb1563d7df7af3999397b7143c1029e8d1b67` |
| rollback | `47e070c8e00d7fcf271c5ee5745441a13b4089d5cdf9eac78f4671a96afb28e1` |

Installed-code fingerprint (postcheck `m5_code_fingerprint`): `8ab570555eef51cd5220112e13655df3` (Unix) /
`cec33a5ea861887b077d78b0f545b50c` (Windows paste) — both reproduced on PG16; M1–M4 fingerprints unchanged by M5.

Restoring access (`reactivate`) brings back the learner's courses and progress at that same dealership; after a move to
another dealership, enrolling again re-attaches the SAME enrollment (`re_attach`, audited) — never a second one. Moving
training that was earned at ANOTHER dealership family is HCPS-only: a Training Manager is refused ("ask HCPS to move it"),
so no Training Manager can pull another dealership's training history into their team view.

## Security review corrections (ChatGPT review of d9b9022, PR #20 comment 6243057953)

| Finding | Fix | Tests |
|---|---|---|
| S1 enumeration by timing | Every code request — known address or not — hands ONE sealed, fixed-size envelope (AES-256-GCM, key from ACADEMY_SESSION_SECRET) to the background function `academy-mail-background` (202 at once) and never waits for the email provider; the answer is held to a minimum time (900 ms, `ACADEMY_SIGNIN_FLOOR_MS`) | a2b.pg "S1 timing" (provider 700 ms slow: known = unknown, one envelope each, same length, nothing readable) |
| S2 spoofed IP | Only Netlify's `x-nf-client-connection-ip` is read; X-Forwarded-For / Client-IP never; no header = one shared bucket | a2b.pg "S2" (spoofed headers never buy a new bucket) |
| S3 quota race | request_code and verify_code take a network-address lock, then the address lock (fixed order) | m5.pg "S3 simultaneous" (15 at once → exactly 10 codes; 40 guesses → ≤ 25 tries) |
| Delivery failure | The worker sends only a live code; if the email (or the hand-off to the worker) fails, `academy_access_op_code_undelivered` burns the code and it stops counting, so asking again works | a2b.pg "S1 delivery failure", m5.pg "Undelivered codes" |
| Cross-dealership history | Re-attaching training from another dealership family = HCPS only | m5.pg "Cross-dealership training history" |
| Duplicate email (re-review gate 2) | The worker atomically claims a code's single email (`academy_access_op_code_claim_mail`, row lock, `mailed_at`) before sending; only a live code for a known address can be claimed, once | m5.pg "Single delivery" (10 simultaneous claims → 1), a2b.pg worker test (5 parallel duplicates → 0 extra emails) |

The worker accepts only an envelope sealed with the Academy secret and at most 2 minutes old, re-checks the code row
(by claiming its single email atomically: not used, burned, expired, undelivered or already mailed) before sending, and never throws (Netlify retries a failed
background run).

## Production procedure (NOT authorized yet)

1. Read-only preflight (`academy_a2b_m5_postcheck.sql` before: `m5_functions` 0; record M1–M4 fingerprints, switches,
   rows).
2. Angelo checks the sha256 in the editor and runs the migration himself; all 8 install checks `ok = true`.
3. Postcheck: M5 fingerprint = the precomputed Unix or Windows-paste value; M1–M4 fingerprints unchanged; 22 / 15 / 0;
   learner rows 0; switches unchanged.
4. Public-key probe of the two new tables and the 22 functions — all 30 checks BLOCKED.
5. Only then merge + deploy (deploying the code without M5 leaves the learner API off: it is switch-gated and the
   operations answer 503).
6. Switches, the sender address and the pilot each need their own approval.

## Tests

`test/academy-m5.pg.test.js`, `test/academy-a2b.pg.test.js`, `test/academy-learner.browser.js` (strict CSP from
netlify.toml, 360 / 390 / 768 / 1280, axe), `test/academy-a2b.mutants.js`, plus the updated `academy-a2a` suites.
