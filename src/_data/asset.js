// Cache-busting version stamp for the stylesheet. Produces a short hash of
// site.css so the <link> URL changes whenever the CSS content changes — which
// lets us keep long/immutable caching on /assets while still shipping updates
// instantly to returning visitors.
const fs = require("fs");
const crypto = require("crypto");

module.exports = () => {
  let cssVersion = "1";
  try {
    const css = fs.readFileSync(__dirname + "/../assets/css/site.css");
    cssVersion = crypto.createHash("md5").update(css).digest("hex").slice(0, 8);
  } catch (e) {
    // fall back to "1" if the file can't be read at build time
  }
  return { cssVersion };
};
