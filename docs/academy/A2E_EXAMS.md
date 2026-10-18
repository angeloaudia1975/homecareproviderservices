# HCPS Academy — A2E Final exams with server-enforced limits (M6 + application code)

Status: built on branch `academy/a2e-exams`, PR for review. **M6 is NOT run in production.** The new switch
`academy_exams` is OFF (and the learner switches stay OFF); the Golden course stays an unpublished draft.

## What it does (Learner Launch plan, Stage 3)

| Rule | Where it is enforced |
|---|---|
| One open attempt at a time (per learner) | `academy_exam_limits` inside `academy_exam_op_start`, under a per-learner lock |
| 60 minutes between attempts (from the end of the last one; for an expired attempt, from its deadline) | same; `exam_cooldown_minutes` on the version |
| At most 3 attempts started per calendar day, America/Chicago (DST-safe) | same; `exam_daily_limit` on the version |
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
| `supabase/academy_a2e_m6_exam_attempts.sql` (as committed, LF) | `9fc1a12a1aba6d8a513ca25877b709212d7de14ccbcc0535305d75f5cba570be` |
| same, pasted with Windows line endings | `fc1eeee6f6c16e15b611b0b63642612f221d42961c1cac3bb814c3552c2911f6` |
| `supabase/academy_a2e_m6_exam_attempts_rollback.sql` (refused while any attempt exists) | `4ba225622e823f569aa23d3d27e1980fb9de46d7bc5d7d24d50965740b0b0ca4` |
| `supabase/academy_a2e_m6_preflight.sql` (read-only; `ready_for_m6`) | `6cadb2f1b8fef826b25519e2cfce76ef57ad9334e9907a10349a08f84af6c508` |
| `supabase/academy_a2e_m6_postcheck.sql` (read-only) | `f699496a26a91040c9939fd4b0c8dd8ca1e59038b85e554717c9f98f1e13f7a9` |
| `scripts/academy_m6_public_probe_browser.js` (public key only; 9 functions + 4 table checks = 13) | — |

Installed-code fingerprint (`m6_code_fingerprint`): `d5ef9881d56d11f56c561dfaa56768bf` (Unix) /
`1bedb41ce0eb277727a5596243938aa2` (Windows paste). Rehearsed locally on PG16: preflight `ready_for_m6` true → 8/8
install checks → postcheck 10 functions / 5 for the server / 0 public, M1 start/submit not callable by the server, no
attempt writes → preflight again: everything outside the Academy and the M1–M5 code fingerprints identical; only the
Academy grants (server loses attempt writes) and columns (+8) change.

## Production procedure (NOT authorized yet)

1. Read-only preflight `academy_a2e_m6_preflight.sql`: `ready_for_m6` true; record the fingerprints.
2. Angelo checks the sha256 in the editor and runs the migration himself; all 8 install checks `ok = true`.
3. Postcheck: the fingerprint above; 10 / 5 / 0; `m1_start_submit_server` [false, false]; attempts 0; switches unchanged.
4. Preflight again: outside-the-Academy and M1–M5 fingerprints identical.
5. Public-key probe: all 13 BLOCKED.
6. Merge + deploy (without M6 the exam actions answer 503; with `academy_exams` off they answer 403 flag_off).
7. The time limit (decision I) and switching `academy_exams` on for the pilot are separate approvals.

Note for the earlier acceptance files: after M6, the M1 acceptance checks that call `academy_op_start_attempt` as the
server role are expected to be refused — that is the point of M6. Use the M6 suites instead.

## Tests

`test/academy-m6.pg.test.js` (15), `test/academy-a2e.pg.test.js` (7), `test/academy-learner.browser.js` (exam flow at 390
and 1280, axe), `test/academy-a2e.mutants.js`. Edges covered: 20 simultaneous starts → 1 attempt; cooldown 59:59 refused /
60:00 allowed; 3rd attempt of the day allowed, 4th refused until local midnight, on the day daylight saving ends
(25-hour day) and starts (23-hour day); expiry grades only answers saved in time; no key or explanation in any learner
response; withdrawn enrollment and ended access refused.
