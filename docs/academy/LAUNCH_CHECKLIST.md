# HCPS Academy — Golden Lift Chair Sales Certification: launch checklist and controlled pilot

Status (18 Oct 2026, ~21:00 CT): **all production database work and code are live; every learner-facing switch is OFF.**
Nothing in this file is authorized by being written down — each step marked **OWNER** needs Angelo's explicit go-ahead.

## Where things stand

| Item | State | Evidence |
|---|---|---|
| A1 · M1–M5 (foundation, audited ops, content, authoring, atomic save, publication, learner access) | Installed + accepted | CLAUDE.md §20 |
| M6 exams (45 min · 25 questions · 80% · lessons first · 60-min cooldown · 3/day · President-only extra time) | Installed + accepted 18 Oct | PR #22 comments 6256331845, 6257614309 |
| M7 certificates (claim · 12 months · President-only revoke · public verify) | Installed + accepted 18 Oct (fingerprint `42dc5429…`, probe 9/9 BLOCKED) | PR #23 comments (M7 acceptance) |
| Code on production | `main@f2e8568` Published 8:49 PM CT | Netlify deploy list |
| Live flag-off behaviour | PASS (below) | PR #23 comment (this release) |
| Trusted client IP (`x-nf-client-connection-ip`) | PASS on Netlify's real edge | PR #22 comment 6257614309 |
| Golden course v1 | DRAFT · readiness 0 blocking / 3 advice · 11 modules · 60 usable exam questions (30 scenarios, every module) · 25 per attempt · 80% · 12-month validity | Command Center readiness (President session) |
| Learner journey, end to end | PASS locally (isolated DB, synthetic accounts) | `test/academy-phase4.browser.js` 9/9 |
| Dealership management + isolation (API and database) | PASS locally | `test/academy-phase3.pg.test.js` 9/9 (PG16 + PG17.6) |
| Learner email (sign-in codes, invitations) | **Not configured** — `RESEND_API_KEY` / `ACADEMY_MAIL_FROM` unset | — |

## Live flag-off checks (production, 18 Oct ~20:55 CT, no data written)

- `/academy/` and `/academy/verify/`: 200, CSP `default-src 'self'; script-src 'self' …`, `X-Frame-Options: DENY`, noindex.
- academy-api `my_certificates`, `claim_certificate`, `exam_start`: **403 `flag_off`**.
- academy-verify GET: `{"enabled":false}` · POST: 405.
- academy-handoff status: `{"enabled":false}`.
- academy-admin-api without a token / with a forged token: **401**.
- As the President: `whoami` (only `academy_admin` true), `list_certificates` (0, summary all zero) 200;
  `revoke_certificate` with a 2-character reason refused by the API (400) before the database.
- Site and Connect 360 pages: 200.

## Owner decisions still open (none blocks the pilot preparation)

1. **Learner email sender and wording** — set `RESEND_API_KEY` and `ACADEMY_MAIL_FROM` (Production scope) in Netlify,
   verify the sending domain in Resend, approve the code / invitation wording. Without it nobody can sign in by email
   (Partner 360 handoff still works).
2. **Re-certification after expiry or revocation** — M1 allows one certificate per enrollment. Recommended: re-certify on a
   new course version (no schema change; first expiry is October 2027).
3. **Pilot dealership and people** — use the existing TEST sandbox dealer (TEST data is kept apart from real figures and a
   TEST *course* never issues a certificate — but the Golden course is not a TEST course, so pilot certificates would be
   real HCPS certificates: decide whether to revoke them after the pilot or keep them).
4. **Publish Golden v1** — move draft → in review → publish (President only, M4). Required before anyone can enroll.
5. The three readiness advice items (1.1 no scenario; 4.1 ~18 minutes; 10.2 reads ~14 minutes) — accept or edit.

## Activation order (each line = one reviewed SQL line Angelo runs, or one Command Center action)

Each switch is turned on with `update app_settings set value = value || '{"<switch>": true}' where key = 'phase2_flags';`
and off with the same line and `false` (the first step of any rollback; no deploy needed).

| # | Step | Who | Check after |
|---|---|---|---|
| 0 | Email sender set + domain verified + one test code to an HCPS-owned address | OWNER | Resend delivery log shows one email |
| 1 | Publish Golden v1 (Command Center → Courses → Publish) | OWNER | Courses tab "Training available"; records check clean |
| 2 | `academy_learner` ON | OWNER | sign-in page accepts a code; `me` 200 for a signed-in pilot learner; others still `flag_off` |
| 3 | `academy_invites` ON (Training Manager invitations) | OWNER | pilot TM can invite into the TEST dealer only |
| 4 | `academy_handoff` ON (Partner 360 Training button) | OWNER | handoff status `enabled:true`; one pilot dealer user lands signed in |
| 5 | `academy_exams` ON | OWNER | exam status shows 45 min / 25 / 80% / cooldown / 3 a day |
| 6 | `academy_certificates` ON | OWNER | a pilot pass issues `HCPS-XXXX-XXXX`; `/academy/verify/` shows it valid |
| 7 | Pilot review → real dealers | OWNER | separate approval |

Rollback at any step: turn the last switch off. Data written during the pilot (learners, attempts, certificates) is never
deleted or rewritten; a pilot certificate is withdrawn only by a President revocation with a reason.

## Controlled pilot package (synthetic / HCPS-owned accounts only — no real dealer is contacted)

| Role | Account | Expected |
|---|---|---|
| Pilot dealership | the existing TEST sandbox dealer (`is_test`) | kept out of real Academy figures |
| Training Manager | an HCPS-controlled mailbox, appointed by the President in the Command Center | sees only the TEST dealer |
| Learner A (pass) | HCPS-controlled mailbox | completes every lesson → exam → pass (≥ 80%) → certificate → verifies valid |
| Learner B (fail, retake) | HCPS-controlled mailbox | fails once → cooldown shown → retake after 60 min → pass |
| Learner C (interrupted) | HCPS-controlled mailbox | loses connection mid-exam → answers kept → reload resumes the same clock |
| Learner D (leaves) | HCPS-controlled mailbox | TM ends access → signed out at once → certificate (if any) still verifies |
| President | Angelo | extra-time accommodation for Learner C (reason recorded) · revoke one pilot certificate (reason) · Activity tab shows every step |

Expected results to sign off: every learner sees only their own courses; the TM sees lessons done / total, exam passed / not passed
with the attempt count and certificate status — never a score; the 4th exam start in one day is refused; the President's
Activity tab holds an audit row for every invitation, enrollment, attempt, certificate and revocation; nothing reached a
real dealer; no email went anywhere but the HCPS-controlled mailboxes.

## Local evidence (isolated database, synthetic accounts; not a production pass)

- `test/academy-phase4.browser.js` — 9/9: Partner 360 handoff (390) → TM enrolls (360) → both lessons with server-graded
  practice checks → exam locked until done → fail → cooldown → after the cooldown autosave + offline + reload resumes the
  same attempt and deadline → pass → certificate → print layout → public verification → TM sees passed + certificate, no
  score → President API lists it → key screens at 360 / 768 / 1280 with axe clean.
- `test/academy-phase3.pg.test.js` — 9/9 PG16 + PG17.6 (dealership jobs + isolation in API and database).
- `test/academy-m7.pg.test.js` 18, `test/academy-a2f.pg.test.js` 11, `test/academy-a2f.browser.js` 4, A2F mutants 32/32;
  `test/academy-m6.pg.test.js` 32, `test/academy-a2e.pg.test.js` 12, learner browser 6, C1 52, regressions green.
