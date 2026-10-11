# A2C Part C1 — Academy Command Center (foundation)

Status: **PR #5 merged 11 Oct 2026 (main 1a942ce) and verified in production with the switch OFF.** All seven Academy
switches OFF. The Command Center is not switched on until M2 (atomic content operations, `docs/academy/A2C_M2_CONTENT_OPS.md`)
is installed, tested and separately approved for staff-only activation. Course publication rules for C2:
`docs/academy/C2_COURSE_PUBLICATION_DESIGN.md` (design only).

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
- **Audited database operations:** M2 (`academy_content_op_*`) is the only road for courses, draft versions, modules and lessons. M1 (`academy_op_*`) is the only road for:
  - publishing or retiring a version;
  - granting or removing the Training Manager role;
  - verifying or rejecting a manufacturer credential;
  - recording, replacing or withdrawing a product fact.

  If the operations are missing, the answer is 503. It never falls back to a plain write.
- **President only:**
  - publishing or retiring a version;
  - recording an approval-required fact (the President is recorded as the approver);
  - changing details of a course learners have seen.
- **Published or in-review content cannot change.** The server allows edits only on drafts. With M2 the database checks again under a lock on the version (race-safe: 409 `locked`). The A1 triggers, the M1 guard and the M2 guard refuse the same edits again.
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

**With M2 (branch `academy/m2-content-ops`, approved design, awaiting review before merge or production run):** every
ordinary write is ONE call to an `academy_content_op_*` database function, which saves the change and its audit row in
one transaction or neither. A guard trigger refuses every other write to the four content tables. Details, tests and
the production runbook: `docs/academy/A2C_M2_CONTENT_OPS.md`. If M2 is not installed, these writes answer 503 and never
fall back to a plain write.

**As merged in PR #5 (before M2), `recorded()` wrote audit-first:** the audit row with a `_ref`, then the change, and a
`<action>_failed` row if the change failed. The switch was never turned on, so production has no such rows. The
records check still understands `_ref` / `_failed` rows.

**Records check (`audit_check`, Activity tab):** compares every course, version, module and lesson with its latest
*effective* audit row. It reports unrecorded rows, drift (current values differ from the history) and missing rows.
It is read-only and stays as an independent safety net with M2.

## M2 (atomic ordinary writes)
Design approved by Angelo on 11 Oct 2026 (Option A, audited content operations built like M1). Built on branch
`academy/m2-content-ops`; see `docs/academy/A2C_M2_CONTENT_OPS.md`.

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
| `node test/academy-c1.test.js` | 49 tests (with M2: the content operations are answered by `test/academy-content-ops.fake.js`) |
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
- **M2**: draft PR, waiting for Angelo's review. Not merged and not run in production.
- **Course-status rule**: C2 design in `docs/academy/C2_COURSE_PUBLICATION_DESIGN.md`, with decisions A–E for Angelo.
- **Pending in C2:** module reorder, question authoring and lesson blocks.
- **Approval-required facts:** recorded by the President only. A two-person approval queue would need its own design.
- **Mobile header:** fixed in PR #6 (merged 11 Oct 2026, main 2eceda2), not in PR #5.
