/* HCPS Academy — after Stripe's payment page (Phase 2). Access is granted only by Stripe's signed confirmation to HCPS,
   never by this page: it only asks whether that confirmation has arrived (no name, email or amount comes back). */
(function () {
  'use strict';
  var view = document.getElementById('view');
  var s = new URLSearchParams(location.search).get('session') || '';
  function p(t, cls) { var e = document.createElement('p'); if (cls) e.className = cls; e.textContent = t; return e; }
  function link() { var a = document.createElement('a'); a.className = 'ac-btn pri'; a.href = '/academy/'; a.textContent = 'Sign in to the HCPS Academy'; return a; }
  if (!/^cs_(test|live)_[A-Za-z0-9]{8,240}$/.test(s)) { view.replaceChildren(p('If you completed a payment, sign in to the HCPS Academy with the email you used.'), link()); return; }
  history.replaceState(null, '', location.pathname);
  var tries = 0;
  (function ask() {
    fetch('/.netlify/functions/academy-checkout', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-academy-request': '1' }, body: JSON.stringify({ action: 'status', session: s }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return {}; })
      .then(function (j) {
        if (j.state === 'granted') { view.replaceChildren(p('Your payment is confirmed and your course is ready. Sign in with the email you used — we will email you a 6-digit code.'), link()); return; }
        if (j.state === 'review') { view.replaceChildren(p('Your payment was received. HCPS needs to check one detail before your course opens; we will contact you by email shortly.')); return; }
        if (++tries < 10) { setTimeout(ask, 3000); return; }
        view.replaceChildren(p('Your payment is being confirmed. This can take a minute. Sign in with the email you used; your course appears as soon as it is confirmed.'), link());
      });
  })();
})();
