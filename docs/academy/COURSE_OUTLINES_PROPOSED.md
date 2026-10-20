# HCPS Academy — proposed next courses (issue #30)

**Status of everything in this file: PROPOSED.** Claude drafted these outlines as a starting aid. Nothing here is written,
reviewed or approved by the HCPS owner yet, and none of it may be attributed to him until he adopts or edits it. No course
record has been created in production. Lesson copy, product claims, exam answers and publication stay the owner's.

Status gates for every course: **Proposed → Owner-reviewed outline → Draft lessons → Owner-approved publication →
Published.** Nothing publishes or certifies automatically, and a published version is never rewritten (a change is a new
version). A course appears on the public page as "Coming soon" only when the owner approves that.

## 1. What the existing builder already does (audit, 20 Oct 2026)

Everything below exists on main and is used through Connect 360 → Academy Command Center. No new system is needed.

| Need from #30 | Existing feature | Where |
|---|---|---|
| Course / version / module / lesson structure | Create and edit courses, draft versions, modules and lessons (audited M2 operations) | Command Center → Courses |
| Short interactive lessons | 14 screen types: objectives, text, callout, quote, image, video, document, fact, comparison, explorer, steps, scenario, check, takeaways | Course Builder |
| Role-play / scenarios | `scenario` screens (branching choices with feedback) and `check` screens (practice questions, graded on the server) | Course Builder |
| Product facts with source + date | Product Facts (source, date, status, President approval for sensitive fields); fact screens show source and date | Command Center → Product Facts |
| Images and documents with rights | Upload or import → candidate → President approves with rights, permission and alt text | Builder → Media |
| Exam bank, answers server-side | Question bank (exam / practice), per-module distribution, pass mark, question count; answer keys never leave the server | Builder → Questions |
| Readiness before publishing | Blocking items (missing media, unverified facts, empty lessons, thin exam bank) and advice | Builder → Readiness |
| Owner preview (desktop + phone) | Staff preview with the learner renderer, phone layout | Builder → Preview |
| Review → publish | Draft → in review → President publishes (M4, one transaction); TEST courses (`test-…`) never certify | Command Center |
| Free / paid per course | Access policy Free during launch / Paid / Off (F1, PR #31, pending install) | Command Center → Paid access |
| Training Manager workflow | Invite, enroll, end access, team progress, exam passed / not passed, certificates (no scores) | Learner app → My team |
| Usage | Overview counts, dealer summary, Dealer 360 Academy card | Command Center, Dealer 360 |

### Gap list (only what is genuinely missing)

1. **New version from a published one.** Creating version 2 gives an empty draft; the modules, lessons, screens, questions
   and fact links of version 1 must be rebuilt by hand. Needed for any correction to the Golden course (P1) and for every
   future course update. Proposal: an audited "copy published version into a new draft" operation (needs its own
   migration and owner approval).
2. **Course prerequisites.** No way to require course A before course B. Not needed for the first three courses.
3. **Outline import.** Modules and lessons are typed one by one. A paste-in outline (titles + minutes) would save time;
   small, builder-only.
4. **Bulk question import.** Questions are entered one at a time. A reviewed CSV import into the draft bank would help
   the 60-question banks below.
5. **Public "Coming soon" from the course record.** The landing page lists coming courses from the website editor, by
   hand. Fine for now; keep it manual so nothing shows without the owner's approval.
6. **Files over 3 MB.** Large brochures / manuals must be linked, not uploaded (documented limit; signed upload is the
   planned fix).
7. **Outside learners' certificates show no company.** The certificate's dealership line is empty for a learner at an
   outside organization (M7 reads the CRM dealer). Small follow-up: show the organization name.

## 2. Draft → preview → approve → publish on a non-public course

Proven locally with the real handlers and database (no production records created, per the testing rule):
`test/academy-builder.pg.test.js` (draft editing, atomic saves, media approval, readiness), `test/academy-m4.pg.test.js`
(review → President publish → retire), `test/academy-free.pg.test.js` (a `test-…` course: free policy, TEST dealership
learner enrolls, outsiders refused). A `test-…` course never issues a real certificate and never appears in public
catalogs. When the owner wants to see it live, the same steps run on a `test-…` course in his Command Center session.

## 3. Shared template for every course

- HCPS-issued certificate, 12 months; "independently developed and administered by HCPS; not issued, sponsored or endorsed
  by <manufacturer>".
- 10–15 minute lessons, each: objectives → 4–8 visual screens → one scenario or comparison → practice check → takeaways.
- Exam: 25 questions drawn across every module, 80% to pass, 45 minutes; bank target 50–60; only questions whose facts
  are verified are drawn (the system already enforces this).
- Every product claim is a Product Fact with a source document and date. Sales guidance written by HCPS is labelled as
  HCPS guidance, never as a manufacturer statement. No clinical or medical advice: "refer to the prescriber / therapist"
  where fit or medical need comes up.
- Media: manufacturer photos only with recorded rights; manuals and videos linked, not re-hosted, unless permission is
  recorded per asset.

---

## Course A — Golden Scooters & Power Mobility Sales Fundamentals (proposed)

**Purpose.** Help dealer staff match a customer to the right Golden scooter or power chair *category*, explain features
accurately, and hand off anything clinical. **Audience:** showroom and phone sales staff, new hires. **Runtime:** ~2 h
(8 lessons) + exam.

**Objectives (proposed).** The learner can: (1) run a needs conversation covering where, how far, transport, storage and
user capacity; (2) explain the difference between travel / portable, mid-size and full-size scooters, and when a power
chair is the better fit; (3) state a model's key specifications from the current Golden source, not memory; (4) explain
batteries, charging and range claims with the manufacturer's conditions; (5) recognise safety and clinical questions to
refer on; (6) close with accessories, warranty and delivery expectations.

| # | Lesson (≈ min) | Key screens / activities |
|---|---|---|
| 1 | Welcome and how mobility sales differ (8) | objectives; HCPS approach; takeaways |
| 2 | The needs conversation (15) | steps (question checklist); scenario: "my mother wants something for the mall" |
| 3 | Scooter categories (12) | comparison: travel vs mid-size vs full-size; explorer: what changes (frame, wheels, capacity) |
| 4 | Scooter or power chair? (12) | comparison; scenario: indoor tight spaces; callout: when to refer to a clinician |
| 5 | Reading a spec sheet (15) | fact screens (capacity, range, speed, turning radius — all sourced); check |
| 6 | Batteries, charging and range (12) | steps (charging routine); callout: range depends on conditions as Golden states them |
| 7 | Transport, storage and lifts (10) | explorer (disassembly, weights of heaviest piece — sourced); scenario: car trunk |
| 8 | Accessories, warranty and handover (12) | document (warranty, linked); steps (delivery checklist); takeaways |

**Downloadable checklists.** Needs-conversation card; delivery / handover checklist (HCPS-written).

**Question-bank blueprint (target 50).** L2 8 · L3 7 · L4 6 · L5 9 · L6 6 · L7 6 · L8 8. Mix: 40% scenario, 40% fact
(sourced, verified only), 20% process. No question on a model not confirmed current.

**Sources needed (source-of-truth table).**

| Claim area | Source | Status |
|---|---|---|
| Current model list | Owner's Golden product matrix + goldentech.com current pages | **Owner to supply / confirm** — never from scraped or discontinued listings |
| Per-model specs (capacity, range, speed, weights) | Golden spec / sell sheets, owner's manuals | To collect, date each |
| Battery and charging | Golden owner's manuals | To collect |
| Warranty | Golden warranty documents | To collect (link only) |
| Photos / videos | Golden (rights per asset) | Per-asset permission |

**Questions for the owner.** Which Golden scooter / power chair models does HCPS actively sell today? Is there a current
Golden power-mobility matrix or price sheet to treat as the model list?

---

## Course B — Strongback Mobility Wheelchair Product Knowledge & Customer Conversations (proposed)

**Purpose.** Help dealers present the Strongback wheelchair and rollator line HCPS represents, demonstrate it, and answer
common questions within the manufacturer's guidance. **Audience:** sales and service staff. **Runtime:** ~1 h 45 min
(7 lessons) + exam.

**Objectives (proposed).** The learner can: (1) name the Strongback models HCPS offers and what distinguishes them;
(2) explain the design benefits Strongback states (e.g. back support, weight, folding) using the manufacturer's words;
(3) ask fit-related questions without giving clinical advice; (4) run a 3-minute demonstration (fold, lift, adjust);
(5) recommend the right accessories; (6) answer the five most common dealer questions.

| # | Lesson (≈ min) | Key screens / activities |
|---|---|---|
| 1 | Welcome: who Strongback is and what HCPS represents (8) | objectives; quote (manufacturer's own statement, attributed) |
| 2 | The model line (15) | comparison across the models; explorer per model (sourced facts only) |
| 3 | Design features in Strongback's words (12) | fact screens; callout: these are manufacturer statements |
| 4 | Fit questions and when to refer (12) | steps (seat width, user weight, use); scenario: post-surgery customer → refer to clinician |
| 5 | The 3-minute demonstration (15) | steps (fold, lift, adjust); video (linked, if Strongback provides one) |
| 6 | Accessories and add-ons (10) | comparison (accessory → purpose); check |
| 7 | Common dealer questions and service (12) | scenario set; document (warranty / instructions, linked); takeaways |

**Downloadable checklists.** Demo checklist; fit-question card (non-clinical).

**Question-bank blueprint (target 45).** L2 9 · L3 7 · L4 7 · L5 7 · L6 6 · L7 9.

**Sources needed.**

| Claim area | Source | Status |
|---|---|---|
| Model list and names | Strongback Dealer Pricing 2026 Rev C (models on record: 1003AB, 1012AB, 1017, 1007AB, 1010AB, 1019, 1036DB, ErgoSteel ES0001, SEATA R0001) | On file — use for *names / codes only*; prices are never course content |
| Specs and features | Strongback product pages, spec sheets, owner's manuals | To collect and date |
| Accessories | Rev C list (A1000, A1001, A1004, A1005 4-pack, SB100) + Strongback accessory descriptions | Descriptions to collect |
| Warranty / instructions | Strongback documents | To collect (link only) |
| Photos / videos | Strongback (rights per asset) | Per-asset permission |

**Questions for the owner.** Should the rollator (SEATA) and ErgoSteel be in this course or a later one? Does Strongback
allow its product photos in an HCPS course?

---

## Course C — Bemis Raised Toilet Seat Product Knowledge & Sales Essentials (proposed)

**Purpose.** Help dealers choose the right Bemis raised seat / accessory for a customer's toilet and need, explain
installation as Bemis states it, and handle common service questions. **Audience:** retail, phone and delivery staff.
**Runtime:** ~1 h 20 min (6 lessons) + exam. **Easiest to produce first:** the Bemis line was just through Manufacturer
Center enrichment, so verified pages, photos and source decisions already exist.

**Objectives (proposed).** The learner can: (1) tell the Bemis raised-seat models apart; (2) ask the qualifying questions
(round vs elongated bowl, height needed, arms, user weight); (3) explain installation only as Bemis instructs;
(4) match accessories; (5) resolve the three most common service calls; (6) know what is NOT claimed (open items below).

| # | Lesson (≈ min) | Key screens / activities |
|---|---|---|
| 1 | Welcome and why bathroom safety sells (8) | objectives; takeaways |
| 2 | The Bemis line (15) | comparison (Assurance, Rise, Assist, Steadfast…); explorer per model (verified facts only) |
| 3 | Qualifying questions (12) | steps (bowl shape, height, arms, weight); scenario: "it doesn't fit my toilet" |
| 4 | Installation as Bemis instructs (12) | steps from Bemis instructions; callout: never improvise an installation |
| 5 | Accessories and the bidet (10) | comparison; check |
| 6 | Service scenarios (12) | scenario set (loose seat, wrong shape, returns); takeaways |

**Downloadable checklists.** Bowl-shape / height qualifying card; installation hand-off note (from Bemis instructions).

**Question-bank blueprint (target 40).** L2 9 · L3 8 · L4 8 · L5 6 · L6 9.

**Sources and known open items (from the Bemis Manufacturer Center decisions).**

| Claim area | Source | Status |
|---|---|---|
| Model list, codes, case quantities | Bemis Digital Price List 2026 (approved source) | On file — names / codes only, never prices |
| Assurance, Rise, Assist pages | Bemis product pages used in Release B (Ready pages) | Verified for enrichment; re-check dates for the course |
| Steadfast installation system name | Bemis page says "Snap 2 Secure", HCPS catalog says "Stay-Tite" | **Open — pending Bemis; keep out of lessons and exams** |
| Support arms "350 lb per arm" | No product-specific Bemis source | **Open — keep out** |
| Personal Wash Bidet | No product-specific Bemis source | **Open — keep out until a source is added** |
| Display (444DISPLAY) | No current source | Not course content |
| Installation | Bemis instruction sheets | To collect (link only) |
| Photos | Bemis photos copied to HCPS storage in Release B (rights recorded) | Reuse per recorded rights |

**Questions for the owner.** Is Course C the right first course to write (sources are most complete)? Should the
open Bemis items wait, or should the course launch without them?

---

## Recommended order

1. **Bemis (C)** — most verified material already on file; shortest.
2. **Strongback (B)** — model list on record; needs spec / feature documents.
3. **Golden Scooters (A)** — needs the owner's current model matrix first.

Next step after the owner picks one: create it as a draft in the Command Center (owner's session), load the outline
(modules + lessons), and stage AI-assisted draft screens clearly marked "draft for owner rewrite" for him to edit.
