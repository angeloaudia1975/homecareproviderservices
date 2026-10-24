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

## Two receipt bases — never mixed

| Basis | What proves it | When the date is assigned |
|---|---|---|
| `mailbox_attachment_match` | The email's attachment SHA-256, read with the read-only `email-sync-api report_inventory` action, **equals** the imported file's SHA-256 | Only on an exact hash match. Otherwise the date is **not assigned** and the line blocks with `received_date_mismatch`. |
| `hcps_intake_verified` | A separate HCPS intake record for THIS file: who verified it (`verified_by`) and how (`note`, for example "handed over at the 21 Oct meeting") | When the record is complete. If an attachment hash is also given, it must match too. |

A bare date with no basis (the old `--received YYYY-MM-DD`) is kept for the record, but the line cannot be staged
(`received_unverified`). The received date is **never** the manufacturer's effective date: effective dates come
only from the source itself (Dalton: 2026-11-01).

## Evidence record
This is passed as `--received-evidence e.json`, or as a batch `received` object / `received_evidence` file:

```json
{ "date": "2026-10-09", "basis": "mailbox_attachment_match",
  "attachment_name": "Pricelist fall 2026.pdf", "attachment_sha256": "<64 hex>",
  "message_id": "<internetMessageId>", "verified_by": null, "note": null }
```

It travels with every import row in `raw._provenance`:

* `received_basis`
* `received_evidence`: attachment name and hash, message id, who and how

Email content is never stored there. The rows reach Manufacturer Center only through its two existing gates.

## Where each line stands (from the 23 Oct mailbox match)

| Line | Status |
|---|---|
| Access4U | Matched by SHA-256 → `mailbox_attachment_match`, received 2026-10-09 |
| Dalton (corrected Nov 2026 list, REVa) | The 20 Oct email attachment is a **different** file. Needs the email that carried REVa, or an HCPS intake record. Effective date stays 2026-11-01 |
| AIRAVANT / BongoRx, Corsicana (`_rev`), ABM, PediFix | No hash match yet. Each needs its matching attachment or an intake record |
| Ohio Medical / GCE | No price-list email found. A contract email is not evidence |

These are open blockers, not failures. PediFix's 2025 document is still not a current 2026 list, and ABM stays
blocked for general dealer pricing whatever its receipt date.

## Code
* `netlify/functions/_catalog_import.js`: `applyReceipt`, `RECEIPT_BASES`, the `received_date_mismatch` and
  `received_unverified` blockers, and `provenanceOf`
* `scripts/catalog-import.js`: `--received-evidence`
* Tests:
  * `test/catalog-import.test.js` (53)
  * `test/catalog-import.handoff.test.js` (7)
  * `test/catalog-import.mutants.js` (73/73)
