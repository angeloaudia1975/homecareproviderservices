/* HCPS Academy — FREE course start (Phase 2 / F1, issue #29). No card, no Stripe, no inline script (the /academy/*
   policy); every server text is placed with textContent. Flow: choose a free course + name / company / email →
   academy-free register (the server sends the Academy's own 6-digit sign-in code) → enter the code (academy-api
   verify_code opens the Academy session) → academy-api enroll_free → the Academy. Registration alone grants nothing;
   the enrollment happens only for a signed-in learner. The email is kept in sessionStorage, never in the URL. */
(function () {
  'use strict';
  var FREE = '/.netlify/functions/academy-free', API = '/.netlify/functions/academy-api';
  var sf = document.getElementById('sf'), cf = document.getElementById('cf'), sel = document.getElementById('sc');
  var state = document.getElementById('sstate'), sgo = document.getElementById('sgo'), cgo = document.getElementById('cgo');
  var KEY = 'hcps-academy-start';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(text, kind) { var m = el('div', 'ac-msg ' + (kind || 'ok'), text); m.setAttribute('role', kind === 'err' ? 'alert' : 'status'); state.replaceChildren(m); }
  function clear() { state.replaceChildren(); }
  function save(v) { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) { /* private window */ } }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-academy-request': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; }); },
            function () { return { status: 0, body: { message: 'The HCPS Academy could not be reached. Check your connection and try again.' } }; });
  }
  function showCode(p) {
    sf.hidden = true; cf.hidden = false;
    document.getElementById('csent').textContent = 'If ' + p.email + ' can use the HCPS Academy, a 6-digit code is on its way. It works once, for 10 minutes.';
    document.getElementById('cc').focus();
  }
  function showForm() { cf.hidden = true; sf.hidden = false; }

  var q = new URLSearchParams(location.search);
  fetch(FREE + '?action=catalog', { credentials: 'omit' })
    .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return {}; })
    .then(function (j) {
      var list = (j && j.courses) || [];
      if (!j || !j.enabled) { say('Free sign-up is not open yet.', 'err'); return; }
      if (!list.length) { say('No free courses are open right now.', 'err'); return; }
      list.forEach(function (c) { var o = el('option', null, c.title + ' — Free'); o.value = c.slug; sel.append(o); });
      var want = q.get('course'); if (want) sel.value = want;
      var p = load();
      if (p && p.email && p.slug) { sel.value = p.slug; showCode(p); } else showForm();
    });

  sf.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { action: 'register', course_slug: sel.value, full_name: document.getElementById('sn').value.trim(),
                 company: document.getElementById('so').value.trim(), email: document.getElementById('se').value.trim().toLowerCase() };
    if (!body.course_slug || body.full_name.length < 2 || body.company.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      say('Please choose a course and enter your name, company and email.', 'err'); return;
    }
    sgo.disabled = true; say('Sending your sign-in code…', 'ok');
    post(FREE, body).then(function (r) {
      sgo.disabled = false;
      if (r.status === 200 && r.body.ok) { clear(); var p = { email: body.email, slug: body.course_slug }; save(p); showCode(p); return; }
      say(r.body.message || 'The sign-up could not be completed. Please try again.', 'err');
    });
  });

  cf.addEventListener('submit', function (e) {
    e.preventDefault();
    var p = load(), code = document.getElementById('cc').value.trim();
    if (!p) { showForm(); return; }
    if (!/^\d{6}$/.test(code)) { say('Enter the 6-digit code from the email.', 'err'); return; }
    cgo.disabled = true; say('Signing you in…', 'ok');
    post(API, { action: 'verify_code', email: p.email, code: code }).then(function (r) {
      if (r.status !== 200) { cgo.disabled = false; say(r.body.message || 'That code did not work. Try again.', 'err'); return null; }
      say('Adding your free course…', 'ok');
      return post(API, { action: 'enroll_free', course_slug: p.slug });
    }).then(function (r) {
      if (!r) return;
      if (r.status === 200 && r.body.ok) { save(null); say('You are enrolled. Opening the HCPS Academy…', 'ok'); location.assign('/academy/'); return; }
      cgo.disabled = false; say(r.body.message || 'The course could not be added. Open the HCPS Academy and try again.', 'err');
    });
  });
  document.getElementById('cback').addEventListener('click', function () { save(null); clear(); showForm(); });
})();
