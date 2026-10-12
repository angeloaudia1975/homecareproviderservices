# A2D Stage 3 — Course Builder (runbook)

Authorized by Angelo on 12 Oct 2026 at 11:27 CT. Built on branch `academy/a2d-course-builder` as a draft PR.
It is not merged. It creates no Academy course records and does not load the Golden course.

## What it is

The page is `/admin/academy-builder.html?version=<id>`. Open it from Command Center → Courses → a version → **Open course builder**.

- **Who can use it:** the President and HCPS administrators, behind the same gate as the Command Center.
- **Read-only cases:** a version in review, published or retired opens read only.
- **Pieces:**
  - the page script, `src/admin/academy-builder.js`;
  - the server actions, `netlify/functions/_academy_builder.js`, registered in `academy-admin-api.js`;
  - storage helpers in `_academy.js`.

| Priority Angelo set | Where it is |
|---|---|
| Visual lesson editing with no code | **Lessons & screens.** A form for each of the 14 screen kinds; lists and choices are added, moved and removed with buttons. |
| Drag-and-drop with mobile move controls | Screens, lessons and modules move by drag handle (⠿) or by ▲ ▼ buttons. The buttons are 44 px, keyboard friendly, and keep focus on the moved item. Lessons move within their module. |
| Live lesson previews | The Stage 2 learner player draws the **unsaved** screens (`preview_blocks`). Desktop and phone widths are available. Practice checks are graded on the server; nothing is saved. |
| Golden images under the President's control | **Pictures & media.** Any administrator may upload a *candidate*: private, named by its SHA-256, never overwriting another file. Only the President approves it, recording rights, permission, and alt text or "decorative". Only the President discards a candidate, with a reason; the audit row is written before the file is removed. The database repeats the President-only rule (M3). |
| Interactive comparison and scenario editing | **Comparison:** model chips, rows of specifications, and a live grid that marks cells not recorded (red) or awaiting confirmation (amber). **Scenario:** 3–4 responses with feedback and best-answer marks. **Explorer:** hotspots are placed by clicking the picture. |
| Question bank with configurable module distribution | **Question bank:** create, edit, retire (a reason is required), restore, and link facts. Answer keys appear on this screen only. **Exam distribution:** automatic, or a number per module that must add up. |
| Readiness warnings | **Readiness** and the header badge. Blocking items: missing pictures, video or documents; unrecorded or unconfirmed facts; incomplete screens; bad knowledge checks; too few usable exam questions; a distribution that does not work. Advice items: lesson length, scenario share, the 60-question target. Each item opens the place to fix it. |

## Rules it keeps

- **Every write is an audited database operation.**
  - Modules and lessons use the M2 operations.
  - Screens, order, distribution, questions, media and fact links use the M3 operations.
  - The single exception is the storage removal on a discard, which is preceded by its own audit row.
  - The acting person is always the signed-in staff member.
  - **No new SQL** and no database change.
- **A save never overwrites someone else's work.** Each save names the content it started from; anything else gets 409 "changed".
- **A refused save leaves the lesson exactly as it was.** The facts a save needs are linked first, each link audited. If the database then refuses the screens, those links are undone.
- **Unsaved screens are never lost silently.** Switching lessons asks first, and so does leaving the page.
- **The upload size is limited.** The upload is the only request allowed above 256 KB, and only with its `x-academy-upload` header. Files are capped at 3 MB because Netlify limits a request to 6 MB, and base64 encoding inflates the file. That is lower than the 5 MB the plan proposed.
- **Pages never build HTML.** Text is placed as text, and no browser dialogs are used.
- **Still disabled:** learner access, invites, enrollment, certificates, payments and automatic Golden updates. Switches are unchanged.

## Tests

| Test | What it covers | Result |
|---|---|---|
| `test/academy-builder.test.js` | Readiness rules, hashes, upload types; static page rules (no HTML building, no actor sent, only allowed actions, no dialogs) | 16 |
| `test/academy-builder.pg.test.js` | The real handler against real Postgres with A1, M1, M2 and M3, through `test/academy-pgrest.js` | 21 |
| `test/academy-builder.browser.js` | Chromium against the real API and the real database rules (details below) | 13 |
| `test/academy-builder.mutants.js` | Server mutants | 29/29 killed |
| Browser test with `BUILDER_MUTANT` | Page-script mutants | 5/5 killed |
| Regression | C1 49, A2A 31 + pg 18, M2 pg 18, M3 pg 28, lesson 23 + pg 5 + browser 11, C1 browser 6; admin masthead on the Academy pages 60/60 | All pass |

**What the browser test exercises:**
- all 14 kinds built with the forms only;
- the preview following unsaved edits;
- dragging and keyboard moves;
- hotspot placement;
- the question bank and distribution;
- the upload → President approval flow;
- the readiness links;
- the unsaved-change guard;
- read-only versions;
- hostile text;
- widths 1440, 1280, 1024, 820, 390 and 360;
- axe WCAG 2.2 A/AA.

**Mutants held by a second layer.** Five server mutants removed a check that a second layer repeats; that layer still refused, which shows the defence in depth holds:
- the locked-version save;
- President-only approval;
- video embed hosts;
- a retire reason;
- answer keys in the preview (the payload builder strips them).

**Known regression failures.** These fail exactly as on main:
- `mi1c-*`, which needs the September PDF;
- `resources-render`, because documents.json lacks models.

## Deployment

Merging deploys code only. There is no SQL to run and no switch to change.

After the merge:
1. Confirm Netlify shows "Published".
2. Open the Command Center → a draft version → Open course builder. No course exists yet in production, so the builder has nothing to open until Angelo approves creating the Golden course draft.
3. Check that a forged token gets 401 and that the learner API still answers 403.

**Rollback:** revert the merge commit. Nothing in the database depends on it.
