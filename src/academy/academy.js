/* HCPS Academy — learner pages (A2B). One page: sign in (email code, or the Partner 360 handoff), my courses, a lesson
   (the shared lesson player, with progress saved and resumed), and — for a Training Manager — my team.
   Talks only to /.netlify/functions/academy-api with the Academy's own HttpOnly session cookie (never readable here).
   Every text from the server is placed with textContent; no inline script (the /academy/* security policy). */
(function () {
  'use strict';
  var API = '/.netlify/functions/academy-api';
  var view = document.getElementById('view'), nav = document.getElementById('nav');
  var ME = null, ROUTE = null, EXAMS_OPEN = false;

  function el(tag, a, kids) {
    var e = document.createElement(tag);
    if (a) Object.keys(a).forEach(function (k) {
      var v = a[k]; if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else if (k === 'cls') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v; else if (k === 'disabled') e.disabled = !!v;
      else e.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) { if (c == null || c === false) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function msg(text, bad) { return el('div', { cls: 'ac-msg ' + (bad ? 'err' : 'ok'), role: bad ? 'alert' : 'status', text: text }); }
  function show(nodes) { view.replaceChildren.apply(view, [].concat(nodes)); }
  function focusMain() { try { document.getElementById('main').focus({ preventScroll: false }); } catch (e) { /* older browsers */ } }

  function api(body) {
    return fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-academy-request': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; }); },
            function () { return { status: 0, body: { message: 'The Academy could not be reached. Check your connection and try again.' } }; });
  }
  var text = function (r, fallback) { return (r && r.body && r.body.message) || fallback || 'That did not work. Try again.'; };
  function busy(btn, on, label) { btn.disabled = !!on; if (label) btn.textContent = label; }

  /* ------------------------------------------------------------ boot */
  function boot() {
    var m = /^#handoff=([A-Za-z0-9_-]{43})$/.exec(location.hash || '');
    if (m) {
      history.replaceState(null, '', location.pathname);   // the code never stays in the address bar or the history
      show(el('p', { cls: 'ac-muted', text: 'Opening your training…' }));
      api({ action: 'handoff_redeem', code: m[1] }).then(function (r) {
        if (r.status === 200) return loadMe();
        signIn(text(r, 'This Training link has expired. Open Training again from Partner 360.'), true);
      });
      return;
    }
    loadMe();
  }
  function loadMe() {
    return api({ action: 'me' }).then(function (r) {
      if (r.status === 403 && r.body.error === 'flag_off') { nav.hidden = true; show(el('div', { cls: 'ac-card ac-signin' }, [el('h1', { text: 'HCPS Academy' }), el('p', { text: 'The HCPS Academy is not open yet.' })])); return; }
      if (r.status !== 200) { ME = null; signIn(); return; }
      ME = r.body; drawNav(); route();
    });
  }
  function drawNav() {
    nav.hidden = !ME; nav.replaceChildren();
    if (!ME) return;
    nav.appendChild(el('button', { type: 'button', text: 'My courses', onclick: function () { go('courses'); }, 'aria-current': ROUTE === 'courses' ? 'page' : null }));
    if (ME.training_manager) nav.appendChild(el('button', { type: 'button', text: 'My team', onclick: function () { go('team'); }, 'aria-current': ROUTE === 'team' ? 'page' : null }));
    nav.appendChild(el('button', { type: 'button', text: 'Sign out', onclick: signOut }));
  }
  function go(where, params) { location.hash = where + (params ? '?' + new URLSearchParams(params).toString() : ''); }
  function route() {
    var h = (location.hash || '').replace(/^#/, ''); var q = h.indexOf('?'); var name = q < 0 ? h : h.slice(0, q);
    var params = new URLSearchParams(q < 0 ? '' : h.slice(q + 1));
    if (!ME) return;
    if (name === 'lesson' && params.get('e') && params.get('l')) { ROUTE = 'lesson'; drawNav(); return lesson(params.get('e'), params.get('l')); }
    if (name === 'team' && ME.training_manager) { ROUTE = 'team'; drawNav(); return team(); }
    if (name === 'exam' && params.get('e')) { ROUTE = 'exam'; drawNav(); return exam(params.get('e')); }
    if (name === 'take' && params.get('a')) { ROUTE = 'take'; drawNav(); return take(params.get('a'), params.get('e')); }
    ROUTE = 'courses'; drawNav(); courses();
  }
  window.addEventListener('hashchange', function () { if (ME) route(); });
  function signOut() { api({ action: 'sign_out' }).then(function () { ME = null; drawNav(); history.replaceState(null, '', location.pathname); signIn('You are signed out.'); }); }

  /* ------------------------------------------------------------ sign in */
  function signIn(note, bad) {
    nav.hidden = true;
    var email = el('input', { type: 'email', id: 'em', autocomplete: 'email', inputmode: 'email', required: true, maxlength: 254 });
    var out = el('div', { 'aria-live': 'polite' }, note ? msg(note, bad) : null);
    var btn = el('button', { type: 'submit', cls: 'ac-btn pri', text: 'Email me a code' });
    var form = el('form', { cls: 'ac-stack', novalidate: true }, [el('label', { cls: 'ac-field', for: 'em' }, ['Your work email', email]), btn, out]);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var v = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { out.replaceChildren(msg('Enter a valid email address.', true)); email.focus(); return; }
      busy(btn, true, 'Sending…');
      api({ action: 'request_code', email: v }).then(function (r) {
        busy(btn, false, 'Email me a code');
        if (r.status !== 200) { out.replaceChildren(msg(text(r), true)); return; }
        enterCode(v, r.body.message);
      });
    });
    show(el('div', { cls: 'ac-card ac-signin ac-stack' }, [el('h1', { text: 'Sign in to the HCPS Academy' }),
      el('p', { cls: 'ac-muted', text: 'We will email you a 6-digit code. There is no password. Partner 360 users can also open Training from Partner 360.' }), form]));
    email.focus();
  }
  function enterCode(addr, note) {
    var code = el('input', { type: 'text', id: 'cd', cls: 'ac-code', autocomplete: 'one-time-code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, required: true });
    var out = el('div', { 'aria-live': 'polite' }, msg(note || 'Check your email for the code.'));
    var btn = el('button', { type: 'submit', cls: 'ac-btn pri', text: 'Sign in' });
    var form = el('form', { cls: 'ac-stack', novalidate: true }, [el('label', { cls: 'ac-field', for: 'cd' }, ['6-digit code', code]), btn, out,
      el('div', { cls: 'ac-row' }, [el('button', { type: 'button', cls: 'ac-btn sec', text: 'Use a different email', onclick: function () { signIn(); } }),
        el('button', { type: 'button', cls: 'ac-btn sec', text: 'Send a new code', onclick: function () { api({ action: 'request_code', email: addr }).then(function (r) { out.replaceChildren(msg(text(r), r.status !== 200)); }); } })])]);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var v = code.value.replace(/\s/g, '');
      if (!/^\d{6}$/.test(v)) { out.replaceChildren(msg('Enter the 6 digits from the email.', true)); code.focus(); return; }
      busy(btn, true, 'Checking…');
      api({ action: 'verify_code', email: addr, code: v }).then(function (r) {
        busy(btn, false, 'Sign in');
        if (r.status !== 200) { out.replaceChildren(msg(text(r), true)); code.select(); return; }
        history.replaceState(null, '', location.pathname); loadMe();
      });
    });
    show(el('div', { cls: 'ac-card ac-signin ac-stack' }, [el('h1', { text: 'Enter your code' }), el('p', { cls: 'ac-muted', text: 'Sent to ' + addr + '.' }), form]));
    code.focus();
  }

  /* ------------------------------------------------------------ my courses */
  function courses() {
    show(el('p', { cls: 'ac-muted', text: 'Loading your courses…' }));
    api({ action: 'my_courses' }).then(function (r) {
      if (r.status !== 200) { show(msg(text(r), true)); return; }
      var dealers = (ME.memberships || []).map(function (m) { return m.dealer; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      var head = [el('h1', { text: 'Hello, ' + (ME.learner.full_name || 'there') }), el('p', { cls: 'ac-muted', text: dealers.join(' · ') })];
      var list = r.body.courses || [];
      if (!list.length) { show(head.concat(el('div', { cls: 'ac-card' }, [el('h2', { text: 'No courses yet' }), el('p', { text: 'Your Training Manager or HCPS will enroll you in a course. It will appear here.' })]))); focusMain(); return; }
      EXAMS_OPEN = !!r.body.exams_open;
      show(head.concat(el('div', { cls: 'ac-courses' }, list.map(courseCard)))); focusMain();
    });
  }
  function courseCard(c) {
    var pct = c.lessons_total ? Math.round(100 * c.lessons_completed / c.lessons_total) : 0;
    var outline = el('ol', { cls: 'ac-outline', hidden: true }, [].concat.apply([], c.outline.map(function (m) {
      return m.lessons.map(function (l) {
        return el('li', null, [el('span', { cls: 'ac-dot ' + l.status, 'aria-hidden': 'true' }),
          el('button', { type: 'button', text: m.position + '.' + l.position + ' ' + l.title, onclick: function () { go('lesson', { e: c.enrollment_id, l: l.id }); } }),
          el('span', { cls: 'ac-muted ac-small', text: l.status === 'completed' ? 'Done' : l.status === 'viewed' ? 'Started' : '' })]);
      });
    })));
    var toggle = el('button', { type: 'button', cls: 'ac-btn sec', 'aria-expanded': 'false', text: 'All lessons' });
    toggle.addEventListener('click', function () { var o = outline.hidden; outline.hidden = !o; toggle.setAttribute('aria-expanded', String(o)); });
    var cont = c.next_lesson_id ? el('button', { type: 'button', cls: 'ac-btn pri', text: c.lessons_completed ? 'Continue' : 'Start', onclick: function () { go('lesson', { e: c.enrollment_id, l: c.next_lesson_id }); } })
                                : el('span', { cls: 'ac-pill', text: 'All lessons complete' });
    return el('section', { cls: 'ac-card ac-course' }, [el('h2', { text: c.course }),
      el('p', { cls: 'ac-muted ac-small', text: 'Version ' + c.version + (c.due_on ? ' · due ' + c.due_on : '') + (c.version_status === 'retired' ? ' · an older version you started' : '') }),
      el('div', { cls: 'ac-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Lessons completed' }, el('span', { style: 'width:' + pct + '%' })),
      el('p', { cls: 'ac-small', text: c.lessons_completed + ' of ' + c.lessons_total + ' lessons complete' }),
      el('div', { cls: 'ac-row' }, [cont, toggle, EXAMS_OPEN ? el('button', { type: 'button', cls: 'ac-btn sec', text: 'Final exam', onclick: function () { go('exam', { e: c.enrollment_id }); } }) : null]), outline]);
  }

  /* ------------------------------------------------------------ a lesson */
  function lesson(eid, lid) {
    show(el('p', { cls: 'ac-muted', text: 'Loading the lesson…' }));
    api({ action: 'lesson', enrollment_id: eid, lesson_id: lid }).then(function (r) {
      if (r.status !== 200) { show([msg(text(r, 'The lesson could not be loaded.'), true), el('button', { type: 'button', cls: 'ac-btn sec', text: 'Back to my courses', onclick: function () { go('courses'); } })]); return; }
      var d = r.body, box = el('div'), saveNote = el('p', { cls: 'ac-muted ac-small', 'aria-live': 'polite' });
      var furthest = d.progress.resume_block || 0, done = d.progress.status === 'completed', last = Date.now(), timer = null;
      var save = function (status, block) {
        api({ action: 'save_progress', enrollment_id: eid, lesson_id: lid, status: status, resume_block: block }).then(function (x) {
          saveNote.textContent = x.status === 200 ? '' : 'Your progress could not be saved just now. It will be saved the next time it can.';
        });
      };
      var total = (d.lesson.blocks || []).length;
      var nav2 = el('div', { cls: 'ac-lessonnav' }, [
        el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: function () { go('courses'); } }),
        el('div', { cls: 'ac-row' }, [d.prev_lesson_id ? el('button', { type: 'button', cls: 'ac-btn sec', text: 'Previous lesson', onclick: function () { go('lesson', { e: eid, l: d.prev_lesson_id }); } }) : null,
          d.next_lesson_id ? el('button', { type: 'button', cls: 'ac-btn pri', text: 'Next lesson', onclick: function () { go('lesson', { e: eid, l: d.next_lesson_id }); } }) : null])]);
      show([box, saveNote, nav2]);
      window.HCPSLessonPlayer.mount(box, d.lesson, {
        startAt: done ? 0 : furthest,
        check: function (qid, answer) {
          return api({ action: 'practice_check', enrollment_id: eid, lesson_id: lid, question_id: qid, answer: answer }).then(function (x) {
            if (x.status !== 200) throw new Error(text(x)); return x.body;
          });
        },
        onProgress: function (p) {
          if (p.kind === 'lesson' && p.status === 'completed') { done = true; save('completed', Math.max(total - 1, 0)); return; }
          if (typeof p.index !== 'number') return;
          var next = Math.min(p.index + 1, Math.max(total - 1, 0));
          if (next <= furthest || done) return;
          furthest = next;
          // at most one save a second; the last screen reached is always saved (trailing save)
          clearTimeout(timer); var wait = Math.max(0, 1000 - (Date.now() - last));
          timer = setTimeout(function () { last = Date.now(); save('viewed', furthest); }, wait);
        },
      });
      if (!done) save('viewed', furthest);
      focusMain();
    });
  }

  /* ------------------------------------------------------------ the final exam (A2E) */
  var when = function (iso) { try { return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return String(iso); } };
  var topic = function (t) { return String(t).replace(/[-_.]+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }); };
  function exam(eid, note) {
    show(el('p', { cls: 'ac-muted', text: 'Loading the exam…' }));
    api({ action: 'exam_status', enrollment_id: eid }).then(function (r) {
      var back = el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: function () { go('courses'); } });
      if (r.status !== 200) { show([msg(text(r, 'The exam could not be loaded.'), true), back]); return; }
      var S = r.body, P = S.policy || {}, out = el('div', { 'aria-live': 'polite' }, note || null);
      var rules = el('ul', { cls: 'ac-rules' }, [
        el('li', { text: P.questions + (P.questions === 1 ? ' question' : ' questions') + ' · ' + P.pass_mark + '% to pass' }),
        el('li', { text: (P.your_time_limit_minutes || P.time_limit_minutes) + ' minutes once you start' + (P.extra_minutes ? ' (includes ' + P.extra_minutes + ' minutes of extra time)' : '') + '; your answers are saved as you go, and the clock keeps running if you lose your connection' }),
        el('li', { text: 'Finish every lesson in the course first' }),
        el('li', { text: 'Wait ' + P.cooldown_minutes + ' minutes between attempts · at most ' + P.daily_limit + ' attempts a day' }),
        el('li', { text: 'The results show your score and the topics to review — not which answers were right' })]);
      var actions = el('div', { cls: 'ac-row' });
      if (S.reason === 'open_attempt' && String(S.open_enrollment_id) === String(eid)) {
        actions.appendChild(el('button', { type: 'button', cls: 'ac-btn pri', text: 'Continue the exam', onclick: function () { go('take', { a: S.open_attempt_id, e: eid }); } }));
        out.appendChild(msg('You have an exam in progress. It must be finished by ' + when(S.next_at) + '.'));
      } else if (S.can_start && P.version_published) {
        var start = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Start the exam' });
        start.addEventListener('click', function () {
          var yes = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Start now (' + (P.your_time_limit_minutes || P.time_limit_minutes) + ' minutes)' });
          var no = el('button', { type: 'button', cls: 'ac-btn sec', text: 'Not yet', onclick: function () { exam(eid); } });
          yes.addEventListener('click', function () {
            busy(yes, true, 'Starting…');
            api({ action: 'exam_start', enrollment_id: eid }).then(function (x) {
              if (x.status !== 200) { busy(yes, false, 'Start now'); out.replaceChildren(msg(text(x) + (x.body.next_at ? ' (' + when(x.body.next_at) + ')' : ''), true)); return; }
              go('take', { a: x.body.attempt_id, e: eid });
            });
          });
          actions.replaceChildren(el('p', { text: 'The clock starts as soon as you begin. Ready?' }), yes, no); yes.focus();
        });
        actions.appendChild(start);
      } else if (S.reason === 'open_attempt') {
        out.appendChild(msg('You have an exam in progress in another course. Finish it first — it ends by ' + when(S.next_at) + '.'));
      } else if (S.reason === 'lessons_incomplete') {
        out.appendChild(msg('Finish every lesson first: ' + (S.lessons_completed || 0) + ' of ' + (S.lessons_total || 0) + ' lessons completed. Then come back to start the exam.'));
        actions.appendChild(el('button', { type: 'button', cls: 'ac-btn pri', text: 'Back to my courses', onclick: function () { go('courses'); } }));
      } else if (S.reason === 'grading_pending') {
        out.appendChild(msg('Your last attempt is still being graded. Your saved answers are kept. Please contact HCPS if this does not clear.', true));
      } else if (!P.version_published) {
        out.appendChild(msg('This course version is no longer offered, so its exam cannot be started.'));
      } else {
        out.appendChild(msg((S.reason === 'daily_limit' ? 'You have used today’s attempts. ' : 'Take a short break before your next attempt. ') + 'You can start again ' + when(S.next_at) + '.'));
      }
      var hist = (S.attempts || []).filter(function (a) { return !a.open; }).map(function (a) {
        return el('li', null, [el('span', { text: when(a.started_at) }),
          el('span', { cls: 'ac-pill' + (a.passed ? ' ok' : ''), text: a.overdue ? 'Being graded' : (a.passed ? 'Passed' : 'Not passed') }),
          a.score != null ? el('span', { text: a.score + '%' }) : null, a.expired ? el('span', { cls: 'ac-muted ac-small', text: 'time ran out' }) : null]);
      });
      show([el('h1', { text: 'Final exam' }), el('section', { cls: 'ac-card ac-stack' }, [rules, actions, out]),
        hist.length ? el('section', { cls: 'ac-card' }, [el('h2', { text: 'Your attempts' }), el('ol', { cls: 'ac-attempts' }, hist)]) : null, back].filter(Boolean));
      focusMain();
    });
  }
  function take(aid, eid) {
    show(el('p', { cls: 'ac-muted', text: 'Opening your exam…' }));
    api({ action: 'exam_view', attempt_id: aid }).then(function (r) {
      if (r.status !== 200 || !r.body.open) { if (r.status === 200 && eid) return exam(eid); show([msg(text(r, 'This exam is not open.'), true), el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: function () { go('courses'); } })]); return; }
      var D = r.body, Q = D.questions || [], A = Object.assign({}, D.answers || {}), i = 0, ended = false;
      eid = eid || D.enrollment_id;
      var deadline = new Date(D.expires_at).getTime();   // the database enforces it; this clock only shows it
      var clock = el('span', { cls: 'ac-clock', role: 'timer', 'aria-live': 'off' }), saved = el('span', { cls: 'ac-muted ac-small', 'aria-live': 'polite' });
      var body = el('div', { cls: 'ac-card ac-stack ac-exam' }), timer = null, saveT = null, pending = {};
      var flush = function () {
        clearTimeout(saveT); var send = pending; pending = {};
        if (!Object.keys(send).length) return Promise.resolve();
        return api({ action: 'exam_save', attempt_id: aid, answers: send }).then(function (x) {
          if (x.status === 200 && x.body.ok) { saved.textContent = 'Saved'; return; }
          if (x.status === 200 && x.body.reason === 'expired') { finish(); return; }
          pending = Object.assign(send, pending);
          saved.textContent = x.status === 0 ? 'Connection lost — your answer is kept on this screen and will be saved when you are back online. The clock keeps running.' : 'Not saved yet — it will try again.';
          clearTimeout(saveT); if (!ended) saveT = setTimeout(flush, 5000);
        });
      };
      var online = function () { if (!ended && Object.keys(pending).length) { saved.textContent = 'Back online — saving…'; flush(); } };
      var offline = function () { if (!ended) saved.textContent = 'You are offline. Keep going: your answers will be saved when the connection returns. The clock keeps running.'; };
      window.addEventListener('online', online); window.addEventListener('offline', offline);
      var answered = function () { return Q.filter(function (q) { var a = A[q.id]; return a != null && (!Array.isArray(a) || a.length); }).length; };
      var setAnswer = function (q, v) { A[q.id] = v; pending[q.id] = v; saved.textContent = ''; clearTimeout(saveT); saveT = setTimeout(flush, 700); };
      var tick = function () {
        var left = Math.max(0, deadline - Date.now()), m = Math.floor(left / 60000), sec = Math.floor(left % 60000 / 1000);
        clock.textContent = m + ':' + (sec < 10 ? '0' : '') + sec + ' left';
        clock.className = 'ac-clock' + (left < 5 * 60000 ? ' low' : '');
        if (left <= 0) finish();
      };
      var draw = function () {
        var q = Q[i], multi = q.kind === 'multi', name = 'q' + i, cur = A[q.id];
        var opts = q.choices.map(function (c) {
          var on = multi ? Array.isArray(cur) && cur.indexOf(c.id) >= 0 : cur === c.id;
          var inp = el('input', { type: multi ? 'checkbox' : 'radio', name: name, id: name + c.id, value: c.id });
          inp.checked = on;
          inp.addEventListener('change', function () {
            if (!multi) { setAnswer(q, c.id); return; }
            var list = [].slice.call(body.querySelectorAll('input[name="' + name + '"]:checked')).map(function (x) { return x.value; });
            setAnswer(q, list.length ? list : null);
          });
          return el('label', { cls: 'ac-choice', for: inp.id }, [inp, el('span', { text: c.text })]);
        });
        var prev = el('button', { type: 'button', cls: 'ac-btn sec', text: 'Previous', disabled: i === 0, onclick: function () { i--; draw(); } });
        var next = i < Q.length - 1 ? el('button', { type: 'button', cls: 'ac-btn pri', text: 'Next', onclick: function () { i++; draw(); } })
                                    : el('button', { type: 'button', cls: 'ac-btn pri', text: 'Review and submit', onclick: review });
        body.replaceChildren(
          el('p', { cls: 'ac-muted ac-small', text: 'Question ' + (i + 1) + ' of ' + Q.length + (multi ? ' · choose every answer that applies' : '') }),
          el('fieldset', { cls: 'ac-q' }, [el('legend', { text: q.prompt })].concat(opts)),
          el('div', { cls: 'ac-lessonnav' }, [prev, next]));
        var first = body.querySelector('input'); if (first) first.focus({ preventScroll: true });
      };
      var review = function () {
        var n = answered(), missing = Q.length - n;
        var yes = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Submit my answers' });
        yes.addEventListener('click', function () { busy(yes, true, 'Submitting…'); submit(); });
        body.replaceChildren(el('h2', { text: 'Ready to submit?' }),
          el('p', { text: 'You answered ' + n + ' of ' + Q.length + ' questions.' + (missing ? ' Unanswered questions count as wrong.' : '') }),
          el('div', { cls: 'ac-jump' }, Q.map(function (q, k) {
            var a = A[q.id], has = a != null && (!Array.isArray(a) || a.length);
            return el('button', { type: 'button', cls: 'ac-btn sec' + (has ? '' : ' warn'), text: String(k + 1), 'aria-label': 'Question ' + (k + 1) + (has ? '' : ', not answered'), onclick: function () { i = k; draw(); } });
          })),
          el('div', { cls: 'ac-row' }, [yes, el('button', { type: 'button', cls: 'ac-btn sec', text: 'Back to the questions', onclick: function () { draw(); } })]));
        yes.focus();
      };
      var detach = function () { window.removeEventListener('online', online); window.removeEventListener('offline', offline); clearTimeout(saveT); };
      var result = function (R) {
        clearInterval(timer); window.removeEventListener('beforeunload', guard); detach();
        var topics = (R.study_topics || []).map(function (t) { return el('li', { text: topic(t) }); });
        show([el('h1', { text: R.passed ? 'You passed' : 'Not passed this time' }),
          el('section', { cls: 'ac-card ac-stack' }, [el('p', { cls: 'ac-score', text: (R.score != null ? R.score + '%' : '') }),
            R.expired ? msg('Time ran out: the answers saved before the deadline were graded.') : null,
            R.passed ? el('p', { text: 'Well done.' }) : el('p', { text: 'Review the topics below, then try again after the break.' }),
            topics.length ? el('div', null, [el('h2', { text: 'Topics to review' }), el('ul', null, topics)]) : null].filter(Boolean)),
          el('div', { cls: 'ac-row' }, [el('button', { type: 'button', cls: 'ac-btn pri', text: 'Back to the exam page', onclick: function () { go('exam', { e: eid }); } }),
            el('button', { type: 'button', cls: 'ac-btn sec', text: 'My courses', onclick: function () { go('courses'); } })])]);
        focusMain();
      };
      var ungraded = function (why) {   // past the deadline and not graded yet: no score is shown, the answers are kept
        clearInterval(timer); window.removeEventListener('beforeunload', guard); detach();
        show([el('h1', { text: 'Your exam is being graded' }), el('section', { cls: 'ac-card ac-stack' }, [msg(why, true)]),
          el('div', { cls: 'ac-row' }, [el('button', { type: 'button', cls: 'ac-btn pri', text: 'Back to the exam page', onclick: function () { go('exam', { e: eid }); } }),
            el('button', { type: 'button', cls: 'ac-btn sec', text: 'My courses', onclick: function () { go('courses'); } })])]);
        focusMain();
      };
      var submit = function () {
        ended = true; clearTimeout(saveT);
        var send = Object.assign({}, pending); pending = {};
        api({ action: 'exam_submit', attempt_id: aid, answers: send }).then(function (x) {
          if (x.status === 409 && x.body && x.body.error === 'grading_pending') { ungraded(text(x)); return; }
          if (x.status !== 200) { ended = false; pending = Object.assign(send, pending); body.prepend(msg(text(x, 'Your answers could not be submitted. Check your connection and try again.'), true)); return; }
          result(x.body);
        });
      };
      var finish = function () { if (ended) return; submit(); };
      var guard = function (e) { if (!ended) { flush(); e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', guard);
      show([el('div', { cls: 'ac-examhead' }, [el('h1', { text: 'Final exam' }), clock]), saved, body]);
      tick(); timer = setInterval(tick, 1000); draw(); focusMain();
    });
  }

  /* ------------------------------------------------------------ my team (Training Manager) */
  function team(note, noteBad) {
    show(el('p', { cls: 'ac-muted', text: 'Loading your team…' }));
    Promise.all([api({ action: 'team' }), api({ action: 'courses' })]).then(function (rs) {
      var r = rs[0], cr = rs[1];
      if (r.status !== 200) { show(msg(text(r), true)); return; }
      var T = r.body, C = cr.status === 200 ? cr.body.courses : [];
      var out = el('div', { 'aria-live': 'polite' });
      var refresh = function (n, bad) { team(n, bad); };
      var call = function (btn, body, okText) {
        busy(btn, true); api(body).then(function (x) { busy(btn, false); if (x.status !== 200) { out.replaceChildren(msg(text(x), true)); return; } refresh(okText); });
      };
      var dealerSel = function (id) { return el('select', { id: id }, T.dealers.map(function (d) { return el('option', { value: d.id, text: d.name }); })); };
      var askReason = function (holder, label, onOk) {
        var inp = el('input', { type: 'text', maxlength: 500, id: 'rs' + Math.random().toString(36).slice(2) });
        var b = el('button', { type: 'button', cls: 'ac-btn warn', text: 'Confirm' });
        b.addEventListener('click', function () { if (!inp.value.trim()) { inp.focus(); return; } onOk(b, inp.value.trim()); });
        holder.replaceChildren(el('div', { cls: 'ac-inline' }, [el('label', { cls: 'ac-field', for: inp.id }, [label, inp]), b])); inp.focus();
      };
      // invite
      var em = el('input', { type: 'email', id: 'iem', autocomplete: 'off', maxlength: 254 }), nm = el('input', { type: 'text', id: 'inm', maxlength: 200 });
      var ds = dealerSel('ids'), ib = el('button', { type: 'submit', cls: 'ac-btn pri', text: 'Send invitation' });
      var inviteForm = el('form', { cls: 'ac-inline', novalidate: true }, [el('label', { cls: 'ac-field', for: 'iem' }, ['Email', em]),
        el('label', { cls: 'ac-field', for: 'inm' }, ['Name (optional)', nm]), el('label', { cls: 'ac-field', for: 'ids' }, ['Dealership', ds]), ib]);
      inviteForm.addEventListener('submit', function (e) {
        e.preventDefault(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim())) { out.replaceChildren(msg('Enter a valid email address.', true)); em.focus(); return; }
        busy(ib, true);
        api({ action: 'invite', email: em.value.trim(), full_name: nm.value.trim(), dealer_id: ds.value }).then(function (x) {
          busy(ib, false); if (x.status !== 200) { out.replaceChildren(msg(text(x), true)); return; }
          refresh(x.body.email_sent ? 'Invitation sent.' : 'Invitation recorded. The email could not be sent yet; ask HCPS.');
        });
      });
      // roster
      var active = T.roster.filter(function (p) { return p.status === 'active'; }), ended = T.roster.filter(function (p) { return p.status !== 'active'; });
      var person = function (p) {
        var holder = el('div');
        var courseLines = p.courses.map(function (c) {
          var ex = c.exam && c.exam.attempts ? (c.exam.passed ? ' · exam passed' : ' · exam not passed yet (' + c.exam.attempts + (c.exam.attempts === 1 ? ' attempt)' : ' attempts)')) : '';
        return el('div', { cls: 'ac-row ac-small' }, [el('span', { text: c.course + ' v' + c.version + ' — ' + c.lessons_completed + '/' + c.lessons_total + ' lessons' + ex + (c.status === 'withdrawn' ? ' (withdrawn)' : '') + (c.due_on ? ' · due ' + c.due_on : '') }),
            c.status !== 'withdrawn' && c.status !== 'completed' ? el('button', { type: 'button', cls: 'ac-btn sec', text: 'Withdraw', onclick: function () { askReason(holder, 'Why withdraw this course?', function (b, why) { call(b, { action: 'withdraw', enrollment_id: c.enrollment_id, reason: why }, 'Course withdrawn.'); }); } }) : null]);
        });
        var actions = [];
        if (p.status === 'active' && C.length) {
          actions.push(el('button', { type: 'button', cls: 'ac-btn sec', text: 'Enroll in a course', onclick: function () {
            var s = el('select', { id: 'cs' + p.membership_id }, C.map(function (c) { return el('option', { value: c.version_id, text: c.title + ' (v' + c.version + ')' + (c.test ? ' · TEST' : '') }); }));
            var due = el('input', { type: 'date', id: 'du' + p.membership_id });
            var b = el('button', { type: 'button', cls: 'ac-btn pri', text: 'Enroll' });
            b.addEventListener('click', function () { call(b, { action: 'enroll', learner_id: p.learner_id, version_id: s.value, due_on: due.value || null }, 'Enrolled.'); });
            holder.replaceChildren(el('div', { cls: 'ac-inline' }, [el('label', { cls: 'ac-field', for: s.id }, ['Course', s]), el('label', { cls: 'ac-field', for: due.id }, ['Due (optional)', due]), b]));
          } }));
        }
        if (p.status === 'active' && p.role !== 'training_manager' && !p.you) actions.push(el('button', { type: 'button', cls: 'ac-btn warn', text: 'End access', onclick: function () { askReason(holder, 'Why end ' + (p.name || p.email) + '’s access?', function (b, why) { call(b, { action: 'deactivate', membership_id: p.membership_id, reason: why }, 'Access ended.'); }); } }));
        if (p.status !== 'active' && !T.roster.some(function (q) { return q.learner_id === p.learner_id && q.dealer_id === p.dealer_id && q.status === 'active'; }))
          actions.push(el('button', { type: 'button', cls: 'ac-btn sec', text: 'Give access again', onclick: function (e) { call(e.currentTarget, { action: 'reactivate', learner_id: p.learner_id, dealer_id: p.dealer_id }, 'Access restored.'); } }));
        return el('div', { cls: 'ac-person' }, [el('div', { cls: 'ac-row' }, [el('b', { text: p.name || p.email }), p.role === 'training_manager' ? el('span', { cls: 'ac-pill tm', text: 'Training Manager' }) : null,
            p.status !== 'active' ? el('span', { cls: 'ac-pill ended', text: 'Access ended' }) : null, el('span', { cls: 'ac-muted ac-small', text: p.email + ' · ' + p.dealer })]),
          el('div', { cls: 'ac-stack', style: 'gap:6px' }, courseLines.length ? courseLines : [el('span', { cls: 'ac-muted ac-small', text: 'No courses yet.' })]),
          actions.length ? el('div', { cls: 'ac-row' }, actions) : null, holder]);
      };
      var invites = T.invites.map(function (i) {
        var holder = el('div');
        return el('div', { cls: 'ac-person' }, [el('div', { cls: 'ac-row' }, [el('b', { text: i.full_name || i.email }), el('span', { cls: 'ac-muted ac-small', text: i.email + ' · ' + i.dealer + ' · invited, waiting for them to sign in (until ' + String(i.expires_at).slice(0, 10) + ')' }),
          el('button', { type: 'button', cls: 'ac-btn warn', text: 'Cancel invitation', onclick: function () { askReason(holder, 'Why cancel?', function (b, why) { call(b, { action: 'revoke_invite', id: i.id, reason: why }, 'Invitation cancelled.'); }); } })]), holder]);
      });
      show([el('h1', { text: 'My team' }), el('p', { cls: 'ac-muted', text: T.dealers.map(function (d) { return d.name; }).join(' · ') }), el('div', { id: 'teamnote' }, note ? msg(note, noteBad) : null), out,
        el('section', { cls: 'ac-card', 'aria-labelledby': 'h-inv' }, [el('h2', { id: 'h-inv', text: 'Invite an employee' }), el('p', { cls: 'ac-muted ac-small', text: 'They sign in with this email address; no password and no ordering or pricing access.' }), inviteForm]),
        el('section', { cls: 'ac-card', 'aria-labelledby': 'h-team' }, [el('h2', { id: 'h-team', text: 'People (' + active.length + ')' })].concat(active.length ? active.map(person) : [el('p', { cls: 'ac-muted', text: 'Nobody yet.' })])),
        invites.length ? el('section', { cls: 'ac-card', 'aria-labelledby': 'h-pend' }, [el('h2', { id: 'h-pend', text: 'Waiting invitations (' + invites.length + ')' })].concat(invites)) : null,
        ended.length ? el('section', { cls: 'ac-card', 'aria-labelledby': 'h-end' }, [el('h2', { id: 'h-end', text: 'Access ended (' + ended.length + ')' })].concat(ended.map(person))) : null].filter(Boolean));
      focusMain();
    });
  }

  boot();
})();
