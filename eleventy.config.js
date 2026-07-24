module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

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
