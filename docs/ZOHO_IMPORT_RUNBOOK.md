# Zoho CRM Plus — One-Time Dealer Import Runbook

Bulk-loads the corrected 2026 dealer list **directly into Zoho** using Zoho's native Import (no custom loader). Two files: **Accounts** (376 dealers/branches) then **Contacts** (908 people). After this, all changes originate in the HCPS Admin Portal and sync forward.

Files:
- `zoho_accounts_import.csv` — 376 rows, 36 columns
- `zoho_contacts_import.csv` — 908 rows, 8 columns

---

## Step 1 — Create the custom fields (one time)
In Zoho CRM: **Setup → Customization → Modules and Fields**.

**Accounts module — add these fields:**
| Field label | Type | Values |
|---|---|---|
| Dealer Organization | Single Line | — |
| Territory State | Single Line | — |
| Business Type | Pick List | (import will collect values; allow "add unmapped") |
| Business Model | Pick List | Retail, Insurance, Pharmacy, Hospital, Home Mods, Ecommerce Dealer, All |
| Dealer Status | Pick List | Active, Prospect, Dormant |
| Golden Flagship Level | Pick List | Level 1: 1-4 Chairs, Level 2: 5-11 Chairs, Level 3: 12-23 Chairs, Level 4: 24+ Chairs |
| Mobility Flagship Level | Pick List | Level 1: 1-4 Mobility Products, Level 2: 5-8 Mobility Products, Level 3: 9+ Mobility Products |
| Ovation Access | Pick List | Active, Approved Prospect, Restricted |

**Accounts module — per manufacturer (10 lines: Golden, Access4U, Pedifix, GCE, Climbing Steps, Strongback, Corsicana, BongoRx, Bemis, Ovation):**
| Field label | Type |
|---|---|
| `{Mfr} Account` | Checkbox |
| `{Mfr} Acct #` | Single Line |

(Billing address, Phone, Website, Account Name are standard — no need to create.)

**Contacts module — add:**
| Field label | Type |
|---|---|
| Contact Role | Single Line |

(First/Last Name, Email, Phone, Title, Email Opt Out are standard.)

> Tip: on a Pick List import, enable **"Add these values to the picklist"** when prompted, so any stray value is captured rather than dropped.

---

## Step 2 — Import Accounts (do this first)
**Accounts → (⋯) → Import → Import Accounts.**
1. Upload `zoho_accounts_import.csv`.
2. **Duplicate handling:** find matching records by **Account Name** → **"Update existing and create new"** (upsert).
3. Map columns — labels match Zoho field names, so mapping is 1:1. Confirm the 20 manufacturer fields map to the checkbox/text fields from Step 1.
4. Run. Expect **376 accounts** created/updated. Review the import summary for skipped rows.

## Step 3 — Import Contacts (after Accounts exist)
**Contacts → (⋯) → Import → Import Contacts.**
1. Upload `zoho_contacts_import.csv`.
2. **Link to account:** map `Account Name` → the Account lookup so each contact attaches to its dealer (Zoho matches on the Account Name loaded in Step 2).
3. **Duplicate handling:** match by **Email** → **"Update existing and create new"** (upsert).
4. Run. Expect **~908 contacts**. Contacts with a blank email will import unlinked to marketing — that's expected.

---

## Step 4 — Verify
- Accounts count ≈ 376; spot-check a family (e.g., filter `Dealer Organization = Adapthealth` → 7 branches) and a flagship (`Golden Flagship Level` is set).
- Confirm **Ovation Access = Restricted** on the ~296 suppressed accounts — these must never enter an Ovation campaign (build that suppression segment before any Ovation send).
- Contacts attached to the right accounts.

## Step 5 — Freeze the manual path
This import is **one-time**. From here, dealers are added/edited only in the **HCPS Admin Portal → Dealer 360**, and the ongoing `HCPS → Zoho` sync (existing `zoho-api.js`, extended for the custom fields above, upserting on Account Name / Email) keeps Zoho current. Do not hand-edit dealer master fields in Zoho.

---

### Optional: I can drive Step 2–3 with you
If you'd rather, open the Zoho import screen and I can walk the mapping click-by-click in your browser. Creating the custom fields in Step 1 is an admin settings change — you make those (or approve each), then I can assist with the mapping and verification.
