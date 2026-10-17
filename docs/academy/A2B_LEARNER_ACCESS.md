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
- `supabase/academy_a2b_m5_postcheck.sql` — read-only; run before (as preflight) and after.

| File | sha256 |
|---|---|
| migration (as committed, LF) | `cd04087a8c3cff722f9be221436bc49eb9a41318d035c5d1ce88090844c6b287` |
| migration pasted with Windows line endings | `e512849ef6d16dd962f3cd13bfeb3943c964fac58eac7561729ca14eb6a4c0c2` |
| rollback | `47e070c8e00d7fcf271c5ee5745441a13b4089d5cdf9eac78f4671a96afb28e1` |

Installed-code fingerprint (postcheck `m5_code_fingerprint`): `45068089db7de18fdf0d63be888d18aa` (Unix) /
`81dbf1a23dd7b625429c922c9f1fc24e` (Windows paste) — both reproduced on PG16; M1–M4 fingerprints unchanged by M5.

Restoring access (`reactivate`) brings back the learner's courses and progress at that same dealership; after a move to
another dealership, enrolling again re-attaches the SAME enrollment (`re_attach`, audited) — never a second one.

## Production procedure (NOT authorized yet)

1. Read-only preflight (`academy_a2b_m5_postcheck.sql` before: `m5_functions` 0; record M1–M4 fingerprints, switches,
   rows).
2. Angelo checks the sha256 in the editor and runs the migration himself; all 8 install checks `ok = true`.
3. Postcheck: M5 fingerprint = the precomputed Unix or Windows-paste value; M1–M4 fingerprints unchanged; 20 / 13 / 0;
   learner rows 0; switches unchanged.
4. Public-key probe of the two new tables and the 13 operations — all BLOCKED.
5. Only then merge + deploy (deploying the code without M5 leaves the learner API off: it is switch-gated and the
   operations answer 503).
6. Switches, the sender address and the pilot each need their own approval.

## Tests

`test/academy-m5.pg.test.js`, `test/academy-a2b.pg.test.js`, `test/academy-learner.browser.js` (strict CSP from
netlify.toml, 360 / 390 / 768 / 1280, axe), `test/academy-a2b.mutants.js`, plus the updated `academy-a2a` suites.
