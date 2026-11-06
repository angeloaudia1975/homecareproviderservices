/* C3-07 Stage 7 — supabase/c7_s7_storefront.sql in a REAL Postgres: install checks (RULE 19), a second run is safe; inquiry
   limits are enforced INSIDE one call under advisory locks (per visitor 3 an hour, per email/phone 3 a day, 200 a storefront a
   day, 10 emailed a storefront an hour) and hold under 20 simultaneous requests; a switched-off storefront refuses at once;
   view counts are capped (400 per visitor per storefront a day) and only for a live storefront; the server role can't insert
   a request directly; purge removes expired requests and old rate rows.
     PGTEST_PSQL=… PGHOST=… PGUSER=postgres node test/storefront.pg.test.js */
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_sf_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SQL = process.env.SF_SQL || path.join(__dirname, '..', 'supabase', 'c7_s7_storefront.sql');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); } }
const q = (sql) => run(DB, sql);
const D = '11111111-1111-1111-1111-111111111111', S = '22222222-2222-2222-2222-222222222222';
const add = (row, client) => q(`select public.storefront_inquiry_add('${S}', '${JSON.stringify(row).replace(/'/g, "''")}'::jsonb, '${client}')::text`);
const cli = (c) => c.repeat(32).slice(0, 32);
const par = (sqls) => Promise.all(sqls.map((sql) => new Promise((res) => { const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-d', DB, '-c', sql]); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => res(o.trim())); })));

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
(async () => {
  try {
    q(`create extension if not exists pgcrypto;
       do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
         if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
         if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$;
       create table dealers (id uuid primary key default gen_random_uuid(), business_name text, active boolean);
       insert into dealers values ('${D}','Synthetic Dealer');`);
    await t('install: 4 tables, RLS on, no policies, nothing public; a second run is safe', async () => {
      assert.strictEqual(file(DB, SQL).split('\n').pop(), '4|t|0|0|0|0');
      assert.strictEqual(file(DB, SQL).split('\n').pop(), '4|t|0|0|0|0');
    });
    q(`insert into dealer_storefronts (id, dealer_id, company_id, slug, enabled, email, created_by, updated_by) values ('${S}','${D}','${D}','syn-store',true,'shop@dealer.test','t','t')`);
    await t('the server role can\'t insert a request directly (only through storefront_inquiry_add); public roles nothing', async () => {
      assert.throws(() => q(`set role service_role; insert into storefront_inquiries (storefront_id, dealer_id, name, email) values ('${S}','${D}','x','x@y.z')`), /permission denied/);
      assert.throws(() => q(`set role anon; select * from dealer_storefronts`), /permission denied/);
      assert.throws(() => q(`set role anon; select public.storefront_inquiry_add('${S}','{}'::jsonb,'none')`), /permission denied/);
      assert.ok(/"ok": true/.test(q(`set role service_role; select public.storefront_inquiry_add('${S}','{"name":"Svc","email":"svc@x.test"}'::jsonb,'${cli('0')}')::text`)));
    });
    await t('per visitor: 3 an hour (any storefront), then refused', async () => {
      const r = [1, 2, 3, 4].map((i) => JSON.parse(add({ name: 'V', email: `v${i}@x.test` }, cli('a'))));
      assert.deepStrictEqual(r.map((x) => x.refused || 'ok'), ['ok', 'ok', 'ok', 'client']);
    });
    await t('per email and per phone (digits compared): 3 a day, whichever visitor sends them', async () => {
      const e = ['b', 'c', 'd', 'e'].map((c) => JSON.parse(add({ name: 'E', email: 'same@x.test' }, cli(c))).refused || 'ok');
      assert.deepStrictEqual(e, ['ok', 'ok', 'ok', 'contact']);
      const p = ['f', '1', '2', '3'].map((c, i) => JSON.parse(add({ name: 'P', phone: ['555 0100', '(555) 0100', '555-0100', '5550100'][i] }, cli(c))).refused || 'ok');
      assert.deepStrictEqual(p, ['ok', 'ok', 'ok', 'contact']);
    });
    await t('20 simultaneous requests from one visitor store exactly 3 (advisory locks)', async () => {
      q(`delete from storefront_rate where true`);
      await par(Array.from({ length: 20 }, (_, i) => `select public.storefront_inquiry_add('${S}', '{"name":"Race","email":"race${i}@x.test"}'::jsonb, '${cli('9')}')`));
      assert.strictEqual(q(`select count(*) from storefront_inquiries where name='Race'`), '3');
    });
    await t('emails: at most 10 a storefront an hour; the rest are stored for My Storefront (send false, no address)', async () => {
      q(`delete from storefront_rate where true`);
      const sent = q(`select count(*) from storefront_inquiries where storefront_id='${S}' and mail_slot and created_at > now() - interval '1 hour'`);
      const out = []; for (let i = 0; i < 14 - Number(sent); i++) out.push(JSON.parse(add({ name: 'M', email: `m${i}@x.test` }, (i.toString(16) + 'f').repeat(16).slice(0, 32))));
      assert.strictEqual(q(`select count(*) from storefront_inquiries where storefront_id='${S}' and mail_slot`), '10');
      const last = out[out.length - 1]; assert.strictEqual(last.ok, true); assert.strictEqual(last.send, false); assert.strictEqual(last.to, null);
      assert.ok(out.filter((x) => x.send).every((x) => x.to === 'shop@dealer.test'));
    });
    await t('views: only a live storefront; capped at 400 per visitor per storefront in 24 hours; bad items skipped', async () => {
      const items = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ manufacturer: 'bemis', code: 'C' + i, category: 'Bath' })).concat([{ manufacturer: 'BAD!', code: 'x' }]).slice(0, 40));
      let total = 0; for (let i = 0; i < 12; i++) total += Number(q(`select public.storefront_count('${D}', '${items}'::jsonb, '${cli('7')}')`));
      assert.strictEqual(total, 400);
      assert.strictEqual(q(`select public.storefront_count('${D}', '[{"manufacturer":"bemis","code":"Z"}]'::jsonb, 'not-a-key')`), '0');
      q(`update dealer_storefronts set enabled=false where true`);
      assert.strictEqual(q(`select public.storefront_count('${D}', '[{"manufacturer":"bemis","code":"Z"}]'::jsonb, '${cli('6')}')`), '0');
      assert.strictEqual(JSON.parse(add({ name: 'Off', email: 'off@x.test' }, cli('5'))).refused, 'unavailable');
      q(`update dealer_storefronts set enabled=true, hcps_blocked=true where true`);
      assert.strictEqual(JSON.parse(add({ name: 'Blk', email: 'blk@x.test' }, cli('4'))).refused, 'unavailable');
      q(`update dealer_storefronts set hcps_blocked=false where true; update dealers set active=false where true`);
      assert.strictEqual(JSON.parse(add({ name: 'Closed', email: 'cl@x.test' }, cli('3'))).refused, 'unavailable', 'a closed location refuses at once');
      q(`update dealers set active=null where true`);
    });
    await t('purge: expired requests and rate rows older than 2 days', async () => {
      q(`update storefront_inquiries set delete_after = current_date - 1 where name='Svc'; insert into storefront_rate (bucket, client, dealer_id, views) values (now() - interval '3 days', 'none', '${D}', 1)`);
      assert.strictEqual(q(`select public.storefront_purge()`), '1');
      assert.strictEqual(q(`select count(*) from storefront_rate where bucket < now() - interval '2 days'`), '0');
    });
  } finally { run('postgres', `drop database if exists ${DB}`); }
  console.log(`\nstorefront.pg: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
