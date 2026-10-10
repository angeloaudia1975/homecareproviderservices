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
- **Coverage & commission reporting key off commission DATA, not the importer**: a manufacturer-month
  counts as a commission report received when it has `source='commission'` OR any row with a non-zero
  `commission` (commissions-api `config.received`). Never gate commission coverage/reporting on `source`
  alone.
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
- **Tests:** `test/mi1a-identity.pg.test.js` (runs the committed SQL in Postgres, bigint + uuid ids),
  `test/mi1a-compat.test.js` + `.mutants.js` (other manufacturers unaffected; switches; alias guard).
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
Findings" (decisions 1–21). Summary of what binds code in this repo:
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
- Big-icon-on-top NOT yet retrofitted to: `manufacturers/index.njk` (pillars),
  `become-a-manufacturer-partner.njk` (capability icons). Pending user go-ahead.
- Some service icons sit on a faint white square (not transparent) — optional cleanup.
