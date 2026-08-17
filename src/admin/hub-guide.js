/* HCPS Admin — feature-guide content for the category landing pages (hub.html).
 * Keyed by the tool's label (matches admin-chrome.js HUBS). Each entry is a plain-language
 * product overview so an administrator can understand a tool's full scope before opening it.
 * Fields (all optional; hub.html renders only what's present):
 *   tagline      one strong sentence under the title
 *   what         "What it does" paragraph
 *   features[]   Main features
 *   data         What data it uses
 *   actions[]    What you can do
 *   reports[]    Reports & analytics available
 *   connects[]   How it connects to the rest of the platform
 *   problems     What problems it solves / why use it
 *   workflow     How it fits the sales/admin workflow
 *   intelligence Automation, AI, reporting or intelligence built in
 */
window.HUB_GUIDE = {

  /* ---------------- SALES DATA & ANALYTICS ---------------- */
  "Command Center 360": {
    tagline: "Your interactive business-intelligence cockpit — every sales number on the platform, drillable from the big picture down to a single order.",
    what: "Command Center 360 turns all of your imported sales, commission, and engagement data into one live, clickable model of the business. Instead of static reports you start at a summary and drill straight through Manufacturer → State → Company → Dealer → Product → Order, with every metric tracing back to the exact records that produced it.",
    features: [
      "Manufacturer sales trends over time, with rising/declining momentum",
      "State-level and territory revenue rollups",
      "Company and dealer rankings — top and bottom performers, growers and decliners",
      "Product performance and line-mix per dealer",
      "Reorder-cadence and momentum indicators",
      "Six-month forecasting from cadence plus weighted pipeline",
      "Dealer engagement and health overlay",
      "Campaign performance readback",
      "Retired lines kept in history but dropped from active run-rate"
    ],
    data: "Reads the aggregated sales cube built from monthly_sales (orders, quantities, amounts, commissions), the canonical dealer master with its alias/merge layer, live rep assignments from the directory, manufacturer catalog data, and dealer engagement signals.",
    actions: [
      "Filter by period, manufacturer line, rep, state, or company",
      "Click any metric to drill into the underlying records",
      "Compare year-over-year and period-over-period",
      "Isolate a single rep's book or one manufacturer line",
      "Print or export any view"
    ],
    reports: ["Manufacturer performance", "State & territory revenue", "Company / dealer leaderboards", "Product-level detail", "Six-month forecast", "Momentum & at-risk lists"],
    connects: [
      "Shares the same canonical dealer records as Dealer 360 and the Dealer Manager",
      "Rep assignments come from the directory that also scopes the Sales Rep Portal",
      "Commission figures come from Commission Import",
      "Engagement/health feeds Who to Call and Today's Opportunities",
      "Open deals from Pipeline feed the forecast"
    ],
    problems: "Answers “what is actually happening in the business” without exporting to spreadsheets — where growth is coming from, which accounts are slipping, which lines are trending, and what next quarter looks like.",
    workflow: "Start here for the weekly review or before a territory trip: read the summary, drill into a rep or state, then jump straight into the dealers that need attention.",
    intelligence: "Automatic momentum and trend detection, cadence-based forecasting, and rep-scoped views — a rep sees only their own book while the president sees everything."
  },
  "Rep Performance & Goals": {
    tagline: "Every rep's scorecard — sales versus target, year-over-year, book health, and a live leaderboard.",
    what: "Turns the sales cube into per-rep performance: how each rep is tracking against goal, how their book is trending year over year, which of their accounts are growing or slipping, and where they rank against the team.",
    features: ["Sales vs. target with attainment %", "Year-over-year comparison", "Book health mix (active / at-risk / dormant)", "Team leaderboard", "Per-rep account roster", "Goal setting per rep"],
    data: "monthly_sales aggregated by the live rep assignment (dealer_directory), rep goals/targets, and dealer engagement.",
    actions: ["Set and adjust rep goals", "View any rep's book (president) or your own (rep)", "Drill into a rep's dealers", "Compare periods and years"],
    reports: ["Attainment vs. goal", "Year-over-year growth", "Leaderboard", "Book-health breakdown", "Rep account roster"],
    connects: ["Rep assignments come from the same directory that scopes the whole portal", "Aligns with Command Center 360 and Who to Call", "Earnings context comes from Commission Import"],
    problems: "Answers “how is each rep doing and who needs coaching” at a glance, with the numbers to back the conversation.",
    workflow: "Weekly 1:1s and quarterly reviews — and spotting a rep whose book is slipping before it shows up in revenue.",
    intelligence: "Rep-scoped automatically: a rep sees only their own numbers; leadership sees the full team."
  },
  "My Commissions": {
    tagline: "Your own commissions and sales — by month, manufacturer line, and dealer.",
    what: "Your personal earnings view. It totals the commissions and sales attributed to your assigned accounts, then breaks them down by month, by manufacturer line, and by dealer so you can see exactly where your income comes from and which accounts drive it.",
    features: ["Commission YTD and all-time", "Sales YTD and effective commission rate", "Commission by month (last 12)", "Commission by manufacturer line", "Top dealers by commission"],
    data: "The same sales cube as the rest of the portal, filtered to the accounts assigned to you in the directory — nobody else's numbers.",
    actions: ["Review your monthly commission trend", "See which lines and dealers pay you most", "Cross-check a figure against Rep Performance"],
    reports: ["Commission by month", "Commission by line", "Top dealers by commission"],
    connects: ["Scoped by the same rep assignment as every other tool", "Underlying sales detail lives in Rep Performance and Command Center 360"],
    problems: "Answers “what am I earning and from where” without waiting on a report — and flags if an account you own isn't showing up (a sign your assignment needs fixing).",
    workflow: "Check it after each commission import, and before a territory review, to know your best accounts and lines.",
    intelligence: "Figures reflect only your assigned accounts; if something's missing, confirm your rep name is assigned to that dealer in the directory."
  },
  "Rep Usage & Adoption": {
    tagline: "President's view of how each rep is actually using the platform — adoption, not just logins.",
    what: "Shows, per rep, when they last signed in, how many days they were active, real active time (counted only while the app is in front of them), which tools and dealer accounts they opened, and the meaningful work they logged — touches, notes, tasks completed, routes, and opportunities — rolled into one engagement score.",
    features: ["Last login, active days, and real active time", "Tools used and dealer accounts opened", "Touches, notes, tasks, routes & opportunities per rep", "Engagement score that rewards work over minutes", "A 'logged in, no activity' flag", "Per-rep activity timeline drill-down"],
    data: "Login/active time and tool/dealer views from staff_sessions + rep_activity (usage capture), combined with the rep-attributed CRM, visit, route and pipeline records already on file.",
    actions: ["Switch the window (7 / 30 / 90 days)", "Click a rep to see their full activity timeline", "Spot reps who log in but don't work the tools", "Confirm the platform is part of the daily routine"],
    reports: ["Per-rep adoption table", "Engagement leaderboard", "Idle-but-logged-in flags", "Individual activity timeline"],
    connects: ["Reads the same rep records that power Dealer 360, Territory Map, and Tasks", "Complements Rep Performance & Goals (sales outcomes) with adoption (behavior)"],
    problems: "Answers 'are my reps actually using this, and using it well' with evidence — so training and coaching target the right people.",
    workflow: "Check weekly to confirm adoption, catch a rep who's drifted off the platform, and reward the ones working it hardest.",
    intelligence: "President-only. Active time counts foreground use, so leaving the portal open doesn't inflate the numbers."
  },
  "Pipeline & Forecast": {
    tagline: "Open deals plus a data-driven six-month revenue forecast.",
    what: "Combines your open opportunities (weighted by stage) with reorder-cadence projections to forecast the next six months of revenue — so you can see what's committed, what's likely, and where the gaps are.",
    features: ["Open-deal pipeline by stage", "Weighted pipeline value", "Six-month forecast from cadence plus pipeline", "Per-rep and per-line breakdowns", "Gap-to-goal view"],
    data: "Opportunities/deals (kept in sync with Zoho), monthly_sales reorder cadence, and rep assignments.",
    actions: ["Review and filter open deals", "See the forecast by rep or line", "Identify light months before they arrive"],
    reports: ["Pipeline by stage", "Weighted forecast", "Cadence-based projection"],
    connects: ["Deals sync two-way with Zoho CRM Plus", "Cadence comes from the sales cube", "Feeds the Command Center 360 forecast"],
    problems: "Replaces gut-feel forecasting with a number grounded in real reorder patterns and live deals.",
    workflow: "Monthly forecasting and pipeline review — deciding where to push before quarter-end.",
    intelligence: "Automatic stage-weighting and cadence-based revenue projection."
  },
  "Analytics Deep Dive": {
    tagline: "The granular layer — cadence, orders, master accounts, and rep assignments behind every number.",
    what: "The detailed analytical workbench beneath Command Center 360: order-by-order cadence, master-account rollups (HQ plus branches), product mix, and the live rep-assignment map that everything else is built on.",
    features: ["Order cadence & frequency", "Master / branch account rollups", "Product and line mix", "Rep-assignment auditing", "Retired-line handling"],
    data: "The full monthly_sales cube, the dealer master with alias/merge, and directory rep assignments.",
    actions: ["Audit how sales roll up to companies", "Verify rep assignments", "Inspect cadence for any account"],
    reports: ["Order cadence", "Master-account totals", "Product mix", "Assignment coverage"],
    connects: ["The canonical layer shared with Command Center 360, Dealer 360, and Rep Performance"],
    problems: "When a headline number looks off, this is where you trace it back to the underlying orders and assignments.",
    workflow: "Data QA, assignment cleanup, and deep single-account analysis."
  },
  "Manufacturer Performance": {
    tagline: "Revenue by manufacturer line — sliced by rep, state, and company.",
    what: "A focused view of how each manufacturer line performs across your territory: total revenue, which reps and states drive it, and which dealers buy it — so you can manage each manufacturer relationship with real numbers.",
    features: ["Revenue by line", "Rep / state / company breakdown per line", "Top dealers per line", "Trend over time"],
    data: "monthly_sales by manufacturer, dealer geography, and rep assignments.",
    actions: ["Pick a line and see its whole footprint", "Identify states to expand a line into", "Prep manufacturer business reviews"],
    reports: ["Per-line revenue", "Geographic distribution", "Dealer roster per line"],
    connects: ["Same cube as Command Center 360", "Supports Campaign Studio targeting and the Dealer Handout crossover pick"],
    problems: "Manufacturer QBRs and line-expansion decisions, backed by data instead of anecdote."
  },
  "Commission Import": {
    tagline: "Load manufacturer commission reports and reconcile them against sales.",
    what: "Bring in the commission statements manufacturers send you, map them to dealers and reps, and reconcile paid commissions against the sales on record — so rep earnings and margins are accurate.",
    features: ["Upload manufacturer commission files", "Column mapping", "Dealer/rep matching via the alias layer", "Reconciliation against monthly_sales", "Exception flagging"],
    data: "Manufacturer commission files written to monthly_sales.commission, plus the dealer alias/merge layer and rep assignments.",
    actions: ["Import files", "Resolve unmatched rows", "Reconcile against sales", "Feed rep commission views"],
    reports: ["Commissions by rep / line / dealer", "Reconciliation exceptions"],
    connects: ["Powers My Commissions in the Sales Rep Portal", "Feeds Rep Performance earnings and Command Center commission metrics"],
    problems: "Accurate rep pay and margin visibility without hand-keying statements.",
    intelligence: "Alias-based auto-matching of messy manufacturer names to your canonical dealers."
  },
  "Sales Report Import": {
    tagline: "Load manufacturer order/sales reports — products, quantities, branches — auto-dated into monthly sales.",
    what: "The intake for sales data: upload the order/sales reports manufacturers provide and the importer parses products, quantities, amounts, and branch/customer names, matches them to your dealers, and writes them into the monthly sales cube that powers the entire platform.",
    features: ["Multi-format upload", "Product & quantity parsing", "Branch/customer matching via the alias layer", "Automatic period-dating", "Duplicate protection"],
    data: "Writes monthly_sales; uses the dealer master plus alias/merge.",
    actions: ["Import files", "Review matches", "Correct unmatched customers", "Commit to the sales cube"],
    reports: ["Import summaries", "Unmatched-customer worklist"],
    connects: ["The source that feeds Command Center 360, Dealer Health, Opportunities, the Dealer Handout — everything sales"],
    problems: "Turns raw manufacturer spreadsheets into clean, attributed sales the whole platform can trust.",
    intelligence: "Automatic period-dating and fuzzy customer matching to canonical dealers."
  },
  "Email Sync": {
    tagline: "Outlook email matched to dealers in Dealer 360 — plus live SPF/DKIM/DMARC deliverability monitoring.",
    what: "Pulls staff Outlook mail through Microsoft Graph and automatically attaches each message to the right dealer — building a shared communication history on every account, flagging senders it couldn't place for a one-click assign. It also carries a Deliverability panel that pulls DMARC monitoring data (via Postmark) so you can see, from the mailbox providers' own reports, how much of your outbound mail is passing SPF, DKIM, and DMARC — and which sources are sending as your domain.",
    features: ["Microsoft Graph inbox + sent ingestion", "Auto-match by contact email, domain, and name", "Unmatched-sender queue with one-click assign", "Noise controls: Not important / Ignore / Ignore whole domain", "Automatic no-reply / notification hiding", "Domain learning that grows over time", "Deliverability: SPF/DKIM/DMARC pass rates & sending-source breakdown from DMARC monitoring"],
    data: "email_messages, dealer_contacts, dealer_domains, the dealer alias layer, and Postmark DMARC reports.",
    actions: ["Run or schedule the sync", "Assign an unmatched sender to a dealer (and back-fill their past mail)", "Ignore noise reversibly", "Watch email deliverability (SPF/DKIM/DMARC) and catch spoofing or misconfiguration"],
    reports: ["Unmatched senders", "Ignored / hidden lists", "Per-dealer email timeline", "Deliverability — SPF/DKIM/DMARC pass rates and every source sending as your domain"],
    connects: ["Writes the email history shown in Dealer 360 & CRM", "Grows dealer_contacts used by matching and Campaign Studio", "Protects the campaigns sent from Campaign Studio by keeping authentication healthy"],
    problems: "Every rep sees the full email thread with a dealer, no conversation stays siloed — and you finally have eyes on whether your email is authenticating and landing instead of getting marked as spam.",
    intelligence: "Automatic dealer matching, domain learning, no-reply/notification auto-hiding, and independent DMARC-based deliverability monitoring."
  },
  "Activation & Go-Live": {
    tagline: "The master switch — Development / Sandbox / Live — and your official go-live date.",
    what: "Controls the platform's operating mode and go-live date, so you can build and test in Sandbox and flip to Live when you're ready — no code change required.",
    features: ["Dev / Sandbox / Live mode switch", "Official go-live date", "Environment-aware behavior across every function"],
    data: "Platform / app settings.",
    actions: ["Switch environment", "Set the go-live date"],
    connects: ["Every function reads the environment flag — e.g. email and tasks are tagged by environment"],
    problems: "Safe rollout — test without affecting live dealers, then go live in one click."
  },

  /* ---------------- SALES & MARKETING ---------------- */
  "Today's Opportunities": {
    tagline: "The single next-best action for every dealer, ranked.",
    what: "A daily, ranked list of the highest-value move for each dealer — hot buying intent, overdue reorders, cross-sell openings, and dormant win-backs — so reps always know exactly what to do next.",
    features: ["Ranked next-best-action per dealer", "Buying-intent signals", "Overdue-reorder detection from each dealer's own cadence", "Cross-sell suggestions", "Dormant-account flags"],
    data: "Sales cadence, engagement/intent signals, open opportunities, and line eligibility (what each dealer is approved to carry).",
    actions: ["Work the ranked list", "Open any dealer", "Log the outcome"],
    reports: ["Opportunity mix by type", "Per-rep worklists"],
    connects: ["Draws on Dealer Health, the sales cube, and eligibility", "Feeds My Tasks", "Aligns with the Dealer Handout crossover pick"],
    problems: "Reps stop guessing who to work and focus on the single highest-value action.",
    intelligence: "Automatic ranking and signal detection from the platform's engine."
  },
  "Who to Call": {
    tagline: "The daily call worklist — intent, overdue reorders, and dormant accounts.",
    what: "A focused calling list built from real signals: dealers showing buying intent, dealers overdue for a reorder based on their own rhythm, and dormant accounts that are slipping away.",
    features: ["Prioritized call list", "A plain reason for every dealer on it", "Cadence-based overdue detection", "Dormant win-back surfacing"],
    data: "Sales cadence, engagement, and intent signals.",
    actions: ["Call, log the outcome, and spin up follow-up tasks"],
    connects: ["Shares signals with Today's Opportunities and Dealer Health", "Logs activity to Dealer 360", "Creates My Tasks"],
    problems: "Fills a rep's day with the calls that actually move revenue."
  },
  "Dealer Health": {
    tagline: "Every dealer scored on recency, rhythm, and trend.",
    what: "A health score for each dealer — how recently they bought, how steady their rhythm is, and whether they're trending up or down — so at-risk accounts surface before they lapse.",
    features: ["Composite health score", "Recency / rhythm / trend components", "At-risk flags", "Portfolio-wide rollup"],
    data: "monthly_sales cadence and engagement.",
    actions: ["Sort by risk", "Open at-risk dealers", "Trigger outreach"],
    reports: ["Health distribution", "At-risk list", "Trend movers"],
    connects: ["Feeds Who to Call and Today's Opportunities", "Rep-scoped to each rep's book"],
    problems: "Catch churn early instead of noticing after the revenue is already gone.",
    intelligence: "Automatic scoring and at-risk detection."
  },
  "Dealer Manager": {
    tagline: "The master dealer database — records, locations, hierarchy, and portal access.",
    what: "The system of record for dealers: business details, multiple locations, HQ/branch hierarchy, merges and aliases, contract pricing, portal accounts, and email verification — the spine every other tool reads from.",
    features: ["Add and edit dealers", "Multi-location and parent/branch hierarchy", "Merge duplicates and manage aliases", "Contract pricing", "Portal login approvals", "Email verification and pending-verification account creation", "Relevance-ranked instant search from the first character"],
    data: "dealers, dealer_addresses, dealer_aliases, dealer_contacts, and dealer_manufacturers.",
    actions: ["Add / edit dealers", "Merge duplicates", "Approve portal logins", "Set contract pricing", "Verify emails", "Create accounts with an unverified email to confirm later"],
    connects: ["The canonical source for Command Center, Dealer 360, Analytics, Zoho sync, and ordering pricing/logins"],
    problems: "One clean, deduplicated dealer list that keeps every other tool accurate.",
    intelligence: "Alias normalization plus relevance-ranked instant search."
  },
  "Dealer 360 & CRM": {
    tagline: "The full account command center — activity, contacts, tasks, and next best action.",
    what: "Everything about one dealer on a single screen: sales history, the full email timeline, contacts, notes, tasks, buying intent, opportunities, manufacturer accounts, and the recommended next action — the rep's home base for any account.",
    features: ["360° activity timeline", "Email threads pulled in by Email Sync", "Contacts", "Notes and tasks", "Buying intent and opportunities", "Manufacturer accounts and pricing", "Next-best-action", "Visit logging"],
    data: "The sales cube, email_messages, dealer_contacts, tasks, opportunities, and engagement.",
    actions: ["Log calls and visits", "Add notes and tasks", "Create opportunities", "Send email follow-ups", "Review full history"],
    reports: ["Per-dealer activity", "Buying history", "Opportunity list"],
    connects: ["Pulls from Email Sync, the sales cube, Dealer Health, and My Tasks", "Pushes notes, tasks, and contacts to Zoho CRM Plus"],
    problems: "No more hunting across inboxes and spreadsheets — the whole relationship lives in one place.",
    intelligence: "Auto-surfaced buying intent, next-best-action, and automatically attached email."
  },
  "Territory Map": {
    tagline: "Dealer map, drive routing, saved trips — and the printable Dealer Handout.",
    what: "A geographic view of your territory with routing and trip planning, plus the visit-prep Dealer Handout and business-case packets that turn a drive into a productive sales day.",
    features: ["Dealer map with status coloring", "Optimized drive routes", "Multi-day itineraries and saved trips", "Territory scorecard", "Dealer Handout: 60/120/180-day purchase-gap read, a rotating regional crossover pick, CardChamp, and the assigned-rep contact", "Business-case visit packets"],
    data: "Geocoded dealer addresses, the sales cube, contacts, engagement, and regional sales trends.",
    actions: ["Plan and optimize routes", "Save trips", "Print handouts and business-case packets", "Log visits"],
    reports: ["Territory scorecard", "Per-visit business case"],
    connects: ["Uses the sales cube and directory", "The handout's crossover pick comes from regional sales trends", "Visits log back to Dealer 360"],
    problems: "Plan efficient trips and walk into every visit already prepared.",
    intelligence: "Route optimization plus the handout's regional crossover recommendation, which rotates from visit to visit."
  },
  "Sales Reps & Staff": {
    tagline: "Team accounts, roles, and territory ownership.",
    what: "Manage staff logins and what each person can see: roles (president, relations, rep), the rep-name mapping to the directory, travel flags, and active status — the control layer behind portal scoping.",
    features: ["Add and edit staff accounts", "Role assignment", "Rep-name mapping to the directory", "Can-travel flag", "Active / inactive status"],
    data: "staff_users and dealer_directory.",
    actions: ["Add staff", "Set roles", "Map a rep to their directory name", "Deactivate a departed rep"],
    connects: ["Roles and rep-name drive data scoping across every endpoint — a rep sees their own book, relations sees all dealers, the president sees everything"],
    problems: "The right people see the right data — reps their book, leadership the whole picture."
  },
  "My Tasks": {
    tagline: "Your task queue — auto-built from dealer signals plus anything you add.",
    what: "A follow-up engine: tasks the platform creates automatically from dealer signals (overdue reorders, visit follow-ups, expected orders) alongside anything you add manually — so nothing slips.",
    features: ["Auto-generated and manual tasks", "Priorities and due dates", "Linked to the dealer they belong to", "Visit-driven follow-ups"],
    data: "Tasks, engagement signals, and visit notes.",
    actions: ["Complete, snooze, add, or reassign tasks"],
    connects: ["Created from Dealer 360 visits, Today's Opportunities, and Who to Call", "The masthead badge shows your open count on every page"],
    problems: "Turns intentions into tracked follow-through.",
    intelligence: "Automatic task generation from dealer signals and visit notes."
  },
  "Pipeline": {
    tagline: "Your open deals and weighted pipeline.",
    what: "The working view of open opportunities — stages, values, and next steps — kept in sync with Zoho so the pipeline reads the same everywhere.",
    features: ["Open deals by stage", "Weighted pipeline value", "Owner and next-step tracking", "Two-way Zoho sync"],
    data: "Opportunities/deals shared with Zoho CRM Plus.",
    actions: ["Advance deals", "Update values and next steps", "Filter by rep or stage"],
    connects: ["Syncs two-way with Zoho CRM Plus", "Feeds the six-month forecast in Pipeline & Forecast and Command Center 360"],
    problems: "One trustworthy pipeline instead of competing spreadsheets."
  },
  "Zoho Sync": {
    tagline: "Two-way CRM sync — accounts, contacts, pipeline, and notes.",
    what: "Keeps Supabase (your system of record) and Zoho CRM Plus in step: pushes dealers to Accounts, contacts to Contacts, opportunities to Deals, and notes across — and pulls deal-stage and account changes back — with a dashboard showing heartbeat, webhooks, and recent activity.",
    features: ["Incremental content-hash push (only changed records move)", "Inbound webhooks for Accounts, Deals, and Contacts", "Deal-stage pull-back", "Sync heartbeat and health tiles", "Invalid-email surfacing with a Fix link"],
    data: "dealers, dealer_contacts, and opportunities ↔ the matching Zoho modules.",
    actions: ["Monitor sync health", "Fix flagged email addresses", "Trigger and verify webhooks"],
    reports: ["Sync state", "Webhook activity", "Recent events", "Emails to fix"],
    connects: ["Bridges the whole platform to Zoho CRM Plus — the marketing and automation engine that drives Campaign Studio"],
    problems: "Your operational data and your CRM/marketing engine stay consistent automatically.",
    intelligence: "Content-hash incremental sync — only records that actually changed are pushed."
  },
  "CardChamp": {
    tagline: "Referral activity, conversions, and commission for the CardChamp partnership.",
    what: "Tracks the CardChamp payment-processing partnership — which dealers you've referred, how many convert, and the commission it earns — and is the value-added service now featured on the Dealer Handout.",
    features: ["Referral tracking", "Conversion status", "Commission reporting"],
    data: "The partner-services / CardChamp dataset.",
    actions: ["Log referrals", "Track status", "Report commission earned"],
    connects: ["Promoted on the Dealer Handout as a dealer value-add", "A dealer-services revenue line alongside product sales"],
    problems: "Turns payment processing into a dealer value-add and a new revenue stream."
  },
  "Target Audiences": {
    tagline: "Build campaign lists from dealers and contacts — filter, pick, save.",
    what: "A segment builder: filter dealers and contacts by geography, lines carried, health, and activity to build static or auto-refreshing audiences for campaigns.",
    features: ["Multi-criteria filtering", "Static or dynamic (auto-refreshing) lists", "Contact-level targeting", "Saved, reusable audiences"],
    data: "Dealers, contacts, and sales/health signals.",
    actions: ["Build, preview, save, and reuse audiences"],
    connects: ["Feeds Campaign Studio", "Syncs to Zoho Campaigns"],
    problems: "Precise targeting instead of blasting the whole list."
  },
  "Campaign Studio": {
    tagline: "Brief in, audience + copy + sequence out — drafted into Zoho Campaigns.",
    what: "An assisted campaign builder: describe the goal and it generates a target audience, the copy, and a send sequence, then drafts the whole thing into Zoho Campaigns for your review before it sends.",
    features: ["Brief-to-campaign generation", "Audience, copy, and sequence together", "Drafts into Zoho Campaigns", "Performance readback"],
    data: "Target Audiences, contacts, and dealer data; Zoho Campaigns.",
    actions: ["Brief a campaign", "Edit the generated content", "Push to Zoho", "Track results"],
    reports: ["Campaign performance via Zoho and Command Center 360"],
    connects: ["Uses Target Audiences", "Drafts into Zoho CRM Plus", "Results surface in analytics"],
    problems: "Go from an idea to a ready-to-send, well-targeted campaign in minutes.",
    intelligence: "AI-generated audience, copy, and send sequence from a short brief."
  },
  "Product Interest": {
    tagline: "Turn portal browsing into targeted campaigns — dealers who show intent but haven't ordered.",
    what: "Reads the behavioral signals flowing in from the ordering and Golden portals and answers the campaign question directly: for any product or manufacturer line, which dealers viewed, searched, or carted it recently but haven't actually ordered it? Select them and build a ready-to-use campaign audience in one click.",
    features: ["Pick a specific product (SKU) or a whole manufacturer line", "Window control (30 / 60 / 90 days)", "Signal toggles — views & clicks, cart activity, searches", "Automatically excludes dealers who already ordered it", "Per-dealer intent score, signal breakdown & last-touch", "One-click audience → Campaign Studio / Target Audiences"],
    data: "intent_events (portal behavior from all sources incl. the Golden federation), monthly_sales (to exclude buyers), and the dealer master + rep directory.",
    actions: ["Choose a product or line and window", "Review the ranked dealer list", "Select dealers and build a named audience", "Hand off to Campaign Studio to send"],
    reports: ["Interested-but-not-buying list per product or line", "Intent breakdown (views / carts / searches) per dealer"],
    connects: ["Consumes the same intent stream that powers Dealer 360 and Command Center", "Writes a static audience into Target Audiences", "Feeds Campaign Studio for a Golden-branded send"],
    problems: "Converts real buying signals into precise re-marketing — pitch the exact line a dealer has been eyeing, not a generic blast.",
    workflow: "Weekly: pick a line you want to grow, pull the interested non-buyers, and launch a targeted campaign.",
    intelligence: "Behavioral intent scoring with automatic buyer exclusion."
  },
  "Golden Activity": {
    tagline: "A live window into the Golden ordering platform — every dealer touch, in one dashboard.",
    what: "The portfolio view of what's happening inside the HCPS-owned Golden ordering platform right now: who logged in, which products are being viewed, what's sitting in carts, what's been abandoned, and what's being ordered — fed in real time through the federation connector and attributed to the right HCPS dealer.",
    features: ["30-day KPIs — logins, views, searches, cart adds, abandoned carts, orders, order value", "Top products viewed across dealers", "Recent orders with value and line count", "Recent logins and abandoned carts", "Unmatched-event visibility (events that didn't map to a dealer)"],
    data: "The federation tables (federation_events, federation_orders) and intent_events tagged source='golden'.",
    actions: ["Monitor live Golden dealer behavior", "Spot the products drawing the most interest", "Jump into a dealer or into the audience builder"],
    reports: ["Activity KPIs", "Top products", "Recent orders / logins / abandoned carts"],
    connects: ["The same signals that update Dealer 360, engagement, and Who-to-Call", "Links straight into the Product-Interest audience builder"],
    problems: "A single trustworthy read on Golden portal engagement without logging into Golden — and it turns that read into sales action.",
    workflow: "A daily glance to see momentum, catch abandoned carts worth a call, and find products to campaign on.",
    intelligence: "Real-time federated ingestion with per-dealer identity resolution."
  },

  /* ---------------- ONLINE ORDERING ---------------- */
  "Catalog": {
    tagline: "Products, SKUs, categories, and descriptions for every manufacturer line.",
    what: "The product catalog behind the dealer ordering portal — manage items, SKUs, categories, pricing references, and descriptions per manufacturer line so dealers browse an accurate, complete catalog.",
    features: ["Product and SKU management", "Categories and per-line organization", "Descriptions and specs", "MSRP / pricing references"],
    data: "Catalog data served to the dealer ordering platform.",
    actions: ["Add and edit products", "Organize categories", "Maintain each manufacturer's catalog"],
    connects: ["Feeds the dealer ordering portal", "MSRP references feed the retail-value figure on the Dealer Handout"],
    problems: "Dealers order from a correct, current catalog — fewer errors, faster orders."
  },
  "Product Images": {
    tagline: "Upload and manage product photography.",
    what: "The image library for the catalog — upload, replace, and organize product photos so the ordering portal looks professional and products are easy to recognize.",
    features: ["Image upload and replace", "Per-product association", "Library management"],
    connects: ["Images render across the ordering portal and catalog"],
    problems: "A polished, visual catalog that helps dealers buy with confidence."
  },
  "Featured Products": {
    tagline: "Curate the promoted items dealers see first.",
    what: "Choose which products get top billing on the ordering portal — promotions, new arrivals, and priority lines — to steer dealer attention and drive the sales you want.",
    features: ["Featured-item curation", "Priority ordering", "Promotion highlighting"],
    connects: ["Drives merchandising on the ordering portal home"],
    problems: "Merchandise the portal to push the lines you're trying to grow."
  },
  "Portal Home Content": {
    tagline: "Hero banner, promos, and the “what's new” tiles dealers see on login.",
    what: "Edit the dealer ordering portal's landing content — hero banner, promotions, and news tiles — so dealers see current messaging and offers the moment they log in.",
    features: ["Hero / banner editor", "Promotion blocks", "What's-new tiles"],
    connects: ["The ordering portal's front door", "Complements the “what's new” section on the Dealer Handout"],
    problems: "Keep the dealer portal fresh and on-message without a developer."
  },
  "Contract Pricing": {
    tagline: "Per-dealer negotiated pricing by product.",
    what: "Set and manage the negotiated pricing each dealer sees in the ordering portal — contract prices by product and line so every dealer orders at their agreed terms.",
    features: ["Per-dealer price overrides", "By product and line", "Live in the dealer's portal"],
    data: "Pricing held on the dealer record.",
    actions: ["Set and adjust contract prices per dealer"],
    connects: ["The ordering portal shows each dealer their own pricing", "Part of the Dealer Manager record"],
    problems: "Accurate, dealer-specific pricing without manual quotes."
  },
  "Dealer Portal Accounts": {
    tagline: "Registrations, approvals, and ordering access.",
    what: "Approve and manage the dealer logins for the ordering portal — new registrations wait here for your approval, and you control who has ordering access.",
    features: ["Pending-registration approvals", "Access control", "Account status"],
    actions: ["Approve or deny registrations", "Manage who can order"],
    connects: ["Gates the ordering portal", "Tied to the dealer record in Dealer Manager"],
    problems: "Control who can order, and onboard new dealers cleanly."
  },
  "Order Review & Fulfillment": {
    tagline: "See, confirm, and track submitted dealer orders.",
    what: "The order desk: review the orders dealers submit through the portal, confirm them, and track fulfillment status from submission to delivery.",
    features: ["Submitted-order queue", "Confirm and track", "Status and history"],
    data: "Orders placed through the ordering portal.",
    actions: ["Review, confirm, and update order status"],
    connects: ["Closes the loop from the ordering portal", "Order data feeds sales history"],
    problems: "A clear handle on incoming orders and exactly where each one stands."
  },

  /* ---------------- WEBSITE ---------------- */
  "Website Content": {
    tagline: "Manufacturers, documents, pages, team, and settings for the public site.",
    what: "The content manager for homecareproviderservices — manage manufacturer profiles, documents, pages, team bios, and site settings that render on the public marketing website.",
    features: ["Manufacturer profiles", "Document library", "Page content", "Team bios", "Site settings"],
    connects: ["Publishes the public site", "Manufacturer pages help recruit new dealers"],
    problems: "Keep the public site current without a developer."
  },
  "Manufacturer Pages": {
    tagline: "Partner logos, profiles, and catalog links.",
    what: "Manage each manufacturer's public page — logo, profile, product highlights, and links — the pages that showcase your lines to prospective dealers.",
    features: ["Logo and profile", "Product highlights", "Catalog and contact links"],
    connects: ["Public marketing", "The same logos are used on the Dealer Handout"],
    problems: "Showcase your manufacturer lineup to attract dealers."
  },
  "Landing Pages": {
    tagline: "Campaign and program landing pages.",
    what: "Build and edit landing pages for campaigns and programs — the destinations your marketing and Campaign Studio send dealers to.",
    features: ["Campaign landing pages", "Program pages", "Editable content blocks"],
    connects: ["Paired with Campaign Studio", "Measured by Website Traffic"],
    problems: "Purpose-built pages that convert campaign clicks into leads."
  },
  "Site Images & Media": {
    tagline: "Hero images, banners, and downloadable assets.",
    what: "The public site's media library — hero images, banners, and downloadable documents that dealers and prospects access.",
    features: ["Hero and banner images", "Downloadable documents", "Media library"],
    connects: ["Renders across the public site and landing pages"],
    problems: "A consistent, managed set of visual and document assets."
  },
  "Links & Navigation": {
    tagline: "Menus, footer links, and redirects.",
    what: "Control the public site's navigation — menus, footer links, and redirects — so visitors and campaign traffic reach the right pages.",
    features: ["Menu management", "Footer links", "Redirects"],
    connects: ["Structures the public site", "Supports campaign link routing"],
    problems: "Keep site navigation clean and campaign links working."
  },
  "Website Traffic": {
    tagline: "Live public-site analytics — visits, top pages, and sources.",
    what: "Privacy-friendly web analytics for the public site: who's visiting, what they read, and where they came from — so you can tell whether the site and campaigns are drawing dealers.",
    features: ["Visits and unique visitors", "Top pages", "Referral sources", "Bounce rate and trends"],
    data: "Plausible analytics for the public website.",
    actions: ["Monitor campaign-landing traffic", "See which manufacturer pages draw interest"],
    reports: ["Visitors", "Page views", "Sources", "Bounce rate"],
    connects: ["Pairs with Landing Pages and Campaign Studio to measure marketing", "Manufacturer-page interest is a sales signal"],
    problems: "Know whether the website and campaigns are actually working."
  }

};
