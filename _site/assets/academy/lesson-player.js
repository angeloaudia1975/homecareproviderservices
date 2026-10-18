/* HCPS Academy — the lesson player (A2D Stage 2). ONE renderer for every place a lesson is shown: the staff preview in
   the Command Center now, and the learner player at /academy/ later (A2E). Do not write a second one.

     HCPSLessonPlayer.mount(rootElement, payload, {
       check:      async (questionId, answer) => ({ correct, explanation }),   // grades ONE practice answer on the server
       onProgress: ({ index, kind, status }) => {},                           // learner player: save progress (A2B); preview: omitted
       startAt: <screen index>,                                               // learner player: resume point (A2B); ignored in a preview
       view:       'slides' | 'scroll'                                         // one screen at a time (default) or the whole lesson
     })

   The payload comes from netlify/functions/_academy_lesson.js buildLesson(). Rules this file keeps:
     - TEXT IS TEXT. Every value is placed with textContent / createTextNode. This file never uses innerHTML,
       insertAdjacentHTML, outerHTML, document.write, eval or new Function (test/academy-lesson.test.js checks the source).
     - Links are https only; video frames only youtube-nocookie.com/embed or player.vimeo.com/video, re-checked here.
     - No inline <script> and no style attributes from markup: it runs under the /academy/* Content Security Policy.
     - Practice answers are graded by the server (opts.check). The payload carries no answer key and no explanation.
     - A missing picture, video, document or fact is a LABELLED placeholder; a picture that fails to load becomes one.
     - Keyboard and screen readers: real buttons, tabs with arrow keys, labelled regions, live feedback, visible focus.
     - Layout follows the approved Samples A and B: desktop has the module list beside one ~680px reading column; below
       900px of player width the module list becomes an "All modules" panel and Back / position / Next sit in a bottom bar.
       Width is measured on the player itself (container queries), so the staff preview can show phone and desktop
       widths side by side on one screen. */
(function () {
  'use strict';
  var HTTPS = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{2,5})?(\/[^\s<>"]*)?$/;
  var VIDEO = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{6,20}|player\.vimeo\.com\/video\/[0-9]{3,12})(\?[A-Za-z0-9=&_.-]*)?$/;
  var SAFE_ATTRS = /^(aria-[a-z]+|role|id|type|alt|tabindex|title|hidden|target|rel|loading|decoding|allow|allowfullscreen|referrerpolicy|scope|for|disabled|lang|name|value|data-[a-z-]+|width|height)$/;
  var PASSIVE = { objectives: 1, text: 1, callout: 1, quote: 1, image: 1, fact: 1, comparison: 1, steps: 1, takeaways: 1 };
  var uid = 0;
  var nextId = function (p) { uid += 1; return 'hl-' + p + '-' + uid; };

  /* Builds an element. props: { cls, text, attrs, on, href, src }. Children: nodes or strings (always text). */
  function h(tag, props, children) {
    var el = document.createElement(tag); props = props || {};
    if (props.cls) el.className = props.cls;
    if (props.text != null) el.textContent = String(props.text);
    var a = props.attrs || {};
    Object.keys(a).forEach(function (k) {
      if (a[k] == null || a[k] === false) return;
      if (!SAFE_ATTRS.test(k)) throw new Error('attribute not allowed: ' + k);
      el.setAttribute(k, a[k] === true ? '' : String(a[k]));
    });
    if (props.href != null) { if (!HTTPS.test(String(props.href))) throw new Error('link not allowed'); el.setAttribute('href', props.href); }
    if (props.src != null) el.setAttribute('src', props.src);   // callers check src against HTTPS or VIDEO first
    var on = props.on || {};
    Object.keys(on).forEach(function (k) { el.addEventListener(k, on[k]); });
    (children || []).forEach(function (c) { if (c == null || c === false) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  var safeUrl = function (u) { return typeof u === 'string' && HTTPS.test(u) ? u : null; };

  /* The small text markup lessons use: paragraphs (blank line), "- " bullet lines, "1. " numbered lines, **bold**. */
  function inline(text) {
    var out = [], parts = String(text).split(/\*\*(.+?)\*\*/);
    parts.forEach(function (p, i) { if (!p) return; out.push(i % 2 ? h('strong', { text: p }) : document.createTextNode(p)); });
    return out;
  }
  function body(text) {
    var frag = document.createDocumentFragment();
    String(text || '').split(/\n\s*\n/).forEach(function (para) {
      var lines = para.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      var buf = [], list = null, listTag = null;
      var flush = function () { if (buf.length) { frag.appendChild(h('p', {}, inline(buf.join(' ')))); buf = []; } };
      lines.forEach(function (l) {
        var bullet = /^[-*]\s+(.*)$/.exec(l), num = /^\d+\.\s+(.*)$/.exec(l);
        var tag = bullet ? 'ul' : num ? 'ol' : null;
        if (tag) {
          flush();
          if (!list || listTag !== tag) { list = h(tag, { cls: 'hl-list' }); listTag = tag; frag.appendChild(list); }
          list.appendChild(h('li', {}, inline((bullet || num)[1])));
        } else { list = null; listTag = null; buf.push(l); }
      });
      flush();
    });
    return frag;
  }
  function date(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); if (!m) return '';
    return Number(m[3]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] + ' ' + m[1];
  }
  function sourceLine(label, url, d, prefix) {
    var p = h('p', { cls: 'hl-source' }, [(prefix || 'Source') + ': ']);
    var u = safeUrl(url);
    p.appendChild(u ? h('a', { href: u, text: label, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : document.createTextNode(label));
    if (d) p.appendChild(document.createTextNode(' · verified ' + date(d)));
    return p;
  }
  function placeholder(label, what, alt) {
    return h('div', { cls: 'hl-ph', attrs: { role: 'img', 'aria-label': (what ? what + ': ' : '') + (alt || label) } }, [
      h('span', { cls: 'hl-ph-kind', text: what || 'Placeholder', attrs: { 'aria-hidden': 'true' } }),
      h('span', { cls: 'hl-ph-label', text: label, attrs: { 'aria-hidden': 'true' } }),
      alt ? h('span', { cls: 'hl-ph-alt', text: alt, attrs: { 'aria-hidden': 'true' } }) : null]);
  }
  /* A picture that keeps its shape while loading and turns into a labelled placeholder if it fails. */
  function picture(img, fallbackLabel) {
    if (!img || img.missing || !safeUrl(img.src)) return placeholder(fallbackLabel || 'Picture to be added', 'Picture', img && img.alt);
    var box = h('div', { cls: 'hl-media' });
    var el = h('img', { attrs: { alt: img.decorative ? '' : (img.alt || ''), loading: 'lazy', decoding: 'async', 'aria-hidden': img.decorative ? 'true' : null } });
    el.addEventListener('error', function () { box.replaceWith(placeholder('This picture could not be loaded just now', 'Picture', img.alt)); }, { once: true });
    el.setAttribute('src', img.src);
    box.appendChild(el);
    return box;
  }

  function mount(root, payload, opts) {
    opts = opts || {};
    var P = payload || {}, blocks = Array.isArray(P.blocks) ? P.blocks : [];
    var mfr = (P.course && P.course.manufacturer) || 'the manufacturer';
    var preview = P.mode !== 'learner';
    var state = { screen: 0, view: opts.view === 'scroll' ? 'scroll' : 'slides', passed: {}, done: false };
    var screens = [], announce, fill, bar, pct, posEl, backBtn, nextBtn, completeBtn, completeMsg, panel, modulesBtn, viewBtns = {};

    root.textContent = '';
    root.classList.add('hl');
    var shell = h('div', { cls: 'hl-shell' });
    root.appendChild(shell);

    /* ---------- header ---------- */
    var C = P.course || {}, Mo = P.module || {}, L = P.lesson || {};
    var head = h('header', { cls: 'hl-head' });
    head.appendChild(h('p', { cls: 'hl-crumbs' }, [h('span', { cls: 'hl-course', text: C.title || 'Course' }),
      Mo.position ? ' · Module ' + Mo.position + (Mo.count ? ' of ' + Mo.count : '') + ' · ' + (Mo.title || '') : '']));
    var titleEl = h('h1', { cls: 'hl-title', text: L.title || 'Lesson', attrs: { tabindex: '-1' } });
    head.appendChild(titleEl);
    var meta = h('p', { cls: 'hl-meta' }, [(Mo.position && L.position ? 'Lesson ' + Mo.position + '.' + L.position + ' · ' : '') + (L.est_minutes ? 'about ' + L.est_minutes + ' minutes' : '')]);
    if (preview) meta.appendChild(h('span', { cls: 'hl-badge', text: P.sample ? 'Staff preview · sample lesson · nothing is saved' : 'Staff preview · nothing is saved' }));
    head.appendChild(meta);
    var prog = h('div', { cls: 'hl-progress' });
    bar = h('div', { cls: 'hl-progress-track', attrs: { role: 'progressbar', 'aria-label': 'Lesson progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' } });
    fill = h('span', { cls: 'hl-progress-fill' }); bar.appendChild(fill);
    pct = h('span', { cls: 'hl-progress-label', text: '0%' });
    prog.appendChild(bar); prog.appendChild(pct); head.appendChild(prog);
    var tools = h('div', { cls: 'hl-tools' });
    var panelId = nextId('modules');
    modulesBtn = h('button', { cls: 'hl-btn hl-modules-btn', text: 'All modules', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId }, on: { click: function () { openPanel(); } } });
    tools.appendChild(modulesBtn);
    var vg = h('div', { cls: 'hl-viewtoggle', attrs: { role: 'group', 'aria-label': 'How to show the lesson' } });
    [['slides', 'One screen at a time'], ['scroll', 'Whole lesson']].forEach(function (v) {
      viewBtns[v[0]] = h('button', { cls: 'hl-pill', text: v[1], attrs: { type: 'button', 'aria-pressed': 'false' }, on: { click: function () { setView(v[0]); } } });
      vg.appendChild(viewBtns[v[0]]);
    });
    tools.appendChild(vg); head.appendChild(tools);
    shell.appendChild(head);

    /* ---------- module list (beside the lesson on desktop; a full panel on phones) ---------- */
    function outlineList() {
      var ol = h('ol', { cls: 'hl-outline-list' });
      (P.outline || []).forEach(function (m) {
        var cur = (m.lessons || []).some(function (l) { return l.current; });
        var li = h('li', { cls: cur ? 'hl-outline-current' : '', attrs: { 'aria-current': cur ? 'step' : null } }, [m.position + ' · ' + (m.title || '')]);
        if (cur) (m.lessons || []).forEach(function (l) { li.appendChild(h('span', { cls: 'hl-outline-lesson', text: m.position + '.' + l.position + ' ' + (l.title || '') })); });
        ol.appendChild(li);
      });
      ol.appendChild(h('li', { cls: 'hl-outline-exam', text: 'Final exam (locked until every lesson is complete)' }));
      return ol;
    }
    var bodyEl = h('div', { cls: 'hl-body' });
    var side = h('nav', { cls: 'hl-outline', attrs: { 'aria-label': 'Course modules' } }, [h('p', { cls: 'hl-outline-head', text: 'Modules' }), outlineList()]);
    bodyEl.appendChild(side);
    panel = h('div', { cls: 'hl-panel', attrs: { id: panelId, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'All modules', hidden: true } });
    var closeBtn = h('button', { cls: 'hl-btn', text: 'Close', attrs: { type: 'button' }, on: { click: function () { closePanel(); } } });
    panel.appendChild(h('div', { cls: 'hl-panel-head' }, [h('h2', { text: 'All modules' }), closeBtn]));
    panel.appendChild(outlineList());
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });
    function openPanel() { panel.hidden = false; modulesBtn.setAttribute('aria-expanded', 'true'); closeBtn.focus(); }
    function closePanel() { panel.hidden = true; modulesBtn.setAttribute('aria-expanded', 'false'); modulesBtn.focus(); }
    shell.appendChild(panel);

    var main = h('main', { cls: 'hl-main' });
    bodyEl.appendChild(main);
    shell.appendChild(bodyEl);

    if (preview && P.warnings && P.warnings.length) {
      var det = h('details', { cls: 'hl-warnings' }, [h('summary', { text: P.warnings.length + ' preview warning' + (P.warnings.length === 1 ? '' : 's') + ' (staff only)' })]);
      var wl = h('ul'); P.warnings.forEach(function (w) { wl.appendChild(h('li', { text: 'Screen ' + w.block + ': ' + w.message })); });
      det.appendChild(wl); main.appendChild(det);
    }
    announce = h('p', { cls: 'hl-sr', attrs: { 'aria-live': 'polite' } });
    main.appendChild(announce);
    var stage = h('div', { cls: 'hl-stage' });
    main.appendChild(stage);

    /* ---------- progress ---------- */
    function pass(i, status) {
      if (state.passed[i]) return;
      state.passed[i] = true;
      if (typeof opts.onProgress === 'function') { try { opts.onProgress({ index: i, kind: blocks[i] && blocks[i].kind, status: status || 'passed' }); } catch (e) { /* the player never stops on a save problem */ } }
      update();
    }
    function allPassed() { for (var i = 0; i < blocks.length; i++) if (!state.passed[i]) return false; return blocks.length > 0; }
    function update() {
      var n = 0; for (var i = 0; i < blocks.length; i++) if (state.passed[i]) n++;
      var p = blocks.length ? Math.round(n / blocks.length * 100) : 0;
      fill.style.width = p + '%'; pct.textContent = p + '%'; bar.setAttribute('aria-valuenow', String(p));
      if (state.done) { completeBtn.textContent = 'Lesson complete'; completeBtn.disabled = true; completeBtn.className = 'hl-complete-btn hl-done'; }
      else if (allPassed()) { completeBtn.textContent = 'Mark lesson complete'; completeBtn.disabled = false; completeBtn.className = 'hl-complete-btn hl-ready'; completeMsg.textContent = ''; }
      else {
        completeBtn.textContent = 'Mark lesson complete'; completeBtn.disabled = true; completeBtn.className = 'hl-complete-btn';
        var need = [];
        blocks.forEach(function (b, i) { if (!state.passed[i] && (b.kind === 'scenario' || b.kind === 'check' || b.kind === 'explorer')) need.push(b.kind === 'check' ? 'the knowledge check' : b.kind === 'scenario' ? 'the scenario' : 'an explorer'); });
        completeMsg.textContent = need.length ? 'To complete: try ' + need.filter(function (x, k) { return need.indexOf(x) === k; }).join(', ') + ', and see every screen.' : 'To complete: see every screen.';
      }
    }

    /* ---------- one block ---------- */
    var HEADS = { objectives: 'You will be able to', text: 'Read', callout: 'Note', quote: 'In ' + mfr + '’s words', image: 'Picture', video: 'Watch',
      document: 'Read the document', fact: 'Product fact', comparison: 'Compare', explorer: 'Explore', steps: 'Step by step',
      scenario: 'Customer scenario', check: 'Knowledge check', takeaways: 'Key takeaways' };
    var TONE = { tip: 'Tip', caution: 'Caution', ask_manufacturer: 'Ask ' + mfr };
    function renderBlock(b, i) {
      var sec = h('section', { cls: 'hl-screen hl-k-' + b.kind });
      var heading = (b.kind === 'text' && b.heading) || (b.kind === 'callout' && TONE[b.tone]) || (b.kind === 'fact' && b.label) ||
        ((b.kind === 'comparison' || b.kind === 'explorer' || b.kind === 'steps') && b.title) || (b.kind === 'image' && b.caption) || HEADS[b.kind] || 'Lesson';
      var hid = nextId('h');
      sec.setAttribute('aria-labelledby', hid);
      sec.appendChild(h('p', { cls: 'hl-eyebrow', text: HEADS[b.kind] === heading ? (b.kind === 'check' ? 'Practice only' : '') : HEADS[b.kind] }));
      sec.appendChild(h('h2', { cls: 'hl-h', text: heading, attrs: { id: hid, tabindex: '-1' } }));
      var R = RENDER[b.kind]; if (R) R(sec, b, i); else sec.appendChild(h('p', { text: 'This part of the lesson cannot be shown.' }));
      return sec;
    }
    var RENDER = {
      objectives: function (s, b) { var ul = h('ul', { cls: 'hl-objectives' }); (b.items || []).forEach(function (x) { ul.appendChild(h('li', { text: x })); }); s.appendChild(ul); },
      text: function (s, b) { s.appendChild(h('div', { cls: 'hl-prose' }, [body(b.body)])); },
      callout: function (s, b) { s.appendChild(h('aside', { cls: 'hl-callout hl-tone-' + b.tone, attrs: { role: 'note', 'aria-label': TONE[b.tone] || 'Note' } }, [h('div', { cls: 'hl-prose' }, [body(b.body)])])); },
      quote: function (s, b) {
        var cap = h('figcaption', {}, ['— ' + (b.manufacturer || 'Manufacturer') + ', ']);
        var u = safeUrl(b.source_url);
        cap.appendChild(u ? h('a', { href: u, text: b.source_label, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : document.createTextNode(b.source_label || ''));
        if (b.source_date) cap.appendChild(document.createTextNode(', ' + date(b.source_date)));
        s.appendChild(h('figure', { cls: 'hl-quote' }, [h('blockquote', {}, [h('p', { text: '“' + b.text + '”' })]), cap]));
      },
      image: function (s, b) {
        var fig = h('figure', { cls: 'hl-figure' });
        fig.appendChild(b.image ? picture(b.image) : placeholder(b.placeholder, 'Picture', b.alt));
        if (b.caption) fig.appendChild(h('figcaption', { text: b.caption }));
        s.appendChild(fig);
      },
      video: function (s, b, i) {
        var fig = h('figure', { cls: 'hl-figure' });
        if (b.video && VIDEO.test(b.video.embed)) {
          var box = h('div', { cls: 'hl-media hl-video' });
          var play = h('button', { cls: 'hl-play', attrs: { type: 'button', 'aria-label': 'Play video: ' + (b.video.title || 'video') } }, [
            h('span', { cls: 'hl-play-icon', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Play: ' + (b.video.title || 'video') }),
            h('span', { cls: 'hl-play-note', text: 'Loads only when you tap, to save mobile data.' })]);
          play.addEventListener('click', function () {
            var f = h('iframe', { attrs: { title: b.video.title || 'Video', allow: 'fullscreen; picture-in-picture; encrypted-media', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'lazy' } });
            f.setAttribute('src', b.video.embed);
            box.replaceChildren(f); f.focus(); pass(i, 'opened');
          });
          box.appendChild(play); fig.appendChild(box);
        } else fig.appendChild(placeholder(b.placeholder || 'Video to be added', 'Video'));
        if (b.caption) fig.appendChild(h('figcaption', { text: b.caption }));
        s.appendChild(fig);
      },
      document: function (s, b, i) {
        if (b.document && safeUrl(b.document.href)) {
          var a = h('a', { cls: 'hl-doc', href: b.document.href, attrs: { target: '_blank', rel: 'noopener noreferrer' } }, [
            h('span', { cls: 'hl-doc-title', text: 'Open: ' + (b.title || 'document') }),
            h('span', { cls: 'hl-doc-note', text: b.document.hosted_by === 'hcps' ? 'HCPS copy · opens in a new tab · the link expires after a few minutes' : 'Opens on ' + mfr + '’s site in a new tab' })]);
          a.addEventListener('click', function () { pass(i, 'opened'); });
          s.appendChild(a);
        } else { s.appendChild(h('p', { cls: 'hl-doc-title', text: b.title || '' })); s.appendChild(placeholder(b.placeholder || 'Document to be added', 'Document')); }
      },
      fact: function (s, b) {
        var f = b.fact, card = h('div', { cls: 'hl-fact' + (f && f.status === 'awaiting' ? ' hl-awaiting' : '') + (f ? '' : ' hl-missing') });
        card.appendChild(h('p', { cls: 'hl-fact-model', text: (b.manufacturer ? b.manufacturer + ' ' : '') + b.model_code }));
        if (!f) { card.appendChild(h('p', { cls: 'hl-fact-value', text: 'Not available yet' })); card.appendChild(h('p', { cls: 'hl-source', text: 'This product fact has not been recorded. It is never guessed.' })); }
        else {
          card.appendChild(h('p', { cls: 'hl-fact-value', text: f.text || 'Awaiting confirmation' }));
          if (f.status === 'awaiting') card.appendChild(h('p', { cls: 'hl-flag', text: 'Awaiting ' + (f.manufacturer || mfr) + ' confirmation' + (f.note ? ': ' + f.note : '') }));
          card.appendChild(sourceLine(f.source_label, f.source_url, f.status === 'verified' ? f.verified_on : null));
          if (f.status !== 'verified' && f.verified_on) card.appendChild(h('p', { cls: 'hl-source', text: 'Last checked ' + date(f.verified_on) }));
        }
        s.appendChild(card);
      },
      comparison: function (s, b) {
        var only = false;
        var toggle = h('button', { cls: 'hl-pill', text: 'Show differences only', attrs: { type: 'button', 'aria-pressed': 'false' } });
        var wrap = h('div', { cls: 'hl-table-wrap', attrs: { role: 'region', 'aria-label': (b.title || 'Comparison') + ' (scrolls sideways)', tabindex: '0' } });
        var table = h('table', { cls: 'hl-table' });
        table.appendChild(h('caption', { cls: 'hl-sr', text: (b.title || 'Comparison') + ': ' + (b.models || []).map(function (m) { return m.code; }).join(', ') }));
        var tr = h('tr', {}, [h('th', { text: 'Feature', attrs: { scope: 'col' } })]);
        (b.models || []).forEach(function (m) { tr.appendChild(h('th', { attrs: { scope: 'col' } }, [h('span', { cls: 'hl-code', text: m.code }), m.name ? h('span', { cls: 'hl-mname', text: m.name }) : null])); });
        table.appendChild(h('thead', {}, [tr]));
        var tb = h('tbody'), rows = [];
        (b.rows || []).forEach(function (r) {
          var row = h('tr', {}, [h('th', { text: r.label, attrs: { scope: 'row' } })]);
          r.cells.forEach(function (c) {
            var td = h('td', { cls: c.status === 'awaiting' ? 'hl-awaiting' : c.status === 'missing' ? 'hl-missing' : '' }, [c.text || (c.status === 'missing' ? 'Not available' : 'Awaiting confirmation')]);
            if (c.status === 'awaiting') td.appendChild(h('span', { cls: 'hl-flag', text: 'Awaiting ' + mfr + (c.note ? ': ' + c.note : '') }));
            row.appendChild(td);
          });
          var texts = r.cells.map(function (c) { return c.text; });
          rows.push({ row: row, same: texts.every(function (t) { return t === texts[0]; }) });
          tb.appendChild(row);
        });
        table.appendChild(tb); wrap.appendChild(table);
        toggle.addEventListener('click', function () {
          only = !only; toggle.setAttribute('aria-pressed', String(only)); toggle.textContent = only ? 'Show all rows' : 'Show differences only';
          rows.forEach(function (x) { x.row.hidden = only && x.same; });
        });
        s.appendChild(h('div', { cls: 'hl-row' }, [toggle]));
        s.appendChild(wrap);
        s.appendChild(h('p', { cls: 'hl-source', text: 'Every cell comes from the product-facts layer with its source and date. ' + (b.rows && b.rows.some(function (r) { return r.cells.some(function (c) { return c.status === 'awaiting'; }); }) ? 'Amber marks a detail awaiting ' + mfr + ' confirmation.' : '') }));
      },
      explorer: function (s, b, i) { (b.style === 'hotspots' ? hotspots : b.style === 'cards' ? cards : tabs)(s, b, i); },
      steps: function (s, b) {
        var ol = h('ol', { cls: 'hl-steps' }); (b.items || []).forEach(function (x) { ol.appendChild(h('li', { text: x })); }); s.appendChild(ol);
        if (b.source_label) s.appendChild(h('p', { cls: 'hl-source', text: 'Source: ' + b.source_label }));
        if (b.document && safeUrl(b.document.href)) s.appendChild(h('a', { cls: 'hl-doc', href: b.document.href, text: 'Open the source document', attrs: { target: '_blank', rel: 'noopener noreferrer' } }));
      },
      scenario: function (s, b, i) {
        s.appendChild(h('p', { cls: 'hl-scenario', text: b.prompt }));
        var fb = h('div', { cls: 'hl-feedback', attrs: { role: 'status', 'aria-live': 'polite' } });
        var grp = h('div', { cls: 'hl-choices', attrs: { role: 'group', 'aria-label': 'Your recommendation' } }), btns = [];
        (b.choices || []).forEach(function (c) {
          var btn = h('button', { cls: 'hl-choice', text: c.text, attrs: { type: 'button', 'aria-pressed': 'false' } });
          btn.addEventListener('click', function () {
            btns.forEach(function (x) { x.setAttribute('aria-pressed', 'false'); x.classList.remove('hl-good', 'hl-bad'); });
            btn.setAttribute('aria-pressed', 'true'); btn.classList.add(c.best ? 'hl-good' : 'hl-bad');
            fb.className = 'hl-feedback ' + (c.best ? 'hl-good' : 'hl-bad');
            fb.textContent = (c.best ? 'Good choice. ' : 'Not the best fit. ') + c.feedback;
            pass(i, 'answered');
          });
          btns.push(btn); grp.appendChild(btn);
        });
        s.appendChild(grp); s.appendChild(fb);
        s.appendChild(h('p', { cls: 'hl-source', text: 'Scenarios teach judgement. They are never scored.' }));
      },
      check: function (s, b, i) {
        var qs = b.questions || [];
        if (!qs.length) { s.appendChild(placeholder('No practice questions are available for this check yet', 'Knowledge check')); return; }
        var st = { qi: 0, res: {} };
        var info = h('p', { cls: 'hl-qinfo' }), score = h('p', { cls: 'hl-qscore', attrs: { 'aria-live': 'polite' } });
        var box = h('div', { cls: 'hl-qbox' });
        var fb = h('div', { cls: 'hl-feedback', attrs: { role: 'status', 'aria-live': 'polite' } });
        var prev = h('button', { cls: 'hl-btn', text: 'Previous question', attrs: { type: 'button' } });
        var next = h('button', { cls: 'hl-btn', text: 'Next question', attrs: { type: 'button' } });
        prev.addEventListener('click', function () { if (st.qi > 0) { st.qi--; draw(true); } });
        next.addEventListener('click', function () { if (st.qi < qs.length - 1) { st.qi++; draw(true); } });
        function tally() {
          var a = Object.keys(st.res).length, c = Object.keys(st.res).filter(function (k) { return st.res[k].correct; }).length;
          score.textContent = a ? c + ' of ' + a + ' correct so far · practice answers never count against you' : 'Not started · practice answers never count against you';
          if (a === qs.length) pass(i, 'attempted');
        }
        function send(q, answer, btns) {
          fb.className = 'hl-feedback'; fb.textContent = 'Checking…';
          var go = typeof opts.check === 'function' ? opts.check(q.id, answer) : Promise.reject(new Error('no checker'));
          Promise.resolve(go).then(function (r) {
            if (!r || typeof r.correct !== 'boolean') throw new Error('bad reply');
            st.res[q.id] = { answer: answer, correct: r.correct, explanation: String(r.explanation || '') };
            show(q, btns); tally();
          }).catch(function () { fb.className = 'hl-feedback hl-bad'; fb.textContent = 'The answer could not be checked just now. Try again.'; });
        }
        function show(q, btns) {
          var r = st.res[q.id]; if (!r) { fb.className = 'hl-feedback'; fb.textContent = ''; return; }
          btns.forEach(function (x) {
            var picked = Array.isArray(r.answer) ? r.answer.indexOf(x.dataset.choice) >= 0 : r.answer === x.dataset.choice;
            x.classList.remove('hl-good', 'hl-bad'); if (picked) x.classList.add(r.correct ? 'hl-good' : 'hl-bad');
            if (x.tagName === 'BUTTON') x.setAttribute('aria-pressed', String(picked)); else x.querySelector('input').checked = picked;
          });
          fb.className = 'hl-feedback ' + (r.correct ? 'hl-good' : 'hl-bad');
          fb.textContent = (r.correct ? 'Correct. ' : 'Not quite. ') + r.explanation;
        }
        function draw(focus) {
          var q = qs[st.qi];
          info.textContent = 'Question ' + (st.qi + 1) + ' of ' + qs.length + ' · practice only';
          box.replaceChildren();
          var lid = nextId('q');
          box.appendChild(h('p', { cls: 'hl-qprompt', text: q.prompt, attrs: { id: lid, tabindex: '-1' } }));
          var grp = h('div', { cls: 'hl-choices', attrs: { role: 'group', 'aria-labelledby': lid } }), btns = [];
          if (q.kind === 'multi') {
            q.choices.forEach(function (c) {
              var cid = nextId('c');
              var lab = h('label', { cls: 'hl-choice hl-check', attrs: { for: cid, 'data-choice': c.id } }, [h('input', { attrs: { type: 'checkbox', id: cid, value: c.id } }), ' ' + c.text]);
              btns.push(lab); grp.appendChild(lab);
            });
            var go = h('button', { cls: 'hl-btn hl-primary', text: 'Check answer', attrs: { type: 'button' } });
            go.addEventListener('click', function () {
              var ans = btns.filter(function (l) { return l.querySelector('input').checked; }).map(function (l) { return l.dataset.choice; });
              if (!ans.length) { fb.className = 'hl-feedback'; fb.textContent = 'Choose at least one answer.'; return; }
              send(q, ans, btns);
            });
            box.appendChild(grp); box.appendChild(go);
          } else {
            q.choices.forEach(function (c) {
              var btn = h('button', { cls: 'hl-choice', text: c.text, attrs: { type: 'button', 'aria-pressed': 'false', 'data-choice': c.id } });
              btn.addEventListener('click', function () { send(q, c.id, btns); });
              btns.push(btn); grp.appendChild(btn);
            });
            box.appendChild(grp);
          }
          show(q, btns);
          prev.disabled = st.qi === 0; next.disabled = st.qi === qs.length - 1;
          if (focus) box.firstChild.focus();
        }
        s.appendChild(info); s.appendChild(score); s.appendChild(box); s.appendChild(fb);
        s.appendChild(h('div', { cls: 'hl-row' }, [prev, next]));
        draw(false); tally();
      },
      takeaways: function (s, b) {
        var ul = h('ul', { cls: 'hl-takeaways' }); (b.items || []).forEach(function (x) { ul.appendChild(h('li', { text: x })); }); s.appendChild(ul);
        endMatter(s);
      },
    };
    var endDone = false;
    function endMatter(s) {
      endDone = true;
      if (P.open_items && P.open_items.length) {
        var box = h('div', { cls: 'hl-open' }, [h('h3', { text: 'Awaiting ' + mfr + ' confirmation' })]);
        var ul = h('ul'); P.open_items.forEach(function (x) { ul.appendChild(h('li', { text: x })); }); box.appendChild(ul); s.appendChild(box);
      }
      if (P.sources && P.sources.length) {
        var src = h('div', { cls: 'hl-sources' }, [h('h3', { text: 'Sources used in this lesson' })]);
        var sl = h('ul');
        P.sources.forEach(function (x) {
          var li = h('li'); var u = safeUrl(x.url);
          li.appendChild(u ? h('a', { href: u, text: x.label, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : document.createTextNode(x.label));
          if (x.dates && x.dates.length) li.appendChild(document.createTextNode(' · read ' + x.dates.map(date).join(', ')));
          sl.appendChild(li);
        });
        src.appendChild(sl); s.appendChild(src);
      }
    }

    /* ---------- explorers ---------- */
    function detailPanel() { return h('div', { cls: 'hl-detail', attrs: { 'aria-live': 'polite' } }); }
    function fillDetail(d, it) {
      d.replaceChildren(h('h3', { text: it.title }), h('div', { cls: 'hl-prose' }, [body(it.body)]));
      if (it.image) d.appendChild(picture(it.image));
    }
    function tabs(s, b, i) {
      var list = h('div', { cls: 'hl-tabs', attrs: { role: 'tablist', 'aria-label': b.title || 'Explore' } });
      var panelEl = h('div', { cls: 'hl-tabpanel', attrs: { role: 'tabpanel', tabindex: '0', id: nextId('tp') } });
      var ts = [];
      function select(k, focus, user) {
        ts.forEach(function (t, j) { t.setAttribute('aria-selected', String(j === k)); t.tabIndex = j === k ? 0 : -1; });
        panelEl.setAttribute('aria-labelledby', ts[k].id);
        fillDetail(panelEl, b.items[k]);
        if (focus) ts[k].focus();
        if (user) pass(i, 'explored');
      }
      (b.items || []).forEach(function (it, k) {
        var t = h('button', { cls: 'hl-tab', text: it.title, attrs: { type: 'button', role: 'tab', id: nextId('tab'), 'aria-controls': panelEl.id, 'aria-selected': 'false' } });
        t.addEventListener('click', function () { select(k, false, true); });
        t.addEventListener('keydown', function (e) {
          var n = ts.length, j = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (k + 1) % n; else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (k - 1 + n) % n;
          else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = n - 1;
          if (j != null) { e.preventDefault(); select(j, true, true); }
        });
        ts.push(t); list.appendChild(t);
      });
      s.appendChild(list); s.appendChild(panelEl);
      if (ts.length) select(0, false, false);
    }
    function cards(s, b, i) {
      var grid = h('div', { cls: 'hl-cards' }), d = detailPanel(), btns = [];
      d.id = nextId('cd');
      d.appendChild(h('p', { cls: 'hl-hint', text: 'Choose a card to see more.' }));
      (b.items || []).forEach(function (it) {
        var btn = h('button', { cls: 'hl-card', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': d.id } }, [h('span', { cls: 'hl-card-title', text: it.title })]);
        btn.addEventListener('click', function () {
          btns.forEach(function (x) { x.setAttribute('aria-expanded', 'false'); });
          btn.setAttribute('aria-expanded', 'true'); fillDetail(d, it); pass(i, 'explored');
        });
        btns.push(btn); grid.appendChild(btn);
      });
      s.appendChild(grid); s.appendChild(d);
    }
    function hotspots(s, b, i) {
      var fig = h('div', { cls: 'hl-hotspots' }), d = detailPanel(), btns = [];
      d.appendChild(h('p', { cls: 'hl-hint', text: 'Choose a numbered point to see more.' }));
      var hasPic = b.image && !b.image.missing && safeUrl(b.image.src);
      fig.appendChild(hasPic ? picture(b.image) : placeholder('Picture to be added', 'Picture', b.image && b.image.alt));
      var picker = h('div', { cls: 'hl-picker', attrs: { role: 'group', 'aria-label': (b.title || 'Points') + ': choose a point' } });
      (b.items || []).forEach(function (it, k) {
        var choose = function () { btns.forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); btns.filter(function (x) { return x.dataset.k === String(k); }).forEach(function (x) { x.setAttribute('aria-pressed', 'true'); }); fillDetail(d, it); pass(i, 'explored'); };
        if (hasPic) {
          var dot = h('button', { cls: 'hl-dot', text: String(k + 1), attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': (k + 1) + ': ' + it.title, 'data-k': String(k) } });
          dot.style.left = it.x + '%'; dot.style.top = it.y + '%';
          dot.addEventListener('click', choose); btns.push(dot); fig.appendChild(dot);
        }
        var pb = h('button', { cls: 'hl-pill', text: (k + 1) + ' · ' + it.title, attrs: { type: 'button', 'aria-pressed': 'false', 'data-k': String(k) } });
        pb.addEventListener('click', choose); btns.push(pb); picker.appendChild(pb);
      });
      s.appendChild(picker); s.appendChild(fig); s.appendChild(d);
    }

    /* ---------- screens, navigation, view ---------- */
    blocks.forEach(function (b, i) { var sec = renderBlock(b, i); screens.push(sec); stage.appendChild(sec); });
    if (!endDone && ((P.sources && P.sources.length) || (P.open_items && P.open_items.length))) { var tail = h('section', { cls: 'hl-screen hl-tail' }); endMatter(tail); stage.appendChild(tail); }

    var finish = h('div', { cls: 'hl-finish' });
    completeBtn = h('button', { cls: 'hl-complete-btn', text: 'Mark lesson complete', attrs: { type: 'button', disabled: true } });
    completeMsg = h('p', { cls: 'hl-complete-msg', attrs: { 'aria-live': 'polite' } });
    completeBtn.addEventListener('click', function () {
      if (!allPassed()) return;
      state.done = true; update();
      completeMsg.textContent = preview ? 'Complete. This is a staff preview, so nothing was saved.' : 'Lesson complete.';
      if (!preview && typeof opts.onProgress === 'function') { try { opts.onProgress({ index: null, kind: 'lesson', status: 'completed' }); } catch (e) { /* never stops the player */ } }
    });
    finish.appendChild(completeBtn); finish.appendChild(completeMsg);
    main.appendChild(finish);

    var nav = h('nav', { cls: 'hl-bar', attrs: { 'aria-label': 'Lesson screens' } });
    backBtn = h('button', { cls: 'hl-btn hl-back', text: 'Back', attrs: { type: 'button' } });
    nextBtn = h('button', { cls: 'hl-btn hl-primary hl-next', text: 'Next', attrs: { type: 'button' } });
    posEl = h('span', { cls: 'hl-pos' });
    backBtn.addEventListener('click', function () { go(state.screen - 1, true); });
    nextBtn.addEventListener('click', function () {
      var b = blocks[state.screen];
      if (b && (b.kind === 'video' || b.kind === 'document')) pass(state.screen, 'skipped');   // opened or skipped with Next
      if (state.screen < blocks.length - 1) go(state.screen + 1, true); else completeBtn.focus();
    });
    nav.appendChild(backBtn); nav.appendChild(posEl); nav.appendChild(nextBtn);
    main.appendChild(nav);

    var shownTimer = null, observer = null;
    function seen(i) { var b = blocks[i]; if (b && PASSIVE[b.kind]) pass(i, 'viewed'); else if (b && state.view === 'scroll' && (b.kind === 'video' || b.kind === 'document')) pass(i, 'viewed'); }
    function go(i, focus) {
      if (!blocks.length) return;
      i = Math.max(0, Math.min(blocks.length - 1, i)); state.screen = i;
      if (state.view === 'slides') {
        screens.forEach(function (s, j) { s.hidden = j !== i; });
        var tailEl = stage.querySelector('.hl-tail'); if (tailEl) tailEl.hidden = i !== blocks.length - 1;
        finish.hidden = i !== blocks.length - 1;
        posEl.textContent = (i + 1) + ' of ' + blocks.length;
        backBtn.disabled = i === 0; nextBtn.textContent = i === blocks.length - 1 ? 'Finish' : 'Next';
        announce.textContent = 'Screen ' + (i + 1) + ' of ' + blocks.length;
        clearTimeout(shownTimer); shownTimer = setTimeout(function () { seen(i); }, 700);   // "shown on screen for a moment"
        if (focus) { var hd = screens[i].querySelector('.hl-h'); if (hd) hd.focus(); }
      }
    }
    function setView(v) {
      state.view = v; root.setAttribute('data-view', v);
      Object.keys(viewBtns).forEach(function (k) { viewBtns[k].setAttribute('aria-pressed', String(k === v)); });
      if (observer) { observer.disconnect(); observer = null; }
      if (v === 'scroll') {
        screens.forEach(function (s) { s.hidden = false; }); var t = stage.querySelector('.hl-tail'); if (t) t.hidden = false; finish.hidden = false;
        nav.hidden = true;
        if ('IntersectionObserver' in window) {
          var timers = {};
          observer = new IntersectionObserver(function (es) {
            es.forEach(function (e) {
              var k = screens.indexOf(e.target);
              if (e.isIntersecting) timers[k] = setTimeout(function () { seen(k); }, 700); else clearTimeout(timers[k]);
            });
          }, { threshold: 0.35 });
          screens.forEach(function (s) { observer.observe(s); });
        } else screens.forEach(function (s, k) { seen(k); });
      } else { nav.hidden = false; go(state.screen, false); }
    }

    setView(state.view); update();
    // Learner resume (A2B): screens before the saved resume point were passed in an earlier visit.
    var startAt = !preview && Number.isInteger(opts.startAt) ? Math.min(Math.max(opts.startAt, 0), Math.max(blocks.length - 1, 0)) : 0;
    if (startAt > 0) { for (var r = 0; r < startAt; r++) state.passed[r] = true; update(); if (state.view === 'slides') go(startAt, false); }
    return {
      go: function (i) { go(i, true); },
      view: setView,
      state: function () { var n = 0; for (var i = 0; i < blocks.length; i++) if (state.passed[i]) n++; return { screen: state.screen, view: state.view, passed: n, total: blocks.length, complete: allPassed(), done: state.done }; },
    };
  }

  window.HCPSLessonPlayer = { mount: mount, version: '1' };
})();
