/* HCPS Academy — manufacturer technical-certification program page (issue #32). ONE renderer for the learner page
   (/academy/) and the staff Student view (/admin/academy-student.html), like the lesson player.
     HCPSProgram.render(root, program, {
       preview:     true on the staff Student view (nothing is recorded; the step buttons say so),
       uploadsOpen: whether certificate uploads are switched on,
       contact:     the HCPS email shown when uploads are off,
       step:        (step) => Promise<{ ok, label, message }>      'watched' | 'quiz_submitted'
       upload:      (file) => Promise<{ ok, label, message }>
       back:        () => void
     })
   Rules: text is text (textContent only); the video is the privacy-enhanced YouTube embed (youtube-nocookie.com, no
   autoplay) with a "Watch on YouTube" fallback; the quiz is the manufacturer's own page opened in a new tab
   (rel="noopener noreferrer"); HCPS never shows, copies or grades the manufacturer's questions and never issues its
   certificate; a learner's report is labelled as a report, never as a result. Nothing is inferred from the video
   loading or a link being clicked. */
(function () {
  'use strict';
  var EMBED = /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{6,20}$/;
  function safe(u) { try { var x = new URL(String(u || '')); return x.protocol === 'https:' && !x.username && !x.password ? x.toString() : null; } catch (e) { return null; } }
  function el(tag, a, kids) {
    var e = document.createElement(tag);
    if (a) Object.keys(a).forEach(function (k) {
      var v = a[k]; if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else if (k === 'cls') e.className = v;
      else if (k === 'disabled') e.disabled = !!v; else e.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) { if (c == null || c === false) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var ORDER = { training_started: 0, training_completed: 1, exam_opened: 1, exam_reported: 2, awaiting_certificate: 2, certificate_uploaded: 3, verified: 4, rejected: 2 };
  function render(root, P, opts) {
    opts = opts || {};
    var m = P.manufacturer || 'The manufacturer', ms = /s$/i.test(m) ? m + '’' : m + '’s', cred = P.credential || null, level = cred ? (ORDER[cred.status] || 0) : 0;
    var live = el('div', { cls: 'ac-pg-live', 'aria-live': 'polite' });
    var say = function (t, bad) { live.replaceChildren(el('div', { cls: 'ac-msg ' + (bad ? 'err' : 'ok'), role: bad ? 'alert' : 'status', text: t })); };
    var previewNote = function () { say('Staff preview: nothing is recorded here. A learner’s button records this step for them.'); };
    var stepBtn = function (label, step, enabled, doneText) {
      if (doneText) return el('p', { cls: 'ac-pg-done', text: '✓ ' + doneText });
      var b = el('button', { type: 'button', cls: 'ac-btn sec', text: label, disabled: !enabled && !opts.preview });
      b.addEventListener('click', function () {
        if (opts.preview) { previewNote(); return; }
        b.disabled = true;
        Promise.resolve(opts.step && opts.step(step)).then(function (r) {
          if (r && r.ok) { say((r.label || 'Recorded') + '.'); if (opts.reload) opts.reload(); return; }
          b.disabled = false; say((r && r.message) || 'That could not be recorded just now.', true);
        }, function () { b.disabled = false; say('That could not be recorded just now.', true); });
      });
      return b;
    };

    // 1. the official video
    var embed = P.video && EMBED.test(String(P.video.embed || '')) ? P.video.embed : null;
    var watch = P.video && safe(P.video.watch_url);
    var videoBox = embed
      ? el('div', { cls: 'ac-video' }, el('iframe', { src: embed + '?rel=0', title: (P.video.title || P.title) + ' — ' + m + ' video', loading: 'lazy',
          allow: 'encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin' }))
      : el('div', { cls: 'ac-video ac-video-missing', role: 'img', 'aria-label': 'Video not added yet' }, el('span', { text: 'The official ' + m + ' training video has not been added to this program yet.' }));
    var s1 = el('li', { cls: 'ac-pg-step' + (level >= 1 ? ' done' : '') }, [
      el('h2', null, [el('span', { cls: 'ac-pg-n', text: '1' }), ' Watch ' + ms + ' official training video']),
      videoBox,
      el('p', { cls: 'ac-small ac-muted' }, [watch ? el('a', { href: watch, target: '_blank', rel: 'noopener noreferrer', text: 'Watch on YouTube instead ↗' }) : null,
        watch ? ' · ' : null, 'Captions and full-screen are in the player’s controls.']),
      stepBtn('I watched the whole video', 'watched', true, level >= 1 ? 'You reported that you watched the video' + (cred && cred.training_completed_at ? ' (' + new Date(cred.training_completed_at).toLocaleDateString() + ')' : '') + '.' : null)]);

    // 2. the manufacturer's own quiz
    var quiz = safe(P.quiz_url || P.url);
    var s2 = el('li', { cls: 'ac-pg-step' + (level >= 2 ? ' done' : '') }, [
      el('h2', null, [el('span', { cls: 'ac-pg-n', text: '2' }), ' Take ' + ms + ' official quiz']),
      P.quiz_note ? el('p', { text: P.quiz_note }) : el('p', { text: m + ' grades the quiz and emails its certificate to you.' }),
      quiz ? el('a', { cls: 'ac-btn pri ac-pg-quiz', href: quiz, target: '_blank', rel: 'noopener noreferrer', text: 'Take ' + ms + ' official quiz ↗',
        'aria-label': 'Take ' + ms + ' official quiz (opens ' + ms + ' form in a new tab)' }) : el('p', { cls: 'ac-msg err', text: 'The quiz link has not been added yet.' }),
      el('p', { cls: 'ac-small ac-muted', text: 'The quiz opens on ' + ms + ' own form. HCPS does not see your answers or your score.' }),
      stepBtn('I submitted the quiz', 'quiz_submitted', level >= 1, level >= 2 ? 'You reported that you submitted the quiz. Your result comes from ' + m + ' by email.' : null)]);

    // 3. send HCPS the manufacturer's certificate
    var s3kids = [el('h2', null, [el('span', { cls: 'ac-pg-n', text: '3' }), ' Send HCPS your ' + m + ' certificate'])];
    if (level >= 3) s3kids.push(el('p', { cls: 'ac-pg-done', text: '✓ Certificate received. HCPS is checking it.' }));
    else if (opts.uploadsOpen) {
      var file = el('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,image/webp', id: 'ac-pg-file' });
      var up = el('button', { type: 'button', cls: 'ac-btn sec', text: 'Upload certificate', disabled: level < 2 && !opts.preview });
      up.addEventListener('click', function () {
        if (opts.preview) { previewNote(); return; }
        var f = file.files && file.files[0]; if (!f) { say('Choose the certificate file first (PDF or picture, up to 3 MB).', true); return; }
        if (f.size > 3 * 1024 * 1024) { say('The file is larger than 3 MB.', true); return; }
        up.disabled = true;
        Promise.resolve(opts.upload && opts.upload(f)).then(function (r) {
          if (r && r.ok) { say((r.label || 'Received') + '.'); if (opts.reload) opts.reload(); return; }
          up.disabled = false; say((r && r.message) || 'The certificate could not be uploaded.', true);
        }, function () { up.disabled = false; say('The certificate could not be uploaded.', true); });
      });
      s3kids.push(el('p', { text: 'When ' + m + ' emails your certificate, upload it here (PDF or picture, up to 3 MB).' }),
        el('label', { cls: 'ac-field', for: 'ac-pg-file' }, ['Certificate file', file]), up);
    } else s3kids.push(el('p', { text: 'When ' + m + ' emails your certificate, forward it to HCPS' + (opts.contact ? ' at ' + opts.contact : '') + ' so we can record it.' }));
    var s3 = el('li', { cls: 'ac-pg-step' + (level >= 3 ? ' done' : '') }, s3kids);

    // 4. HCPS verification
    var s4 = el('li', { cls: 'ac-pg-step' + (level >= 4 ? ' done' : '') }, [
      el('h2', null, [el('span', { cls: 'ac-pg-n', text: '4' }), ' HCPS records your ' + m + ' credential']),
      level >= 4 ? el('p', { cls: 'ac-pg-done', text: '✓ Verified by HCPS' + (cred.verified_at ? ' on ' + new Date(cred.verified_at).toLocaleDateString() : '') + (cred.certificate_ref ? ' · certificate ' + cred.certificate_ref : '') + '.' })
                 : el('p', { text: 'HCPS checks the certificate ' + m + ' issued and records it on your Academy profile.' })]);

    root.replaceChildren.apply(root, [
      el('p', { cls: 'ac-small' }, el('button', { type: 'button', cls: 'ac-btn sec', text: '← My courses', onclick: null })),
      el('h1', { text: P.title }),
      el('p', { cls: 'ac-pg-issuer', text: 'Issued by ' + m + ' — not by HCPS. ' + m + ' provides the training and the quiz and issues the certificate; HCPS links to them and records your credential.' }),
      P.overview ? el('p', { cls: 'ac-pg-overview', text: P.overview }) : null,
      cred ? el('p', { cls: 'ac-pg-status' }, [el('b', { text: 'Your status: ' }), cred.label || cred.status, cred.note ? el('span', { text: ' — ' + cred.note }) : null]) : null,
      el('ol', { cls: 'ac-pg-steps' }, [s1, s2, s3, s4]),
      live,
      safe(P.manufacturer_page_url) ? el('p', { cls: 'ac-small ac-muted' }, ['About this certification on ' + ms + ' website: ',
        el('a', { href: safe(P.manufacturer_page_url), target: '_blank', rel: 'noopener noreferrer', text: ms + ' certification page ↗' })]) : null].filter(Boolean));  // replaceChildren(null) would print "null"
    var back = root.querySelector('button'); if (back && opts.back) back.addEventListener('click', opts.back);
  }
  window.HCPSProgram = { render: render };
})();
