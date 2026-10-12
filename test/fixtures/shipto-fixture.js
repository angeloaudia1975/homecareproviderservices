/* Phase C Ship-To review fixture: the REAL Strongback order-export header with FICTIONAL dealers and orders.
   Shared by test/shipto-review.test.js and test/mi-c.ui.js. */
// The REAL Strongback order-export header (44 columns, 2026), with fictional dealers.
const HEADER = 'Number,Status,Subtotal,Discount,Shipping,Total,"Payment Due Date","Amount Paid","Fully Paid","Date Fully Paid","Customer Notes","Staff Notes",PO,"Created Date","Created Time","Line Item Quantity","Line Item Name","Line Item Sku","Line Item UPC","Line Item [""MSRP""]","Line Item Wholesale Price","Line Item Shipped Quantity","Customer Username","Company Name","Customer Name",Email,"Shipping Name","Shipping Address","Shipping Address 2","Shipping City","Shipping State","Shipping Zip Code","Shipping Country","Billing Name","Billing Address","Billing Address 2","Billing City","Billing State","Billing Zip Code","Billing Country","Ship By Date","Fully Shipped","Date Fully Shipped","Tax Amount"';
const COLS = HEADER.match(/("([^"]|"")*"|[^,]+)/g).length;
function line(o) {
  const v = Array(COLS).fill('');
  const set = (i, x) => { v[i] = x == null ? '' : String(x); };
  set(0, o.n); set(1, 'Shipped'); set(6, '10/30/2026'); set(13, o.date || '2026-09-10'); set(15, o.qty || 1); set(16, o.item || 'Chair'); set(17, o.sku || '1007AB');
  set(20, o.price == null ? '500.00' : o.price); set(22, o.user || ''); set(23, o.company || ''); set(24, 'Buyer'); set(25, 'b@x.test');
  set(26, o.sname || ''); set(27, o.saddr || ''); set(29, o.scity || ''); set(30, o.sstate || ''); set(31, o.szip || ''); set(32, o.szip ? 'US' : '');
  set(33, o.bname || o.company || ''); set(34, o.baddr || ''); set(36, o.bcity || ''); set(37, o.bstate || ''); set(38, o.bzip || '');
  return v.map(x => /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x).join(',');
}
const W = { user: 'wilburbros', company: 'Wilbur Brothers Healthcare Pharmacy', bcity: 'Washington', bstate: 'Indiana', bzip: '47501', baddr: '10 W Main Street' };
const CSV = [HEADER,
  line({ n: 7139, user: 'harmonia', company: 'Harmonia Medical Supply', sname: 'Harmonia Medical Supply', saddr: '415 Vigo Street', scity: 'Vincennes', sstate: 'IN', szip: '47591-1143' }),
  line({ n: 7139, sku: '1010AB', user: 'harmonia', company: 'Harmonia Medical Supply', sname: 'Harmonia Medical Supply', saddr: '415 Vigo Street', scity: 'Vincennes', sstate: 'IN', szip: '47591-1143', price: '541.00' }),
  line(Object.assign({ n: 7191, sname: 'Wilbur Brothers Princeton', saddr: '101 W. Brumfield Avenue', scity: 'Princeton', sstate: 'Indiana', szip: '47670', price: '0.00', qty: 25 }, W)),
  line(Object.assign({ n: 7200, sname: 'Wilbur Brothers', saddr: '9 New Plaza', scity: 'Evansville', sstate: 'Indiana', szip: '47999' }, W)),
  line(Object.assign({ n: 7201 }, W)),
  line({ n: 7202, user: 'twinco', company: 'Twin Care', sname: 'Twin Care', scity: 'Jasper', sstate: 'IN', szip: '47546' }),
  line({ n: 7203, user: 'nobody', company: 'Unknown Mobility LLC', sname: 'Unknown', scity: 'Nowhere', sstate: 'OH', szip: '45000' }),
  line(Object.assign({ n: 7204, sname: 'Wilbur Brothers Princeton', saddr: '101 W. Brumfield Avenue', scity: 'Princeton', sstate: 'IN', szip: '47670' }, W)),
  line(Object.assign({ n: 7204, sname: 'Wilbur Brothers Jasper', saddr: '5 Newton St', scity: 'Jasper', sstate: 'IN', szip: '47546' }, W)),
  line({ n: 7210, user: 'boston', company: 'Boston Rehab', sname: 'Boston Rehab', saddr: '1 Main St', scity: 'Boston', sstate: 'MA', szip: '02134' }),
].join('\r\n') + '\r\n';
const BYTES = Buffer.from(CSV, 'utf8');
const SHA = require('crypto').createHash('sha256').update(BYTES).digest('hex');

const DEALERS = [
  { id: 'harm', business_name: 'Harmonia Medical Supply', parent_id: null, city: 'Vincennes', state: 'IN', zip: '47591', address: '415 Vigo St' },
  { id: 'whq', business_name: 'Wilbur Brothers Healthcare Pharmacy', parent_id: null, city: 'Washington', state: 'IN', zip: '47501', address: '10 W Main St' },
  { id: 'wpr', business_name: 'Wilbur Brothers Princeton', parent_id: 'whq', city: 'Princeton', state: 'IN', zip: '47670', address: '101 W Brumfield Ave' },
  { id: 'wja', business_name: 'Wilbur Brothers Jasper', parent_id: 'whq', city: 'Jasper', state: 'IN', zip: '47546', address: '5 Newton St' },
  { id: 'thq', business_name: 'Twin Care', parent_id: null, city: 'Jasper', state: 'IN', zip: '47546', address: '1 A St' },
  { id: 'tb2', business_name: 'Twin Care East', parent_id: 'thq', city: 'Jasper', state: 'IN', zip: '47546', address: '2 B St' },
  { id: 'bos', business_name: 'Boston Rehab', parent_id: null, city: 'Boston', state: 'MA', zip: '02134', address: '1 Main St' },
  { id: 'tst', business_name: 'Unknown Mobility LLC', parent_id: null, city: 'Nowhere', state: 'OH', zip: '45000', is_test: true },
];
const ACCOUNTS = [{ dealer_id: 'whq', account_ref: 'WilburBros' }, { dealer_id: 'harm', account_ref: 'harmonia' }, { dealer_id: 'thq', account_ref: 'twinco' }, { dealer_id: 'bos', account_ref: 'boston' }];

module.exports = { HEADER, COLS, line, W, CSV, BYTES, SHA, DEALERS, ACCOUNTS };
