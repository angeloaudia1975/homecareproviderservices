/* Copies the Commission Report Import page readers VERBATIM into netlify/functions/_commission_rows.js (between its
   BEGIN/END markers). Run after changing the page:  node test/commission-rows.extract.js
   test/commission-rows.test.js fails whenever the page and the server copy differ. */
const fs = require('fs'), path = require('path');
const { grabDecl } = require('./extract-picker.js');
const PAGE = path.join(__dirname, '..', 'src', 'admin', 'import-commissions.html');
const MOD = path.join(__dirname, '..', 'netlify', 'functions', '_commission_rows.js');
const DECLS = ['const numv=', 'const FIELDS=', 'const GROUPED_LINES=', 'const A4U_PO=', 'function parseGrouped(', 'const LEDGER_TWO_TAB=', 'function parseGce('];
const BEGIN = '/* BEGIN verbatim page readers */\n', END = '\n/* END verbatim page readers */';
function pageBlock(src) { return DECLS.map(a => grabDecl(src, a)).join('\n'); }
function moduleBlock(mod) { const i = mod.indexOf(BEGIN), j = mod.indexOf(END); if (i < 0 || j < 0) throw new Error('markers missing'); return mod.slice(i + BEGIN.length, j); }
module.exports = { pageBlock, moduleBlock, PAGE, MOD, DECLS };
if (require.main === module) {
  const mod = fs.readFileSync(MOD, 'utf8'), blk = pageBlock(fs.readFileSync(PAGE, 'utf8'));
  const i = mod.indexOf(BEGIN), j = mod.indexOf(END);
  fs.writeFileSync(MOD, mod.slice(0, i + BEGIN.length) + blk + mod.slice(j));
  console.log('copied ' + DECLS.length + ' declarations');
}
