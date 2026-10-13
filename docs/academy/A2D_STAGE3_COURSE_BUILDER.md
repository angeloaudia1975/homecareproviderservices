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
- **A save never silently overwrites someone else's work, and a failure never leaves a silent partial change.** See "The save sequence" below.
- **Unsaved screens are never lost silently.** Switching lessons asks first, and so does leaving the page.
- **The upload size is limited.** The upload is the only request allowed above 256 KB, and only with its `x-academy-upload` header. Files are capped at 3 MB because Netlify limits a request to 6 MB, and base64 encoding inflates the file. That is lower than the 5 MB the plan proposed.
- **Pages never build HTML.** Text is placed as text, and no browser dialogs are used.
- **Still disabled:** learner access, invites, enrollment, certificates, payments and automatic Golden updates. Switches are unchanged.

## The save sequence (review item 1, 12 Oct 2026)

> **Superseded on branch `academy/m3_1-atomic-save` (M3.1, development):** once M3.1 is installed and that branch is merged, the builder saves through ONE database operation instead of the sequence below. See `docs/academy/A2D_M3_1_ATOMIC_SAVE.md`. The sequence below describes production until then.

M3 has no single operation that links the facts, writes the screens and compares the starting point together. No new SQL is allowed without Angelo's approval, so a save is a short series of operations. Each operation is atomic with its own audit row:

1. **Start check.** The save must start from the lesson's current content. Otherwise the answer is 409 "changed".
2. **Fact links.** The facts the screens show are linked to the lesson (M3 shows a fact only when it is linked). Each link is audited.
3. **Re-check.** The starting point is checked again just before the screens are written.
4. **Write.** The screens are written through `academy_author_op_set_blocks`, which runs the database's own block checker.
5. **Overwrite check.** The audit row of that write records the content it replaced. If that is not the content the save started from, someone saved in the gap. Their version is put back (audited), and this save answers 409. The history shows their save, ours, and the put-back.
6. **Tidy-up.** Fact links the saved screens no longer use are removed (audited). Links always end up matching the screens.

| Failure (tested by injection against real Postgres) | Result |
|---|---|
| The write fails after linking | The links are undone (link and undo both in the history); the lesson is unchanged |
| The screens are refused and an undo also fails | The answer says a link is left; the next successful save removes it |
| Someone saves while this save is linking | Caught at step 3; this attempt's links are undone; 409 |
| Someone saves in the gap before step 4 | Caught at step 5; their version is put back; 409 |
| The write succeeds but its answer is lost | 409 "reload"; nothing is undone, so the saved screens keep their facts |

**What remains non-atomic.** For the moment between steps 4 and 5, the other person's version is replaced before it is put back. A learner never sees it, because there is no learner access and the version is a draft.

**Proposed M3.1, for separate approval only, not built.** One database operation, `academy_author_op_save_lesson(p_actor, p_lesson_id, p_blocks, p_base_hash, p_links)`, would do steps 1–6 in one transaction under the lesson's row lock, comparing the hash of the stored blocks. It needs no new tables and no change to M1 or M2. It would replace this sequence; the builder would keep the same screens.

## Uploads: today and later (review item 2)

Approved for Stage 3: a **3 MB** limit, with these protections kept:
- the contents are checked against the file type on the server;
- the size limit;
- a private, hash-named store that never overwrites;
- the President's approval before use;
- the President alone may discard, with a reason and the audit row first.

**Future improvement (not built).** Large brochures and PDF manuals would go straight to private Supabase storage, so the whole file never passes through Netlify:
1. The browser hashes the file (SHA-256) and asks the admin API for an upload slot. The request gives the name, type, size and hash.
2. The server checks the person, the type and a larger limit (for example 50 MB for PDFs). It picks the hash-named path `media/<folder>/<sha16>-<name>` and returns a short-lived **signed upload URL** for that one path, with no overwrite allowed.
3. The browser uploads directly to storage.
4. The browser calls `finish_upload`. The server downloads or streams the stored object, re-checks the size, the file signature and the SHA-256, and removes the object (audited) if anything differs.
5. The file is then a candidate like today: unusable until the President approves it.

This needs the storage signed-upload endpoint and a limit setting only. There is no database change, and the bucket stays private.

## Tests

| Test | What it covers | Result |
|---|---|---|
| `test/academy-builder.test.js` | Readiness rules, hashes, upload types; static page rules (no HTML building, no actor sent, only allowed actions, no dialogs) | 16 |
| `test/academy-builder.pg.test.js` | The real handler against real Postgres with A1, M1, M2 and M3, through `test/academy-pgrest.js`, including 6 failure-injection tests of the save sequence | 27 |
| `test/academy-builder.browser.js` | Chromium against the real API and the real database rules (details below) | 13 |
| `test/academy-builder.mutants.js` | Server mutants | 33/33 killed |
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

**Mutants held by a second layer.** Seven server mutants removed a check that a second layer repeats; that layer still refused, which shows the defence in depth holds:
- the first starting-point check, twice (the re-check before the write still refuses);
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
