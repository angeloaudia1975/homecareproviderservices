# HCPS Platform — Build Standards & Procedure (single source of truth)

**Read this file first, every session, before changing any page.** These are the
agreed rules for homecareproviderservices.org. If a change would violate one, stop
and either follow the rule or get the rule changed here first.

## RULE 0 — every rule gets recorded here, always (non-negotiable)
**Whenever the user and I agree on any standard, procedure, or preference, it MUST be
written into this file in the same session, before the work is called done.** A rule
that lives only in conversation does not exist and will be forgotten. No exceptions.
This is itself a permanent rule.

**It is MY responsibility, not the user's.** The user should never have to remind me a
rule exists or ask me to write it down. Whenever the user states a standard, preference,
correction, or "do it this way from now on" — I notate it here immediately and proactively,
and confirm in one line that it's recorded. Forgetting a recorded rule, or failing to
record a stated one, is a defect.

## RULE 0.1 — verify the REPO before writing any file (non-negotiable)

There are **two separate repos** with overlapping filenames, deployed to two different
Netlify sites. Editing the wrong repo's copy silently does nothing — the change never
reaches the deployed tool. Before creating or committing ANY file, confirm which repo it
belongs in and that it is the copy the live site actually serves.

- **`homecareproviderservices` (this repo) → `homecareproviderservices.netlify.app`** — the
  Connect 360 admin, the public marketing site, and MOST Netlify functions. Admin pages live
  in `src/admin/`, functions in `netlify/functions/`. **The Product Content / Catalog tool and
  its `product-content` function live HERE.**
- **`homecareproviderservicesordering` → the dealer ordering portal (separate site)** — the
  dealer-facing ordering front end. Admin pages in `public/admin/`, functions in
  `netlify/functions/`. **The `product_content*` SQL schema files live in its `supabase/`.**

Procedure, every time, before writing:
1. Find the URL/tile the user actually uses (e.g. `admin-chrome.js` HUBS `href`, or the link the
   user gives). The domain tells you the repo: `homecareproviderservices.netlify.app` → main repo.
2. Confirm the target file is that repo's copy — not a same-named file in the other repo. When a
   filename exists in both repos, the deployed one wins; the other is a stale/parallel copy.
3. Only then edit + commit. If a feature spans both (schema in ordering/supabase, tool in main),
   put each piece in its correct repo and say so.

Two files were once shipped to the wrong repo (the catalog workspace + its function landed in
`homecareproviderservicesordering` when the live tool is in `homecareproviderservices`). Never again.

## How rules get set (the procedure)
1. When we agree on a standard, it is **added to this file in the same session** — not
   left in conversation. A rule that isn't written here does not exist.
2. Every rule change is committed to the repo (this file is version-controlled).
3. Before building/editing a page, re-read the relevant sections below.
4. When finishing a page, self-check it against the "Per-page checklist" at the bottom.

### How the user sets a rule (say any of these, and I record it here immediately)
- "Rule: <the rule>"  ·  "Make this a standard: <rule>"  ·  "Add to standards: <rule>"
- I will (a) write it into this file, (b) commit it, and (c) apply it to existing pages
  if it's retroactive. To see every current rule: "send me all the standards."

---

## 1. Hero cards (the "depth hero") — REQUIRED on every main page
- A banner image in an interactive **3D mouse-tilt** frame (rotateX/Y + translateZ)
  with a moving glare, then a **short headline**, a support line, and CTA buttons
  centered beneath it.
- Desktop-only tilt (mousemove); respects `prefers-reduced-motion`.
- **The tilt banner element must NEVER be a scroll-reveal target.** Do NOT put
  `data-reveal` on the tilt image. The reveal engine pins `transform:none !important`
  once revealed, which overrides and kills the tilt. (This broke Dealer Services +
  Consulting on 2026-08; fixed by removing `data-reveal` from those tilt images.)
  The copy/cards *around* the hero may reveal; the tilt image may not.
- **Headline:** short headlines are single row on desktop (`white-space:nowrap`, wrap on
  mobile) — e.g. "Everything you need, all in one place." Longer descriptive headlines may
  wrap to **at most two balanced lines** (`text-wrap:balance`), never three. Prefer short.
- Banner images: optimize to progressive JPEG ~1600px wide, quality ~82 (~200–300KB).
  Store at `src/assets/<page>/hero-banner.jpg`. Set CSS `aspect-ratio` to the image's ratio.

## 2. Icons on cards — big-icon-on-top
- Service/category/resource cards show a **large icon across most of the card width**
  (~72–82%, ~170–200px), centered on top of the card — never a small glyph.
- Icons are their own image files under `src/assets/<page>/…`, resized ~360–520px.
- Cards are centered (text-align:center) with the big icon leading.

## 3. Scroll effects — shared engine (site-wide, do not duplicate per page)
- CSS lives in `src/assets/css/site.css` under "HCPS shared FX layer".
- JS lives in `src/assets/js/hcps-fx.js`, loaded once by `src/_includes/layouts/base.njk`.
- Reveal any element by adding `data-reveal="up|down|left|right|fade"`; standard blocks
  (`.section-head`, cards, etc.) reveal automatically. Runs once; reduced-motion safe;
  FOUC-free via the `.has-js` flag set in base.njk `<head>`.
- Never paste per-page reveal CSS/JS again — use the shared engine so rebuilds keep it.

## 4. Card depth & hover (shared)
- Manufacturer / team / testimonial cards get gradient + soft shadow + hover lift
  (in the shared FX layer). Testimonials: hover enlarges + brings forward + dims siblings.

## 5. Brand & content
- Colors: navy `#0b1f33`, blue `#1681c2`, blue-dark `#0f5c8f`, orange `#ef6325`,
  gold `#fcb21e`, ink `#0b0d0f`.
- Contact info comes from `src/_data/site.json`: phone **937-626-5141**,
  email **info@homecareproviderservices.us**. Do not hardcode other numbers/emails.
- Partner/manufacturer lists are **data-driven** from `activeManufacturers`
  (manufacturers.json filtered by `hidden !== true`). Never hardcode a partner list.
- Resource files: `src/_data/documents.json` is **admin-managed — do not hand-edit**.
  Manufacturer identity/category resolves via the `manuById` / `resourceCat` filters.

## 6. Commission importer (Ohio Medical / GCE and others)
- Canonical manufacturer slug is `ohio-medical` (legacy `gce` merged via
  `supabase/ohio_medical_slug.sql`, which must be run once in Supabase).
- **ZIP is the master key** for branch routing: an explicit ZIP→branch assignment in
  Review wins over name/address spelling, scoped to the corporate that set it.
- Ship-to locations are first-class: branches listed individually; person-name
  patients roll up as drop-ship on the corporate.

## 7. Workflow
- Work happens in the cloud session; deliver by committing to the device repo via the
  device bridge. `documents.json` excepted (admin-managed).
- After changes, run **`npm run build`** before deploying. (A local full build currently
  trips on an unrelated missing include `blocks/hero.njk`; verify pages by rendering
  in isolation if needed.)
- Scheduled tasks use the `create_trigger` MCP, never the local Cron tools.

---

## 8. Content architecture — page purpose & service ownership (single source of truth)
Every page has ONE distinct purpose. Do not repeat a full service description across pages —
own it on one page and **cross-link** from the others. Approved map:

- **Home** — brand + overview; routes visitors to the right page. No full service copy.
- **Manufacturers** — the represented lines (data-driven from `activeManufacturers`). Owns product/brand info.
- **Dealer Hub** — the logged-work hub for existing dealers: resources, pricing access,
  ordering, **bookable services** (in-service, technical support, showroom consult) via the
  `?service=<key>#schedule` scheduler. Owns "get help / book a service."
- **Dealer Services** — HCPS **done-for-you** products: Digital Marketing, Website & Online
  Presence (and partner services). Execution HCPS performs *for* the dealer.
- **Consulting** — **advisory & strategy** (showroom strategy, product mix, pricing, sales
  process). Guidance, not execution. Owns "HCPS Business Consulting."
- **Become a Dealer** — top-of-funnel signup/onboarding. Links to the above; no duplicate service copy.
- **Contact** — all **form requests** (pricing, ordering, literature, general) via
  `/contact/?reason=<preselect>`.

### Dealer Services ↔ Consulting boundary (RULE)
Dealer Services = **done-for-you** (HCPS executes). Consulting = **advisory/strategy** (HCPS
advises). "HCPS Business Consulting" lives ONLY on `/consulting/`. Each page carries a one-line
clarifier + a cross-link to the other. Do not re-add a Business Consulting service card to Dealer Services.

### Dealer Resource Library — data schema (RULE)
`/resources/` is driven by `src/_data/documents.json` (admin-managed; `documents.js` stays
neutralized — never re-seed). Standardized schema, all resolved centrally:
- Top level: `types` (id, label, color, need), `categories` (11 product categories), `needs`
  (7 need groups → types), `formats`, `accessLevels`.
- Each item: `manufacturer`, `category` (per-document product category — NOT derived from the
  manufacturer anymore), standardized `type`, `models[]`, `year`, `keywords`, `popular`,
  `featured`, `sortPriority`, plus title/description/file/url/format/access.
- The admin tool must preserve these fields. Category is per-document; do not reintroduce the
  manufacturer→category derivation (`resourceCat`) for new work.
- Page architecture: hero universal search → "What do you need?" need-cards → Most-Used →
  Browse-by-Manufacturer grid → 3-filter Resource Finder (manufacturer/category/type + search)
  with removable chips → compact color-coded result cards → "Can't find it" CTA.
- Per-manufacturer Resource Center pages (`/resources/<manufacturer>/`) are the planned next
  step; manufacturer cards currently pre-filter the finder.
- Hidden filter results MUST use `.rl-result[hidden]{display:none!important}` (author `display`
  overrides the UA `[hidden]` rule otherwise).

### Audience-specific framing is NOT duplication (RULE)
On **Become a Manufacturing Partner**, "Product Launch / Staff Training / Marketing" describe what
HCPS does *for a manufacturer to reach the dealer base* — a distinct service from Consulting's
*dealer-facing* advisory. Keep that copy where it is; do NOT cross-link it to Consulting or treat it
as a duplicate of the dealer-side services. Only collapse copy that is the same service for the same
audience.

### Related-pages row — site-wide component (RULE)
Every main page ends with a "related pages" cross-link row so navigation replaces repeated copy.
- Component: `src/_includes/related.njk`; styling `.hcps-related*` in `site.css`.
- Usage: before the page's trailing `<script>`/scope close, set `relatedPages`
  (list of `{href,label,blurb}`, 3 items) and optional `relatedHeading`, then
  `{% include "related.njk" %}`. Links follow the ownership map's adjacencies.
- The row uses the shared `data-reveal` FX and global `.container` (page-agnostic).

### Hero standard — one message, one primary CTA (RULE)
Each page hero has a single distinct message, its own hero image, and exactly one primary
CTA aligned to that page's job (secondary actions use the ghost/outline style). Don't add a
second primary button to a hero.

### Dealer Support page — RETIRED (RULE)
`/dealer-support/` is retired. Its form was a duplicate of Contact's (same Netlify function);
its bookable functions live in Dealer Hub. Do not recreate it.
- `dealer-support.njk` is a `permalink:false` stub (not emitted).
- `/dealer-support/*` and `/dealer-support/` → `/dealer-hub/` (301) via `redirects.json`.
- Request/form links point to `/contact/?reason=…`; bookable services to
  `/dealer-hub/?service=<key>#schedule`. No internal link should target `/dealer-support/`.

---

## 9. HCPS Connect 360 — admin feature placement (RULE)
Connect 360 is the complete administrative command center. **No admin tool may exist as a
direct-URL-only page.** Any new admin tool, reporting module, importer, workflow, or platform
enhancement must be placed into the operating system so administrators can see and reach it.

**Placement workflow — run it for every new feature, no exceptions:**
> New feature created → assign a Connect 360 category (hub) → add it to the category page →
> add dashboard access when it's an active admin tool → verify permissions & navigation.

### Single source of truth (this is what makes the rule enforceable)
The four hubs and every tool live **once**, in `src/admin/admin-chrome.js` as the `HUBS` array.
That one array drives all three surfaces:
1. the masthead **sub-nav** (admin-chrome.js render),
2. the **category landing pages** (`src/admin/hub.html`), and
3. the **dashboard grid** (`src/admin/index.html`, which renders from `ACAdmin.HUBS`).

**Add a tool to `HUBS` and it appears on all three automatically. Never hand-code a tile into
the dashboard grid again** — that is exactly what let Product Content Enrichment & Review go
missing (2026-08; fixed by making index.html data-driven).

- Each tool object: `{ href, label, icon, desc, status? }`. `status`: omit/`"live"` | `"new"` | `"planned"`.
- `status:"planned"` **or** an empty `href` → shown on the dashboard as a roadmap tile, but hidden
  from the sub-nav and category pages (no dead links). When the page ships, give it a real `href`
  and drop the planned status.
- Rich guide-card copy for a tool goes in `src/admin/hub-guide.js`, keyed by the **exact `label`**.
- Prefer hosting admin tools on **this (main-site) deploy** so they share the Connect 360 staff
  sign-in. Auth pattern: load `/admin/staff-session.js` on the page and send the staff JWT as
  `Authorization: Bearer <HCPS.token()>`; the function verifies it with a `whoami()` that checks
  Supabase Auth → `staff_users` role (copy the pattern from `product-content.js` / `featured-api.js`).
  **Do NOT add a separate per-tool token prompt** — that's what forced re-entry on the enrichment
  tool (2026-08); it was moved from the ordering deploy onto this one so the staff login just works.
  A tool that genuinely must live on the ordering deploy is linked by absolute URL, but then it
  can't use the staff session (cross-origin) — avoid that for admin tools.
- Audience: reps see a curated subset via `REP_TOOLS`; admin-only gating is `ADMIN_ROLES`.
  Verify a new tool's intended audience before shipping.

---

## 10. Mobile-first — every surface works on phone, tablet, AND desktop (RULE)

**Nothing is "done" until it works and has been tested on desktop, tablet, iPhone (Safari), and
Android (Chrome).** This applies to *every* surface: HCPS website pages, Partner 360 tools,
Connect 360 admin features, and manufacturer pages. Fitting on a small screen is not enough —
all functionality must actually work by touch.

Required on every surface:
- **Responsive layout** that reflows for phone/tablet (no fixed-width blocks that overflow).
- **Navigation** works by touch — the site nav uses the hamburger panel + tap-to-expand
  accordions in `layouts/base.njk` (desktop hover menus are untouched; the mobile system is
  gated to `@media (max-width:980px)`). Never ship a nav that is `display:none` on mobile with
  no replacement.
- **Touch targets ≥ 44px**; buttons and links are comfortably tappable.
- **Product / manufacturer cards stack cleanly** (grids collapse to 2-up then 1-up).
- **Images** use `max-width:100%; height:auto` and never get cut off; hero pop-out / lightbox
  works on touch.
- **Forms**: inputs are `font-size:16px` on mobile (prevents iOS focus-zoom — enforced site-wide
  in the "MOBILE HARDENING" block of `site.css` with `!important` so page-level styles can't
  re-break it), full-width, easy to complete.
- **Tables / reports** stay usable — either stack (label-per-row) or scroll horizontally inside
  a `.table-scroll` / `.m-table-wrap` container. `base.njk` auto-wraps any bare `<table>`.
- **Ordering, checkout, dashboards, calculators, configurators** are operable by touch, not just
  visible.
- **No horizontal page scroll**: `body{overflow-x:hidden}` is the mobile safety net, but the real
  fix is finding the offending element (run the QA script below) and letting it shrink
  (`min-width:0`) or wrap.
- **Animations** respect `prefers-reduced-motion` and never tank performance on a phone.

**Where the mobile system lives (single source of truth):** the hamburger/panel markup + script
is in `src/_includes/layouts/base.njk`; all mobile CSS is in `src/assets/css/site.css` under the
`Mobile navigation` and `MOBILE HARDENING` banners. Reuse these — do not re-implement per page.

**How to test (required before "done"):** run the reusable QA matrix —
`node test/mobile-qa.js` (see `docs/MOBILE_QA_MATRIX.md`). It builds the site and checks, for
every key page at desktop / tablet / iPhone / Android widths: zero horizontal overflow, hamburger
shown on mobile / hidden on desktop, the panel opens, and dropdown accordions expand. Green =
shippable; any red must be fixed first.

**Connect 360 masthead on phones (agreed 2026-10-11).** Below 760px the shared admin masthead scrolls away with the page
(not sticky), account controls (My Sales Workspace, favourites, Lock / Exit view-as) wrap onto their own row and stay on
screen, each navigation row is ONE sideways-scrolling row with the current page's link scrolled into view, and every
control is ≥44px tall. It lives in ONE place — `admin-chrome.js ensureMobileStyles()` / `revealCurrent()` (the dashboard's
own header mirrors it in `index.html`); desktop and tablet (≥761px) are pixel-identical to before. Test every admin page
with `node test/admin-header.mobile.js` (47 pages × president / My Sales Workspace / view-as / rep / relations × 360 /
390 / 768 / 1280; needs Playwright: `PLAYWRIGHT_MODULE=…`). Green = shippable.

## 11. Variant-aware products — one model = one record, routed by catalog group (RULE)

A single catalog "product" often bundles several **models** that each have their own manufacturer
page, image gallery, and specs (e.g. Ovation Gen 2® Walking Boot = 20 SKUs across Tall/Short ×
Pneumatic/Non-Pneumatic = 4 models). **Never let one image gallery serve multiple models, and never
let a SKU inherit another model's images.**

The model:
- **Parent → Model Variant → SKUs → manufacturer page → images/content.** Each model is its own
  `product_content` row (its own `page_key`, e.g. `gen2-walking-boot-tall-air`), carrying
  `parent_key` (the family), `variant_label`, `variant_group`, `variant_order`. The family header is
  the parent row (`is_parent = true`).
- **SKUs route to their model by the catalog `group` string, not by image basename.** The portal
  builds `variantByGroup` from approved `variant_group`s and resolves each SKU's `group` → the model's
  `page_key`; it falls back to the parent/base key when a model isn't approved yet (so nothing breaks
  mid-review). See `mergeCatalogEdits` in the ordering portal `public/index.html`.
- **Self-contained variants:** shared content (general story, features, clinical uses, warranty,
  overview video) is **copied into each model**; variant-specific content (images, height,
  pneumatic/non-pneumatic feature, dimensions, sizing, model IFU, billing codes) is unique per model.
- **Review/approve each model independently** in the enrichment tool. Variants live in the tool's
  `DATA.pages` manifest with their `variant_*` keys; the parent is flagged and lists its `variants`.
  The review screen renders the family as one grouped block (`renderGrouped`/`familyBlock` in
  `admin/product-content-review.html`): each model card shows its own manufacturer `website_url`,
  its own image gallery, a per-model Approve button, and every field is tagged **Shared** (applies
  to all models) or **Model-specific** (this model only).
- **Schema:** `supabase/product_content_variants.sql` adds the columns + indexes. Seed a family with a
  per-model seed (see `ovation_gen2_variants_seed.sql`), status `pending_review`.

Apply this to every multi-model / multi-configuration / multi-gallery product (Compact Pro ROM
Standard/Cool wrap, back braces by panel, etc.), not just the Gen 2 boot.

## 12. AI dealer communications — one central Style Guide (RULE)

Every AI email generator and automated-campaign generator writes from ONE shared style guide,
`netlify/functions/_ai_style.js` (the "HCPS AI Communication Style Guide"). Maintain the rules there
only — never copy tone rules into individual prompts.

- Any generator that builds an AI prompt for dealer-facing copy (`ai-email-api.js`, `campaign-api.js`,
  and any new one) MUST `require("./_ai_style.js")`, inject `loadStyleGuide(sbGet)` into the prompt,
  and run `findBanned()` on the result (regenerate once if it flags a phrase).
- The guide can be overridden live via `app_settings.ai_style_guide` (`{text:...}`) with no redeploy;
  `loadStyleGuide()` falls back to the code default. Seed/edit with `supabase/ai_style_guide_seed.sql`.
- Voice: a knowledgeable rep bringing a real, specific opportunity — confident, helpful, relevant,
  value-driven. Never desperate, apologetic, repetitive, or generically sales-y.
- Every message leads with a real reason grounded in Dealer 360 (purchase history, lines bought,
  products, inactivity, regional trends, new products/promotions, crossover) — never "just checking
  in" / "still interested?". Follow the Don't-Say → Say-Instead pairs in the module.
- Hardcoded (non-AI) templates (e.g. `_engine.js`) follow the same voice — no "we've missed you".

## 13. Importers keep manufacturer account numbers current (RULE)

When a commission or sales report carries a reliable dealer account number, the importer uses that
source data to maintain the platform's manufacturer account numbers — in BOTH the sales-report importer
(`sales-import-api.js`) and the commission importer (`commissions-api.js`), via the shared
`_accountorg.reconcileAccountRef`.

- Per matched dealer: **set** the number when blank (and fill it across the family), **confirm** + mark
  the manufacturer relationship **active** when it matches, and **flag** (never silently overwrite) when
  it differs — or when one report lists more than one number for the same dealer. Conflicts surface in
  the preview/import result for review.
- Reused-number manufacturers (a shared number that belongs to more than one dealer, e.g. PediFix) are
  matched **by name first** — list them in `_mfr_rules.js` `NAME_FIRST`. A slug whose report "number"
  is not a real account number (an order #) goes in `NO_ACCOUNT_CAPTURE`.
- The preview is a **dry run** (`reconcileAccountRef({apply:false})`) — nothing is written until commit.
- The captured number must reach every place account numbers live (Dealer 360, Partner 360, reporting,
  CRM sync) — it is stored once on `dealer_manufacturers`, which those surfaces already read.

## 14. A report with commission data counts as a commission report (RULE)

Some manufacturer reports are BOTH a sales report and a commission statement (e.g. PediFix, Ovation).
Whichever importer loads them, they must count as commission reports.

- Both importers write to `monthly_sales` and both store a per-line `commission`. Each row is tagged
  by lane: the commission importer stamps `source='commission'`, the sales-report importer
  `source='sales_report'`. Keep both tags set.
- **Coverage & commission reporting key off commission DATA, not the importer** — but a row is not data
  just because it exists (amended 2026-10-10, see the next bullet). Never gate commission coverage/reporting
  on `source` alone.
- **A blank row is not a received report (RULE, Angelo 2026-10-10).** A commission report counts as received
  / entered for a manufacturer-month ONLY when that month holds validated statement data: a commission-lane
  row (`source='commission'`, or legacy no-source/no-external_ref) that is not an open INVOICE line and
  carries an explicit commission figure. An explicit 0 is a documented zero-dollar statement and counts;
  NULL never does and is never shown or summed as $0. A month whose only commission-lane rows have no
  commission figure shows **Not received / Not entered** (with the reason), never Received or $0.
  Sales-report rows carry a commission COMPUTED at the rate typed in (amount × rate): that is an **estimate**,
  shown separately ("Sales report only — estimated"), never as a received statement — unless the
  manufacturer's sales report is its own commission statement (`commission_config.statement_sales_reports`,
  default PediFix + Ovation per RULE 14, pending Angelo's confirmation). An order-line export (e.g. the
  Strongback September CSV, $2,159 wholesale) is NOT proof a commission statement was received or paid; a 9%
  commission from it is an estimate only, and it belongs in the Sales Report Import, never the Commission
  Report Import. One definition: `_commission_coverage.js` (coverage + import validation).
- **Commission imports refuse incomplete statements before writing anything.** Sales amount and commission $
  must be mapped (column-mapped files); every non-invoice row must carry a numeric amount AND commission;
  every open-invoice ledger row a billed amount; the file must hold at least one commission figure. A blank is
  never turned into 0 — the import is refused (422 `statement_incomplete`) naming the unmapped column(s) and
  the rows missing a value, in analyze AND import (legacy and MI-1a paths).
- **A learned name alias names the COMPANY, not a branch** (Williams Brothers, 2026-10-10). The importers pick the
  branch by ship-to ZIP inside the dealer family, so an alias saved from Review & correct is stored on the family
  root (HQ) unless the name itself names that branch (its own business name or city). Branch routing that a name
  can't carry is a per-manufacturer ZIP assignment. An alias already pointing to a different dealer is never
  overwritten silently (409 `alias_conflict`, confirm to replace).
- **Status 2026-10-10 (PROPOSED, branch `commission-coverage-fix` — not merged, not deployed, no SQL run):** code above +
  `test/commission-coverage.test.js` (34, mutants 32/32) + `test/commission-sept2026.pg.test.js` (11). Cleanup
  `supabase/commission_sept2026_cleanup.sql` (+ `_rollback.sql`, read-only `_preview.sql`) moves exactly the 7 blank
  Strongback 2026-09 rows into `monthly_sales_quarantine` (whole rows, original ids, evidence; RULE 19 locked) —
  preview: 7 match, fingerprint c7b81f69…, 12,004 → 11,997 rows, totals unchanged. `williams_brothers_alias_fix.sql`
  (+ rollback) moves the generic alias from Princeton to the HQ. Coverage impact: 107 received → 79 (all kept; 0
  gained), 23 → estimated (ABM 11, Strongback 12), 5 → not entered (Strongback 2026-09, Ohio Medical 2026-04/06/07,
  Climbing Steps 2026-05). Found, not in the cleanup: Ohio Medical 2026-04 has 16 blank PAYMENT rows; Bemis 2026-06
  has 4 blank rows of 17; Access4u has 7 payment lines with a sale but no commission (a future file like that is now
  refused). Decisions pending: confirm PediFix/Ovation (and whether ABM) sales reports are statements; the two older
  generic Williams aliases (→ Henderson, → Columbus). `mi_import_v2` stays OFF until this is reviewed.
  **September cleanup RUN by Angelo 2026-10-11 02:43 UTC (verified):** 7 rows quarantined (whole, fingerprints valid,
  preview fingerprint c7b81f69… = the stored copies), 0 left in monthly_sales, 11,997 rows, $10,802,558.50 / $493,077.06
  unchanged, live = Part 0 snapshot (EXCEPT ALL 0/0), 0 batches / 0 superseded, quarantine RLS on / 0 policies / anon +
  authenticated no privileges / service_role yes. A second run was correctly refused ("expected exactly 7 matching
  rows, found 0 — nothing written"). Outside public-key check (`scripts/quarantine_public_probe_browser.js`, run by Angelo
  2026-10-11 02:52 UTC, key accepted on a public table first): read 401/42501 BLOCKED, write 401/42501 BLOCKED. (Alias fix and code deploy since DONE — see "Controlled steps" below.)
  **Angelo's decisions 2026-10-10 (after independent verification of the cleanup — do NOT run it again):** approach
  approved with one change — a month holding valid statement lines AND lines without a commission figure is
  **"Received — incomplete, requires review"** (partial, with the count), never plain green; kept apart per month:
  valid statement lines · explicit $0 commission · missing commission · open/unpaid invoices · sales-report estimates;
  never manufacture a zero. ABM sales-report commission stays an ESTIMATE unless the actual manufacturer file is
  verified as its statement. PediFix/Ovation exceptions kept **provisionally**, with their evidence documented
  (`STATEMENT_SALES_REPORT_EVIDENCE`): PediFix = 172 rows from one sales export `PediFix_ALL_2025-2026.csv`, every
  commission = amount × 10% computed at import (not read from a statement) → months resting on it are marked
  provisional (dashed); Ovation has no rows. A sales export never becomes a confirmed statement because estimated
  commission values are populated. Ohio Medical / Bemis / Access4u / Climbing Steps exceptions = READ-ONLY review, no
  cleanup, no other financial record changed. Williams Brothers generic alias → HQ approved in principle, NOT to be run
  yet (exact guards + a fresh production pre-check first); September shipment stays on Princeton via ZIP 47670; the two
  older generic aliases unchanged pending a separate review. Both MI switches stay OFF; AirAvant correction not started.
  **Coverage correction DEPLOYED 2026-10-10 22:02 CT** (main 935e1c7, Netlify "Published"; branch merged with the latest
  main incl. Academy A2A, no conflicts). Tests: commission-coverage 41 (+39/39 mutants), commission-sept2026.pg 11,
  mi1a-compat 16 (+14/14), mi1a-identity.pg 28, all Phase 0 suites, academy-a2a 31 + pg 15, mcverify 19 (after updating
  the local ordering repo); phase1-visits / phase2-account-class / phase2-timeline fail identically on main (clock).
  Live grid on production data: 74 received (incl. 16 PediFix provisional), 5 partial (Bemis 2026-06: 13 valid / 4
  blank; Access4u 2025-10, 2026-05/06/07: $0-sale payment lines without a commission figure, 4/1/1/1), 23 estimated
  (ABM 11, Strongback 12), 4 not entered (Climbing Steps 2026-05; Ohio Medical 2026-04 = 16 blank payments + 19 open
  invoices, 2026-06 / 2026-07 = open invoices only); Strongback 2026-09 not on file. Production unchanged: 11,997 rows,
  $10,802,558.50 / $493,077.06, D7 / B1 / keys / attribution fingerprints = the original Part 0/Part 2 values, 0 batches,
  both switches OFF, alias still on Princeton (459 aliases).
  **Controlled steps 2026-10-10 ~22:25–22:40 CT (authorized by Angelo 22:20):**
  (1) **Williams Brothers alias fix RUN** (`williams_brothers_alias_fix.sql`, sha256 9c2773f6…, pasted verbatim): only
  "WILLIAMS BROTHERS HEALTHCARE PHARMACY" moved Princeton 3396b841… → HQ 86baecc2… (root; Princeton's parent). Unchanged:
  459 aliases, every other alias (fingerprint), the two older generic aliases (WILLIAMS BROS HEALTHCARE → Columbus,
  WILLIAMS BROTHERS HEALTHCARE → Henderson — still pending their own review), dealers, monthly_sales, dealer_manufacturers,
  the quarantine (September WB row still on Princeton, fingerprint c7b81f69…). Rollback file: sha256 9044287a…, not run.
  (2) **`mi_import_v2` ON for operator-reviewed Strongback sales imports** (`mi_commission_v2` stays OFF). Smoke test =
  preview only on the live page, original workbook (sha b7a17e64…): v2 path, 143 rows, 142 matched, $43,021.50 / $3,871.94,
  57 unchanged / 0 new / 0 changed / 0 retire, 0 collisions / cross-lane / differences, 25 account numbers confirmed,
  applied false. Production after: 11,997 rows, $10,802,558.50 / $493,077.06, D7 / B1 / keys / attribution fingerprints
  unchanged, 0 batches. Imports are run by an operator after reviewing the preview; nothing imports or retires on its own.
  The Strongback September order CSV is NOT imported until its own preview + reconciliation is approved.
  (3) **Provisional months are reported apart (main 027f961, Published):** a month resting only on the RULE 14
  sales-report exception has status `provisional`, is NOT in `received` and is never counted as a verified receipt;
  `config.summary` counts months per status and the grid shows it. Live: **58 verified received · 16 provisional
  (PediFix) · 5 received — incomplete · 23 estimated (ABM 11, Strongback 12) · 4 not entered**. Open invoices keep their
  own status. Tests 42 + mutants 43/43; commission-sept2026.pg 11.
  (4) **Historical exceptions — RECORDED for later source-document review; NOT changed (no record altered, no $0 entered):**
  Ohio Medical 2026-04: 16 blank PAYMENT rows (invoice no, order date, customer, dealer present; no amount/commission) +
  19 open invoices; Ohio Medical 2026-06 / 2026-07: open invoices only (13 / 12). Bemis 2026-06: 4 blank part lines
  (7YE85320H20 ARM, 9YA040002, 9YA040001, 1BALLMISC ×50) beside 13 valid lines. Access4u 2025-10 (4), 2026-05 / 06 / 07
  (1 each): $0.00 payment lines without a commission figure (3 of the 7 are voided) — never auto-entered as $0; a future
  file with such lines is refused by the import gate (decision on how to enter voids pending). Climbing Steps 2026-05: one
  cash sale $1,466.50 with no commission figure. Each needs the manufacturer's source document before anything changes.
- The **Commission Report Import coverage grid** shows **every year that has data** (not just the current
  year), so loaded history stays visible; green = received, amber = still needed (current year), grey =
  gap in a past year.
- Optional hygiene: backfill `source='commission'` on legacy commission rows that predate the tag
  (`supabase/backfill_commission_source.sql`). Not required for the grid, which already keys on
  commission data.

## 15. Partner 360 catalog is managed in the admin Catalog Management Workspace (RULE)

The Partner 360 product catalog is curated end-to-end through the **Catalog Management Workspace**.
**File locations (see RULE 0.1):** the tool is **`homecareproviderservices/src/admin/product-content-review.html`**
and its backend is **`homecareproviderservices/netlify/functions/product-content.js`** (this repo — served at
`homecareproviderservices.netlify.app/admin/product-content-review.html`, linked from the "Product Content
Enrichment & Review" tile). The `product_content*` **SQL schema files live in the OTHER repo**,
`homecareproviderservicesordering/supabase/`. The whole catalog — product structure, SKUs, lifecycle status,
categories, sizing, and content — is edited in that UI. Do **not** hand-write SQL for routine catalog
changes; add a backend action instead so the workspace can do it.

- **Workflow (standard order):** Import → Review structure → Correct products & categories →
  Enrich images & content → Add sizing/specs → Disable obsolete → Preview → Approve → Publish.
- **Structure review before enrichment.** Every product whose SKUs look like several products bundled
  together is flagged *"Possible Multiple Products — Review SKU Grouping."* Signals: more than one HCPCS
  code, more than one base product name, or more than one catalog group across its SKUs (strong signal),
  or a large SKU set of 8+ (soft nudge). The reviewer splits, moves, merges, or dismisses. This is the
  operational partner to RULE 11 (variant-aware products): bundles get split into one record per product.
- **Lifecycle status (one field, `product_content.status`):** `pending_review` · `approved` · `rejected`
  (review states) and `published` · `active` · `discontinued` · `hidden` (catalog states). **Approve ≠
  live.** Approve signs off content; **Publish** makes it live and orderable. Per-SKU status
  (`active`/`discontinued`/`hidden`) and a `disabled` flag suppress individual SKUs or the whole product.
- **Public visibility gate:** a product/SKU shows on Partner 360 only when
  `status IN ('published','active','discontinued')` and `disabled = false`. The RLS policy **and** the
  `product-content` function's public read filter must always match this set. The migration
  `supabase/product_content_catalog_workspace.sql` moved every legacy `approved` row to `published` so
  nothing went dark — deploy that SQL and the function together.
- **Sizing/spec tables are pasted, not coded.** Paste a tab/comma table in the workspace; it is stored as
  `{columns:[…ordered…], rows:[…]}` so column order survives. No per-product SQL sizing files going forward.
- **Every structural/status/content write is logged** to `product_content_history` with a before-snapshot,
  and is reversible from the workspace **History → Undo** drawer. Undo restores snapshots and hides
  (never hard-deletes) anything a change created.
- **Editing a SKU number is a TRUE global rename (never edit only the content copy).** The workspace's
  ✎ Edit SKU control renames everywhere at once: it calls catalog-api `rename_code` (re-points the catalog —
  `custom_products` / `product_overrides` / `product_links` / `product_media` / `featured_products` — and
  **`dealer_contract_prices`**), then `product-content` `rename_sku` (content overlay + history). The catalog
  is the SKU's source of truth (`code`); `product_content.skus` is a reference copy — keep them in sync via
  this rename, never by editing one side alone. **Historical `order_items` / `monthly_sales` keep the original
  code on purpose** (a record of what was actually ordered/sold). `catalog-api` requires the **president** role.
- **AI-assisted content is on by the central style guide (RULE 12).** Each editable field has a ✨ AI button →
  `product-content` `generate_content` (Anthropic, `ANTHROPIC_API_KEY` + `HCPS_AI_MODEL`). Prose fields
  (description/tagline/features/warranty) inject `loadStyleGuide()` and re-generate once if `findBanned()` flags a
  phrase; category/subcategory align to the existing taxonomy. Output is a draft the reviewer edits and Saves —
  never auto-published — and the prompt forbids inventing specs/measurements/claims.
- **Removing a SKU is grouping-only, never destructive.** The 🗑 Remove (per-SKU and bulk `remove_skus`) takes a
  SKU out of THIS product's `product_content.skus` grouping and logs a before-snapshot for Undo. It must NEVER
  delete the orderable catalog item or its price — that is the Discontinued/Hidden status, managed in Product
  Catalog. Keep the tool's labels clear: **“Off” hides a SKU (stays listed); “Remove” takes it out; Split/Move
  relocates it** — and none of them touch pricing.
- **Price Check verifies catalog price coverage.** The 💲 Price Check button cross-references every SKU (across all
  products) against the catalog price list (catalog-api GET: `base_price` from the deployed JSON / `custom_products`,
  with `product_overrides` applied) and reports priced vs. missing-price vs. not-in-catalog SKUs. It is read-only —
  pricing is set in Product Catalog (base) and Contract Pricing (per-dealer), never in the enrichment tool.
- **Product images render large (150px, click to open full size)** in Images/Documents & Source — reviewers must
  actually see the photo. Don't shrink them back to thumbnails.
- **Auth = Connect 360 staff sign-in (per RULE 9), no token prompt.** The workspace loads
  `/admin/staff-session.js` and sends `Authorization: Bearer <HCPS.token()>`; the `product-content`
  function verifies it via `whoami()` (Supabase Auth → `staff_users` admin role) and does every write with
  `SUPABASE_SERVICE_ROLE`. The service-role key is server-only and never reaches the browser.

## 16. Connect 360 field CRM — permissions, visits & the Command Center (RULE)

Agreed for Phase 0 / Phase 1 (2026-09/10). Applies to every rep-facing tool.

- **Reps never change structural dealer settings — even on their own book.** Ordering/portal access,
  email verification status, account numbers, company info edits and other dealer settings are
  **management-only** (president/admin/owner), enforced in the function (`dealers-api` NON_MGMT_READS,
  `crm-api` save_account_ref), never by hiding a button. Reps work visits, notes, contacts, tasks,
  opportunities, emails, dealer intelligence and routes. Customer Relations is read-only in Dealer Manager.
- **Scope = `_scope.js`.** `dealers.rep_email` is authoritative; a rep reaches a record only through a
  dealer in their book (knowing an id is never enough). Missing/invalid token → deny.
- **One store per record type — no parallel systems.** Visit follow-ups go into `dealer_tasks` through
  `_tasks.js createTasks`; deals into `opportunities` through `_opps.js` (existing stages only; Zoho reads
  named columns, so new columns are not synced); people into `dealer_contacts`; meeting attendees into
  `dealer_visit_participants` linked to `dealer_contacts` with a name/title snapshot (still readable if the
  contact is deleted).
- **AI suggests, the rep approves.** Visit summaries, attendees, follow-ups and opportunities are
  suggestions until the rep taps Approve; nothing is written to the CRM before that. A follow-up email is
  a draft — Edit / Copy / Save draft / Send — and **never sends automatically**. No AI runs on page load
  (one approved exception, 2026-10-03: the Morning Brief is written after the Command Center is on screen
  when today's brief doesn't exist yet — see 2B below).
- **A replay is a no-op.** Every write from a visit carries `(origin_type, origin_id, origin_key)` against
  a unique index (or a claim PATCH on a null column), so a double tap, an offline resend or a late replay
  never duplicates a visit, note, task, deal, contact, activity row or intent signal — while a genuinely
  new visit still creates a new record.
- **Command Center access:** a rep sees only their own; president/admin/owner and Relations may pick a
  rep to view, read-only. The `rep_landing` switch (`staff-auth` landingFor) stays **off** until approved —
  then `pilot` for named reps, and `on` for everyone only after the pilot is approved. A Relations user
  follows it **only when her own email is listed** (`on` alone never moves Relations); management always
  lands on `/admin/`. Pilot approved 2026-10-03: Greg + Lori → Command Center.
- **My Sales Workspace (President dual role).** The President also works his own dealer book. Masthead
  "My Sales Workspace" sets a per-tab flag (`staff-session.js` HCPS.workspace, `?workspace=mine|off`; any
  page outside CC / field app / map / Dealer 360 / My Tasks / Pipeline leaves it) and API calls carry
  `x-hcps-workspace: mine`. The server (`SC.workspaceMine`, management only) uses it **only to narrow
  lists** to his book via `SC.ownBook` (the rep resolver — `dealers.rep_email`, no second ownership model):
  CC (no picker, his own day), my_tasks/task_count, pipeline board, list_routes (not routes he planned for
  others), dealers-api GET, geocode-api GET. **Phase 2 amendment 1 (2026-10-03):** the workspace is Angelo
  acting as a rep, so operational sales writes and record checks made from it are limited to his book too —
  `SC.workspaceUser(event, me)` checks him as a rep with his own book (dealer/record checks in crm-api,
  pipeline-api, routes-api visit actions incl. Start visit, ai-email-api, visit-voice-api, email-sync-api);
  role gates keep the real role. Admin mode (no header) keeps company-wide reach. The header means nothing
  for reps or Relations. Back to Admin Dashboard leaves it.
- **Reads:** filter on the server, run in parallel, page past the 1000-row cap (`SC.getAll`), no N+1 and
  no company-wide payloads to a rep's browser.
- **Shipping:** SQL the user must run is pasted inline in the reply (and committed as a file); after a push,
  the live Netlify endpoints are tested — a successful push is not proof of a deploy.
- **AI never blocks a visit.** The meeting summary is four AI requests run at the same time ("what
  happened", commitments, follow-ups, deals — each a fraction of the output, so long dictations fit the
  function's time limit); each asks for compact JSON, is shape-checked and retried ONCE inside a fixed budget,
  and only supplies its own keys. Thinking is turned OFF for these calls (Sonnet 5 thinks by default —
  slow, and it used up the output allowance); a model that refuses the setting is asked again without it.
  If a later part fails, the summary still shows, marked partial (saying
  which part); Try AI again then asks ONLY for the missing part and fills only that section — what already
  came back and anything the rep changed is never touched. The parts are cross-checked without another AI
  call (quantity, model vs the notes, deal contact, promised date, asked-for follow-ups): conflicts are
  marked for the rep, never resolved by picking one. The review always opens: "Try AI again" in place, or a full manual fallback (summary,
  attendees, follow-ups, opportunities, next action). The rep's notes are saved before any AI call.
- **Dates in AI drafts are absolute.** The real visit date is passed in; drafts say "on October 2", never
  "yesterday/today" unless the system itself computed it. Follow-up emails go to an attendee first; with
  several attendees the rep chooses; the main contact is only the fallback.
- **A visit needs a real dealer.** Visit writes check the dealer exists — for every role, management included.
- **QA switches** (`qa_fail_first`, `qa_fail_part`, `qa_visit_at`) work only for the president on a TEST
  dealer and are ignored for everyone and everything else.
- **View-as** stays president-only, audit-logged, and goes through the same server authorization as the
  real user. Never add a bypass or a test-only endpoint that skips authorization. QA switches that only
  change AI/email behaviour are allowed solely for the president on a TEST (`is_test`) dealer.
- **Duplicate suggestions** (a follow-up repeated, or a next action that repeats a follow-up) are shown
  unticked — never silently dropped, never auto-selected twice.
- **Phase 2 switches** (`_flags.js`, app_settings `phase2_flags`): a feature is on only when its value is
  exactly `true`; a missing row/key or a read error = off = Phase 1 behaviour. Turning a switch off is step 1
  of any Phase 2 rollback (no deploy).
- **Unplanned visits (2A, switch `adhoc_visit`).** Start visit on Dealer 360 opens the field app in dealer
  mode (`scheduled-routes.html?dealer=<id>`) — the same visit flow, no route. The phone makes a `visit_key`
  at Start and sends it on every call, queued or not; the server finds the visit by rep + dealer + key, so a
  replay after approval never opens another visit or lands on the next one. One open unplanned visit per
  rep per dealer (`uq_dvr_open_adhoc`): a second Start resumes it. Reach: the rep's book or a route he
  drives; Relations and Admin mode anywhere; My Sales Workspace his book only.
- **Morning Brief (2B, switch `morning_brief`).** One stored brief per person per day (`rep_daily_briefs`,
  kind `morning`). `today` only READS it, so the Command Center renders at once; the page then calls
  `rep-command-api` `brief` (`auto` writes it if there is none yet; `refresh` once per 10 minutes; `check`
  read-only). The row is the lock (one generation at a time; a stuck `generating` row is retried after 90 s).
  Every focus item / watch-out must cite a ref from the input (task, follow-up, deal, appointment, stop,
  signal) and quote no $ amount the input lacks — anything else is dropped; nothing grounded → no brief, the
  rule-based Today's Priorities stand in. `signals_key` marks a stored brief stale when the day's facts change.
  Relationship signals (`_brief_ai.js rankSignals`, top 8; TEST dealers excluded): a rep's and the President's
  own book (`SC.ownBook`, in My Sales Workspace and the Admin view alike — never company-wide President
  data); Customer Relations: her own work plus the top 10 company-wide signals. Management and Relations may
  READ a rep's stored brief, never write one in that person's name.
- **End-of-Day Recap (2C, switch `eod_recap`).** Same table, kind `eod`, same rules (own only; one
  (re)generation per 10 minutes; read-only for management and Relations; one per person per day, shared by My
  Sales Workspace and the Admin view). The numbers are counted by code (`_brief_ai.js recapInputs`: visits
  completed/started, people met (unique), commitments, follow-up tasks created from today's visits, tasks
  completed (done, not dismissed), deals created today, weighted pipeline added, follow-up emails sent/drafted,
  open follow-ups, tomorrow's priorities); the AI writes only the narrative. `checkNumbers` checks every number
  in it against the count it sits next to (no totals, no percentages, $ only the counted amounts); a mismatch is
  retried once with the exact figures, then rejected — the card shows the counted numbers and `ruleRecap`.
  **No AI on page load**: the card (evening view, or whenever a recap is stored) only calls `check`; the rep
  taps "Write my recap".
- **Relationship Timeline (2D, switch `timeline`).** Dealer 360's activity list becomes one chronological
  history built at READ time by `crm-api timeline` (`_timeline.js`) from the existing stores — no activity
  table, no writer change, nothing written by reading it. Each thing appears once: a visit report (completed)
  folds its visit note (`visit_note_id`), its `visit` activity row (ref_type visit_report, or the legacy row
  written at the same moment); a call (`call_outcomes`) folds its note (`note_id`) and `call` row; a synced
  email / engine send folds its logged `email` / `campaign` row; an appointment its `meeting` rows; a Golden
  order (`federation_orders`, one per `external_order_id`) its order / purchase rows. Portal activity is one
  line per portal per local day (`tz` from the browser) plus milestones: first sign-in ever, a sign-in after
  30+ days away, a cart left open over $500. Newest first, 50 a page, `before` cursor; a source that hits its
  row cap sets a "floor" the page never goes below, so Load older skips and repeats nothing. Filters: visits,
  calls, emails, tasks, deals, orders, portal, notes. Who may read it = who may open that Dealer 360 (the
  crm-api dealer-scope check; in My Sales Workspace Angelo's own book). Off → the old 50-row list.
- **Opportunity stage history & Conversion (2E, switch `conversion`).** An audit layer on the SAME
  `opportunities` table and five stages (no second deal system). `opportunity_events` is written ONLY by the
  database trigger `hcps_opportunity_event` (AFTER INSERT OR UPDATE OF stage, status): kind `created` /
  `change` with from/to stage and status, value at the time and `changed_at` — authoritative whichever code
  path wrote. `source`/`changed_by` only when reliably known: `pipeline` + the email when pipeline-api's
  write carried `x-hcps-source: pipeline` / `x-hcps-actor` (PostgREST request headers; nothing else sends
  them), `visit` + the row's updated_by/created_by for a deal whose own row says it came from a visit, else
  `unknown` (e.g. the Zoho pull — Zoho code is unchanged and never reads this table). The migration wrote one
  `baseline` per existing deal (source baseline, changed_by system): a starting point, never a move — moves,
  closes, entered-Quoted and time in stage count only created/change entries; a stay that began at a
  baseline isn't measured. `pipeline-api history` (one deal) and `conversion` (`_conversion.js`, pure: 30/90/
  180/365 days or from–to) are scoped like the board: a rep his own deals, My Sales Workspace Angelo's own,
  President/Admin/Relations company-wide; no commission figures. Win rate = won ÷ (won + lost) closed in the
  period. "Possible order match" = same dealer + same manufacturer (the deal's known slug, or a line equal
  to exactly one manufacturer) + a portal order / sales-report line within 120 days AFTER creation (a
  month-only sales line must be a later month) — never called attribution. Off → the Phase 1 Pipeline page.
- **Zoho sync failures are recorded, secrets never stored (2F-1).** `_zoho_log.js` is the one way the Zoho
  sync records a problem: `failRow()` → a `zoho_sync_log` row with `result:"fail"`, ONE ROW PER FAILED
  RECORD (entity, entity_id, dealer_id, zoho_id, action; `detail` = JSON {phase, msg, run, …} up to 8000
  chars). `redact()` drops any field named like secret/token/auth/password/api key/signature/cookie and
  masks this deployment's own secret values (webhook secret, Zoho client secret, service key) anywhere in
  text — the webhook stores and logs only the redacted copy. **2F-1.1:** `scrubString()` also masks anything
  SHAPED like a credential (an Authorization header value, a Zoho OAuth token `1000.<hex>.<hex>`, a JWT, an
  `sb_secret_` key, and the value of any secret/token/password/api-key/authorization `name=value` /
  `name: value` / `"name":"value"` pair), and EVERY logging path goes through it — failure rows, the run
  summary, `console.error`, the autosync crash row (kept whole, up to 8000 chars) and zoho-api's error replies.
  Nothing may `catch(e){}` around a Zoho read or write: autosync uses its per-run collector (`F.fail`, flushed after each phase) and logs the run
  "partial" when any failure happened; the run's own row is complete JSON with counts
  (`failures`, `failures_by_phase`), never cut. `_zoho.js`: `upsertRecords().failed` lists every refused
  record (a refused batch lists each record in it); `getAllRecords()` sets `.incomplete` when a page
  failed or the 60-page cap was hit. On-demand actions in `zoho-api.js` and scheduling's Zoho task/lead
  calls log the same rows; responses carry `failed` and `zoho_read_incomplete`. Sync behaviour (what is
  sent to Zoho, what is written to HCPS, ordering, the webhook's queue write) is unchanged by 2F-1.
- **Account class (Phase 2 add-on, `dealers.account_class`).** One optional label per account, set by
  President/Admin only (`dealers-api set_account_class`; Edit company info on Dealer 360): dealer, prospect,
  manufacturer, vendor, service_provider, internal, other, not_relevant. It decides ONE thing — Morning Brief
  relationship signals skip manufacturer / vendor / service_provider / internal / not_relevant
  (`_account_class.js SIGNAL_EXCLUDED`); blank (every existing record), dealer, prospect and other stay
  eligible. It never changes owner, rep scope, access, visibility or any other column (no `updated_at`), and
  nothing is ever classified automatically or inferred from a company name.
- **TEST isolation (2F-2).** `_zoho_test.js` is the ONE rule every Zoho push path uses: a dealer with
  `is_test = true`, and everything attached to it — its own email, contacts, deals, tasks, notes,
  appointments, website-booking Leads, sales roll-ups and campaign recipients — is never sent to Zoho.
  `load(sbGet)` reads the TEST dealers and their contacts' emails once per run/request and THROWS when it
  can't; the caller then pushes nothing (fail closed) and records why (a failure row; autosync logs the run
  "partial", sets `outbound_skipped:"test_rule_unavailable"` and still runs its pulls). Matching: by dealer
  id; a record that only carries a company name (imports, the master list, a booking not yet tied to a
  dealer) by the name compared on letters and digits; imports and Leads also by a TEST dealer's email.
  Wired into zoho-autosync (accounts, contacts, deals — TEST rows dropped BEFORE de-duplication, so a real
  dealer's copy of a shared address is still pushed), every zoho-api push (sync_accounts, sync_contacts,
  zoho_import_accounts/contacts, zoho_load_master, sync_deals, mirror_to_zoho, sync_opportunities —
  responses carry `test_excluded`), schedule-api's Zoho task and Lead, and campaign-api push_to_zoho. Any new
  code that writes to Zoho must use it (the 2F-2 test fails when a new Zoho writer appears without it). The
  autosync summary carries `test_excluded:{accounts,contacts,deals}`. Existing Zoho TEST records are left
  alone — removing them is a separate, approved cleanup step. Pulls from Zoho are unchanged.
- **Zoho and testing.** Until 2F-2 is live and verified, TEST dealers, contacts, tasks and opportunities can
  still reach Zoho: create none unless the task requires it and Angelo has approved it, and live tests use
  what exists (the TEST sandbox dealer, read-only checks). Once 2F-2 is verified live they stay out of
  Zoho, but live tests still create only what a check needs, on the TEST sandbox dealer.
- **Zoho webhook credential + payload (2F-3).** The webhook's credential is the HTTP request header
  `x-hcps-secret`, checked (timing-safe) against Netlify env `ZOHO_WEBHOOK_HEADER_SECRET` — header ONLY: the same
  value sent as a URL/body parameter is refused (401). A webhook secret never goes in a URL, query string, body,
  log, payload, screenshot, report or source control, and Claude never views it: Angelo generates it locally and
  enters it in Netlify and Zoho himself. `ZOHO_WEBHOOK_SECRET` is the RETIRED secret (exposed on screen during the
  2026-10-07 inspection): accepted the old way only while it is still set, so the webhooks can be moved over one
  at a time; it is deleted from Netlify (and the site redeployed) once all three Zoho webhooks are proven on the
  header, which ends the old way for good. Rotation order: add the new env var → deploy → move each webhook →
  one safe test per module → delete the old env var → redeploy → prove an old-secret call gets 401.
  **Done 2026-10-08:** all three webhooks accepted on the header; `ZOHO_WEBHOOK_SECRET` deleted and the site
  redeployed, so the old way is off. **Netlify env changes reach functions only after a new deploy** — after
  adding, changing or deleting a variable, Trigger deploy and confirm "Published" in the deploy list before
  testing (the first acceptance test failed only because the new variable had not been deployed yet).
  `zoho-webhook.js normalize()` is the ONE place inbound payloads are read (URL query, urlencoded or multipart
  form, JSON incl. lookups and `{data:[…]}`, base64 bodies); `pick()` then reads module, record id (a generic
  `id`, else the module's own id — never another module's), Modified_Time, Modified_By, Account_Name, Email,
  matching names case/punctuation-insensitively; everything is sanitized (`_zoho_log.js redact`, which also
  masks `ZOHO_WEBHOOK_HEADER_SECRET`) before it is stored or logged. A receipt's `detail` is JSON
  `{summary, modified_time, modified_by, accepted_via, shape}` — `shape` = content type, body kind, query/body
  key NAMES only (a long token-like name is kept as `[long-key]`). A refused call that presented a credential
  or looks like a Zoho event is recorded as an `action:"auth"` failure row with the reason (at most 20 an
  hour); no value is ever kept. The response, the GET probe and the queue write are unchanged (the queue's
  42P10 failure stays visible until 2F-4 repairs it — repaired in 2F-4, see below).
  **Zoho webhook form (learned 2026-10-08):** everything under the form's **Header** section (its Module
  Parameters AND Custom Parameters) is sent as HTTP **headers**; the **Body** section (Form-Data) is the body.
  A header name cannot contain a space — the old Contacts webhook sent a header named "Account Name", so every
  Contacts call was rejected as "Bad request" before reaching HCPS (the 16 failures), and module/id arrived as
  headers, which is why every older receipt logged "Unknown". Live config of all three webhooks: POST to
  `…/.netlify/functions/zoho-webhook` (nothing after it); Header = ONLY `x-hcps-secret` (the new secret, entered
  by Angelo); Body = Form-Data with module fields `id`, `Modified_Time`, `Modified_By`, `Account_Name` (+ `Email`
  on Contacts) and custom field `module` = Accounts / Contacts / Deals; DateTime format yyyy-mm-dd, Central
  time. Zoho sends it as urlencoded. On Contacts and Deals `Account_Name` arrives as the account's Zoho id (a
  lookup), on Accounts as the name. Claude never views a webhook page once the secret is in it (the saved
  details page shows header values).
- **Inbound Zoho events: capture + classify ONLY (2F-4, RULE agreed 2026-10-08).** Until 2F-5 establishes field
  authority and conflict handling, an inbound webhook event never changes HCPS business data: no dealer,
  contact, deal (stage / value / close date), new contact, Dealer 360 activity/timeline entry, and never
  triggers a Zoho push. (The old 15-minute Deals PULL — Zoho stage/amount/close onto linked HCPS deals — was
  replaced in 2F-5 by the conflict-safe deal engine, see below. Account and Contact events stay capture-only.)
  **Identity:** each event's key is `in:<module>:<Zoho id>:<Modified_Time>:<sha256 of the cleaned payload, 24
  hex>` (`zoho-webhook.js eventIdentity`; key order and surrounding spaces don't change it). The database holds
  ONE queue row per key: full unique index `zoho_queue_event_key_uniq` + `hcps_zoho_capture_event(p jsonb)`
  (insert, or on the same key only `deliveries+1`) — never an application-side check, and never the old
  partial index (dropped). Migration `supabase/phase2f4_inbound_identity.sql` (rollback
  `…_rollback.sql`: redeploy the 2F-3 code FIRST, then run it). **Deploy order: run the SQL, THEN push the
  code** — without the function every event answers 503 and is logged as a failure.
  **States (every event ends explainable, never silently dropped):** `pending` + classification null =
  captured, awaiting classification; `pending/external`, `pending/unresolved` = for 2F-5; `ignored/echo` =
  HCPS echo (with its reason; the database refuses `ignored` without `echo` and a classification without a
  reason); `failed` = no record id / unknown module / unreadable body (reason in `last_error` + a failure row);
  a repeat = `deliveries` count + a receipt with result `duplicate`; capture refused = failure row (with the
  event key) + receipt outcome `not_captured` + **503** (deliberately not 200, so Zoho may retry; a retry is
  recognised, never doubled).
  **Echo rule — Modified_By is NEVER used** (the integration signs in as Angelo Audia, also a real Zoho user,
  so "Modified_By = Angelo" must never mean "ignore"). `zoho-autosync` classifies pending events: echo ONLY if
  (1) exactly one HCPS record's last ACCEPTED push went to that Zoho record — `app_settings.zoho_push_times`
  `{key: {at, id}}`, written only for records Zoho accepted, key as in `zoho_push_hashes`; (2) Zoho's CURRENT
  values of the pushed fields, rebuilt exactly as the push hashed them, equal that push's fingerprint; and
  (3) the event's Modified_Time (Chicago wall clock, `ZOHO_WEBHOOK_TZ`) is within −10 min … +2 min of that
  push. Values differ → external; no recorded push (incl. every TEST record) → external; record not in Zoho
  or tied to 2+ HCPS records → unresolved. Time proximity alone never makes an echo. If Zoho or the push
  times can't be read, events stay unclassified (failure row, run partial) — nothing is guessed, and unread
  push times are never overwritten. Proving the echo rule live uses the next NATURAL HCPS push — never a
  manufactured edit to a real dealer.
- **Deals: field-level two-way sync with conflict protection (2F-5, RULE agreed 2026-10-09).** ONE engine,
  `_zoho_deals.js`, moves a linked deal's two-way fields — **stage, amount (HCPS `value`), close date** — for the
  15-minute zoho-autosync AND the on-demand zoho-api actions; nothing else may push or pull those fields. Each field
  is compared independently with the **last-synchronized baseline** (`zoho_deal_baseline.base`), never with
  `updated_at` (any unrelated HCPS edit changes it): only Zoho changed → applied to HCPS; only HCPS changed → that
  field ALONE is pushed (partial PUT); neither → nothing; **both → a `zoho_deal_conflicts` row (open) and NEITHER side
  is changed** — a conflict never silently picks a winner (both changed to the same value = they agree). An open
  conflict clears only when both sides agree again (resolved in place, kept). The baseline moves only for a field
  that was agreed, applied or pushed successfully; a refused/failed write leaves it (retried next run, never doubled).
  **Zoho → HCPS only through an inbound Deal event that 2F-4 classified external and still pending** (agreed: events
  only); a Zoho difference with no event is **drift** — logged once, never applied. **A stale event never authorizes
  a newer change** (amendment 2026-10-10): an event authorizes the Zoho state read only if Zoho's current
  Modified_Time ≤ the newest Modified_Time of any CAPTURED event for that deal (applied, echo or pending alike);
  otherwise the state holds an uncaptured change — nothing from it reaches HCPS, the drift is reported once, and the
  event stays pending until the newer change's own webhook arrives. A Zoho record or event without a readable
  Modified_Time authorizes nothing. **One Zoho Deal id belongs to at most one HCPS deal** (unique index on
  `zoho_deal_baseline(zoho_id)`); a Zoho deal linked to 2+ HCPS deals is not synchronized at all (failure row). Events of Zoho-only (unlinked)
  deals, echoes, unresolved, Account and Contact events are not touched. A processed event ends `synced` or `conflict`
  with an `outcome` text. **Stage:** HCPS keeps its five stages; Zoho's EXACT stage is kept in
  `opportunities.zoho_stage` (nullable) and the baseline. A Zoho move between stages that map to the same HCPS stage
  (Needs Analysis ↔ Value Proposition ↔ Identify Decision Makers) changes no HCPS stage and is never rewritten to
  HCPS's preferred Zoho stage; HCPS pushes a stage only for its OWN stage change and never when Zoho's stage already
  maps to it; an **unmapped Zoho stage is preserved, recorded for review (`unmapped_stage`) and never overwritten**.
  The mapping itself is unchanged (not redesigned). A blank HCPS close date is "no value" — never pushed, never a
  change (provisional close-date handling is 2F-6; new deals still get the provisional date as before). **First
  sight of a linked deal (no baseline):** fields that already agree become the baseline; a field that differs is a
  `no_baseline` review — nothing is guessed, nothing written on either side. HCPS-owned Deal fields (name, line →
  Description, account link) stay one-way and are pushed only when they change. TEST deals are never pushed (2F-2)
  but are kept in step FROM Zoho. A push records the 2F-4 push time + fingerprint (`_zoho_deals.js fingerprint`, the
  same function the echo classifier uses). Order in a run: Accounts → Contacts → classify inbound (2F-4) → Deals.
  Migration `supabase/phase2f5_deal_sync.sql` (additive; rollback `…_rollback.sql`: redeploy 58bfbe0 first).
  Live proof of HCPS→Zoho pushes uses the next NATURAL HCPS deal edit (TEST deals can't be pushed); unmapped-stage
  proof is automated (Zoho's picklist has no unmapped stage) — agreed 2026-10-09.
  **2F-5 approved COMPLETE (2026-10-10).** Still open, NOT blocking: on the next NATURAL HCPS-only real deal change,
  confirm only the changed field is pushed, its webhook is classified echo with no second write, and an equivalent
  exact `zoho_stage` stays untouched when another field is pushed. Never manufacture a real-deal change to prove these.
- **Close dates (2F-6, F5 — RULES agreed 2026-10-10).** HCPS `expected_close = null` stays null until a person
  actually chooses a date; an HCPS-generated/provisional Zoho date is never pulled back into HCPS as if it were real;
  a genuine Zoho close-date change with its valid external Deal webhook still goes through the 2F-5 field-level
  engine, and HCPS-only real close-date changes still push through it; both sides changed = conflict, never silently
  pick one. Stage and amount behaviour, Accounts/Contacts and TEST/orphan/duplicate Zoho records are not touched.
  **Zoho's actual API behaviour is established FIRST, on the TEST deal only** (can Closing_Date be cleared? can an
  update omit it? is it required on create?). If Zoho accepts a genuinely blank date: HCPS null = Zoho null and the
  invented-date behaviour is removed entirely (no provisional mechanism that isn't needed). If Zoho requires a date:
  STOP and report before any placeholder policy — never invent a 30/60/90-day or other business date without
  approval. The three real open deals' old-sync dates are NOT cleared or rewritten at deployment: after 2F-6 is
  proven, a separate review shows those records and the exact proposed cleanup before anything changes. The four TEST
  deal dates belong to the later TEST cleanup. Discovery tool: `zoho-api probe_close_date` (president only; refuses
  any Zoho deal not linked to exactly one TEST dealer's deal, and fails closed when the TEST rule or the link can't be
  read; steps read / meta / clear / clear_blank / omit / restore / create; writes carry `trigger:[]` so no workflow or
  webhook fires; each write is logged as action `probe`, result ok / refused). It is the one deliberate exception to
  "TEST records never reach Zoho" — authorized for 2F-6 discovery only.
- **Zoho inspection decisions (2026-10-07, Angelo).** The 183 Zoho-only Deals are NOT imported into HCPS
  automatically. The 175 Closed Won sales roll-ups are not HCPS opportunities. The 8 orphan TEST Deals are
  cleanup candidates for later. The 8 orphan Accounts are real businesses — review/merge candidates, never
  automatic deletions. The 22 historical duplicate Accounts need a reviewed cleanup later, never a bulk delete.
  **No Zoho cleanup is authorized** until Angelo approves a specific cleanup step. Order agreed: 2F-3 webhook
  repair + rotation → 2F-4 echo filtering + inbound queue repair → 2F-5 deal conflict / stage preservation
  (F4/F6) → 2F-6 provisional close-date handling (F5); F1.1, sync order and stage mapping stay as they are
  until their unit.

## 17. Online Ordering — one master record per field (RULE, agreed 2026-10-07)

Architecture: **Structure Map = organisation · Product Content Enrichment = identity/content ·
product_skus = commercial (SKU, dealer price, MSRP, MAP, tiers, sellable status) · Partner 360 =
published output.** One master answer per field; no tool keeps its own copy; no new parallel store.
Disagreeing sources are reported, never silently resolved. Priority until further notice: finish
Climbing Steps → Strongback → Ovation; **no new manufacturer onboarding and no admin-nav redesign**
until all three pass the Gold Standard (Structure, Content, Commerce, Partner 360).

- **Canonical commercial write (migrated lines).** Admin commercial edit → `product_skus` FIRST →
  temporary legacy projection (override / added row) so the shop matches while
  `record_authoritative=false`. Never "edit the override, then copy it into the record". The
  projection is marked `patch.record_projection.fields`; the reconciler settles a projected field
  from it alone and never counts it as a vote against the catalog file. One path:
  `commitCommercial` in `catalog-api.js` (save_override, bulk_price/Price Check, save_product,
  retire/restore/discontinue). If the record write fails, nothing is written to the layers.
  Lines with no product_skus rows keep legacy behaviour until they are migrated.
- **The record is never rebuilt from the layers on a migrated line.** The end-of-request hook only
  checks parity (what the shop shows vs product_skus) for the codes touched and writes a
  `parity:` message to `manufacturer_meta.record_resync_error` on any difference — that blocks
  authority. `reconcile apply replace:true` is refused while canonical edits exist.
- **A failed read is an error, never an empty layer.** Catalog file: 404 = genuinely no file
  (empty); any other failure throws. Supabase reads on these paths have no `.catch(()=>[])`.
- **Record authority** stays OFF on every line until that line's parity is proven and Angelo has
  reviewed the reconciliation report. `set_record_authority` requires `confirm_parity:true`, a
  clean `record_resync_error`, and zero parity drift; it never rewrites the record.
- **Product Catalog saves send only the fields the person changed** (`draftChanges`). A price edit
  must never pin name, category or description as an override.
- **Price changes are confirmed against the manufacturer's approved price list before anything
  changes;** a conflict is reported to Angelo, not fixed silently.
- **The server is the final pricing authority (Phase 2.7).** `orders-api` prices every HCPS line
  with `_pricing.js`, which runs the storefront's OWN engine (`_shop_engine.js`, a verbatim copy of
  the shop page's familyQty/tierQty/contractPrice/unitPrice + catalog merge — never edit it by hand;
  regenerate with `test/extract-engine.js`; `test/pricing-parity.test.js` fails on any drift, and also
  holds `feedRows`/`recordAuthority` to catalog-feed's and contract prices to dealer-auth's). Every
  read is strict: a layer that cannot be read stops the pricing (503 `pricing_unavailable`) — an
  order is never priced from a partial catalog. The unit price, line total and subtotal stored on
  an order are the server's, never the browser's.
- **Saved carts never re-price silently.** A restored cart (and the cart page, at most once a
  minute) is checked with `price_check`; each moved line shows **Price updated $old → $new**, totals
  and tiers recalculate, the dealer's current contract prices are refreshed, and a withdrawn item
  must be removed before ordering. **Checkout:** the page checks again; then `submit-order` (shop)
  forwards the dealer's sign-in to `orders-api create`, which re-prices and, if anything differs from
  what the dealer reviewed, saves nothing and returns 409 `prices_changed` with the new prices for
  review. Only a recorded order is emailed to HCPS, and the email carries the recorded prices.
  Golden orders are priced by Golden and pass through untouched.
- **Validate → persist → notify (orders).** The recorded order is the proof that an order exists,
  never an email. An order is recorded with all of its lines or not at all (lines that fail to
  write withdraw the order row). No email of any kind (HCPS, dealer confirmation, tracking request)
  goes out for an order that did not persist. A notification that fails AFTER a successful record
  is retried once, then the order is flagged in `admin_notes` for staff — a valid order is never
  rolled back because an email provider failed. When one manufacturer's order fails to record,
  only the recorded ones are emailed; the failed one stays in the dealer's cart.
- **One image authority (Phase 2.4).** A product's photos live on its enrichment page:
  `images_gallery` is ordered with exactly one `primary`, and `product_content.image` is always that
  primary (normalised on every save). A SKU that genuinely needs its own photo uses
  `skus[i].image`. A SKU no page claims keeps its photo on the catalog layer (override `image`, or the
  added product's `image`). Precedence everywhere — shop, Featured, Product Images: SKU photo →
  page primary → catalog layer → catalog file. **Product Images is a view over that authority**
  (images-api writes the page/SKU/catalog record, never `product_images`); on a multi-SKU product it
  asks "whole product or this SKU". `product_images` is legacy: migrated by `migrate_legacy`
  (dry run first; a collision with an approved primary is never auto-replaced), then kept read-only.
- **Gallery with no photo marked main (agreed 2026-10-08):** the page's own image is the main photo,
  even if it is not in the gallery (it is what dealers were shown); only a page with no image falls
  back to the gallery's first photo. A photo the person deletes in Enrichment is never brought back.
  The same rule lives in images-api, product-content, _catalog-join and the shop (`pageImageFor`).
- **Part numbers match exactly in the catalog layers.** An override / added row applies to the
  exact `code` it was written for, as the storefront does — a switched-off lower-case legacy row
  ("fcom-02") never hides its upper-case twin. (Enrichment SKU lists still match case-insensitively.)
- **Visible ≠ sellable (agreed 2026-10-08).** Page status published/active = visible and orderable;
  **discontinued = visible for reference (content, documents, related products) but nothing on it
  can be ordered**; hidden or disabled = removed. A SKU entry marked discontinued is shown as
  "Discontinued" and cannot be ordered; hidden/Off removes it. Partner 360 (`VISIBLE_STATUSES`),
  the admin join (`visible` / `sellable`), the structure audit, the completion board (its own
  "Discontinued" count, outside the percentage, like Retired) and server pricing (refuses
  `_discontinued`) all use this one definition. Catalog-level Retire/Discontinue in Product Catalog
  still removes a SKU from Partner 360 entirely.
- **Quantity pooling follows an explicit commercial family, never presentation grouping** (agreed
  2026-10-08). Until a `tier_family` exists in the commercial master, dealer pricing keeps pooling by
  the catalog `group`; do not switch pooling to product pages.
- **No broken images on dealer pages (standing rule):** every product image has an `onerror`
  placeholder; a failed thumbnail leaves the strip.
- **Old Partner 360 `/admin` pages** are contained with temporary redirects to the main admin; their
  functions stay until usage logs show nothing calls them.
- **Corrections to earlier notes:** Price Check is NOT read-only (it writes through bulk_price /
  save_override, now via the canonical path).
- **Renaming a part number moves the commercial master and contract prices (agreed 2026-10-09).**
  `rename_code` reads every layer strictly (any unreadable layer → 503, nothing written), refuses a
  code already used in the catalog file, an added row OR the master record (409 `sku_in_use`; a
  re-spelling of the same normalised code is allowed), and refuses when one dealer has contract
  prices on both codes (409 `contract_conflict`). Then, in order: master record (re-spell in place,
  or a new row carrying every commercial field + the old row set `not_listed`, `superseded_by` the
  new code) → `dealer_contract_prices` → catalog layers (an added row on a migrated line carries
  the RECORD's prices, never the browser's) → links / media / Featured → retire the old code. Any
  failed step stops and answers 502 `rename_incomplete` with `failed_step` and what was `done` —
  never a silent partial. Legacy `product_images` is read-only and not re-pointed.
- **Retired legacy records are not duplicates (agreed 2026-10-09).** A same-normalised-code twin
  that is switched off (`active:false`, e.g. "fcom-02") is history and never makes the active
  "FCOM-02" show "Possible Duplicate". Two ACTIVE records claiming one normalised SKU are still a
  real conflict. (`_catalog-join.js` duplicate check.)
- **One category resolver (agreed 2026-10-09).** Every screen answers "what category is this?" with
  `_catalog-join.js resolveCategory`, per SKU: a pinned category wins; the subcategory map files a
  SKU only when its page is VISIBLE (published/active/discontinued, not disabled); otherwise the
  SKU's own record category. The Structure Map runs a verbatim copy (`<shared:resolveCategory>` in
  product-content-review.html, drift-tested by `test/structure-resolver.test.js`); a draft page
  shows "→ X once published" instead of being filed early, and a page whose SKUs land under
  different headings is flagged "SKUs split". catalog-api's page read includes `disabled`.
- **Reads that feed a decision are strict everywhere (agreed 2026-10-09).** catalog-api (every
  read path — GET, audits, sweeps, merges, deletes, renames), featured-api, the Contract Pricing
  editor and the admin pages that call them: an unreadable layer is a 503 / a visible error,
  never an empty list. The dealer session (dealer-auth) is the one place that must not fail as a
  whole: unreadable contract prices come back as `prices:null, prices_unavailable:true`; the shop
  keeps the last prices it had and shows "Your account pricing could not be loaded just now";
  checkout re-prices strictly on the server either way.
- **Approved manufacturer sources (2026-10-09).**
  - Climbing Steps: `Climbing Steps 2026 Pricing website 982026.xlsx` is the current price
    authority (the January `2026 Climbing Steps Pricelist.xls` is superseded). Its 21 products are
    the line. The 12 SKUs that appear only on the old list are NOT added; retired records stay
    retired; anything absent from the current source stays not offered until a newer source
    restores it.
  - Climbing Steps images: Angelo's `MP-P08.jpg` (blue/white rolling shower/commode chair) is the
    approved primary for MP-P08 — never replaced by an older legacy upload. `MS-P02-GEN.jpg`
    (yellow Genesis stairlift) is the approved primary for MS-P02-GEN; the earlier photo stays as a
    gallery alternate if it shows the same product.
  - Ovation: `2026 ovation medical pricelist 1092026.xlsx`. Its third price column is labelled
    "Price 5-10 Units" after "Price 2-5 Units" (overlap at 5) — recorded as a source anomaly; HCPS
    normalises the breaks to 1 / 2–5 / 6–10 / 11–20 / 21+ unless a source says otherwise. A
    non-monotonic source row (4900-Wrap 11–20 $9.90 → 21+ $9.95) is kept exactly as published,
    never "fixed". A dealer-facing price change is shown (current vs proposed at qty 1/2/6/11/21,
    contract overrides, affected carts/orders) and approved before it is applied.
  - Strongback: `Strongback Mobility · Dealer Pricing 2026 V2.pdf` (Rev C, Aug 27 2026). Its
    right-hand column is **MAP, not MSRP** — MAP goes in `map`; `msrp` stays blank unless another
    approved source gives one. Wheelchair/rollator levels are 1 / 2+ / 8+. A1005 is sold in
    4-packs: dealer order unit = 4-pack at $50, MAP = $24.95 EACH — a unit-of-measure difference
    (`uom`/`case_qty`), not a bad price; no pack-level MAP is invented. RC100 is not on the sheet:
    legacy/unverified, and it blocks Strongback record authority until sourced or removed.
    "Can mix and match all models to get 2+ pricing" is recorded; whether 8+ pools too is
    UNCONFIRMED, so Strongback quantities are not pooled yet. Freight facts (wheelchairs and
    rollators ship included; accessories $15 per box) wait for the Manufacturer/Freight Center —
    no second freight authority.
- **MSRP has three states (agreed 2026-10-09).** MSRP populated → shown; MSRP empty and not
  marked → derived at 2× dealer price, as before; MSRP empty and `msrp_auto:false` stated by a
  SAVED EDIT (override patch) or the MASTER RECORD → no MSRP is shown, never a made-up one. The
  added-product table's `msrp_auto` column is not that signal (false is its default; 28 live
  Ovation rows rely on the derived MSRP). Partner 360 (`noMsrpRule`, `fillMsrp`, the record
  reconcile), the record feed (`msrp_auto:false` is sent, not dropped) and the admin parity check
  all apply it; parity also flags a record saying "none" where the storefront still derives one.
  Never infer "no MSRP" from a blank field.
- **Climbing Steps complete (2026-10-09):** provenance stamped on all 21 records; verification
  order VERIFY-CS-GOLD-TEST (MP-P09, $69.99 browser = server = stored) placed, seen in dealer
  history, then cancelled in admin.
- **A manufacturer source is staged into the record before activation (agreed 2026-10-09).**
  `catalog-api stage_record_source` writes an approved source's rows (prices, breaks, MAP, MSRP /
  msrp_auto, uom, case_qty, status, source file + date) to product_skus ONLY — never a layer — and
  answers with the activation preview: every field dealers would see change when record authority
  is switched on. `dry_run:true` first. Refused on a line already record-authoritative.
- **Pack units (agreed 2026-10-09, Strongback A1005).** A SKU with `case_qty > 1` is ordered and
  priced per pack: Partner 360 shows "$50.00 per 4-pack · Dealer order unit = 1 4-pack (4 each)",
  a per-piece MAP as "MAP $24.95 each", the cart "1 × 4-pack = 4 each", and both order emails
  "4-pack (4 each)". The unit comes from the master record (server-priced lines carry it).
- **Provenance lives on the master record (agreed 2026-10-09).** `catalog-api set_record_provenance`
  stamps `source_file` / `effective_date` on the product_skus rows a source file lists — record-only,
  never a price, MAP, MSRP, tier, status or layer. Every listed code must have an ACTIVE record or
  nothing is written; `dry_run:true` shows the current provenance first.
- **Climbing Steps is the first record-authoritative line (2026-10-09).** Gold Standard passed
  against the 9/8/2026 workbook (21/21 price/MAP/MSRP, 0 structure faults, 0 true duplicates,
  approved MP-P08 / MS-P02-GEN photos, images and categories identical across Partner 360, Product
  Images, Featured, Structure Map and the admin resolver, server price check unchanged, parity drift
  0) and `record_authoritative=true` was set; the storefront now prices it from product_skus with
  0 differences. Commercial edits on this line go to the record (the canonical path already does).
- **Strongback decisions (Angelo, 2026-10-09).** Rev C is the commercial authority. 2+ mix-and-match
  covers the MODELS only: 1003AB, 1012AB, 1017, 1007AB, 1010AB, 1019, 1036DB, ES0001, R0001; 8+
  stays per SKU. Accessories (incl. A1000/A1001) never pool, not even with each other. Pooling is
  threshold-specific: a price break may name its family (`pool`), a break without one counts the
  SKU alone; a product with no family keeps today's behaviour, so Ovation pooling is untouched.
  RC100 is `not_listed` ("Not offered on current Strongback Dealer Pricing 2026 Rev C"), NOT
  discontinued; history kept, restorable. Accessory freight is "$15 per box — box definition
  pending"; today's free freight stays until the box rule is confirmed, and it is a known Strongback
  activation exception — RESOLVED the same day by the confirmed $15-per-order rule below.
- **Strongback freight CONFIRMED (Angelo, 2026-10-09; replaces "$15 per box").** $15 flat shipping
  & handling ONCE per Strongback order that contains one or more accessories, whatever their number
  or SKUs; models (wheelchairs, ErgoSteel, SEATA) ship included; never stacked. Expressed in the
  existing freight engine: a freight group may select lines by CATEGORY (the canonical dealer
  category — "Accessories"), so new accessories need no code. manufacturers.json Strongback groups:
  Accessories → flatFee 15; everything else → free.
- **Freight is server-computed and stored (2026-10-09).** orders-api works out each order's freight
  with the storefront's own `computeFreight` (now part of `_shop_engine.js`) from manufacturers.json,
  stores `orders.freight_fee` / `estimated_total` (SQL: `orders_freight.sql`, run BEFORE the code),
  and both emails carry that figure (the HCPS email never trusts a browser freight number).
- **Threshold-specific pooling is built (2026-10-09).** A break may carry `pool` (e.g.
  `{min_qty:2, price:497, pool:"strongback-models"}`): it qualifies on the combined cart quantity of
  the line's products whose breaks name that pool; a break without `pool` counts as before. The tier
  validator keeps `pool`; a later save that omits it (Product Catalog, Price Check, imports) keeps
  the record's pool on the same break; the feed carries it; browser and server share the code.
  Ovation has no pools, so its pricing is unchanged. Pooled breaks read "(mix models)".
- **Every active master record states its unit (agreed 2026-10-09).** Before a line goes
  record-authoritative, each active `product_skus` row carries an explicit `uom` (and `case_qty`
  for a pack) — never a storefront display default. Strongback: SB100 / A1000 / A1001 / A1004 =
  Each (individual dealer units under Rev C), A1005 = 4-pack, case_qty 4; the 9 models = Each.
- **The activation check is automated on every commercial field (agreed 2026-10-09).** A line is
  not declared Gold Standard while any field is only inspected by eye. The final check asserts,
  against an independently typed copy of the approved source: base price, every tier, tier pool,
  MAP, MSRP state (null + `msrp_auto:false` = none), uom, case_qty, status, source file — on the
  record before activation and on the storefront (browser) and server after it — plus freight
  behaviour (the live freight rule and each SKU's category). `parityCompare` covers base / MSRP /
  tiers / pools only, so MAP / uom / case_qty / status are asserted alongside it.
- **My Orders shows what the dealer paid (agreed 2026-10-09).** order-history-api returns each
  portal order's stored `freight` and `total` (orders.freight_fee / estimated_total); My Orders and
  the dashboard's recent orders show that total to the cent with "incl. $X freight", the footer is
  "Total (incl. freight)", and the CSV adds a Freight line. `cost` (and every spend KPI / report)
  stays merchandise. Found by the Strongback freight test order, which showed $8 instead of $22.70.
- **Strongback freight verification order (2026-10-09):** VERIFY-SB-FREIGHT-TEST, 1 × SB100 =
  $7.70 + $15.00 = $22.70 — browser = server = stored (freight_fee 15, estimated_total 22.70), one
  order, no notification flag, both emails render $15.00 / $22.70; cancelled in admin. The RC100
  enrichment page is hidden (not deleted); the Strongback catalog audit is clean.
- **Strongback Gold Standard COMPLETE (2026-10-10).** Second record-authoritative line. Activation
  order used (and the order for every line whose storefront must change on activation): snapshot any
  open cart holding the line → re-save each SKU through the canonical edit with the record's own values
  (record first, projection onto the layer — the moment dealers see the new prices) → parity gate 0 →
  `set_record_authority` → full post-activation suite. Units (`uom` / `case_qty`) reach the storefront
  only from the record once authority is on; `price_check` responses do not echo them (the stored order
  and emails get them from the server's internal pricing). Result: 168/168 storefront + server checks
  (every SKU at 1 / 2 / 8, six mix-and-match carts, six freight carts, MAP, no MSRP, units, A1005 4-pack,
  RC100 refused), parity 0/15, Ovation 358/358 unchanged in browser and server. **Legacy-cart item:** one
  saved cart (jennifer.johansson@strongbackmobility.com) holds the old code `SEATA` (1 × $320, Aug 2026);
  it was already unknown to the server before activation, stays in the cart untouched, is shown as "no
  longer available — remove", blocks checkout, and is never converted to R0001 without an approved alias.
- **Bemis is the first Manufacturer Center pilot — and waits (agreed 2026-10-10).** Bemis starts only after
  Climbing Steps, Strongback AND Ovation are all Gold Standard COMPLETE; its onboarding workflow is then
  designed from what those three lines taught, not built ahead of them.
- **Ovation Gold Standard audit (2026-10-10, authority still OFF).** Commercial master = the 2026 price list on
  303/303 active SKUs (colour SKUs checked against their base code); storefront and master identical on every
  field (price, tiers, pools, MSRP, MAP, uom, case_qty) — activation needs no canonical edit. Done: neoprene-knee
  primary marked; 16 photos on 14 pages rehosted from ovationmed.com to our storage (same pictures, order and
  primary kept); 4900-OKBU-S-M / -L-XL / 4900-Wrap category → Knee (per their approved pages); nitrile-glove
  description/features from Ovation's own page + the price list; elastic-bandage page SKU names = master names.
  Open, Angelo's call: strap 30000S photo; units on all 303 records (price list has no unit column — named packs
  only); provenance stamp on the other 302; 4900 subcategory; 18 retired codes still on the 2026 list (Spine
  Brace, Flex Power Plus, Tri-Mod, Premium Plus Back); Ovation freight terms; 21 legacy photo collisions.
  Pooling families mixing different prices or products (night splint + strap, single + 10-pack extension belt,
  casting-tape widths with black split out, gauze sizes) are UNCONFIRMED by Ovation — kept exactly as they are.
- **Ovation decisions (Angelo, 2026-10-10).** UNITS: `Each` (= one manufacturer orderable unit, never an implied
  inner count) unless the approved source/product name states a pack; "12 Rolls" items → `12-roll pack`, case_qty 12
  (cohesive wrap, conforming gauze, elastic bandage, cast padding — 15); 61000-210 → `10-pack` ×10; nitrile gloves →
  `Box` ×100 (the 100/box is in HCPS's catalog names, not the 2026 price list); gauze sponges / casting tape → Each,
  no case_qty, until Ovation supplies a U/M or case-pack sheet (use manufacturer U/M where Ovation publishes it).
  Written to all 303 active records; provenance "2026 ovation medical pricelist 1092026.xlsx", effective 2026-10-09,
  on 303/303. 4900 items → Knee / Knee Braces & Supports. The 18 retired codes still on the 2026 list stay RETIRED —
  a current price is not authorization to reactivate (that is a separate business decision). Freight stays
  "calculated / confirmed by HCPS" until Ovation dealer freight terms exist. The 21 legacy photo collisions stay
  unused and undeleted; a legacy photo joins a gallery only if it is the same product, a useful extra view, equal or
  better quality and not redundant. Pooling families that mix prices/products are recorded as **"Manufacturer
  pooling confirmation pending — current dealer behavior preserved"** and change only on Ovation's written
  confirmation. 30000S strap photo: manufacturer-owned image preferred, verified to show the strap, rehosted; never a
  reseller image without Angelo's approval; if none exists, stop and ask — Ovation's page lists 30000S as text only
  (its "detail" photo is the splint's own stretch-indicator strap, not the accessory), so the photo is with Angelo.
- **Ovation master authority activation PASS (2026-10-10).** Third record-authoritative line;
  `record_authoritative=true` with parity 0/369 and no canonical edit needed (storefront already equalled the
  record). Post-activation: storefront prices from the record (303 matched, 0 differences) and its full-field
  fingerprint (price, tiers, pools, MSRP, MAP, uom, case_qty) equals the record's; 358/358 baseline prices unchanged
  in browser AND live server (every SKU at 1–21, all 55 family pairs); MSRP = automatic 2× except 4900-Wrap (none);
  no MAP; pack wording "per 12-roll pack / per Box / per 10-pack · Dealer order unit = 1 … (n each)", Each shows no
  unit; freight unchanged (HCPS-confirmed, $0 computed); retired codes refused by the server; 1,117 snapshot: only
  the approved Strongback activation (15) and Ovation units (302 + 4900-Wrap) changed. 30000S primary photo is a
  THIRD-PARTY RESELLER image (Amazon listing B00N3J0ZY6, Ovation Medical store — Ovation publishes none), approved by
  Angelo and recorded as `source:"third-party-reseller"` with the listing URL on the gallery entry; 30014/30016 untouched.
  Still open (not blockers): manufacturer pooling confirmation pending on the mixed-price families; 31 same-name
  master records and 56 option tidiness notes (dealer labels verified distinct). Climbing Steps, Strongback and
  Ovation are all Gold Standard — Bemis may be planned once Angelo reviews this report.
- **Three lines Gold Standard; no further changes without a regression (2026-10-10).** Climbing Steps, Strongback
  and Ovation are complete and authoritative from product_skus — change them only to fix a regression.
- **Manufacturer Center orchestrates; it is not a second database or pricing engine (agreed 2026-10-10).** It guides
  a manufacturer from source files to Gold Standard through the EXISTING systems — Structure Map (organisation),
  Product Content Enrichment (identity/content/images), product_skus (commercial master), Partner 360 (dealer
  output) — using their existing actions (stage_record_source, set_record_provenance, rename_code, save_override
  canonical edit, set_record_authority, product-content, images-api, manufacturers.json). Workflow: Upload sources →
  Extract → Match SKUs → Review conflicts → Structure/content/images → Commercial rules → Freight/UOM → Stage master →
  Compare dealer output → Approve → Activate → Verify. Only new storage allowed: a metadata register of source files.
  Bemis is the pilot; **no Bemis production writes until Angelo approves the pilot plan.**
- **Bemis audit (2026-10-10, read-only).** Bemis is ALREADY `record_authoritative=true` (10 product_skus rows, 9 active,
  parity 0) but was never Gold-Standard checked: no source file / provenance, no MAP, no enrichment pages (9
  unassigned SKUs), case prices 1¢ off unit × case on two seats, per-unit MSRP shown beside per-case prices, "2/CS"
  unit labels. Sources held: 2026 dealer application (Terms of Agreement eff. 2022-03-01: case-quantity ordering,
  $10/line less-than-case, $500 prepaid-freight minimum else +$40 S&H, MAP policy, 2/10 net 30), 2026 Bath Safety
  catalog (item numbers, no prices), 2026 Assurance display program. **No Bemis price list held; the $20 dropship
  charge appears in no Bemis source** — not implemented. Authority flag left as is pending Angelo's decision.
- **Bemis pilot decisions (Angelo, 2026-10-10).** Pilot plan and 12-step Manufacturer Center APPROVED, with two
  human gates (conflict/business-rule approval; final activation approval). Bemis `record_authoritative` switched
  OFF (it had never been validated against a source) and stays OFF until Bemis passes the full process. Today's
  Bemis prices, MSRP and packaging are legacy/current-state data, NOT manufacturer truth: do not "fix" the 1¢ case
  prices, per-unit MSRP beside case price, "2/CS" wording, Steadfast case qty, display-kit UOM, MAP or 7Y… mapping
  until the source pack settles them. Keep 7Y… codes; manufacturer item numbers become aliases; renames are a
  separate approved action. Freight wording keeps Bemis's terms: "$500 minimum for prepaid freight; below $500,
  +$40 shipping & handling" (never "free freight" in provenance). The $10 less-than-case fee is recorded, not
  coded, until the storefront can create a less-than-case order. The $20 dropship fee is NOT valid unless Bemis
  confirms it in writing. No Bemis enrichment pages until the source pack and SKU matching are done; existing nine
  photos may stay meanwhile, official Bemis assets win when supplied, all hosted by HCPS. Before the files arrive
  only the read-only Manufacturer Center framework may be built (source register, metadata/effective date/
  supersedes, extraction preview, saved column mapping, SKU-match proposals, conflict queue, dry-run comparison).
  Human approval required for: source selection, source conflicts, dealer-facing price changes, MAP/MSRP
  interpretation, UOM/case where sources disagree, aliases/renames, active/retired, pooling, freight and fees,
  third-party imagery, the final canonical edit, authority activation. A failed/unreadable source fails loudly.
- **Bemis Digital Price List 2026 received (2026-10-10, not yet approved as the source).** Model numbers = the 9 HCPS
  7Y… codes; MSRP = MAP per unit on every row; case packs 2/4/3. On every case row "Dealer Cost Per Unit" is exactly
  $10.00 above Master Case Cost ÷ case qty — question for Bemis before anything is staged. No effective date,
  freight, dropship or breaks on the list; Steadfast and the display kit have no case qty.
- **Turning authority OFF can change display even at parity 0 (learned 2026-10-10, Bemis).** The parity gate does not
  compare uom/case_qty: the record held case_qty 2, the catalog file holds the text "2/CS", so with authority off the
  storefront lost "per 2/CS · Dealer order unit = 1 2/CS (2 each)". Before switching authority either way, compare the
  storefront's full rendered output (fields + price block), not only prices.
- **Bemis 2026 source APPROVED and staged; authority stays OFF (Angelo, 2026-10-10).** `Bemis Digital Price List
  2026(20261010-175622).xlsx` is the authoritative commercial source. Dealer price = the explicit Dealer Master Case
  Cost with `uom = Case`, `case_qty = Master Case Qty` — never derived from the unit cost, and the unit cost is never
  derived from the case. MAP and MSRP are separate per-piece fields; on a case item the card reads "$X per Case ·
  Dealer order unit = 1 Case (N each) · MSRP $Y each · MAP $Z each". The only price changes were 7YR05310TSS and
  7YE05310TSS $109.99 → $109.98 and 7YA0AS100 $99.99 → $99.98. **Two dates, never one:** HCPS received the file
  2026-10-10 (price_imports raw `_received_date`); the manufacturer effective date stays NULL on product_skus until
  Bemis confirms it — never invented, never the received date. The authority gate does not require an effective
  date. **Final decisions (Angelo, 2026-10-10 14:35):** the file is accepted by HCPS as the current 2026 Bemis price
  list; the missing manufacturer effective date is recorded as pending and is NOT an activation blocker. The "sold in
  case quantities" rule applies only where the list gives a Master Case Qty. Steadfast 7YE82350TC = Each / 1 and
  444DISPLAY = one orderable Display / 1 (record uom "Display", never a multi-unit Case): neither is a case item, the
  2026 list prices each as a single unit, and neither is flagged as missing a case quantity (price_imports raw
  `_hcps_uom`). A later Bemis source that gives either a pack quantity is a source change Manufacturer Center flags. **Bemis freight words:** `freeLabel` "Prepaid freight" ($500+) and `flatLabel` "shipping & handling" ($40
  below $500) on the Bemis group in manufacturers.json; cart, HCPS email and dealer confirmation use them. A freight
  group without labels keeps the old wording ("FREE freight", "$15.00 freight").
  Legacy price notes that divided the case price into a "/unit" figure, or repeated MSRP already shown as a
  field, are removed. "Dealer Cost Per Unit" lives only in price_imports.raw for this pilot — Manufacturer Center
  should get structured source fields for unit cost, received date and MSRP/MAP basis rather than free text.
  `msrp_each:true` on a pack row (catalog file) labels MSRP "each" and compares it with case price ÷ qty; a pack
  MSRP quoted per pack (Ovation) carries no flag and is unchanged. Unchanged: $500 prepaid freight / +$40 S&H below
  $500, $10 less-than-case fee recorded not coded, $20 dropship on HOLD, 7Y codes, retired DO5300RD444.
- **Bemis Gold Standard COMPLETE (2026-10-10, ~15:00 CT).** `record_authoritative=true` after the final pre-activation
  check (9/9 source-aligned, parity 0 normal + strict, browser = server on 7 carts, freight $499.99/$500.00/$500.01 =
  $40 / prepaid / prepaid, no Bemis contract prices or saved carts, retired DO5300RD444 refused, Ovation/Strongback/
  Climbing Steps fingerprints identical). Post-activation: Bemis prices from the record with 0 differences; the only
  field that moved is 444DISPLAY uom "" → "Display" (approved; shows only in the HCPS email). Do not change Bemis again
  unless a regression is found or Bemis sends a new source (Manufacturer Center flow). Open: manufacturer effective
  date (pending, not a blocker); no Bemis enrichment pages yet (catalog_audit lists 9 "needs SKU review" for that
  reason only).
- **FROZEN: Climbing Steps, Strongback, Ovation and Bemis (Angelo, 2026-10-10 15:13).** All four are Gold Standard
  COMPLETE and record-authoritative. No commercial, content, image, category, UOM, freight or wording change to any
  of them unless a regression is found (then: show the regression, propose the fix, wait for approval) or the
  manufacturer sends a new source (Manufacturer Center flow, two human gates). A shared code change must prove zero
  dealer-facing change on all four (full-field fingerprint before/after). Do not start another manufacturer until
  Angelo says so.
- **Bemis product pages were intentionally DEFERRED (Angelo, 2026-10-10).** Bemis has no enrichment pages by decision;
  catalog_audit's 9 "needs SKU review" for Bemis reflects that deferral only and is NOT a Gold Standard regression.
  Pages come later from manufacturer-supported families/content, with a structure/content/image proposal first.
- **Manufacturer Center lessons from the Bemis pilot (2026-10-10).** (1) Compare the FULL rendered output (fields +
  price block + cart + both emails), not only prices — parity covers base/msrp/map/tiers, not uom/case_qty, wording
  or freight labels. (2) Keep manufacturer facts and HCPS interpretations apart: price_imports holds the file as
  received (raw columns untouched) plus `_hcps_*` notes; product_skus holds the decision. (3) Two dates, never one:
  received vs manufacturer effective. (4) Never derive one price from another (unit vs case); store both as given.
  (5) Manufacturer wording is data (freight labels, MSRP basis), never a global code change — Ovation and Bemis quote
  pack MSRP differently. (6) A staging row that omits a field must not blank it — send unchanged UOMs explicitly.
  (7) The catalog file and the override layer must both be corrected before authority switches either way, or the
  storefront changes when the flag moves. Needed as structured fields: unit cost, received date, MSRP/MAP basis,
  freight terms per source.
- **Manufacturer Center Phases 1–3 (approved by Angelo 2026-10-10; one release, run and verified in order — a
  failure stops it).** Manufacturer Center orchestrates Structure Map / Content Enrichment / product_skus /
  Partner 360; it is never a second product database or pricing engine. Decisions:
  (1) **Freight terms** live in `manufacturer_meta.freight_terms` (merged over manufacturers.json from Phase 5); every
  rule set carries `trace` {source_id and/or decision_id} — a CHECK refuses untraced terms.
  (2) **`product_skus.dealer_unit_cost`** = the accepted manufacturer per-piece cost; the raw value stays in
  `price_imports.raw`. Never dealer-facing, never used to calculate a dealer price. `msrp_basis` / `map_basis`
  (`each` | `order_unit` | null = today's rule) are recorded now and read by the storefront only from Phase 4.
  (3) **Source files** go to the private bucket `mfr-sources`; SHA-256 in `mfr_sources`. A new source must have a
  received date (legacy backfills are flagged `legacy`, never given an invented date); `effective_date_status`
  stated|pending|not_applicable, and "stated" exists exactly when the manufacturer date does.
  (4) **The freeze is a hard block** at two levels: catalog-api `freezeGate` refuses every commercial action on a
  `manufacturer_meta.frozen` line before writing (423 line_frozen), and the database trigger `mfr_freeze_guard`
  refuses the write itself whatever path sends it (catalog-api, images tool, the ordering site's old catalog
  endpoint, hand-run SQL). The only override is an unused `mfr_decisions` row of kind `regression_fix` for that
  line, sent as `regression_fix:{decision_id, reason}` (catalog-api forwards it as header x-hcps-regression-fix and
  marks it used after success). No silent unfreeze; authority and freight terms of a frozen line are guarded too.
  Hand SQL on a frozen line: record the decision, then `select set_config('request.headers','{"x-hcps-regression-fix":"<id>"}', true);`
  in the same transaction. `mfr_freeze_guard_selftest()` (catalog-api `mc_guard_selftest`) tries one write per
  table per frozen line inside rolled-back sub-transactions and must report every attempt "blocked".
  (5) **Safe staging** (stage_record_source): a field a source row omits is KEPT; a value is cleared only when listed
  in `clear` AND `clear_decision_id` names a decision of that line; the dry run reports per SKU changed / unchanged /
  would_clear / not_in_source; a new file never inherits the old file's effective date; `source_id` must be an
  accepted source of the line.
  (6) **Verification = `mc_verify`, not parity alone**: server copies of the storefront engine and card/freight
  rendering are re-extracted from the LIVE index.html every run (`_extract.js`; mismatch = fail); full-field parity
  (price, MSRP, MAP, tiers, UOM, case qty); source alignment vs price_imports + decisions; product-card rules;
  cart pack line; browser = server on every SKU and the closest real carts either side of each freight threshold;
  freight fee + wording at −1¢/exact/+1¢; dealer confirmation and HCPS email rendered (nothing sent); contract and
  saved-cart impact; retired SKUs refused; every image loads; the line fingerprint (same canonical lines as the
  Partner 360 browser fingerprint) against the last passing baseline. Evidence saved in `mfr_verification_runs`.
  `_shop_render.js` / `_hcps_email.js` are verbatim copies — regenerate with `node test/mc-copies.js`, never by hand.
  Rule 19 applies to every MC object (RLS on, no policies, revoked from public/anon/authenticated, public-key check).
  Multi-SKU test carts are priced against the WHOLE cart (the engine's CART holds that cart while it prices it), as
  the storefront does — family and pooled tier breaks count every line. Pricing each line alone was a checker defect
  (failed runs #2 Strongback and #4 Ovation, kept as history); never delete or rewrite verification runs.
  (7) **The freeze stays as built (Angelo, 2026-10-10).** On a frozen line the database also refuses override
  saves that only change a name, image or description when that row's patch holds price keys (the save is an
  upsert, so the INSERT is checked first). That is accepted under the freeze rule. Do NOT weaken the guard for
  Bemis product-page work (or any other content work on a frozen line): it comes through an explicitly approved
  `regression_fix` decision or a separately approved freeze-policy change, nothing else.
  **Phases 1–3 ACCEPTED / COMPLETE (Angelo, 2026-10-10).** Baselines: Bemis #1, Climbing Steps #3, Strongback #5,
  Ovation #6, all pass; fingerprints unchanged at every step. Release review is on record in the Manufacturer Center
  implementation plan doc. Open follow-ups: re-check anonymous listing of `mfr-sources` after the first real source
  file is stored; live keep-vs-clear staging stays test-backed until a suitable non-frozen master record exists.
  Phase 4 (MSRP/MAP basis reaching the storefront) is approved as its OWN release; accepted only with zero
  dealer-facing change and identical fingerprints on Climbing Steps, Strongback, Ovation and Bemis. Phase 5 is not
  approved yet.
- **Manufacturer Center Phase 4 — MSRP/MAP basis on the storefront (approved by Angelo 2026-10-10; its own
  release).** `product_skus.msrp_basis` / `map_basis` ('each' | 'order_unit' | empty) travel through catalog-feed
  (and `_pricing.feedRows`, identical) and, on a record-authoritative line only, onto the product. They decide
  only the PACK card words: `msrpIsEach(p)` / `mapIsEach(p)` in index.html. Empty basis = the standing rule,
  unchanged (MSRP "each" only for catalog rows with msrp_each:true, MAP "each" on every pack); a single item never
  gets a basis label; an unknown word is ignored. MSRP "each" is weighed against the per-piece price, per order unit
  against the order-unit price. mc_verify compares the basis in full-field parity and checks the card wording
  against the RECORD. Acceptance: zero dealer-facing change on Climbing Steps, Strongback, Ovation and Bemis — the
  backfilled basis reproduces today's cards exactly. The product DETAIL page, featured tiles and quotes still show
  MSRP/MAP without a basis label; changing them would be dealer-facing on frozen lines and needs separate approval.
  Phase 5 (freight terms from manufacturer_meta) is not approved yet.
  **Phase 4 PASS / COMPLETE (2026-10-10).** Post runs Bemis #7, Strongback #8, Climbing Steps #9, Ovation #10 all pass
  against baselines #1/#5/#3/#6; all 347 products identical, the 28 basis rows (Bemis 7 each/each, Ovation 20 MSRP
  order_unit, Strongback A1005 MAP each) keep their wording, fingerprints equal `gs_fp_pre_mc_p4`. Saved run detail is
  stored as jsonb, so compare runs with sorted keys, never raw JSON text.
  Phase 4 accepted by Angelo (2026-10-10). Accepted limitation: no live pack has both MSRP and MAP basis blank, so
  that fallback stays test-backed — never create production data just to exercise it. Product detail pages,
  featured tiles and quotes stay outside Phase 4 and unchanged.
- **Manufacturer Center Phase 5 — freight terms as data (approved by Angelo 2026-10-10; its own release).** A line's
  freight rule = `manufacturer_meta.freight_terms` when present AND valid (`validFreightTerms`; its `trace` is dropped)
  → otherwise its manufacturers.json `freight` entry, exactly as before → otherwise no rule. The record replaces the
  file entry WHOLE (never a field merge), so a partial record cannot combine with the file into a rule nobody wrote,
  and a missing / null / empty / malformed / unreadable record can never wipe a rule — the file stands (the
  storefront warns in the console; mc_verify fails `freight_source` when a line's record terms are invalid).
  One function decides, `freightTermsFor` in index.html: the storefront runs it in loadManufacturers (manufacturer_meta
  is read with the public key, freight_terms included), and the server runs the same text from `_shop_engine.js` in
  `_pricing.lineProducts`, so cart, stored order, dealer confirmation and HCPS email can never pick differently.
  manufacturers.json stays the compatibility / fallback layer: keep it in step until a later, separately approved
  phase retires it. Corsicana and PediFix have no record terms and stay on the file. Frozen-line terms are guarded by
  the freeze (a change needs a regression_fix). Must stay exactly: Climbing Steps free on every order (`freeAt: 0`);
  Strongback $15 once per order with accessories, $0 models only; Ovation freight confirmed by HCPS, no threshold;
  Bemis under $500 = $40 shipping & handling, $500+ = "Prepaid freight". Phase 6 is not approved.
  **Phase 5 PASS / COMPLETE (2026-10-10).** Post runs Bemis #11, Strongback #12, Climbing Steps #13, Ovation #14 pass with
  `freight_source` = record on all four; every freight check, both emails, cards and parity equal the Phase 4 runs value
  for value; fingerprints equal `gs_fp_pre_mc_p5`; Corsicana and PediFix verify as file. Invalid/missing record terms
  stay test- and mutant-backed — never change production freight data just to exercise them. Phase 6 waits for
  Angelo's approval of the Phase 5 post-release report.
  Phase 5 ACCEPTED (Angelo, 2026-10-10); runs #11–14 and the pre/post Phase 5 fingerprints are kept. Production fallback
  approved: valid `manufacturer_meta.freight_terms` → manufacturers.json → no rule. A bad or unreadable record may fall
  back so dealers are not disrupted, but Manufacturer Center must keep flagging it as a verification failure.
- **Manufacturer Center Phase 6 — the guided workflow (approved by Angelo 2026-10-10; its own release).** Screens in
  manufacturer-center.html, per line: 1 Sources → 2 Match & decide → 3 Structure & content (status + links only) →
  4 Commercial & freight → 5 Stage → 6 Verify & activate, plus History (compare two runs) and Decisions. Rules:
  (a) Every write answers `dry_run:true` with exactly what it would write, and the screen shows that before the
  write button exists. (b) **Approval 1** = `mc_approve_gate {gate:'stage', plan_hash, plan_kind:'records'|'freight'}`:
  stage_record_source and mc_set_freight_terms write only with an unused approval whose hash equals the dry-run plan
  the server recomputes (a changed plan needs a new approval). (c) **Approval 2** = `mc_approve_gate {gate:'activate',
  run_id}`: a PASSING `pre` verification run of the same line, newer than every product_skus change; set_record_authority
  (on) needs it, re-checks the run, and spends it. Approvals are mfr_decisions (kind acceptance, field gate:*),
  single-use, recorded only by mc_approve_gate (mc_record_decision refuses gate:* fields). (d) Source facts
  (price_imports, raw kept) and HCPS interpretations (mfr_decisions hcps_value using staging fields; line-wide or
  `applies_to:'packs'`) are kept apart; mc_match only PROPOSES their combination. A source is imported once; a
  corrected file is a new source; a source needs its received date; files go to private `mfr-sources` (sha256,
  never overwritten). (e) The new line writes (mc_register_source, mc_accept_source, mc_import_source_rows,
  mc_approve_gate, mc_set_freight_terms) are in COMMERCIAL_ACTIONS, so a frozen line refuses them (even dry runs) and
  opens read-only; its only control is Decisions → regression_fix. (f) `supabase/mc_phase6_append_only.sql`: runs and
  decisions are never updated, deleted or truncated — the one allowed change is stamping used_at/used_by once.
  (g) Product data is still written only by stage_record_source / set_record_authority; structure, content, images
  and categories stay in their own tools. (h) Tests that write records go through `test/mc-gates.js`. The dry
  walkthrough (test/mcflow.test.js, screens: test/mcui.walkthrough.js) rebuilds a COPY of Bemis as a new line and must
  end at the real Bemis fingerprint 3620a321933995db. Open follow-up: re-check anonymous listing of `mfr-sources` once
  a real source file is stored. Do not onboard the next manufacturer until Angelo approves.
  **Phase 6 correction (approved by Angelo 2026-10-11; appended to the same release — the 2026-10-11 live evidence
  is kept, no run or decision rewritten).** Live Match on the frozen lines proposed every Bemis SKU active → "HOLD",
  the pack basis on the singles, and a fake "needs a decision" queue on the legacy lines. Rules now:
  (i) **Decisions are field-scoped.** A decision changes only the product field named in `field`, with its partner
  (uom+case_qty, msrp_basis+map_basis, status+status_note); a plain hcps_value is that field's value. Any other key
  describes the decision itself (#11 fee_dropship `{"status":"HOLD"}` is a fee on hold, never a product status); a
  decision whose field is not a product field (fees, freight, deferral, acceptance…) changes no SKU. Never merge
  arbitrary hcps_value keys into a SKU. (j) **Pack-only rules follow the facts:** `applies_to` "packs" or any
  pack/case wording ("items with a Master Case Qty") covers only SKUs whose structured case quantity is > 1, after the
  SKU's own order-unit decision (7YE82350TC Each/1 and 444DISPLAY Display/1 are not packs); wording that is not
  understood is never guessed — Match lists it as not applied. A SKU's own decision beats a line-wide one.
  (k) **Legacy sources without stored rows** show "Accepted legacy source — row-level source data not stored; Match
  comparison unavailable." — information, not a conflict and not a decision queue (Climbing Steps, Strongback,
  Ovation). A current (non-legacy) source with missing rows still asks per SKU. (l) A record that already names its
  order unit keeps it (staging keeps omitted fields); `summary.proposed_changes` = new + changed SKUs. (m) Test
  fixtures never contain the Supabase project URL — Netlify secret scanning fails the build on it; fixtures use
  `{{SUPABASE_URL}}` (filled by the test world) and the scan is never widened. Regression tests on the live wording
  of all 15 decisions: test/mcmatch.live.test.js + test/mcmatch.ui.js (test/fixtures/mc-live-frozen.json).
  **Phase 6 ACCEPTED — PASS / COMPLETE (Angelo, 2026-10-11).** Final live check with the correction deployed:
  Bemis Match 9/9 SKUs match the Gold Standard record, 0 proposed changes, 0 decisions needed, 0 false HOLD, retired
  DO5300RD444 still retired; 7YE82350TC Each/1 and 444DISPLAY Display/1 without pack basis; the 7 case SKUs keep
  MSRP/MAP each; Climbing Steps / Strongback / Ovation show the legacy-source label with 0 decisions and 0 proposed
  changes; 28/28 frozen write probes refused; freeze self-test 20/20 blocked; counts 14 runs / 15 decisions /
  0 approvals (verification run with save:false); fingerprints unchanged — Climbing Steps 270c15b4991d580a,
  Strongback d35dcdff0cf9816c, Ovation 46f8ed0f02c81067, Bemis 3620a321933995db. The first, faulty live Match
  evidence is kept as history in the plan doc's Phase 6 release review; no run or decision was rewritten.
  **Manufacturer Center Phases 1–6 are COMPLETE.** Still open: re-check anonymous listing of `mfr-sources` once the
  first real source file is stored there. No new manufacturer starts until Angelo approves it.
  **Release A — the content freeze + enrichment windows (approved by Angelo 2026-10-11).** Plan from here (Angelo,
  2026-10-11): A Safety → B Enrichment workflow (front door, + Add Manufacturer, Continue Product Enrichment, page
  proposals, background Auto-Enrich, image rehosting, field provenance, Review Issues, Advanced Product Editor
  repositioned — all drafts, zero dealer-facing change) → C Dealer Preview (staff-only draft rendering through Partner
  360) → D Publish & Verify (dry run, single-use approval, atomic line publish, verification, back to draft on FAIL,
  new Gold Standard fingerprint on PASS) → Bemis run. Acceptance test: open Bemis → Continue Product Enrichment → the
  system enriches → Angelo resolves only exceptions → preview → publish. Rules:
  (n) A frozen line protects everything dealers see, not only prices: product_content (pages, grouping, content,
  images, category, publish/hidden), product_content_sources, product_media, product_links, product_related (rows FOR
  the line), product_overrides (every patch key), custom_products (every column), manufacturer_meta logo_url / active /
  enriched_only / category_order / category_map. The database refuses it (supabase/mc_release_a_content_freeze.sql,
  mfr_content_guard, beside Phase 2's mfr_freeze_guard); catalog-api (freezeGate, MC.isFrozenProtected),
  product-content.js and images-api.js (MC.contentGate) refuse it first with a plain 423. Not covered on purpose:
  featured tiles (featured_products), storage files on their own (nothing shows until a row links them), the history log.
  (o) Two recorded ways through, nothing else: a regression_fix of that line (any change; single use, spent when the
  request succeeds; header x-hcps-regression-fix) or the line's OPEN enrichment_window (header
  x-hcps-enrichment-window): hidden drafts only — a product_content row hidden before AND after the write (status not
  published/active/discontinued, or disabled) and product_content_sources. Never a visible page, publishing, another
  line, the catalog layer, media, links, related products, the line's settings, or anything commercial. catalog-api
  and images-api never accept a window (their writes are visible at once).
  (p) Windows are opened only by mc_open_enrichment_window (dry run first, reason required, frozen line only, one open
  per line — unique index mfr_decisions_one_open_window) and closed only by mc_close_enrichment_window (used_at stamped
  once). mc_record_decision refuses kind enrichment_window. Bemis's window opens only after Release A passes live, on
  Angelo's go-ahead. Its scope (Angelo): may write hidden draft pages, descriptions/features/specs/sizing, categories,
  page groupings/options, images copied into HCPS storage, manufacturer URLs/source provenance; must NOT change dealer
  price, tiers/pooling, UOM/case qty, MSRP/MAP, freight or commercial active/retired state. Making a page live needs
  Approve & Publish Manufacturer and a passing verification run; a new fingerprint becomes the Gold Standard only then.
  (q) Decided 2026-10-11: the Advanced Product Editor (today's Product Content Enrichment page) loses its price write
  path — a read-only commercial summary plus "Open Commercial & Pricing in Manufacturer Center" (Release B); one
  commercial write path. Warranty and specifications are source-only: blank when the source doesn't state them, never
  an AI default or an inference from similar products. Page grouping is presentation only: sharing a dealer page (Bemis
  Round + Elongated) never creates or changes a commercial pricing family. Statuses stay six: Ready, Needs image,
  Needs content, Needs category, Needs grouping decision, Conflict; review by exception, never field by field.
  (r) mc_guard_selftest runs Phase 2's 20 commercial attempts plus the content guard's 16 per frozen line, each judged
  against what it expects (an enrichment-window draft = "allowed"); a missing content guard is a failure.
  Tests: test/mc-content-freeze.pg.test.js, test/mccontentfreeze.test.js, test/mccontentdrafts.test.js (hidden drafts
  leave the fingerprint unchanged; one visible page moves it), test/mccontent.mutants.js.
  **Release A is APPROVED / COMPLETE (Angelo, 2026-10-11):** live proof accepted — all commercial/content freeze
  checks passed, the four fingerprints unchanged, no window, approval, run or decision created.
  **Release B, gate 1 — draft media (approved 2026-10-11).** (s) product_media can't prove an image belongs only to a
  hidden draft (keyed by SKU, read publicly with no visibility rule), so it stays fully frozen — no exemption, window or
  not. A draft's photos live on its own page row (image / images_gallery / skus[].image / options) and
  supabase/mc_release_b_draft_media.sql (after Release A) makes that provable in the database: product_content.draft_window
  records which window built a draft (the guard stamps it); a window changes or deletes ONLY the drafts it built (never a
  live page, an older hidden page, or another line's page); under a window every image URL on the row must be a copy in
  HCPS storage filed under that window — product-content/<line>/drafts/w<window id>/... (mfr_draft_media_problem) — so
  outside links, the catalog's own /assets photos, another line's or another window's folder are refused; and a draft never
  gets a dealer-visible status under a window, not even switched off (no single later flag can make it visible).
  product-content.js files every upload / file / rehost made under a window in that folder with x-upsert false (never
  overwrites) and re-copies an HCPS file from another folder instead of reusing it. MC.contentGate refuses a window on any
  line but its own (frozen or not), across several lines, and on images-api outright (catalog-layer images). A closed
  window opens nothing, and a NEW window cannot edit the old window's drafts — run one Bemis window to the end. Decision
  kind content_resolution (Review Issues: field page:<page_key>, hcps_value {issue, choice}; a later choice supersedes,
  never rewrites; Match ignores the kind). The self-test is now 25 attempts per frozen line (window drafts and draft
  images "allowed"; live-page images, outside images, another window's folder, another line's window, publishing a draft
  with its image, a live status switched off, a closed window, a page the window didn't build — "blocked").
  Tests: test/mc-draft-media.pg.test.js, test/mcdraftmedia.test.js, test/mcdraftmedia.mutants.js.
- **Photos are hosted by us (2026-10-10).** A product photo loading from a manufacturer's website is moved to our
  storage with product-content `rehost` (same picture, gallery order and primary kept) — a third-party URL can
  vanish and break a dealer page.
- **4900-Wrap corrected (2026-10-09):** $19.50 / 2–5 $15.95 / 6–10 $12.95 / 11–20 $9.90 / 21+ $9.95,
  no MSRP (`msrp_auto:false`); provenance on the record notes the source's "5-10" column normalised
  to 6–10. Ovation parity 0 drift; Ovation authority still waits on its other checks.
- **tier_family (approved concept, 2026-10-09):** commercial pooling will use an explicit pricing
  family in the commercial master, not pages or display groups — but no one-field version until
  the Strongback threshold question is answered (a single family field would pool 2+ AND 8+).
  Ovation keeps today's pooling. No dealer price moves merely because the schema gets cleaner.
- **Climbing Steps Gold Standard (order agreed 2026-10-09):** deploy the 2.4b/2.5c release + the
  integration fixes → full validation against the NEW workbook (21/21 prices, 0 structure faults,
  0 true duplicates, approved MP-P08 / MS-P02-GEN images, unified images, content complete, server
  checkout parity, category consistency, no parity drift) → only then `record_authoritative=true`
  → re-verify (feed uses the record, 21 prices / cart / server / categories / images unchanged,
  ordering works) → report PASS/FAIL and stop before Strongback activation. No Bemis yet.

## 18. Manufacturer report imports — MI-1a transaction identity & safe replacement (RULE, agreed 2026-10-09/10)

Project MI (Manufacturer Reporting & Intelligence) extends the EXISTING Sales Report Import and Commission
Report Import — no second importer, no Strongback-only system. MI-1a is the financial-safety foundation.

- **The PDF dealer report never writes `monthly_sales`.** Manufacturer summary figures (e.g. Strongback's
  September report, its Aug/Sep totals) are reference/reconciliation data only; transactional sales and
  commission come only from transaction exports or commission statements.
- **One transaction identity, per manufacturer, by approval.** A sales line = order + SKU + rank among
  identical lines (`hcps_ms_order_part` / `hcps_ms_sku_part`, SQL — the only definition); the ORDER is the unit
  of replacement; `line_hash` = qty, amount, rate, order date only. A manufacturer uses it only when listed in
  `mi1a_enrollment` — written ONLY by reviewed SQL (Strongback via `mi1a_part2_rekey_strongback.sql`), never by
  code. Every other manufacturer keeps today's import untouched until its own identity audit (dry run D8:
  invoice numbers reused across customers / >31 days / files) passes and Angelo approves. PediFix is NOT
  eligible yet (reused invoice INV173133; no SKU on its 172 rows).
- **Switches** (`phase2_flags`, exactly `true` = on): `mi_import_v2` (Sales Report Import → `hcps_sales_report_apply`
  for ENROLLED manufacturers; also turns on the alias guard) and `mi_commission_v2` (Commission Report Import →
  `hcps_commission_file_apply`). Routing lives in `_mi1a.js`: not enrolled → legacy path, unchanged; enrolled +
  switch off → paused (409 `import_paused`); an unreadable enrolment table is an error, never "not enrolled".
- **Atomic, whole-file writes.** A sales file and a commission file (ALL its months) are each ONE database
  transaction; any failure writes nothing. Replaced rows are archived whole in `monthly_sales_superseded`; any
  batch (`mfr_report_batches`) can be undone exactly, newest first (`hcps_import_batch_rollback`).
- **Statements are never appended by file name.** Every month already holding commission-lane rows (any file,
  before or after MI-1a) needs a reviewed decision: replace (named files), append (reason; refused if identical;
  overlapping lines need confirmation) or reject. A statement control total, when given, must match.
- **Paid records.** A month locked in `commission_period_locks`, or holding a commission statement, changes only
  with `approve_paid` + a written reason, stored on the batch.
- **Cross-lane duplicates are refused** without confirmation: a sales-report line matching a commission-lane line
  (same manufacturer, month, qty, amount), and vice versa. Found live 2026-10-09: AirAvant/BongoRx June 2026.
- **Semantic collisions block an import:** one order number with different account refs or dates > 31 days apart.
- **Non-financial differences** (dealer, customer name, account ref, ship-to, product name) are listed in the
  preview and stored on the batch; confirmed HCPS dealer/rep attribution is always kept.
- **Write guard.** Trigger `hcps_ms_write_guard`: on enrolled manufacturer/lanes only the MI-1a functions may
  insert, delete or change money/key columns; re-attribution (dealer, rep, channel) stays allowed. A row is protected
  when its OLD **or** NEW classification (manufacturer + lane) is enrolled (`hcps_ms_guarded`, security definer so RLS
  can't hide the enrolment) — an enrolled row can't escape by changing manufacturer/source/external_ref, and a row
  can't be moved into an enrolled lane outside the MI-1a functions. Rollback order:
  switch off → revert code (imports for enrolled lines stay FROZEN by the guard) → undo batches newest first → R1
  (old keys + un-enrol in one transaction) → R2 optional.
- **Legacy commission import (always on, 2026-10-10):** deletes ONLY explicitly identified commission-lane rows —
  `source='commission'`, or legacy rows with no source AND no external_ref (the same test as SQL
  `hcps_ms_is_commission_lane`); every other source is untouched — and stops before inserting if the delete fails
  (502 `replace_failed`).
- **Aliases are global** (all manufacturers, both importers, Analytics). With `mi_import_v2` on, assigning a name
  that already points to another dealer is refused (409 `alias_conflict`) until confirmed; past sales never move.
  **Wyatt's Pharmacy → Weaver Medical Equipment Metro stays unchanged** until the business relationship is
  confirmed; no merge, no reassignment; ambiguous manufacturer intelligence for it is held for review.
- **AirAvant/BongoRx June 2026 duplicate (decision 2026-10-10):** keep the Excel commission-statement row
  (f6b9b070…) as the financial authority; archive the PDF sales-report row (b09d0e04…) with its evidence —
  ONLY after Angelo approves the audited correction (`mi1a_airavant_duplicate_correction.sql`, rollback file).
- **Before any MI production SQL:** Part 0 snapshot (`mi1a_snapshot_monthly_sales`) — Supabase daily backups exist
  but Point-in-Time Recovery is NOT enabled, and a daily restore would discard other changes.
  **Part 0 DONE 2026-10-10 18:50 UTC** (approved by Angelo; file on main, sha256 7556e1cb…): snapshot 11,997 rows =
  live row-for-row (EXCEPT ALL both ways = 0), fingerprint dde7a2cef62eb5e5d3525a7a49e9b949 (meta + recomputed), totals
  $10,802,558.50 / $493,077.06, Strongback 143 / $43,021.50 / $3,871.94; RLS on, no policies — the public API returns 0
  rows. Daily backup 10 Oct 09:10 UTC was present. Part 1 / Part 2 not run; both MI switches OFF. Migrations run in the
  Supabase SQL editor itself (its Run button) with the committed file pasted verbatim and its sha256 checked in the
  editor first — the read-only query helper wraps statements and cannot run DDL.
- **MI-1a tables are closed to ordinary app users (approved 2026-10-10, Part 1 rev 3).** `anon` / `authenticated` (and
  PUBLIC) hold NO privileges on `mi1a_snapshot_monthly_sales`, `mi1a_snapshot_meta`, `mfr_report_batches`,
  `monthly_sales_superseded` (+ its id sequence), `commission_period_locks`, `mi1a_enrollment` (Part 1) and
  `mi1a_rekey_backup` (Part 2); RLS on, no policies; the owner and `service_role` keep select/insert/update/delete.
  No MI-1a function is executable by PUBLIC / anon / authenticated either (service_role only), so the write guard
  fails closed for an ordinary-user write to `monthly_sales`. Any new MI table or function gets the same treatment (RULE 19).
  **Part 1 DONE 2026-10-10** (approved by Angelo; file on main ed2a6a1, sha256 a8cf4849…; run verbatim — Supabase's
  "potential issues" dialog answered "Run without RLS" so nothing was added to the file, which enables RLS itself):
  4 tables + 4 nullable monthly_sales columns (all empty) + 10 functions + trigger `hcps_ms_write_guard` installed,
  `hcps_commission_month_apply` absent; 11,997 rows, fingerprint dde7a2ce…, $10,802,558.50 / $493,077.06, Strongback
  143 / $43,021.50 / $3,871.94 unchanged; live = snapshot row-for-row; both snapshot tables byte-identical to before.
  Privileges: anon/authenticated 0 on all 6 tables, the sequence and all 10 functions; service_role 24/24 + 10/10;
  public key → 401 / 42501 on every table and RPC (rule 19 outside check). 0 enrolled, 0 batches, switches OFF; live
  previews (Strongback, PediFix, ABM, AirAvant; PediFix + Ovation commission) still use today's import, nothing written.
  **Part 2 DONE 2026-10-10** (approved by Angelo; file on main, sha256 93499283…, run verbatim — the dialog flagged only
  the temp table `mi1a_before`): 143/143 Strongback sales_report rows re-keyed to v2 with order_key/line_key/line_hash,
  143 distinct keys = the D5 dry-run keys exactly; `mi1a_rekey_backup` 143 rows = the old keys exactly (RLS on, no
  policies, anon/authenticated 0, service_role 4/4, public key 401/42501); enrolment = strongback-mobility/sales_report
  only. A1: D7 fingerprint dde7a2ce… unchanged (11,997 rows, $10,802,558.50 / $493,077.06); B1: 26 dealer rows,
  $43,021.50 / $3,871.94, per-dealer fingerprint unchanged; dealer/rep/channel attribution of every row unchanged;
  every other row's key untouched; 0 batches, 0 superseded; switches OFF. **Strongback Sales Report Import now
  answers 409 `import_paused` until `mi_import_v2` is turned on (by design — the write guard protects its rows);**
  every other manufacturer's sales import and all commission imports (incl. Strongback) still use today's path.
  **mi_import_v2 activation attempt 2026-10-10 — FAILED SAFELY, switch back OFF.** The first live preview (Strongback,
  143 rows) returned 500 "UPDATE requires a WHERE clause": Supabase API sessions load **pg-safeupdate** (authenticator
  `session_preload_libraries = supautils, safeupdate`), which refuses any UPDATE / DELETE without WHERE — inside functions
  and on temp tables too. `hcps_sales_report_apply` had two (`update _in set …`). Nothing was written (baseline, keys,
  attribution, account numbers, aliases identical; 0 batches); `mi_import_v2` set to false. Fix: `where true` on both
  (Part 1 rev 3c) + on the rollback file's enrolment delete; the PG test fixture now loads safeupdate on every session
  so this class of bug fails locally. **RULE: every UPDATE / DELETE in SQL that can run through the API carries a WHERE
  clause (use `where true` for a deliberate whole-table/temp-table change); test databases load pg-safeupdate.**
  **Part 1 rev 3c RE-RUN DONE 2026-10-10 ~16:25 CT** (approved by Angelo; main 8e072e7, sha256 e7f7a304…, verbatim):
  `hcps_sales_report_apply` now carries the `where true` clauses; 10 functions, trigger, privileges unchanged (ordinary
  users 0, service_role 10/10); baseline, keys, attribution, account numbers, aliases, snapshot, backup and enrolment
  byte-identical; 0 batches; `mi_import_v2` still false. Original workbook "Stongback Orders and Account Report
  YTDa.xlsx" (sha256 b7a17e64…) checked OFFLINE: 143 lines / 57 orders / $43,021.50 = HCPS row-for-row (order, SKU,
  qty, amount, date fingerprint de869e5f…; order/account/company/ZIP fingerprint e466ddc4…).
  **mi_import_v2 preview-only acceptance PASSED 2026-10-10 ~20:15 CT** (approved by Angelo; switch ON only for the
  previews, then OFF — it stays OFF until Angelo approves normal operation). Live Sales Report Import page, real workbook
  (sha256 b7a17e64…, verified in the browser): path v2 (`hcps_sales_report_apply`, applied:false), 143 rows, 57 orders
  unchanged / 0 new / 0 changed / 0 to retire / 0 missing, $43,021.50, $3,871.94 at 9%, 142 lines matched (GF Health
  Products, order 5804, $320, is unmatched in HCPS too), 0 non-financial differences, 0 collisions, 0 cross-lane, account
  numbers 25 already correct / 0 conflicts. Modified copy (order 5775 qty 1→2): exactly 1 changed order, $536 → $1,072,
  56 unchanged. File without order 5775: listed as missing, retire 0; retired only when named in `retire_orders`
  (page checkboxes start unticked). 9 non-enrolled manufacturers previewed on the legacy path; 5 commission analyses
  stayed on today's path. A browser guard blocked any non-preview call (0 attempted). After: every row except the 7
  September rows = Part 0 snapshot (EXCEPT ALL 0/0), backup 143, 0 batches, 0 superseded, baseline identical; with the
  switch OFF Strongback answers 409 `import_paused` again. Known display bug: the v2 preview's "Dealers" tile shows
  "undefined" (the v2 summary has no dealer count) — cosmetic, not fixed yet.
  **Strongback September CSV was loaded on the legacy commission path at 2026-10-10 23:49 UTC** ("Strongback Sept
  Commission Report 2026.csv", 7 rows, period 2026-09, source commission, no batch) — not by Claude. All 7 have BLANK
  amount and commission (the file's $2,159 did not land); alias "Williams Brothers Healthcare Pharmacy" was created by
  it. Left untouched pending Angelo's decision.
- **Tests:** `test/mi1a-identity.pg.test.js` (runs the committed SQL in Postgres, bigint + uuid ids),
  `test/mi1a-compat.test.js` + `.mutants.js` (other manufacturers unaffected; switches; alias guard).
- **SB-0 plan (2026-10-10, design only — nothing built):** Claude Doc "SB-0" (claude.ai/code/artifact/d86d9dbc-2856-4761-9e35-7c5333b645f3).
  Three Strongback sources stay in three lanes with their own provenance: order exports → Sales Report Import
  (`monthly_sales`); commission statements → Commission Report Import; the monthly dealer-intelligence PDF → MI-1c
  intelligence only (never `monthly_sales`, commissions, tasks, deals, contacts or Zoho). Proposed: MI-1b = extend
  `mfr_sources` as the one register of manufacturer report files (kinds sales_export / commission_statement /
  dealer_report, period, prepared_date, batch link); MI-1c = `mfr_dealer_snapshots` + `mfr_dealer_observations`
  (RULE 19 locked), match review queue, publish step. September expected matches: 15 auto, 7 review, Wyatt's held,
  GF Health + Nebcare unmatched (never created). Awaiting Angelo's decisions before SB-1.
- **SB-0 APPROVED with refinements; MI-1b development authorized (Angelo, 2026-10-10 22:46 CT).** Branch only — no
  production SQL, no deploy, no historical backfill, no September PDF import until separately approved. Decisions:
  (1) MI-1b reuses the Manufacturer Center register `mfr_sources`. (2) Its unique `(manufacturer, file_sha256)` safeguard
  stays; the report kinds (sales_export, commission_statement, dealer_report) coexist with the six existing catalog
  rows/kinds, which keep their behaviour unchanged. (3) A report's received/accepted status is SEPARATE from whether its
  intelligence is published to Dealer 360: registering or accepting a file never makes a manufacturer PDF visible or
  triggers any action. (4) Keep the original file, SHA-256, received date, manufacturer-prepared date, report period,
  supersession history and an audit trail of approvals; never invent a missing date or a link to a historical financial
  import batch. (5) MI-1c observations use stable SOURCE-POSITION identities (report + page/block/line position), never
  text/date alone, so identical legitimate notes are kept. (6) September matching: 15 automatic candidates, 7 manual
  review, Wyatt's Pharmacy HELD, GF Health + Nebcare unmatched; an import never creates dealers or changes aliases.
  (7) HCPS rep assignments stand: a report's owner field never overrides `dealers.rep_email`, and family-level or
  sister-branch information must not leak across rep scopes. (8) The Strongback September CSV stays separate from the
  PDF; no new sales or commission import is approved. (9) The 5% Premium Chair offer is stored only as unverified
  manufacturer-supplied text — no pricing or campaign action. SB-1 / MI-1c needs its own authorization.
- **MI-1b BUILT on branch `mi1b-report-register` (2026-10-10, NOT merged, NOT deployed, NO production SQL, no backfill).**
  `supabase/mi1b_report_register.sql` (sha256 e4f5b5e2…, rollback `…_rollback.sql` fac9febe…): report kinds
  sales_export / commission_statement / dealer_report on `mfr_sources` beside the 7 catalog kinds; the unique
  (manufacturer, file_sha256) index unchanged; report columns (period, prepared_date + stated/not_stated, file size/type,
  supersede_reason, decided_reason, publication_status unpublished/published/withdrawn for dealer reports only,
  import_batch_id); constraints keep catalog rows free of report fields; guard trigger `mfr_report_guard` (report rows
  written only by the `hcps_mfr_report_*` functions, file facts immutable, never deleted; catalog rows unaffected);
  append-only `mfr_source_events` (service_role select+insert only — its default update/delete/truncate grants are
  revoked); functions register (idempotent by hash; same file under another kind refused; second file for a period
  only as a correction) / decide (accepting a correction supersedes the old record and withdraws its publication in
  one transaction) / publication (publish refused until MI-1c staged intelligence exists) / link_batch (never to a
  batch older than the registration, lane/manufacturer/file name must match). API `mfr-reports-api.js` (president/admin/
  owner only; server hashes the bytes, checks the file signature, stores at `reports/<mfr>/<kind>/<sha>.<ext>` in the
  private `mfr-sources` bucket with x-upsert false; 2-minute signed download). Page `/admin/report-history.html`
  (HUBS: Sales Data & Analytics → Manufacturer Report History). Tests: mi1b-register.pg 34, mi1b-api 22, mutants 32/32;
  all other suites unchanged (phase1-visits / phase2-account-class / phase2-timeline fail identically on main — clock).
  Production observation (read-only): `mfr_sources` ids 2 and 3 are two legacy registrations of the same Ovation 2026
  price list (no hash); left as they are.
- **MI-1b review corrections (Angelo, 2026-10-10 23:10 CT) — migration NOT authorized, no merge/deploy until reviewed.**
  (1) Several distinct, legitimate sales exports / commission statements may cover the SAME period and be registered and
  accepted independently — never forced into a fictitious correction. The (manufacturer, file_sha256) uniqueness stays.
  Only dealer-intelligence reports keep ONE accepted report per manufacturer + period, with the controlled correction
  workflow. A genuine replacement (any kind) must name the record it supersedes and give a reason. (2) A correction must
  cover the SAME reporting period as the record it supersedes (a September report can never supersede October); a
  period-correction workflow would be its own separately approved design. (3) Linking a financial import batch needs a
  NONBLANK batch source_file that exactly equals the registered file name (plus manufacturer, lane, imported status and
  creation-after-registration). (4) The Sales Report Import and Commission Report Import do NOT register their files
  yet — automatic registration is a later controlled unit; the register is not described as complete until then.
  Files stored before a database refusal are identified by their hash-named path having no register row, and are
  reconciled only by a person, never by an automatic delete. (5) Keep the branch current with main and re-run the MI-1b,
  Manufacturer Center, MI-1a and regression suites before review. `mi_import_v2` stays ON, `mi_commission_v2` OFF.
- **MI-1b corrections BUILT on the branch (2026-10-10 ~23:30 CT; still NOT merged / deployed / run).** Branch merged with
  main (3ffb9f6, incl. Manufacturer Center freight-terms work; no conflicts). `mi1b_report_register.sql` sha256
  7761828e… (rollback b79dde05…). (1) One-accepted-per-period is now `mfr_sources_dealer_report_period_uk` (dealer reports
  only); the register's period clash check and decide's "already accepted" check apply to dealer reports only; several
  sales exports / commission statements per period register and are accepted independently. (2) A correction must
  cover the superseded record's exact period — refused in register AND re-checked by the guard trigger on insert.
  (3) link_batch refuses a NULL/blank batch source_file and needs an exact (case-sensitive) file-name match.
  (4) Concurrency: `pg_advisory_xact_lock` on (manufacturer, file hash) and, for dealer reports, on (manufacturer, period)
  — proven with two real sessions (same file → one record + "existing"; two dealer reports for one period → the second
  refused; two commission statements → both kept); without the period lock both dealer reports got in. (5) API: a
  database refusal after the file was stored answers `file_stored:true` + `storage_path` (kept privately, NOT
  registered, reused if the same file is registered later); read-only `orphans` action lists stored files under
  reports/ that no record names — nothing is deleted. Import screens still do not register files (deferred). Tests:
  mi1b-register.pg 43, mi1b-api 25, mi1b mutants 42/42; MC guard pg 17, mcfreeze 17, mcverify 25, freightterms 11 (+mutants),
  MI-1a identity.pg 28 / compat 16 (+14/14), commission-coverage 42 (+43/43), Phase 0 suites all pass; phase1-visits /
  phase2-account-class / phase2-timeline fail identically on main 3ffb9f6 (late-evening clock).
- **MI-1b APPROVED for controlled production rollout (Angelo, 2026-10-10 23:48 CT)** with the reviewed fingerprints
  (migration 7761828e…, rollback b79dde05…). Order: reconcile the branch with main (SQL must stay identical; rerun
  MI-1b / MC / MI-1a / regression; a mutation run with a failing control is not presented as valid) → production
  preflight (6 catalog sources, 0 report records, hash index unchanged, MI-1a schema + financial baseline unchanged,
  `mi_import_v2` ON / `mi_commission_v2` OFF, backup present) → run the SQL in the editor, every check ok → outside
  public-key probe on `mfr_source_events` + the four functions → only then merge + deploy, confirm Published, verify the
  page (President/Admin open, other roles refused, zero records) and run the read-only orphan check (no deletions).
  Not authorized: registering/accepting the September Strongback PDF, importing the September CSV, changing either MI
  switch, AirAvant corrections, MI-1c. Any failed check → STOP, no merge/deploy.
  **Reconciliation (2026-10-10 ~23:58 CT):** main 08c9e58 merged (Academy M1 rev 2, Manufacturer Center Phase 6 guided
  workflow + `mc_phase6_append_only.sql`); MI-1b SQL byte-identical. Compatibility: catalog-api `mc_register_source`
  accepts only catalog kinds and stores files at `<slug>/<sha>/<name>` (MI-1b uses `reports/…`); `mc_accept_source`'s
  direct PATCH on a report record is refused by `mfr_report_guard` (fails closed); the same file cannot be both a
  catalog source and a report (hash index). Tests: mi1b pg 46 (MC Phase 6 in the chain) / api 25 / mutants 42/42;
  mc-append pg 6, mc-guard pg 17, mcflow 13 (+mutants), mcgates 12, mcfreeze 17, mcverify 25, mc mutants; MI-1a 28 / 16
  (+14/14); commission 42 / 11; phase1-visits / phase2-account-class / phase2-timeline fail identically on main 08c9e58
  (late-evening clock), so the Phase 0 mutation run is not reported tonight (its control includes them).
  **MI-1b migration RUN by Angelo 2026-10-11 ~08:47 CT (verified):** the approved file (sha256 7761828e…, from commit
  550480b) pasted in the SQL editor; all 9 install checks ok = true. Preflight before (backup 11 Oct 09:11 UTC present):
  6 catalog sources (5 price_list, 1 terms), fingerprint 425746f1…, 0 report records. After, re-checked: catalog rows
  byte-identical (425746f1…), hash index unchanged; ledger 11,997 / $10,802,558.50 / $493,077.06, Strongback 143 /
  $43,021.50 / $3,871.94, D7 dde7a2ce… / B1 d1f841ca… / keys 0d2908d1… / attribution 810065d6…, 0 batches / 0 superseded,
  459 aliases; the 10 MI-1a functions byte-identical to committed Part 1 rev 3c (per-function md5(prosrc)); dealers 447,
  contacts 770, opportunities 7, zoho_deal_baseline 7, dealer_manufacturers 597811b5…, quarantine 7, price_imports 9,
  MC decisions 15 / runs 14 — all unchanged; flags unchanged (`mi_import_v2` ON, `mi_commission_v2` off), enrolment
  Strongback sales_report only. New: 3 triggers, 4 constraints, 0 events, 0 report records, bucket private with 0 files;
  anon/authenticated 0 grants on mfr_source_events / mfr_sources and 0 executable MI-1b functions; service_role
  select+insert on events, execute on all 7. Outside public-key probe (`scripts/mi1b_public_probe_browser.js`, run by
  Angelo 08:50 CT, key accepted on a public table first): ALL 11 BLOCKED (401) — events read/insert/update/delete,
  mfr_sources read/insert, the 5 RPCs. Lesson: the read-only query helper runs its queries THROUGH the SQL editor, so
  it overwrites whatever is loaded there — never run a check in the editor tab while a migration waits for Angelo's
  Run (the first Run at 08:44 executed a read-only check instead of the migration; nothing was written).
  **MI-1b DEPLOYED 2026-10-11 ~08:57 CT** (branch merged with main c5233cc — MC test-fixture change only, no conflicts,
  migration byte-identical; mi1b pg 46 / api 25 / mutants 42/42, mcflow 13 + mutants, mcgates 12, mcui 21 screens, MI-1a
  28 / 16 → main 939de27, Netlify "Published"). Live checks: Report History page opens for the President under Sales Data
  & Analytics, shows "No report files registered yet"; API POST list → 200, 0 reports, no-store; orphans → 200, 0 stored
  / 0 orphans, read-only; no token / forged token / junk token → 401 sign_in_required (tested with XMLHttpRequest — the
  admin pages' staff-session.js wraps window.fetch and adds the signed-in token, so a "forged" fetch from an admin page
  is NOT a real forged-token test); rep / Relations → 403 management_only (code + mi1b-api tests; no non-admin login
  used live). Production after: 6 sources, 0 report records, 0 events, 0 stored files, 11,997 rows / $10,802,558.50,
  0 batches, `mi_import_v2` ON, `mi_commission_v2` absent (off). Nothing registered; MI-1c not started.
- **MI-1b ACCEPTED COMPLETE (Angelo, 2026-10-11 09:31 CT)** after his own independent verification (schema, privileges,
  six catalog records, 0 report records / stored files / audit events, financial baseline, code on GitHub main).
- **MI-1c / SB-1 DEVELOPMENT AUTHORIZED (Angelo, 2026-10-11 09:31 CT) — branch only.** Build the September Strongback
  Dealer Intelligence importer per SB-0: (1) use the MI-1b `mfr_sources` register — no second file registry; (2) parse the
  original 17-page September PDF (25 dealer profiles in the table, 22 detailed dealer pages), keeping Strongback's exact
  terms, dates, figures and source provenance; (3) snapshot + observation schema with stable SOURCE-POSITION identities,
  full audit, RULE 19 locked; (4) preview + dealer-match review: 15 automatic, 7 manual review, Wyatt's Pharmacy HELD,
  GF Health + Nebcare unmatched; (5) never create, merge, reassign or alter dealers / rep ownership; (6) manufacturer-
  reported amounts, trends, tiers, contacts and notes stay separate from HCPS-confirmed activity and financial records;
  (7) operator-reviewed preview of all 25 dealers: extraction results, match evidence, unresolved items, differences from
  HCPS; (8) no automatic tasks, opportunities, contacts, campaigns, Zoho changes or pricing discounts; (9) PostgreSQL, API,
  parser, permissions, concurrency, idempotence and regression tests + rollback plan. Preserve concurrent Manufacturer
  Center, Academy and ordering changes. NOT authorized: installing MI-1c SQL in production, registering or publishing the
  September PDF, importing the September order CSV, modifying financial records. `mi_import_v2` stays ON,
  `mi_commission_v2` OFF. STOP after implementation and tests; return the change manifest, tests, expected dealer-match
  table, security evidence and rollout plan.
- **MI-1c BUILT on branch `mi1c-dealer-intel` (2026-10-11, NOT merged, NOT deployed, NO production SQL, September PDF
  not registered).** Migration `supabase/mi1c_dealer_intel.sql` (sha256 4f69367f…, rollback `…_rollback.sql` c2873764…,
  refuses while any MI-1c row exists): tables `mfr_intel_reports` (one per imported dealer_report file),
  `mfr_dealer_snapshots` (one per printed dealer, Strongback's words/figures as printed + the HCPS match proposal),
  `mfr_dealer_observations` (contacts, product lines, told-us notes, contact log, offers — each with its printed position),
  append-only `mfr_intel_events`; writes ONLY through `hcps_mfr_intel_import(p)` (accepted dealer_report, same sha256 as
  the register, same period, no parse errors; idempotent by content hash; advisory lock + source-row lock) and
  `hcps_mfr_intel_match(p)` (a person's decision with a reason and the `match_version` he saw; only match columns change;
  never a TEST dealer). Guard trigger: owner's rights + the function's marker, no delete/truncate. RULE 19: RLS on, no
  policies, anon/authenticated nothing, service_role SELECT only + execute on the two functions. Server reads the stored
  bytes (SHA-256 re-checked) with pdf.js 3.11.174 (legacy build; worker required statically so the bundler includes it;
  `.npmrc omit=optional` keeps canvas out; function zip 11.2 MB). Six Skia private-use glyphs mapped (confirmed with
  Poppler); any other one fails loudly. Parser checks 141/141 on the real PDF. Matcher: exact names/aliases/sales names,
  then distinctive words only when nothing exact; automatic only with one ordinary candidate whose name agrees and whose
  city agrees or sales corroborate; Wyatt's HELD. September result = SB-0: 15 matched, 7 review, 1 held, 2 unmatched.
  Contacts are observations only (never dealer_contacts); the report owner is never a dealer contact; offers stored as
  "unverified manufacturer text". API `mfr-intel-api.js` (management only, actor from the sign-in, preview_hash must equal
  the server's recomputed preview); page `/admin/dealer-intel.html` (HUBS: Sales Data & Analytics → Dealer Intelligence
  Import). Tests: mi1c-intel.pg 57, mi1c-api 21, mi1c-parser 21 (needs the PDF via MI1C_PDF; the PDF is never in git),
  mutants 52/52 (clean control). **Known consequence:** once snapshots exist, MI-1b `hcps_mfr_report_publication` would
  accept a publish — the Report History button stays disabled ("not enabled"); publishing needs its own approval.
  Pre-existing, unrelated: `test/resources-render.test.js` fails on main since documents.json update de939e7 (4 items
  without `models`; admin-managed — not hand-edited).
- **MI-1c CONDITIONALLY ACCEPTED (development) — four corrections required before rollout (Angelo, 2026-10-11 11:12 CT).
  Production installation NOT approved.** Rules (binding from now on):
  (1) **Publication stays OFF at the server AND database level.** An accepted or imported dealer report stays
  unpublished until a separately approved publishing phase. Switch `phase2_flags.mi_intel_publish` (exactly `true` = on;
  missing / non-true / unreadable = off) — NOT turned on by any migration. Database: trigger `mfr_sources_publication_gate`
  (MI-1c migration; security definer) refuses any write that makes a dealer report "published" on every path (MI-1b's
  function, REST, hand SQL as the owner); withdraw is not gated; MI-1b's function body is unchanged; the MI-1c rollback
  drops the trigger. API: `mfr-reports-api` publish → 403 `publication_not_authorized` before the database.
  (2) **A recorded hold is never changed by the standard decision workflow.** Holds live ONLY in `mfr_intel_holds`
  (seeded: Strongback "Wyatt's Pharmacy Inc", RULE 18), keyed by `hcps_mfr_intel_name_key` (JS `holdKey`, same rule —
  catches "Wyatts Pharmacy" etc.). Import: a held name must be stored held (no dealer), and "held" only from a recorded
  hold. `hcps_mfr_intel_match` refuses EVERY decision on a held name (`mi1c_held_locked`); the API refuses it first (423).
  Holds can't be updated/deleted/truncated (owner included); a release is a future owner-authorized design. Manual
  "held" decisions on other rows (the seven-dealer review workflow) are unchanged.
  (3) **Manufacturer-vs-HCPS reconciliation uses the sales-report lane only** (`source='sales_report'`); commission-lane
  rows (`hcps_ms_is_commission_lane`) and other sources are listed apart, never added, with a count of rows that look
  like the same transaction (MI-1a cross-lane test). Matcher name evidence = sales-report lane too. Read-only.
  (4) **The manufacturer's prepared date must equal the register's** — both stated and equal, or both not stated. A
  mismatch is shown first in Preview and refuses the import (API 422 and SQL `mi1c_prepared_date_mismatch`); never an
  upload/received date, never invented. The reader: "prepared" printed but unreadable = error; not printed = not stated.
  Real-file tests FAIL (not skip) when the September PDF is absent unless `MI1C_ALLOW_NO_PDF=1`.
  **Corrections BUILT (2026-10-11, branch `mi1c-dealer-intel`; NOT merged / deployed / run):** migration rev 2 sha256
  550c64f8…, rollback 345512fd…; 9 install checks; outside probe 22 checks (5 tables + 2 RPCs). Tests: mi1c-intel.pg 76,
  mi1c-api 29, mi1c-parser 26 (real PDF used, nothing skipped), MI-1c mutants 79/79, MI-1b api 28 + mutants 44/44,
  mi1b-register.pg 46; full regression after merging main 5d0c0fa (Academy C1, mobile masthead): 81/82 suites pass
  (only the pre-existing resources-render failure).
- **MI-1c CONTROLLED PRODUCTION ROLLOUT APPROVED (Angelo, 2026-10-11 12:04 CT)** — migration sha256 550c64f8…ce7,
  rollback 345512fd…7a4, subject to final reconciliation + preflight. Order: (1) bring main in, SQL byte-identical, rerun
  MI-1c / MI-1b / MI-1a / commission / affected MC tests + the real PDF (stop on a change or unexplained failure);
  (2) preflight: financial baseline, MI-1b schema, six catalog sources, 0 dealer reports, 0 import batches, `mi_import_v2`
  ON / `mi_commission_v2` OFF, `mi_intel_publish` absent/off, nothing published, recent backup; (3) Angelo runs the exact
  migration in the SQL editor — all 9 checks ok, full baseline compared after; (4) 22-check public-key probe all BLOCKED
  + read-only metadata checks of the publication gate and Wyatt's hold (never publish a real report to test); (5) merge +
  deploy, Netlify Published at the expected commit, Dealer Intelligence Import opens for President/Admin, reps/Relations
  refused, no report ready for import. STOP. NOT authorized: registering/accepting the September PDF, the 25-dealer
  import, match decisions, publishing, the September CSV, the publish switch, rep changes, AirAvant, financial records.
  Read-only rollout queries: `supabase/mi1c_rollout_baseline.sql` (before/after) and `supabase/mi1c_rollout_postcheck.sql`
  (expected code fingerprint 618a4139… LF / 887809bd… CRLF). Reconciled with main c59a3ad (Release A content freeze;
  no overlap) — SQL byte-identical; regression 84/85 (only resources-render).
  **MI-1c migration RUN by Angelo 2026-10-11 ~12:45 CT (verified):** editor contents checked = sha256 550c64f8… (LF,
  39,315 bytes) before his Run; all 9 install checks ok = true. Post-install baseline = the preflight on 22/24 rows
  (ledger 11,997 / $10,802,558.50 / $493,077.06, D7 dde7a2ce…, full-row 83fa3b5b…, Strongback 143 / $43,021.50 / $3,871.94,
  0 batches / 0 superseded / 7 quarantined, catalog sources acf6e62b…, 0 report records / 0 published / 0 events, flags
  3f965e20… with mi_import_v2 ON / mi_commission_v2 + mi_intel_publish absent, dealers 3e27e8ce…, aliases 3da52cea…,
  dealer_manufacturers 597811b5…, 770 / 7 / 429, 9 / 15 / 14, MI-1b functions 82cd50d8…, MI-1a 10 / 162f107a…, grants
  3072 / 47b8b8e5…, policies 29 / 5fc16d5b…, bucket private 0 files); the 2 changed rows are the expected MI-1c additions
  (mfr_sources triggers + publication gate; 5 tables + 6 functions). Metadata postcheck: code 6 / 887809bd… (the CRLF
  form, precomputed), gate trigger enabled type 23, gate SECURITY DEFINER search_path=public, pg_temp, callable by
  nobody (anon/authenticated/service_role false), switch absent, 0 published, the one Wyatt's hold (key WYATTS PHARMACY,
  3 spellings → same key), hold guards enabled, match refuses held names, import enforces holds + prepared date, 0 MI-1c
  rows, anon/authenticated 0 grants, service_role SELECT, RLS 5/5, 0 policies. Outside public-key probe
  (`scripts/mi1c_public_probe_browser.js`, run by Angelo 12:58 CT, key verified first): ALL 22 BLOCKED (401). Before the
  merge, main 0751266 (MC content-freeze SQL only) brought in; MI-1c SQL byte-identical; MI-1c 76/29/26 (real PDF),
  MI-1b 46/28, MI-1a 28/16, commission 42/11, MC content-freeze 19/18/3, guard 17, append 6, flow 13, gates 12, freeze 17.
  **MI-1c DEPLOYED 2026-10-11 ~13:00 CT** (branch merged → main 86b4958, Netlify "Production: main@86b4958 Published").
  Live: Dealer Intelligence Import opens for the President under Sales Data & Analytics and shows "No dealer-intelligence
  report is registered yet"; API `sources` (signed in) → 200, no-store, 0 sources, reader strongback-mobility; no token /
  forged token / junk token → 401 sign_in_required (XMLHttpRequest, not the wrapped fetch); rep / Relations → 403
  management_only (code ADMIN = president/admin/owner + mi1c-api tests; no non-admin login used live); Report History
  API list → 200. Nothing registered, imported, matched or published; `mi_intel_publish` absent; `mi_import_v2` ON,
  `mi_commission_v2` off. Awaiting Angelo's MI-1c installation acceptance; the September PDF registration and the
  25-dealer import each need their own approval.
- **Scope after MI-1a acceptance:** MI-1b report history → MI-1c Strongback September dealer-intelligence import
  into Dealer 360 → MI-2 (Dealer 360, opportunities, task suggestions reps approve, campaign targeting; no auto
  tasks/deals/sends/promotions; opt-outs, exclusions, caps kept) → MI-3 Outlook report discovery.

## 19. Database objects are NOT private by default — review every new view and table (RULE, agreed 2026-10-10)
- **Require every new database view and table to be reviewed for public grants, RLS behaviour, and access through
  exposed API schemas. Do not assume any new database object is private by default.** In this Supabase project new
  objects in `public` inherit default grants to `anon` and `authenticated`, so a new table or view is reachable with
  the public key unless the migration revokes it.
- Every migration that creates a table or view states, in the file: RLS on or off and why; the policies; an explicit
  `revoke all ... from public, anon, authenticated` unless public access is intended and written down; and, for a
  view, `security_invoker = true` (a view without it runs with its owner's rights and bypasses RLS).
- After running it, check from outside with the public key (expect 401 / `42501` for anything private) and record the
  result. Reference: the 10 Oct 2026 fix to `v_commission_by_rep`, `v_sales_by_account`, `v_dealer_activity`,
  `hcps_dealer_rep`, `product_content_review_queue` and the `order_items` insert policy.
- **A rollback is not a reaction to suspicion.** Do not run a security rollback merely because a problem is
  suspected; investigate first. That rollback would reopen the exposure it closed.

## 20. HCPS Training & Certification Academy (RULE, agreed 2026-10-10)
The project specification and decision log are the Claude Docs "HCPS Academy — Project Specification & Phase A0
Findings" (decisions 1–46, incl. "Golden Technologies confirmations", 10 Oct 2026). Summary of what binds code in this repo:
- **Place:** courses live at `/academy/`; Dealer Services carries a promo section; the Dealer Hub keeps live
  training bookings and links to the academy; the Academy Command Center is a Connect 360 tool added to `HUBS`
  (rule 9). No separate admin site and no duplicate training system or product database.
- **Accounts:** training-only learners never receive ordering or pricing access. Dealer Training Managers manage
  academy access for their own dealership only; HCPS alone grants the Training Manager role. Partner 360 hands
  off with a single-use, short-lived, server-validated code — never a reusable credential in a URL.
- **Certificates:** HCPS-issued certificates default to 12 months (configurable). Golden-issued credentials have no
  assumed expiry, are tracked separately (exam submitted is not certified), and are never presented as HCPS
  credentials — and the HCPS Sales Certification is never presented as a Golden credential.
- **Product facts:** one verified product-facts layer (proposed `product_facts`), each fact with source and date.
  Never copy the Golden ordering catalog. Never mark a model discontinued because a page or listing is missing.
  Automatic monitoring and publishing are OFF at launch; lesson wording, safety claims, exam answers and
  certification requirements always need admin approval; published course versions, attempts and certificates are
  never rewritten.
- **Content:** one standard interactive lesson format for every manufacturer. Link to official Golden material;
  copy or rehost it only with Golden's permission. Health or clinical statements appear only as the manufacturer's
  own attributed words. Zero broken images: use a labelled placeholder and ask for the image.
- **Golden confirmations (10 Oct 2026, permanent):** approved Golden education materials, technical videos, logos,
  photography and brochures may be used (brand guidelines apply; files hosted by HCPS with their rights recorded);
  learners may be sent to Golden's exams. Golden gives NO exam-verification feed, NO product data feed and does NOT
  endorse the HCPS sales certification. A Golden credential is "verified" only with a Golden certificate or another
  approved Golden confirmation — never from an exam-link click or a learner's own report (enforced by
  `academy_external_certs` checks). Discontinued: PR515 (→ PR519), PR763 (→ PR750), PR735, PR545, PR504, PR632 —
  archive only. Zones = motors. Product checks use Golden's website, catalogs, sell sheets, brochures, manuals,
  warranty documents and approved videos; spec/explanation/exam/certification changes need admin approval.
- **Phase A1 database foundation LIVE (10 Oct 2026, approved by Angelo).** Migration `supabase/academy_a1_foundation.sql`
  (sha256 a3d6b1f9…cacf4) run in the SQL editor: 18 tables, 5 rule functions, 7 triggers, private bucket
  `academy-private`, app_settings `academy` (monitoring/auto-update off). Verified: acceptance tests 26/26 + no-leftover
  check (`academy_a1_acceptance_tests.sql`, sha256 587a5712…), public-key probe 22/22 blocked
  (`scripts/academy_a1_public_probe_browser.js`, key checked on a public table first), regression fingerprints identical
  to the preflight (grants 2755, policies 29, 105 tables; only app_settings +1). Rollback
  `academy_a1_foundation_rollback.sql` (sha256 ee37021c…) refuses while learner/attempt/certificate rows or bucket files
  exist. Production storage.buckets carries Supabase triggers: a new bucket must leave the lifecycle columns NULL, and a
  direct bucket delete needs `set local storage.allow_delete_query = 'true'`. **The Supabase SQL editor shows only the
  LAST statement's result** — a test script must end with its results query (undo test data in a sub-transaction).
- **Phase A2 (approved 10 Oct 2026 18:45; one unit at a time, each with its own approval).** Order: A2A security → A2C
  part C1 → A2D → A2F → A2C part C2 → A2B → A2E. Everything ships behind `phase2_flags` switches that are OFF
  (`academy_admin`, `academy_learner`, `academy_handoff`, `academy_invites`, `academy_external_uploads`,
  `academy_certificates`, `academy_dealer360`), turned on only by a reviewed one-line SQL of the form
  `value = value || '{"academy_x": true}'` that Angelo runs. All Academy server code goes through `_academy.js`
  (who is calling, dealership scope, strict reads, audit, switches, input/output rules). Training Manager scope = the
  dealer + its direct branches; a branch Training Manager sees the branch only (D3). Reps and Relations never see
  numeric scores. HCPS staff emails are never learners in A2 (D6).
- **Security-sensitive Academy changes are atomic with their audit row (RULE, Angelo 10 Oct 2026).** Training Manager
  grant/revoke, Golden credential verify/reject, HCPS certificate issue/revoke, publishing/retiring a course version,
  exam submission/grading/result correction, and product-fact record/supersede/withdraw run ONLY as the database
  functions `academy_op_*` (migration `supabase/academy_a2a_m1_audited_ops.sql`): one transaction, the change and its
  `academy_events` row together or neither. Guard triggers refuse the same changes made any other way. Calls go through
  `_academy.js op()`. Exams are graded inside the database; answer keys never leave it; pass/fail uses the exact
  fraction. A disputed or unsafe fact is withdrawn with NO replacement value (`academy_op_withdraw_fact`: an
  `awaiting_manufacturer` row with value null), never left published (D2). A TEST course (slug `test-…`) never issues a
  certificate. The A1 acceptance tests run before and after M1 (setup goes through the operations once M1 exists).
- **M1 rev 2 — final security refinements (Angelo, 10 Oct 2026 22:29; A–E).** (A) An exam correction takes a SCORE only
  (0–100) and a reason; pass/fail always follows the version's pass mark — there is no override that records a pass the
  score does not support (an override would need its own approved design). (B) A certified pass is never corrected to a
  fail while its certificate is valid: the correction is refused until the certificate is revoked as its own audited
  decision (recommended over automatic revocation, so revoking a credential is always a deliberate, separately recorded
  act). (C) Attempts are created only by `academy_op_start_attempt` (the database draws exactly `exam_questions` distinct
  active exam questions of the ENROLLED, PUBLISHED version; one open attempt at a time); submission and issuance re-check
  the set (same version, active exam questions, count, no duplicates, enrollment not withdrawn, version published or
  since retired), and the submitting learner must be the attempt's learner. (D) The 11 operations are SECURITY DEFINER
  with a pinned search path, executable by the server role only; the 7 helpers and the guard by the owner only. The guard
  accepts a marked change only with the owner's rights, so the server role cannot set `academy.op` by hand. Staff actors
  must be `staff:<email>` of an ACTIVE president/admin/owner in staff_users (approvers of approval-required facts too);
  learner actors exactly `learner:<id>` of the record's learner, active, not HCPS staff. (E) Issuance needs
  `phase2_flags.academy_certificates` exactly true (the database refuses otherwise, as well as the application layer), an
  issuer of `system:grader` or an administrator, a submitted+graded+passed attempt on a valid set, an active non-staff
  learner, a non-withdrawn enrollment, a non-TEST HCPS certification course, and no earlier certificate for the
  enrollment. Note: enrollments are unique per learner+version, so after a revocation re-certification on the same
  version needs a decision (new version or a reviewed schema change) — not built. Tests: `test/academy/m1_hardening.sql`
  (28; 19 of them fail on the original M1), the acceptance file (42 + check 43, which also proves phase2_flags unchanged).
- **M1 rev 2 APPROVED for production by Angelo (10 Oct 2026 22:49)** — exact sha256 7253ff80…a864 (supersedes 85e87157…);
  Angelo runs it by hand in the SQL editor; Claude never runs it. Expected installed-code fingerprint
  130e45fa36f768e032a89da43b645f8a (`supabase/academy_a2a_m1_postcheck.sql`) — or e70543ba23d96ca7c5aec8eeff0ea341 when the
  file is pasted into the SQL editor from Windows (CRLF line endings; same code otherwise, reproduced exactly locally). Lesson:
  a code fingerprint taken from prosrc must be computed for BOTH line-ending forms before the run. Post-migration: 19 functions, 6 guard
  triggers, RLS 18/18, switches OFF, acceptance 43/43, A1 27/27, no test rows, probe all BLOCKED, outside fingerprints =
  the 21:45 baseline. A SKIP in the editor is not a pass: it needs the alternative check before M1 is declared complete.
  A failed test = stop and investigate; never an automatic rollback. PR #4 stays draft until verified and approved.
- **M1 rev 2 RUN and VERIFIED in production (Angelo, 10 Oct 2026 ~23:00 CT).** Preflight after = the 21:45 baseline on every
  fingerprint (outside grants 1c268eb2…/2811, policies 219ac18e…/29, columns d039b75f…/109; Academy 7af6d10e…/252,
  ca214093…/179, RLS 18/18, 0 policies; key row counts identical); 19 functions, 6 guard triggers; installed-code
  fingerprint e70543ba… (the approved file pasted with Windows line endings — reproduced exactly locally); operations
  server-only 11, helpers callable by the server 0; M1 acceptance 43/43 (no SKIP — the server-role checks 34/39 ran);
  A1 compatibility 27/27; Academy rows 0 and switches {} after the tests; public-key probe ALL 19 BLOCKED (401).
  **Fingerprint ACCEPTED by Angelo (10 Oct 2026 23:12):** installed e70543ba23d96ca7c5aec8eeff0ea341 (expected
  130e45fa36f768e032a89da43b645f8a with Unix line endings); cause = the editor paste saved every line ending as \r\n;
  evidence = the approved file installed locally with CRLF reproduces e70543ba exactly and passes 28 + 43 + 27 + 11 tests,
  and production passed 43/43, 27/27 and 19/19 BLOCKED. Never roll back or reinstall M1 just to change the fingerprint.
  **A2A (code + M1) COMPLETE — accepted by Angelo 10 Oct 2026 23:12.** All Academy switches OFF; certificates stay off until separately authorized. PR #4
  (M1 rev 2 files) stays DRAFT until Angelo approves its merge. A2C and later units not started.
- **Exam retake policy (approved; build in A2E, NOT yet):** one open attempt (already enforced by start_attempt), a
  one-hour cooldown between attempts, at most three attempts per day, unlimited lifetime retakes — enforced on the
  server/database and tested under SIMULTANEOUS requests before the learner pilot. HCPS certificate issuance stays
  disabled (`academy_certificates` off) until Angelo authorizes it separately.
- **Academy sign-in (security review 10 Oct 2026).** Learners get the Academy's OWN session — an HMAC-signed 8-hour value
  in an HttpOnly, Secure, SameSite=Strict `__Host-hcps_academy` cookie (`_academy_session.js`, secret
  `ACADEMY_SESSION_SECRET`, Production-scoped, 32+ random bytes, set by Angelo). It is accepted only by `academy-api`;
  ordering, pricing, Partner 360 and Connect 360 never read it. **Never give the Academy a Supabase session** (the "View
  as" magic-link method was reviewed and rejected: the token would also order and price on Partner 360). GET may only
  read (named read actions); every change is POST with the `x-academy-request` header and an allowed Origin. Academy
  pages live only on www.homecareproviderservices.org — the primary domain; Netlify sends the bare domain to www, and netlify.toml sends homecareproviderservices.netlify.app/academy/* there (301). Never add a www→bare-domain rule: it loops, under the strict `/academy/*` security
  headers in netlify.toml: no inline script and no third-party scripts on Academy pages.
- **A2A code MERGED and LIVE (10 Oct 2026 ~22:00 CT, PR #3 → main 16805ed, approved by Angelo 21:47).** Production
  verified: academy-handoff status `{enabled:false}`; admin API 401 with no token / public key / forged token; learner
  API and handoff mint 403 `flag_off`; no-store on every response; `/academy/*` 404 with DENY / noindex / CSP;
  netlify.app/academy and the bare domain land on www/academy (no loop); site pages and Connect 360 unchanged. All seven
  switches OFF. **A2A ACCEPTED by Angelo (10 Oct 2026 22:29)**, subject to the remaining authentication tests (the
  request-body-actor test and the signed-in role/scope tests) before any learner or staff feature is switched on. M1 is NOT run — the original (sha256 85e87157…22a01) was held by Angelo for refinements A–E; rev 2 awaits his
  approval; its baseline is the 21:45 preflight (outside grants 1c268eb2…/2811, policies 219ac18e…/29,
  columns d039b75f…/109; Academy grants 7af6d10e…/252, columns ca214093…/179, RLS 18/18, 0 policies).
- **D14 — Academy-only email sign-in codes (approved by Angelo 10 Oct 2026 for A2B DESIGN only; not implemented).**
  Training-only employees sign in with Academy-only email codes. Requirements: training-only credentials never
  authenticate to Partner 360 ordering or pricing; existing dealer accounts keep their ordering permissions; Academy
  sessions are accepted only by Academy APIs; codes are single-use, short-lived and rate-limited; revocation and
  deactivation take effect at once; an existing dealer uses both systems without a duplicate identity; the sign-in and
  account lifecycle are secured and audited. No D14 migration or code until A2B is separately approved.
- **Operations take the acting person from the verified sign-in, never from the request (A2A merge gate, 10 Oct 2026).**
  The database checks only that an actor is named; the trust boundary is the server role. Every `op()` call passes
  `actorLabel()` of the actor `staffActor` / `learnerActor` returned; the A2C unit adds a test proving a request-body
  actor is ignored.
- **A2C Part C1 — Academy Command Center (Angelo, 11 Oct 2026 08:27: design ACCEPTED; PR #5 merged 11 Oct 2026, main 1a942ce).**
  `/admin/academy.html` (Connect 360 → Sales & Marketing; admins only — reps/Relations keep their menus unchanged) +
  `academy-admin-api.js`. Six tabs are fixed: Overview, Courses, Learners & Dealerships, Product Facts, Certifications,
  Activity. HCPS-issued and manufacturer-issued credentials are always shown apart. President-only: publish/retire a
  version, approval-required facts (the President is the recorded approver), edits to a course learners have seen.
  Role assignments and credential verification go only through M1 operations. Ordinary content writes (courses,
  draft versions, modules, lessons) go only through the M2 content operations (next bullet); as merged in PR #5 they
  were written audit-first (`_ref` / `<action>_failed`), which the records check (`audit_check`) still understands.
  The switch never went on, so production has no audit-first rows.
  **Course record status** (`academy_courses.status`) is not changed in C1; the UI shows "Training available" from the
  versions so a course with a published version never looks unpublished; the permanent rule is a C2 decision (proposal
  in the doc). **TEST data:** TEST dealers (`is_test`), pilot learners (all active memberships at TEST dealers) and
  TEST-course (`test-…`) enrollments/credentials are excluded from real Academy figures and shown apart; every future
  Academy metric uses the same rule; a TEST course never issues a genuine certificate (M1). Do not begin A2D until
  Angelo approves it separately. All Academy switches stay OFF.
- **PR #5 and PR #6 MERGED and VERIFIED in production (Angelo's approval 11 Oct 2026 11:22).** PR #5 (Command Center) →
  main 1a942ce: Netlify Published; with `academy_admin` OFF the page says switched off, signed-in actions get 403
  `flag_off`, no/forged token 401; site, Connect 360, crm-api, mfr-reports-api unchanged. PR #6 (Connect 360 mobile
  masthead, rule 10) → main 2eceda2: 49 admin pages × 5 roles × 4 widths clean; desktop/tablet headers pixel-identical;
  phone Lock and account controls on screen. All seven switches OFF.
- **Ordinary Academy content is atomic with its audit row (RULE, Angelo 11 Oct 2026 — M2 design approved).** Creating
  and editing courses, draft versions, modules and lessons, and moving a version draft ↔ in review, run ONLY as the
  database functions `academy_content_op_*` (migration `supabase/academy_a2c_m2_content_ops.sql`; prefix chosen so
  M1's `academy\_op\_%` fingerprint and rollback are untouched): one transaction — the change and its `academy_events`
  row together or neither; each operation re-reads its row under the version lock and must change exactly one row
  before it records. Guard trigger `academy_content_guard` on the four content tables refuses every other insert, edit
  or delete (also the owner without an operation, and the server role even with a forged `academy.op`). The database
  repeats every server check: active administrator named `staff:<email>` (from the verified sign-in, `contentOp()` in
  `_academy.js`), the President for a course learners have seen, allowed fields only, drafts only (55000 → 409
  `locked`). Published and retired content stays frozen (A1 triggers + M1 + M2). Not installed = 503, never a plain
  write. Test setups that insert content directly set `academy.op` as the owner around those inserts (A1/M1 acceptance,
  m1_hardening, atomicity — their sha256 changed for that reason only). **M2 is NOT run in production: Angelo approves
  the exact file and runs it himself; the Command Center is not switched on until M2 is installed, tested and
  separately approved for staff-only activation.** Expected fingerprint f24e4f88… (Unix) / 794f3c3e… (CRLF paste).
  **Pre-M2 production baseline ACCEPTED by Angelo (11 Oct 2026 13:56 CT):** ready_for_m2 true; M1 19 / 6 / e70543ba…;
  M2 absent; Academy content + audit rows 0; 1 active President; switches {} (all OFF); Academy grants 7af6d10e…/252,
  columns ca214093…/179, 0 policies, RLS 18/18; outside grants 336bae11…/2860, columns add1e9f7…/115 tables, policies
  219ac18e…/29, other functions 5ac72858…/79 (the +6 tables / +49 grants since M1 = MI-1b + MI-1c, authorized).
  Production is Postgres 17.6: the M2 suite passes on a local 17.6 (pg-safeupdate is unavailable there; covered on 16
  plus the static WHERE check). M2 files change no database setting.
  **M2 RUN and VERIFIED in production (Angelo, 11 Oct 2026 ~14:23–15:27 CT):**
  - Angelo pasted the approved file (sha256 b4e28fd0…) himself.
  - **Postcheck:** 15 functions, 11 server-only operations, 0 / 0 callable helpers and public-key functions, both guards on
    the 4 tables, fingerprint 794f3c3e… (CRLF, as precomputed); M1 19 / 6 / e70543ba… unchanged.
  - **Tests:** M2 acceptance 21/21, A1 27/27, M1 43/43 (34 and 39 ran); second postcheck 0 rows.
  - **Preflight after:** every fingerprint equals the accepted baseline. Only row counts product_content 103 /
    history 2466 / sources 59 moved: Angelo's 7 Bemis Auto-Enrich drafts at 14:30 CT, attributed by query. The post-M2
    baseline uses those counts.
  - **Public-key probe:** ALL 26 BLOCKED. The first run's one "OPEN" was a probe bug: PATCH of a column the table lacks
    gives PGRST204 before any permission check; fixed (sha256 71f42e7f…). A probe write must name a real column.
  - Switches all OFF. PR #7 still DRAFT; merging it and activating the Command Center each need Angelo's separate approval.
  TRUNCATE is guarded too (`academy_content_guard_truncate`). Foreign-key cascades run as the table owner and so pass
  the guard when a marker is set: any future cascade INTO the four content tables must be reviewed against it.
- **Course publication rules (Angelo, 11 Oct 2026 — C2 design only, NOT implemented; `docs/academy/C2_COURSE_PUBLICATION_DESIGN.md`).**
  Show clearly whether training is published and available. Only the President publishes or retires a course. Published
  versions are immutable. Publishing a replacement version retires the previous one and publishes the new one in ONE
  transaction. Manufacturer-hosted training gets its own controlled (President-only, audited) publication. Published
  history and certification records are preserved. TEST courses never issue real certificates; every dashboard and
  report keeps TEST apart. Do not begin A2D, A2F, A2B, A2E or C2 without separate approval; never enable learner access,
  issue certificates, publish real courses, activate payments or modify Golden Ordering without it.
- **Never:** modify the original Thinkific course; change Golden ordering data from academy findings (discrepancies
  go to the Golden product data issue tracker and wait for approval); run academy migrations, deploy academy
  features or start a phase without explicit approval.

## Per-page checklist (run before calling a page done)
- [ ] Depth-hero present; tilt works; **no `data-reveal` on the tilt image**.
- [ ] Hero headline is short + single-row on desktop, wraps on mobile.
- [ ] Card icons are big-on-top (where the page uses icon cards).
- [ ] Scroll reveals come from the shared engine (no per-page reveal JS/CSS).
- [ ] Content data-driven where applicable; contact info from site.json.
- [ ] Images optimized (JPEG ~1600px hero, icons resized).
- [ ] `npm run build` clean before deploy.
- [ ] **Mobile (RULE 10):** tested at desktop / tablet / iPhone / Android — no horizontal scroll,
      nav + dropdowns work by touch, cards stack, forms are 16px & full-width, tables stack/scroll,
      any interactive tool is operable by touch. Run `node test/mobile-qa.js` → all green.
- [ ] **New admin tool** added to `HUBS` in `admin-chrome.js` (→ auto-appears on the dashboard,
      category page & sub-nav); guide card in `hub-guide.js`; audience/permissions verified.

## Open items / not-yet-applied (keep current)
- `test/phase2-timeline.test.js` (2 tests) fails late in the evening Chicago time on main and every branch alike: its
  fixtures are "now minus N hours" and cross a local-day boundary after ~21:00 CT. A test-clock fix, not an app bug;
  not changed during A2A (found 10 Oct 2026 at the A2A merge gate).
- Big-icon-on-top NOT yet retrofitted to: `manufacturers/index.njk` (pillars),
  `become-a-manufacturer-partner.njk` (capability icons). Pending user go-ahead.
- Some service icons sit on a faint white square (not transparent) — optional cleanup.
