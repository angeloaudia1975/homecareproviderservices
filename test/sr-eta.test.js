/* Scheduled Routes — arrival times a dealer can be told (unit suite, no browser).

   Reported 2026-10-30: a heads-up showed "estimated arrival 1:21 AM EST on November 3". Two causes,
   both pinned here with the live "Darrell Travel" shape (synthetic copy: home base Cottontown, TN —
   Central — 9:00 departure, first stop Louisville, KY — Eastern — 141 min away):
     1. The day's start time was read in the FIRST STOP's zone, not the home base's: 9:00 became
        9:00 Eastern and every arrival was an hour early (stop 1: 11:21 AM EST; right: 12:21 PM EST).
     2. A route with a missing overnight runs its clock through the night, and the heads-up offered
        whatever time that produced. Now the time is left out (phone) and refused (server).
   Run: node test/sr-eta.test.js     MUTANTS=1 also proves each guard is load-bearing. */
const fs = require('fs');
const path = require('path');
const CLOCK = path.join(__dirname, '..', 'src', 'admin', 'route-clock.js');
const API = path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');
const PAGE = path.join(__dirname, '..', 'src', 'admin', 'scheduled-routes.html');

function loadClock(src) { const mod = { exports: {} }; new Function('module', 'exports', 'window', src)(mod, mod.exports, undefined); return mod.exports; }
function lift(src, name) {
  const at = src.indexOf('function ' + name + '('); if (at < 0) throw new Error('anchor not found: ' + name);
  let i = src.indexOf('{', at), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1); }
  throw new Error('unbalanced: ' + name);
}

/* Synthetic copy of the live route's shape (drive minutes as OpenRouteService returned them). */
const LEGS = [141, 15, 18, 34, 56, 36, 32, 62, 3, 55, 44, 44, 14, 43, 18].map(m => ({ duration_s: m * 60 }));
const STOPS = [
  ['KY', -85.71, null], ['KY', -85.59, 45], ['KY', -85.53, 45], ['IN', -85.82, 45, true], ['IN', -86.46, 45], ['IN', -86.48, 45], ['IN', -86.55, 45],
  ['IN', -85.89, 45], ['IN', -85.88, 45, true], ['IN', -85.21, 60], ['IN', -84.87, 45], ['OH', -84.38, 60], ['OH', -84.42, 60], ['KY', -84.48, null], ['KY', -84.65, null],
].map(([state, lng, vm, on]) => ({ state, lng, visit_min: vm, overnight: !!on, next_start_min: on ? 485 : null }));
const HOME = { lat: 36.51, lng: -86.64, address: '1003 wilkinson place cottontown, tn 37048', depart_time: '09:00' };

function run(srcClock, srcPage, srcApi) {
  const R = loadClock(srcClock);
  // the field app's own start-zone rule, lifted from the page
  const homeTz = new Function('RouteClock', lift(srcPage, 'homeTz') + '; return homeTz;')(R);
  const previsitEta = new Function(lift(srcApi, 'previsitEta') + '; return previsitEta;')();
  let pass = 0, fail = 0; const out = [];
  const t = (n, f) => { try { f(); pass++; out.push('  ok   ' + n); } catch (e) { fail++; out.push('  FAIL ' + n + '\n         ' + e.message); } };
  const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); };
  const itin = (stops, opts) => R.routeItinerary(Object.assign({ stops, legs: LEGS, leadingLeg: true, startDate: '2026-11-03', startMinutes: 9 * 60, defaultVisit: 30 }, opts));
  const show = it => R.fmtAbs(it.arriveAbs, it.tz);

  t('home base zone: Cottontown, TN (from the address) is Central', () => eq(homeTz({ round_trip: true, home_base: HOME }, true), 'America/Chicago'));
  t('home base zone: a home with a state field uses it', () => eq(homeTz({ home_base: Object.assign({}, HOME, { state: 'OH', lng: -84.5 }) }, true), 'America/New_York'));
  t('one-way route (no home leg): no start-zone override', () => eq(homeTz({ home_base: HOME }, false), undefined));
  t('Darrell Travel stop 1: 9:00 CST + 2 h 21 m drive = 12:21 PM EST (was 11:21 AM EST)', () => {
    const it = itin(STOPS, { startTz: homeTz({ home_base: HOME }, true) });
    eq(show(it[0]), '12:21 PM EST'); eq(it[0].dateISO, '2026-11-03');
  });
  t('without the start zone the old one-hour-early answer comes back (pins the cause)', () => eq(show(itin(STOPS, {})[0]), '11:21 AM EST'));
  t('overnights hold: every stop of the real 3-day plan lands inside business hours', () => {
    const it = itin(STOPS, { startTz: 'America/Chicago' });
    eq(it.map(x => x.dayIndex), [0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    eq(it.filter(x => R.outsideHours(x.arriveAbs, x.tz)).length, 0, 'after-hours stops');
    eq([it[4].dateISO, it[9].dateISO], ['2026-11-04', '2026-11-05']);
  });
  t('a missing overnight runs past midnight — and those stops are flagged after hours', () => {
    const it = itin(STOPS.map(s => Object.assign({}, s, { overnight: false })), { startTz: 'America/Chicago' });
    const off = it.map((x, i) => R.outsideHours(x.arriveAbs, x.tz) ? i + 1 : 0).filter(Boolean);
    if (!off.length || off[0] > 11) throw new Error('expected late stops flagged, got ' + off);
    if (!off.includes(12) || !off.includes(13)) throw new Error('the 3 AM / 4 AM stops must be flagged: ' + off);
    eq(it.slice(0, 6).some(x => R.outsideHours(x.arriveAbs, x.tz)), false, 'daytime stops flagged');
  });
  t('outsideHours: 7:00 and 19:00 inclusive are inside; 6:59 and 19:01 are outside; 1:21 AM is outside', () => {
    const at = (h, m) => R.localToAbs(2026, 10, 3, h * 60 + m, 'America/New_York');
    eq([R.outsideHours(at(7, 0), 'America/New_York'), R.outsideHours(at(19, 0), 'America/New_York'), R.outsideHours(at(6, 59), 'America/New_York'),
        R.outsideHours(at(19, 1), 'America/New_York'), R.outsideHours(at(1, 21), 'America/New_York')], [false, false, true, true, true]);
  });
  t('DST: Nov 1 2026 (fall back) — a 9:00 Central start on Nov 1 and Nov 2 both read 9:00 local', () => {
    for (const d of ['2026-11-01', '2026-11-02', '2026-10-31']) {
      const it = R.routeItinerary({ stops: [{ state: 'TN', lng: -86.6, visit_min: 0 }], legs: [], startDate: d, startMinutes: 540 });
      eq(R.fmtAbs(it[0].arriveAbs, it[0].tz).replace(/ C[DS]T$/, ''), '9:00 AM', d);
    }
  });
  t('server: the heads-up refuses 1:21 AM EST and says why', () => { const w = []; eq(previsitEta('1:21 AM EST', w), ''); if (!/outside business hours/.test(w[0] || '')) throw new Error(JSON.stringify(w)); });
  t('server: normal times pass through, cleaned', () => { eq(previsitEta('12:21 PM EST', []), '12:21 PM EST'); eq(previsitEta(' 9:05  am ', []), '9:05 AM'); eq(previsitEta('7:00 PM CST', []), '7:00 PM CST'); });
  t('server: 7:01 PM, 6:59 AM, 12:00 AM refused; garbage refused; empty is just empty', () => {
    eq(['7:01 PM', '6:59 AM', '12:00 AM', '11:30 PM'].map(x => previsitEta(x, [])), ['', '', '', '']);
    const w = []; eq(previsitEta('tomorrow-ish', w), ''); eq(w.length, 1); const w2 = []; eq(previsitEta('', w2), ''); eq(w2.length, 0);
    eq(previsitEta('13:15 PM', []), '');
  });
  t('server: 12:30 PM is noon-thirty (not 30 past midnight)', () => eq(previsitEta('12:30 PM EDT', []), '12:30 PM EDT'));
  return { pass, fail, out };
}

const src = { c: fs.readFileSync(CLOCK, 'utf8'), p: fs.readFileSync(PAGE, 'utf8'), a: fs.readFileSync(API, 'utf8') };
const r = run(src.c, src.p, src.a);
console.log(r.out.join('\n')); console.log(`\nsr-eta: ${r.pass} passed, ${r.fail} failed`);
let bad = r.fail;
if (process.env.MUTANTS) {
  const M = [
    ['c', 'const firstTz = o.startTz || tzForStop', 'const firstTz = tzForStop'],
    ['p', 'return RouteClock.tzForStop(st, isFinite(hb.lng)?Number(hb.lng):null);', 'return undefined;'],
    ['c', 'return m < a || m > b;', 'return false;'],
    ['c', 'return m < a || m > b;', 'return m < a;'],
    ['a', 'if(mins<7*60 || mins>19*60)', 'if(mins<0)'],
    ['a', "((+m[1])%12+(/[Pp]/.test(m[3])?12:0))", "(+m[1])"],
  ];
  let killed = 0;
  for (const [k, from, to] of M) {
    const s = Object.assign({}, src); if (!s[k].includes(from)) { console.log('MUTANT ANCHOR MISSING: ' + from); bad++; continue; }
    s[k] = s[k].split(from).join(to);
    let res; try { res = run(s.c, s.p, s.a); } catch (e) { res = { fail: 1 }; }
    if (res.fail) killed++; else console.log('SURVIVED: ' + from + ' → ' + to);
  }
  console.log(`mutants: ${killed}/${M.length} killed`); if (killed !== M.length) bad++;
}
process.exitCode = bad ? 1 : 0;
