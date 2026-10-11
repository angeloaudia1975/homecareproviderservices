# HCPS Academy — A2A completion record (accepted by Angelo, 10 Oct 2026 23:12 CT)

## Code (PR #3, merged 16805ed, live ~22:00 CT)
Shared security layer `_academy.js`, Academy session `_academy_session.js` (`__Host-hcps_academy`, HMAC, 8 h),
`academy-admin-api`, `academy-api`, `academy-handoff`; canonical host www.homecareproviderservices.org (netlify.app → www,
bare domain → www by Netlify); strict `/academy/*` headers. Live checks: admin API 401 (no token / public key / forged),
learner API and handoff mint 403 `flag_off`, status `{enabled:false}`, no-store, `/academy/` 404 with DENY/noindex/CSP,
redirects single-hop, site and Connect 360 unchanged. All seven Academy switches OFF.

## Database (M1 rev 2, run by Angelo in the SQL editor ~23:00 CT)
| Item | Value |
|---|---|
| Migration | `supabase/academy_a2a_m1_audited_ops.sql`, SHA-256 `7253ff8016caae6e308bd788c9c1d0f2b2335fdc0e3309cdbc4f9b62006da864` (supersedes `85e87157…`, never run) |
| Rollback | `supabase/academy_a2a_m1_rollback.sql`, SHA-256 `e197b6fda60dd3a7f7b5f7752c12b8aad2686473f2750ac26885601fcaa7b220` (not run) |
| Acceptance tests | `supabase/academy_a2a_m1_acceptance_tests.sql`, SHA-256 `8176688204c0b623a72cdc08b8d4cd3fa6c0569f1807cf283c1c3f550948729e` — **43/43 PASS**, no SKIP |
| A1 compatibility | `supabase/academy_a1_acceptance_tests.sql`, SHA-256 `60c6f1912e7da65d22799e890a256ee82fe85c4daec9259f55cc10d36daf6a0b` — **27/27 PASS** |
| Public-key probe | `scripts/academy_a2a_m1_public_probe_browser.js` — **19/19 BLOCKED (401)**, key verified on a public table |
| Installed objects | 19 functions (11 operations SECURITY DEFINER, server role only; 7 helpers + guard owner only), 6 guard triggers |
| Installed-code fingerprint | **`e70543ba23d96ca7c5aec8eeff0ea341` — ACCEPTED**. Expected `130e45fa36f768e032a89da43b645f8a` with Unix line endings; the editor paste stored every line ending as `\r\n`. The approved file installed locally with CRLF reproduces `e70543ba…` exactly and passes 28 targeted + 43 acceptance + 27 A1 + 11 atomicity tests. |
| Academy after tests | 0 rows; switches `{}`; RLS 18/18; 0 policies |

## Regression (preflight 21:45 vs after M1 — identical)
Outside the Academy: grants `1c268eb21624804fa439b7c7bc77adba / 2811`, policies `219ac18ed7a25a0db2d9a50c5b8a88e7 / 29`,
columns `d039b75fab3368e8333bed02248a93a8 / 109 tables`; key row counts identical (dealers 447, monthly_sales 11,997,
orders 3, staff_users 3, …). Academy: grants `7af6d10ef284760d9fb9ca840fad04b7 / 252`, columns
`ca21409347af0c7feba3e16a200fa482 / 179`, RLS 18/18, 0 policies. M1 created only functions and triggers on Academy tables.

## Refinements in force (Angelo 22:29, A–E)
A corrections take a score only, pass/fail follows the pass mark · B a certified pass is corrected to a fail only after the
certificate is revoked (its own audited step) · C questions drawn and validated by the database for the enrolled,
published version; only the record's learner submits · D operations SECURITY DEFINER, server role only; helpers owner
only; the guard needs owner rights + marker; staff actors = active president/admin/owner · E issuance needs the
certificates switch and every eligibility check; TEST courses never issue.

## Remaining limitations (not blocking)
- Request-body-actor and signed-in role/scope tests are built with the first feature that calls the operations (A2C C1).
- Retake policy (one-hour cooldown, three per day, unlimited lifetime; one open attempt already enforced) — A2E, tested
  under simultaneous requests before the learner pilot.
- Re-certification after a revocation on the same version needs a design decision (enrollment is unique per version).
- Certificates stay OFF until separately authorized.
- `phase1-visits`, `phase2-account-class`, `phase2-timeline` fail identically on main (test clock), unrelated.
