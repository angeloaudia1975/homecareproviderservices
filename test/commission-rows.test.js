/* The server commission-statement reader (_commission_rows.js): its page readers are a VERBATIM copy of the Commission
   Report Import page (drift test), and readStatement reads each supported shape and refuses everything it cannot read
   reliably.  node test/commission-rows.test.js */
const fs = require('fs'), assert = require('assert');
const XLSX = require('xlsx');
const X = require('./commission-rows.extract.js');
const CR = require('../netlify/functions/_commission_rows.js');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + String(e.message).split('\n')[0]); } };
const book = sheets => { const wb = XLSX.utils.book_new(); for (const [n, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };

t('drift: the server copy of the page readers is byte-identical to the page', () => {
  assert.strictEqual(X.moduleBlock(fs.readFileSync(X.MOD, 'utf8')), X.pageBlock(fs.readFileSync(X.PAGE, 'utf8')));
});
t('drift: every copied declaration is present in the page (anchors still match)', () => {
  const page = fs.readFileSync(X.PAGE, 'utf8'); for (const a of X.DECLS) assert.ok(page.includes('\n' + a), a);
});
t('Access4U: the grouped ledger → payments (amount + commission) and open invoices (billed only)', () => {
  const b = book([['Sheet1', [['Transaction List by Client'], ['', 'Date', 'Transaction type', 'Num', 'Memo/Description', 'Amount', 'Net Sale', '%', 'Commission', 'Rep'],
    ['Mobility Plus'], ['', '09/03/2026', 'Payment', '1001', 'R-5001 paid', '1000.00', '980.00', '5', '49.00', 'AA'], ['', '09/04/2026', 'Invoice', 'r-5002', 'PO 77', '400.00', '', '5', '', 'AA'],
    ['Total for Mobility Plus'], ['', '09/05/2026', 'Credit', 'X', '', '1', '', '', '', '']]]]);
  const r = CR.readStatement(b, 'xlsx', 'access4u', null);
  assert.strictEqual(r.reader, 'grouped_ledger'); assert.strictEqual(r.ledger, true); assert.strictEqual(r.rows.length, 2);
  assert.deepStrictEqual([r.rows[0].line_type, r.rows[0].amount, r.rows[0].commission, r.rows[0].invoice_no], ['payment', 980, 49, 'R-5001']);
  assert.deepStrictEqual([r.rows[1].line_type, r.rows[1].amount, r.rows[1].billed_amount, r.rows[1].invoice_no], ['invoice', null, 400, 'R-5002']);
});
t('Ohio Medical: the two named sheets (open invoices skip "Invoice Paid = Yes"; payments carry earned commission)', () => {
  const H = ['Customer Name', 'Cust #', 'Ship To Name', 'Address1', 'City', 'State', 'Zip', 'Part Number', 'Part Description', 'Quantity', 'Sales $', 'Comm %', 'Order Date', 'Inv Number', 'Sales Rep', 'Invoice Paid', 'Earned Commission $'];
  const b = book([['Summary', [['x']]], ['Sales-Commission Data', [H, ['Med Mart', '77', 'Med Mart', '1 Main', 'Nashville', 'TN', '37211', 'P1', 'Desc', '1', '100', '5', '2026-08-02', 'INV1', 'AA', 'No', ''],
    ['Med Mart', '77', 'Med Mart', '1 Main', 'Nashville', 'TN', '37211', 'P2', 'Desc', '1', '50', '5', '2026-08-03', 'INV2', 'AA', 'Yes', '']]],
    ['Current month payment', [H, ['Med Mart', '77', 'Med Mart', '1 Main', 'Nashville', 'TN', '37211', 'P2', 'Desc', '1', '50', '5', '2026-08-03', 'INV2', 'AA', 'Yes', '2.50']]]]);
  const r = CR.readStatement(b, 'xlsx', 'ohio-medical', null);
  assert.strictEqual(r.reader, 'two_tab_ledger'); assert.strictEqual(r.rows.length, 2);
  assert.deepStrictEqual(r.rows.map(x => [x.line_type, x.invoice_no]), [['invoice', 'INV1'], ['payment', 'INV2']]);
  assert.strictEqual(r.rows[1].commission, '2.50');
});
t('template: found on a later header row, every saved column required, only dealer lines kept', () => {
  const csv = Buffer.from('Report,,\n\nCustomerName,ExtendedPrice,CommissionAmount\nMed Mart,10.00,1.00\n,,\nMobility Plus,20.00,2.00\n');
  const r = CR.readStatement(csv, 'csv', 'golden-technologies', { customer_name: 'CustomerName', amount: 'ExtendedPrice', commission: 'CommissionAmount' });
  assert.strictEqual(r.header_row, 3); assert.strictEqual(r.rows.length, 2); assert.deepStrictEqual(r.mapped_fields.sort(), ['amount', 'commission', 'customer_name']);
});
t('template refusals: none saved / missing dealer-amount-commission / a saved column absent', () => {
  const csv = Buffer.from('CustomerName,ExtendedPrice\nMed Mart,10\n');
  assert.strictEqual(CR.readStatement(csv, 'csv', 'bemis', null).error, 'no_template');
  assert.strictEqual(CR.readStatement(csv, 'csv', 'x', {}).error, 'no_template');
  assert.strictEqual(CR.readStatement(csv, 'csv', 'x', { customer_name: 'CustomerName', amount: 'ExtendedPrice' }).error, 'template_incomplete');
  assert.strictEqual(CR.readStatement(csv, 'csv', 'x', { customer_name: 'CustomerName', amount: 'ExtendedPrice', commission: 'CommissionAmount' }).error, 'template_does_not_fit');
});
t('never read automatically: PDF, email body, other types; an empty ledger is an error, not zero rows imported', () => {
  assert.strictEqual(CR.readStatement(Buffer.from('%PDF'), 'pdf', 'airavant-bongorx', {}).error, 'pdf_statement');
  assert.strictEqual(CR.readStatement(Buffer.from('x'), 'eml', 'climbing-steps', {}).error, 'body_report');
  assert.strictEqual(CR.readStatement(Buffer.from('x'), 'docx', 'x', {}).error, 'unsupported_format');
  assert.strictEqual(CR.readStatement(book([['S', [['nothing']]]]), 'xlsx', 'access4u', null).error, 'no_rows');
});
console.log(`\ncommission-rows: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
