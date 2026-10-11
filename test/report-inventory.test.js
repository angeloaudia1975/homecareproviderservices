/* MI Inbox Automation, Phase A — the READ-ONLY report inventory (email-sync-api action report_inventory +
   netlify/functions/_report_inventory.js). The real function is loaded unmodified (mutant-capable through
   phase0-mock's loader) against a fake Supabase Auth/PostgREST and a fake Microsoft Graph. Proves: who may call it;
   that every Graph call is a GET and nothing is written anywhere; paging; throttling; duplicates; the five sample
   manufacturers' formats (Strongback order CSV = sales export despite its subject, Ohio Medical two-tab workbook,
   Access4U combined-month ledger, AirAvant cash-basis PDF, Climbing Steps body-only); that incomplete work is
   always reported (time budget + resumable cursor, too-large / unreadable files, a listing that fails); and that
   no body text, file content or raw column header ever leaves the function. */
const assert = require('assert');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { load, call } = require('./phase0-mock');
const BASE = 'https://db.test';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* ── fixtures ─────────────────────────────────────────────────────────────── */
function pdf(lines) {
  const esc = s => s.replace(/[\\()]/g, m => '\\' + m);
  const stream = 'BT /F1 11 Tf 50 750 Td ' + lines.map((l, i) => (i ? '0 -14 Td ' : '') + `(${esc(l)}) Tj`).join(' ') + ' ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const book = sheets => { const wb = XLSX.utils.book_new(); for (const [n, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const SECRET_CUSTOMER = 'ZEPHYR SECRET PHARMACY';
const SECRET_BODY = 'confidential body phrase 7731';
const SB_CSV = Buffer.from('Order Number,Order Date,Customer,Account,SKU,Product,Qty,Line Total,Ship To Zip Code\n'
  + `5775,2026-09-03,${SECRET_CUSTOMER},A100,1010AB,Wheelchair,1,536.00,47670\n5776,2026-09-09,Other Co,A101,A1005,Cup holder,2,100.00,43004\n`);
const OHIO = book([['Sales-Commission Data', [['Invoice', 'Customer', 'Item', 'Amount', 'Commission'], ['INV1', SECRET_CUSTOMER, 'X', 100, 5]]],
  ['Current month payment', [['Invoice', 'Customer', 'Paid Amount', 'Commission'], ['INV0', 'B', 200, 10]]]]);
const A4U = book([['Sheet1', [['Access4U Inc'], ['Commission Detail'], ['Type', 'Date', 'Num', 'Name', 'Amount', 'Commission'], ['Invoice', '11/03/2025', '9001', SECRET_CUSTOMER, 1000, 80], ['Payment', '12/01/2025', '9001', SECRET_CUSTOMER, 1000, 80]]]]);
const AIR = pdf(['AirAvant Medical', 'Commissions - Cash Basis', 'July 2026', 'Invoice  Customer  Amount  Commission', `INV-22 ${SECRET_CUSTOMER} $1,000.00 $100.00`]);
const DEALER = pdf(['Strongback Mobility', 'Dealer Report Overview', 'Prepared 8 October 2026', 'September 2026']);
const PRICE = book([['Pricing', [['Model', 'Description', 'Dealer Cost', 'MSRP', 'MAP'], ['1010AB', 'Chair', 400, 900, 899]]]]);
const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);

/* ── worlds ───────────────────────────────────────────────────────────────── */
const em = (address, name) => ({ emailAddress: { address, name: name || '' } });
function msgs() {
  return [
    { id: 'm1', internetMessageId: '<sb-sep@x>', subject: 'Commission report September 2026 - Angelo Audia', from: em('amanda.erickson@strongbackmobility.com', 'Amanda'), receivedDateTime: '2026-10-07T14:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a1', name: 'Strongback Sept Commission Report 2026.csv', contentType: 'text/csv', bytes: SB_CSV }, { id: 'a1i', name: 'image001.png', contentType: 'image/png', isInline: true, bytes: LOGO }] },
    { id: 'm2', internetMessageId: '<ohio@x>', subject: 'Commissions through August', from: em('michael.belcaster@ohiomedical.com'), receivedDateTime: '2026-09-23T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a2', name: 'HCPS Commissions Aug 2026.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: OHIO }] },
    { id: 'm3', internetMessageId: '<a4u@x>', subject: 'November and December 2025 Commissions Report', from: em('dlouallen@access4uinc.com'), receivedDateTime: '2026-01-16T15:00:00Z', hasAttachments: true, parentFolderId: 'fArch',
      att: [{ id: 'a3', name: 'Commission report.xlsx', contentType: 'application/octet-stream', bytes: A4U }] },
    { id: 'm4', internetMessageId: '<air@x>', subject: 'RE: Commission Reports and Payments', from: em('jcollazo@airavant.com'), receivedDateTime: '2026-07-17T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a4', name: 'scan0001.pdf', contentType: 'application/pdf', bytes: AIR }] },
    { id: 'm5', internetMessageId: '<cs@x>', subject: 'August Commissions 2026', from: em('sdiamond@climbingsteps.com'), receivedDateTime: '2026-09-08T15:00:00Z', hasAttachments: false, parentFolderId: 'fIn',
      body: `Hi Angelo,\nAugust commission: $412.50\nOrder 1001 $2,500.00\n${SECRET_BODY}\nThanks` },
    { id: 'm6', internetMessageId: '<sbd@x>', subject: 'Your Strongback dealer overview, September 2026', from: em('melanie.psychas@strongbackmobility.com'), receivedDateTime: '2026-10-08T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a6', name: 'Strongback_Report_Overview_September_2026.pdf', contentType: 'application/pdf', bytes: DEALER }] },
    { id: 'm7', internetMessageId: '<bemis@x>', subject: 'COMMISSION REPORT for Rep/Month: 705 / 2026-08', from: em('faxstar03@faxrelay.example'), receivedDateTime: '2026-08-17T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a7', name: 'report.pdf', contentType: 'application/pdf', bytes: pdf(['Commission Report', 'Rep 705']) }] },
    // the same Ohio message, filed in a second folder (Graph copy: other id, same internetMessageId + same file)
    { id: 'm2b', internetMessageId: '<ohio@x>', subject: 'Commissions through August', from: em('michael.belcaster@ohiomedical.com'), receivedDateTime: '2026-09-23T15:00:00Z', hasAttachments: true, parentFolderId: 'fArch',
      att: [{ id: 'a2b', name: 'HCPS Commissions Aug 2026.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: OHIO }] },
    // a manufacturer's ordinary mail: no attachment, no report words → counted, never listed
    { id: 'm8', internetMessageId: '<golden-chat@x>', subject: 'Lunch next week?', from: em('rep@goldentech.com'), receivedDateTime: '2026-08-01T15:00:00Z', hasAttachments: false, parentFolderId: 'fIn' },
    // a manufacturer's mail with an attachment but no report words → listed by name only, not downloaded
    { id: 'm9', internetMessageId: '<golden-inv@x>', subject: 'Order acknowledgement 55120', from: em('orders@goldentech.com'), receivedDateTime: '2026-08-02T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a9', name: 'ACK55120.pdf', contentType: 'application/pdf', bytes: pdf(['Ack']) }] },
    // unrelated dealer mail → never in the response
    { id: 'm10', internetMessageId: '<dealer@x>', subject: 'Question about a wheelchair', from: em('owner@somedealer.com'), receivedDateTime: '2026-08-03T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a10', name: 'photo.png', contentType: 'image/png', bytes: LOGO }] },
    // unknown sender with a report → "unidentified" (needs a new profile)
    { id: 'm11', internetMessageId: '<unk@x>', subject: 'Q3 commission statement', from: em('ap@newvendor.example'), receivedDateTime: '2026-10-02T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a11', name: 'statement.xlsx', contentType: 'application/octet-stream', bytes: PRICE }] },
    // HCPS's own mail about commissions → never treated as a manufacturer report
    { id: 'm12', internetMessageId: '<int@x>', subject: 'Commission report draft', from: em('greg@hcps.us'), receivedDateTime: '2026-10-03T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a12', name: 'x.xlsx', contentType: 'application/octet-stream', bytes: PRICE }] },
    // a manufacturer price list
    { id: 'm13', internetMessageId: '<a4u-price@x>', subject: 'pricing sheet', from: em('dlouallen@access4uinc.com'), receivedDateTime: '2026-02-10T15:00:00Z', hasAttachments: true, parentFolderId: 'fIn',
      att: [{ id: 'a13', name: 'Access4U 2026.xlsx', contentType: 'application/octet-stream', bytes: PRICE }] },
    { id: 'm14', internetMessageId: '<draft@x>', subject: 'Commission report', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-09T15:00:00Z', hasAttachments: false, parentFolderId: 'fDrafts', isDraft: true },
  ];
}

function world(o) {
  o = o || {};
  const st = { calls: [], sleeps: 0 };
  const all = (o.messages || msgs()).slice().sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime) || a.id.localeCompare(b.id));
  const res = (status, body, hdr) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: k => (hdr || {})[String(k).toLowerCase()] || null },
    json: async () => (Buffer.isBuffer(body) ? {} : body), text: async () => (Buffer.isBuffer(body) ? body.toString('latin1') : JSON.stringify(body)),
    arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  let throttles = o.throttle || 0;
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = String(url), m = (opts.method || 'GET').toUpperCase();
    st.calls.push({ u, m, headers: opts.headers || {} });
    if (u.startsWith('https://login.microsoftonline.com/')) return res(200, { access_token: 'gtok', expires_in: 3600 });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const e = { pres: 'angelo@hcps.us', admin: 'ad@hcps.us', owner: 'own@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', off: 'gone@hcps.us' }[tok]; return e ? res(200, { email: e }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) { const e = decodeURIComponent(u.match(/email=eq\.([^&]+)/)[1]);
      const s = { 'angelo@hcps.us': { role: 'president' }, 'ad@hcps.us': { role: 'admin' }, 'own@hcps.us': { role: 'owner' }, 'greg@hcps.us': { role: 'rep' }, 'lori@hcps.us': { role: 'relations' }, 'gone@hcps.us': { role: 'president', active: false } }[e];
      return res(200, s ? [{ email: e, ...s }] : []); }
    if (u.startsWith(BASE + '/rest/v1/manufacturers')) { if (o.mfrFail) return res(500, { message: 'down' });
      return res(200, [{ slug: 'strongback-mobility', name: 'Strongback Mobility' }, { slug: 'abm-respiratory-care', name: 'ABM Respiratory Care' }, { slug: 'golden-technologies', name: 'Golden Technologies' }]); }
    if (u.startsWith(BASE)) return res(500, { message: 'unexpected db call ' + u });
    if (!u.startsWith(GRAPH)) return res(500, { message: 'unexpected host ' + u });
    if (m !== 'GET') return res(405, { error: { message: 'only GET in this fake' } });
    if (throttles > 0) { throttles--; return res(429, { error: { message: 'slow down' } }, { 'retry-after': '1' }); }
    const p = u.slice(GRAPH.length);
    let x;
    if ((x = p.match(/^\/users\/([^/]+)\/messages\?(.*)$/))) {
      if (o.listFail) return res(500, { error: { message: 'listing broke' } });
      const q = new URLSearchParams(x[2]); const f = q.get('$filter') || '';
      const ge = f.match(/ge (\S+)/)[1], lt = f.match(/lt (\S+)/)[1];
      const inWin = all.filter(mm => mm.receivedDateTime >= ge && mm.receivedDateTime < lt);
      const top = o.pageSize || +q.get('$top'); const skip = +(q.get('$skip') || 0);
      const page = inWin.slice(skip, skip + top).map(mm => ({ id: mm.id, internetMessageId: mm.internetMessageId, subject: mm.subject, from: mm.from, receivedDateTime: mm.receivedDateTime, hasAttachments: mm.hasAttachments, parentFolderId: mm.parentFolderId, isDraft: !!mm.isDraft }));
      st.pages = (st.pages || 0) + 1;
      const body = { value: page };
      if (skip + top < inWin.length) { const q2 = new URLSearchParams(x[2]); q2.set('$skip', String(skip + top)); q2.set('$top', String(top)); body['@odata.nextLink'] = `${GRAPH}/users/${x[1]}/messages?${q2}`; }
      return res(200, body);
    }
    if ((x = p.match(/^\/users\/[^/]+\/mailFolders\/([^?]+)\?/))) return res(200, { displayName: { fIn: 'Inbox', fArch: 'Archive', fDrafts: 'Drafts' }[decodeURIComponent(x[1])] || 'Other' });
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\/attachments\?/))) {
      const mm = all.find(y => y.id === decodeURIComponent(x[1]));
      return res(200, { value: (mm.att || []).map(a => ({ '@odata.type': a.type || '#microsoft.graph.fileAttachment', id: a.id, name: a.name, contentType: a.contentType, size: a.size != null ? a.size : a.bytes.length, isInline: !!a.isInline })) });
    }
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\/attachments\/([^/?]+)\/\$value$/))) {
      const mm = all.find(y => y.id === decodeURIComponent(x[1])); const a = mm.att.find(y => y.id === decodeURIComponent(x[2]));
      if (a.fail) return res(500, { error: { message: 'attachment fetch broke' } });
      st.downloads = (st.downloads || []).concat(a.id); return res(200, a.bytes);
    }
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\?\$select=body$/))) {
      const mm = all.find(y => y.id === decodeURIComponent(x[1])); st.bodies = (st.bodies || []).concat(mm.id);
      return res(200, { body: { contentType: 'text', content: mm.body || '' } });
    }
    return res(404, { error: { message: 'no route ' + p } });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('email-sync-api.js', w, { GRAPH_MAILBOXES: 'angelo@hcps.us, greg@hcps.us' }) }; };
const as = tok => ({ token: tok });
const INV = o => Object.assign({ action: 'report_inventory', from: '2025-10-01', to: '2025-12-01' }, o);
const YEAR = o => INV(Object.assign({ from: '2026-01-01', to: '2026-02-28' }, o));
async function runAll(m, opts) {     // walk Oct 2025 → Oct 2026 month by month, following cursors
  const months = []; for (let y = 2025, mo = 10; y < 2026 || mo <= 10; mo++) { if (mo > 12) { mo = 1; y++; } const n = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`; months.push([`${y}-${String(mo).padStart(2, '0')}-01`, n]); }
  const out = []; for (const [from, to] of months) { let cursor = null; for (let k = 0; k < 50; k++) { const r = await call(m, INV(Object.assign({ from, to, cursor }, opts || {})), as('pres')); out.push(r); if (r.status !== 200 || r.body.done) break; cursor = r.body.cursor; } }
  return out;
}
const flat = rs => rs.flatMap(r => (r.body.messages || []).concat(r.body.unidentified || []));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); } }

(async () => {
  console.log('\n— who may call it —');
  await t('no sign-in 401, inactive 401, rep 403, Relations 403 — and Microsoft Graph is never called for them', async () => {
    for (const [tok, code] of [[null, 401], ['off', 401], ['greg', 403], ['lori', 403]]) {
      const { w, m } = boot(); const r = await call(m, INV(), tok ? as(tok) : {});
      assert.strictEqual(r.status, code, `${tok} → ${r.status}`);
      assert.ok(!w.calls.some(c => c.u.includes('graph.microsoft.com') || c.u.includes('login.microsoftonline')), `${tok} reached Graph`);
    }
  });
  await t('President, Admin and Owner may run it', async () => {
    for (const tok of ['pres', 'admin', 'owner']) { const { m } = boot(); const r = await call(m, INV(), as(tok)); assert.strictEqual(r.status, 200, tok); assert.strictEqual(r.body.read_only, true); }
  });
  await t('only a synced mailbox; dates required; one window ≤ 62 days; a bad cursor is refused — all before Graph', async () => {
    const cases = [[{ mailbox: 'someone@else.com' }, 400], [{ from: 'x' }, 400], [{ from: '2026-01-01', to: '2026-01-01' }, 400], [{ from: '2026-01-01', to: '2026-04-01' }, 400], [{ cursor: 'skip' }, 400]];
    for (const [o, code] of cases) { const { w, m } = boot(); const r = await call(m, INV(o), as('pres')); assert.strictEqual(r.status, code, JSON.stringify(o));
      assert.ok(!w.calls.some(c => c.u.includes('graph.microsoft.com')), 'reached Graph for ' + JSON.stringify(o)); }
  });
  await t('default mailbox = the caller\'s own synced mailbox; another synced mailbox only when named', async () => {
    const { w, m } = boot(); await call(m, INV(), as('pres'));
    assert.ok(w.calls.some(c => c.u.includes('/users/angelo%40hcps.us/messages')));
    assert.ok(!w.calls.some(c => c.u.includes('greg%40hcps.us')));
    const b = boot(); const r = await call(b.m, INV({ mailbox: 'greg@hcps.us' }), as('pres')); assert.strictEqual(r.status, 200); assert.ok(b.w.calls.some(c => c.u.includes('/users/greg%40hcps.us/messages')));
  });
  await t('an unreadable manufacturer list stops the scan (503) — never an inventory without manufacturer names', async () => {
    const { w, m } = boot({ mfrFail: true }); const r = await call(m, INV(), as('pres')); assert.strictEqual(r.status, 503);
    assert.ok(!w.calls.some(c => c.u.includes('graph.microsoft.com')));
  });

  console.log('\n— read-only —');
  await t('every Graph call is a GET; the only POST is the token request; the database is only read; no importer is reached', async () => {
    const { w, m } = boot(); const rs = await runAll(m);
    assert.ok(rs.every(r => r.status === 200));
    const nonGet = w.calls.filter(c => c.m !== 'GET');
    assert.ok(nonGet.length >= 1 && nonGet.every(c => c.u.startsWith('https://login.microsoftonline.com/')), 'non-GET: ' + nonGet.map(c => c.m + ' ' + c.u).join(', '));
    const db = w.calls.filter(c => c.u.startsWith(BASE + '/rest/v1/'));
    assert.ok(db.every(c => /\/rest\/v1\/(staff_users|manufacturers)\?/.test(c.u)), 'db: ' + db.map(c => c.u).filter(u => !/staff_users|manufacturers/.test(u)).join(', '));
    assert.ok(!w.calls.some(c => /\/rpc\/|\/storage\/v1\/|isRead|\/move|\/send|sendMail|createReply/i.test(c.u)));
  });
  await t('Graph is asked for immutable ids (stable across folder moves)', async () => {
    const { w, m } = boot(); await call(m, INV({ from: '2026-10-01', to: '2026-10-12' }), as('pres'));
    const g = w.calls.filter(c => c.u.startsWith(GRAPH)); assert.ok(g.length && g.every(c => /IdType="ImmutableId"/.test(c.headers.Prefer || '')));
  });

  console.log('\n— the five sample manufacturers + profiles —');
  const { w: W, m: M } = boot(); const ALL = await runAll(M); const R = flat(ALL);
  const byId = id => R.find(r => r.internet_message_id === id);
  await t('Strongback order CSV is a SALES EXPORT despite its "Commission report" subject (content wins)', async () => {
    const r = byId('<sb-sep@x>'); assert.ok(r);
    const a = r.attachments.find(x => /\.csv$/.test(x.name));
    assert.strictEqual(a.format, 'csv'); assert.strictEqual(a.classification, 'sales_export'); assert.strictEqual(a.basis, 'content');
    assert.strictEqual(a.sha256, sha(SB_CSV)); assert.strictEqual(a.rows, 2);
    assert.deepStrictEqual(a.sheets[0].columns, ['account', 'amount', 'customer', 'date', 'order', 'product', 'qty', 'ship_to', 'sku', 'zip']);
    assert.strictEqual(r.classification, 'sales_export'); assert.strictEqual(r.classified_by, 'attachment_content');
    assert.strictEqual(r.subject_suggests, 'commission_statement');
    assert.strictEqual(r.manufacturer, 'strongback-mobility'); assert.strictEqual(r.match, 'sender_domain');
    assert.strictEqual(r.received, '2026-10-07T14:00:00Z'); assert.strictEqual(r.folder, 'Inbox');
    assert.deepStrictEqual(r.period_guess.periods, ['2026-09']);
    assert.strictEqual(r.inline_skipped, 1); assert.ok(!r.attachments.some(x => x.name === 'image001.png'));
  });
  await t('Ohio Medical two-tab workbook = commission statement; "through August" is cumulative', async () => {
    const r = byId('<ohio@x>'); const a = r.attachments[0];
    assert.strictEqual(a.format, 'xlsx'); assert.deepStrictEqual(a.sheets.map(s => s.name), ['Sales-Commission Data', 'Current month payment']);
    assert.strictEqual(a.classification, 'commission_statement'); assert.strictEqual(r.period_guess.cumulative, true); assert.deepStrictEqual(r.period_guess.periods, ['2026-08']);
  });
  await t('Access4U combined-month ledger: commission statement, both months (Nov + Dec 2025), header found below title rows', async () => {
    const r = byId('<a4u@x>'); assert.strictEqual(r.classification, 'commission_statement'); assert.deepStrictEqual(r.period_guess.periods, ['2025-11', '2025-12']);
    assert.ok(r.attachments[0].sheets[0].columns.includes('commission')); assert.strictEqual(r.folder, 'Archive');
  });
  await t('AirAvant PDF format is CONFIRMED from its text: QuickBooks "Commissions – Cash Basis" (not guessed from the name)', async () => {
    const r = byId('<air@x>'); const a = r.attachments[0];
    assert.strictEqual(a.format, 'pdf'); assert.strictEqual(a.pages, 1);
    assert.ok(a.signals.includes('cash_basis') && a.signals.includes('commission') && a.signals.includes('quickbooks'), a.signals.join());
    assert.strictEqual(a.classification, 'commission_statement'); assert.strictEqual(a.basis, 'content'); assert.deepStrictEqual(a.text_periods, ['2026-07']);
  });
  await t('Climbing Steps body-only report: found from body SIGNALS; the body is never returned', async () => {
    const r = byId('<cs@x>'); assert.strictEqual(r.classification, 'commission_statement'); assert.strictEqual(r.classified_by, 'email_body');
    assert.strictEqual(r.body.looks_like_report, true); assert.strictEqual(r.body.amounts, 2); assert.strictEqual(r.attachments.length, 0);
    assert.deepStrictEqual(r.period_guess.periods, ['2026-08']);
  });
  await t('Strongback dealer overview PDF = dealer report; Bemis relay recognised by its subject pattern', async () => {
    assert.strictEqual(byId('<sbd@x>').classification, 'dealer_report');
    const b = byId('<bemis@x>'); assert.strictEqual(b.manufacturer, 'bemis'); assert.strictEqual(b.match, 'subject_pattern'); assert.strictEqual(b.classification, 'commission_statement'); assert.deepStrictEqual(b.period_guess.periods, ['2026-08']);
  });
  await t('price list recognised from columns; unknown sender with a commission statement → unidentified (needs a profile)', async () => {
    assert.strictEqual(byId('<a4u-price@x>').classification, 'price_list');
    const u = ALL.flatMap(r => r.body.unidentified || []); assert.deepStrictEqual(u.map(x => x.internet_message_id), ['<unk@x>']); assert.strictEqual(u[0].manufacturer, null);
  });
  await t('ordinary manufacturer mail is only counted; its order acknowledgement is listed by name, never downloaded', async () => {
    const counted = ALL.reduce((n, r) => n + ((r.body.not_reports_by_manufacturer || {})['golden-technologies'] || 0), 0); assert.strictEqual(counted, 1);
    const ack = byId('<golden-inv@x>'); assert.ok(ack); assert.strictEqual(ack.attachments[0].sha256, null); assert.ok(!(W.downloads || []).includes('a9'));
    assert.strictEqual(byId('<golden-chat@x>'), undefined);
  });
  await t('unrelated mail, HCPS\'s own mail and drafts never appear', async () => {
    for (const id of ['<dealer@x>', '<int@x>', '<draft@x>']) assert.strictEqual(byId(id), undefined, id);
    const txt = JSON.stringify(ALL.map(r => r.body)); assert.ok(!/somedealer|Question about a wheelchair|Commission report draft/.test(txt));
  });
  await t('no file content, body text or raw column header leaves the function', async () => {
    const txt = JSON.stringify(ALL.map(r => r.body));
    for (const s of [SECRET_CUSTOMER, SECRET_BODY, 'Ship To Zip Code', 'Line Total', '412.50', 'contentBytes', 'gtok']) assert.ok(!txt.includes(s), 'leaked: ' + s);
  });
  await t('duplicates: the same message in two folders and the same file are flagged (never counted twice)', async () => {
    const copies = R.filter(r => r.internet_message_id === '<ohio@x>'); assert.strictEqual(copies.length, 2);
    assert.strictEqual(copies.filter(c => c.duplicate_of_message).length, 1);
    const later = copies.find(c => c.duplicate_of_message); assert.ok(later.attachments[0].same_file_as, 'same file not flagged');
    assert.strictEqual(later.attachments[0].sha256, sha(OHIO));
  });

  console.log('\n— paging, throttling, incomplete work —');
  await t('Graph paging is followed to the end (page size 2 → every message seen)', async () => {
    const { w, m } = boot({ pageSize: 2 }); const r = await call(m, INV({ from: '2026-10-01', to: '2026-10-12' }), as('pres'));
    assert.strictEqual(r.body.listing.complete, true); assert.ok(r.body.listing.pages >= 3, 'pages ' + r.body.listing.pages);
    assert.strictEqual(r.body.listing.scanned, 5); assert.strictEqual(r.body.done, true);
    assert.deepStrictEqual(flat([r]).map(x => x.internet_message_id).sort(), ['<int@x>', '<sb-sep@x>', '<sbd@x>', '<unk@x>'].filter(x => x !== '<int@x>').sort());
  });
  await t('throttling (429 + Retry-After) is waited out and retried, not dropped', async () => {
    const { m } = boot({ throttle: 1 }); const r = await call(m, INV({ from: '2026-09-01', to: '2026-10-01' }), as('pres'));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.listing.complete, true);
  });
  await t('a listing that fails is reported as an incomplete window, never as "no reports"', async () => {
    const { m } = boot({ listFail: true }); const r = await call(m, INV(), as('pres'));
    assert.strictEqual(r.body.done, false); assert.strictEqual(r.body.listing.complete, false); assert.ok(/listing not finished/.test(r.body.incomplete[0].reason));
  });
  await t('a too-large file and an unreadable file are listed with the reason; the message is still reported', async () => {
    const list = msgs(); list.find(x => x.id === 'm2').att[0].size = 40e6; list.find(x => x.id === 'm4').att[0].fail = true;
    const { m } = boot({ messages: list }); const rs = await runAll(m); const all = flat(rs);
    const big = all.find(x => x.internet_message_id === '<ohio@x>' && !x.duplicate_of_message); assert.strictEqual(big.attachments[0].sha256, null); assert.ok(/larger than/.test(big.incomplete[0]));
    const bad = all.find(x => x.internet_message_id === '<air@x>'); assert.ok(/could not be read/.test(bad.incomplete[0]));
    const inc = rs.flatMap(r => r.body.incomplete); assert.ok(inc.some(x => /larger than/.test(x.reason)) && inc.some(x => /could not be read/.test(x.reason)));
  });

  console.log('\n— time budget + cursor (module, injected clock) —');
  const RI = require('../netlify/functions/_report_inventory.js');
  const deps = (w, clock) => ({ getToken: async () => 'gtok', fetch: w.fetch, now: () => clock.t, sleep: async () => {} });
  const tick = (w, clock, ms) => { const f = w.fetch; w.fetch = async (u, o) => { clock.t += ms; return f(u, o); }; };
  await t('the budget stops the scan with a cursor; following it finishes the window with nothing lost or repeated', async () => {
    const w = world(); const clock = { t: 0 }; tick(w, clock, 400);
    const base = { mailbox: 'angelo@hcps.us', from: '2025-10-01T00:00:00Z', to: '2026-10-12T00:00:00Z', internal_domains: ['hcps.us'], budget_ms: 3000 };
    let cursor = null, got = [], calls = 0, partial = false;
    for (; calls < 40; calls++) { const r = await RI.inventory(Object.assign({}, base, { cursor }), deps(w, clock));
      assert.strictEqual(r.ok, true); got = got.concat(r.messages, r.unidentified);
      if (!r.done) { partial = true; assert.ok(r.cursor && r.cursor.skip > (cursor ? cursor.skip : -1)); assert.ok(r.incomplete.some(x => /not inspected yet/.test(x.reason))); }
      if (r.done) break; cursor = r.cursor; }
    assert.ok(partial, 'budget never hit'); assert.ok(calls < 40);
    const ids = got.map(x => x.internet_message_id + '|' + x.folder);
    assert.strictEqual(new Set(ids).size, ids.length, 'a message was repeated');
    assert.strictEqual(got.length, 11);
  });
  await t('a cursor that no longer matches the window is refused (window_changed), never silently skipped', async () => {
    const w = world(); const clock = { t: 0 };
    const r = await RI.inventory({ mailbox: 'a@hcps.us', from: '2025-10-01T00:00:00Z', to: '2026-10-12T00:00:00Z', internal_domains: ['hcps.us'], cursor: { skip: 2, last_id: 'nope' } }, deps(w, clock));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'window_changed');
    const b = boot(); const r2 = await call(b.m, INV({ from: '2026-09-01', to: '2026-10-01', cursor: { skip: 1, last_id: 'nope' } }), as('pres')); assert.strictEqual(r2.status, 409);
  });
  await t('period guesses: ISO month, month + year, "you may" is not May, a month after the received month is last year', async () => {
    const { periodGuess } = RI._internal;
    assert.deepStrictEqual(periodGuess('COMMISSION REPORT 705 / 2026-08', '2026-08-17T00:00:00Z').periods, ['2026-08']);
    assert.strictEqual(periodGuess('you may need this report', '2026-08-17T00:00:00Z'), null);
    assert.deepStrictEqual(periodGuess('December Commissions', '2026-01-10T00:00:00Z').periods, ['2025-12']);
  });

  console.log(`\nreport-inventory: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
