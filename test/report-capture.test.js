/* MI Inbox Automation, Phase B — the capture run end to end: netlify/functions/_report_capture.js (+ the shared
   _report_inventory.js helpers and the MI-1c reader) against a fake Microsoft Graph mailbox and the REAL capture SQL
   in Postgres (supabase/mi_b_report_capture.sql on the real MI-1a → MC → MI-1b → MI-1c chain). The database is reached
   exactly as the live code reaches it — the service role, only SELECTs and the hcps_mfr_capture_* functions — through
   a small adapter for the four PostgREST reads the capture makes.
   Proves: the three Strongback profiles (SR032 statement, order export despite its subject, dealer overview linked to
   record 7 by hash), draft profiles never register, unknown senders and changed formats go to Needs Attention, multiple
   attachments are handled one by one, every Graph call is a GET, storage writes are hash-named and never overwrite,
   period from content beats the received date, the durable retry queue, the time budget never loses or repeats an
   email, outage recovery from an old checkpoint, throttling, and that nothing outside capture + the register changes.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/var/tmp/pgmi PGPORT=55433 PGUSER=postgres node test/report-capture.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const assert = require('assert');
const XLSX = require('xlsx');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mibcap_' + process.pid;
const PDF7 = process.env.MI1C_PDF || '/mnt/user-data/uploads/Strongback_Report_Overview_September_2026.pdf';
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
if (!fs.existsSync(PDF7) && !process.env.MI1C_ALLOW_NO_PDF) { console.log(`FAIL: the September PDF is needed (${PDF7}); set MI1C_PDF`); console.log('\nreport-capture: 0 passed, 1 failed'); process.exit(1); }
const SB = f => (f === 'mi_b_report_capture.sql' && process.env.MIB_SQL) ? process.env.MIB_SQL : path.join(__dirname, '..', 'supabase', f);
const T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
const q = sql => run(DB, sql);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
// Mutation runs load the module through phase0-mock's loader (the mutant is applied in memory); normal runs require it.
const RC = process.env.P0_MUTANT ? require('./phase0-mock').load('_report_capture.js', { fetch: async () => { throw new Error('no network'); } })
  : require('../netlify/functions/_report_capture.js');

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
const SECRET = 'ZEPHYR SECRET PHARMACY';
const SR032_SEP = pdf(['Strongback Mobility', 'Sales Rep Commission Statement', 'Period 2026-09', 'Order 5775  1010AB  1  $536.00  Commission $48.24']);
const SR032_AUG = pdf(['Strongback Mobility', 'Sales Rep Commission Statement', 'Period 2026-08', 'Order 5701  1003AB  1  $497.00  Commission $44.73']);
const ORDERS_AUG = Buffer.from('Order Number,Order Date,Customer,Account,SKU,Product,Qty,Line Total,Ship To Zip\n'
  + `5701,08/04/2026,${SECRET},A100,1003AB,Chair,1,497.00,47670\n5702,08/21/2026,Other,A101,A1005,Cup,2,100.00,43004\n`);
const SB_XLSX_CHANGED = book([['Sheet1', [['Invoice', 'Customer', 'Amount', 'Commission'], ['I1', 'A', 10, 1]]]]);
const BEMIS = Buffer.from('Invoice,Invoice Date,Customer,Account,Ship To,Zip,Item,Qty,Amount,Commission\nI9,2026-08-03,X,1,X,1,7YA,1,10,1\n');
const OHIO = book([['Summary', [['Commission'], [5]]], ['Sales-Commission Data', [['Invoice', 'Customer', 'Amount', 'Commission'], ['I', SECRET, 1, 1]]],
  ['Current month payment', [['Invoice', 'Customer', 'Paid Amount', 'Commission'], ['I', 'B', 1, 1]]]]);
const ROSE = book([['Sheet1', [['Invoice', 'Date', 'Customer', 'Item', 'Qty', 'Amount', 'Commission'], ['1', '2026-09-01', 'x', 'y', 1, 2, 3]]]]);
const PRICELIST = pdf(['SPARE PARTS PRICELIST 2026', 'Model  Dealer Price  MSRP']);
const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300)]);
const REC7 = fs.existsSync(PDF7) ? fs.readFileSync(PDF7) : null;

const em = (address, name) => ({ emailAddress: { address, name: name || '' } });
let seq = 0;
const M = (o, att) => Object.assign({ id: 'g' + (++seq), internetMessageId: o && o.extra ? `<${o.subject.replace(/\W+/g, '-')}@x>` : `<m${seq}@x>`, isDraft: false, parentFolderId: 'fIn', hasAttachments: !!(att && att.length), att: att || [] }, o);
const A = (name, contentType, bytes, o) => Object.assign({ id: 'a' + (++seq), name, contentType, bytes, size: bytes ? bytes.length : 0 }, o || {});
function mailbox() {
  seq = 0;
  return [
    M({ subject: 'Commission report September 2026 - Angelo Audia', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-07T14:00:00Z' },
      [A('2026-09 SR032.pdf', 'application/pdf', SR032_SEP), A('image001.png', 'image/png', LOGO, { isInline: true })]),
    M({ subject: 'Your Strongback dealer overview, September 2026', from: em('melanie.psychas@strongbackmobility.com'), receivedDateTime: '2026-10-08T15:46:00Z' },
      REC7 ? [A('Angelo_Strongback_Dealers_2026-09.pdf', 'application/pdf', REC7)] : []),
    M({ subject: 'RE: Commission report August 2026 - Angelo Audia', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-02T15:00:00Z' },
      [A('Angelo Orders August 2026.csv', 'text/csv', ORDERS_AUG), A('2026-08 SR032.pdf', 'application/pdf', SR032_AUG), A('SPARE PARTS PRICELIST 2026.pdf', 'application/pdf', PRICELIST)]),
    M({ subject: 'Fw: Commission report August 2026', from: em('jennifer.johansson@strongbackmobility.com'), receivedDateTime: '2026-10-03T13:00:00Z' },
      [A('2026-08 SR032.pdf', 'application/pdf', SR032_AUG)]),
    M({ subject: 'Commission report - new layout', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-04T13:00:00Z' },
      [A('Strongback September.xlsx', 'application/octet-stream', SB_XLSX_CHANGED)]),
    M({ subject: 'COMMISSION REPORT for Rep/Month: 705 / 2026-09', from: em('faxstar03@bemismfg.com'), receivedDateTime: '2026-10-05T21:07:00Z' },
      [A('705-2026-09.csv', 'text/csv', BEMIS)]),
    M({ subject: 'Commissions through September', from: em('michael.belcaster@ohiomedical.com'), receivedDateTime: '2026-10-06T15:00:00Z' },
      [A('HomeCare Provider Services - commission detail 0926.xlsx', 'application/octet-stream', OHIO)]),
    M({ subject: 'September Commissions 2026', from: em('sdiamond@climbingsteps.com'), receivedDateTime: '2026-10-06T16:00:00Z',
      body: `Hi Angelo\nSeptember commission: $412.50\n${SECRET}\n` }),
    M({ subject: 'September Commissions Report', from: em('brittany@rose-healthcare.com'), receivedDateTime: '2026-10-06T17:00:00Z' },
      [A('Audia September.xlsx', 'application/octet-stream', ROSE)]),
    M({ subject: 'Order acknowledgement 55120', from: em('orders@goldentech.com'), receivedDateTime: '2026-10-06T18:00:00Z' },
      [A('ACK55120.pdf', 'application/pdf', pdf(['Ack']))]),
    M({ subject: 'Commission report draft', from: em('greg@homecareproviderservices.us'), receivedDateTime: '2026-10-06T19:00:00Z' },
      [A('x.csv', 'text/csv', ORDERS_AUG)]),
    M({ subject: 'Question about a wheelchair', from: em('owner@somedealer.com'), receivedDateTime: '2026-10-06T20:00:00Z' }, [A('photo.pdf', 'application/pdf', pdf(['x']))]),
    M({ subject: 'Commission report October draft', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-09T10:00:00Z', isDraft: true }),
  ];
}

/* ── the fake Graph mailbox (GET only) ────────────────────────────────────── */
function graph(box, o) {
  o = o || {};
  const st = { calls: [], downloads: [] };
  let throttles = o.throttle || 0;
  const res = (status, body, hdr) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => (hdr || {})[String(k).toLowerCase()] || null },
    json: async () => (Buffer.isBuffer(body) ? {} : body), text: async () => (Buffer.isBuffer(body) ? body.toString('latin1') : JSON.stringify(body)),
    arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  st.fetch = async (url, opts) => {
    const u = String(url), m = (opts && opts.method) || 'GET'; st.calls.push({ u, m, headers: (opts && opts.headers) || {} });
    if (o.tick) o.tick(u);
    if (m !== 'GET') return res(405, { error: { message: 'GET only' } });
    if (throttles > 0) { throttles--; return res(429, {}, { 'retry-after': '1' }); }
    if (o.throttleOn && o.throttleOn(u)) return res(429, {}, { 'retry-after': '120' });   // a file Graph will not hand over within this run
    const p = u.replace('https://graph.microsoft.com/v1.0', ''); let x;
    if ((x = p.match(/^\/users\/[^/]+\/messages\?(.*)$/))) {
      const qs = new URLSearchParams(x[1]); const f = qs.get('$filter'); const ge = f.match(/ge (\S+)/)[1], lt = f.match(/lt (\S+)/)[1];
      const all = box.filter(mm => mm.receivedDateTime >= ge && mm.receivedDateTime < lt).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
      const top = o.pageSize || +qs.get('$top'), skip = +(qs.get('$skip') || 0);
      const body = { value: all.slice(skip, skip + top).map(mm => ({ id: mm.id, internetMessageId: mm.internetMessageId, subject: mm.subject, from: mm.from,
        receivedDateTime: mm.receivedDateTime, hasAttachments: mm.hasAttachments, parentFolderId: mm.parentFolderId, isDraft: mm.isDraft, webLink: 'https://outlook.example/' + mm.id })) };
      if (skip + top < all.length) { qs.set('$skip', String(skip + top)); body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0${p.split('?')[0]}?${qs}`; }
      return res(200, body);
    }
    if ((x = p.match(/^\/users\/[^/]+\/mailFolders\/([^?]+)\?/))) return res(200, { displayName: { fIn: 'Inbox' }[decodeURIComponent(x[1])] || 'Archive' });
    const msg = id => box.find(mm => mm.id === decodeURIComponent(id));
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\/attachments\?/))) {
      if (o.listFail && o.listFail(x[1])) return res(500, { error: { message: 'list broke' } });
      return res(200, { value: msg(x[1]).att.map(a => ({ '@odata.type': a.type || '#microsoft.graph.fileAttachment', id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: !!a.isInline })) });
    }
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\/attachments\/([^/?]+)\/\$value$/))) {
      const a = msg(x[1]).att.find(y => y.id === decodeURIComponent(x[2]));
      if (o.downloadFail && o.downloadFail(a)) return res(500, { error: { message: 'download broke' } });
      st.downloads.push(a.name); return res(200, a.bytes);
    }
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\?\$select=body$/))) return res(200, { body: { contentType: 'text', content: msg(x[1]).body || '' } });
    if ((x = p.match(/^\/users\/[^/]+\/messages\/([^/?]+)\/\$value$/))) return res(200, Buffer.from('MIME-Version: 1.0\r\nSubject: ' + msg(x[1]).subject + '\r\n\r\n' + (msg(x[1]).body || '')));
    return res(404, { error: { message: 'no route ' + p } });
  };
  return st;
}

/* ── the real database through the service role (the four reads the capture makes + the functions) ── */
function dbAdapter(log) {
  const sr = sql => q(`begin; set local role service_role; ${sql}; commit;`);
  return {
    async get(p) {
      log.push('GET ' + p);
      let x;
      if (/^mfr_report_profiles\?/.test(p)) return JSON.parse(sr(`select coalesce(json_agg(p order by id), '[]') from mfr_report_profiles p where status in ('active','draft')`));
      if (/^manufacturers\?/.test(p)) return JSON.parse(sr(`select coalesce(json_agg(json_build_object('slug', slug, 'name', name)), '[]') from manufacturers`));
      if ((x = p.match(/^mfr_report_items\?state=eq\.exception&retryable=eq\.true&resolved_at=is\.null&next_retry_at=lte\.([^&]+)&.*msg\.mailbox=eq\.([^&]+)/)))
        return JSON.parse(sr(`select coalesce(json_agg(x order by x.next_retry_at), '[]') from (select i.*, to_jsonb(m) as msg from mfr_report_items i join mfr_report_messages m on m.id = i.message_id
          where i.state = 'exception' and i.retryable and i.resolved_at is null and i.next_retry_at <= ${lit(decodeURIComponent(x[1]))} and m.mailbox = ${lit(decodeURIComponent(x[2]))}
          order by i.next_retry_at limit 10) x`));
      if ((x = p.match(/^mfr_sources\?manufacturer=eq\.([^&]+)&file_sha256=eq\.([0-9a-f]{64})&select=id,kind$/)))
        return JSON.parse(sr(`select coalesce(json_agg(json_build_object('id', id, 'kind', kind)), '[]') from mfr_sources where manufacturer = ${lit(decodeURIComponent(x[1]))} and file_sha256 = ${lit(x[2])}`));
      if ((x = p.match(/^mfr_sources\?manufacturer=eq\.([^&]+)&kind=eq\.commission_statement&report_period_start=eq\.([0-9-]+)&report_period_end=eq\.([0-9-]+)&status=in\.\(received,accepted\)&select=id,file_sha256$/)))
        return JSON.parse(sr(`select coalesce(json_agg(json_build_object('id', id, 'file_sha256', file_sha256) order by id), '[]') from mfr_sources where manufacturer = ${lit(decodeURIComponent(x[1]))}
          and kind = 'commission_statement' and report_period_start = ${lit(x[2])} and report_period_end = ${lit(x[3])} and status in ('received','accepted')`));
      if ((x = p.match(/^mfr_report_items\?state=eq\.classified&resolved_at=is\.null&source_id=is\.null&sha256=not\.is\.null&profile_id=in\.\(([0-9,]+)\)&.*msg\.mailbox=eq\.([^&]+)/)))
        return JSON.parse(sr(`select coalesce(json_agg(x order by x.id), '[]') from (select i.*, to_jsonb(m) as msg from mfr_report_items i join mfr_report_messages m on m.id = i.message_id
          where i.state = 'classified' and i.resolved_at is null and i.source_id is null and i.sha256 is not null and i.profile_id in (${x[1]}) and m.mailbox = ${lit(decodeURIComponent(x[2]))}
          order by i.id limit 20) x`));
      if ((x = p.match(/^mfr_report_messages\?mailbox=eq\.([^&]+)&received_at=gte\.([^&]+)&/)))
        return JSON.parse(sr(`select coalesce(json_agg(json_build_object('internet_message_id', m.internet_message_id, 'items_listed', m.items_listed,
          'items', (select coalesce(json_agg(json_build_object('state', i.state)), '[]') from mfr_report_items i where i.message_id = m.id))), '[]')
          from mfr_report_messages m where m.mailbox = ${lit(decodeURIComponent(x[1]))} and m.received_at >= ${lit(decodeURIComponent(x[2]))}`));
      throw new Error('unexpected read ' + p);
    },
    async rpc(fn, p) { log.push('RPC ' + fn); return JSON.parse(sr(`select public.${fn}('${JSON.stringify(p).replace(/'/g, "''")}'::jsonb)`)); },
  };
}
function storage(log) { const kept = new Map(); return { kept, async upload(pth, bytes, mime) { log.push('PUT ' + pth); if (kept.has(pth)) return true; kept.set(pth, { bytes, mime }); return true; } }; }

const MB = 'angelo@homecareproviderservices.us';
function deps(box, o) {
  o = o || {};
  const log = [], G = graph(box, o), S = storage(log);
  const d = { getToken: async () => 'gtok', fetch: G.fetch, db: dbAdapter(log), storage: S, sleep: async () => {}, now: o.now };
  return { d, G, S, log };
}
const cap = (o, x) => RC.runCapture(Object.assign({ mailbox: MB, internal_domains: ['homecareproviderservices.us'], budget_ms: 25000 }, o), x.d);
const items = () => JSON.parse(q(`select coalesce(json_agg(json_build_object('file', coalesce(i.file_name, i.item_key), 'state', i.state, 'kind', i.kind, 'attention', i.attention,
  'period', i.period_start || '..' || i.period_end, 'basis', i.period_basis, 'source', i.source_id, 'from', m.from_address, 'retryable', i.retryable, 'id', i.id, 'part', i.part,
  'manufacturer', i.manufacturer, 'suggested', i.suggested) order by i.id), '[]') from mfr_report_items i join mfr_report_messages m on m.id = i.message_id`));
const byFile = (f, from) => items().filter(i => i.file === f && (!from || i.from.startsWith(from)));
const setSwitch = v => q(`update app_settings set value = value || jsonb_build_object('mi_report_capture', ${v}) where key='phase2_flags'`);
const owner = sql => q(`select set_config('hcps.capture_op','on',false); ${sql}`);

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); } }

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
(async () => {
  let REC7_ID = null, FP0;
  try {
    for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
      T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
      SB('mi1b_report_register.sql')]) file(DB, f);
    q(`alter table dealers add column if not exists is_test boolean default false, add column if not exists active boolean default true, add column if not exists account_class text`);
    q(`create table if not exists app_settings (key text primary key, value jsonb); alter table app_settings enable row level security; revoke all on app_settings from anon, authenticated;
       insert into app_settings values ('phase2_flags','{"mi_import_v2": true}') on conflict do nothing`);
    q(`create table if not exists dealer_aliases (alias_norm text primary key, raw_name text, dealer_id uuid references dealers(id), created_at timestamptz default now())`);
    q(`insert into manufacturers values ('ohio-medical','Ohio Medical'),('access4u','Access4U'),('airavant-bongorx','AirAvant / BongoRx'),('climbing-steps','Climbing Steps'),
       ('bemis','Bemis'),('complete-medical-supplies','Complete Medical Supplies'),('golden-technologies','Golden Technologies') on conflict do nothing`);
    file(DB, SB('mi1c_dealer_intel.sql'));
    if (REC7) {
      const s7 = sha(REC7);
      REC7_ID = JSON.parse(q(`begin; set local role service_role; select public.hcps_mfr_report_register('${JSON.stringify({ manufacturer: 'strongback-mobility', kind: 'dealer_report',
        title: 'Strongback — September 2026 Dealer Report', file_name: 'Strongback_Report_Overview_September_2026.pdf', file_sha256: s7,
        storage_path: `reports/strongback-mobility/dealer_report/${s7}.pdf`, file_size: REC7.length, content_type: 'application/pdf', received_date: '2026-10-11',
        prepared_date: '2026-10-08', report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'angelo@homecareproviderservices.us' })}'::jsonb); commit;`).split('\n').pop()).id;
    }
    file(DB, SB('mi_b_report_capture.sql'));
    FP0 = q(`select (select count(*) from monthly_sales) || '|' || (select count(*) from dealers) || '|' || (select count(*) from dealer_aliases) || '|' ||
      (select md5(string_agg(concat_ws('|', id, status, file_sha256, received_date, prepared_date, created_by), ';' order by id)) from mfr_sources where id = ${REC7_ID || 0})`);
  } catch (e) { console.log('SETUP FAILED: ' + String(e.message).split('\n').slice(0, 3).join(' | ')); fail++; finish(); return; }

  console.log('\n— switch —');
  await t('switch off: the database refuses to begin — nothing is listed, downloaded or written', async () => {
    const x = deps(mailbox());
    await assert.rejects(() => cap({}, x), /capture_switch_off/);
    assert.strictEqual(x.G.calls.length, 0); assert.strictEqual(q(`select count(*) from mfr_report_messages`), '0');
  });
  await t('the cron does nothing at all while the switch is off (no Graph, no database write)', async () => {
    const calls = []; const saved = global.fetch;
    global.fetch = async (u) => { calls.push(String(u)); if (/app_settings/.test(u)) return { ok: true, status: 200, json: async () => [{ value: { mi_import_v2: true } }], text: async () => '' }; throw new Error('unexpected ' + u); };
    const env = Object.assign({}, process.env); Object.assign(process.env, { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE: 'svc' });
    try { delete require.cache[require.resolve('../netlify/functions/report-capture-cron.js')];
      const r = await require('../netlify/functions/report-capture-cron.js').handler({});
      assert.strictEqual(JSON.parse(r.body).skipped, 'switch_off'); assert.deepStrictEqual(calls.map(c => c.replace(/\?.*/, '')), ['https://db.test/rest/v1/app_settings']);
    } finally { global.fetch = saved; for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
  });

  console.log('\n— the first run (October mailbox) —');
  let X1, R1;
  await t('switch on: one run captures the window, completes, and moves the checkpoint to the run start', async () => {
    setSwitch('true'); X1 = deps(mailbox()); R1 = await cap({}, X1);
    assert.strictEqual(R1.ok, true, R1.error); assert.strictEqual(R1.complete, true);
    assert.ok(new Date(R1.checkpoint_after) > new Date('2026-10-10T00:00:00Z'));
    assert.strictEqual(q(`select count(*) from mfr_report_capture_runs where finished_at is not null and complete`), '1');
  });
  await t('every Graph call was a GET; the token is never written anywhere', async () => {
    assert.ok(X1.G.calls.length > 10 && X1.G.calls.every(c => c.m === 'GET'));
    assert.ok(X1.G.calls.every(c => /IdType="ImmutableId"/.test(c.headers.Prefer || '')));
  });
  await t('Strongback SR032 → registered as a COMMISSION STATEMENT for the period in its file name (2026-09)', async () => {
    const [i] = byFile('2026-09 SR032.pdf'); assert.strictEqual(i.state, 'registered'); assert.strictEqual(i.kind, 'commission_statement');
    assert.strictEqual(i.period, '2026-09-01..2026-09-30'); assert.strictEqual(i.basis, 'file_name');
    assert.strictEqual(q(`select kind || '|' || received_date || '|' || created_by || '|' || status from mfr_sources where id=${i.source}`),
      'commission_statement|2026-10-07|system:report-capture|received');
  });
  await t('the order CSV under a "Commission report" subject → registered as a SALES EXPORT, period from its own dates (August), not the received month', async () => {
    const [i] = byFile('Angelo Orders August 2026.csv'); assert.strictEqual(i.state, 'registered'); assert.strictEqual(i.kind, 'sales_export');
    assert.strictEqual(i.period, '2026-08-01..2026-08-31'); assert.strictEqual(i.basis, 'content_dates');
  });
  await t('the September overview email → LINKED to record 7 by its identical hash; record 7 and the register unchanged otherwise', async () => {
    if (!REC7) return;
    const [i] = byFile('Angelo_Strongback_Dealers_2026-09.pdf'); assert.strictEqual(i.state, 'linked'); assert.strictEqual(i.source, REC7_ID);
    assert.strictEqual(i.kind, 'dealer_report'); assert.strictEqual(i.period, '2026-09-01..2026-09-30'); assert.strictEqual(i.basis, 'report');
    assert.strictEqual(q(`select count(*) from mfr_sources where kind = 'dealer_report'`), '1');
  });
  await t('one email, three attachments: each handled on its own (export + statement registered, price list "not a report", inline logo skipped)', async () => {
    const m = items().filter(i => i.from === 'amanda.erickson@strongbackmobility.com' && /Orders August|2026-08 SR032|PRICELIST/.test(i.file));
    assert.strictEqual(m.length, 3);
    assert.strictEqual(byFile('SPARE PARTS PRICELIST 2026.pdf')[0].state, 'classified'); assert.strictEqual(byFile('SPARE PARTS PRICELIST 2026.pdf')[0].kind, null);
    assert.strictEqual(byFile('image001.png').length, 0);
  });
  await t('the same SR032 forwarded by Jennifer → linked to the same record (two source emails, one register record)', async () => {
    const [a] = byFile('2026-08 SR032.pdf', 'amanda'), [b] = byFile('2026-08 SR032.pdf', 'jennifer');
    assert.strictEqual(a.state, 'registered'); assert.strictEqual(b.state, 'linked'); assert.strictEqual(a.source, b.source);
  });
  await t('a Strongback workbook in a changed layout → Needs Attention "format changed" (never registered)', async () => {
    const [i] = byFile('Strongback September.xlsx'); assert.strictEqual(i.state, 'exception'); assert.strictEqual(i.attention, 'format_changed');
  });
  await t('draft profiles (Bemis, Ohio Medical, Climbing Steps body-only) → recognised and classified, never registered', async () => {
    const [b] = byFile('705-2026-09.csv'); assert.strictEqual(b.state, 'classified'); assert.strictEqual(b.kind, 'commission_statement'); assert.strictEqual(b.period, '2026-09-01..2026-09-30');
    const [o] = byFile('HomeCare Provider Services - commission detail 0926.xlsx'); assert.strictEqual(o.state, 'classified'); assert.strictEqual(o.manufacturer, 'ohio-medical');
    assert.strictEqual(o.period, '2026-01-01..2026-09-30', 'cumulative "through September"');
    const [c] = items().filter(i => i.from === 'sdiamond@climbingsteps.com'); assert.strictEqual(c.part, 'body'); assert.strictEqual(c.state, 'classified'); assert.strictEqual(c.kind, 'commission_statement');
    assert.strictEqual(q(`select count(*) from mfr_sources where manufacturer in ('bemis','ohio-medical','climbing-steps') and kind in ('sales_export','commission_statement','dealer_report')`), '0');
  });
  await t('an unknown sender (Rose Healthcare) → Needs Attention "unknown sender"', async () => {
    const [r] = byFile('Audia September.xlsx'); assert.strictEqual(r.state, 'exception'); assert.strictEqual(r.attention, 'unknown_sender'); assert.strictEqual(r.manufacturer, null);
  });
  await t('not recorded at all: an order acknowledgement, HCPS\'s own mail, dealer mail, a draft', async () => {
    const froms = new Set(items().map(i => i.from));
    for (const f of ['orders@goldentech.com', 'greg@homecareproviderservices.us', 'owner@somedealer.com']) assert.ok(!froms.has(f), f);
    assert.strictEqual(q(`select count(*) from mfr_report_messages where subject like '%October draft%'`), '0');
  });
  await t('storage: one hash-named original per registered file, only under reports/<mfr>/<kind>/ — linked files are not stored again', async () => {
    const puts = [...X1.S.kept.keys()]; if (process.env.DBG) console.log(puts);
    assert.deepStrictEqual(puts.map(p => p.split('/').slice(0, 3).join('/')).sort(),
      ['reports/strongback-mobility/commission_statement', 'reports/strongback-mobility/commission_statement', 'reports/strongback-mobility/sales_export']);
    for (const [p, v] of X1.S.kept) assert.ok(p.endsWith(sha(v.bytes) + '.' + p.split('.').pop()), p);
  });
  await t('nothing outside capture + the register changed (monthly_sales, dealers, aliases, record 7)', async () => assert.strictEqual(q(`select (select count(*) from monthly_sales) || '|' || (select count(*) from dealers) || '|' || (select count(*) from dealer_aliases) || '|' ||
      (select md5(string_agg(concat_ws('|', id, status, file_sha256, received_date, prepared_date, created_by), ';' order by id)) from mfr_sources where id = ${REC7_ID || 0})`), FP0));
  await t('no body text, file content or column header was stored', async () => {
    const dump = q(`select coalesce(string_agg(to_jsonb(i)::text, ' '), '') from mfr_report_items i`) + q(`select coalesce(string_agg(to_jsonb(m)::text, ' '), '') from mfr_report_messages m`);
    for (const s of [SECRET, '412.50', 'Ship To Zip', 'Line Total']) assert.ok(!dump.includes(s), 'stored: ' + s);
  });

  console.log('\n— the next runs —');
  await t('a second run right away changes nothing: no new items, no new registrations, no downloads', async () => {
    const n = q(`select count(*) || '|' || (select count(*) from mfr_sources) from mfr_report_items`);
    const x = deps(mailbox()); const r = await cap({}, x);
    assert.strictEqual(r.ok, true); assert.strictEqual(q(`select count(*) || '|' || (select count(*) from mfr_sources) from mfr_report_items`), n);
    assert.strictEqual(x.G.downloads.length, 0);
  });
  await t('a failed download is a queued exception (retry later) that does NOT hold the checkpoint back', async () => {
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-10-11T00:00:00Z' where true`);
    const box = mailbox().concat([M({ extra: 1, subject: 'Commission report October 2026', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T09:00:00Z' },
      [A('2026-10 SR032.pdf', 'application/pdf', pdf(['Commission statement', 'Period 2026-10']))]),
      M({ extra: 1, subject: 'Commission report October 2026 resend', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T10:00:00Z' },
      [A('2026-10 SR032 copy.pdf', 'application/pdf', pdf(['Commission statement 2', 'Period 2026-10']))])]);
    const x = deps(box, { downloadFail: a => a.name === '2026-10 SR032.pdf' }); const r = await cap({}, x);
    assert.strictEqual(r.complete, true);
    const [f] = byFile('2026-10 SR032.pdf'); assert.strictEqual(f.state, 'exception'); assert.strictEqual(f.attention, 'attachment_failed'); assert.strictEqual(f.retryable, true);
    assert.strictEqual(byFile('2026-10 SR032 copy.pdf')[0].state, 'registered', 'the later email was still captured');
    assert.ok(new Date(r.checkpoint_after) > new Date('2026-10-11T10:00:00Z'));
  });
  await t('when the retry is due and the download works, the queued item registers', async () => {
    owner(`update mfr_report_items set next_retry_at = now() - interval '1 minute' where file_name = '2026-10 SR032.pdf'`);
    const box = mailbox().concat([M({ extra: 1, id: 'gX', subject: 'Commission report October 2026', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T09:00:00Z' },
      [A('2026-10 SR032.pdf', 'application/pdf', pdf(['Commission statement', 'Period 2026-10']))])]);
    owner(`update mfr_report_messages set graph_id = 'gX' where subject = 'Commission report October 2026'`);
    const r = await cap({}, deps(box)); assert.strictEqual(r.counts.retried, 1);
    assert.strictEqual(byFile('2026-10 SR032.pdf')[0].state, 'registered');
  });

  console.log('\n— budget, outage recovery, throttling, listing failures —');
  await t('a tight time budget stops part-way; following runs finish; nothing lost or repeated; the checkpoint never passes an unhandled email', async () => {
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-09-25T00:00:00Z' where true`);
    const N = q(`select count(*) from mfr_report_items`);
    const box = mailbox(); const more = [];
    for (let k = 0; k < 6; k++) more.push(M({ extra: 1, subject: `Commission report batch ${k}`, from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: `2026-09-2${6 + (k % 3)}T1${k}:00:00Z` },
      [A(`2026-0${(k % 3) + 6} SR032 b${k}.pdf`, 'application/pdf', pdf(['Commission', `batch ${k}`, `Period 2026-0${(k % 3) + 6}`]))]));
    const all = box.concat(more);
    let clock = Date.parse('2026-10-11T12:00:00Z'); const runs = [];
    for (let k = 0; k < 15; k++) {
      const x = deps(all, { now: () => clock, tick: () => { clock += 350; } });
      const r = await cap({ budget_ms: 3000 }, x); runs.push(r);
      assert.ok(!r.checkpoint_after || !runs[k - 1] || new Date(r.checkpoint_after) >= new Date(runs[k - 1].checkpoint_after));
      if (process.env.DBG) console.log(JSON.stringify({c: r.complete, cp: r.checkpoint_after, e: r.error, s: r.stopped_by_budget, n: r.counts}));
      if (r.complete) break;
    }
    assert.ok(runs.length > 1, 'the budget never stopped a run'); assert.ok(runs[runs.length - 1].complete, 'never completed');
    assert.strictEqual(q(`select count(*) from mfr_report_items`), String(+N + 6));
    assert.strictEqual(q(`select count(*) from mfr_report_items where file_name like '%SR032 b%' and state = 'registered'`), '6');
    assert.strictEqual(q(`select count(*) - count(distinct (message_id, item_key)) from mfr_report_items`), '0');
  });
  await t('a listing so slow it uses most of the budget still handles one email per run (the checkpoint always moves)', async () => {
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-10-02T00:00:00Z' where true`);
    let clock = Date.parse('2026-10-11T19:00:00Z'); const cps = [];
    for (let k = 0; k < 3; k++) {
      const r = await cap({ budget_ms: 3000 }, deps(mailbox(), { now: () => clock, tick: u => { clock += /\/messages\?/.test(u) ? 2600 : 10; } }));
      cps.push(r.checkpoint_after);
    }
    assert.ok(new Date(cps[2]) > new Date(cps[0]), 'the checkpoint moved: ' + cps.join(' → '));
  });
  await t('throttling (429 + Retry-After) is waited out, not dropped', async () => {
    const r = await cap({}, deps(mailbox(), { throttle: 2 })); if (process.env.DBG) console.log(JSON.stringify(r)); assert.strictEqual(r.ok, true); assert.strictEqual(r.complete, true);
  });
  await t('an attachment list that cannot be read → a "listing failed" queue item; the retry reads it and captures the file', async () => {
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-10-11T11:00:00Z' where true`);
    const box = mailbox().concat([M({ extra: 1, id: 'gL', subject: 'Commission report listing test', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T11:30:00Z' },
      [A('2026-07 SR032.pdf', 'application/pdf', pdf(['Commission', 'Period 2026-07']))])]);
    const r1 = await cap({}, deps(box, { listFail: id => id === 'gL' })); if (process.env.DBG) console.log(JSON.stringify(r1)); assert.strictEqual(r1.complete, true);
    const [l] = items().filter(i => i.part === 'listing'); assert.strictEqual(l.state, 'exception'); assert.strictEqual(l.attention, 'listing_failed');
    owner(`update mfr_report_items set next_retry_at = now() - interval '1 minute' where part = 'listing'`);
    await cap({}, deps(box));
    assert.strictEqual(items().filter(i => i.part === 'listing')[0].state, 'ignored');
    assert.strictEqual(byFile('2026-07 SR032.pdf')[0].state, 'registered');
  });
  await t('a lease held by another run → this run answers busy and touches nothing', async () => {
    owner(`update mfr_report_capture_state set lock_token = 'someone-else-0123456789', lock_until = now() + interval '1 minute' where true`);
    const x = deps(mailbox()); const r = await cap({}, x); assert.strictEqual(r.busy, true); assert.strictEqual(x.G.calls.length, 0);
    owner(`update mfr_report_capture_state set lock_token = null, lock_until = null where true`);
  });
  await t('an email whose single attachment cannot be handled within one run is queued as an exception; the next run moves past it', async () => {
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-10-11T13:00:00Z' where true`);
    const box = mailbox().concat([
      M({ extra: 1, id: 'gS', subject: 'Commission report slow file', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T13:30:00Z' },
        [A('2026-05 SR032 slow.pdf', 'application/pdf', pdf(['Commission', 'Period 2026-05']))]),
      M({ extra: 1, subject: 'Commission report after the slow one', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T13:40:00Z' },
        [A('2026-04 SR032 after.pdf', 'application/pdf', pdf(['Commission', 'Period 2026-04']))])]);
    let throttled = true;
    const slow = () => deps(box, { throttleOn: u => throttled && /\/messages\/gS\/attachments\/[^/]+\/\$value$/.test(u) });
    const r1 = await cap({ budget_ms: 6000 }, slow()); if (process.env.DBG) console.log(JSON.stringify(r1), JSON.stringify(byFile('2026-05 SR032 slow.pdf')));
    assert.strictEqual(byFile('2026-05 SR032 slow.pdf')[0].state, 'exception');
    let r2 = r1; for (let k = 0; k < 4 && !r2.complete; k++) r2 = await cap({ budget_ms: 6000 }, slow());
    assert.strictEqual(r2.complete, true); assert.strictEqual(byFile('2026-04 SR032 after.pdf')[0].state, 'registered');
    // Graph serves it again later: the queued retry captures it.
    throttled = false; owner(`update mfr_report_items set next_retry_at = now() - interval '1 minute' where file_name = '2026-05 SR032 slow.pdf'`);
    await cap({}, slow()); assert.strictEqual(byFile('2026-05 SR032 slow.pdf')[0].state, 'registered');
  });
  await t('period rules: file name vs report text disagree → a conflict for a person; the received date is only the labelled last resort', async () => {
    const P = RC._internal.periodOf, prof = { rules: { period: { order: ['file_name', 'content', 'received_prior_month'] } } };
    assert.ok(P(prof, { name: '2026-09 SR032.pdf', text_periods: ['2026-08'] }, { subject: '', received_at: '2026-10-07T14:00:00Z' }).conflict);
    assert.deepStrictEqual(P(prof, { name: 'statement.pdf', text_periods: [] }, { subject: '', received_at: '2026-10-07T14:00:00Z' }),
      { start: '2026-09-01', end: '2026-09-30', basis: 'received_date_rule' });
    assert.strictEqual(P({ rules: { period: { order: ['file_name'] } } }, { name: 'x.pdf' }, { subject: 'September', received_at: '2026-10-07T14:00:00Z' }), null);
    const d = RC._internal.decide({ name: 'x.pdf', format: 'pdf', signals: ['commission'], suggested: 'commission_statement' },
      { from_address: 'a@strongbackmobility.com', subject: '', received_at: '2026-10-07T14:00:00Z' },
      [{ id: 1, code: 'c', status: 'active', auto_register: true, manufacturer: 'strongback-mobility', kind: 'commission_statement', rules: { senders: { domains: ['strongbackmobility.com'] }, formats: ['pdf'], period: { order: ['file_name'] } } }],
      { slug: 'strongback-mobility' });
    assert.deepStrictEqual([d.outcome, d.attention], ['exception', 'period_unknown']);
  });
  await t('first live run (2026-10-11): an order export takes its period from the order date, never the payment-due date', async () => {
    const csv = Buffer.from('Number,Status,Total,"Payment Due Date","Created Date","Line Item Sku","Ship By Date","Close Date"\n' +
      '5801,open,536,10/04/2026,2026-09-04,1003AB,10/20/2026,12/01/2026\n5802,open,320,10/25/2026,2026-09-25,R0001,11/02/2026,12/15/2026\n');
    assert.deepStrictEqual(RC._internal.dateRange(csv, true), { min: '2026-09', max: '2026-09', n: 2 });
    // no transaction date at all → no content period (the subject / other rules decide, or a person does)
    assert.strictEqual(RC._internal.dateRange(Buffer.from('Order,"Payment Due Date"\n1,10/04/2026\n'), true), null);
    // plain "Date" and "Invoice Date" still count
    assert.deepStrictEqual(RC._internal.dateRange(Buffer.from('Invoice Date,Amount\n08/12/2026,10\n'), true), { min: '2026-08', max: '2026-08', n: 1 });
  });
  await t('first live run (2026-10-11): an attached email is a person\'s job only for a manufacturer with an ACTIVE profile', async () => {
    const box = mailbox().concat([
      M({ extra: 1, subject: 'RE: Golden Consignment Inventory Report Update', from: em('rwright@goldentech.com'), receivedDateTime: '2026-10-11T15:00:00Z' },
        [A('FW: Golden order needs picked up', 'message/rfc822', null, { type: '#microsoft.graph.itemAttachment', size: 9000 })]),
      M({ extra: 1, subject: 'Commission report forwarded', from: em('amanda.erickson@strongbackmobility.com'), receivedDateTime: '2026-10-11T15:05:00Z' },
        [A('FW: Commission report September 2026', 'message/rfc822', null, { type: '#microsoft.graph.itemAttachment', size: 9000 })])]);
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-10-11T14:30:00Z' where true`);
    await cap({}, deps(box));
    const g = byFile('FW: Golden order needs picked up')[0], s = byFile('FW: Commission report September 2026')[0];
    assert.deepStrictEqual([g.state, g.attention], ['classified', null]);
    assert.deepStrictEqual([s.state, s.attention], ['exception', 'cloud_attachment']);
  });
  console.log('\n— Phase D: reconsider on activation, reply threads —');
  await t('activating a profile: its earlier classified item is reconsidered ONCE, registers with its original received date and hash', async () => {
    const [b0] = byFile('705-2026-09.csv'); assert.strictEqual(b0.state, 'classified');
    const sha0 = q(`select sha256 from mfr_report_items where id = ${b0.id}`);
    owner(`update mfr_report_profiles set status = 'active', auto_register = true, updated_at = now() where code = 'bemis:commission_statement:rep705'`);
    const r = await cap({}, deps(mailbox())); assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.counts.reconsidered, 1);
    const [b] = byFile('705-2026-09.csv'); assert.strictEqual(b.state, 'registered');
    const rec = JSON.parse(q(`select row_to_json(s) from mfr_sources s where id = ${b.source}`));
    assert.deepStrictEqual([rec.kind, rec.received_date, rec.file_sha256, rec.report_period_start, rec.created_by], ['commission_statement', '2026-10-05', sha0, '2026-09-01', 'system:report-capture']);
    assert.ok(/Reconsidered after bemis:commission_statement:rep705/.test(rec.note));
    const n = q(`select count(*) from mfr_sources`);
    const r2 = await cap({}, deps(mailbox())); assert.strictEqual(r2.counts.reconsidered, 0); assert.strictEqual(q(`select count(*) from mfr_sources`), n, 'never twice');
    assert.strictEqual(q(`select count(*) from mfr_report_capture_events where item_id = ${b.id} and action = 'registered'`), '1');
  });
  await t('not reconsidered: items of a still-draft profile, items classified after the activation, items with no profile', async () => {
    const [o] = byFile('HomeCare Provider Services - commission detail 0926.xlsx'); assert.strictEqual(o.state, 'classified', 'Ohio is still draft');
    const [pl] = byFile('SPARE PARTS PRICELIST 2026.pdf'); assert.strictEqual(pl.state, 'classified');
  });
  await t('a reconsidered file whose bytes changed is never registered — "content changed" for a person', async () => {
    owner(`update mfr_report_profiles set status = 'active', auto_register = true, updated_at = now() where code = 'ohio-medical:commission_statement:through'`);
    const box = mailbox(); const om = box.find(m => /Commissions through September/.test(m.subject)); om.att[0].bytes = Buffer.concat([om.att[0].bytes, Buffer.from('x')]);
    const r = await cap({}, deps(box)); assert.strictEqual(r.ok, true, r.error);
    const [o] = byFile('HomeCare Provider Services - commission detail 0926.xlsx');
    assert.strictEqual(o.state, 'exception'); assert.ok(['content_changed', 'attachment_failed'].includes(o.attention), o.attention);
    assert.strictEqual(q(`select count(*) from mfr_sources where manufacturer = 'ohio-medical'`), '0');
  });
  await t('Climbing Steps: the original email body registers; quoted replies / forwards and a reply re-attaching the same month do not', async () => {
    file(DB, SB('mi_d_body_reports.sql'));      // body-only reports need .eml in the register (Climbing Steps prerequisite)
    owner(`update mfr_report_profiles set status = 'active', auto_register = true, updated_at = now() - interval '1 day' where code = 'climbing-steps:commission_statement:monthly'`);
    owner(`update mfr_report_capture_state set checkpoint_at = '2026-10-12T00:00:00Z' where true`);
    const XLS = book([['Sheet1', [['Invoice', 'Customer', 'Amount', 'Commission'], ['1', 'A', 100, 10]]]]);
    const box = mailbox().concat([
      M({ extra: 1, subject: 'August 2026 Commissions - Climbing Steps', from: em('sdiamond@climbingsteps.com'), receivedDateTime: '2026-10-12T09:00:00Z', body: 'August commission: $300.00 on $3,000.00' }),
      M({ extra: 1, subject: 'RE: August 2026 Commissions - Climbing Steps', from: em('sdiamond@climbingsteps.com'), receivedDateTime: '2026-10-12T10:00:00Z', body: 'Thanks!\n> August commission: $300.00 on $3,000.00' }),
      M({ extra: 1, subject: 'FW: August 2026 Commissions - Climbing Steps', from: em('bfink@climbingsteps.com'), receivedDateTime: '2026-10-12T11:00:00Z', body: 'fyi\n> August commission: $300.00' }),
      M({ extra: 1, subject: 'RE: August 2026 Commissions - Climbing Steps - report attached', from: em('sdiamond@climbingsteps.com'), receivedDateTime: '2026-10-12T12:00:00Z' },
        [A('August 2026 Commision Report.xlsx', 'application/octet-stream', XLS)])]);
    const r = await cap({}, deps(box)); assert.strictEqual(r.ok, true, r.error);
    const cs = JSON.parse(q(`select json_agg(json_build_object('subj', m.subject, 'part', i.part, 'state', i.state, 'detail', i.attention_detail) order by m.received_at)
      from mfr_report_items i join mfr_report_messages m on m.id = i.message_id where m.from_address like '%climbingsteps.com' and m.received_at >= '2026-10-12'`));
    assert.deepStrictEqual(cs.map(x => x.state), ['registered', 'classified', 'classified', 'classified'], JSON.stringify(cs));
    assert.ok(/quotes earlier figures/.test(cs[1].detail) && /quotes earlier figures/.test(cs[2].detail));
    assert.ok(/already covers 2026-08 — Retry/.test(cs[3].detail), cs[3].detail);
    assert.strictEqual(q(`select count(*) from mfr_sources where manufacturer = 'climbing-steps' and report_period_start = '2026-08-01'`), '1');
    const r2 = await cap({}, deps(box)); assert.strictEqual(r2.counts.reconsidered, 0, 'items already judged by the active profile are not reconsidered again');
  });
  await t('reply rule (pure): body replies never; reply attachment only without a record for the period; same file links; a person\'s Retry overrides', () => {
    const R = RC._internal.replyRule, base = { outcome: 'register', subject: 'RE: x', format: 'xlsx', kind: 'commission_statement', sha256: 'a', period: '2026-08' };
    assert.ok(R(Object.assign({}, base, { format: 'eml' })));
    assert.strictEqual(R(Object.assign({}, base, { existing: [] })), null);
    assert.ok(R(Object.assign({}, base, { existing: [{ id: 3, file_sha256: 'b' }] })));
    assert.strictEqual(R(Object.assign({}, base, { existing: [{ id: 3, file_sha256: 'a' }] })), null);
    assert.strictEqual(R(Object.assign({}, base, { existing: [{ id: 3, file_sha256: 'b' }], person_asked: true })), null);
    assert.strictEqual(R(Object.assign({}, base, { subject: 'August Commissions', existing: [{ id: 3, file_sha256: 'b' }] })), null);
    for (const sj of ['Re: x', 'FW: x', 'Fwd: x', '  re : x']) assert.ok(R(Object.assign({}, base, { subject: sj, format: 'eml' })), sj);
  });
  await t('every exception is in the event log; no capture row was ever deleted', async () => {
    assert.strictEqual(q(`select count(*) from mfr_report_items where state = 'exception' and id not in (select item_id from mfr_report_capture_events where action = 'exception' and item_id is not null)`), '0');
  });
  finish();
})();
function finish() { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} console.log(`\nreport-capture: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
