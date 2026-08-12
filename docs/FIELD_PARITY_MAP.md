# Dealer Field Parity & Ownership Map — Zoho CRM Plus ⇄ Dealer 360

**Version:** 1.0 · Companion to `FEDERATED_ARCHITECTURE.md`
**Rule:** every dealer field that matters to sales, marketing, segmentation, or account management exists in **both** systems, with **one owner** and a **defined sync direction** — so updates never fight or duplicate.

## Ownership doctrine (dealer master)
- **HCPS Dealer 360 is the owner** of all dealer master + classification fields below. It is the single source of truth.
- **Zoho is a synced mirror** for these fields: `HCPS → Zoho`, one-way. Editing them in Zoho is not the workflow (Zoho is single-admin, headless — §6.1a).
- **Zoho owns** campaign/engagement/pipeline fields (opens, clicks, deals, scores); those flow back `Zoho → Dealer 360`. They are **not** in this import.
- **Match keys (no duplicates):** Accounts dedupe on **Account Name**; Contacts dedupe on **Email**. Both imports use *upsert* (add new + update existing) on these keys.

## Account (dealer/branch) fields

| Canonical field | Zoho — Accounts (type) | Dealer 360 (Supabase) | Owner → Sync |
|---|---|---|---|
| Company name | `Account Name` (std) | `dealers.business_name` | HCPS → Zoho |
| Dealer organization (parent group) | `Dealer Organization` (text) | `dealers.dealer_organization` / `parent_id` | HCPS → Zoho |
| Billing address | `Billing Street/City/State/Code/Country` (std) | `dealers.address/city/state/zip` | HCPS → Zoho |
| Phone | `Phone` (std) | `dealers.phone` | HCPS → Zoho |
| Website | `Website` (std) | `dealers.website` | HCPS → Zoho |
| Territory state | `Territory State` (text) | `dealers.state` | HCPS → Zoho |
| Business type | `Business Type` (picklist) | `dealers.business_type` | HCPS → Zoho |
| Business model | `Business Model` (picklist) | `dealers.business_model` | HCPS → Zoho |
| Dealer status | `Dealer Status` (picklist: Active/Prospect/Dormant) | `dealers.status` | HCPS (MRE) → Zoho |
| Golden / Lift-Chair flagship level | `Golden Flagship Level` (picklist L1–L4) | `dealers.golden_flagship_level` | HCPS → Zoho |
| Mobility flagship level | `Mobility Flagship Level` (picklist L1–L3) | `dealers.mobility_flagship_level` | HCPS → Zoho |
| Ovation access | `Ovation Access` (picklist: Active/Approved Prospect/Restricted) | `dealers.ovation_status` (+ `ovation_access` bool) | HCPS → Zoho |
| **Per manufacturer (×10)** — active flag | `{Mfr} Account` (checkbox) | `dealer_manufacturers.active` | HCPS → Zoho |
| **Per manufacturer (×10)** — account number | `{Mfr} Acct #` (text) | `dealer_manufacturers.account_ref` | HCPS → Zoho |

Manufacturers (the 10): Golden, Access4U, Pedifix, GCE, Climbing Steps, Strongback, Corsicana, BongoRx, Bemis, Ovation. Account numbers are **organization-level** (shared across a dealer's branches) with the branch-override rule — the model already built.

## Contact fields

| Canonical field | Zoho — Contacts (type) | Dealer 360 | Owner → Sync |
|---|---|---|---|
| Linked account | `Account Name` (lookup) | `dealer_contacts.dealer_id` | HCPS → Zoho |
| First / Last name | `First Name` / `Last Name` (std) | `dealer_contacts.name` | HCPS → Zoho |
| Email (match key) | `Email` (std) | `dealer_contacts.email` | HCPS → Zoho |
| Phone | `Phone` (std) | `dealer_contacts.phone` | HCPS → Zoho |
| Title | `Title` (std) | `dealer_contacts.title` | HCPS → Zoho |
| Contact role | `Contact Role` (text) | `dealer_contacts.role` | HCPS → Zoho |
| Marketing eligibility | `Email Opt Out` (std) | `dealer_contacts` / `email_optout` | HCPS → Zoho; unsubscribes Zoho → HCPS |

## Going-forward flow (after the one-time import)
`HCPS Admin Portal → Dealer 360 (owner) → Zoho (mirror)`. New dealers/edits are made in the portal; the existing Zoho sync (`zoho-api.js`, extended for these custom fields) pushes them to Zoho on the match keys above. Zoho never originates a dealer-master change; it only sends back campaign/engagement/pipeline data. This is what keeps the two systems from drifting or duplicating.
