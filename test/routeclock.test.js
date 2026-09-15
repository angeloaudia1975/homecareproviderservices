/* Route clock — behaviour suite.
   Loads the real src/admin/route-clock.js and runs it.

   This decides what time a dealer is told their rep is arriving. Getting it wrong
   is not a display bug: a three-day Kentucky loop was printed as one continuous
   day, so stops landed at 12:25 AM and 3:22 AM, and the pre-visit emails offered
   those times to real customers. */
const fs = require('fs');
const path = require('path');

const SRC = process.env.ROUTE_CLOCK
  || path.join(__dirname, '..', 'src', 'admin', 'route-clock.js');

function load(src){
  const js = src !== undefined ? src : fs.readFileSync(SRC, 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'window', js)(mod, mod.exports, undefined);
  return mod.exports;
}

let pass = 0, fail = 0;
const out = [];
function t(name, fn){
  try { fn(); pass++; out.push('  ok   ' + name); }
  catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); }
}
function eq(a, b, what){
  if(JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}
function ok(v, msg){ if(!v) throw new Error(msg || 'expected truthy'); }

function run(src){
  const R = load(src);
  pass = 0; fail = 0; out.length = 0;

  const leg = m => ({ duration_s: m * 60 });
  const hhmm = (it) => R.fmtAbs(it.arriveAbs, it.tz).replace(/\s[A-Z]{3}$/, '');

  /* ---- THE ONE THAT MAILED DEALERS 3 AM ---------------------------------- */
  t('an overnight ends the day and the next stop starts next morning', () => {
    const stops = [
      { state:'OH', lng:-83.40, visit_min:30, overnight:true, next_start_min:8*60 },
      { state:'OH', lng:-84.37, visit_min:30 },
    ];
    const it = R.routeItinerary({ stops, legs:[leg(120)], startDate:'2026-09-16', startMinutes:20*60 });
    eq(it[0].dateISO, '2026-09-16', 'stop 1 date');
    eq(it[1].dateISO, '2026-09-17', 'stop 2 rolls to the next day');
    /* The day starts at 8:00 and the rep then DRIVES — two hours here — so the
       arrival is 10:00, not 8:00. The point is that it is 10:00 on the 17th
       rather than 10:20 PM on the 16th. */
    eq(hhmm(it[1]), '10:00 AM', 'day start plus the drive');
    eq([it[0].dayIndex, it[1].dayIndex], [0, 1], 'day indices');
  });

  t('without the overnight flag the clock runs straight through the night', () => {
    // The old behaviour, kept as a test so the difference is explicit.
    const stops = [{ state:'OH', lng:-83.40, visit_min:30 }, { state:'OH', lng:-84.37, visit_min:30 }];
    const it = R.routeItinerary({ stops, legs:[leg(300)], startDate:'2026-09-16', startMinutes:20*60 });
    eq(it[1].dateISO, '2026-09-17', 'it does cross midnight');
    eq(it[1].dayIndex, 0, 'but it is still the same working day, not a new one');
  });

  t('a three-day loop reports three days', () => {
    const stops = [
      { state:'KY', lng:-85.93, visit_min:45 },
      { state:'OH', lng:-83.40, visit_min:30, overnight:true, next_start_min:8*60 },
      { state:'OH', lng:-84.37, visit_min:90, overnight:true, next_start_min:8*60 },
      { state:'KY', lng:-85.58, visit_min:45 },
    ];
    const it = R.routeItinerary({ stops, legs:[leg(200),leg(60),leg(90)],
      startDate:'2026-09-16', startMinutes:8*60 });
    eq(R.dayCount(it), 3, 'days');
    eq(it.map(x => x.dateISO), ['2026-09-16','2026-09-16','2026-09-17','2026-09-18'], 'dates');
  });

  t('each overnight uses its own next-start time', () => {
    const stops = [
      { state:'OH', lng:-84, visit_min:0, overnight:true, next_start_min:7*60+30 },
      { state:'OH', lng:-84, visit_min:0, overnight:true, next_start_min:9*60+15 },
      { state:'OH', lng:-84, visit_min:0 },
    ];
    // zero-length hops so the arrival IS the day start, and the times read plainly
    const it = R.routeItinerary({ stops, legs:[leg(0),leg(0)], startDate:'2026-09-16', startMinutes:8*60 });
    eq(hhmm(it[1]), '7:30 AM', 'second day');
    eq(hhmm(it[2]), '9:15 AM', 'third day');
  });

  t('the morning drive is added after the day starts, not before it', () => {
    /* Which way round this goes decides whether a 7:00 start with a two-hour drive
       means arriving at 7:00 or at 9:00. The rep leaves at 7:00 and arrives at 9:00. */
    const stops = [{ state:'OH', lng:-84, visit_min:0, overnight:true, next_start_min:7*60 },
                   { state:'OH', lng:-84 }];
    const it = R.routeItinerary({ stops, legs:[leg(120)], startDate:'2026-09-16', startMinutes:8*60 });
    eq(hhmm(it[1]), '9:00 AM', 'arrival');
  });

  t('an overnight with no stated start time falls back to 8am', () => {
    const stops = [{ state:'OH', lng:-84, visit_min:0, overnight:true }, { state:'OH', lng:-84 }];
    const it = R.routeItinerary({ stops, legs:[leg(0)], startDate:'2026-09-16', startMinutes:14*60 });
    eq(hhmm(it[1]), '8:00 AM', 'default');
  });

  /* ---- timezones --------------------------------------------------------- */
  t('the Kentucky Central/Eastern line is respected', () => {
    /* Glasgow KY is Central, Louisville KY is Eastern. A browser-local clock shows
       one of them an hour wrong no matter where the rep is standing. */
    eq(R.tzForStop('KY', -85.93), R.TZ_C, 'Glasgow');
    eq(R.tzForStop('KY', -85.58), R.TZ_E, 'Louisville');
    eq(R.tzForStop('TN', -86.7),  R.TZ_C, 'Nashville');
    eq(R.tzForStop('TN', -83.9),  R.TZ_E, 'Knoxville');
    eq(R.tzForStop('IN', -87.5),  R.TZ_C, 'Evansville corner');
    eq(R.tzForStop('OH', -84),    R.TZ_E, 'Ohio');
  });

  t('the start time is read in the FIRST stop\'s zone', () => {
    // 08:00 leaving Glasgow is 08:00 Central, which is 09:00 Eastern.
    const central = R.routeItinerary({ stops:[{state:'KY',lng:-85.93}], legs:[], startDate:'2026-09-16', startMinutes:8*60 });
    const eastern = R.routeItinerary({ stops:[{state:'KY',lng:-85.58}], legs:[], startDate:'2026-09-16', startMinutes:8*60 });
    eq(eastern[0].arriveAbs - central[0].arriveAbs, -3600000, 'one hour apart');
  });

  t('each stop reports its own zone, so a crossing route reads correctly', () => {
    const it = R.routeItinerary({ stops:[{state:'KY',lng:-85.93},{state:'KY',lng:-85.58}],
      legs:[leg(120)], startDate:'2026-09-16', startMinutes:8*60 });
    eq([it[0].tz, it[1].tz], [R.TZ_C, R.TZ_E], 'zones');
  });

  t('a stop\'s date is its OWN local date, even when that differs from Eastern', () => {
    /* A late call in Glasgow: 11:30 PM Central is already 12:30 AM Eastern the next
       day. The date the dealer would write in their diary — and the date the
       heads-up email must carry — is the Central one. Reading it in a fixed zone
       puts a whole evening of stops on tomorrow's sheet. */
    const it = R.routeItinerary({ stops:[{state:'KY',lng:-85.93}], legs:[],
      startDate:'2026-09-16', startMinutes:23*60+30 });
    eq(it[0].tz, R.TZ_C, 'central stop');
    eq(it[0].dateISO, '2026-09-16', 'still the 16th where the dealer is');
    eq(R.isoDateIn(it[0].arriveAbs, R.TZ_E), '2026-09-17', 'but the 17th in Eastern');
  });

  t('an unknown state falls back to longitude rather than assuming Eastern', () => {
    eq(R.tzForStop('', -90), R.TZ_C, 'clearly central');
    eq(R.tzForStop('', -80), R.TZ_E, 'clearly eastern');
    eq(R.tzForStop('', null), R.TZ_E, 'nothing to go on');
  });

  /* ---- the driving legs --------------------------------------------------- */
  t('a leading home-base leg is consumed before the first stop', () => {
    const stops = [{ state:'OH', lng:-84, visit_min:0 }, { state:'OH', lng:-84, visit_min:0 }];
    const withHome = R.routeItinerary({ stops, legs:[leg(60),leg(30)], leadingLeg:true,
      startDate:'2026-09-16', startMinutes:8*60 });
    const without = R.routeItinerary({ stops, legs:[leg(30)],
      startDate:'2026-09-16', startMinutes:8*60 });
    eq(hhmm(withHome[0]), '9:00 AM', 'an hour from home first');
    eq(hhmm(without[0]),  '8:00 AM', 'straight to the first stop');
    eq(hhmm(withHome[1]), '9:30 AM', 'then the same hop');
  });

  t('visit time pushes the next arrival, and a missing visit uses the default', () => {
    const it = R.routeItinerary({ stops:[{state:'OH',lng:-84,visit_min:90},{state:'OH',lng:-84}],
      legs:[leg(30)], startDate:'2026-09-16', startMinutes:8*60, defaultVisit:45 });
    eq(hhmm(it[1]), '10:00 AM', '8:00 + 90 visit + 30 drive');
    eq(it[1].visit_min, 45, 'default applied to the stop with none');
  });

  /* ---- refusing to invent ------------------------------------------------- */
  t('no driving data means no times at all, rather than made-up ones', () => {
    /* A route with missing legs used to silently produce a plausible-looking
       schedule. Every one of those numbers reaches a dealer. */
    eq(R.routeItinerary({ stops:[{state:'OH',lng:-84},{state:'OH',lng:-84}], legs:[],
      startDate:'2026-09-16', startMinutes:480 }), [], 'too few legs');
    eq(R.routeItinerary({ stops:[{state:'OH',lng:-84},{state:'OH',lng:-84}], legs:[leg(10)],
      leadingLeg:true, startDate:'2026-09-16', startMinutes:480 }), [], 'home leg not counted');
  });

  t('a missing or malformed start date yields nothing', () => {
    const s = [{ state:'OH', lng:-84 }];
    eq(R.routeItinerary({ stops:s, legs:[], startDate:'' }), [], 'blank');
    eq(R.routeItinerary({ stops:s, legs:[], startDate:'16/09/2026' }), [], 'wrong format');
    eq(R.routeItinerary({ stops:[], legs:[], startDate:'2026-09-16' }), [], 'no stops');
  });

  t('dayCount is honest about an empty itinerary', () => {
    eq(R.dayCount([]), 0, 'empty');
    eq(R.dayCount(null), 0, 'null');
  });

  /* ---- helpers the pages rely on ------------------------------------------ */
  t('a time string parses, and anything else takes the fallback', () => {
    eq(R.parseTimeMin('08:00'), 480, '08:00');
    eq(R.parseTimeMin('7:30'), 450, '7:30');
    eq(R.parseTimeMin('', 480), 480, 'blank');
    eq(R.parseTimeMin('nonsense', 600), 600, 'junk');
  });

  t('the date of an instant is read in the stop\'s zone, not the machine\'s', () => {
    // 00:30 Eastern on the 17th is 23:30 Central on the 16th — the dealer's diary
    // date depends on which of them you ask.
    const ms = Date.UTC(2026, 8, 17, 4, 30);
    eq(R.isoDateIn(ms, R.TZ_E), '2026-09-17', 'eastern');
    eq(R.isoDateIn(ms, R.TZ_C), '2026-09-16', 'central');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, load, SRC };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
