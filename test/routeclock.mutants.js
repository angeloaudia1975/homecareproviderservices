/* Mutation harness for the route clock.

   Every number this produces ends up in front of a dealer — on a printed visit
   package, in a calendar invite, and in a "we'll be there around…" email sent from
   the rep's own Outlook. The failure that prompted it was not a crash: it was a
   plausible-looking schedule that quietly put stops at 12:25 AM and 3:22 AM and
   mailed those times out.

   So the mutants are about being subtly wrong rather than broken: a night that
   does not end the day, a day that starts at the wrong hour, a drive added on the
   wrong side of the night, a timezone dropped.

   Every anchor must occur exactly once. CONTROL is a genuine no-op and must
   SURVIVE; if it dies the harness is failing everything. */
const fs = require('fs');
const suite = require('./routeclock.test');

const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing',
    from: '    let dayIndex = 0;',
    to:   '    let dayIndex = 0; /* control mutant */',
    expect: 'survive' },

  // --- the night that does not end the day
  { name: 'ignore the overnight flag entirely, which is the original bug',
    from: '      const overnight = !!s.overnight;',
    to:   '      const overnight = false;' },

  { name: 'treat every stop as an overnight',
    from: '      const overnight = !!s.overnight;',
    to:   '      const overnight = true;' },

  { name: 'roll the date but not the clock, leaving 3am arrivals on the right day',
    from: '        abs = localToAbs(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), nextMin, tz);',
    to:   '        ;' },

  { name: 'add a fixed rest period instead of starting a new morning',
    from: '        abs = localToAbs(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), nextMin, tz);',
    to:   '        abs = abs + 12 * 3600000;' },

  // --- the wrong morning
  { name: 'resume on the same calendar day',
    from: '        base.setUTCDate(base.getUTCDate() + dayIndex);',
    to:   '        ;' },

  { name: 'always resume on day two, however many nights have passed',
    from: '        base.setUTCDate(base.getUTCDate() + dayIndex);',
    to:   '        base.setUTCDate(base.getUTCDate() + 1);' },

  { name: 'ignore the stop\'s own next-start time',
    from: '        const nextMin = (s.next_start_min != null) ? Number(s.next_start_min) : 8 * 60;',
    to:   '        const nextMin = 8 * 60;' },

  { name: 'stop counting days, so nothing can tell it is a multi-day route',
    from: '        dayIndex++;',
    to:   '        ;' },

  // --- the drive on the wrong side of the night
  { name: 'add the morning drive before the day starts rather than after',
    from: '      if (legIdx >= 0) abs += (Number(legs[legIdx] && legs[legIdx].duration_s) || 0) * 1000;',
    to:   '      if (legIdx >= 0 && !(i > 0 && stops[i-1] && stops[i-1].overnight)) abs += (Number(legs[legIdx] && legs[legIdx].duration_s) || 0) * 1000;' },

  { name: 'drop the leading home-base leg, so every stop reads an hour early',
    from: '    const lead = o.leadingLeg ? 1 : 0;',
    to:   '    const lead = 0;' },

  // --- timezones
  { name: 'put every stop in Eastern',
    from: '      const tz = tzForStop(s.state, s.lng);',
    to:   '      const tz = TZ_E;' },

  { name: 'read the start time in the machine\'s zone instead of the first stop\'s',
    from: '    const firstTz = tzForStop(stops[0].state, stops[0].lng);',
    to:   '    const firstTz = TZ_E;' },

  { name: 'drop the Kentucky longitude split, making Glasgow Eastern',
    from: '    if (st === "KY") return (lng != null && lng < -85.9) ? TZ_C : TZ_E;',
    to:   '    if (st === "KY") return TZ_E;' },

  { name: 'default an unknown state to Eastern instead of reading the longitude',
    from: '    if (lng != null && isFinite(lng)) return lng < -85.7 ? TZ_C : TZ_E;',
    to:   '    ;' },

  { name: 'stamp the date from the machine\'s zone, not the stop\'s',
    from: '                 dateISO: isoDateIn(arriveAbs, tz), visit_min: visit });',
    to:   '                 dateISO: isoDateIn(arriveAbs, TZ_E), visit_min: visit });' },

  // --- inventing a schedule
  { name: 'carry on with too few driving legs and invent the arrivals',
    from: '    if (legs.length < stops.length - 1 + lead) return [];',
    to:   '    ;' },

  { name: 'accept a malformed start date',
    from: '    if (!stops.length || !start) return [];',
    to:   '    if (!stops.length) return [];' },

  // --- visits
  { name: 'ignore the visit length, so the next stop is always too early',
    from: '      const visit = (s.visit_min != null) ? Math.max(0, Number(s.visit_min) || 0) : defVisit;',
    to:   '      const visit = 0;' },
];

let bad = 0;
console.log('mutant                                                          anchors  result');
console.log('-'.repeat(84));

for(const m of MUTANTS){
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(62) + String(hits).padStart(6) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
    bad++; continue;
  }
  const mutated = src.replace(m.from, m.to);
  let r;
  try { r = suite.run(mutated); }
  catch(e){ r = { pass: 0, fail: -1, report: 'threw: ' + e.message }; }

  const survived = r.fail === 0;
  const wantSurvive = m.expect === 'survive';
  const ok = survived === wantSurvive;
  if(!ok) bad++;

  const verdict = survived
    ? (wantSurvive ? 'survived (correct — no-op)' : 'SURVIVED — untested behaviour')
    : (wantSurvive ? 'KILLED — harness is broken' : 'killed by ' + r.fail + ' test(s)');
  console.log(m.name.padEnd(62) + String(hits).padStart(6) + '   ' + verdict);
}

console.log('-'.repeat(84));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
