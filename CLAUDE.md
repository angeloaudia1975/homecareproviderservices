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

## Per-page checklist (run before calling a page done)
- [ ] Depth-hero present; tilt works; **no `data-reveal` on the tilt image**.
- [ ] Hero headline is short + single-row on desktop, wraps on mobile.
- [ ] Card icons are big-on-top (where the page uses icon cards).
- [ ] Scroll reveals come from the shared engine (no per-page reveal JS/CSS).
- [ ] Content data-driven where applicable; contact info from site.json.
- [ ] Images optimized (JPEG ~1600px hero, icons resized).
- [ ] `npm run build` clean before deploy.

## Open items / not-yet-applied (keep current)
- Big-icon-on-top NOT yet retrofitted to: `manufacturers/index.njk` (pillars),
  `become-a-manufacturer-partner.njk` (capability icons). Pending user go-ahead.
- Some service icons sit on a faint white square (not transparent) — optional cleanup.
