/* HCPS Site Editor — schema-driven admin for the Eleventy block system.
   Talks to /.netlify/functions/admin-api which commits to GitHub. */
(function () {
  "use strict";

  var API = "/.netlify/functions/admin-api";
  var TOKEN_KEY = "hcps_admin_token";

  // ---- Files this editor manages (repo paths) ----
  var FILE = {
    manufacturers: "src/_data/manufacturers.json",
    documents: "src/_data/documents.json",
    home: "src/_data/home.json",
    site: "src/_data/site.json",
    team: "src/_data/team.json",
    testimonials: "src/_data/testimonials.json",
    pages: "src/_data/pages.json",
    seo: "src/_data/seo.json",
    redirects: "src/_data/redirects.json",
  };

  // ---- Schemas for the simple data editors (Home Page / Site / Team / Testimonials) ----
  var HOME_SCHEMA = [
    { k: "hero", label: "Hero", type: "object", full: true, item: [
      { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
      { k: "territory", label: "Headline territory line", type: "text", full: true },
      { k: "lead1", label: "Intro paragraph 1", type: "textarea", full: true },
      { k: "lead2", label: "Intro paragraph 2", type: "textarea", full: true },
      { k: "cta1_label", label: "Primary button label", type: "text" },
      { k: "cta2_label", label: "Secondary button label", type: "text" } ] },
    { k: "manufacturers_section", label: "Manufacturers section", type: "object", full: true, item: [
      { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
      { k: "title", label: "Heading", type: "text", full: true },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "order_note_title", label: "Order note — title", type: "text" },
      { k: "order_note_copy", label: "Order note — copy", type: "textarea", full: true } ] },
    { k: "why_section", label: "“Why choose us” heading", type: "object", full: true, item: [
      { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
      { k: "title", label: "Heading", type: "text", full: true } ] },
    { k: "team_section", label: "Team heading", type: "object", full: true, item: [
      { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
      { k: "title", label: "Heading", type: "text", full: true } ] },
    { k: "testimonials_section", label: "Testimonials heading", type: "object", full: true, item: [
      { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
      { k: "title", label: "Heading", type: "text", full: true } ] },
    { k: "territory_section", label: "Territory section", type: "object", full: true, item: [
      { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
      { k: "coverage_title", label: "Coverage heading", type: "text", full: true },
      { k: "coverage_copy", label: "Coverage copy", type: "textarea", full: true } ] },
    { k: "cta_section", label: "Bottom call-to-action", type: "object", full: true, item: [
      { k: "title", label: "Heading", type: "text", full: true },
      { k: "copy", label: "Copy", type: "textarea", full: true } ] },
  ];

  var SITE_SCHEMA = [
    { k: "tagline", label: "Tagline", type: "text" },
    { k: "founded", label: "Founded year", type: "text" },
    { k: "meta_description", label: "Meta description (SEO)", type: "textarea", full: true },
    { k: "contact", label: "Contact", type: "object", full: true, item: [
      { k: "phone_display", label: "Phone (display)", type: "text" },
      { k: "phone_href", label: "Phone (dial, e.g. +1937…)", type: "text" },
      { k: "email", label: "Email", type: "text" } ] },
    { k: "stats", label: "Headline stats", type: "object", full: true, item: [
      { k: "dealers", label: "Active dealers (e.g. 300+)", type: "text" },
      { k: "states", label: "States covered", type: "text" },
      { k: "manufacturers", label: "Manufacturer partners", type: "text" } ] },
    { k: "links", label: "Links", type: "object", full: true, item: [
      { k: "online_ordering", label: "Online ordering URL", type: "url" },
      { k: "support", label: "Support URL", type: "url" } ] },
    { k: "why_choose", label: "“Why choose us” cards", type: "objlist", full: true, item: [
      { k: "title", label: "Title", type: "text" },
      { k: "description", label: "Description", type: "textarea", full: true } ] },
    { k: "dealer_support_tools", label: "Dealer support tools", type: "objlist", full: true, item: [
      { k: "title", label: "Title", type: "text" },
      { k: "description", label: "Description", type: "textarea", full: true } ] },
  ];

  var TEAM_ITEM = [
    { k: "name", label: "Name", type: "text" },
    { k: "role", label: "Role / region", type: "text" },
    { k: "phone_display", label: "Phone (display)", type: "text" },
    { k: "phone_href", label: "Phone (dial)", type: "text" },
    { k: "email", label: "Email", type: "text" },
    { k: "photo", label: "Photo", type: "image", dir: "team", full: true },
  ];
  var TESTI_ITEM = [
    { k: "quote", label: "Quote", type: "textarea", full: true },
    { k: "name", label: "Name", type: "text" },
    { k: "role", label: "Role / company", type: "text" },
  ];
  var SEO_ITEM = [
    { k: "path", label: "Page path (e.g. / or /contact/)", type: "text" },
    { k: "title", label: "SEO / browser title", type: "text", full: true },
    { k: "description", label: "Meta description (~150–160 characters)", type: "textarea", full: true },
  ];
  var REDIR_ITEM = [
    { k: "from", label: "From path (e.g. /old-page/)", type: "text" },
    { k: "to", label: "To path or full URL", type: "text" },
    { k: "status", label: "Status — 301 permanent, 302 temporary", type: "text" },
  ];

  // ---- Content pages (pages.json): Partner, Contact, Consulting, Dealer Hub ----
  var HEADING = function (extra) { return [
    { k: "eyebrow", label: "Eyebrow (small label)", type: "text", full: true },
    { k: "title", label: "Heading", type: "text", full: true }
  ].concat(extra || []); };

  var PAGES_SCHEMA = [
    { k: "partner", label: "Become a Manufacturer Partner", type: "object", full: true, item: [
      { k: "hero", label: "Hero", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "headline", label: "Headline", type: "text", full: true },
        { k: "lead", label: "Intro paragraph", type: "textarea", full: true },
        { k: "cta1_label", label: "Primary button label", type: "text" },
        { k: "cta2_label", label: "Secondary button label", type: "text" },
        { k: "video", label: "Hero video link — YouTube/Vimeo/Drive (optional; replaces the glance card)", type: "url", full: true },
        { k: "card_title", label: "Glance card — title", type: "text", full: true },
        { k: "card_bullets", label: "Glance card — bullet points", type: "list", full: true } ] },
      { k: "why", label: "“Why choose us” section", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "cards", label: "Cards", type: "objlist", full: true, item: [
          { k: "title", label: "Card title", type: "text" },
          { k: "description", label: "Card text", type: "textarea", full: true } ] } ] },
      { k: "territory", label: "Territory section", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text" },
        { k: "intro", label: "Intro paragraph", type: "textarea", full: true } ] },
      { k: "leadership", label: "Leadership section", type: "object", full: true, item: HEADING() },
      { k: "form", label: "Inquiry form heading", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "intro", label: "Intro paragraph", type: "textarea", full: true } ] } ] },

    { k: "contact", label: "Contact", type: "object", full: true, item: [
      { k: "hero", label: "Hero", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "headline", label: "Headline", type: "text", full: true },
        { k: "lead", label: "Intro paragraph", type: "textarea", full: true } ] },
      { k: "paths", label: "“How can we help” heading", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "intro", label: "Intro paragraph", type: "textarea", full: true } ] },
      { k: "cards", label: "Audience cards", type: "objlist", full: true, item: [
        { k: "title", label: "Card title", type: "text" },
        { k: "description", label: "Card text", type: "textarea", full: true },
        { k: "button", label: "Button label", type: "text" },
        { k: "interest", label: "Form topic it selects", type: "text", full: true } ] },
      { k: "form", label: "Form heading", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "intro", label: "Intro paragraph", type: "textarea", full: true } ] } ] },

    { k: "consulting", label: "Consulting", type: "object", full: true, item: [
      { k: "hero", label: "Hero", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "headline", label: "Headline", type: "text", full: true },
        { k: "lead", label: "Intro paragraph", type: "textarea", full: true },
        { k: "cta1_label", label: "Primary button label", type: "text" },
        { k: "cta2_label", label: "Secondary button label", type: "text" },
        { k: "card_badge", label: "Side card — badge", type: "text" },
        { k: "card_title", label: "Side card — title", type: "text", full: true },
        { k: "card_copy", label: "Side card — copy", type: "textarea", full: true } ] },
      { k: "services", label: "Services section", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "intro", label: "Intro paragraph", type: "textarea", full: true },
        { k: "items", label: "Service cards", type: "objlist", full: true, item: [
          { k: "title", label: "Title", type: "text" },
          { k: "description", label: "Description", type: "textarea", full: true } ] } ] },
      { k: "split", label: "Showroom / floorplan section", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "copy", label: "Copy", type: "textarea", full: true },
        { k: "chips", label: "Chips / tags", type: "list", full: true },
        { k: "aside_title", label: "Side card — title", type: "text" },
        { k: "aside_copy", label: "Side card — copy", type: "textarea", full: true },
        { k: "aside_cta", label: "Side card — button label", type: "text" } ] },
      { k: "process", label: "Process section", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "steps", label: "Steps", type: "objlist", full: true, item: [
          { k: "title", label: "Title", type: "text" },
          { k: "description", label: "Description", type: "textarea", full: true } ] } ] },
      { k: "cta", label: "Bottom call-to-action", type: "object", full: true, item: [
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "copy", label: "Copy", type: "textarea", full: true },
        { k: "cta1_label", label: "Primary button label", type: "text" },
        { k: "cta2_label", label: "Secondary button label", type: "text" } ] } ] },

    { k: "dealerhub", label: "Dealer Hub", type: "object", full: true, item: [
      { k: "hero", label: "Hero", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "headline", label: "Headline", type: "text", full: true },
        { k: "lead", label: "Intro paragraph", type: "textarea", full: true },
        { k: "cta1_label", label: "Primary button label", type: "text" },
        { k: "cta2_label", label: "Secondary button label", type: "text" } ] },
      { k: "welcome", label: "Welcome bar", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text" },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "help_label", label: "Help link label", type: "text" } ] },
      { k: "actions", label: "Action cards (6)", type: "objlist", full: true, item: [
        { k: "icon", label: "Icon (emoji)", type: "text" },
        { k: "title", label: "Title", type: "text" },
        { k: "description", label: "Description", type: "textarea", full: true } ] },
      { k: "manufacturers_heading", label: "Manufacturer Centers heading", type: "object", full: true, item: HEADING() },
      { k: "future_login", label: "Future Dealer Login section", type: "object", full: true, item: [
        { k: "eyebrow", label: "Eyebrow", type: "text", full: true },
        { k: "title", label: "Heading", type: "text", full: true },
        { k: "copy", label: "Copy", type: "textarea", full: true },
        { k: "cta_label", label: "Button label", type: "text" } ] } ] },
  ];

  // config for each simple data view
  var DATA_VIEWS = {
    pages: { file: "pages", title: "Pages", root: "object", schema: PAGES_SCHEMA,
      note: "Edit the text on the Contact, Consulting, Dealer Hub, and Become a Manufacturer Partner pages. Layout and design stay fixed — you're editing the words (and you can add a hero video link on the Partner page)." },
    home: { file: "home", title: "Home Page", root: "object", schema: HOME_SCHEMA,
      note: "Edit the homepage text. The page layout and design stay fixed — you're editing the words." },
    site: { file: "site", title: "Site Settings", root: "object", schema: SITE_SCHEMA,
      note: "Contact info, headline stats, links, and the “why choose us” and dealer-support cards used across the site." },
    team: { file: "team", title: "Team", root: "array", item: TEAM_ITEM, itemLabel: "Team member", dir: "team",
      note: "Add, edit, reorder, or remove consulting team members shown on the homepage. Upload a photo for each." },
    testimonials: { file: "testimonials", title: "Testimonials", root: "array", item: TESTI_ITEM, itemLabel: "Testimonial",
      note: "Dealer quotes shown on the homepage." },
    seo: { file: "seo", title: "SEO", root: "array", item: SEO_ITEM, itemLabel: "Page",
      note: "Per-page search title and meta description. Path must match the live URL exactly (with leading and trailing slash, e.g. /contact/). Pages without an entry keep their default title and the site description." },
    redirects: { file: "redirects", title: "Redirects", root: "array", item: REDIR_ITEM, itemLabel: "Redirect",
      note: "Send an old or moved URL to a new one (great for SEO when a page changes address). From is a path on this site (/old/); To is a path or full URL. Use 301 for a permanent move. Takes effect on the next publish." },
  };

  // ---- Block schemas: mirror src/_includes/blocks/*.njk ----
  // types: text, textarea, url, image, color, bool, select, list, objlist, object, matrix
  var IMG = function () { return { type: "image", dir: "products" }; };

  var BLOCKS = {
    hero: { label: "Hero", fields: [
      { k: "eyebrow", label: "Eyebrow", type: "text" },
      { k: "headline", label: "Headline", type: "text" },
      { k: "lead", label: "Lead paragraph", type: "textarea", full: true },
      { k: "card_title", label: "Side-card title", type: "text" },
      { k: "card_intro", label: "Side-card intro", type: "textarea", full: true },
      { k: "checklist", label: "Side-card checklist", type: "list", full: true },
      { k: "image", label: "Side-card image (optional — falls back to logo)", type: "image", dir: "products", full: true },
      { k: "stats", label: "Side-card stats", type: "objlist", full: true, item: [
        { k: "value", label: "Value", type: "text" }, { k: "label", label: "Label", type: "text" } ] },
    ]},
    stats: { label: "Stat bar", fields: [
      { k: "items", label: "Stats", type: "objlist", full: true, item: [
        { k: "value", label: "Value", type: "text" }, { k: "label", label: "Label", type: "text" } ] },
    ]},
    cards: { label: "Category cards", fields: [
      { k: "eyebrow", label: "Eyebrow", type: "text" },
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "items", label: "Cards", type: "objlist", full: true, item: [
        { k: "name", label: "Name", type: "text" },
        { k: "tag", label: "Tag (small label)", type: "text" },
        { k: "image", label: "Image", type: "image", dir: "products" },
        { k: "description", label: "Description", type: "textarea", full: true } ] },
    ]},
    products: { label: "Featured products", fields: [
      { k: "eyebrow", label: "Eyebrow", type: "text" },
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "items", label: "Products", type: "objlist", full: true, item: [
        { k: "name", label: "Name", type: "text" },
        { k: "badge", label: "Badge", type: "text" },
        { k: "image", label: "Image", type: "image", dir: "products" },
        { k: "url", label: "Product URL", type: "url" },
        { k: "description", label: "Description", type: "textarea", full: true },
        { k: "tags", label: "Tags", type: "list" },
        { k: "bullets", label: "Bullet points", type: "list" } ] },
    ]},
    spotlight: { label: "Spotlight", fields: [
      { k: "badge", label: "Badge", type: "text" },
      { k: "headline", label: "Headline", type: "text" },
      { k: "copy", label: "Copy", type: "textarea", full: true },
      { k: "image", label: "Image", type: "image", dir: "products", full: true },
      { k: "checklist", label: "Checklist", type: "list", full: true },
      { k: "cta", label: "Button label", type: "text" },
    ]},
    comparison: { label: "Comparison", fields: [
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "left", label: "Left column", type: "object", full: true, item: [
        { k: "title", label: "Title", type: "text" }, { k: "points", label: "Points", type: "list", full: true } ] },
      { k: "right", label: "Right column (highlighted)", type: "object", full: true, item: [
        { k: "title", label: "Title", type: "text" }, { k: "points", label: "Points", type: "list", full: true } ] },
    ]},
    split: { label: "Split (text + image)", fields: [
      { k: "headline", label: "Headline", type: "text" },
      { k: "copy", label: "Copy", type: "textarea", full: true },
      { k: "checklist", label: "Checklist (bulleted)", type: "list", full: true },
      { k: "checks", label: "Check chips", type: "list", full: true },
      { k: "image", label: "Image", type: "image", dir: "products" },
      { k: "image_side", label: "Image side", type: "select", options: ["right", "left"] },
    ]},
    table: { label: "Table", fields: [
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "__matrix", label: "Table", type: "matrix", full: true },
    ]},
    video: { label: "Video", fields: [
      { k: "eyebrow", label: "Eyebrow", type: "text" },
      { k: "headline", label: "Headline", type: "text" },
      { k: "copy", label: "Copy", type: "textarea", full: true },
      { k: "embed", label: "Embed URL (iframe src)", type: "url", full: true },
      { k: "checklist", label: "Checklist", type: "list", full: true },
      { k: "video_side", label: "Video side", type: "select", options: ["left", "right"] },
    ]},
    faq: { label: "FAQ", fields: [
      { k: "eyebrow", label: "Eyebrow", type: "text" },
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "items", label: "Questions", type: "objlist", full: true, item: [
        { k: "q", label: "Question", type: "text" }, { k: "a", label: "Answer", type: "textarea", full: true } ] },
    ]},
    steps: { label: "Steps", fields: [
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "items", label: "Steps", type: "objlist", full: true, item: [
        { k: "title", label: "Title", type: "text" }, { k: "description", label: "Description", type: "textarea", full: true } ] },
    ]},
    cta_strip: { label: "CTA strip", fields: [
      { k: "headline", label: "Headline", type: "text" },
      { k: "copy", label: "Copy", type: "textarea", full: true },
      { k: "url", label: "Button URL (blank = ordering URL)", type: "url" },
      { k: "cta", label: "Button label", type: "text" },
    ]},
    differentiators: { label: "Differentiators", fields: [
      { k: "eyebrow", label: "Eyebrow", type: "text" },
      { k: "title", label: "Title", type: "text" },
      { k: "intro", label: "Intro", type: "textarea", full: true },
      { k: "items", label: "Cards", type: "objlist", full: true, item: [
        { k: "title", label: "Title", type: "text" }, { k: "description", label: "Description", type: "textarea", full: true } ] },
    ]},
  };

  var MANU_FIELDS = [
    { k: "name", label: "Name", type: "text" },
    { k: "category", label: "Category", type: "text" },
    { k: "featured", label: "Featured on homepage", type: "bool" },
    { k: "description", label: "Description", type: "textarea", full: true },
    { k: "website", label: "Manufacturer website", type: "url" },
    { k: "ordering_url", label: "Online ordering URL", type: "url" },
    { k: "logo", label: "Logo", type: "image", dir: "logos", full: true },
    { k: "brand.accent", label: "Accent color", type: "color" },
    { k: "brand.dark", label: "Dark color", type: "color" },
  ];

  // ---------- tiny DOM helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k === "html") el.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    (Array.isArray(kids) ? kids : kids != null ? [kids] : []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function get(obj, path) { return path.split(".").reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }
  function set(obj, path, val) {
    var parts = path.split("."), last = parts.pop();
    var t = parts.reduce(function (o, k) { if (o[k] == null) o[k] = {}; return o[k]; }, obj);
    t[last] = val;
  }

  // ---------- state ----------
  var state = { view: "manufacturers", token: null, dirty: false,
    manufacturers: null, mSha: null, documents: null, dSha: null, editingManu: null,
    data: {}, dataSha: {} };

  // ---------- UI feedback ----------
  var busyEl = $("#busy"), busyMsg = $("#busy-msg"), toastEl = $("#toast"), toastTimer = null;
  function busy(on, msg) { busyMsg.textContent = msg || "Working…"; busyEl.hidden = !on; }
  function toast(msg, kind) {
    toastEl.textContent = msg; toastEl.className = "toast" + (kind ? " " + kind : ""); toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.hidden = true; }, kind === "bad" ? 6000 : 3200);
  }

  // ---------- API ----------
  function api(action, payload) {
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    return fetch(API, { method: "POST", headers: headers, body: JSON.stringify(Object.assign({ action: action }, payload || {})) })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 401 && action !== "login") { logout(); throw new Error(res.body.error || "Session expired."); }
        if (res.status >= 400) throw new Error(res.body.error || ("Request failed (" + res.status + ")."));
        return res.body;
      });
  }

  // ---------- auth ----------
  function login(pw) {
    return api("login", { password: pw }).then(function (b) {
      state.token = b.token; localStorage.setItem(TOKEN_KEY, b.token);
      showApp(b.github);
    });
  }
  function logout() {
    state.token = null; localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
    state.manufacturers = state.documents = state.editingManu = null; state.dirty = false;
    state.data = {}; state.dataSha = {};
    $("#app").hidden = true; $("#login").hidden = false; $("#password").value = "";
  }

  function showApp(githubOk) {
    $("#login").hidden = true; $("#app").hidden = false;
    var gh = $("#gh-status");
    if (githubOk === false) { gh.className = "gh-status bad"; gh.textContent = "GitHub not configured"; }
    else { gh.className = "gh-status ok"; gh.textContent = "Publishing live"; }
    navigate("manufacturers");
  }

  // ---------- data loading ----------
  function ensureManufacturers() {
    if (state.manufacturers) return Promise.resolve();
    return api("get", { path: FILE.manufacturers }).then(function (b) {
      state.manufacturers = JSON.parse(b.content || "[]"); state.mSha = b.sha;
    });
  }
  function ensureDocuments() {
    if (state.documents) return Promise.resolve();
    return api("get", { path: FILE.documents }).then(function (b) {
      state.documents = JSON.parse(b.content || "{}"); state.dSha = b.sha;
    });
  }

  // ---------- navigation ----------
  function navigate(view) {
    if (state.dirty && !confirm("You have unsaved changes. Leave without saving?")) return;
    state.dirty = false; state.editingManu = null; state.view = view;
    var sb = $(".savebar"); if (sb) sb.remove();
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.view === view); });
    if (view === "manufacturers") renderManuIndex();
    else if (view === "documents") renderDocuments();
    else if (DATA_VIEWS[view]) renderData(view);
  }

  // ---------- generic data editors (Home Page / Site / Team / Testimonials) ----------
  function ensureData(view) {
    if (state.data[view]) return Promise.resolve();
    var cfg = DATA_VIEWS[view];
    return api("get", { path: FILE[cfg.file] }).then(function (b) {
      state.data[view] = JSON.parse(b.content || (cfg.root === "array" ? "[]" : "{}"));
      state.dataSha[view] = b.sha;
    });
  }
  function renderData(view) {
    var cfg = DATA_VIEWS[view];
    var v = $("#view"); v.innerHTML = "";
    v.appendChild(h("div", { class: "view-head" }, [ h("h2", {}, cfg.title) ]));
    if (cfg.note) v.appendChild(h("p", { class: "section-note" }, cfg.note));
    var host = h("div"); v.appendChild(host);
    busy(true, "Loading…");
    ensureData(view).then(function () {
      if (cfg.root === "object") {
        host.appendChild(renderFields(cfg.schema, state.data[view], { dir: cfg.dir || "products" }));
      } else {
        var wrapper = { items: state.data[view] };
        var field = { k: "items", label: cfg.itemLabel + "s", type: "objlist", full: true, item: cfg.item };
        host.appendChild(renderFields([field], wrapper, { dir: cfg.dir || "products" }));
      }
      busy(false);
      renderSaveBar(function () { saveData(view); }, false);
    }).catch(function (e) { busy(false); toast(e.message, "bad"); });
  }
  function saveData(view) {
    var cfg = DATA_VIEWS[view];
    var content = JSON.stringify(state.data[view], null, 2) + "\n";
    busy(true, "Publishing…");
    api("put", { path: FILE[cfg.file], content: content, sha: state.dataSha[view], message: "Edit " + cfg.title + " via admin" })
      .then(function (b) { state.dataSha[view] = b.sha; state.dirty = false; updateSaveBar(); busy(false);
        toast("Published. Live site rebuilds in ~1–2 min.", "ok"); })
      .catch(function (e) { busy(false); toast(e.message, "bad"); });
  }

  // ---------- Manufacturer index ----------
  function renderManuIndex() {
    var v = $("#view"); v.innerHTML = "";
    v.appendChild(h("div", { class: "view-head" }, [ h("h2", {}, "Manufacturers") ]));
    v.appendChild(h("p", { class: "section-note" }, "Add, hide, or remove a manufacturer \u2014 or click one to edit its page. Hidden or removed manufacturers drop off the website and the homepage count updates automatically when you publish."));
    var bar = h("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:12px" });
    bar.appendChild(h("button", { class: "btn primary", onclick: function () { addManufacturer(); } }, "+ Add manufacturer"));
    var countEl = h("span", { class: "section-note", style: "margin:0" }, "");
    bar.appendChild(countEl);
    v.appendChild(bar);
    var wrap = h("div", { class: "grid" });
    v.appendChild(wrap);
    busy(true, "Loading\u2026");
    ensureManufacturers().then(function () {
      var showing = state.manufacturers.filter(function (m) { return !m.hidden; }).length;
      countEl.textContent = showing + " showing of " + state.manufacturers.length + " on the site";
      state.manufacturers.forEach(function (m, i) {
        var built = (m.sections || []).length;
        var cell = h("div", { style: "display:flex;flex-direction:column;gap:6px" + (m.hidden ? ";opacity:.55" : "") }, [
          h("button", { class: "pick-card", onclick: function () { editManufacturer(i); } }, [
            h("div", { class: "nm" }, (m.name || m.id) + (m.hidden ? "  \u00b7 hidden" : "")),
            h("div", { class: "meta" }, m.category || ""),
            h("div", {}, built
              ? h("span", { class: "badge built" }, built + " section" + (built > 1 ? "s" : ""))
              : h("span", { class: "badge stub" }, "Stub \u2014 needs building")),
          ]),
          h("div", { style: "display:flex;gap:8px" }, [
            h("button", { class: "btn ghost sm", onclick: function () { toggleManuHidden(i); } }, m.hidden ? "Show on site" : "Hide from site"),
            h("button", { class: "btn ghost sm", style: "color:#b91c1c", onclick: function () { removeManufacturer(i); } }, "Remove"),
          ]),
        ]);
        wrap.appendChild(cell);
      });
      busy(false);
    }).catch(function (e) { busy(false); toast(e.message, "bad"); });
  }
  function manuSlug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function addManufacturer() {
    var name = prompt("New manufacturer name:");
    if (name == null) return; name = name.trim(); if (!name) return;
    var id = manuSlug(name);
    if (state.manufacturers.some(function (m) { return m.id === id; })) { toast("A manufacturer with that name already exists.", "bad"); return; }
    state.manufacturers.push({ id: id, name: name, category: "", description: "", website: "", logo: "", featured: false, ordering_url: "", brand: { accent: "#1681c2", dark: "#0b0d0f" }, sections: [] });
    state.editingManu = state.manufacturers.length - 1;
    saveManufacturers();
    renderManuEditor();
  }
  function toggleManuHidden(i) {
    state.manufacturers[i].hidden = !state.manufacturers[i].hidden;
    saveManufacturers();
    renderManuIndex();
  }
  function removeManufacturer(i) {
    var m = state.manufacturers[i];
    if (!confirm("Remove \u201c" + (m.name || m.id) + "\u201d from the website completely? This deletes its page and homepage card. To hide it temporarily instead, use \u201cHide from site.\u201d")) return;
    state.manufacturers.splice(i, 1);
    saveManufacturers();
    renderManuIndex();
  }


  // ---------- Manufacturer editor ----------
  function editManufacturer(index) {
    state.editingManu = index; state.dirty = false;
    renderManuEditor();
  }

  function renderManuEditor() {
    var m = state.manufacturers[state.editingManu];
    var v = $("#view"); v.innerHTML = "";
    v.appendChild(h("div", { class: "crumbs" }, [
      h("a", { onclick: function () { navigate("manufacturers"); } }, "Manufacturers"),
      document.createTextNode("  ›  " + (m.name || m.id)),
    ]));
    v.appendChild(h("div", { class: "view-head" }, [
      h("h2", {}, m.name || m.id),
      h("a", { class: "btn ghost sm", href: "/manufacturers/" + m.id + "/", target: "_blank" }, "View live page ↗"),
    ]));

    // Top-level manufacturer fields
    var mCard = h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [ h("div", { class: "ttl" }, "Manufacturer details") ]),
    ]);
    var mBody = h("div", { class: "card-body" });
    mCard.appendChild(mBody);
    mBody.appendChild(renderFields(MANU_FIELDS, m, { dir: manuDir(m) }));
    v.appendChild(mCard);

    // Sections
    v.appendChild(h("h3", { style: "margin:1.4rem 0 .3rem" }, "Page sections"));
    v.appendChild(h("p", { class: "section-note" }, (m.sections || []).length
      ? "Edit, reorder, or remove the blocks that build this page."
      : "This page has no blocks yet. Add blocks below to build it out."));

    var secWrap = h("div", { id: "sections" });
    v.appendChild(secWrap);
    renderSections(secWrap, m);

    // Add-block control
    var sel = h("select", {}, [h("option", { value: "" }, "Add a section…")]
      .concat(Object.keys(BLOCKS).map(function (t) { return h("option", { value: t }, BLOCKS[t].label + "  (" + t + ")"); })));
    v.appendChild(h("div", { class: "addblock" }, [
      sel,
      h("button", { class: "btn dark sm", onclick: function () {
        if (!sel.value) return;
        m.sections = m.sections || [];
        m.sections.push(newBlock(sel.value));
        sel.value = ""; markDirty(); renderSections(secWrap, m);
        window.scrollTo(0, document.body.scrollHeight);
      } }, "+ Add section"),
    ]));

    renderSaveBar();
  }

  function manuDir(m) { return "products/" + m.id; }

  function renderSections(wrap, m) {
    wrap.innerHTML = "";
    var secs = m.sections || [];
    if (!secs.length) { wrap.appendChild(h("div", { class: "empty" }, "No sections yet.")); return; }
    secs.forEach(function (blk, i) {
      var schema = BLOCKS[blk.type];
      var head = h("div", { class: "card-head" }, [
        h("div", { class: "ttl" }, [
          h("span", { class: "type-tag" }, blk.type),
          schema ? schema.label : "Unknown block",
        ]),
        h("div", { class: "card-actions" }, [
          h("button", { class: "btn icon", title: "Move up", disabled: i === 0, onclick: function () { move(m, i, -1, wrap); } }, "↑"),
          h("button", { class: "btn icon", title: "Move down", disabled: i === secs.length - 1, onclick: function () { move(m, i, 1, wrap); } }, "↓"),
          h("button", { class: "btn danger sm", onclick: function () {
            if (confirm("Remove this " + (schema ? schema.label : blk.type) + " section?")) { m.sections.splice(i, 1); markDirty(); renderSections(wrap, m); }
          } }, "Remove"),
        ]),
      ]);
      var body = h("div", { class: "card-body" });
      if (schema) body.appendChild(renderFields(schema.fields, blk, { dir: manuDir(m), block: blk }));
      else body.appendChild(h("p", { class: "hint" }, "No editor for block type “" + blk.type + "”."));
      wrap.appendChild(h("div", { class: "card" }, [head, body]));
    });
  }

  function move(m, i, dir, wrap) {
    var j = i + dir; if (j < 0 || j >= m.sections.length) return;
    var s = m.sections; var tmp = s[i]; s[i] = s[j]; s[j] = tmp; markDirty(); renderSections(wrap, m);
  }

  function newBlock(type) {
    var blk = { type: type };
    (BLOCKS[type].fields || []).forEach(function (f) {
      if (f.k === "__matrix") { blk.columns = ["Column 1", "Column 2"]; blk.rows = [["", ""]]; return; }
      if (f.type === "list") set(blk, f.k, []);
      else if (f.type === "objlist") set(blk, f.k, []);
      else if (f.type === "object") set(blk, f.k, {});
      else if (f.type === "bool") set(blk, f.k, false);
      else set(blk, f.k, "");
    });
    return blk;
  }

  // ---------- generic field renderer ----------
  // ctx: { dir, block }  dir = media upload subfolder under src/assets/
  function renderFields(fields, obj, ctx) {
    var grid = h("div", { class: "fields" });
    fields.forEach(function (f) {
      grid.appendChild(renderField(f, obj, ctx));
    });
    return grid;
  }

  function renderField(f, obj, ctx) {
    if (f.type === "matrix") return matrixField(f, ctx.block);
    var wrapCls = "field" + (f.full ? " full" : "");
    var val = get(obj, f.k);

    if (f.type === "bool") {
      var cb = h("input", { type: "checkbox" }); cb.checked = !!val;
      cb.addEventListener("change", function () { set(obj, f.k, cb.checked); markDirty(); });
      return h("div", { class: wrapCls }, [ h("label", { class: "chk" }, [cb, document.createTextNode(f.label)]) ]);
    }
    if (f.type === "color") {
      var cur = val || "#1681c2";
      var picker = h("input", { type: "color", value: cur });
      var hex = h("input", { type: "text", value: cur });
      picker.addEventListener("input", function () { hex.value = picker.value; set(obj, f.k, picker.value); markDirty(); });
      hex.addEventListener("input", function () { set(obj, f.k, hex.value); if (/^#[0-9a-f]{6}$/i.test(hex.value)) picker.value = hex.value; markDirty(); });
      return h("div", { class: wrapCls }, [ h("label", {}, f.label), h("div", { class: "color-row" }, [picker, hex]) ]);
    }
    if (f.type === "select") {
      var s = h("select", {}, (f.options || []).map(function (o) {
        var opt = h("option", { value: o }, o); if (o === (val || f.options[0])) opt.selected = true; return opt;
      }));
      s.addEventListener("change", function () { set(obj, f.k, s.value); markDirty(); });
      if (val == null) set(obj, f.k, f.options[0]);
      return h("div", { class: wrapCls }, [ h("label", {}, f.label), s ]);
    }
    if (f.type === "image") return imageField(f, obj, ctx);
    if (f.type === "list") return listField(f, obj);
    if (f.type === "objlist") return objListField(f, obj, ctx);
    if (f.type === "object") {
      if (get(obj, f.k) == null) set(obj, f.k, {});
      var sub = get(obj, f.k);
      var box = h("div", { class: "sublist" }, [ renderFields(f.item, sub, ctx) ]);
      return h("div", { class: wrapCls }, [ h("label", {}, f.label), box ]);
    }
    // text / textarea / url
    var input = f.type === "textarea" ? h("textarea", {}) : h("input", { type: f.type === "url" ? "url" : "text" });
    input.value = val == null ? "" : val;
    input.addEventListener("input", function () { set(obj, f.k, input.value); markDirty(); });
    return h("div", { class: wrapCls }, [ h("label", {}, f.label), input ]);
  }

  // list of strings
  function listField(f, obj) {
    if (get(obj, f.k) == null) set(obj, f.k, []);
    var arr = get(obj, f.k);
    var wrap = h("div", { class: "field full" }, [ h("label", {}, f.label) ]);
    var box = h("div", { class: "sublist" });
    function draw() {
      box.innerHTML = "";
      arr.forEach(function (val, i) {
        var input = h("input", { type: "text", value: val });
        input.addEventListener("input", function () { arr[i] = input.value; markDirty(); });
        box.appendChild(h("div", { class: "str-row" }, [
          input,
          h("button", { class: "btn icon", title: "Move up", disabled: i === 0, onclick: function () { var t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t; markDirty(); draw(); } }, "↑"),
          h("button", { class: "btn danger sm", onclick: function () { arr.splice(i, 1); markDirty(); draw(); } }, "✕"),
        ]));
      });
      box.appendChild(h("button", { class: "btn sm", onclick: function () { arr.push(""); markDirty(); draw(); } }, "+ Add item"));
    }
    draw(); wrap.appendChild(box); return wrap;
  }

  // list of objects
  function objListField(f, obj, ctx) {
    if (get(obj, f.k) == null) set(obj, f.k, []);
    var arr = get(obj, f.k);
    var wrap = h("div", { class: "field full" }, [ h("label", {}, f.label) ]);
    var box = h("div", { class: "sublist" });
    function draw() {
      box.innerHTML = "";
      arr.forEach(function (item, i) {
        var head = h("div", { class: "sub-item-head" }, [
          h("span", { class: "lbl" }, (f.label.replace(/s$/, "")) + " " + (i + 1)),
          h("div", { class: "mini" }, [
            h("button", { class: "btn icon", title: "Move up", disabled: i === 0, onclick: function () { var t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t; markDirty(); draw(); } }, "↑"),
            h("button", { class: "btn icon", title: "Move down", disabled: i === arr.length - 1, onclick: function () { var t = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = t; markDirty(); draw(); } }, "↓"),
            h("button", { class: "btn danger sm", onclick: function () { arr.splice(i, 1); markDirty(); draw(); } }, "Remove"),
          ]),
        ]);
        box.appendChild(h("div", { class: "sub-item" }, [ head, renderFields(f.item, item, ctx) ]));
      });
      box.appendChild(h("button", { class: "btn sm", onclick: function () {
        var blank = {}; f.item.forEach(function (sf) { blank[sf.k] = (sf.type === "list") ? [] : (sf.type === "bool" ? false : ""); });
        arr.push(blank); markDirty(); draw();
      } }, "+ Add"));
    }
    draw(); wrap.appendChild(box); return wrap;
  }

  // image field with upload
  function imageField(f, obj, ctx) {
    var dir = f.dir || (ctx && ctx.dir) || "products";
    if (f.dir === "logos") dir = "logos";
    else if (ctx && ctx.dir && f.dir === "products") dir = ctx.dir;
    var val = get(obj, f.k) || "";
    var wrapCls = "field" + (f.full ? " full" : "");
    var prev = h("div", { class: "img-preview" });
    var pathInput = h("input", { type: "text", value: val, placeholder: "/assets/…" });
    pathInput.addEventListener("input", function () { set(obj, f.k, pathInput.value); setPrev(pathInput.value); markDirty(); });
    // Preview from a path on the live site (falls back to "not live yet" if the
    // file was just committed and hasn't deployed).
    function setPrev(u) {
      prev.innerHTML = "";
      if (u) {
        var img = h("img", { src: u, alt: "" });
        img.addEventListener("error", function () { prev.innerHTML = ""; prev.appendChild(h("span", { class: "img-pending" }, "not live yet")); });
        prev.appendChild(img);
      } else prev.appendChild(document.createTextNode("no image"));
    }
    // Preview directly from the file the user just picked — always renders, even
    // before the new image has deployed.
    function setPrevLocal(fileObj) {
      prev.innerHTML = "";
      var img = h("img", { src: URL.createObjectURL(fileObj), alt: "" });
      prev.appendChild(img);
    }
    setPrev(val);
    var file = h("input", { type: "file", accept: "image/*", style: "display:none" });
    file.addEventListener("change", function () {
      if (!file.files[0]) return;
      var picked = file.files[0];
      uploadMedia(picked, dir).then(function (url) {
        set(obj, f.k, url); pathInput.value = url; setPrevLocal(picked); markDirty();
        toast("Image uploaded — click “Publish changes” to make it live.", "ok");
      }).catch(function (e) { toast(e.message, "bad"); }).then(function () { file.value = ""; });
    });
    var btn = h("button", { class: "btn sm", onclick: function () { file.click(); } }, "⬆ Upload image");
    return h("div", { class: wrapCls }, [
      h("label", {}, f.label),
      h("div", { class: "img-field" }, [ prev, h("div", { class: "img-ctrls" }, [ btn, pathInput, file,
        h("div", { class: "hint" }, "Uploads commit instantly, then appear on the live site after you Publish and Netlify rebuilds (~1–2 min).") ]) ]),
    ]);
  }

  // table matrix editor (columns + rows on the block itself)
  function matrixField(f, blk) {
    if (!Array.isArray(blk.columns)) blk.columns = ["Column 1", "Column 2"];
    if (!Array.isArray(blk.rows)) blk.rows = [];
    var wrap = h("div", { class: "field full" }, [ h("label", {}, f.label) ]);
    var host = h("div", { class: "matrix" });
    function normalize() { blk.rows.forEach(function (r) { while (r.length < blk.columns.length) r.push(""); r.length = blk.columns.length; }); }
    function draw() {
      normalize(); host.innerHTML = "";
      var table = h("table");
      var thead = h("tr");
      blk.columns.forEach(function (c, ci) {
        var ci_ = h("input", { type: "text", value: c });
        ci_.addEventListener("input", function () { blk.columns[ci] = ci_.value; markDirty(); });
        thead.appendChild(h("th", {}, [ ci_,
          h("button", { class: "rm-col", title: "Remove column", onclick: function () {
            blk.columns.splice(ci, 1); blk.rows.forEach(function (r) { r.splice(ci, 1); }); markDirty(); draw();
          } }, "✕") ]));
      });
      thead.appendChild(h("th", {}, ""));
      table.appendChild(h("thead", {}, thead));
      var tb = h("tbody");
      blk.rows.forEach(function (row, ri) {
        var tr = h("tr");
        blk.columns.forEach(function (_, ci) {
          var inp = h("input", { type: "text", value: row[ci] || "" });
          inp.addEventListener("input", function () { row[ci] = inp.value; markDirty(); });
          tr.appendChild(h("td", {}, inp));
        });
        tr.appendChild(h("td", {}, h("button", { class: "rm-row", title: "Remove row", onclick: function () { blk.rows.splice(ri, 1); markDirty(); draw(); } }, "✕")));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      host.appendChild(table);
      host.appendChild(h("div", { style: "display:flex;gap:.4rem;margin-top:.5rem" }, [
        h("button", { class: "btn sm", onclick: function () { blk.rows.push(blk.columns.map(function () { return ""; })); markDirty(); draw(); } }, "+ Row"),
        h("button", { class: "btn sm", onclick: function () { blk.columns.push("Column " + (blk.columns.length + 1)); blk.rows.forEach(function (r) { r.push(""); }); markDirty(); draw(); } }, "+ Column"),
      ]));
    }
    draw(); wrap.appendChild(host); return wrap;
  }

  // ---------- media upload ----------
  function slug(s) { return String(s).toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file"; }
  function ext(name) { var m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : "bin"; }
  function readBase64(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1]); };
      r.onerror = function () { rej(new Error("Could not read file.")); };
      r.readAsDataURL(file);
    });
  }
  function uploadMedia(file, dir) {
    busy(true, "Uploading " + file.name + "…");
    var fname = slug(file.name) + "-" + Date.now().toString(36) + "." + ext(file.name);
    var repoPath = "src/assets/" + dir + "/" + fname;   // committed here
    var publicUrl = "/assets/" + dir + "/" + fname;      // referenced in JSON
    return readBase64(file).then(function (b64) {
      return api("upload", { path: repoPath, contentBase64: b64, message: "Upload " + fname + " via admin" });
    }).then(function () { busy(false); return publicUrl; })
      .catch(function (e) { busy(false); throw e; });
  }

  // ---------- save (manufacturers) ----------
  function markDirty() { if (!state.dirty) { state.dirty = true; updateSaveBar(); } }
  function renderSaveBar(saveFn, backView) {
    var old = $(".savebar"); if (old) old.remove();
    var actions = [];
    if (backView !== false) actions.push(h("button", { class: "btn ghost", onclick: function () { navigate(backView || "manufacturers"); } }, "Back"));
    actions.push(h("button", { class: "btn primary", id: "save-btn", onclick: (saveFn || saveManufacturers) }, "Publish changes"));
    var bar = h("div", { class: "savebar" }, [
      h("div", { class: "savebar-inner" }, [
        h("div", { class: "msg", id: "save-msg" }, "All changes saved."),
        h("div", { class: "actions" }, actions),
      ]),
    ]);
    document.body.appendChild(bar); updateSaveBar();
  }
  function updateSaveBar() {
    var msg = $("#save-msg"); if (!msg) return;
    if (state.dirty) msg.innerHTML = '<span class="dirty-dot">●</span> Unsaved changes';
    else msg.textContent = "All changes saved.";
  }
  function saveManufacturers() {
    var content = JSON.stringify(state.manufacturers, null, 2) + "\n";
    busy(true, "Publishing…");
    api("put", { path: FILE.manufacturers, content: content, sha: state.mSha, message: "Edit content via admin" })
      .then(function (b) { state.mSha = b.sha; state.dirty = false; updateSaveBar(); busy(false);
        toast("Published. Live site rebuilds in ~1–2 min.", "ok"); })
      .catch(function (e) { busy(false); toast(e.message, "bad"); });
  }

  // ---------- Documents ----------
  function renderDocuments() {
    var v = $("#view"); v.innerHTML = "";
    v.appendChild(h("div", { class: "view-head" }, [
      h("h2", {}, "Documents"),
      h("button", { class: "btn primary", onclick: function () { editDoc(null); } }, "+ Add document"),
    ]));
    v.appendChild(h("p", { class: "section-note" }, "Brochures, price lists, forms, and videos shown in the Resources library and on manufacturer pages."));
    var host = h("div"); v.appendChild(host);
    busy(true, "Loading…");
    Promise.all([ensureDocuments(), ensureManufacturers()]).then(function () {
      drawDocTable(host); busy(false);
    }).catch(function (e) { busy(false); toast(e.message, "bad"); });
  }

  function manuName(id) { if (!id) return "General / HCPS"; var m = (state.manufacturers || []).find(function (x) { return x.id === id; }); return m ? m.name : id; }
  function typeLabel(id) { var t = (state.documents.types || []).find(function (x) { return x.id === id; }); return t ? t.label : id; }

  function drawDocTable(host) {
    host.innerHTML = "";
    var items = state.documents.items || [];
    if (!items.length) { host.appendChild(h("div", { class: "empty" }, "No documents yet.")); return; }
    var rows = items.map(function (d, i) {
      return h("tr", {}, [
        h("td", {}, [ h("strong", {}, d.title || "(untitled)"), h("div", { style: "font-size:12px;color:#5b6472" }, d.description || "") ]),
        h("td", {}, typeLabel(d.type)),
        h("td", {}, manuName(d.manufacturer)),
        h("td", {}, h("span", { class: "pill " + (d.access || "") }, d.access || "public")),
        h("td", {}, (d.format || "").toUpperCase()),
        h("td", { style: "text-align:right;white-space:nowrap" }, [
          h("button", { class: "btn sm", onclick: function () { editDoc(i); } }, "Edit"),
          document.createTextNode(" "),
          h("button", { class: "btn danger sm", onclick: function () { deleteDoc(i, host); } }, "Delete"),
        ]),
      ]);
    });
    var table = h("table", { class: "doc-table" }, [
      h("thead", {}, h("tr", {}, ["Document", "Type", "Manufacturer", "Access", "Format", ""].map(function (t) { return h("th", { style: t === "" ? "text-align:right" : "" }, t); }))),
      h("tbody", {}, rows),
    ]);
    host.appendChild(table);
  }

  function deleteDoc(i, host) {
    var d = state.documents.items[i];
    if (!confirm('Delete "' + (d.title || "this document") + '"? This publishes immediately.')) return;
    state.documents.items.splice(i, 1);
    saveDocuments().then(function () { drawDocTable(host); });
  }

  function editDoc(index) {
    var isNew = index == null;
    var d = isNew
      ? { id: "", title: "", type: (state.documents.types[0] || {}).id || "", manufacturer: "", format: "pdf", file: "", url: "", description: "", access: "public", dealers: [], featured: false }
      : JSON.parse(JSON.stringify(state.documents.items[index]));

    var typeOpts = (state.documents.types || []).map(function (t) { return { v: t.id, l: t.label }; });
    var manuOpts = [{ v: "", l: "General / HCPS" }].concat((state.manufacturers || []).map(function (m) { return { v: m.id, l: m.name }; }));
    var fmtOpts = (state.documents.formats || ["pdf", "xlsx", "docx", "video", "link"]).map(function (x) { return { v: x, l: x.toUpperCase() }; });
    var accessOpts = [{ v: "public", l: "Public — anyone" }, { v: "dealer", l: "Dealer login" }, { v: "dealer-specific", l: "Specific dealers" }];

    function selField(label, key, opts) {
      var s = h("select", {}, opts.map(function (o) { var op = h("option", { value: o.v }, o.l); if (o.v === d[key]) op.selected = true; return op; }));
      s.addEventListener("change", function () {
        d[key] = s.value;
        if (key === "type") { var t = (state.documents.types || []).find(function (x) { return x.id === s.value; }); if (t && t.defaultAccess) { d.access = t.defaultAccess; body.querySelector('[data-k="access"]').value = t.defaultAccess; } }
      });
      s.setAttribute("data-k", key);
      return h("div", { class: "field" }, [ h("label", {}, label), s ]);
    }
    function txtField(label, key, ta, full) {
      var el = ta ? h("textarea", {}) : h("input", { type: "text" }); el.value = d[key] || "";
      el.addEventListener("input", function () { d[key] = el.value; });
      return h("div", { class: "field" + (full ? " full" : "") }, [ h("label", {}, label), el ]);
    }

    // file upload row
    var fileVal = h("input", { type: "text", value: d.file || "", placeholder: "/assets/docs/…" });
    fileVal.addEventListener("input", function () { d.file = fileVal.value; });
    var fileInput = h("input", { type: "file", accept: ".pdf,.doc,.docx,.xls,.xlsx", style: "display:none" });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files[0]) return;
      uploadMedia(fileInput.files[0], "docs").then(function (url) {
        d.file = url; fileVal.value = url; d.format = ext(url) === "pdf" ? "pdf" : (ext(url) === "docx" || ext(url) === "doc" ? "docx" : (ext(url) === "xlsx" || ext(url) === "xls" ? "xlsx" : d.format));
        toast("File uploaded.", "ok");
      }).catch(function (e) { toast(e.message, "bad"); }).then(function () { fileInput.value = ""; });
    });
    var fileRow = h("div", { class: "field full" }, [
      h("label", {}, "File (upload a PDF/DOCX/XLSX, or paste a path)"),
      h("div", { class: "row-inline" }, [ h("button", { class: "btn sm", onclick: function () { fileInput.click(); } }, "⬆ Upload file"), fileVal, fileInput ]),
      h("div", { class: "hint" }, "For videos or external links, leave File blank and use the URL field."),
    ]);

    var featEl = h("input", { type: "checkbox" }); featEl.checked = !!d.featured;
    featEl.addEventListener("change", function () { d.featured = featEl.checked; });

    var body = h("div", { class: "modal-body" }, [
      h("div", { class: "fields" }, [
        txtField("Title", "title", false, true),
        selField("Type", "type", typeOpts),
        selField("Manufacturer", "manufacturer", manuOpts),
        selField("Format", "format", fmtOpts),
        selField("Access level", "access", accessOpts),
        txtField("Description", "description", true, true),
        fileRow,
        txtField("External URL (video / link)", "url", false, true),
        txtField("ID (auto if blank)", "id", false, false),
        h("div", { class: "field" }, [ h("label", { class: "chk" }, [featEl, document.createTextNode("Featured")]) ]),
      ]),
    ]);

    var modalBg = h("div", { class: "modal-bg" }, [
      h("div", { class: "modal" }, [
        h("div", { class: "modal-head" }, [ h("h3", {}, isNew ? "Add document" : "Edit document"),
          h("button", { class: "btn ghost sm", onclick: close }, "✕") ]),
        body,
        h("div", { class: "modal-foot" }, [
          h("button", { class: "btn ghost", onclick: close }, "Cancel"),
          h("button", { class: "btn primary", onclick: save }, "Publish"),
        ]),
      ]),
    ]);
    function close() { modalBg.remove(); }
    function save() {
      if (!d.title.trim()) { toast("Title is required.", "bad"); return; }
      if (!d.id.trim()) d.id = slug(d.title) + "-" + Date.now().toString(36);
      if (!Array.isArray(d.dealers)) d.dealers = [];
      if (isNew) state.documents.items.push(d);
      else state.documents.items[index] = d;
      saveDocuments().then(function () { close(); renderDocuments(); });
    }
    document.body.appendChild(modalBg);
  }

  function saveDocuments() {
    var content = JSON.stringify(state.documents, null, 2) + "\n";
    busy(true, "Publishing…");
    return api("put", { path: FILE.documents, content: content, sha: state.dSha, message: "Edit documents via admin" })
      .then(function (b) { state.dSha = b.sha; busy(false); toast("Published. Live site rebuilds in ~1–2 min.", "ok"); })
      .catch(function (e) { busy(false); toast(e.message, "bad"); throw e; });
  }

  // ---------- boot ----------
  $("#login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("#login-error"); err.hidden = true;
    var btn = $("#login-btn"); btn.disabled = true; btn.textContent = "Signing in…";
    login($("#password").value).catch(function (ex) { err.textContent = ex.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = "Sign in"; });
  });
  document.querySelectorAll(".tab").forEach(function (t) { t.addEventListener("click", function () { navigate(t.dataset.view); }); });
  $("#logout-btn").addEventListener("click", logout);
  window.addEventListener("beforeunload", function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  // resume session
  var saved = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  if (saved) {
    state.token = saved;
    api("ping").then(function (b) { showApp(b.github); }).catch(function () { logout(); });
  }
})();
