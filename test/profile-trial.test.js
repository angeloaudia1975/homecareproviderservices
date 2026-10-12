/* Phase D — profile trial (netlify/functions/_profile_trial.js): a draft profile run over mailbox history, READ-ONLY.
   Uses the capture's own inspect / decide, so a trial and the live capture agree file by file. Every Graph call is a GET.
     node test/profile-trial.test.js */
const assert = require('assert');
const crypto = require('crypto');
const T = require('../netlify/functions/_profile_trial.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

const BEMIS = { id: 9, code: 'bemis:commission_statement:rep705', manufacturer: 'bemis', kind: 'commission_statement', status: 'draft', auto_register: false,
  rules: { senders: { domains: ['bemismfg.com'] }, formats: ['csv'], file_name: '^705-\\d{4}-\\d{2}\\.csv$', content: { columns_all: ['commission'] }, period: { order: ['file_name'] }, expected: { cadence: 'monthly', days: [17, 17] } } };
const CS = { id: 7, code: 'climbing-steps:commission_statement:monthly', manufacturer: 'climbing-steps', kind: 'commission_statement', status: 'draft', auto_register: false,
  rules: { senders: { domains: ['climbingsteps.com'] }, formats: ['xls', 'xlsx'], file_name: 'commi?ss?ion|comms', body_only: true, period: { order: ['subject', 'file_name'] } } };
const csv = (rows) => Buffer.from(['Customer,Ship To,Zip,Invoice,Amount,Commission', ...rows].join('\r\n') + '\r\n');
const JUL = csv(['Acme Medical,Acme,47670,INV1,100.00,10.00']), AUG = csv(['Acme Medical,Acme,47670,INV2,200.00,20.00']);

function graph(msgs) {
  const calls = [];
  const res = (status, body, raw) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => { const b = raw; return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const fetch = async (url, opts) => {
    const u = decodeURIComponent(url); calls.push({ u, m: (opts && opts.method) || 'GET' });
    const mm = u.match(/\/messages\/([^/?]+)(\/attachments(?:\/([^/?]+))?)?(\/\$value)?/);
    if (/\$search=/.test(u)) { const d = u.match(/from:([^"]+)"/)[1]; return res(200, { value: msgs.filter(m => m.from.emailAddress.address.endsWith('@' + d)).map(({ atts, body, ...m }) => m) }); }
    const m = mm && msgs.find(x => x.id === mm[1]);
    if (m && mm[3] && mm[4]) return res(200, null, m.atts.find(a => a.id === mm[3]).bytes);
    if (m && mm[2]) return res(200, { value: m.atts.map(({ bytes, ...a }) => ({ '@odata.type': '#microsoft.graph.fileAttachment', size: bytes.length, ...a })) });
    if (m && mm[4]) return res(200, null, Buffer.from('MIME ' + m.body));
    if (m && /\$select=body/.test(u)) return res(200, { body: { content: m.body } });
    return res(404, { error: { message: 'unexpected ' + u } });
  };
  return { calls, deps: { getToken: async () => 'tok', fetch, sleep: async () => {} } };
}
const msg = (id, from, day, subject, atts, body) => ({ id, internetMessageId: '<' + id + '>', subject, from: { emailAddress: { address: from } }, receivedDateTime: day + 'T15:00:00Z', hasAttachments: !!(atts && atts.length), atts: atts || [], body: body || '' });

(async () => {
  await t('Bemis: each monthly CSV would be registered once with its file-name period; the resend is a copy; other files classified', async () => {
    const msgs = [msg('a', 'faxstar03@bemismfg.com', '2026-08-17', 'COMMISSION REPORT for Rep/Month: 705 / 2026-07', [{ id: 'f1', name: '705-2026-07.csv', contentType: 'text/csv', bytes: JUL }]),
      msg('b', 'faxstar03@bemismfg.com', '2026-08-17', 'COMMISSION REPORT for Rep/Month: 705 / 2026-07', [{ id: 'f1', name: '705-2026-07.csv', contentType: 'text/csv', bytes: JUL }]),
      msg('c', 'faxstar03@bemismfg.com', '2026-09-17', 'COMMISSION REPORT for Rep/Month: 705 / 2026-08', [{ id: 'f2', name: '705-2026-08.csv', contentType: 'text/csv', bytes: AUG }]),
      msg('d', 'sales@bemismfg.com', '2026-09-20', 'Price list', [{ id: 'f3', name: 'Bemis price list.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') }]),
      msg('z', 'faxstar03@bemismfg.com', '2025-01-17', 'old', [{ id: 'f9', name: '705-2025-01.csv', contentType: 'text/csv', bytes: JUL }])];
    const { calls, deps } = graph(msgs);
    const r = await T.trial({ slug: 'bemis', profiles: [BEMIS], mailbox: 'angelo@hcps.us', from: '2025-10-01', to: '2026-12-31', known: {} }, deps);
    assert.strictEqual(r.done, true); assert.strictEqual(r.messages_total, 4, 'outside the window is not read');
    const o = r.files.map(f => [f.file, f.outcome, f.period && f.period.start]);
    assert.deepStrictEqual(o.slice(0, 3), [['705-2026-07.csv', 'would_register', '2026-07-01'], ['705-2026-07.csv', 'copy_of_earlier_file', '2026-07-01'], ['705-2026-08.csv', 'would_register', '2026-08-01']]);
    assert.notStrictEqual(r.files[3].outcome, 'would_register');
    assert.ok(calls.every(c => c.m === 'GET'), 'GET only');
    const s = T.summarize(r.files); assert.deepStrictEqual(Object.keys(s.by_month), ['2026-07', '2026-08']); assert.strictEqual(s.counts.would_register, 2);
  });
  await t('a file already registered would be LINKED, never registered again', async () => {
    const { deps } = graph([msg('a', 'faxstar03@bemismfg.com', '2026-08-17', 'x', [{ id: 'f1', name: '705-2026-07.csv', contentType: 'text/csv', bytes: JUL }])]);
    const sha = crypto.createHash('sha256').update(JUL).digest('hex');
    const r = await T.trial({ slug: 'bemis', profiles: [BEMIS], mailbox: 'm@x', from: '2025-10-01', to: '2026-12-31', known: { [sha]: { id: 44, kind: 'commission_statement' } } }, deps);
    assert.strictEqual(r.files[0].outcome, 'would_link'); assert.strictEqual(r.files[0].known_record, 44);
  });
  await t('Climbing Steps: a body-only statement with amounts is a candidate; a body without amounts is not', async () => {
    const { deps } = graph([msg('a', 'sdiamond@climbingsteps.com', '2026-03-06', 'February 2026 Commissions - Climbing Steps', [], 'Your commission for February is $412.50 on $4,125.00'),
      msg('b', 'sdiamond@climbingsteps.com', '2026-04-06', 'March 2026 Commissions - Climbing Steps', [], 'Will send shortly')]);
    const r = await T.trial({ slug: 'climbing-steps', profiles: [CS], mailbox: 'm@x', from: '2025-10-01', to: '2026-12-31', known: {} }, deps);
    assert.deepStrictEqual(r.files.map(f => [f.file, f.outcome, (f.period && f.period.start) || null]), [["(email body)", 'would_register', '2026-02-01'], ['(email body)', 'classified', null]]);
  });
  await t('the time budget stops a page cleanly with a cursor; the next page resumes without repeating', async () => {
    const msgs = [1, 2, 3].map(n => msg('m' + n, 'faxstar03@bemismfg.com', `2026-0${n + 5}-17`, 'x', [{ id: 'f', name: `705-2026-0${n + 4}.csv`, contentType: 'text/csv', bytes: csv(['A,B,1,I' + n + ',1,0.1']) }]));
    const { deps } = graph(msgs); let clock = 0; deps.now = () => clock;
    const realFetch = deps.fetch; deps.fetch = async (u, o) => { clock += 4000; return realFetch(u, o); };
    const p1 = await T.trial({ slug: 'bemis', profiles: [BEMIS], mailbox: 'm@x', from: '2025-10-01', to: '2026-12-31', known: {}, budget_ms: 20000 }, deps);
    assert.strictEqual(p1.done, false); assert.ok(p1.cursor >= 1 && p1.cursor < 3);
    clock = 0; const p2 = await T.trial({ slug: 'bemis', profiles: [BEMIS], mailbox: 'm@x', from: '2025-10-01', to: '2026-12-31', known: {}, cursor: p1.cursor, seen: p1.seen, budget_ms: 22000 }, deps);
    const all = p1.files.concat(p2.files).map(f => f.file); assert.strictEqual(new Set(all).size, all.length); assert.ok(p2.done || p2.cursor > p1.cursor);
  });

  await t('an ignore_file_name rule classifies a recurring non-report file instead of raising an exception', async () => {
    const OH = { id: 4, code: 'ohio-medical:commission_statement:through', manufacturer: 'ohio-medical', kind: 'commission_statement', status: 'draft',
      rules: { senders: { domains: ['ohiomedical.com'] }, formats: ['xlsx'], ignore_file_name: '^ZOL SPIFF', content: { sheet_names_any: ['Current month payment'] }, period: { order: ['subject'] } } };
    const X = require('xlsx'); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Order', 'Customer', 'Qty', 'Amount'], ['1', 'A', 1, 5]]), 'Sheet1');
    const buf = X.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const mk = rules => graph([msg('a', 'michael.belcaster@ohiomedical.com', '2026-09-23', 'Commissions through August', [{ id: 'f', name: 'ZOL SPIFF - HomeCare Provider Services.xlsx', contentType: 'application/x', bytes: buf }])]);
    let { deps } = mk(); let r = await T.trial({ slug: 'ohio-medical', profiles: [OH], mailbox: 'm@x', from: '2025-10-01', to: '2026-12-31', known: {} }, deps);
    assert.deepStrictEqual([r.files[0].outcome, /ignore rule/.test(r.files[0].detail)], ['classified', true]);
    const OH2 = Object.assign({}, OH, { rules: Object.assign({}, OH.rules) }); delete OH2.rules.ignore_file_name;
    ({ deps } = mk()); r = await T.trial({ slug: 'ohio-medical', profiles: [OH2], mailbox: 'm@x', from: '2025-10-01', to: '2026-12-31', known: {} }, deps);
    assert.ok(!/ignore rule/.test(r.files[0].detail || ''), 'without the rule the file is judged on its content (live: an unidentified_type exception)');
  });

  console.log(`\nprofile-trial: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
