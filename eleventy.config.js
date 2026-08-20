module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // The admin editor is a static app copied verbatim to /admin — it must NOT be
  // processed as a Nunjucks template (its JS contains braces Eleventy would choke on).
  eleventyConfig.addPassthroughCopy({ "src/admin": "admin" });
  eleventyConfig.ignores.add("src/admin/**");

  // Convert a normal YouTube / Vimeo / Google Drive share link into an embeddable URL.
  // Pass-through if it's already an embed URL or unrecognized.
  eleventyConfig.addFilter("embed", (url) => {
    if (!url) return "";
    let u = String(url).trim();
    // Tolerate a full <iframe ...> paste: pull the src out of it first.
    const iframeSrc = u.match(/src\s*=\s*["']([^"']+)["']/i);
    if (iframeSrc) u = iframeSrc[1];
    let m;
    // Start time may arrive as t= or start=
    const t = (u.match(/[?&#](?:t|start)=(\d+)/) || [])[1];
    if ((m = u.match(/[?&]v=([\w-]+)/)) || (m = u.match(/youtu\.be\/([\w-]+)/)) || (m = u.match(/youtube\.com\/(?:embed|shorts)\/([\w-]+)/))) {
      return "https://www.youtube.com/embed/" + m[1] + (t ? "?start=" + t : "");
    }
    if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/))) return "https://drive.google.com/file/d/" + m[1] + "/preview";
    if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/))) return "https://player.vimeo.com/video/" + m[1];
    return u;
  });

  eleventyConfig.addFilter("byManufacturer", (docs, manuId) =>
    (docs || []).filter((d) => d.manufacturer === manuId)
  );

  eleventyConfig.addFilter("publicOnly", (docs) =>
    (docs || []).filter((d) => d.access === "public")
  );

  eleventyConfig.addFilter("typeLabel", (typeId, types) => {
    const t = (types || []).find((x) => x.id === typeId);
    return t ? t.label : typeId;
  });

  // Resource-library helpers (standardized documents.json schema)
  eleventyConfig.addFilter("typeColor", (typeId, types) => {
    const t = (types || []).find((x) => x.id === typeId);
    return t && t.color ? t.color : "#5a6675";
  });
  eleventyConfig.addFilter("typeNeed", (typeId, types) => {
    const t = (types || []).find((x) => x.id === typeId);
    return t && t.need ? t.need : "";
  });
  eleventyConfig.addFilter("catLabel", (catId, cats) => {
    const c = (cats || []).find((x) => x.id === catId);
    return c ? c.label : catId;
  });
  eleventyConfig.addFilter("manuLabel", (id, list) => {
    const m = (list || []).find((x) => x && x.id === id);
    if (m) return m.name;
    const extra = { "complete-medical-supplies": "Complete Medical / Blue Jay" };
    return extra[id] || String(id || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  });
  eleventyConfig.addFilter("countIn", (items, field, values) =>
    (items || []).filter((i) => (values || []).indexOf(i[field]) > -1).length
  );

  eleventyConfig.addFilter("countBy", (docs, manuId) =>
    (docs || []).filter((d) => d.manufacturer === manuId).length
  );

  // --- Centralized manufacturer <-> resource mapping helpers -------------------
  // Resolve a manufacturer record by its id from a list (e.g. activeManufacturers).
  // NOTE: Nunjucks has no `equalto` test, so `selectattr("id","equalto",id) | first`
  // silently returned the FIRST manufacturer (Golden) for every item — this replaces it.
  eleventyConfig.addFilter("manuById", (list, id) =>
    (list || []).find((m) => m && m.id === id) || null
  );

  // Map a manufacturer's free-text category to a Resources product-category id, so a
  // resource inherits its category from the ONE manufacturer record (keyword, first hit).
  eleventyConfig.addFilter("resourceCat", (categoryString) => {
    const s = String(categoryString || "").toLowerCase();
    if (/ramp/.test(s)) return "ramps";
    if (/oxygen/.test(s)) return "oxygen";
    if (/respirat|airway|cough/.test(s)) return "respiratory";
    if (/apnea|epap|cpap/.test(s)) return "sleep";
    if (/bed|mattress|surface|healthcare sleep/.test(s)) return "sleep-surfaces";
    if (/brac|ortho/.test(s)) return "bracing";
    if (/bath/.test(s)) return "bath-safety";
    if (/foot/.test(s)) return "footcare";
    if (/stair|patient lift|hand truck/.test(s)) return "lifts";
    if (/recliner|lift chair|seating/.test(s)) return "lift-chairs";
    if (/wheelchair|mobility|scooter|transport|rollator/.test(s)) return "mobility";
    return "";
  });

  // Resources product-category taxonomy (the filter dropdown). Central + reusable.
  eleventyConfig.addGlobalData("resourceCategories", [
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
  ]);

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "html", "md"]
  };
};
