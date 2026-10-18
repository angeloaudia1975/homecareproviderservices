# HCPS Academy — A2E Final exams with server-enforced limits (M6 + application code)

Status: built on branch `academy/a2e-exams`, PR for review. **M6 is NOT run in production.** The new switch
`academy_exams` is OFF (and the learner switches stay OFF); the Golden course stays an unpublished draft.

## What it does (Learner Launch plan, Stage 3)

| Rule | Where it is enforced |
|---|---|
| One open attempt at a time **per learner, across all their courses** (open = not submitted and before its deadline) | `academy_exam_limits` inside `academy_exam_op_start`, under a per-learner lock |
| 60 minutes between attempts **per enrollment** (from the end of the last one; for an expired attempt, from its deadline) — an attempt in course A never holds course B | same; `exam_cooldown_minutes` on the version |
| At most 3 attempts started per calendar day, America/Chicago (DST-safe), **per enrollment** — course A's attempts never use up course B's | same; `exam_daily_limit` on the version |
| A grade that cannot be written is never swallowed: recorded on the attempt (`grading_failures`, `grading_failed_at`, `grading_error` = SQLSTATE: message), an `expire_failed` / `submit_failed` audit row when the error is new or different, a database WARNING, and returned to the caller; graded again (same saved answers → same result) by the next exam call; meanwhile that enrollment cannot start (`grading_pending`) and a submit answers `ok:false` (`grading_pending` after the deadline, `grading_failed` before it, answers kept) → API 409, never a result | `academy_exam_grading_failed`, `academy_exam_expire`, `academy_exam_op_submit` |
| Time limit 45 minutes; an attempt open past its deadline is graded with the answers saved before it (answers sent later never count) | `academy_exam_expire`, `exam_time_limit_minutes` on the version (decision I: proposed default) |
| Answer keys and explanations never leave the database | questions are read only through `academy_exam_op_view`; the result is M1's score, pass/fail and topics to study |
| Grading, draw, verified facts, published version | unchanged M1/M3 code, CALLED by the M6 operations (M1/M3 byte-identical) |
| No way around the limits | the server role loses EXECUTE on M1's `academy_op_start_attempt` / `academy_op_submit_attempt` and INSERT/UPDATE/DELETE on `academy_attempts` |
| An attempt's learner, enrollment, start and deadline never change | trigger `academy_exam_attempt_defaults` (sets learner and deadline on insert, refuses changes) |

Learner pages (`/academy/`): **Final exam** on each course card (when `academy_exams` is on) → rules, attempt history and
the next allowed start → in-page "Start now" confirmation → one question per screen with a countdown, answers saved as
they are chosen (resume after a reload or dropped connection) → review (unanswered highlighted) → submit → result
(score, pass/fail, topics to review) → back to the exam page with the cooldown shown. Training Managers see, per
employee and course, **exam passed / not passed yet (N attempts)** — never a score.

## Files

| File | sha256 |
|---|---|
| `supabase/academy_a2e_m6_exam_attempts.sql` (as committed, LF) | `155975273a0e818d5af49975550949ebf5c48596405307cc73f1d46ee5c79673` |
| same, pasted with Windows line endings | `3ea0cefa5b50f7d8cbe549e5153b2f9182a1ba8a3c8155004398c0a0f22b8b39` |
| `supabase/academy_a2e_m6_exam_attempts_rollback.sql` (refused while any attempt exists) | `526af04dee6e45df7e732258a306b1b8ba0cd23d20c6a5f4a2e7e0bfcc7b1e6c` |
| `supabase/academy_a2e_m6_preflight.sql` (read-only; `ready_for_m6`) | `6cadb2f1b8fef826b25519e2cfce76ef57ad9334e9907a10349a08f84af6c508` |
| `supabase/academy_a2e_m6_postcheck.sql` (read-only) | `6fd38c8d1f18ac79903fe3537ac17bbe55b195231f5e67ed04de1b64a46de070` |
| `scripts/academy_m6_public_probe_browser.js` (public key only; 10 functions + 4 table checks = 14) | — |

Installed-code fingerprint (`m6_code_fingerprint`): `3d8e9206e24c0f2244e714ea0caff9b8` (Unix) /
`b40d2fa66fdb4ae8dc8f8c01a76ecf5a` (Windows paste). Rehearsed locally on PG16: preflight `ready_for_m6` true → 8/8
install checks → postcheck 11 functions / 5 for the server / 0 public, M1 start/submit not callable by the server, no
attempt writes → preflight again: everything outside the Academy and the M1–M5 code fingerprints identical; only the
Academy grants (server loses attempt writes) and columns (+8) change.

## Production procedure (NOT authorized yet)

1. Read-only preflight `academy_a2e_m6_preflight.sql`: `ready_for_m6` true; record the fingerprints.
2. Angelo checks the sha256 in the editor and runs the migration himself; all 8 install checks `ok = true`.
3. Postcheck: the fingerprint above; 11 / 5 / 0; `m1_start_submit_server` [false, false]; attempts 0; switches unchanged.
4. Preflight again: outside-the-Academy and M1–M5 fingerprints identical.
5. Public-key probe: all 14 BLOCKED.
6. Merge + deploy (without M6 the exam actions answer 503; with `academy_exams` off they answer 403 flag_off).
7. The time limit (decision I) and switching `academy_exams` on for the pilot are separate approvals.

Note for the earlier acceptance files: after M6, the M1 acceptance checks that call `academy_op_start_attempt` as the
server role are expected to be refused — that is the point of M6. Use the M6 suites instead.

## Tests

`test/academy-m6.pg.test.js` (22), `test/academy-a2e.pg.test.js` (8), `test/academy-learner.browser.js` (exam flow and
the ungraded state at 390 and 1280, axe), `test/academy-a2e.mutants.js` (32 + control). Edges covered: 20 simultaneous starts → 1 attempt; cooldown 59:59 refused /
60:00 allowed; 3rd attempt of the day allowed, 4th refused until local midnight, on the day daylight saving ends
(25-hour day) and starts (23-hour day); expiry grades only answers saved in time; no key or explanation in any learner
response; withdrawn enrollment and ended access refused; across two courses one open attempt blocks the other course while
cooldown and daily limit stay per course; a grading failure (injected by a test-only trigger on the audit table) is
recorded, audited once per distinct error, raised as a WARNING, blocks only that enrollment, makes submit answer
grading_pending / grading_failed (409) and is graded deterministically once the fault is gone; a failure to record the
failure still returns the call's answer.

## Pre-activation checks (kept from the independent review, not done yet)

- The real Netlify production deployment check of the exam pages and actions after the merge.
- The trusted client-IP validation on Netlify's edge (`docs/academy/ip-verify/`) before any learner switch goes on.

## Owner decisions still open (requirements NOT changed until Angelo decides)

- Time limit: 45 minutes for 25 questions (recommended by the review) — currently the proposed default.
- Whether all 17/17 lessons must be complete before the exam can start (recommended: yes, enforced in the database) —
  not enforced today.
