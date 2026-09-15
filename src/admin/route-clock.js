/* WHEN THE REP ACTUALLY ARRIVES — one answer, shared.
 *
 * There were two of these. The route planner (map.html) computed arrival times in
 * the stop's own timezone and ended the day at every stop marked overnight. The
 * field app (scheduled-routes.html) ran one continuous clock in the browser's
 * timezone and had never heard of overnights — so a saved three-day route printed
 * stop 10 at 12:25 AM, stop 12 at 3:22 AM and stop 14 at 7:07 AM, all stamped with
 * day one's date, and the pre-visit emails inherited those times.
 *
 * Both answers came from the same saved route. That is the whole bug: the fact
 * lived in two places and only one of them knew about nights.
 *
 * TWO THINGS THIS GETS RIGHT THAT A NAÏVE CLOCK DOES NOT
 *
 *   Timezones. A Kentucky loop crosses the Central/Eastern line — Glasgow is
 *   Central, Louisville is Eastern — so "08:00" and "arrives at 2:14" are only
 *   meaningful next to a zone. Every time here is an absolute instant; the zone is
 *   carried alongside so each stop can be shown in its own local time.
 *
 *   Nights. An overnight does not add hours to a clock, it ENDS the day: the next
 *   stop starts at next_start_min on the following calendar date, in that stop's
 *   zone. Adding a fixed rest period instead is what produces 3 AM arrivals.
 *
 * Pure and dependency-free, so it runs in both pages and under node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RouteClock = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const TZ_E = "America/New_York", TZ_C = "America/Chicago";
  const TZ_STATE = {
    OH:TZ_E, GA:TZ_E, NC:TZ_E, SC:TZ_E, WV:TZ_E, PA:TZ_E, VA:TZ_E, FL:TZ_E,
    MD:TZ_E, DE:TZ_E, NJ:TZ_E, NY:TZ_E, MI:TZ_E,
    AL:TZ_C, IL:TZ_C, MS:TZ_C, MO:TZ_C, WI:TZ_C, IA:TZ_C, MN:TZ_C, AR:TZ_C,
    LA:TZ_C, TX:TZ_C, KS:TZ_C, OK:TZ_C, NE:TZ_C
  };

  /* The three split states HCPS actually sells into get a longitude test; the rest
     go by state. An unknown state falls back to longitude rather than silently
     defaulting to Eastern, because a home base saved before we captured its state
     would otherwise put the whole day an hour out. */
  function tzForStop(state, lng) {
    const st = String(state || "").toUpperCase().trim();
    if (st === "TN") return (lng != null && lng < -85.4) ? TZ_C : TZ_E;
    if (st === "KY") return (lng != null && lng < -85.9) ? TZ_C : TZ_E;
    if (st === "IN") return (lng != null && lng < -87.3) ? TZ_C : TZ_E;
    if (TZ_STATE[st]) return TZ_STATE[st];
    if (lng != null && isFinite(lng)) return lng < -85.7 ? TZ_C : TZ_E;
    return TZ_E;
  }

  // Minutes east of UTC for tz at instant d (negative in the US).
  function tzOffMin(tz, d) {
    try {
      const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
      let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0;
      return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute) - d.getTime()) / 60000);
    } catch (e) { return -300; }
  }

  // A wall-clock time in a zone -> the absolute instant it names.
  function localToAbs(y, mo, dd, minutes, tz) {
    const guess = new Date(Date.UTC(y, mo, dd, 12, 0, 0));
    const off = tzOffMin(tz, guess);
    return Date.UTC(y, mo, dd, 0, 0, 0) + minutes * 60000 - off * 60000;
  }

  function tzShort(tz, d) {
    try {
      const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
        .formatToParts(d || new Date()).find(x => x.type === "timeZoneName");
      return (s && s.value) || "";
    } catch (e) { return ""; }
  }

  function fmtAbs(ms, tz) {
    const d = new Date(ms);
    const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
    const z = tzShort(tz, d);
    return t + (z ? " " + z : "");
  }

  // The calendar date this instant falls on IN THAT STOP'S ZONE — which is the date
  // the dealer would put in their diary, and the one a heads-up email must carry.
  function isoDateIn(ms, tz) {
    try {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(ms)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
      return p.year + "-" + p.month + "-" + p.day;
    } catch (e) { return ""; }
  }

  function parseISODate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    return { y: +m[1], mo: +m[2] - 1, dd: +m[3] };
  }

  function parseTimeMin(v, fallback) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
    if (!m) return fallback == null ? 8 * 60 : fallback;
    return (+m[1]) * 60 + (+m[2]);
  }

  /* THE CLOCK.
   *   stops        [{lat,lng,state,visit_min,overnight,next_start_min}]
   *   legs         driving legs [{duration_s}] — one per hop
   *   leadingLeg   true when legs[0] is home-base -> first stop (a round trip)
   *   startDate    'YYYY-MM-DD'
   *   startMinutes minutes past midnight, in the FIRST stop's zone
   *   defaultVisit minutes to allow at a stop with no visit_min of its own
   *
   * Returns one item per stop: { arriveAbs, departAbs, tz, dayIndex, dateISO,
   * overnight }. Returns [] rather than guessing when the legs don't cover the
   * hops — a route with no driving data has no honest arrival times, and inventing
   * them is how a dealer gets told 3 AM.
   */
  function routeItinerary(opts) {
    const o = opts || {};
    const stops = Array.isArray(o.stops) ? o.stops : [];
    const legs = Array.isArray(o.legs) ? o.legs : [];
    const lead = o.leadingLeg ? 1 : 0;
    const start = parseISODate(o.startDate);
    if (!stops.length || !start) return [];
    if (legs.length < stops.length - 1 + lead) return [];

    const defVisit = o.defaultVisit == null ? 30 : Number(o.defaultVisit) || 0;
    const firstTz = tzForStop(stops[0].state, stops[0].lng);
    let abs = localToAbs(start.y, start.mo, start.dd,
      (o.startMinutes == null ? 8 * 60 : Number(o.startMinutes) || 0), firstTz);

    let dayIndex = 0;
    const out = [];
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const tz = tzForStop(s.state, s.lng);
      const legIdx = i + lead - 1;
      if (legIdx >= 0) abs += (Number(legs[legIdx] && legs[legIdx].duration_s) || 0) * 1000;

      const arriveAbs = abs;
      const visit = (s.visit_min != null) ? Math.max(0, Number(s.visit_min) || 0) : defVisit;
      const departAbs = arriveAbs + visit * 60000;
      const overnight = !!s.overnight;

      out.push({ arriveAbs, departAbs, tz, dayIndex, overnight,
                 dateISO: isoDateIn(arriveAbs, tz), visit_min: visit });

      abs = departAbs;
      /* The night. Not "add twelve hours" — the day ends here and the next one
         begins at next_start_min on the following calendar date, read in the zone
         of the stop we stopped at. */
      if (overnight) {
        dayIndex++;
        const base = new Date(Date.UTC(start.y, start.mo, start.dd, 12));
        base.setUTCDate(base.getUTCDate() + dayIndex);
        const nextMin = (s.next_start_min != null) ? Number(s.next_start_min) : 8 * 60;
        abs = localToAbs(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), nextMin, tz);
      }
    }
    return out;
  }

  /* How many days a route actually spans, for a header that currently claims one. */
  function dayCount(items) {
    if (!items || !items.length) return 0;
    return items[items.length - 1].dayIndex + 1;
  }

  return { TZ_E, TZ_C, TZ_STATE, tzForStop, tzOffMin, tzShort, localToAbs,
           fmtAbs, isoDateIn, parseISODate, parseTimeMin, routeItinerary, dayCount };
});
