# A2C Part C1 — Academy Command Center (foundation)

Status: **draft PR, awaiting Angelo's review**. Not merged, not deployed to production. All Academy switches OFF.
Authorized by Angelo, 10 Oct 2026 23:12 (code, local testing, draft PR only).

## What it is
`/admin/academy.html` in Connect 360 → Sales & Marketing → **Academy Command Center**, served by
`netlify/functions/academy-admin-api.js`.

| Tab | What it does |
|---|---|
| Overview | Counts for courses, versions, learners, dealerships, enrollments, HCPS certificates, manufacturer credentials and product facts; the two kinds of credential; manufacturers; recent activity |
| Courses | Courses for any manufacturer on the HCPS list. Create draft courses; edit details. Versions: new draft, settings, modules and lessons, submit for review / return to draft, **publish and retire (President only)** |
| Learners & Dealerships | A summary per dealership (branch shown under its parent) and per learner; grant or remove the Training Manager role |
| Product Facts | Current facts with source and date; history; record, replace, withdraw |
| Certifications | HCPS-issued certificates (read-only) and manufacturer-issued credentials (review: verify / reject), always kept apart |
| Activity | The complete audit history, filtered and paged |

## Security
- **Who may use it:** `academy_admin` switch ON *and* an active president/admin/owner. Everyone else gets 403; no sign-in or a learner cookie gets 401. `whoami` answers any active staff member, so the page can explain itself.
- **Identity:** the actor is always `staff:<signed-in email>`. Request fields such as `actor`, `p_actor`, `verified_by`, `approved_by` and `published_by` are ignored.
- **Audited operations (M1):** publish/retire a version, Training Manager role, manufacturer credential review, record/replace/withdraw a fact. They run only through `academy_op_*`; there is no fallback to a plain write.
- **President only:** publish and retire a version; record an approval-required fact (the President is recorded as the approver); edit details of a course that learners have seen.
- **Draft only:** a version's settings, modules and lessons change only while it is a draft. The write itself is limited to `status=eq.draft`, so it is safe against a race. The A1 triggers and the M1 guard refuse the same changes again.
- **Not in C1:** issuing or revoking certificates, exams, question authoring, lesson content blocks, changing switches, changing a course's status, editing the manufacturer list. Calls for these get 404.
- **No exam answers:** questions are counted (`select=id,use,status`) and never returned. Answers, answer keys, choices and token hashes are hidden in the activity history.
- **Strict reads:** an unreadable table returns 503, never an empty list. Changes must be POST (GET → 405). A failed audit write is reported (`audited:false`), never hidden.

## Tests
- `node test/academy-c1.test.js`: 42 tests.
- `node test/academy-c1.mutants.js`: 29 mutants, all killed; the control survives.
- `test/academy-c1.browser.js` (Playwright + Chromium):
  - runs the real handler behind a local server;
  - checks every tab at desktop and phone widths;
  - checks that publish is offered to the President only;
  - runs a full build-and-publish flow through the page;
  - checks the switched-off and rep views;
  - runs a **hostile-data** pass: no payload executes and no `javascript:` link appears. Disabling `esc()` or `safeUrl()` makes this pass fail.

## Open items for later units (not built)
- **Course-level status** (`academy_courses.status`) stays `draft`. Publishing a version does not change it. Decide in C2 whether it is derived from the versions or set by its own audited operation.
- **Module reorder, question authoring, lesson blocks:** these come in C2.
- **Approval queue:** approval-required facts can be recorded only by the President. A two-person approval queue would need its own design.
- **Pre-existing finding:** the shared Connect 360 masthead overflows a 390 px phone screen on every admin page (the Lock button is cut off; the AI Style Guide shows the same). This lives outside the Academy and was not changed.
