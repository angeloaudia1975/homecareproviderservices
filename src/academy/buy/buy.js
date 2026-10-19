/* HCPS Academy — course checkout page (Phase 2). Lists the courses on sale (the server's prices) and sends the buyer to
   Stripe's hosted payment page. The price is never sent from here: the server reads it from the database. No inline
   script (the /academy/* policy); every server text is placed with textContent. */
(function () {
  'use strict';
  var API = '/.netlify/functions/academy-checkout';
  var view = document.getElementById('view');
  function el(tag, a, kids) {
    var e = document.createElement(tag);
    Object.keys(a || {}).forEach(function (k) { var v = a[k]; if (v == null || v === false) return; if (k === 'text') e.textContent = v; else if (k === 'cls') e.className = v; else e.setAttribute(k, v === true ? '' : String(v)); });
    [].concat(kids == null ? [] : kids).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function msg(t, bad) { return el('div', { cls: 'ac-msg ' + (bad ? 'err' : 'ok'), role: bad ? 'alert' : 'status', text: t }); }
  function field(id, label, type, extra) { var i = el('input', Object.assign({ id: id, type: type || 'text', required: true }, extra || {})); return { input: i, wrap: el('label', { cls: 'ac-field', for: id }, [label, i]) }; }
  fetch(API + '?action=catalog', { credentials: 'omit' }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.enabled || !j.courses || !j.courses.length) { view.replaceChildren(el('div', { cls: 'ac-card' }, [el('h2', { text: 'Paid course access is coming soon' }), el('p', { text: 'No payment is taken today.' })])); return; }
    var want = new URLSearchParams(location.search).get('course');
    var sel = el('select', { id: 'course', required: true });
    j.courses.forEach(function (c) { var o = el('option', { value: c.slug, text: c.title + ' — ' + c.price }); if (c.slug === want) o.selected = true; sel.appendChild(o); });
    var name = field('name', 'Your name', 'text', { autocomplete: 'name', maxlength: 120 });
    var org = field('org', 'Company name', 'text', { autocomplete: 'organization', maxlength: 160 });
    var email = field('email', 'Work email (you sign in to the Academy with it)', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: 254 });
    var out = el('div', { 'aria-live': 'polite' });
    var btn = el('button', { type: 'submit', cls: 'ac-btn pri', text: 'Continue to secure payment' });
    var form = el('form', { cls: 'ac-card ac-stack', novalidate: true }, [el('label', { cls: 'ac-field', for: 'course' }, ['Course', sel]), name.wrap, org.wrap, email.wrap, btn, out,
      j.mode === 'test' ? el('p', { cls: 'ac-small ac-muted', text: 'TEST MODE — no real card is charged.' }) : null]);
    if (new URLSearchParams(location.search).get('canceled')) out.replaceChildren(msg('Payment was canceled. Nothing was charged.', false));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (name.input.value.trim().length < 2 || org.input.value.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.input.value.trim())) { out.replaceChildren(msg('Fill in your name, company and a valid email.', true)); return; }
      btn.disabled = true; btn.textContent = 'Opening the payment page…';
      fetch(API, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-academy-request': '1' },
        body: JSON.stringify({ action: 'start', course: sel.value, name: name.input.value.trim(), organization: org.input.value.trim(), email: email.input.value.trim() }) })
        .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return { message: 'The payment page could not be reached. Nothing was charged.' }; })
        .then(function (x) {
          if (x && x.url && /^https:\/\/checkout\.stripe\.com\//.test(x.url)) { location.assign(x.url); return; }
          btn.disabled = false; btn.textContent = 'Continue to secure payment';
          out.replaceChildren(msg((x && x.message) || 'This purchase could not be started.', true));
        });
    });
    view.replaceChildren(form);
  }, function () { view.replaceChildren(msg('The course list could not be loaded. Try again shortly.', true)); });
})();
