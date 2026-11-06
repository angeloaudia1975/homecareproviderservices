/* C3-07 Stage 5 — manufacturer account applications: the ORIGINAL application PDF of each manufacturer and where the
   dealer's answers and signature go on it.

   Every application is the manufacturer's own file (src/assets/docs, bundled with the function, SHA-256 pinned — a
   replaced file stops signing until its layout is reviewed). Three ways a form is completed:
     fill     the PDF's own fillable fields, then flattened              (Climbing Steps, Strongback, ABM, PediFix, AirAvant)
     overlay  printed text placed after each printed label (_app_forms_layout.json, built by scripts/app-forms-layout.py)
                                                                        (Access4U, Ovation)
     addendum the original pages untouched + an "Application details" page with every answer (Bemis, Yuwell, Dalton)
   Any answer a form has no place for is listed on the details page, so nothing the dealer entered is lost.
   Signature and date boxes are Documenso fields, completed by the dealer's authorised signer when signing; a few values a
   form asks for but HCPS never stores (SSNs, bank account numbers) are left for the signer to type into the signing
   screen ("signerText") — they exist only inside the signed PDF.
   Golden Technologies (Nuvo), Ohio Medical (online registration) and Corsicana (Word form) keep their own process.
   Coordinates: PDF points, origin TOP-LEFT, page from 1. */
const LAYOUT = require('./_app_forms_layout.json');

/* the questionnaire — one set of answers serves every form */
const SECTIONS = [
  ['Business', [['biz.legal_name', 'Legal business name', 'req'], ['biz.dba', 'DBA / trade name'], ['biz.address', 'Street address', 'req'], ['biz.city', 'City', 'req'],
    ['biz.state', 'State', 'req'], ['biz.zip', 'ZIP', 'req'], ['biz.phone', 'Phone', 'req'], ['biz.fax', 'Fax'], ['biz.email', 'Business email', 'req'], ['biz.website', 'Website'],
    ['biz.ein', 'Federal tax ID (EIN)', 'req'], ['biz.resale_no', 'Sales-tax resale certificate #'], ['biz.npi', 'NPI / DME #'], ['biz.entity', 'Entity type'],
    ['biz.state_inc', 'State of incorporation'], ['biz.started', 'Date business started'], ['biz.years', 'Years in business'], ['biz.nature', 'Nature of business'],
    ['biz.employees', 'Number of employees'], ['biz.annual_volume', 'Expected annual purchases'], ['biz.sales_area', 'Sales area / territory']]],
  ['Ship-to', [['ship.address', 'Ship-to street'], ['ship.city', 'Ship-to city'], ['ship.state', 'Ship-to state'], ['ship.zip', 'Ship-to ZIP']]],
  ['Contacts', [['purch.name', 'Purchasing contact'], ['purch.phone', 'Purchasing phone'], ['purch.email', 'Purchasing email'],
    ['ap.name', 'Accounts payable contact', 'req'], ['ap.phone', 'Accounts payable phone'], ['ap.email', 'Accounts payable email', 'req']]],
  ['Owners / officers', [['owner1.name', 'Owner / officer 1 name', 'req'], ['owner1.title', 'Title'], ['owner1.phone', 'Phone'], ['owner1.email', 'Email'], ['owner1.address', 'Home or business address'],
    ['owner2.name', 'Owner / officer 2 name'], ['owner2.title', 'Title'], ['owner2.phone', 'Phone'], ['owner2.email', 'Email'], ['owner2.address', 'Home or business address']]],
  ['Bank', [['bank.name', 'Bank name'], ['bank.contact', 'Bank contact'], ['bank.phone', 'Bank phone'], ['bank.address', 'Bank street'], ['bank.city', 'Bank city'],
    ['bank.state', 'Bank state'], ['bank.zip', 'Bank ZIP']]],
  ['Trade references', [1, 2, 3].flatMap((n) => [[`ref${n}.name`, `Reference ${n} business`], [`ref${n}.contact`, 'Contact'], [`ref${n}.phone`, 'Phone'], [`ref${n}.fax`, 'Fax'],
    [`ref${n}.email`, 'Email'], [`ref${n}.address`, 'Street'], [`ref${n}.city`, 'City'], [`ref${n}.state`, 'State'], [`ref${n}.zip`, 'ZIP'], [`ref${n}.account`, 'Your account # with them']])],
  ['Signer', [['signer.name', 'Authorised signer (full name)', 'req'], ['signer.title', 'Signer title', 'req'], ['signer.email', 'Signer email', 'req']]],
  ['Request', [['req.terms', 'Requested terms'], ['req.credit_limit', 'Requested credit limit'], ['req.notes', 'Notes for HCPS']]],
];
const FIELDS = new Map(); for (const [sec, list] of SECTIONS) for (const [k, label, req] of list) FIELDS.set(k, { key: k, label, section: sec, required: req === 'req' });
const ENTITIES = { corporation: 'Corporation', s_corp: 'S Corporation', llc: 'LLC', partnership: 'Partnership', proprietorship: 'Sole proprietorship', other: 'Other' };

/* derived values a form may ask for in one box */
function derived(a) {
  const j = (...p) => p.filter(Boolean).join(', ');
  const csz = (c, s, z) => j(c, [s, z].filter(Boolean).join(' '));
  const d = {
    'biz.csz': csz(a['biz.city'], a['biz.state'], a['biz.zip']), 'ship.csz': csz(a['ship.city'], a['ship.state'], a['ship.zip']),
    'biz.full_address': j(a['biz.address'], csz(a['biz.city'], a['biz.state'], a['biz.zip'])),
    'bank.full_address': j(a['bank.address'], csz(a['bank.city'], a['bank.state'], a['bank.zip'])), 'bank.sz': [a['bank.state'], a['bank.zip']].filter(Boolean).join(' '),
    'biz.entity_label': ENTITIES[a['biz.entity']] || '', 'signer.name_title': j(a['signer.name'], a['signer.title']),
    'biz.billing_line': j(a['biz.address'], csz(a['biz.city'], a['biz.state'], a['biz.zip'])),
  };
  for (const n of [1, 2, 3]) { d[`ref${n}.full_address`] = j(a[`ref${n}.address`], csz(a[`ref${n}.city`], a[`ref${n}.state`], a[`ref${n}.zip`])); d[`ref${n}.sz`] = [a[`ref${n}.state`], a[`ref${n}.zip`]].filter(Boolean).join(' '); }
  return d;
}

/* box(page, x, top, w, h) in points → Documenso percentages */
const box = (page, x, top, w, h, H = 792, W = 612) => ({ page, positionX: +(x / W * 100).toFixed(3), positionY: +(top / H * 100).toFixed(3), width: +(w / W * 100).toFixed(3), height: +(h / H * 100).toFixed(3) });

const FORMS = {
  'climbing-steps': { name: 'Climbing Steps', file: 'climbing-steps-dealer-application-2025-hps-ms84xfg3.pdf', sha256: '3c0541e5a32b0affef33a6d579539f30291f872cef86bfa893b7151131ba1015', mode: 'fill',
    fill: { 'Company Name': 'biz.legal_name', 'Address': 'biz.address', 'City': 'biz.city', 'State': 'biz.state', 'Zip': 'biz.zip', 'Address_2': 'ship.address', 'City_2': 'ship.city',
      'State_2': 'ship.state', 'Zip_2': 'ship.zip', 'Phone': 'biz.phone', 'Email': 'biz.email', 'Fax': 'biz.fax', 'Company Website': 'biz.website', 'Date business commenced': 'biz.started',
      'Resale Certificate Number': 'biz.resale_no', 'Primary Contact': 'owner1.name', 'Title': 'owner1.title', 'Phone_2': 'owner1.phone', 'Email_2': 'owner1.email',
      'Alternate Contact': 'owner2.name', 'Title_2': 'owner2.title', 'Phone_3': 'owner2.phone', 'Email_3': 'owner2.email', 'Purchasing Contact': 'purch.name', 'Phone_4': 'purch.phone',
      'Email_4': 'purch.email', 'Accounts Payable Contact': 'ap.name', 'Phone_5': 'ap.phone', 'Email_5': 'ap.email', 'Name Printed_2': 'signer.name', 'Title_4': 'signer.title' },
    sign: [box(1, 89, 792 - 172, 215, 33)], date: [box(1, 336, 792 - 170, 200, 30)] },
  'strongback-mobility': { name: 'Strongback Mobility', file: '2026-dealer-account-application-hps-mud66qww.pdf', sha256: 'a1131ae0b2e7f4b08e1433b440beaba1b28bb253a4e48680748fef5b122a7e9b', mode: 'fill',
    fill: { 'Dealer Name': 'biz.legal_name', 'Business Name': 'biz.dba', 'Billing Address': 'biz.address', 'City State Zip Code': 'biz.csz', 'Country': '=USA', 'Telephone': 'biz.phone',
      'Fax': 'biz.fax', 'Email': 'biz.email', 'Shipping Address': 'ship.address', 'City State Zip Code_2': 'ship.csz', 'Country_2': '=USA', 'Telephone_2': 'purch.phone', 'Email_2': 'purch.email',
      'Bank Name': 'bank.name', 'Bank Location City': 'bank.city', 'Telephone_3': 'bank.phone', 'State Zip Code': 'bank.sz', 'Bank Contact': 'bank.contact',
      'How long in business': 'biz.years', 'Primary business activity': 'biz.nature', 'Tax Exempt': 'biz.resale_no', 'Fed ID or SS': 'biz.ein',
      '1 Name': 'ref1.name', 'Telephone_4': 'ref1.phone', 'Address City': 'ref1.full_address', 'State Zip Code_2': 'ref1.sz', 'Type of Account': 'ref1.account',
      '2  Name': 'ref2.name', 'Telephone_5': 'ref2.phone', '2 Address City 2': 'ref2.full_address', 'State Zip Code_3': 'ref2.sz', 'Type of Account #2': 'ref2.account',
      '1 Name_2': 'owner1.name', 'Telephone_6': 'owner1.phone', 'Address City_3': 'owner1.address', '1 Title 2': 'owner1.title',
      '2  Name_2': 'owner2.name', 'Telephone_7': 'owner2.phone', 'Address City_4': 'owner2.address', '2 Title 2': 'owner2.title', 'NAME': 'signer.name', 'TITLE': 'signer.title' },
    check: { 'biz.entity': { corporation: 'Corporation', s_corp: 'Corporation', partnership: 'Partnership', proprietorship: 'Propreitorship' } },
    sign: [box(1, 78, 792 - 86, 160, 19)], date: [box(1, 275, 792 - 86, 132, 19)], dateTop: [box(1, 50, 792 - 776, 142, 18)] },
  'abm-respiratory-care': { name: 'ABM Respiratory Care', file: 'abm-respiratory-care-dealer-application-2026-mw3trycz.pdf', sha256: '5bf7ebe217f79946ea2ed8f5180af66339177800390ea440252a4c0fcdc008fd', mode: 'fill',
    fill: { 'LEGAL NAME OF BUSINESS': 'biz.legal_name', 'TRADE NAMES OR DBAS': 'biz.dba', 'EXPECTED ANNUAL PURCHASE VOLUME': 'biz.annual_volume', 'BILLING ADDRESS CITY STATE ZIP': 'biz.billing_line',
      'BILLING EMAIL': 'ap.email', 'BILLING PHONE': 'ap.phone', 'FEDERAL TAX ID': 'biz.ein', 'BUSINESS START DATE': 'biz.started', 'STATE OF INCORPORATION': 'biz.state_inc',
      'WEBSITE': 'biz.website', 'FIRST  LAST NAMEACCOUNTS PAYABLE': 'ap.name', 'EMAIL ADDRESSACCOUNTS PAYABLE': 'ap.email', 'PHONEACCOUNTS PAYABLE': 'ap.phone',
      'FIRST  LAST NAMEPURCHASING': 'purch.name', 'EMAIL ADDRESSPURCHASING': 'purch.email', 'PHONEPURCHASING': 'purch.phone',
      'MEDICAL FIELD SUPPLIERRow1': 'ref1.name', 'EMAILRow1': 'ref1.email', 'PHONERow1': 'ref1.phone', 'ACCOUNT NUMBERRow1': 'ref1.account',
      'MEDICAL FIELD SUPPLIERRow2': 'ref2.name', 'EMAILRow2': 'ref2.email', 'PHONERow2': 'ref2.phone', 'ACCOUNT NUMBERRow2': 'ref2.account',
      'MEDICAL FIELD SUPPLIERRow3': 'ref3.name', 'EMAILRow3': 'ref3.email', 'PHONERow3': 'ref3.phone', 'ACCOUNT NUMBERRow3': 'ref3.account',
      'TITLE': 'signer.title', 'PRINT NAME': 'signer.name' },
    sign: [box(2, 111, 792 - 321, 180, 27)], date: [box(2, 343, 792 - 273, 222, 27)] },
  pedifix: { name: 'PediFix', file: 'pedifix-credit-application-w-sales-tax-info-rev-feb-2022-mw3tvh1j.pdf', sha256: '42f4241c781c93c4838ce02cba8774796fcd7be8e1983fcd7deba5d06058f767', mode: 'fill',
    fill: { 'Company Name also note any other nameDBA': 'biz.legal_name', 'Billing Address': 'biz.address', 'City': 'biz.city', 'State': 'biz.state', 'Zip code': 'biz.zip', 'Phone': 'biz.phone',
      'Fax': 'biz.fax', 'Email Address': 'biz.email', 'Shipping Address If different from billing': 'ship.address', 'City_2': 'ship.city', 'State_2': 'ship.state', 'Zip code_2': 'ship.zip',
      'of Employees': 'biz.employees', 'Year Business Established': 'biz.started', 'TIN ID': 'biz.ein', 'Accounts Payable Contact': 'ap.name', 'Telephone': 'ap.phone',
      'Anticipated Credit Limit': 'req.credit_limit', '1 Name': 'owner1.name', 'Title': 'owner1.title', '2 Name': 'owner2.name', 'Title_2': 'owner2.title',
      'Name': 'ref1.name', 'Address': 'ref1.address', 'City_3': 'ref1.city', 'State_3': 'ref1.state', 'Zip': 'ref1.zip', 'Account': 'ref1.account', 'Phone_3': 'ref1.phone', 'Fax_3': 'ref1.fax', 'Email Address_3': 'ref1.email',
      'Name_2': 'ref2.name', 'Address_2': 'ref2.address', 'City_4': 'ref2.city', 'State_4': 'ref2.state', 'Zip_2': 'ref2.zip', 'Account_2': 'ref2.account', 'Phone_4': 'ref2.phone', 'Fax_4': 'ref2.fax', 'Email Address_4': 'ref2.email',
      'Name_3': 'ref3.name', 'Address_3': 'ref3.address', 'City_5': 'ref3.city', 'State_5': 'ref3.state', 'Zip_3': 'ref3.zip', 'Account_3': 'ref3.account', 'Phone_5': 'ref3.phone', 'Fax_5': 'ref3.fax', 'Email Address_5': 'ref3.email',
      'Print Name and Title': 'signer.name_title' },
    sign: [box(1, 389, 792 - 47, 198, 14)], date: [box(1, 62, 792 - 30, 112, 13)] },
  'airavant': { name: 'AirAvant Medical (BongoRx)', file: 'bongo-rx-airavant-medical-new-customer-credit-application-20-ms0lb7p9.pdf', sha256: '1e7c9e4541df89888256b16cdbb8d8efa54130e91aa9ed4fd770d64c34c48f64', mode: 'fill',
    fill: { 'Company Name': 'biz.legal_name', 'Year Established': 'biz.started', 'DBA (if applicable)': 'biz.dba', 'Phone #': 'biz.phone', 'Type of Business': 'biz.entity_label', 'Fax #': 'biz.fax',
      'Purchasing Contact': 'purch.name', 'Email': 'purch.email', 'Billing Address': 'biz.address', 'Billing City': 'biz.city', 'Billing State': 'biz.state', 'Billing Zip Code': 'biz.zip', 'Billing Country': '=USA',
      'Accounts Payable Contact': 'ap.name', 'Employer Identification Number': 'biz.ein', 'Accounts Payable Phone #': 'ap.phone', 'Sales Tax Identification Number': 'biz.resale_no',
      'Accounts Payable Email': 'ap.email', 'NPI or DME #': 'biz.npi', 'Ship to Address': 'ship.address', 'Ship to City': 'ship.city', 'Ship to State': 'ship.state', 'Ship to Zip Code': 'ship.zip', 'Ship to Country': '=USA',
      ...Object.fromEntries([1, 2, 3].flatMap((n) => [[`Reference ${n} Name`, `ref${n}.name`], [`Reference ${n} Phone #`, `ref${n}.phone`], [`Reference ${n} Fax #`, `ref${n}.fax`],
        [n === 2 ? 'Reference 2  Address' : `Reference ${n} Address`, `ref${n}.address`], [`Reference ${n} Customer #`, `ref${n}.account`], [`Reference ${n} City`, `ref${n}.city`],
        [`Reference ${n} State`, `ref${n}.state`], [n === 2 ? 'Reference 2   Zip Code' : `Reference ${n}  Zip Code`, `ref${n}.zip`]])),
      'Authorized Signer Title': 'signer.title' },
    drop: ['Clear', 'Print'], sign: [box(1, 50, 792 - 106, 250, 18)], date: [box(1, 517, 792 - 99, 60, 13)] },
  access4u: { name: 'Access4U', mode: 'overlay', layout: 'access4u', ...pick(LAYOUT.access4u),
    marks: { 'biz.entity': { corporation: [1, 140, 183], partnership: [1, 228, 183], proprietorship: [1, 352, 183], s_corp: [1, 450, 183], llc: [1, 512, 183], other: [1, 512, 183] } },
    stamp: [['signer.name', 1, 201, 684, 160], ['signer.title', 1, 372, 684, 105]],
    sign: [box(1, 42, 664, 150, 24)], date: [box(1, 482, 668, 76, 18)],
    signerText: [{ label: 'Bank account # (optional)', ...box(1, 306, 290, 122, 12) }] },
  'ovation-medical': { name: 'Ovation Medical', mode: 'overlay', layout: 'ovation-medical', ...pick(LAYOUT['ovation-medical']),
    marks: { 'biz.entity': { corporation: [1, 400, 229], s_corp: [1, 400, 229], llc: [1, 400, 229], partnership: [1, 462, 229] } },
    stamp: [['signer.title', 1, 146, 602, 70]],
    sign: [box(1, 36, 584, 106, 19), box(1, 36, 692, 140, 19)], date: [box(1, 218, 588, 50, 15), box(1, 182, 696, 70, 15)],
    signerText: [{ label: 'Owner 1 SS# (personal guarantee)', ...box(1, 488, 272, 86, 11) }, { label: 'Bank account #', ...box(1, 422, 521, 70, 11) }],
    notice: 'This application includes a personal guarantee by the signer.' },
  bemis: { name: 'Bemis', file: 'bemis-hme-dme-dealer-application-2026-ms97gpvy.pdf', sha256: '407c3190536f21aafd01f34eead9d733c79bc01c86aa7fe598c0e7c6b7d60af3', mode: 'addendum',
    stamp: [['signer.name', 2, 90, 656, 200], ['signer.title', 2, 333, 656, 200]], sign: [box(2, 128, 654, 180, 14)], date: [box(2, 333, 666, 120, 13)] },
  yuwell: { name: 'Yuwell', file: 'yuwell-new-customer-credit-application-2026.pdf', sha256: '2d97bc7d68aed2b6393c320b27f2277fdf092140e08ecc0b2c08e65d88d7c554', mode: 'addendum',
    stamp: [['biz.legal_name', 4, 262, 440, 300], ['signer.name_title', 4, 262, 502, 300]], sign: [box(4, 262, 455, 300, 22)], date: [box(4, 262, 515, 200, 18)] },
  dalton: { name: 'Dalton Medical', file: 'dalton-medical-credit-application-2026-mud64ho3.pdf', sha256: '0a5a3597287eda846da9da0af21a1a21ee95c59886722011404550fd8e0679e6', mode: 'addendum',
    stamp: [['signer.name', 1, 313, 718, 140], ['signer.title', 1, 463, 718, 110], ['biz.legal_name', 2, 163, 709, 300], ['signer.name', 2, 163, 733, 150], ['signer.title', 2, 322, 733, 110],
      ['signer.name', 3, 160, 498, 160], ['signer.title', 3, 360, 498, 180]],
    sign: [box(1, 311, 733, 145, 11), box(2, 161, 749, 150, 11), box(3, 100, 522, 200, 20)], date: [box(1, 462, 733, 100, 11), box(2, 321, 749, 100, 11), box(3, 360, 526, 120, 16)],
    guarantee: { page: 4 },
    notice: 'Page 4 of this application is a personal guarantee. It is never signed electronically here: each guarantor prints the guarantee page, signs it by hand, and it is uploaded with the application (or sent to Dalton directly).' },
};
function pick(l) { return { file: l.file, sha256: l.sha256 }; }

const EXTERNAL = {
  'golden-technologies': { name: 'Golden Technologies', how: 'Golden’s own online application (Nuvo)', url: 'https://nuvo.com/customer/goldentech?flow=default&salesRep=Angelo%40HomeCareProviderServices.us' },
  'ohio-medical': { name: 'Ohio Medical', how: 'Ohio Medical’s online registration', url: 'https://na4-onlineapp.dnbi.com/createApp/Ohio+Medical+LLC?token=1tsMkgzTo5%2BxH5HshdDOrg%3D%3D' },
  corsicana: { name: 'Corsicana', how: 'Corsicana’s Word application — download, complete and return it to HCPS', url: 'https://www.homecareproviderservices.org/assets/docs/corsicana-healthcare-south-bay-international-credit-applicat-ms87by1g.docx' },
};

module.exports = { FORMS, EXTERNAL, SECTIONS, FIELDS, ENTITIES, LAYOUT, derived, box };
