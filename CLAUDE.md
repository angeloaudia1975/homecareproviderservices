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
