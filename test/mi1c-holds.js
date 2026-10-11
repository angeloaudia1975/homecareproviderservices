/* The recorded holds as the MI-1c migration seeds them (supabase/mi1c_dealer_intel.sql, table mfr_intel_holds) — read
   from the migration text itself, so the JS tests use exactly what the database will hold (one source, no copy). */
const fs = require('fs'), path = require('path');
const SQL = process.env.MI1C_SQL || path.join(__dirname, '..', 'supabase', 'mi1c_dealer_intel.sql');
const un = s => s.replace(/''/g, "'");
function holds() {
  const src = fs.readFileSync(SQL, 'utf8');
  const re = /values \('([a-z0-9-]+)', public\.hcps_mfr_intel_name_key\('((?:[^']|'')+)'\), '((?:[^']|'')+)',\s*'((?:[^']|'')+)'/g;
  const out = []; let m;
  while ((m = re.exec(src))) out.push({ manufacturer: m[1], printed_name: un(m[3]), reason: un(m[4]) });
  if (!out.length) throw new Error('no recorded hold found in ' + SQL);
  return out;
}
module.exports = { holds, strongback: () => holds().filter(h => h.manufacturer === 'strongback-mobility') };
