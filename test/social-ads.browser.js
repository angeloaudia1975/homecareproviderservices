/* Catalog 4 §8 — the Social Ads editor in a real browser (Chromium), desktop / tablet / iPhone / Android widths.
   Loads the ordering site's /assets/ad-builder.js into a page with a fake dealer-ads-api (synthetic products and images —
   nothing reaches a server). Checks: it mounts; templates, sizes and products change the live canvas; the price is the
   catalog's (never typed); a promotion in the words shows a warning and blocks the download; a clean ad downloads a PNG and
   a JPEG of the right size; save / reopen / duplicate send the right requests; no horizontal scroll; controls ≥ 44 px.
     ORDER_REPO=… node test/social-ads.browser.js */
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ORD = process.env.ORDER_REPO || path.join(__dirname, '..', '..', 'homecareproviderservicesordering');
const JS = fs.readFileSync(path.join(ORD, 'public', 'assets', 'ad-builder.js'), 'utf8');
const ADS = require(path.join(__dirname, '..', 'netlify', 'functions', '_social_ads.js'));
let pass = 0, fail = 0;
const ok = (c, w) => { if (!c) throw new Error(w); };
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); } }

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Inter,Arial;overflow-x:hidden}.page{padding:16px}.btn{display:inline-flex;align-items:center;padding:8px 14px;border:1px solid #ccc;border-radius:8px;cursor:pointer}.ph{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}</style></head>
<body><div class="page"><div id="host"></div></div><script>
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function png(color){ const c=document.createElement('canvas'); c.width=400; c.height=300; const x=c.getContext('2d'); x.fillStyle=color; x.fillRect(0,0,400,300); return c.toDataURL('image/png'); }
const CTX=${JSON.stringify({ ok: true, preview: false, head_office: true, can_edit: true, location_id: 'L1',
    locations: [{ id: 'L1', name: 'Acme Medical', city: 'Dayton', can_edit: true }, { id: 'L2', name: 'Acme Branch', city: 'Xenia', can_edit: true }],
    dealer: { name: 'Acme Medical', address: '1 Main St', city: 'Dayton', state: 'OH', phone: '555-0100', website: 'https://acme.test', link: 'https://shop.test/store/acme', has_logo: true },
    products: [{ manufacturer: 'bemis', code: 'B1', name: 'Raised Toilet Seat', category: 'Bath Safety', image: '/x/B1.jpg', price: 99.99, price_label: 'MSRP' },
      { manufacturer: 'strongback', code: 'S1', name: 'Comfort Chair', category: 'Wheelchairs', image: '/x/S1.jpg', price: null, price_label: 'Call for Price' },
      { manufacturer: 'bemis', code: 'B7', name: 'Heat Therapy Pad', category: 'Comfort', image: null, price: 49, price_label: 'MSRP' }],
    templates: ADS.TEMPLATES, formats: ADS.FORMATS, fonts: ADS.FONTS, ctas: ADS.CTAS, limits: ADS.LIMITS, publishing: { enabled: false, note: 'Opens once the platforms approve.' } })};
window.CALLS=[]; const SAVED={};
const CLAIM=/\\$\\s*\\d|\\d+\\s*%|\\b(?:sale|save|free|discount)\\b/i;
async function api(b){ CALLS.push(JSON.parse(JSON.stringify(b)));
  if(b.action==='ads_context') return Object.assign({},CTX,{location_id:b.location_id||'L1'});
  if(b.action==='ads_list') return {ok:true,ads:Object.values(SAVED).map(r=>r.row)};
  if(b.action==='ad_image') return {ok:true,data_url:png(b.logo?'#22aa55':'#3366cc')};
  if(b.action==='ads_suggest') return {ok:true,captions:['Now at Acme Medical in Dayton, OH: Raised Toilet Seat. Visit us today.'],hashtags:['BathSafety','Dayton']};
  if(b.action==='ads_check'||b.action==='ads_save'){ for(const f of ['headline','body','cta','caption']){ const m=String(b.ad[f]||'').match(CLAIM); if(m) return {ok:false,error:'The '+f+' contains a promotion ("'+m[0]+'")',field:f}; }
    if(b.action==='ads_check') return {ok:true,products:(b.ad.products||[]).map(r=>Object.assign({},CTX.products.find(p=>p.code===r.code),window.NEWPRICE&&r.code==='B1'?{price:window.NEWPRICE}:{}))};
    const id=b.id||('ad'+(Object.keys(SAVED).length+1)); const v=(SAVED[id]?SAVED[id].row.version:0)+1;
    SAVED[id]={row:{id,dealer_id:b.location_id,title:b.ad.title,template:b.ad.template,format:b.ad.format,headline:b.ad.headline,version:v,updated_at:new Date().toISOString()},ad:b.ad}; return {ok:true,row:SAVED[id].row}; }
  if(b.action==='social_status') return window.SOCIAL||{ok:true,platforms:[{platform:'facebook',ok:false,reason:'publishing_off'}],connections:[],posts:[]};
  if(b.action==='post_save'){ window.POSTED=b; const p={id:'p1',ad_id:b.ad_id,platforms:b.platforms,scheduled_at:b.scheduled_at,status:'awaiting_approval',version:1}; (window.SOCIAL.posts=[p]); return {ok:true,post:p}; }
  if(b.action==='post_approve'){ window.SOCIAL.posts[0].status='approved'; window.SOCIAL.posts[0].version=2; return {ok:true,post:window.SOCIAL.posts[0]}; }
  if(b.action==='ads_get'){ const r=SAVED[b.id]; return r?{ok:true,row:r.row,ad:r.ad,products:[],problems:[]}:{ok:false,error:'gone'}; }
  if(b.action==='ads_duplicate'){ const r=SAVED[b.id]; const id='ad'+(Object.keys(SAVED).length+1); SAVED[id]={row:Object.assign({},r.row,{id,title:(r.row.title||'')+' (copy)',version:1}),ad:r.ad}; return {ok:true,row:SAVED[id].row,dropped:0}; }
  return {ok:false,error:'unknown'}; }
</script><script>${JS.replace(/<\/script>/gi, '<\\/script>')}</script>
<script>window.HCPSAdBuilder.mount(document.getElementById('host'),{api,esc});</script></body></html>`;

const SIZES = [['desktop', 1280, 900], ['tablet', 768, 1024], ['iphone', 390, 844], ['android', 412, 915]];
(async () => {
  const browser = await chromium.launch();
  for (const [name, w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, hasTouch: w < 800, deviceScaleFactor: 1 });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.setContent(PAGE); await page.waitForSelector('#adbCanvas');
    await t(`${name}: mounts with the account's products and store details; no horizontal scroll; no script errors`, async () => {
      await page.waitForFunction(() => document.querySelectorAll('[data-pk]').length === 3);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth); ok(sw <= w + 1, 'scrollWidth ' + sw);
      ok(!errs.length, errs.join('; '));
    });
    await t(`${name}: picking a product draws it with the catalog price; size changes the canvas`, async () => {
      await page.click('[data-pk="bemis|B1"]'); await page.fill('#adbHead', 'Feel steadier at home'); await page.waitForTimeout(250);
      const dims = await page.evaluate(() => { const c = document.getElementById('adbCanvas'); return [c.width, c.height]; }); ok(dims[0] === 1080 && dims[1] === 1080, String(dims));
      await page.click('[data-fmt="story"]'); await page.waitForTimeout(250);
      const d2 = await page.evaluate(() => { const c = document.getElementById('adbCanvas'); return [c.width, c.height]; }); ok(d2[0] === 1080 && d2[1] === 1920, String(d2));
      const painted = await page.evaluate(() => { const c = document.getElementById('adbCanvas'); const x = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data; return Array.from(x); });
      ok(painted[3] === 255, 'canvas painted');
      ok(await page.evaluate(() => window.HCPSAdBuilder._state.cur.products[0].code === 'B1'), 'B1 chosen');
    });
    await t(`${name}: a promotion in the words warns and blocks the download`, async () => {
      await page.fill('#adbBody', 'Save 20% this week'); await page.waitForTimeout(100);
      ok(/can't be used/.test(await page.textContent('#wBody')), 'live warning');
      await page.click('#adbPng'); await page.waitForTimeout(300);
      ok(/promotion/.test(await page.textContent('#adbMsg')), 'server refusal shown');
      await page.fill('#adbBody', 'See it at our Dayton showroom.'); await page.waitForTimeout(100);
      ok((await page.textContent('#wBody')).trim() === '', 'warning cleared');
    });
    await t(`${name}: a clean ad downloads as PNG and JPEG at the chosen size`, async () => {
      for (const [btn, ext] of [['#adbPng', 'png'], ['#adbJpg', 'jpg']]) {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
        ok(dl.suggestedFilename().endsWith('-story.' + ext), dl.suggestedFilename());
        const p = await dl.path(); const buf = fs.readFileSync(p);
        if (ext === 'png') { ok(buf.readUInt32BE(16) === 1080 && buf.readUInt32BE(20) === 1920, 'png size'); } else ok(buf[0] === 0xff && buf[1] === 0xd8, 'jpeg');
      }
      ok(await page.evaluate(() => CALLS.filter((c) => c.action === 'ads_check').length >= 3), 'every download checked by the server');
      await page.evaluate(() => { window.NEWPRICE = 123.45; }); const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#adbPng')]); await d2.path();
      ok(await page.evaluate(() => window.HCPSAdBuilder._state.ctx.products.find((p) => p.code === 'B1').price === 123.45), 'the export uses the price the server just confirmed');
      await page.evaluate(() => { window.NEWPRICE = null; });
    });
    await t(`${name}: grid template takes 2–4 products; general ad takes none`, async () => {
      await page.click('[data-tpl="grid"]'); await page.click('[data-pk="strongback|S1"]'); await page.click('[data-pk="bemis|B7"]'); await page.waitForTimeout(200);
      ok(await page.evaluate(() => window.HCPSAdBuilder._state.cur.products.length === 3), 'three products');
      await page.click('[data-tpl="brand"]'); ok(await page.evaluate(() => window.HCPSAdBuilder._state.cur.products.length === 0), 'brand ad has no product');
      await page.click('[data-tpl="spotlight"]');
    });
    await t(`${name}: save → list → reopen → duplicate; suggestions fill the caption`, async () => {
      await page.click('[data-pk="bemis|B1"]'); await page.fill('#adbTitle', 'Seat ad');
      await page.click('#adbSug'); await page.waitForSelector('[data-cap="0"]'); await page.click('[data-cap="0"]');
      ok(/Raised Toilet Seat/.test(await page.inputValue('#adbCap')), 'caption used');
      await page.click('#adbSave'); await page.waitForFunction(() => /Saved/.test(document.getElementById('adbMsg').textContent));
      await page.waitForSelector('[data-open="ad1"]'); await page.click('[data-dup="ad1"]'); await page.waitForSelector('[data-open="ad2"]');
      await page.click('[data-open="ad1"]'); await page.waitForTimeout(200);
      ok(await page.evaluate(() => window.HCPSAdBuilder._state.cur.title === 'Seat ad'), 'reopened');
      const saved = await page.evaluate(() => CALLS.find((c) => c.action === 'ads_save'));
      ok(!JSON.stringify(saved.ad).includes('99.99'), 'no typed price stored');
    });
    await t(`${name}: while publishing is off the schedule section only explains; once on, a saved ad is scheduled and waits for the dealer's approval`, async () => {
      ok(/approve/.test(await page.textContent('#adbPub')), 'off note');
      ok(!(await page.$('#adbSched')), 'no schedule button while off');
      await page.evaluate(() => { window.SOCIAL = { ok: true, platforms: [{ platform: 'facebook', ok: true }, { platform: 'instagram', ok: true }, { platform: 'linkedin', ok: false }], connections: [{ id: 'c1', platform: 'facebook', external_id: 'page1', account_name: 'Acme Page', status: 'connected' }], posts: [] }; });
      await page.click('[data-tpl="spotlight"]'); await page.evaluate(() => window.HCPSAdBuilder._state && true);
      await page.evaluate(async () => { const S = window.HCPSAdBuilder._state; S.social = window.SOCIAL; });
      await page.click('[data-fmt="square"]');
      await page.waitForSelector('#adbSched'); ok(!(await page.$('[data-plat="instagram"]')), 'only connected platforms'); await page.check('[data-plat="facebook"]');
      await page.fill('#adbWhen', '2031-01-15T10:30'); await page.click('#adbSched'); await page.waitForSelector('[data-pa="post_approve"]');
      ok(await page.evaluate(() => /^data:image\/png;base64,/.test(window.POSTED.media) && window.POSTED.platforms.join() === 'facebook'), 'rendered image sent');
      await page.click('[data-pa="post_approve"]'); await page.waitForFunction(() => /Approved/.test(document.getElementById('adbPub').textContent));
    });
    await t(`${name}: the main actions are real buttons a keyboard reaches`, async () => {
      ok(await page.evaluate(() => ['adbSave', 'adbPng', 'adbJpg', 'adbCopy', 'adbNew'].every((id) => document.getElementById(id).tagName === 'BUTTON')), 'buttons');
      ok(await page.evaluate(() => document.querySelector('[data-pk="bemis|B1"]').getAttribute('aria-selected') === 'true'), 'aria-selected');
    });
    await t(`${name}: controls are at least 44px tall`, async () => {
      const small = await page.evaluate(() => [...document.querySelectorAll('.adb-opt,.adb-acts .btn,.adb-p,.adb-sw button,.adb-card .btn,.adb-colors input')].filter((el) => el.offsetParent && el.getBoundingClientRect().height < 43.5).map((el) => el.textContent.trim().slice(0, 20)));
      ok(!small.length, small.join(' | '));
      if (w < 800) { const fs16 = await page.evaluate(() => [...document.querySelectorAll('.adb input[type=text],.adb textarea,.adb select')].every((el) => parseFloat(getComputedStyle(el).fontSize) >= 16)); ok(fs16, 'inputs 16px on phones'); }
    });
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `social-ads-${name}.png`), fullPage: false });
    await ctx.close();
  }
  await browser.close();
  console.log(`\nsocial ads browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
