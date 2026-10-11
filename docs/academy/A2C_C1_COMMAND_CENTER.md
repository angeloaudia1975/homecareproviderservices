# A2C Part C1 — Academy Command Center (foundation)

Status: **draft PR #5, awaiting Angelo's final GO/NO-GO and merge approval.** Not merged, not deployed to production.
All seven Academy switches OFF. Authorized 10 Oct 2026 23:12 (code, local testing, draft PR only). Final review
requirements from Angelo, 11 Oct 2026 08:27 — addressed below.

## What it is
`/admin/academy.html` in Connect 360 → Sales & Marketing → **Academy Command Center**, served by
`netlify/functions/academy-admin-api.js`. It has six tabs; the design was accepted by Angelo on 11 Oct 2026.

| Tab | What it does |
|---|---|
| Overview | Real figures for courses, versions, learners, dealerships, enrollments, HCPS certificates, manufacturer credentials and product facts. TEST pilot data is shown apart, never mixed in. Also: the two kinds of credential, manufacturers, recent activity |
| Courses | Courses for any manufacturer on the HCPS list; draft courses; details. Versions: new draft, settings, modules and lessons, submit for review / return to draft, **publish and retire (President only)** |
| Learners & Dealerships | Per dealership (branch under its parent; TEST dealers flagged and listed last) and per learner (TEST pilot learners flagged); Training Manager role |
| Product Facts | Current facts with source and date; history; record, replace, withdraw |
| Certifications | HCPS-issued certificates (read-only) and manufacturer-issued credentials (verify / reject), always kept apart |
| Activity | Full audit history, filtered and paged, plus the **records check** |

## Security (verified by tests)
- **Access:** the `academy_admin` switch must be ON *and* the caller an active president, admin or owner. Reps and Relations get 403 for every action, including unknown ones. No sign-in, an inactive account or a learner cookie gets 401. `whoami` answers any active staff member, so the page can explain itself.
- **Identity:** the actor is always `staff:<signed-in email>`. These request fields are ignored: `actor`, `p_actor`, `verified_by`, `approved_by`, `published_by`, `email`, `role` and `staff`.
- **M1 audited operations:** the only road for:
  - publishing or retiring a version;
  - granting or removing the Training Manager role;
  - verifying or rejecting a manufacturer credential;
  - recording, replacing or withdrawing a product fact.

  If the operations are missing, the answer is 503. It never falls back to a plain write.
- **President only:**
  - publishing or retiring a version;
  - recording an approval-required fact (the President is recorded as the approver);
  - changing details of a course learners have seen.
- **Published or in-review content cannot change.** The server allows edits only on drafts. The write itself is limited to `status=eq.draft`, which makes it race-safe. The A1 triggers and the M1 guard refuse the same edits again.
- **Not in C1:**
  - issuing or revoking certificates;
  - exams and question authoring;
  - lesson blocks;
  - switches;
  - course-record status;
  - the manufacturer list.

  Calls for these get 404.
- **Never exposed:** answer keys, question prompts and choices, learners' answers and token hashes, including inside audit history. Questions are only counted. The internal certificate-file id is not returned; only `has_upload` is.
- **Fails closed:** an unreadable table, including the TEST-dealer list, is a 503, never an empty list. Changes must be POST; GET gets 405.

## Ordinary content writes: audit behaviour
**Which writes are "ordinary":** draft courses, draft versions, modules, lessons, and version draft ↔ in-review moves.
They are not M1 operations. The web API cannot write a change and its audit row in one transaction.

**What C1 does (`recorded()` in academy-admin-api.js):**
1. **Audit row first.** It holds the intended result and a reference (`after._ref`). If the activity history cannot be written, **nothing is changed**: the answer is 503 `audit_unavailable`. A change can never happen without its record.
2. **Then the change.** If the change fails, a `<action>_failed` row with the same `_ref` is added and the error is returned. If that failure row also cannot be written, the server logs `academy audit: the failure record could not be written` with the reference.

**What can still go wrong:** the change fails *and* its failure row is lost. The history then claims a change that did not happen. That is the safe direction (never a silent change), and the records check finds it.

**Records check (`audit_check`, Activity tab):** compares every course, version, module and lesson with its latest *effective* audit row. An action whose `_ref` has a matching `_failed` row counts as not done. It reports:
- **unrecorded rows:** content that has no history;
- **drift:** current values differ from the history, either because something was changed outside the Command Center or because a failure record was lost;
- **missing rows:** recorded but not present.

It is read-only. The rows created by the A1/M1 acceptance tests are gone, so production starts clean.

## Proposal: make ordinary writes atomic (M2) — before production authoring
**Recommended: Option A, audited content operations, built like M1.**
- **New functions:** SECURITY DEFINER functions, executable by the server role only, with a pinned search path, for example:
  - `academy_op_save_course(p_actor, p_course jsonb)`
  - `academy_op_save_version(p_actor, p_version jsonb)`
  - `academy_op_move_version(p_actor, p_id, p_to)` (draft ↔ in_review only)
  - `academy_op_save_module(...)` / `academy_op_delete_module(...)`
  - `academy_op_save_lesson(...)` / `academy_op_delete_lesson(...)`
- **Checks inside each function:**
  - `academy_op_actor_staff(p_actor)`;
  - a per-entity field allow-list;
  - draft-only checks against the version row, read `for update`;
  - President-only for seen courses (needs an `academy_op_actor_president` helper);
  - the `academy_events` row written in the **same transaction**.
- **Guard:** extend `academy_audited_guard` to `academy_courses`, `academy_modules` and `academy_lessons`, and to non-status edits of `academy_course_versions`. Plain writes are then refused, exactly as in M1.
- **Code:** `recorded()` becomes `A.op(...)`. The records check stays as an independent safety net.
- **Tests:**
  - a pg hardening file, with failing-before/passing-after;
  - the A1/M1 acceptance suites rerun;
  - a public-key probe (all BLOCKED);
  - the code fingerprint computed for both line-ending forms.

**Option B, an AFTER trigger on the content tables writing `academy_events`:** fewer functions, and the actor comes from a PostgREST request header the server sets. It is not recommended:
- the actor would be any header the server role sends;
- plain writes stay open;
- draft rules would live in two places.

**Sequence:**
1. Angelo approves the design.
2. Claude writes M2 with its tests.
3. Angelo approves the exact SHA and runs it by hand.
4. Code PR switches to the operations.
5. Verification.

Only then is `academy_admin` considered for production authoring.

## Course status
**C1 (as built):** `academy_courses.status` is left as it is. C1 never writes it, so new courses stay `draft`.

The interface shows separately:
- **Training available:**
  - Published training (vN);
  - In review — not yet published;
  - Draft only;
  - Retired — no current version;
  - No versions yet;
  - Manufacturer-hosted.
- **Version counts:** draft, in review, published and retired.
- **Course record:** shown as a grey `record: draft` pill, with a tooltip saying it does not follow versions in C1.

A course with a published version therefore always reads **Published training (vN)**.

**Recommended permanent rule for C2:**
1. The course record status is **maintained only by audited operations, in the same transaction**, never set by hand:
   - `published` while the course has a published version (set by the publish operation);
   - `retired` only by an explicit, President-only audited "retire course" decision, which also retires its published version;
   - `draft` otherwise.
   The records check verifies it.
2. **Manufacturer programs have no versions.** Their availability is the course record itself, so they need President-only audited `publish_course` and `retire_course` operations.
3. **Publishing a new version replaces the old one in one transaction** (retire vN, publish vN+1). Today M1 `publish_version` refuses while another version is published, because of the unique index of one published version per course. C2 needs a "publish replaces" operation or an M1 amendment.

## TEST data
- **What counts as TEST:**
  - a TEST dealer is `dealers.is_test = true`;
  - a TEST course has a slug starting `test-`;
  - a **pilot learner** has all of their active memberships at TEST dealers.
- **Real figures exclude:**
  - pilot learners;
  - TEST dealers;
  - enrollments and certificates on TEST-course versions;
  - manufacturer credentials on TEST courses.

  The Overview shows the excluded amounts beside the real ones. In Learners & Dealerships, TEST dealers are flagged and listed last, and pilot learners are flagged. A learner with any real dealership counts as real.
- **A TEST course never issues a genuine certificate.** The database refuses it in M1 `academy_op_issue_certificate` ("a TEST course never issues a certificate"), covered by the M1 hardening tests. Issuance is also switched off, and the course screen says so.
- **Future reporting:** any later Academy metric (Dealer 360 in A2-dealer360, reports) must use the same rule.

## Navigation
- The Academy Command Center sits in `HUBS` → Sales & Marketing, which only administrators see. Reps and Relations get the focused workspace menu (`REP_TOOLS` / `RELATIONS_TOOLS`), which does not include it. If one opens the URL directly, the page shows "HCPS administrators only" and the server refuses every action.
- **Browser comparison** (`academy-c1.browser.js`): main's `admin-chrome.js` against this branch, for president, admin, owner, rep and relations, on the dashboard, the Sales hub and an existing tool page.
  - Admins gain exactly one link, `/admin/academy.html` (dashboard 49 → 50).
  - Reps (14) and Relations (18) are identical, and every role lands on the same page as before.
  - No link was lost for any role.

## Tests
| Suite | Result |
|---|---|
| `node test/academy-c1.test.js` | 47 tests |
| `node test/academy-c1.mutants.js` | 39 mutants, all killed; the control survives |
| `test/academy-c1.browser.js` (Playwright + Chromium) | 6 tests |

The browser tests run the real handler and cover:
- every tab at desktop and phone width;
- the records check;
- the President vs admin view;
- the full build-and-publish flow;
- the switched-off and rep views;
- navigation by role compared with `main`;
- hostile data (disabling `esc()` or `safeUrl()` makes it fail).

## Production switch check (read-only; Angelo runs it)
```sql
select k as switch, (s.value -> k) as stored_value, coalesce((s.value -> k) = 'true'::jsonb, false) as is_on
from unnest(array['academy_admin','academy_learner','academy_handoff','academy_invites','academy_external_uploads',
                  'academy_certificates','academy_dealer360']) as k
left join public.app_settings s on s.key = 'phase2_flags'
order by k;
```
Expected: 7 rows, `is_on = false` on every row.

## Open items
- **M2** (atomic ordinary writes) and the **course-status rule**: for Angelo's decision before production authoring and C2.
- **Pending in C2:** module reorder, question authoring and lesson blocks.
- **Approval-required facts:** recorded by the President only. A two-person approval queue would need its own design.
- **Mobile header:** the shared Connect 360 masthead overflowed phones. It is fixed in a separate PR (Connect 360 mobile header), not in PR #5.
