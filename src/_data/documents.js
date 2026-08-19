// HCPS Dealer Resource Library — the data behind /resources/.
// The Resources page filters this directory by manufacturer, product category, and resource type.
//
// HOW TO ADD A REAL DOCUMENT:
//   Push a PDF to /assets/docs/ (or use a manufacturer URL) and add an item:
//     { manufacturer:"golden-technologies", category:"lift-chairs", type:"guide",
//       title:"Golden MaxiComfort Selling Guide", description:"…",
//       access:"public", file:"/assets/docs/golden-maxicomfort-guide.pdf", featured:true }
//   access: "public" (View/Download) · "dealer" (order/login) · "request" (routes to Dealer Support).
//
// Until real files are loaded, each manufacturer is seeded with working entries that point to the
// manufacturer line page, their website/catalogs, online ordering, and dealer-support requests — so
// the directory is fully functional today and every card has a real action.

const manufacturers = require("./manufacturers.json");
const ORDERING = "https://hcpsonlineordering.netlify.app/";

const types = [
  { id: "catalog",  label: "Product Catalog" },
  { id: "guide",    label: "Product Guide" },
  { id: "clinical", label: "Clinical Publication" },
  { id: "form",     label: "Credit App / Dealer Form" },
  { id: "marketing",label: "Sales & Marketing" },
  { id: "training", label: "Training & In-Service" },
  { id: "resource", label: "Manufacturer Resource" },
];

const categories = [
  { id: "lift-chairs",    label: "Lift Chairs & Seating" },
  { id: "mobility",       label: "Mobility & Wheelchairs" },
  { id: "respiratory",    label: "Respiratory & Airway" },
  { id: "oxygen",         label: "Oxygen Therapy" },
  { id: "sleep",          label: "Sleep Apnea (CPAP/EPAP)" },
  { id: "sleep-surfaces", label: "Sleep Surfaces & Beds" },
  { id: "bracing",        label: "Bracing & Orthopedic" },
  { id: "bath-safety",    label: "Bath Safety" },
  { id: "ramps",          label: "Ramps & Access" },
  { id: "lifts",          label: "Patient & Stair Lifts" },
  { id: "footcare",       label: "Footcare" },
];

// Map a manufacturer's category string to a product-category id (keyword match, first hit wins).
function categoryFor(m) {
  const s = String(m.category || "").toLowerCase();
  if (/ramp/.test(s)) return "ramps";
  if (/oxygen/.test(s)) return "oxygen";
  if (/respirat|airway/.test(s)) return "respiratory";
  if (/apnea|epap|cpap/.test(s)) return "sleep";
  if (/bed|mattress|surface|healthcare sleep/.test(s)) return "sleep-surfaces";
  if (/brac|ortho/.test(s)) return "bracing";
  if (/bath/.test(s)) return "bath-safety";
  if (/foot/.test(s)) return "footcare";
  if (/stair|patient lift|lift/.test(s) && !/recliner|chair/.test(s)) return "lifts";
  if (/recliner|lift chair|seating/.test(s)) return "lift-chairs";
  if (/wheelchair|mobility|scooter|transport/.test(s)) return "mobility";
  return "";
}

const items = [];

// ---- HCPS-level (all-manufacturer) resources ----
items.push(
  { manufacturer: "", category: "", type: "form", title: "HCPS Dealer Account Application",
    description: "Apply to become an HCPS dealer and establish your manufacturer accounts across the lines you carry.",
    access: "public", file: "/become-a-dealer/", featured: true },
  { manufacturer: "", category: "", type: "resource", title: "24/7 Online Ordering Portal",
    description: "Browse live catalogs at your dealer pricing, place and reorder anytime, and track every order in one account.",
    access: "dealer", file: ORDERING, featured: true },
  { manufacturer: "", category: "", type: "resource", title: "Showroom Designer Platform",
    description: "Plan product placement, optimize your floor layout, and build a more profitable product mix with a HCPS consultant.",
    access: "public", file: "/dealer-support/?request=Showroom%20Consultation", featured: true },
  { manufacturer: "", category: "", type: "form", title: "Dealer Pricing Request",
    description: "Request dealer pricing access and program information across your manufacturer lines.",
    access: "request", file: "/dealer-support/?request=Pricing%20Access" },
  { manufacturer: "", category: "", type: "training", title: "Schedule an HCPS In-Service",
    description: "Book hands-on, manufacturer-specific product training for your sales and clinical staff.",
    access: "public", file: "/dealer-support/?request=Request%20an%20In-Service" },
  { manufacturer: "", category: "", type: "marketing", title: "Dealer Marketing & Launch Support",
    description: "Product launch materials, sales tools, showroom assets, and promotional resources for your storefront.",
    access: "request", file: "/dealer-support/?request=Marketing%20Support" },
  { manufacturer: "", category: "", type: "clinical", title: "Clinical & Reimbursement Resources",
    description: "Clinical education, product-outcome, and reimbursement-related information — request by product line.",
    access: "request", file: "/dealer-support/?request=Technical%20Support" },
);

// ---- Per-manufacturer resources (seeded, all actionable) ----
for (const m of manufacturers) {
  if (m.active === false) continue;
  const cat = categoryFor(m);
  const site = m.website || `/manufacturers/${m.id}/`;
  const order = m.ordering_url || ORDERING;
  items.push(
    { manufacturer: m.id, category: cat, type: "resource",
      title: `${m.name} — Line Overview`,
      description: `Product ladder, positioning, and dealer story for ${m.name} (${m.category || "HME/DME"}).`,
      access: "public", file: `/manufacturers/${m.id}/`, featured: !!m.featured },
    { manufacturer: m.id, category: cat, type: "catalog",
      title: `${m.name} — Catalogs & Literature`,
      description: `Manufacturer catalogs, product-line brochures, and current literature for ${m.name}.`,
      access: "public", file: site },
    { manufacturer: m.id, category: cat, type: "guide",
      title: `${m.name} — Product Guides & Specs`,
      description: `Product specifications, comparison and selling guides, and setup information.`,
      access: "request", file: "/dealer-support/?request=Order%20Literature" },
    { manufacturer: m.id, category: cat, type: "form",
      title: `${m.name} — Credit Application & Dealer Forms`,
      description: `Manufacturer credit application, dealer account setup, and onboarding forms.`,
      access: "request", file: "/dealer-support/?request=Pricing%20Access" },
    { manufacturer: m.id, category: cat, type: "training",
      title: `${m.name} — Training & In-Service`,
      description: `Staff product education and a manufacturer-specific in-service for your team.`,
      access: "request", file: "/dealer-support/?request=Request%20an%20In-Service" },
    { manufacturer: m.id, category: cat, type: "resource",
      title: `${m.name} — Online Ordering`,
      description: `Order ${m.name} products at your dealer pricing, 24/7.`,
      access: "dealer", file: order },
  );
}

// stable ids for anchors / analytics
items.forEach((it, i) => { it.id = it.id || ("res-" + (i + 1)); });

module.exports = { types, categories, items };
