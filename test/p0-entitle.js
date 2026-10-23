/* P0 (2026-10-23): orders-api prices and orders only the lines a dealer carries (its active
   dealer_manufacturers rows). Test worlds whose dealer orders lines grant them here: every line the
   storefront lists plus the slugs the suites use for their own fixtures. */
const fs = require('fs'), path = require('path');
const ORD = process.env.ORDER_REPO || path.join(__dirname, '..', '..', 'homecareproviderservicesordering');
let shop = [];
try { shop = JSON.parse(fs.readFileSync(path.join(ORD, 'public', 'data', 'manufacturers.json'), 'utf8')).map(m => m.slug); } catch (e) {}
const LINES = [...new Set(shop.concat(['ovation-medical', 'bemis', 'strongback-mobility', 'climbing-steps', 'bemis-copy', 'ohio-medical', 'gce', 'other-line']))];
module.exports = (dealerId, lines) => (lines || LINES).map(manufacturer => ({ dealer_id: dealerId, manufacturer, active: true }));
