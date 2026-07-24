module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // The admin editor is a static app copied verbatim to /admin — it must NOT be
  // processed as a Nunjucks template (its JS contains braces Eleventy would choke on).
  eleventyConfig.addPassthroughCopy({ "src/admin": "admin" });
  eleventyConfig.ignores.add("src/admin/**");

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

  eleventyConfig.addFilter("countBy", (docs, manuId) =>
    (docs || []).filter((d) => d.manufacturer === manuId).length
  );

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "html", "md"]
  };
};
