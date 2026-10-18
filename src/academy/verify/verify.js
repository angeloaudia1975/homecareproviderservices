/* HCPS certificate verification page (A2F). No inline script (the /academy/* policy); every server text is placed with
   textContent. A number in the address (#HCPS-ABCD-2345) is checked on load. */
(function () {
  'use strict';
  var form = document.getElementById('vf'), input = document.getElementById('vn'), out = document.getElementById('vr');
  var SHAPE = /^HCPS-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function date(v) { if (!v) return ''; var d = new Date(v); return isNaN(d) ? String(v).slice(0, 10) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' }); }
  function say(text, bad) { var m = el('div', 'ac-msg ' + (bad ? 'err' : 'ok'), text); m.setAttribute('role', bad ? 'alert' : 'status'); out.replaceChildren(m); }
  function norm(v) { var s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (s.indexOf('HCPS') === 0) s = s.slice(4); return s.length === 8 ? 'HCPS-' + s.slice(0, 4) + '-' + s.slice(4) : String(v || '').trim().toUpperCase(); }
  function check(n) {
    if (!SHAPE.test(n)) { say('A certificate number looks like HCPS-ABCD-2345.', true); input.focus(); return; }
    say('Checking…');
    fetch('/.netlify/functions/academy-verify?n=' + encodeURIComponent(n), { credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return { message: 'The check could not be completed. Try again.' }; })
      .then(function (j) {
        if (j.enabled === false) { say(j.message || 'Certificate verification is not open yet.', true); return; }
        if (!j.found) { say(j.message || 'No HCPS certificate has that number.', true); return; }
        var card = el('section', 'ac-card ac-stack'), head = el('div', 'ac-row');
        var pill = el('span', 'ac-pill ' + (j.status === 'valid' ? 'ok' : 'ended'), j.status === 'valid' ? 'Valid' : j.status === 'expired' ? 'Expired' : 'Revoked');
        head.append(el('h2', null, j.cert_number), pill);
        var dl = el('dl', 'ac-cert-facts');
        [['Holder', j.learner_name], ['Dealership', j.dealer_name], ['Certification', j.course_title], ['Issued', date(j.issued_at)],
         [j.status === 'expired' ? 'Expired' : 'Valid until', date(j.expires_at)], j.status === 'revoked' ? ['Revoked', date(j.revoked_at)] : null, ['Issued by', j.issuer]]
          .filter(Boolean).forEach(function (p) { dl.append(el('dt', null, p[0]), el('dd', null, p[1] || '')); });
        card.append(head, dl, el('p', 'ac-small ac-muted', j.disclosure));
        out.replaceChildren(card);
      });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); var n = norm(input.value); input.value = n; check(n); });
  var h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (h) { input.value = norm(h); check(input.value); }
})();
