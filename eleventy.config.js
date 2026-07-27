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
    const u = String(url).trim();
    let m;
    if ((m = u.match(/[?&]v=([\w-]+)/)) || (m = u.match(/youtu\.be\/([\w-]+)/)) || (m = u.match(/youtube\.com\/(?:embed|shorts)\/([\w-]+)/))) {
      const t = (u.match(/[?&#]t=(\d+)/) || [])[1];
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
