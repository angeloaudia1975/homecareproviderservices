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
| Every lesson of the ENROLLED version completed by THIS enrollment before the exam starts (`completed` only — `viewed` never counts; another enrollment's or another version's progress never counts; a version with no lessons never opens an exam) | `academy_exam_limits` (`lessons_incomplete` with counts) inside `academy_exam_op_start` — the only way to start, the server cannot call M1 directly |
| Time limit 45 minutes for 25 questions (approved by Angelo, 18 Oct 2026); an attempt open past its deadline is graded with the answers saved before it (answers sent later never count); resuming after a lost connection keeps the original deadline | `academy_exam_expire`, `exam_time_limit_minutes` on the version |
| Reasonable accommodation: extra minutes for ONE enrollment, set only by an HCPS administrator with a reason (Command Center → Learners → Exam time: President only), audited; applies to attempts started afterwards; a running attempt keeps its deadline | `academy_exam_op_accommodate`, `academy_enrollments.exam_extra_minutes` (0–240), guard trigger `academy_exam_enrollment_guard` |
| Answer keys and explanations never leave the database | questions are read only through `academy_exam_op_view`; the result is M1's score, pass/fail and topics to study |
| Grading, draw, verified facts, published version | unchanged M1/M3 code, CALLED by the M6 operations (M1/M3 byte-identical) |
| No way around the limits | the server role loses EXECUTE on M1's `academy_op_start_attempt` / `academy_op_submit_attempt` and INSERT/UPDATE/DELETE on `academy_attempts` |
| An attempt's learner, enrollment, start and deadline never change | trigger `academy_exam_attempt_defaults` (sets learner and deadline on insert, refuses changes) |

Learner pages (`/academy/`): **Final exam** on each course card (when `academy_exams` is on) → rules, attempt history and
the next allowed start (or "Finish every lesson first: N of M lessons completed") → in-page "Start now" confirmation → one question per screen with a countdown, answers saved as
they are chosen, with the save state and a connection notice ("You are offline… the clock keeps running"; saved again
when the connection returns) and resume after a reload → review (unanswered highlighted) → submit → result
(score, pass/fail, topics to review) → back to the exam page with the cooldown shown. Training Managers see, per
employee and course, **exam passed / not passed yet (N attempts)** — never a score.

## Files

| File | sha256 |
|---|---|
| `supabase/academy_a2e_m6_exam_attempts.sql` (as committed, LF) | `79c6fe9c4dcd0f72cc2e86e32a967618d464e5d344e7747589e188dbac028777` |
| same, pasted with Windows line endings | `ab79e3e001ad7013e471c3c31a190453171993c9a54d5b7c3ca7cf9e59bacf8e` |
| `supabase/academy_a2e_m6_exam_attempts_rollback.sql` (refused while any attempt or accommodation exists) | `f1a63108262e9105b5e6872bb6c8323b325eed1195a5454dcb567d740f885e86` |
| `supabase/academy_a2e_m6_preflight.sql` (read-only; `ready_for_m6`) | `6cadb2f1b8fef826b25519e2cfce76ef57ad9334e9907a10349a08f84af6c508` |
| `supabase/academy_a2e_m6_postcheck.sql` (read-only) | `4c70e4488ec9808afff1681469cbdf6d910dd91a68ac43ec9b7fd9201cd45631` |
| `scripts/academy_m6_public_probe_browser.js` (public key only; 11 functions + 4 table checks = 15) | `a4bd9b3743c0be213cddb1b9d6322930e5dbf0f07cd25bcc80ace5644762cc5a` |

Installed-code fingerprint (`m6_code_fingerprint`): `8858cea853b42b617b7e61cc29d2ce6b` (Unix) /
`15e87a5c5aa6af1b5984accd12428511` (Windows paste). Rehearsed locally on PG16: preflight `ready_for_m6` true → 8/8
install checks → postcheck 13 functions / 6 for the server / 0 public, M1 start/submit not callable by the server, no
attempt writes → preflight again: everything outside the Academy and the M1–M5 code fingerprints identical; only the
Academy grants (server loses attempt writes) and columns (+12: 8 on attempts, 3 on versions, 1 on enrollments) change.

## Production procedure (NOT authorized yet)

1. Read-only preflight `academy_a2e_m6_preflight.sql`: `ready_for_m6` true; record the fingerprints.
2. Angelo checks the sha256 in the editor and runs the migration himself; all 8 install checks `ok = true`.
3. Postcheck: the fingerprint above; 13 / 6 / 0; triggers 2; `m1_start_submit_server` [false, false]; attempts 0; switches unchanged.
4. Preflight again: outside-the-Academy and M1–M5 fingerprints identical.
5. Public-key probe: all 15 BLOCKED.
6. Merge + deploy (without M6 the exam actions answer 503; with `academy_exams` off they answer 403 flag_off).
7. Switching `academy_exams` on for the pilot is a separate approval.

Note for the earlier acceptance files: after M6, the M1 acceptance checks that call `academy_op_start_attempt` as the
server role are expected to be refused — that is the point of M6. Use the M6 suites instead.

## Tests

`test/academy-m6.pg.test.js` (31), `test/academy-a2e.pg.test.js` (11), `test/academy-learner.browser.js` (exam flow, the
lesson gate, a lost connection mid-exam and the ungraded state at 390 and 1280, axe), `test/academy-c1.browser.js` (Exam
time in the Command Center), `test/academy-a2e.mutants.js` (42 + control; one candidate dropped as equivalent under M5). Edges covered: 20 simultaneous starts → 1 attempt; cooldown 59:59 refused /
60:00 allowed; 3rd attempt of the day allowed, 4th refused until local midnight, on the day daylight saving ends
(25-hour day) and starts (23-hour day); expiry grades only answers saved in time; no key or explanation in any learner
response; withdrawn enrollment and ended access refused; across two courses one open attempt blocks the other course while
cooldown and daily limit stay per course; a grading failure (injected by a test-only trigger on the audit table) is
recorded, audited once per distinct error, raised as a WARNING, blocks only that enrollment, makes submit answer
grading_pending / grading_failed (409) and is graded deterministically once the fault is gone; a failure to record the
failure still returns the call's answer. Lesson gate: no lessons / one of two / viewed-only refused, all completed starts;
another course's or an older version's progress never counts; a withdrawn enrollment refused; 20 simultaneous starts with
a lesson unfinished create nothing, then exactly one. Accommodation: learner, unknown staff, no reason, out of range and
anon refused; the owner cannot write it by hand; +15 gives the next attempt 60 minutes and leaves a running attempt alone;
audited with the President's name and reason; 0 removes it. Cross-dealership: a learner at another dealership gets 404 /
403 on every exam action.

## Pre-activation checks (kept from the independent review, not done yet)

- The real Netlify production deployment check of the exam pages and actions after the merge.
- The trusted client-IP validation on Netlify's edge (`docs/academy/ip-verify/`) before any learner switch goes on.

## Owner decisions (Angelo, PR #22 comment 6252980040, 18 Oct 2026)

- 45-minute hard time limit for 25 randomized questions, 80% to pass — kept (the earlier "no time limit" comment
  6252939569 is superseded).
- Every lesson of the enrolled version completed first, enforced in the database — built.
- Reasonable accommodation as an audited, administrator-controlled per-enrollment extension set before an attempt — built
  with these proposed details, each Angelo's to change: President-only in the Command Center (the database accepts any
  active HCPS administrator); 0–240 extra minutes; reason required; future attempts only (never extends a running attempt);
  no learner or Training Manager request flow.
