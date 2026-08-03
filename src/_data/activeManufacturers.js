// Eleventy global data: the manufacturers actually shown on the site — every entry
// except ones marked hidden in the Website editor. This one list drives every logo row,
// card grid, dropdown, and generated manufacturer page, AND the live "N manufacturers"
// count on the homepage. So adding, hiding, or removing a manufacturer updates the whole
// site (including the count) automatically on the next build.
const list = require("./manufacturers.json");
module.exports = list.filter((m) => m && m.hidden !== true);
