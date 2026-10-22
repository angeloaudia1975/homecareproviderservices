# Phase 2 / F2 — manufacturer technical-certification program pages (issue #32)

Golden's two official technical certifications run as a structured path inside the HCPS Academy:

1. **Watch Golden's official training video.** It is embedded in YouTube's privacy-enhanced player (youtube-nocookie.com), with no autoplay and a "Watch on YouTube" fallback.
2. **Take Golden's official quiz.** Golden's own Google Form opens in a new tab with `rel="noopener noreferrer"`. HCPS never copies, hosts or grades it.
3. **Send HCPS the Golden certificate.** The learner uploads it (PDF or picture, at most 3 MB, stored privately, never used as lesson media), or emails it while uploads are off.
4. **HCPS verifies it.** The existing M1 `review_external_cert` turns it into a verified Golden credential (Certifications tab).

"I watched" and "I submitted the quiz" are recorded as **the learner's own reports**, never as results. Nothing is inferred from the video loading or a link being clicked. Only HCPS's check of Golden's certificate makes a credential verified.

| Program | Video | Quiz | Manufacturer page |
|---|---|---|---|
| Golden Lift Chair Technical Service Certification | https://www.youtube.com/watch?v=VApekZEFn8c | https://forms.gle/BsZRxeTDWitwRGfr5 | https://goldentech.com/lift-chair-certification/ |
| Golden Mobility Technical Service Certification | https://www.youtube.com/watch?v=eI46MshrR3c | https://forms.gle/d7CXFRjeDFNiJnBg8 | https://goldentech.com/mobility-certification/ |

All six links were checked on 21 Oct 2026:
- Both videos allow embedding (YouTube oEmbed answers 200; the titles are Golden's own).
- Both Golden pages embed the same videos and link the same forms.
- Both pages state the rules: a perfect score is required, retakes are unlimited, and Golden emails the certificate within a few weeks.

## Database step (Angelo runs it)

- `supabase/academy_p2_f2_programs.sql`, sha256 `487f26ec…4cbdfec`.
- 5 install checks.
- Rollback `academy_p2_f2_programs_rollback.sql`, sha256 `ef994972…8ec0`. It is refused once data exists.
- Postcheck `academy_p2_f2_postcheck.sql`. The code fingerprint is `26b5275fd826ce1d8100912276fe432d` with Unix line endings, or `33321f332ba6a1bcc43f3f03576ea64e` when pasted from Windows (CRLF).

What the step adds:
- the `academy_program_details` table (RLS on, no policies, server SELECT only, audited writes);
- `academy_ext_op_set_program` (administrators);
- `academy_ext_op_step` (the learner: `watched`, `quiz_submitted`; forward only; a verified credential never changes; after a rejection a new record starts);
- `academy_ext_op_certificate` (the learner; needs `phase2_flags.academy_external_uploads` = true, which stays OFF until approved).

Before it is installed, learners see the quiz link only, and the step buttons answer "not available yet".

## After install

Command Center → Courses → each Golden program → **Program page → Edit program page**. Paste the video link, quiz link, manufacturer page and the quiz note in Golden's words. YouTube watch, youtu.be and embed links are all accepted and stored as the no-cookie embed.

## Tests

- `test/academy-f2.pg.test.js` (9): install, RULE 19, editing (normalisation, bad links, roles, audit), learner listing/draft hidden, steps order + reports, uploads off/on + content type + private + not in media library + HCPS verify, rejection restart, staff preview writes nothing, rollback.
- `test/academy-program.browser.js` (learner page under the real /academy/* CSP, 390 / 1280).
- `test/academy-student-view.browser.js` (staff view of the same page, preview records nothing).
