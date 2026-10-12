# HCPS Academy — A2D Stage 2: the lesson engine

Authorized by Angelo on 11 Oct 2026 at 21:00 CT (development only; a draft PR, no merge without his approval).
Built on branch `academy/a2d-lesson-engine` from main `3baa6c9` (PR #8 merged and verified).

## What it is

There is ONE lesson renderer for every place a lesson is shown. Today that is the staff preview in the Academy Command Center. Later it will be the learner player at `/academy/` (A2E). Nothing here is reachable by a learner, and no switch changes.

| Piece | File | Job |
|---|---|---|
| Payload builder (server) | `netlify/functions/_academy_lesson.js` | Turns a stored lesson (blocks + its facts, media and practice questions) into the payload the player draws. Builds every field by hand from a known block kind; nothing from the database is passed through as-is. |
| Samples A and B | `netlify/functions/_academy_samples.js` | The approved A0 mockups (boards 2A and 2B) rebuilt as lesson data in the exact M3 block format. Staff preview only; never a course record. |
| Preview actions | `netlify/functions/academy-admin-api.js` | `preview_sample`, `preview_lesson`, `preview_check`. Read only. Administrators only, and only while `academy_admin` is on (the existing gate). |
| Private links | `netlify/functions/_academy.js` `signPrivate()` | A link to one file in the private `academy-private` bucket that expires after 15 minutes. Only paths M3 itself chooses (`media/<folder>/<file>`) are signed. |
| Renderer | `src/assets/academy/lesson-player.js` + `.css` | Draws the 14 block kinds. The same file will run under the `/academy/*` Content Security Policy unchanged. |
| Staff preview page | `src/admin/academy-preview.html` | Opened from the Command Center: Courses → "Lesson player preview" (Samples A and B), or "Preview" beside any lesson of a course version. It has a width switch (Desktop, Tablet 820, Phone 390, Phone 360). |

## The 14 block kinds and how they are drawn

| Kind | Drawn as |
|---|---|
| objectives | "You will be able to" list. Always the first screen. |
| text | Paragraphs, bullet and numbered lists, and **bold**, from plain text. Never HTML. |
| callout | Tip, Caution or "Ask Golden" (the course manufacturer's name). |
| quote | The manufacturer's own words, with the source, link and date. |
| image | A picture that keeps its shape while loading, with alt text (a decorative picture is hidden from screen readers). A missing or failed file becomes a labelled placeholder. |
| video | A "Play" panel. The YouTube no-cookie or Vimeo frame loads only after a tap. |
| document | An "Open" link (it opens the manufacturer's site, or an HCPS copy through a private link). |
| fact | The value, model, source, link and verified date. "Awaiting Golden confirmation" shows in amber with its note. A missing fact shows "Not available yet" and is never guessed. |
| comparison | A table with every cell from product facts. It has a "Show differences only" toggle, and the feature column stays put while models scroll sideways on a phone. |
| explorer | Tabs (moved with the arrow keys, Home and End), cards, or numbered hotspots on a picture, with the same points also as a list of buttons. |
| steps | A numbered procedure with its source. |
| scenario | 3–4 choices with feedback on each. Never scored. |
| check | Practice questions, one at a time. Each answer is checked on the server, and the explanation is shown only after answering. |
| takeaways | 3–5 points, then "Awaiting Golden confirmation" (from the facts) and "Sources used in this lesson" (built from the facts, quotes and steps). |

**Slide-style presentation.** By default the lesson shows one screen at a time, with Back, a position ("5 of 15") and Next. "Whole lesson" shows every screen on one page. Below 900px of player width:
- the module list becomes an "All modules" panel (Escape closes it and focus returns);
- Back and Next sit in a bottom bar that clears the iPhone home bar.

The player measures its own width with container queries, so the staff preview shows the real phone layout inside a desktop page.

**Progress (engine side).**
- A screen of reading, a picture, a fact, a comparison, steps or takeaways counts once it has been on screen for a moment.
- A video or document counts when it is opened, or when the learner moves past it with Next.
- An explorer, scenario or check counts once it has been used. A check needs every question tried.
- The completion button unlocks only when every screen counts.

The preview never saves anything. The learner save (`onProgress`) arrives in A2E.

## Security rules kept

- Text is always text. The renderer has no `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval` or `new Function`, and a test reads the source to prove it. A hostile lesson with HTML and script in every field runs nothing and injects nothing (browser test).
- Links are https only. Video frames are only `youtube-nocookie.com/embed` or `player.vimeo.com/video`, the same pattern as M3 and the `/academy/*` frame policy. The pattern is checked on the server and again in the browser, and a test proves all three copies are identical.
- **Answer keys never leave the server.** A preview payload carries a question as id, kind, prompt and choices only, with no key and no explanation. `preview_lesson` reads questions without `answer_key` and `explanation` in its select. `preview_check` is the one place a key is read: it checks one PRACTICE answer and returns right/wrong plus the explanation.
- **`preview_check` refuses:**
  - an exam question (403);
  - a retired question (409);
  - a question that is not in that lesson's checks, or that belongs to another course version (404);
  - an answer sent by GET (405).
- **An exam question is never shown in a lesson.** The database refuses it in a check (M3). If one ever appeared, the payload builder leaves it out and warns the staff.
- **Who and when:** the same gate as the rest of the Command Center. That means the Connect 360 sign-in, an active president, admin or owner, and `academy_admin` exactly true. Everyone else gets 401 or 403. Nothing in Stage 2 writes: no database row, audit row, switch or operation.
- **No Golden photography.** Every sample picture is a labelled placeholder until Angelo approves the specific files.

## Database: nothing new

Stage 2 needs no production SQL. Every file under `supabase/` is unchanged, and so are `netlify.toml` and `package.json`.

The samples are proven to be real lesson data. `test/academy-lesson.pg.test.js` stores both samples through the real M1, M2 and M3 operations in a local Postgres:
1. a draft course and version;
2. the facts (M1 `record_fact`);
3. the practice questions and fact links (M3);
4. the blocks, which pass M3's block checker unchanged.

It then reads the lesson back the way `preview_lesson` does, and checks the payload equals the sample's own preview payload. It passes on PostgreSQL 16 (with pg-safeupdate) and 17.6.

## Tests

| Suite | Result |
|---|---|
| `test/academy-lesson.test.js`: payload, samples, preview actions, private links, renderer static checks | 23/23 |
| `test/academy-lesson.pg.test.js`: samples through the real M1/M2/M3 operations, PG 16 and 17.6 | 5/5 and 5/5 |
| `test/academy-lesson.browser.js` (Chromium; see below) | 11/11 |
| `test/academy-lesson.mutants.js`: server and payload protections | 22/22 killed (one equivalent mutant documented in the table) |
| `test/academy-lesson.mutants.js --browser`: renderer protections | 10/10 killed, control survives (one equivalent mutant documented) |
| `academy-c1` 49, `academy-c1` mutants 39/39, `academy-c1.browser` 6, `academy-a2a` 31, admin masthead on phones (Academy pages) 40/40 | pass |

What the browser suite checks:
- **Five widths:** Samples A and B walked screen by screen at 1440, 1024, 820, 390 and 360px. On every screen: no sideways scroll, every control at least 44px, no text under 12px. Each lesson completes, and "nothing was saved" is shown.
- **A course lesson from the database:**
  - numbered hotspots on a real picture;
  - a file that fails to load becomes a labelled placeholder (zero broken images);
  - a decorative picture;
  - the video loads only on tap;
  - the document link opens with `noopener`;
  - the fact shows its value, source and date.
- **Keyboard:** Tab reaches every control, each with a visible focus ring. Tabs move with the arrow keys. "All modules" opens, and Escape closes it and returns focus.
- **Comparison:** differences-only hides rows that are the same for every model. The feature column stays fixed while the models scroll.
- **Phone width in the preview:** the in-page width switch gives the same layout as a real phone.
- **Completion:** it waits for every knowledge-check question.
- **Hostile lesson:** nothing runs, nothing is injected, and unsafe links are dropped.
- **Access:** a rep and the switched-off state see no lesson.
- **axe-core 4.10 (WCAG 2.2 A and AA):** no violations in Samples A and B or the course lesson, on desktop and phone, with answers and feedback showing.

Run them like this:
```
node test/academy-lesson.test.js
PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres node test/academy-lesson.pg.test.js
PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright AXE=/path/to/axe-core/axe.min.js SHOTS=/tmp/shots node test/academy-lesson.browser.js
node test/academy-lesson.mutants.js            # and: --browser (needs PLAYWRIGHT_MODULE)
```

## How the samples map to the 14 kinds (vs. the mockups)

The mockups used two custom interactions that are not block kinds. Version 1 has no free-form embeds, so both are rebuilt from the approved kinds:
- **Sample A's system-then-zone explorer** becomes three explorers: "The five Comfort Zones" (cards), "Which system, which chairs" (tabs) and "AutoDrive preset positions" (tabs).
- **Sample B's three-question Cloud finder** becomes a tabs explorer, "Cloud finder: what the customer tells you", with the same recommendations.

Sample B adds two blocks: a steps block for the three fitting checks (HCPS method, Module 7) and a document placeholder for the PR511 sell sheet. With these, A and B together use all 14 kinds.

The approved plan mentions 82 mockup checks. Those were not re-run one by one. The browser suite above covers the same ground (layout, interaction, accessibility, placeholders, facts and flags) on the rebuilt data, plus the axe-core audit.

## Not in this stage

- the course builder;
- media upload;
- the question-bank editor;
- the learner player page and progress saving (A2E);
- loading the Golden course (A2F);
- publication rules (C2).

No switch changes. No course, fact, question or media record is created anywhere.
