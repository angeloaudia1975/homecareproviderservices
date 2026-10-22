/* HCPS Academy — Student view (Connect 360, administrators). Walks any course version — draft, in review, published or
   retired — the way a learner sees it: the "My courses" card, every lesson in order in the learner lesson player
   (learner mode), practice checks graded on the server, and a SAMPLE final exam drawn by the real exam's rules and graded
   on the server. Nothing is written anywhere: progress lives in this browser tab only (sessionStorage) and "Start over"
   clears it. Talks only to academy-admin-api with the Connect 360 sign-in. All server text is placed as text. */
(function () {
  'use strict';
  var API = '/.netlify/functions/academy-admin-api';
  var $ = function (s) { return document.querySelector(s); };
  var TOKEN = window.HCPS && HCPS.token();
  window.addEventListener('hcps-token', function (e) { try { TOKEN = e.detail; } catch (_) { /* ignore */ } });
  var q = new URLSearchParams(location.search);
  var VERSION = /^[0-9a-f-]{36}$/i.test(q.get('version') || '') ? q.get('version') : null;
  var WIDTHS = [['desktop', 'Desktop', 1240], ['tablet', 'Tablet', 820], ['phone', 'Phone', 390]];
  var width = WIDTHS.some(function (w) { return w[0] === q.get('width'); }) ? q.get('width') : 'desktop';
  var C = null, PROG = {}, view = $('#view');

  function el(tag, a, kids) {
    var e = document.createElement(tag);
    if (a) Object.keys(a).forEach(function (k) {
      var v = a[k]; if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else if (k === 'cls') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'disabled') e.disabled = !!v; else e.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) { if (c == null || c === false) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function api(body) {
    var h = { 'content-type': 'application/json' }; if (TOKEN) h.authorization = 'Bearer ' + TOKEN;
    return fetch(API, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) {
      if (r.status === 401) { try { HCPS.signOut(); } catch (e) { /* ignore */ } gate('Please sign in again.'); throw new Error('unauthorized'); }
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; });
    }, function () { return { status: 0, body: { message: 'The server could not be reached. Check your connection.' } }; });
  }
  var msg = function (t, bad) { return el('div', { cls: 'ac-msg ' + (bad ? 'err' : 'ok'), role: bad ? 'alert' : 'status', text: t }); };
  function show(nodes) { view.replaceChildren.apply(view, [].concat(nodes)); try { $('#main').focus({ preventScroll: true }); } catch (e) { /* ignore */ } window.scrollTo(0, 0); }
  function notes(list) { $('#sv-notes').replaceChildren.apply($('#sv-notes'), list.filter(Boolean)); }
  function staffNote(title, items) {
    if (!items || !items.length) return null;
    return el('div', { cls: 'sv-note', role: 'note' }, [el('b', { text: title }), el('ul', null, items.map(function (t) { return el('li', { text: t }); }))]);
  }
  var KEY = function () { return 'hcps-student-view:' + VERSION; };
  function loadProg() { try { PROG = JSON.parse(sessionStorage.getItem(KEY()) || '{}') || {}; } catch (e) { PROG = {}; } }
  function saveProg() { try { sessionStorage.setItem(KEY(), JSON.stringify(PROG)); } catch (e) { /* private window: in memory only */ } }
  function lessons() { return [].concat.apply([], (C ? C.modules : []).map(function (m) { return m.lessons.map(function (l) { return { m: m, l: l }; }); })); }

  function setWidth(k) {
    width = k; var w = WIDTHS.filter(function (x) { return x[0] === k; })[0];
    $('#sv-device').style.maxWidth = w[2] + 'px';
    Array.prototype.forEach.call($('#sv-widths').children, function (b, i) { b.setAttribute('aria-pressed', String(WIDTHS[i][0] === k)); });
    try { var u = new URL(location.href); u.searchParams.set('width', k); history.replaceState(null, '', u); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------ manufacturer technical certifications (issue #32)
     The PUBLISHED ones are drawn exactly as the learner page draws them (academy.js mfrPrograms): manufacturer-issued,
     the training / exam open on the manufacturer's own page in a new tab. Drafts and retired ones follow in a separate,
     staff-only block marked NOT VISIBLE TO LEARNERS. HCPS never issues these certificates. */
  var PROGRAMS = [];
  function safeHttps(u) { try { var x = new URL(String(u || '')); return x.protocol === 'https:' && !x.username && !x.password ? x.toString() : null; } catch (e) { return null; } }
  function programRow(p, staffBadge) {
    var open = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Start the training', onclick: function () { programView(p.id, staffBadge); } });
    return el('li', { cls: 'ac-row' }, [el('span', null, [el('b', { text: p.title }),
      staffBadge ? el('span', { cls: 'sv-badge', text: ' ' + staffBadge }) : null]), open]);
  }
  /* the program page exactly as the learner page draws it (shared renderer), in preview mode: nothing is recorded */
  function programView(id, staffBadge) {
    show(el('p', { cls: 'ac-muted', text: 'Loading the program…' }));
    api({ action: 'student_program', course_id: id }).then(function (r) {
      if (r.status !== 200) { show(msg((r.body && r.body.message) || 'The program could not be loaded.', true)); return; }
      var P = r.body.program, warn = [];
      if (!P.visible_to_learners) warn.push((staffBadge || 'NOT VISIBLE TO LEARNERS') + ': learners do not see this program until it is published with a valid link.');
      if (!P.video) warn.push('No official video is set yet: add it in Command Center → Courses → this program → Program page.');
      if (!r.body.tracking_installed) warn.push('Step recording (F2) is not installed yet: learners would see the video and quiz, and their step buttons would answer “not available yet”.');
      warn.push('Preview: the step buttons record nothing here. Certificate uploads are ' + (r.body.uploads_open ? 'ON' : 'OFF (learners are asked to email their certificate)') + '.');
      notes([staffNote('Staff only:', warn)]);
      var box = el('div', { cls: 'ac-program' }); show(box);
      window.HCPSProgram.render(box, P, { preview: true, uploadsOpen: !!r.body.uploads_open, contact: 'info@homecareproviderservices.us',
        back: function () { notes([]); if (C) home(); else catalogHome(); } });
    });
  }
  function programsSection() {
    var shown = PROGRAMS.filter(function (p) { return p.visible_to_learners; });
    var hidden = PROGRAMS.filter(function (p) { return !p.visible_to_learners; });
    var groups = {}; shown.forEach(function (p) { (groups[p.manufacturer] = groups[p.manufacturer] || []).push(p); });
    var out = Object.keys(groups).map(function (m) {
      return el('section', { cls: 'ac-card' }, [el('h2', { text: m + ' technical certifications' }),
        el('p', { cls: 'ac-small ac-muted', text: 'Taught, examined and issued by ' + m + ' — not by HCPS. Watch ' + m + '’s official training video here, then take ' + m + '’s official quiz.' }),
        el('ul', { cls: 'ac-stack' }, groups[m].map(function (p) { return programRow(p); }))]);
    });
    if (hidden.length) out.push(el('section', { cls: 'ac-card sv-hidden', 'aria-label': 'Staff only: programs learners cannot see' }, [
      el('h2', { text: 'Staff only — NOT VISIBLE TO LEARNERS' }),
      el('p', { cls: 'ac-small ac-muted', text: 'Manufacturer programs that are a draft, retired, a TEST, or have no valid https link. Publish one in the Command Center to show it to learners.' }),
      el('ul', { cls: 'ac-stack' }, hidden.map(function (p) { return programRow(p, p.is_test ? 'TEST' : p.status === 'draft' ? 'DRAFT — NOT VISIBLE TO LEARNERS' : p.status === 'retired' ? 'RETIRED — NOT VISIBLE TO LEARNERS' : 'NOT VISIBLE TO LEARNERS'); }))]));
    return out;
  }
  function catalogHome() {
    notes([staffNote('Staff only:', ['This is the learner catalog as of now: the HCPS courses a learner can be enrolled in, and the manufacturer technical certifications every signed-in learner sees. Choose an HCPS course version at the top to walk its lessons and sample exam.'])]);
    show([el('h1', { text: 'Hello, Student' }), el('p', { cls: 'ac-muted', text: 'Your dealership' })].concat(programsSection().length ? programsSection()
      : [el('section', { cls: 'ac-card' }, [el('p', { text: 'No manufacturer technical certifications exist yet.' })])]));
  }

  /* ------------------------------------------------ My courses (one enrolled course, as the learner sees it) */
  function home() {
    var all = lessons(), done = all.filter(function (x) { return PROG[x.l.id] === 'completed'; }).length;
    var next = all.filter(function (x) { return PROG[x.l.id] !== 'completed'; })[0];
    var pct = all.length ? Math.round(100 * done / all.length) : 0;
    var outline = el('ol', { cls: 'ac-outline', hidden: true }, all.map(function (x) {
      var st = PROG[x.l.id] || '';
      return el('li', null, [el('span', { cls: 'ac-dot ' + st, 'aria-hidden': 'true' }),
        el('button', { type: 'button', text: x.m.position + '.' + x.l.position + ' ' + x.l.title, onclick: function () { lesson(x.l.id); } }),
        el('span', { cls: 'ac-muted ac-small', text: st === 'completed' ? 'Done' : st === 'viewed' ? 'Started' : '' })]);
    }));
    var toggle = el('button', { type: 'button', cls: 'ac-btn sec', 'aria-expanded': 'false', text: 'All lessons' });
    toggle.addEventListener('click', function () { var o = outline.hidden; outline.hidden = !o; toggle.setAttribute('aria-expanded', String(o)); });
    var cont = next ? el('button', { type: 'button', cls: 'ac-btn pri', text: done ? 'Continue' : 'Start', onclick: function () { lesson(next.l.id); } })
                    : el('span', { cls: 'ac-pill', text: all.length ? 'All lessons complete' : 'No lessons yet' });
    var V = C.version;
    show([el('h1', { text: 'Hello, Student' }), el('p', { cls: 'ac-muted', text: 'Your dealership' }),
      el('div', { cls: 'ac-courses' }, el('section', { cls: 'ac-card ac-course' }, [el('h2', { text: C.course.title }),
        el('p', { cls: 'ac-muted ac-small', text: 'Version ' + V.version }),
        el('div', { cls: 'ac-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Lessons completed' }, el('span', { style: 'width:' + pct + '%' })),
        el('p', { cls: 'ac-small', text: done + ' of ' + all.length + ' lessons complete' }),
        el('div', { cls: 'ac-row' }, [cont, toggle, el('button', { type: 'button', cls: 'ac-btn sec', text: 'Final exam', onclick: exam })]), outline]))].concat(programsSection()));
  }

  /* ------------------------------------------------ a lesson, in the learner lesson player */
  function lesson(lid) {
    show(el('p', { cls: 'ac-muted', text: 'Loading the lesson…' }));
    api({ action: 'student_lesson', lesson_id: lid, version_id: VERSION }).then(function (r) {
      if (r.status !== 200) { show([msg((r.body && r.body.message) || 'The lesson could not be loaded.', true), el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: home })]); return; }
      var d = r.body, box = el('div'), total = (d.lesson.blocks || []).length, seen = {};
      notes([staffNote('Staff only — preview warnings for this lesson (learners never see these):', d.staff_warnings)]);
      if (PROG[lid] !== 'completed') { PROG[lid] = 'viewed'; saveProg(); }
      var nav = el('div', { cls: 'ac-lessonnav' }, [
        el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: function () { notes([]); home(); } }),
        el('div', { cls: 'ac-row' }, [d.prev_lesson_id ? el('button', { type: 'button', cls: 'ac-btn sec', text: 'Previous lesson', onclick: function () { lesson(d.prev_lesson_id); } }) : null,
          d.next_lesson_id ? el('button', { type: 'button', cls: 'ac-btn pri', text: 'Next lesson', onclick: function () { lesson(d.next_lesson_id); } }) : null])]);
      show([box, nav]);
      window.HCPSLessonPlayer.mount(box, d.lesson, {
        check: function (qid, answer) {
          return api({ action: 'preview_check', lesson_id: lid, question_id: qid, answer: answer }).then(function (x) {
            if (x.status !== 200) throw new Error((x.body && x.body.message) || 'check failed'); return x.body;
          });
        },
        onProgress: function (p) {
          if (p && p.status === 'completed') { PROG[lid] = 'completed'; saveProg(); return; }
          if (p && p.index != null) { seen[p.index] = true; if (Object.keys(seen).length >= total && total) { PROG[lid] = 'completed'; saveProg(); } }
        }
      });
    });
  }

  /* ------------------------------------------------ the final exam: rules page, a sample attempt, the result */
  function exam() {
    notes([]);
    var V = C.version, X = C.exam, all = lessons(), done = all.filter(function (x) { return PROG[x.l.id] === 'completed'; }).length;
    var back = el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: home });
    var rules = el('ul', { cls: 'ac-rules' }, [
      el('li', { text: V.exam_questions + (V.exam_questions === 1 ? ' question' : ' questions') + ' · ' + V.pass_mark + '% to pass' }),
      el('li', { text: (V.time_limit_minutes || 45) + ' minutes once you start; your answers are saved as you go, and the clock keeps running if you lose your connection' }),
      el('li', { text: 'Finish every lesson in the course first' }),
      el('li', { text: 'Wait ' + (V.cooldown_minutes || 60) + ' minutes between attempts · at most ' + (V.daily_limit || 3) + ' attempts a day' }),
      el('li', { text: 'The results show your score and the topics to review — not which answers were right' })]);
    var out = el('div', { 'aria-live': 'polite' }), actions = el('div', { cls: 'ac-row' });
    notes([staffNote('Staff only — about this exam:', [
      'Usable exam questions now: ' + X.usable + (X.held_unverified ? ' (' + X.held_unverified + ' more held back because a product fact they use is not verified)' : '') + '.',
      X.ready ? 'This is a SAMPLE attempt drawn by the same rules as the real exam. It is graded on the server and recorded nowhere; the timer is shown but not enforced.'
              : 'A learner could not start this exam yet: ' + X.problem,
      done < all.length ? 'A learner must finish every lesson first (' + done + ' of ' + all.length + ' done in this view). Staff may take the sample anyway.' : null].filter(Boolean))]);
    if (X.ready) {
      var start = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Start the exam' });
      start.addEventListener('click', function () {
        start.disabled = true; start.textContent = 'Starting…';
        api({ action: 'student_exam_draw', version_id: VERSION }).then(function (x) {
          if (x.status !== 200 || !x.body.ok) { start.disabled = false; start.textContent = 'Start the exam'; out.replaceChildren(msg((x.body && (x.body.problem || x.body.message)) || 'The exam could not be drawn.', true)); return; }
          take(x.body);
        });
      });
      actions.appendChild(start);
    } else out.appendChild(msg('The exam is not ready yet, so a learner would not be able to start it.', true));
    show([el('h1', { text: 'Final exam' }), el('section', { cls: 'ac-card ac-stack' }, [rules, actions, out]), back]);
  }
  function take(D) {
    var Q = D.questions || [], A = {}, i = 0, mins = D.time_limit_minutes || 45, end = Date.now() + mins * 60000, timer = null;
    var clock = el('span', { cls: 'ac-clock', role: 'timer', 'aria-live': 'off' }), body = el('div', { cls: 'ac-card ac-stack ac-exam' });
    var tick = function () { var left = Math.max(0, end - Date.now()), m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
      clock.textContent = m + ':' + (s < 10 ? '0' : '') + s + ' left'; clock.className = 'ac-clock' + (left < 5 * 60000 ? ' low' : ''); };
    var has = function (q) { var a = A[q.id]; return a != null && (!Array.isArray(a) || a.length); };
    var draw = function () {
      var qq = Q[i], multi = qq.kind === 'multi', name = 'q' + i, cur = A[qq.id];
      var opts = (qq.choices || []).map(function (c) {
        var inp = el('input', { type: multi ? 'checkbox' : 'radio', name: name, id: name + c.id, value: c.id });
        inp.checked = multi ? Array.isArray(cur) && cur.indexOf(c.id) >= 0 : cur === c.id;
        inp.addEventListener('change', function () {
          if (!multi) { A[qq.id] = c.id; return; }
          var list = [].slice.call(body.querySelectorAll('input[name="' + name + '"]:checked')).map(function (x) { return x.value; });
          A[qq.id] = list.length ? list : null;
        });
        return el('label', { cls: 'ac-choice', for: inp.id }, [inp, el('span', { text: c.text })]);
      });
      body.replaceChildren(
        el('p', { cls: 'ac-muted ac-small', text: 'Question ' + (i + 1) + ' of ' + Q.length + (multi ? ' · choose every answer that applies' : '') }),
        el('fieldset', { cls: 'ac-q' }, [el('legend', { text: qq.prompt })].concat(opts)),
        el('div', { cls: 'ac-lessonnav' }, [el('button', { type: 'button', cls: 'ac-btn sec', text: 'Previous', disabled: i === 0, onclick: function () { i--; draw(); } }),
          i < Q.length - 1 ? el('button', { type: 'button', cls: 'ac-btn pri', text: 'Next', onclick: function () { i++; draw(); } })
                           : el('button', { type: 'button', cls: 'ac-btn pri', text: 'Review and submit', onclick: review })]));
    };
    var review = function () {
      var n = Q.filter(has).length, yes = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Submit my answers' });
      yes.addEventListener('click', function () { yes.disabled = true; yes.textContent = 'Submitting…'; submit(); });
      body.replaceChildren(el('h2', { text: 'Ready to submit?' }),
        el('p', { text: 'You answered ' + n + ' of ' + Q.length + ' questions.' + (n < Q.length ? ' Unanswered questions count as wrong.' : '') }),
        el('div', { cls: 'ac-jump' }, Q.map(function (qq, k) { return el('button', { type: 'button', cls: 'ac-btn sec' + (has(qq) ? '' : ' warn'), text: String(k + 1), onclick: function () { i = k; draw(); } }); })),
        el('div', { cls: 'ac-row' }, [yes, el('button', { type: 'button', cls: 'ac-btn sec', text: 'Back to the questions', onclick: draw })]));
    };
    var submit = function () {
      api({ action: 'student_exam_grade', version_id: VERSION, question_ids: Q.map(function (x) { return x.id; }), answers: A }).then(function (x) {
        clearInterval(timer);
        if (x.status !== 200) { body.prepend(msg((x.body && x.body.message) || 'The answers could not be graded.', true)); return; }
        result(x.body);
      });
    };
    show([el('div', { cls: 'ac-examhead' }, [el('h1', { text: 'Final exam' }), clock]), body]);
    tick(); timer = setInterval(tick, 1000); draw();
  }
  function result(R) {
    var topics = (R.study_topics || []).map(function (t) { return el('li', { text: String(t).replace(/[-_.]+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }) }); });
    notes([el('div', { cls: 'sv-note', role: 'note' }, [el('b', { text: 'Staff only — answer review (learners only see the score and topics): ' + R.right + ' of ' + R.total + ' correct. Not recorded.' }),
      el('ol', { cls: 'sv-review' }, (R.staff_review || []).map(function (r) {
        return el('li', null, [el('span', { cls: r.correct ? 'ok' : 'no', text: (r.correct ? '✓ ' : r.answered ? '✗ ' : '— not answered · ') }), el('span', { text: r.prompt }),
          r.explanation ? el('div', { cls: 'ac-small', text: 'Why: ' + r.explanation }) : null]);
      }))])]);
    show([el('h1', { text: R.passed ? 'You passed' : 'Not passed this time' }),
      el('section', { cls: 'ac-card ac-stack' }, [el('p', { cls: 'ac-score', text: R.score + '%' }),
        R.passed ? el('p', { text: 'Well done — a learner would now earn the HCPS certificate for ' + C.course.title + ' (not issued in Student view).' }) : el('p', { text: 'Review the topics below, then try again after the break.' }),
        topics.length ? el('div', null, [el('h2', { text: 'Topics to review' }), el('ul', null, topics)]) : null,
        C.disclosure && R.passed ? el('p', { cls: 'ac-muted ac-small', text: C.disclosure }) : null].filter(Boolean)),
      el('div', { cls: 'ac-row' }, [el('button', { type: 'button', cls: 'ac-btn pri', text: 'Back to the exam page', onclick: exam }),
        el('button', { type: 'button', cls: 'ac-btn sec', text: 'My courses', onclick: function () { notes([]); home(); } })])]);
  }

  /* ------------------------------------------------ boot */
  function pickVersion(list) {
    var sel = $('#sv-course'); sel.replaceChildren(el('option', { value: '', text: 'Learner catalog (all courses and certifications)' }));
    list.forEach(function (c) {
      (c.versions || []).forEach(function (v) {
        var o = el('option', { value: v.id, text: (c.is_test ? '[TEST] ' : '') + c.title + ' — v' + v.version + ' (' + String(v.status).replace('_', ' ') + ')' });
        if (v.id === VERSION) o.selected = true; sel.appendChild(o);
      });
    });
    sel.onchange = function () { var u = new URL(location.href); if (sel.value) u.searchParams.set('version', sel.value); else u.searchParams.delete('version'); location.href = u.toString(); };
  }
  function load() {
    loadProg();
    api({ action: 'student_course', version_id: VERSION }).then(function (r) {
      if (r.status !== 200) { show(msg((r.body && r.body.message) || 'This course version could not be loaded.', true)); return; }
      C = r.body;
      var V = C.version, warn = [];
      if (V.status !== 'published') warn.push('This is version ' + V.version + ' with status "' + V.status.replace('_', ' ') + '": learners cannot see it until it is published.');
      if (C.course.is_test) warn.push('TEST course: only TEST-dealership learners can enroll, and it never issues a real certificate.');
      notes([staffNote('Staff only:', warn)]);
      home();
    });
  }
  var booted = false;
  function boot() {
    $('#sv-gate').replaceChildren(); $('#sv-stage').hidden = false;
    if (booted) return; booted = true;
    WIDTHS.forEach(function (w) { $('#sv-widths').appendChild(el('button', { type: 'button', text: w[1], 'aria-pressed': 'false', onclick: function () { setWidth(w[0]); } })); });
    setWidth(width);
    $('#sv-home').addEventListener('click', function () { if (C) { notes([]); home(); } else catalogHome(); });
    $('#sv-reset').addEventListener('click', function () { PROG = {}; saveProg(); if (C) { notes([]); home(); } });
    api({ action: 'whoami' }).then(function (r) {
      var w = r.body || {};
      if (r.status !== 200 || !w.may || !w.may.administer) { show(msg((w && w.message) || 'Student view is limited to the President and HCPS administrators.', true)); return; }
      if (!w.enabled) { show(msg('The Academy Command Center is switched off.', true)); return; }
      api({ action: 'student_catalog' }).then(function (x) {
        var list = (x.body && x.body.courses) || [];
        PROGRAMS = (x.body && x.body.programs) || [];
        pickVersion(list);
        if (!VERSION) { catalogHome(); return; }
        load();
      });
    }).catch(function () { /* handled by api() */ });
  }
  function gate(m) {
    $('#sv-stage').hidden = true;
    var g = $('#sv-gate'), em = el('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' }), pw = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    var er = el('p', { text: m || '' }), btn = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Sign in' });
    var go = function () { er.textContent = 'Signing in…';
      fetch('/.netlify/functions/staff-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login', email: em.value.trim(), password: pw.value }) })
        .then(function (r) { return r.json(); }).then(function (j) { if (!j || !j.ok) { er.textContent = (j && j.message) || 'Could not sign in.'; return; } HCPS.setSession(j); TOKEN = j.token; boot(); })
        .catch(function () { er.textContent = 'Could not reach the server. Try again.'; }); };
    btn.addEventListener('click', go); pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    g.replaceChildren(el('div', { cls: 'sv-gate' }, [el('h2', { text: 'Staff sign-in' }), em, pw, btn, er]));
  }
  if (!TOKEN) gate(); else boot();
})();
