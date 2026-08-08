// Only published landing pages with a slug are generated as pages. Editing landing.json in
// the admin controls this list; unpublished drafts never produce a live URL.
let list = [];
try { list = require("./landing.json"); } catch (e) { list = []; }
module.exports = (Array.isArray(list) ? list : []).filter(function (x) { return x && x.published && x.slug; });
