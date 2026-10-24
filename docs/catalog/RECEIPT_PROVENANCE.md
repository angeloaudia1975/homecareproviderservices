# Price-source receipt provenance (proposal)

**Status:** proposed on branch `catalog/receipt-provenance` (follow-up to the PR #35 review). The code is read-only
importer tooling. Nothing here imports, stages or publishes a price, and no manufacturer effective date changes.

## The problem
HCPS's *received date* for a price list is the date Manufacturer Center registers a source under. It must never be
guessed. Two things kept getting mixed up:

* the date a manufacturer **emailed** a file, and
* the date HCPS **took in** a particular file by some other route (handed over, downloaded, re-saved, corrected).

A corrected or re-saved PDF is a different file. The date of the email that carried the *original* attachment must
never be given to it.

## Three receipt bases — never mixed (tightened on the PR #39 review)

Every basis names the file's SHA-256, and it must equal the imported file's. If it doesn't, the date is **not
assigned** and the line blocks with `received_date_mismatch`.

| Basis | Verified? | Evidence required |
|---|---|---|
| `mailbox_attachment_match` | yes | the email's `message_id` (internetMessageId `<…@…>`), the `mailbox` address, `attachment_name` (and `attachment_id` when known), `attachment_sha256`, Outlook's `received_at` timestamp with a time zone (its Chicago date must equal `date`), `evidence_ref` (the read-only capture that read it, e.g. the `report_inventory` run) and `captured_by` |
| `hcps_intake_verified` | yes | `intake_ref` (the HCPS intake record, e.g. an `mfr_sources` or capture item id), `intake_at` timestamp with a time zone (Chicago date = `date`), `file_sha256`, `verified_by` |
| `hcps_intake_attested` | **no** | `file_sha256`, `attested_by`, `note`. It is kept as a person's own statement and labelled "attested". The line stays blocked (`received_attested`) until a recorded decision (who + why) accepts it. |

Other rules:

* **Missing or malformed evidence is refused outright.** That covers a blank field, a message id that isn't an
  internetMessageId, a mailbox that isn't an address, a hash that isn't 64 hex characters, and a timestamp without a time
  zone or on another day.
* **Dates must be real and not in the future.** `date` must be a real calendar date (no 2026-02-30) and not after today.
  The CLI's `--today` sets "today", so runs are deterministic.
* **A bare date has no basis.** The old `--received YYYY-MM-DD` is kept for the record but blocks (`received_unverified`).
* **Received is not effective.** The received date is never the manufacturer's effective date (Dalton stays 2026-11-01).
* **No message content.** Only references and hashes are kept, never a subject, body or other message content.

## Where each line stands (from the 23 Oct mailbox match)

| Line | Status |
|---|---|
| Access4U | Hash-matched to "Pricelist fall 2026.pdf" (received 2026-10-09). Still needs its evidence record (message id, mailbox, Outlook timestamp, capture reference) before it counts as verified |
| Dalton (corrected Nov 2026 list, REVa) | The 20 Oct email attachment is a **different** file. Needs the email that carried REVa, or an HCPS intake record. Effective date stays 2026-11-01 |
| AIRAVANT / BongoRx, Corsicana (`_rev`), ABM, PediFix | No hash match yet. Each needs its matching attachment or an intake record |
| Ohio Medical / GCE | No price-list email found. A contract email is not evidence |

These are open blockers, not failures. PediFix's 2025 document is still not a current 2026 list, and ABM stays
blocked for general dealer pricing whatever its receipt date.

## Code
* `netlify/functions/_catalog_import.js`: `applyReceipt`, `RECEIPT_BASES` / `VERIFIED_BASES`, the `received_date_mismatch`,
  `received_unverified` and `received_attested` blockers, and `provenanceOf`
* `scripts/catalog-import.js`: `--received-evidence`
* Tests:
  * `test/catalog-import.test.js` (54)
  * `test/catalog-import.handoff.test.js` (7)
  * `test/catalog-import.mutants.js` (81/81)
