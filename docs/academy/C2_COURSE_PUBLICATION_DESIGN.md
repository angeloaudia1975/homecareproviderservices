# A2C Part C2 — Course publication rules (DESIGN ONLY)

Status: **design for Angelo's review. Nothing here is implemented, and nothing may be built until C2 is separately approved.**
The rules come from Angelo's approval of 11 Oct 2026 (§4). This document records them, says what exists today, and lists
what C2 will need. All seven Academy switches stay OFF.

## The rules (Angelo, 11 Oct 2026)
1. Show clearly whether training is published and available.
2. Only the President can publish or retire a course.
3. Published versions are immutable.
4. Publishing a replacement version retires the previous one and publishes the new one atomically.
5. Manufacturer-hosted training gets its own controlled publication.
6. Published history and certification records are preserved.
7. TEST isolation is kept. TEST courses never issue real certificates, and every future dashboard and report keeps the distinction.

## Where each rule stands today

| Rule | Today (A1 + M1, plus C1 code and M2 when installed) | Gap C2 must close |
|---|---|---|
| 1. Visible status | The Command Center shows **Training available** from the versions: Published training (vN), In review, Draft only, Retired, No versions, Manufacturer-hosted. Version counts are shown too. The course record itself shows a grey `record: draft` pill. | `academy_courses.status` is never maintained, and a manufacturer program has no "available" state at all. |
| 2. President only | The Command Center allows only the President to publish or retire a version. M1 `academy_op_publish_version` / `retire_version` accept **any active administrator**. | The President check must be enforced **in the database**, not only in the server code. |
| 3. Immutable | A1 triggers freeze a published or retired version and its modules, lessons and questions. The M1 guard refuses status changes to published or retired. M2 refuses every content change except through its draft-only operations. | None for versions. Course records with published training need a rule for which fields may still change (today: the President may change the title and category). |
| 4. Atomic replacement | A unique index allows one published version per course. M1 `publish_version` therefore **refuses** while another version is published, so a replacement needs two separate steps (retire, then publish), which leaves a gap with nothing published. | A single "publish replacement" operation: in one transaction, retire vN and publish vN+1, with two audit rows (or one row naming both). |
| 5. Manufacturer-hosted | A manufacturer program has no versions (M2 refuses them). Its availability can only be the course record, which nothing sets. | President-only, audited `publish_course` / `retire_course` for manufacturer programs. Publishing checks the https link and the manufacturer. |
| 6. History kept | A1: published and retired versions are never deleted; certificates keep their version; the audit history is append-only. | Retiring a course must never delete or hide history. Certificates issued on a retired version stay as issued (see decision C below). |
| 7. TEST isolation | M1 refuses a certificate on a `test-…` course. The C1 Overview leaves TEST data out of the real figures. | Every C2 status view and count must apply the same rule. |

## Proposed design (for approval)
All of the following would be **one new migration ("M3")**, built and tested like M1 and M2 (preflight, exact SQL, sha256, rollback, acceptance tests, public-key probe, local hardening). Angelo would run it himself.

**1. Course status is maintained only by audited operations, in the same transaction:**
- `published` while the course has a published version (HCPS courses), or after `publish_course` (manufacturer programs);
- `retired` only through an explicit President decision;
- `draft` otherwise.

Nothing else writes it: the M2 content guard already refuses plain writes to `academy_courses`. The records check gains a consistency test (course status against its versions).

**2. Database-level President check.** A helper (like M2's `academy_content_actor_president`) used by every publication operation. Two options:
- **(a) Recommended:** new `academy_publish_op_*` functions call the helper. M1's publish and retire functions are no longer called by the server, and their execute right is withdrawn. M1 code is left unchanged, so its fingerprint stays the same.
- **(b)** Amend M1 (an M1 rev 3). The M1 fingerprint would change and must be re-approved.

**3. `academy_publish_op_publish_version(p_actor, p_version_id)`** does the whole publication in one transaction:
- the same checks as M1 today (questions, approved facts, and so on);
- the President check;
- if another version is published, it retires that version first;
- publishes the new version;
- sets the course to `published`;
- writes audit rows for every change.

Whether publishing requires the version to be **in review first** (a two-step check) is decision A.

**4. `academy_publish_op_retire_course(p_actor, p_course_id, p_reason)`** (President only):
- retires the published version, if there is one;
- sets the course to `retired`;
- writes audit rows with the reason.

**5. `academy_publish_op_publish_course` / `retire_course` for manufacturer programs** (President only):
- checks the manufacturer is on the HCPS list and the https link is valid;
- `publish_course` sets the course to `published`; `retire_course` sets it to `retired`;
- writes the audit row.

The learner catalog (A2D/A2E, later) lists only published courses.

**6. History and certificates:**
- nothing is deleted;
- a retired version keeps its modules, lessons, questions, enrollments, attempts and certificates;
- the Command Center shows retired versions and courses in a history view;
- certificates are never changed by publishing or retiring.

**7. TEST:**
- a `test-…` course may be published for the pilot, but never issues a certificate (M1, unchanged);
- every status count shows TEST separately.

## Decisions needed from Angelo before C2 is built
- **A.** Must a version be submitted for review before the President can publish it? Recommended: yes, so publishing is always a second look.
- **B.** When a replacement is published, what happens to learners part-way through the old version? Options:
  - they keep access to finish it (recommended), or
  - they are moved to the new version, losing progress.
- **C.** Does a certificate issued on a version stay valid until its expiry after that version is retired? Recommended: yes. Retiring is not revoking, and revocation stays its own audited decision.
- **D.** Which course fields may change once training is published? Recommended:
  - title and category, by the President only (as today);
  - the slug, type, issuer and manufacturer, never.
- **E.** Option (a) or (b) for the database-level President check. Recommended: (a).

## Dependencies and order
1. M2 installed in production and verified. The content guard is what keeps course status out of plain writes.
2. Angelo's decisions A–E.
3. M3 SQL, rollback, acceptance tests and local tests, presented as a draft PR. Angelo reviews it and runs it himself.
4. Command Center code switches publish and retire to the new operations, and adds course publication and a history view (C2 code PR).
5. The learner catalog reads course status only after A2D/A2E are approved and the `academy_learner` switch is turned on by Angelo.

C2 also carries the items deferred from C1:
- module reorder;
- exam question authoring (questions are not yet covered by the M2 guard; C2 adds them to it);
- lesson blocks.
