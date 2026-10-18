/* HCPS Academy — learner pages (A2B). One page: sign in (email code, or the Partner 360 handoff), my courses, a lesson
   (the shared lesson player, with progress saved and resumed), and — for a Training Manager — my team.
   Talks only to /.netlify/functions/academy-api with the Academy's own HttpOnly session cookie (never readable here).
   Every text from the server is placed with textContent; no inline script (the /academy/* security policy). */
(function () {
  'use strict';
  var API = '/.netlify/functions/academy-api';
  var view = document.getElementById('view'), nav = document.getElementById('nav');
  var ME = null, ROUTE = null;

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
      el('div', { cls: 'ac-row' }, [cont, toggle]), outline]);
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
          return el('div', { cls: 'ac-row ac-small' }, [el('span', { text: c.course + ' v' + c.version + ' — ' + c.lessons_completed + '/' + c.lessons_total + ' lessons' + (c.status === 'withdrawn' ? ' (withdrawn)' : '') + (c.due_on ? ' · due ' + c.due_on : '') }),
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
