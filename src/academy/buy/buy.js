/* HCPS Academy — buy course access (Phase 2 / M8 sandbox, M9 live). No inline script (the /academy/* policy); every
   server text is placed with textContent. The price shown comes from the server catalog and the server charges its own
   price whatever this page sends. Coming back from Stripe never grants anything: access arrives only through the
   verified Stripe webhook, so the "paid" message tells the buyer to sign in once it is confirmed. */
(function () {
  'use strict';
  var API = '/.netlify/functions/academy-checkout';
  var form = document.getElementById('bf'), sel = document.getElementById('bc'), state = document.getElementById('bstate');
  var mode = document.getElementById('bmode'), go = document.getElementById('bgo');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(box, text, kind) { var m = el('div', 'ac-msg ' + (kind || 'ok'), text); m.setAttribute('role', kind === 'err' ? 'alert' : 'status'); box.replaceChildren(m); }
  function money(c, cur) { return (Number(c) / 100).toLocaleString('en-US', { style: 'currency', currency: String(cur || 'usd').toUpperCase() }); }
  var q = new URLSearchParams(location.search);
  if (q.get('paid') === '1') say(state, 'Thank you — your payment was received by Stripe. Your course is added as soon as Stripe confirms it (usually within a minute). Then sign in to the HCPS Academy with the same email.', 'ok');
  else if (q.get('cancelled') === '1') say(state, 'Payment cancelled. Nothing was charged.', 'err');

  fetch(API + '?action=catalog', { credentials: 'omit' })
    .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return {}; })
    .then(function (j) {
      if (j.test_mode) say(mode, 'TEST MODE — payments use Stripe test cards only. No real card is charged.', 'err');
      if (!j.enabled) { say(q.get('paid') ? mode : state, 'Paid course access is not open yet.', 'err'); return; }
      var list = j.courses || [];
      if (!list.length) { say(state, 'No courses are available for purchase right now.', 'err'); return; }
      list.forEach(function (c) { var o = el('option', null, c.title + ' — ' + money(c.price_cents, c.currency) + (j.tax_added ? ' + applicable sales tax' : '')); o.value = c.slug; sel.append(o); });
      var want = q.get('course'); if (want) sel.value = want;
      form.hidden = false;
    });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { action: 'start', course_slug: sel.value, full_name: document.getElementById('bn').value.trim(),
                 company: document.getElementById('bo').value.trim(), email: document.getElementById('be').value.trim() };
    if (!body.course_slug || body.full_name.length < 2 || body.company.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      say(state, 'Please choose a course and enter your name, company and email.', 'err'); return;
    }
    go.disabled = true; say(state, 'Opening the secure payment page…', 'ok');
    fetch(API, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-academy-request': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return { message: 'The payment page could not be opened. Try again.' }; })
      .then(function (j) {
        if (j && j.ok && /^https:\/\/checkout\.stripe\.com\//.test(j.url || '')) { location.assign(j.url); return; }
        go.disabled = false; say(state, (j && j.message) || 'The payment page could not be opened. Nothing was charged.', 'err');
      });
  });
})();
