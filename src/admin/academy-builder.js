/* HCPS Academy — Course Builder (A2D Stage 3). Staff only; talks ONLY to academy-admin-api with the Connect 360 sign-in.
   - Every change is an audited database operation on the server (M2 modules/lessons, M3 screens, order, questions, media,
     fact links). This page never writes anything else and never decides who acted.
   - Text from the server is placed with textContent only (no innerHTML anywhere in this file).
   - The live preview is drawn by /assets/academy/lesson-player.js — the same player learners will use — from the screens
     being edited (saved or not). Nothing in the preview is saved.
   - The question bank is the one staff screen that shows answer keys; lesson previews never carry them.
   - Pictures: any administrator may upload a candidate; only the President approves (or discards) it. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var TOKEN = window.HCPS && HCPS.token();
  window.addEventListener('hcps-token', function (e) { try { TOKEN = e.detail; } catch (_) { /* keep */ } });
  var Q = new URLSearchParams(location.search);
  var VERSION = /^[0-9a-f-]{36}$/i.test(Q.get('version') || '') ? Q.get('version') : null;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ------------------------------------------------------------------ small DOM helpers (text only) */
  function el(tag, a, kids) {
    var e = document.createElement(tag);
    if (a) Object.keys(a).forEach(function (k) {
      var v = a[k]; if (v == null || v === false) return;
      if (k === 'text') e.textContent = v;
      else if (k === 'cls') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k === 'disabled') e.disabled = !!v;
      else e.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  function btn(text, onclick, a) { var b = el('button', Object.assign({ type: 'button', text: text }, a || {})); if (onclick) b.addEventListener('click', onclick); return b; }
  function pill(text, cls) { return el('span', { cls: 'pill' + (cls ? ' ' + cls : ''), text: text }); }
  function note(text, cls) { return el('div', { cls: 'note' + (cls ? ' ' + cls : ''), text: text }); }
  var toastTimer;
  function toast(text, bad) {
    var t = $('#toast'); t.replaceChildren(note(text, bad ? 'err' : 'ok'));
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.replaceChildren(); }, bad ? 9000 : 3500);
  }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  var fkCounter = 0;
  function focusKey(k) { if (!k) return; var e = document.querySelector('[data-fk="' + k + '"]'); if (e) try { e.focus({ preventScroll: false }); } catch (_) { e.focus(); } }

  /* ------------------------------------------------------------------ API */
  function api(body, headers) {
    var h = { 'content-type': 'application/json' }; if (TOKEN) h.authorization = 'Bearer ' + TOKEN;
    Object.assign(h, headers || {});
    return fetch('/.netlify/functions/academy-admin-api', { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) {
      if (r.status === 401) { HCPS.signOut(); location.reload(); throw new Error('unauthorized'); }
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; });
    }, function () { return { status: 0, body: { message: 'The server could not be reached. Check your connection; nothing was changed.' } }; });
  }
  function msgOf(r, fallback) { return (r && r.body && r.body.message) || fallback || 'That did not work. Nothing was changed.'; }

  /* ------------------------------------------------------------------ state */
  var S = {
    d: null, who: null, tab: 'lessons', lessonId: null, blocks: [], base: null, dirty: false, sel: -1, pane: 'edit', width: 'desktop',
    player: null, previewSeq: 0, previewTimer: null, lastPreviewError: null, addOpen: false, confirm: null,
    bank: { use: '', module: '', status: 'active', q: '' }, editQ: null, lib: null, busy: false,
  };
  var TABS = [['lessons', 'Lessons & screens'], ['bank', 'Question bank'], ['dist', 'Exam distribution'], ['media', 'Pictures & media'], ['ready', 'Readiness']];
  var editable = function () { return !!(S.d && S.d.editable); };
  var president = function () { return !!(S.d && S.d.president); };

  /* ------------------------------------------------------------------ block kinds (the 14 approved kinds) */
  var KIND = {
    objectives: { label: 'Objectives', help: '2–4 things the learner will be able to do. Always the first screen.' },
    text: { label: 'Text', help: 'A heading and a short explanation.' },
    callout: { label: 'Tip or caution', help: 'A tip, a caution, or “ask the manufacturer”.' },
    quote: { label: 'Manufacturer quote', help: 'The manufacturer’s own words, with source and date.' },
    image: { label: 'Picture', help: 'An approved picture, or a labelled placeholder until it is approved.' },
    video: { label: 'Video', help: 'An approved YouTube (no-cookie) or Vimeo video.' },
    document: { label: 'Document', help: 'A manual, brochure or sell sheet.' },
    fact: { label: 'Product fact', help: 'One verified specification, shown with its source and date.' },
    comparison: { label: 'Comparison table', help: '2–6 models side by side, every cell a verified fact.' },
    explorer: { label: 'Explorer', help: 'Tabs, cards, or hotspots on a picture.' },
    steps: { label: 'Steps', help: 'A short procedure from a named manufacturer document.' },
    scenario: { label: 'Customer scenario', help: 'A situation with 3–4 responses and feedback.' },
    check: { label: 'Knowledge check', help: '2–5 practice questions (never exam questions).' },
    takeaways: { label: 'Key takeaways', help: '3–5 points to remember. Usually the last screen.' },
  };
  var ORDER = ['objectives', 'text', 'callout', 'quote', 'image', 'video', 'document', 'fact', 'comparison', 'explorer', 'steps', 'scenario', 'check', 'takeaways'];
  function courseMfr() { return (S.d && S.d.course && S.d.course.manufacturer_slug) || ''; }
  function newBlock(kind) {
    var m = courseMfr();
    switch (kind) {
      case 'objectives': return { kind: kind, items: ['', ''] };
      case 'text': return { kind: kind, heading: '', body: '' };
      case 'callout': return { kind: kind, tone: 'tip', body: '' };
      case 'quote': return { kind: kind, text: '', manufacturer_slug: m, source_label: '', source_url: '', source_date: '' };
      case 'image': return { kind: kind, _mode: 'placeholder', placeholder: '', alt: '', caption: '' };
      case 'video': return { kind: kind, _mode: 'placeholder', placeholder: '', caption: '' };
      case 'document': return { kind: kind, _mode: 'placeholder', placeholder: '', title: '' };
      case 'fact': return { kind: kind, manufacturer_slug: m, model_code: '', field: '', label: '' };
      case 'comparison': return { kind: kind, title: '', manufacturer_slug: m, models: [], fields: [] };
      case 'explorer': return { kind: kind, style: 'tabs', title: '', items: [{ title: '', body: '' }, { title: '', body: '' }] };
      case 'steps': return { kind: kind, title: '', items: ['', ''], source_label: '' };
      case 'scenario': return { kind: kind, prompt: '', choices: [{ id: 'a', text: '', feedback: '', best: true }, { id: 'b', text: '', feedback: '', best: false }, { id: 'c', text: '', feedback: '', best: false }] };
      case 'check': return { kind: kind, question_ids: [] };
      case 'takeaways': return { kind: kind, items: ['', '', ''] };
    }
  }
  /* Saved blocks -> the working copy (null text becomes '', the picture/placeholder choice is remembered). */
  function loadBlocks(blocks) {
    return (Array.isArray(blocks) ? copy(blocks) : []).map(function (b) {
      Object.keys(b).forEach(function (k) { if (b[k] === null && k !== 'media_id') b[k] = ''; });
      if (b.kind === 'image' || b.kind === 'video' || b.kind === 'document') {
        b._mode = b.media_id ? 'media' : 'placeholder';
        if (b.placeholder == null) b.placeholder = ''; if (b.kind === 'image' && b.alt == null) b.alt = '';
      }
      if (b.kind === 'quote' && b.source_date) b.source_date = String(b.source_date).slice(0, 10);
      return b;
    });
  }
  /* The working copy -> what the server stores (helper keys removed; only the chosen picture/placeholder kept). */
  function clean(blocks) {
    return copy(blocks).map(function (b) {
      if (b.kind === 'image' || b.kind === 'video' || b.kind === 'document') {
        if (b._mode === 'media') { delete b.placeholder; delete b.alt; } else { delete b.media_id; }
      }
      if (b.kind === 'explorer') {
        if (!b.media_id) delete b.media_id;
        (b.items || []).forEach(function (it) { if (!it.media_id) delete it.media_id; if (b.style !== 'hotspots') { delete it.x; delete it.y; } });
      }
      if (b.kind === 'steps' && !b.media_id) delete b.media_id;
      Object.keys(b).forEach(function (k) { if (k.charAt(0) === '_') delete b[k]; });
      return b;
    });
  }

  /* ------------------------------------------------------------------ facts, media and questions of this version */
  function factKey(m, model, field) { return m + '|' + String(model || '').toUpperCase() + '|' + field; }
  function factIndex() { var o = {}; (S.d.facts || []).forEach(function (f) { if (!f.valid_to) o[factKey(f.manufacturer_slug, f.model_code, f.field)] = f; }); return o; }
  function modelsOf(mfr) { var s = {}; (S.d.facts || []).forEach(function (f) { if (f.manufacturer_slug === mfr && !f.valid_to) s[String(f.model_code).toUpperCase()] = 1; }); return Object.keys(s).sort(); }
  function fieldsOf(mfr, models) {
    var s = {}; (S.d.facts || []).forEach(function (f) { if (f.manufacturer_slug === mfr && !f.valid_to && (!models || models.indexOf(String(f.model_code).toUpperCase()) >= 0)) s[f.field] = 1; });
    return Object.keys(s).sort();
  }
  function factValue(f) { if (!f) return null; var v = f.value; if (v && typeof v === 'object') v = v.text != null ? v.text : JSON.stringify(v); return String(v == null ? '' : v) + (f.unit ? ' ' + f.unit : ''); }
  function mediaById(id) { return (S.d.media || []).filter(function (m) { return String(m.id) === String(id); })[0] || null; }
  function mfrName(slug) { var r = (S.d.manufacturers || []).filter(function (m) { return m.slug === slug; })[0]; return r ? (r.name || r.slug) : slug; }
  function modulesSorted() { return (S.d.modules || []).slice().sort(function (a, b) { return a.position - b.position; }); }
  function lessonsOf(mid) { return (S.d.lessons || []).filter(function (l) { return String(l.module_id) === String(mid); }).sort(function (a, b) { return a.position - b.position; }); }
  function lessonById(id) { return (S.d.lessons || []).filter(function (l) { return String(l.id) === String(id); })[0] || null; }
  function moduleById(id) { return (S.d.modules || []).filter(function (m) { return String(m.id) === String(id); })[0] || null; }
  function lessonNo(l) { var m = moduleById(l.module_id); return (m ? m.position : '?') + '.' + l.position; }

  /* What a screen still needs (shown on its card; the Readiness tab is the full list). */
  function blockIssues(b) {
    var out = [], fi = factIndex();
    var blank = function (s) { return !String(s == null ? '' : s).trim(); };
    if (b.kind === 'image' || b.kind === 'video' || b.kind === 'document') {
      if (b._mode === 'media' && !b.media_id) out.push(['bad', 'Choose the approved file']);
      if (b._mode !== 'media') out.push(['adv', (b.kind === 'image' ? 'Picture' : b.kind === 'video' ? 'Video' : 'Document') + ' still to come']);
    }
    if (b.kind === 'explorer' && b.style === 'hotspots' && !b.media_id) out.push(['bad', 'Hotspots need a picture']);
    var facts = b.kind === 'fact' ? [[b.model_code, b.field]] : b.kind === 'comparison' ? [].concat.apply([], (b.models || []).map(function (m) { return (b.fields || []).map(function (f) { return [m, f.field]; }); })) : [];
    var miss = 0, wait = 0;
    facts.forEach(function (x) { if (!x[0] || !x[1]) return; var f = fi[factKey(b.manufacturer_slug, x[0], x[1])]; if (!f) miss++; else if (f.status !== 'verified') wait++; });
    if (miss) out.push(['bad', miss + ' fact' + (miss > 1 ? 's' : '') + ' not recorded']);
    if (wait) out.push(['adv', wait + ' awaiting confirmation']);
    var need = { objectives: [2, 4], takeaways: [3, 5], steps: [2, 20], explorer: [2, 12], scenario: [3, 4], check: [2, 5] }[b.kind];
    var arr = b.kind === 'scenario' ? b.choices : b.kind === 'check' ? b.question_ids : b.items;
    if (need && (!arr || arr.length < need[0] || arr.length > need[1])) out.push(['bad', need[0] + '–' + need[1] + ' needed']);
    var empty = false;
    if (b.kind === 'text' || b.kind === 'callout') empty = blank(b.body);
    if (b.kind === 'quote') empty = blank(b.text) || blank(b.source_label) || !b.source_date;
    if (b.kind === 'objectives' || b.kind === 'takeaways' || b.kind === 'steps') empty = (b.items || []).some(blank);
    if (b.kind === 'scenario') empty = blank(b.prompt) || (b.choices || []).some(function (c) { return blank(c.text) || blank(c.feedback); }) || !(b.choices || []).some(function (c) { return c.best; });
    if (b.kind === 'explorer') empty = (b.items || []).some(function (it) { return blank(it.title) || blank(it.body); });
    if (b.kind === 'fact') empty = !b.model_code || !b.field;
    if (b.kind === 'comparison') empty = !(b.models || []).length || !(b.fields || []).length;
    if (empty) out.push(['bad', 'Incomplete']);
    return out;
  }
  function blockSummary(b) {
    var t = '';
    switch (b.kind) {
      case 'objectives': case 'takeaways': case 'steps': t = (b.title ? b.title + ' — ' : '') + (b.items || []).filter(Boolean).join(' · '); break;
      case 'text': t = b.heading || b.body; break;
      case 'callout': t = b.body; break;
      case 'quote': t = b.text; break;
      case 'image': case 'video': t = b._mode === 'media' ? ((mediaById(b.media_id) || {}).alt_text || 'Approved file') : b.placeholder; if (b.caption) t += ' — ' + b.caption; break;
      case 'document': t = b.title || b.placeholder; break;
      case 'fact': t = (b.label || b.field || '') + (b.model_code ? ' · ' + b.model_code : ''); break;
      case 'comparison': t = (b.title ? b.title + ' — ' : '') + (b.models || []).join(', '); break;
      case 'explorer': t = (b.title ? b.title + ' — ' : '') + (b.items || []).map(function (i) { return i.title; }).filter(Boolean).join(' · '); break;
      case 'scenario': t = b.prompt; break;
      case 'check': t = (b.question_ids || []).length + ' practice question(s)'; break;
    }
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t ? (t.length > 90 ? t.slice(0, 88) + '…' : t) : '(empty)';
  }

  /* ------------------------------------------------------------------ form fields (each writes straight into the working copy) */
  function field(label, input, hint, counter) {
    var id = 'f' + (++fkCounter); input.id = id;
    return el('div', null, [el('label', { cls: 'f', for: id, text: label }), input, hint ? el('p', { cls: 'hint', text: hint }) : null, counter || null]);
  }
  function fText(label, obj, key, o) {
    o = o || {};
    var inp = el(o.multiline ? 'textarea' : 'input', { type: o.multiline ? null : (o.type || 'text'), maxlength: o.max || null, placeholder: o.placeholder || null, 'data-fk': o.fk || null, max: o.maxDate || null });
    inp.value = obj[key] == null ? '' : obj[key];
    var cnt = o.max ? el('div', { cls: 'count', text: String(inp.value.length) + ' / ' + o.max }) : null;
    inp.addEventListener('input', function () {
      obj[key] = o.upper ? inp.value.toUpperCase() : inp.value;
      if (cnt) cnt.textContent = inp.value.length + ' / ' + o.max;
      (o.onchange || changed)();
    });
    if (o.list) { var lid = 'dl' + (++fkCounter); inp.setAttribute('list', lid); var dl = el('datalist', { id: lid }, o.list.map(function (v) { return el('option', { value: v }); })); return el('div', null, [field(label, inp, o.hint, cnt), dl]); }
    return field(label, inp, o.hint, cnt);
  }
  function fSelect(label, obj, key, options, o) {
    o = o || {};
    var s = el('select', { 'data-fk': o.fk || null }, options.map(function (x) { return el('option', { value: x[0], text: x[1] }); }));
    s.value = obj[key] == null ? '' : obj[key];
    s.addEventListener('change', function () { obj[key] = s.value; (o.onchange || changed)(); });
    return field(label, s, o.hint);
  }
  /* A list of short texts with move up/down, remove and add (objectives, takeaways, steps). */
  function fList(label, arr, o) {
    var wrap = el('div', { cls: 'list-ed' });
    wrap.appendChild(el('label', { cls: 'f', text: label + ' (' + o.min + '–' + o.max + ')' }));
    arr.forEach(function (v, i) {
      var inp = el(o.multiline ? 'textarea' : 'input', { type: o.multiline ? null : 'text', maxlength: o.maxLen, 'aria-label': (o.item || 'Item') + ' ' + (i + 1), 'data-fk': o.fk + '-' + i });
      if (o.multiline) inp.style.minHeight = '60px';
      inp.value = v || '';
      inp.addEventListener('input', function () { arr[i] = inp.value; changed(); });
      wrap.appendChild(el('div', { cls: 'li' }, [inp,
        btn('▲', function () { if (i > 0) { var t = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = t; structural(o.fk + '-' + (i - 1)); } }, { cls: 'ico', 'aria-label': 'Move ' + (o.item || 'item') + ' ' + (i + 1) + ' up', disabled: i === 0, 'data-w': 1 }),
        btn('▼', function () { if (i < arr.length - 1) { var t = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = t; structural(o.fk + '-' + (i + 1)); } }, { cls: 'ico', 'aria-label': 'Move ' + (o.item || 'item') + ' ' + (i + 1) + ' down', disabled: i === arr.length - 1, 'data-w': 1 }),
        btn('×', function () { arr.splice(i, 1); structural(o.fk + '-' + Math.max(0, i - 1)); }, { cls: 'ico warn', 'aria-label': 'Remove ' + (o.item || 'item') + ' ' + (i + 1), disabled: arr.length <= o.min, 'data-w': 1 })]));
    });
    wrap.appendChild(btn('+ Add ' + (o.item || 'item').toLowerCase(), function () { arr.push(''); structural(o.fk + '-' + (arr.length - 1)); }, { disabled: arr.length >= o.max, 'data-w': 1 }));
    return wrap;
  }
  /* Choose an approved media record of the given kinds (pictures show thumbnails). */
  function mediaPicker(label, obj, key, kinds, o) {
    o = o || {};
    var recs = (S.d.media || []).filter(function (m) { return kinds.indexOf(m.kind) >= 0; });
    var box = el('div');
    box.appendChild(el('label', { cls: 'f', text: label }));
    if (!recs.length) {
      box.appendChild(el('p', { cls: 'hint', text: 'No approved ' + kinds.join(' / ') + ' yet.' }));
    }
    var grid = el('div', { cls: 'pick', role: 'group', 'aria-label': label });
    if (o.allowNone) grid.appendChild(btn(o.noneLabel || 'None', function () { delete obj[key]; structural(); }, { 'aria-pressed': String(!obj[key]), 'data-w': 1 }));
    recs.forEach(function (m) {
      var on = String(obj[key] || '') === String(m.id);
      var kids = [];
      if (m.kind === 'image') kids.push(m.signed_url ? el('img', { src: m.signed_url, alt: '', loading: 'lazy' }) : el('div', { cls: 'muted small', text: 'Picture (preview unavailable)' }));
      kids.push(el('span', { text: m.alt_text ? m.alt_text : (m.kind === 'image' ? 'Decorative picture' : (m.external_url || m.storage_path || m.kind)) }));
      grid.appendChild(btn('', function () { obj[key] = m.id; structural(); }, { 'aria-pressed': String(on), 'data-w': 1 }));
      kids.forEach(function (k) { grid.lastChild.appendChild(k); });
      grid.lastChild.setAttribute('aria-label', (on ? 'Selected: ' : 'Use ') + (m.alt_text || m.kind));
    });
    box.appendChild(grid);
    box.appendChild(el('p', { cls: 'hint' }, ['Files are added and approved under ', btn('Pictures & media', function () { go('media'); }, { cls: '', style: 'min-height:32px;padding:0 8px' }), '.']));
    return box;
  }

  /* ------------------------------------------------------------------ the per-kind screen editors */
  var TONES = [['tip', 'Tip'], ['caution', 'Caution'], ['ask_manufacturer', 'Ask the manufacturer']];
  function mfrOptions() { return (S.d.manufacturers || []).map(function (m) { return [m.slug, m.name || m.slug]; }); }
  function editor(b, i) {
    var fk = 'b' + i, box = el('div', { cls: 'blk-b' });
    box.appendChild(el('p', { cls: 'hint', text: KIND[b.kind].help }));
    var add = function (x) { box.appendChild(x); };
    switch (b.kind) {
      case 'objectives': add(fList('Objectives', b.items, { min: 2, max: 4, maxLen: 200, item: 'Objective', fk: fk })); break;
      case 'takeaways': add(fList('Takeaways', b.items, { min: 3, max: 5, maxLen: 300, item: 'Takeaway', fk: fk })); break;
      case 'text':
        add(fText('Heading (optional)', b, 'heading', { max: 120, fk: fk + 'h' }));
        add(fText('Text', b, 'body', { max: 4000, multiline: true, fk: fk + 't', hint: 'Plain text. A blank line starts a new paragraph.' })); break;
      case 'callout':
        add(fSelect('Kind', b, 'tone', TONES, { fk: fk + 'k' }));
        add(fText('Text', b, 'body', { max: 600, multiline: true, fk: fk + 't' })); break;
      case 'quote':
        add(fText('The manufacturer’s words', b, 'text', { max: 1000, multiline: true, fk: fk + 'q', hint: 'Health or clinical statements appear only as the manufacturer’s own attributed words.' }));
        add(fSelect('Manufacturer', b, 'manufacturer_slug', mfrOptions()));
        add(fText('Source (document or page name)', b, 'source_label', { max: 200 }));
        add(fText('Source link (https, optional)', b, 'source_url', { type: 'url', max: 1000 }));
        add(fText('Source date', b, 'source_date', { type: 'date', maxDate: new Date().toISOString().slice(0, 10) })); break;
      case 'image': case 'video': case 'document': mediaEditor(b, add, fk); break;
      case 'fact': factEditor(b, add, fk); break;
      case 'comparison': comparisonEditor(b, add, fk); break;
      case 'explorer': explorerEditor(b, add, fk); break;
      case 'steps':
        add(fText('Title (optional)', b, 'title', { max: 120 }));
        add(fList('Steps', b.items, { min: 2, max: 20, maxLen: 400, item: 'Step', fk: fk, multiline: true }));
        add(fText('Source document', b, 'source_label', { max: 200, hint: 'Which manufacturer document these steps come from.' }));
        add(mediaPicker('Linked document (optional)', b, 'media_id', ['pdf', 'link'], { allowNone: true, noneLabel: 'No document' })); break;
      case 'scenario': scenarioEditor(b, add, fk); break;
      case 'check': checkEditor(b, add); break;
    }
    return box;
  }
  function mediaEditor(b, add, fk) {
    var what = b.kind === 'image' ? 'picture' : b.kind === 'video' ? 'video' : 'document';
    var g = el('div', { cls: 'bar', role: 'radiogroup', 'aria-label': 'Source of the ' + what });
    [['media', 'Approved ' + what], ['placeholder', 'Placeholder (not available yet)']].forEach(function (x) {
      g.appendChild(btn(x[1], function () { b._mode = x[0]; structural(fk + 'm'); }, { role: 'radio', 'aria-checked': String(b._mode === x[0]), 'data-w': 1, cls: b._mode === x[0] ? 'pri' : '', 'data-fk': x[0] === b._mode ? fk + 'm' : null }));
    });
    add(g);
    if (b._mode === 'media') {
      add(mediaPicker('Approved ' + what, b, 'media_id', b.kind === 'image' ? ['image'] : b.kind === 'video' ? ['video'] : ['pdf', 'link']));
      if (b.kind === 'image') add(el('p', { cls: 'hint', text: 'The alt text comes from the approved picture record.' }));
    } else {
      add(fText('What is needed (shown as the placeholder label)', b, 'placeholder', { max: 200, hint: 'e.g. “Golden photo: PR-446 in full recline, side view”.' }));
      if (b.kind === 'image') add(fText('Alt text (what the picture will show)', b, 'alt', { max: 300, hint: '10–300 characters describing the picture, not a file name.' }));
    }
    if (b.kind === 'document') add(fText('Document title', b, 'title', { max: 200 }));
    else add(fText('Caption (optional)', b, 'caption', { max: 300 }));
  }
  function factStatusLine(mfr, model, fieldName) {
    if (!model || !fieldName) return el('p', { cls: 'hint', text: 'Choose a model and a specification.' });
    var f = factIndex()[factKey(mfr, model, fieldName)];
    if (!f) return note('No product fact recorded for ' + model + ' · ' + fieldName + '. Record it in the Command Center → Product Facts first; until then the lesson shows “not available”.', 'err');
    if (f.status !== 'verified') return note(model + ' · ' + fieldName + ' is awaiting manufacturer confirmation (' + (f.note || 'no note') + '). It is labelled as unconfirmed and cannot be used in exam questions.');
    return note('Verified: ' + factValue(f) + ' · ' + (f.source_label || 'source') + (f.verified_on ? ' · ' + f.verified_on : ''), 'ok');
  }
  function factEditor(b, add, fk) {
    add(fSelect('Manufacturer', b, 'manufacturer_slug', mfrOptions(), { onchange: function () { structural(); } }));
    var fWrap;
    add(fText('Model', b, 'model_code', { max: 40, upper: true, list: modelsOf(b.manufacturer_slug), fk: fk + 'm', onchange: function () {
      changed(); refreshFactLine();
      var dl = fWrap.querySelector('datalist'); if (dl) dl.replaceChildren.apply(dl, fieldsOf(b.manufacturer_slug, b.model_code ? [String(b.model_code).toUpperCase()] : null).map(function (x) { return el('option', { value: x }); }));
    } }));
    fWrap = fText('Specification (field)', b, 'field', { max: 60, list: fieldsOf(b.manufacturer_slug, b.model_code ? [String(b.model_code).toUpperCase()] : null), fk: fk + 'f', onchange: function () { changed(); refreshFactLine(); } });
    add(fWrap);
    add(fText('Label shown to learners', b, 'label', { max: 120, hint: 'e.g. “Weight capacity”.' }));
    var line = el('div', { 'data-factline': '1' }, [factStatusLine(b.manufacturer_slug, String(b.model_code || '').toUpperCase(), b.field)]);
    add(line);
    function refreshFactLine() { line.replaceChildren(factStatusLine(b.manufacturer_slug, String(b.model_code || '').toUpperCase(), b.field)); }
  }
  function comparisonEditor(b, add, fk) {
    add(fText('Title (optional)', b, 'title', { max: 120 }));
    add(fSelect('Manufacturer', b, 'manufacturer_slug', mfrOptions(), { onchange: function () { structural(); } }));
    // models as chips
    add(el('label', { cls: 'f', text: 'Models (2–6)' }));
    var chips = el('div', { cls: 'mchips' });
    b.models.forEach(function (m, i) {
      chips.appendChild(el('span', { cls: 'mchip' }, [m,
        btn('◀', function () { if (i > 0) { var t = b.models[i - 1]; b.models[i - 1] = m; b.models[i] = t; structural(fk + 'ml' + (i - 1)); } }, { 'aria-label': 'Move ' + m + ' left', disabled: i === 0, 'data-w': 1, 'data-fk': fk + 'ml' + i }),
        btn('▶', function () { if (i < b.models.length - 1) { var t = b.models[i + 1]; b.models[i + 1] = m; b.models[i] = t; structural(fk + 'ml' + (i + 1)); } }, { 'aria-label': 'Move ' + m + ' right', disabled: i === b.models.length - 1, 'data-w': 1 }),
        btn('×', function () { b.models.splice(i, 1); structural(fk + 'add'); }, { 'aria-label': 'Remove ' + m, 'data-w': 1 })]));
    });
    if (!b.models.length) chips.appendChild(el('span', { cls: 'muted small', text: 'No models yet.' }));
    add(chips);
    var known = modelsOf(b.manufacturer_slug).filter(function (m) { return b.models.indexOf(m) < 0; });
    var lid = 'dl' + (++fkCounter), inp = el('input', { type: 'text', list: lid, maxlength: 40, 'aria-label': 'Model code to add', placeholder: 'Model code, e.g. PR-446', 'data-fk': fk + 'add' });
    var addModel = function () {
      var v = inp.value.trim().toUpperCase(); if (!v) return;
      if (!/^[A-Z0-9][A-Z0-9._\/-]{0,39}$/.test(v)) { toast('A model code is letters, numbers and . _ / - only.', true); return; }
      if (b.models.indexOf(v) >= 0 || b.models.length >= 6) return;
      b.models.push(v); structural(fk + 'add');
    };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addModel(); } });
    add(el('div', { cls: 'bar' }, [el('div', { cls: 'grow' }, [inp, el('datalist', { id: lid }, known.map(function (m) { return el('option', { value: m }); }))]), btn('+ Add model', addModel, { disabled: b.models.length >= 6, 'data-w': 1 })]));
    // rows
    add(el('label', { cls: 'f', text: 'Rows — the specifications compared (1–12)' }));
    var fl = fieldsOf(b.manufacturer_slug, b.models.length ? b.models : null);
    b.fields.forEach(function (r, i) {
      var lid2 = 'dl' + (++fkCounter);
      var fIn = el('input', { type: 'text', list: lid2, maxlength: 60, 'aria-label': 'Row ' + (i + 1) + ' specification field', value: r.field || '', 'data-fk': fk + 'rf' + i });
      fIn.addEventListener('input', function () { r.field = fIn.value.trim(); changed(); drawGrid(); });
      var lIn = el('input', { type: 'text', maxlength: 80, 'aria-label': 'Row ' + (i + 1) + ' label', value: r.label || '', placeholder: 'Label, e.g. Weight capacity' });
      lIn.addEventListener('input', function () { r.label = lIn.value; changed(); drawGrid(); });
      add(el('div', { cls: 'sub-card' }, [el('div', { cls: 'bar' }, [el('div', { cls: 'grow' }, [fIn, el('datalist', { id: lid2 }, fl.map(function (x) { return el('option', { value: x }); }))]), el('div', { cls: 'grow' }, [lIn]),
        btn('▲', function () { if (i > 0) { var t = b.fields[i - 1]; b.fields[i - 1] = r; b.fields[i] = t; structural(fk + 'rf' + (i - 1)); } }, { cls: 'ico', 'aria-label': 'Move row ' + (i + 1) + ' up', disabled: i === 0, 'data-w': 1 }),
        btn('▼', function () { if (i < b.fields.length - 1) { var t = b.fields[i + 1]; b.fields[i + 1] = r; b.fields[i] = t; structural(fk + 'rf' + (i + 1)); } }, { cls: 'ico', 'aria-label': 'Move row ' + (i + 1) + ' down', disabled: i === b.fields.length - 1, 'data-w': 1 }),
        btn('×', function () { b.fields.splice(i, 1); structural(); }, { cls: 'ico warn', 'aria-label': 'Remove row ' + (i + 1), 'data-w': 1 })])]));
    });
    add(btn('+ Add row', function () { b.fields.push({ field: '', label: '' }); structural(fk + 'rf' + (b.fields.length - 1)); }, { disabled: b.fields.length >= 12, 'data-w': 1 }));
    // the grid as learners will see it, with every missing or unconfirmed cell flagged
    var gridBox = el('div'); add(gridBox); drawGrid();
    function drawGrid() {
      gridBox.replaceChildren();
      if (!b.models.length || !b.fields.length) return;
      var fi = factIndex();
      var t = el('table', { cls: 'cmp' }, [el('thead', null, el('tr', null, [el('th', { text: '' })].concat(b.models.map(function (m) { return el('th', { scope: 'col', text: m }); })))),
        el('tbody', null, b.fields.map(function (r) {
          return el('tr', null, [el('th', { scope: 'row', text: r.label || r.field || '—' })].concat(b.models.map(function (m) {
            var f = r.field ? fi[factKey(b.manufacturer_slug, m, r.field)] : null;
            if (!f) return el('td', { cls: 'miss', text: 'Not recorded' });
            if (f.status !== 'verified') return el('td', { cls: 'wait', text: (factValue(f) || '') + ' · awaiting confirmation' });
            return el('td', { text: factValue(f) });
          })));
        }))]);
      gridBox.appendChild(el('div', { cls: 'grid-wrap' }, t));
      gridBox.appendChild(el('p', { cls: 'hint', text: 'Every cell must be a recorded product fact; red cells are not recorded yet, amber cells await manufacturer confirmation. Saving links these facts to the lesson.' }));
    }
  }
  var placing = null;   // { block, item } while a hotspot is being placed
  function explorerEditor(b, add, fk) {
    add(fSelect('Style', b, 'style', [['tabs', 'Tabs'], ['cards', 'Cards'], ['hotspots', 'Hotspots on a picture']], { onchange: function () {
      if (b.style === 'hotspots') b.items.forEach(function (it, k) { if (typeof it.x !== 'number') { it.x = 20 + (k * 15) % 60; it.y = 50; } });
      structural(); } }));
    add(fText('Title (optional)', b, 'title', { max: 120 }));
    add(mediaPicker(b.style === 'hotspots' ? 'Picture (required for hotspots)' : 'Picture (optional)', b, 'media_id', ['image'], { allowNone: b.style !== 'hotspots', noneLabel: 'No picture' }));
    var pic = b.media_id ? mediaById(b.media_id) : null;
    if (b.style === 'hotspots' && pic && pic.signed_url) {
      var img = el('img', { src: pic.signed_url, alt: pic.alt_text || '' });
      var hot = el('div', { cls: 'hot' }, [img]);
      b.items.forEach(function (it, k) {
        if (typeof it.x === 'number' && typeof it.y === 'number') hot.appendChild(el('span', { cls: 'pin' + (placing && placing.item === k && placing.block === b ? ' on' : ''), style: 'left:' + it.x + '%;top:' + it.y + '%', text: String(k + 1), 'aria-hidden': 'true' }));
      });
      hot.addEventListener('click', function (e) {
        if (!placing || placing.block !== b || !editable()) return;
        var r = img.getBoundingClientRect();
        var x = Math.round(Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100)) * 10) / 10;
        var y = Math.round(Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100)) * 10) / 10;
        var it = b.items[placing.item]; it.x = x; it.y = y; var k = placing.item; placing = null; structural(fk + 'x' + k);
      });
      add(hot);
      add(el('p', { cls: 'hint', text: placing && placing.block === b ? 'Now click the picture where hotspot ' + (placing.item + 1) + ' belongs.' : 'Use “Place on picture”, then click the picture. You can also type the position (0–100 across and down).' }));
    }
    add(el('label', { cls: 'f', text: 'Items (2–12)' }));
    b.items.forEach(function (it, k) {
      var c = el('div', { cls: 'sub-card' });
      c.appendChild(el('div', { cls: 'bar' }, [el('b', { cls: 'grow', text: 'Item ' + (k + 1) }),
        btn('▲', function () { if (k > 0) { var t = b.items[k - 1]; b.items[k - 1] = it; b.items[k] = t; structural(); } }, { cls: 'ico', 'aria-label': 'Move item ' + (k + 1) + ' up', disabled: k === 0, 'data-w': 1 }),
        btn('▼', function () { if (k < b.items.length - 1) { var t = b.items[k + 1]; b.items[k + 1] = it; b.items[k] = t; structural(); } }, { cls: 'ico', 'aria-label': 'Move item ' + (k + 1) + ' down', disabled: k === b.items.length - 1, 'data-w': 1 }),
        btn('×', function () { b.items.splice(k, 1); structural(); }, { cls: 'ico warn', 'aria-label': 'Remove item ' + (k + 1), disabled: b.items.length <= 2, 'data-w': 1 })]));
      c.appendChild(fText('Title', it, 'title', { max: 80, fk: fk + 'it' + k }));
      c.appendChild(fText('Text', it, 'body', { max: 600, multiline: true }));
      if (b.style === 'hotspots') {
        var xIn = el('input', { type: 'number', min: 0, max: 100, step: 0.1, value: it.x, 'aria-label': 'Hotspot ' + (k + 1) + ' across (0–100)', 'data-fk': fk + 'x' + k });
        var yIn = el('input', { type: 'number', min: 0, max: 100, step: 0.1, value: it.y, 'aria-label': 'Hotspot ' + (k + 1) + ' down (0–100)' });
        xIn.addEventListener('input', function () { var v = Number(xIn.value); if (isFinite(v)) { it.x = Math.min(100, Math.max(0, v)); changed(); } });
        yIn.addEventListener('input', function () { var v = Number(yIn.value); if (isFinite(v)) { it.y = Math.min(100, Math.max(0, v)); changed(); } });
        c.appendChild(el('div', { cls: 'bar', style: 'margin-top:8px' }, [el('div', { style: 'width:110px' }, [xIn]), el('div', { style: 'width:110px' }, [yIn]),
          btn(placing && placing.block === b && placing.item === k ? 'Click the picture…' : 'Place on picture', function () { placing = { block: b, item: k }; structural(); }, { disabled: !pic, 'data-w': 1 })]));
      } else {
        c.appendChild(mediaPicker('Picture for this item (optional)', it, 'media_id', ['image'], { allowNone: true, noneLabel: 'No picture' }));
      }
      add(c);
    });
    add(btn('+ Add item', function () { var it = { title: '', body: '' }; if (b.style === 'hotspots') { it.x = 50; it.y = 50; } b.items.push(it); structural(fk + 'it' + (b.items.length - 1)); }, { disabled: b.items.length >= 12, 'data-w': 1 }));
  }
  function relabel(choices) { choices.forEach(function (c, k) { c.id = 'abcd'.charAt(k); }); }
  function scenarioEditor(b, add, fk) {
    add(fText('The situation', b, 'prompt', { max: 1000, multiline: true, fk: fk + 'p', hint: 'What the customer says or needs. Learners choose the best response.' }));
    add(el('label', { cls: 'f', text: 'Responses (3–4) — mark at least one best answer' }));
    b.choices.forEach(function (c, k) {
      var best = el('input', { type: 'checkbox', checked: !!c.best, id: 'best' + (++fkCounter) });
      best.addEventListener('change', function () { c.best = best.checked; changed(); });
      var card = el('div', { cls: 'sub-card' }, [
        el('div', { cls: 'bar' }, [el('b', { cls: 'grow', text: 'Response ' + c.id.toUpperCase() }),
          el('label', { cls: 'bar', for: best.id, style: 'min-height:44px;font-weight:700;font-size:13px' }, [best, ' Best answer']),
          btn('▲', function () { if (k > 0) { b.choices.splice(k - 1, 0, b.choices.splice(k, 1)[0]); relabel(b.choices); structural(); } }, { cls: 'ico', 'aria-label': 'Move response ' + (k + 1) + ' up', disabled: k === 0, 'data-w': 1 }),
          btn('▼', function () { if (k < b.choices.length - 1) { b.choices.splice(k + 1, 0, b.choices.splice(k, 1)[0]); relabel(b.choices); structural(); } }, { cls: 'ico', 'aria-label': 'Move response ' + (k + 1) + ' down', disabled: k === b.choices.length - 1, 'data-w': 1 }),
          btn('×', function () { b.choices.splice(k, 1); relabel(b.choices); structural(); }, { cls: 'ico warn', 'aria-label': 'Remove response ' + (k + 1), disabled: b.choices.length <= 3, 'data-w': 1 })]),
        fText('Response', c, 'text', { max: 300, multiline: true, fk: fk + 'c' + k }),
        fText('Feedback shown after choosing it', c, 'feedback', { max: 500, multiline: true })]);
      add(card);
    });
    add(btn('+ Add response', function () { b.choices.push({ id: 'abcd'.charAt(b.choices.length), text: '', feedback: '', best: false }); structural(fk + 'c' + (b.choices.length - 1)); }, { disabled: b.choices.length >= 4, 'data-w': 1 }));
  }
  function checkEditor(b, add) {
    var practice = (S.d.questions || []).filter(function (q) { return q.use === 'practice' && q.status === 'active'; });
    add(el('p', { cls: 'hint', text: 'Choose 2–5 active practice questions. Exam questions never appear in a lesson (their answers would be given away).' }));
    if (!practice.length) add(note('This version has no practice questions yet. Create them in the Question bank.'));
    var list = el('div', { role: 'group', 'aria-label': 'Practice questions in this check' });
    practice.forEach(function (q) {
      var id = 'chk' + (++fkCounter), on = b.question_ids.indexOf(q.id) >= 0;
      var cb = el('input', { type: 'checkbox', id: id, checked: on, disabled: !on && b.question_ids.length >= 5 });
      cb.addEventListener('change', function () { if (cb.checked) { if (b.question_ids.indexOf(q.id) < 0) b.question_ids.push(q.id); } else b.question_ids = b.question_ids.filter(function (x) { return x !== q.id; }); structural(); });
      var mod = moduleById(q.module_id);
      list.appendChild(el('label', { for: id, cls: 'q', style: 'display:flex;gap:10px;align-items:flex-start;cursor:pointer' }, [cb, el('span', null, [el('b', { text: q.prompt }), el('br'), el('span', { cls: 'muted small', text: (mod ? 'Module ' + mod.position : 'No module') + ' · ' + q.kind })])]));
    });
    add(list);
    var missing = b.question_ids.filter(function (id) { return !practice.some(function (q) { return q.id === id; }); });
    if (missing.length) add(note(missing.length + ' chosen question(s) are no longer active practice questions; remove them.', 'err'));
    add(btn('+ New practice question', function () { S.editQ = { _new: true, use: 'practice', kind: 'single', module_id: (lessonById(S.lessonId) || {}).module_id || '', prompt: '', choices: [{ id: 'a', text: '' }, { id: 'b', text: '' }, { id: 'c', text: '' }], answer_key: 'a', explanation: '', objective_tags: [] }; go('bank'); }, { 'data-w': 1 }));
  }

  /* ------------------------------------------------------------------ editing life-cycle */
  function changed() {
    if (!S.dirty) { S.dirty = true; renderSaveBar(); }
    var card = document.querySelector('.blk[data-i="' + S.sel + '"]');
    if (card && S.blocks[S.sel]) {
      var t = card.querySelector('.blk-h .s'); if (t) t.textContent = blockSummary(S.blocks[S.sel]);
      var fl = card.querySelector('.flags'); if (fl) fl.replaceChildren.apply(fl, blockIssues(S.blocks[S.sel]).map(function (x) { return pill(x[1], x[0]); }));
    }
    schedulePreview();
  }
  function structural(fk) { S.confirm = null; S.dirty = true; renderEdit(); renderSaveBar(); schedulePreview(); focusKey(fk); }
  function selectLesson(id) {
    var l = lessonById(id); if (!l) return;
    S.tab = 'lessons'; S.confirm = null;
    S.lessonId = l.id; S.blocks = loadBlocks(l.blocks); S.base = l.hash; S.dirty = false; S.sel = S.blocks.length ? 0 : -1; S.addOpen = false; placing = null;
    if (window.matchMedia('(max-width:1279px)').matches) S.pane = 'edit';
    setHash(); renderTabs(); renderLessons(); schedulePreview(0);
  }
  /* Never lose unsaved screens: switching lesson or reloading asks first. */
  function guard(next) {
    if (!S.dirty) { next(); return; }
    if (!$('#pEdit')) { S.tab = 'lessons'; setHash(); renderTabs(); render(); }
    S.pane = 'edit'; var lay = document.querySelector('.lay'); if (lay) lay.setAttribute('data-pane', 'edit');
    var p = $('#pEdit'); if (!p) return;
    var box = el('div', { cls: 'note', role: 'alertdialog', 'aria-label': 'Unsaved changes' }, [el('b', { text: 'This lesson has unsaved changes.' }), ' ',
      btn('Save them', function () { save().then(function (ok) { if (ok) next(); }); }, { cls: 'pri', 'data-w': 1 }), ' ',
      btn('Discard them', function () { S.dirty = false; next(); }, { cls: 'warn' }), ' ', btn('Keep editing', function () { box.remove(); })]);
    p.insertBefore(box, p.firstChild); box.querySelector('button').focus();
  }
  window.addEventListener('beforeunload', function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  function save() {
    if (!S.lessonId || !editable() || S.busy) return Promise.resolve(false);
    S.busy = true; renderSaveBar('Saving…');
    var lessonId = S.lessonId;
    return api({ action: 'save_blocks', lesson_id: lessonId, blocks: clean(S.blocks), base_hash: S.base }).then(function (r) {
      S.busy = false;
      if (r.status === 200 && r.body.lesson) {
        var l = lessonById(lessonId); if (l) { l.blocks = r.body.lesson.blocks; l.hash = r.body.lesson.hash; }
        if (S.lessonId === lessonId) { S.blocks = loadBlocks(r.body.lesson.blocks); S.base = r.body.lesson.hash; S.dirty = false; }
        toast('Saved.' + (r.body.facts_linked ? ' ' + r.body.facts_linked + ' product fact(s) linked to the lesson.' : ''));
        refreshData();
        return true;
      }
      if (r.status === 409 && r.body.error === 'changed') {
        renderSaveBar(); var p = $('#pEdit');
        if (p) p.insertBefore(el('div', { cls: 'note err' }, [msgOf(r), ' ', btn('Reload the lesson (your unsaved changes are discarded)', function () { S.dirty = false; refreshData(true); }, { cls: 'warn' })]), p.firstChild);
        return false;
      }
      renderSaveBar(); toast(msgOf(r, 'The lesson could not be saved.'), true); return false;
    });
  }

  /* ------------------------------------------------------------------ live preview (the learner player, unsaved screens) */
  function schedulePreview(delay) {
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(drawPreview, delay == null ? 700 : delay);
  }
  function drawPreview() {
    var box = $('#player'); if (!box || !S.lessonId) return;
    var seq = ++S.previewSeq, lessonId = S.lessonId, blocks = clean(S.blocks);
    var status = $('#pvStatus'); if (status) status.textContent = 'Updating…';
    api({ action: 'preview_blocks', lesson_id: lessonId, blocks: blocks }).then(function (r) {
      if (seq !== S.previewSeq || lessonId !== S.lessonId) return;   // a newer preview is on its way
      var st = $('#pvStatus');
      if (r.status !== 200 || !r.body.lesson) { if (st) st.textContent = 'Preview not updated: ' + msgOf(r); return; }
      if (st) st.textContent = 'Preview of the screens as edited · not saved · practice answers are checked on the server';
      S.player = HCPSLessonPlayer.mount(box, r.body.lesson, {
        check: function (qid, answer) {
          return api({ action: 'preview_check', lesson_id: lessonId, question_id: qid, answer: answer, blocks: blocks }).then(function (x) { if (x.status !== 200) throw new Error(msgOf(x)); return x.body; });
        },
      });
      if (S.sel > 0 && S.player && S.player.go) try { S.player.go(S.sel); } catch (_) { /* the player keeps its own place */ }
    });
  }

  /* ------------------------------------------------------------------ drag and drop (desktop) — the ▲▼ buttons do the same on phones and keyboards */
  function sortable(container, selector, onMove) {
    if (!editable()) return;
    var from = null;
    Array.prototype.forEach.call(container.querySelectorAll(selector), function (item, idx) {
      var handle = item.querySelector('.drag'); if (!handle) return;
      handle.addEventListener('pointerdown', function () { item.setAttribute('draggable', 'true'); });
      handle.addEventListener('pointerup', function () { item.removeAttribute('draggable'); });
      item.addEventListener('dragstart', function (e) { if (!e.target.closest || e.target.closest(selector) !== item) return; from = idx; item.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch (_) { /* old browsers */ } e.stopPropagation(); });
      item.addEventListener('dragend', function () { item.removeAttribute('draggable'); item.classList.remove('dragging'); from = null; Array.prototype.forEach.call(container.querySelectorAll('.dropping'), function (x) { x.classList.remove('dropping'); }); });
      item.addEventListener('dragover', function (e) { if (from == null) return; e.preventDefault(); e.stopPropagation(); item.classList.add('dropping'); });
      item.addEventListener('dragleave', function () { item.classList.remove('dropping'); });
      item.addEventListener('drop', function (e) {
        if (from == null) return; e.preventDefault(); e.stopPropagation(); item.classList.remove('dropping');
        var r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        var to = idx + (after ? 1 : 0); if (to > from) to--;
        var f = from; from = null; if (to !== f) onMove(f, to);
      });
    });
  }
  function moved(list, f, t) { var a = list.slice(); a.splice(t, 0, a.splice(f, 1)[0]); return a; }

  /* ------------------------------------------------------------------ server-side structure changes (modules, lessons, order) */
  function write(body, okText) {
    if (S.busy) return Promise.resolve(null);
    S.busy = true;
    return api(body).then(function (r) {
      S.busy = false;
      if (r.status !== 200) { toast(msgOf(r), true); return null; }
      if (okText) toast(okText);
      return refreshData().then(function () { return r.body; });
    });
  }
  function reorderModules(f, t) { var ids = moved(modulesSorted().map(function (m) { return m.id; }), f, t); write({ action: 'reorder_modules', version_id: VERSION, order: ids }, 'Module order saved.'); }
  function reorderLessons(mid, f, t) { var ids = moved(lessonsOf(mid).map(function (l) { return l.id; }), f, t); write({ action: 'reorder_lessons', module_id: mid, order: ids }, 'Lesson order saved.'); }

  /* ------------------------------------------------------------------ data */
  function refreshData(resetLesson) {
    return api({ action: 'builder', version_id: VERSION }).then(function (r) {
      if (r.status !== 200) { toast(msgOf(r, 'The course could not be loaded.'), true); return; }
      S.d = r.body;
      if (S.lessonId && !lessonById(S.lessonId)) { S.lessonId = null; S.blocks = []; S.dirty = false; }
      if (S.lessonId && (resetLesson || !S.dirty)) { var l = lessonById(S.lessonId); S.blocks = loadBlocks(l.blocks); S.base = l.hash; S.dirty = false; if (S.sel >= S.blocks.length) S.sel = S.blocks.length - 1; }
      renderHead(); renderTabs(); render();
    });
  }

  /* ------------------------------------------------------------------ rendering */
  function setHash() { try { history.replaceState(null, '', location.pathname + location.search + '#' + S.tab + (S.tab === 'lessons' && S.lessonId ? '/' + S.lessonId : '')); } catch (_) { /* ignore */ } }
  function go(tab) { S.tab = tab; setHash(); renderTabs(); render(); window.scrollTo(0, 0); }
  function renderHead() {
    var d = S.d, v = d.version, c = d.course || {};
    $('#title').textContent = (c.title || 'Course') + ' — v' + v.version;
    $('#subtitle').textContent = ({ draft: 'Draft', in_review: 'In review (read only)', published: 'Published (read only)', retired: 'Retired (read only)' }[v.status] || v.status) +
      ' · pass mark ' + v.pass_mark + '% · ' + v.exam_questions + ' exam questions per attempt' + (c.manufacturer_slug ? ' · ' + mfrName(c.manufacturer_slug) : '');
    var R = d.readiness, p = $('#readyPill');
    p.textContent = R.ready ? 'Ready for review' : R.counts.blocking + ' to fix · ' + R.counts.advice + ' suggestion' + (R.counts.advice === 1 ? '' : 's');
    p.className = 'pill ' + (R.ready ? 'ok' : 'bad');
    $('#lockNote').replaceChildren(editable() ? '' : note('This version is ' + v.status.replace('_', ' ') + ', so it is read only here. ' + (v.status === 'in_review' ? 'Return it to draft in the Command Center to change it.' : 'Create a new version in the Command Center to change the course.')));
    $('#backLink').setAttribute('href', '/admin/academy.html#courses');
  }
  function renderTabs() {
    var t = $('#tabs'); t.replaceChildren();
    TABS.forEach(function (x) {
      var label = x[1];
      if (x[0] === 'ready' && S.d && !S.d.readiness.ready) label += ' (' + S.d.readiness.counts.blocking + ')';
      t.appendChild(btn(label, function () { if (x[0] !== S.tab) go(x[0]); }, { role: 'tab', 'aria-selected': String(S.tab === x[0]) }));
    });
  }
  function render() {
    var v = $('#view'); v.replaceChildren();
    if (S.tab === 'lessons') renderLessons();
    else if (S.tab === 'bank') renderBank();
    else if (S.tab === 'dist') renderDist();
    else if (S.tab === 'media') renderMedia();
    else renderReady();
    if (!editable() && S.tab !== 'media' && S.tab !== 'ready') lockInputs($('#view'));
  }
  function lockInputs(root) {
    Array.prototype.forEach.call(root.querySelectorAll('input,select,textarea,button[data-w]'), function (e) { if (!e.closest('#player')) e.disabled = true; });
  }

  /* --- Lessons & screens --- */
  function renderLessons() {
    var v = $('#view'); v.replaceChildren();
    var sw = el('div', { cls: 'pane-switch', role: 'group', 'aria-label': 'Show' });
    [['outline', 'Outline', 'p-outline'], ['edit', 'Screens'], ['preview', 'Preview']].forEach(function (x) {
      sw.appendChild(btn(x[1], function () { S.pane = x[0]; lay.setAttribute('data-pane', x[0]); Array.prototype.forEach.call(sw.children, function (b) { b.setAttribute('aria-pressed', String(b === this)); }, this); if (x[0] === 'preview') schedulePreview(0); }, { cls: x[2] || null, 'aria-pressed': String(S.pane === x[0]) }));
    });
    var lay = el('div', { cls: 'lay', 'data-pane': S.pane }, [el('section', { id: 'pOutline', 'aria-label': 'Course outline' }), el('section', { id: 'pEdit', 'aria-label': 'Lesson screens' }), el('section', { id: 'pPreview', 'aria-label': 'Live preview' })]);
    v.append(sw, lay);
    renderOutline(); renderEdit(); renderPreviewPane();
    if (!editable()) lockInputs(lay);
  }
  function inlineForm(fields, submitText, onSubmit, onCancel) {
    var f = el('form', { cls: 'sub-card' });
    var inputs = fields.map(function (x) { var i = el('input', { type: x.type || 'text', maxlength: x.max || null, min: x.min, max: x.maxv, value: x.value == null ? '' : x.value, required: x.required ? true : null }); f.appendChild(field(x.label, i)); return i; });
    f.appendChild(el('div', { cls: 'bar', style: 'margin-top:8px' }, [el('button', { type: 'submit', cls: 'pri', text: submitText, 'data-w': 1 }), btn('Cancel', onCancel)]));
    f.addEventListener('submit', function (e) { e.preventDefault(); onSubmit(inputs.map(function (i) { return i.value.trim(); })); });
    setTimeout(function () { inputs[0].focus(); }, 0);
    return f;
  }
  function renderOutline() {
    var p = $('#pOutline'); if (!p) return; p.replaceChildren();
    var card = el('div', { cls: 'card' }, [el('h2', { text: 'Outline' }), el('p', { cls: 'hint', text: editable() ? 'Drag ⠿ to reorder, or use ▲ ▼. Lessons move within their module.' : 'Read only.' })]);
    var mods = modulesSorted(), list = el('div');
    mods.forEach(function (m, mi) {
      var box = el('div', { cls: 'mod', 'data-id': m.id });
      var head = el('div', { cls: 'mod-h' }, [editable() ? el('span', { cls: 'drag', 'aria-hidden': 'true', text: '⠿' }) : null, el('span', { cls: 'grow', text: m.position + '. ' + m.title }),
        btn('▲', function () { if (mi > 0) reorderModules(mi, mi - 1); }, { cls: 'ico', 'aria-label': 'Move module ' + m.position + ' up', disabled: mi === 0, 'data-w': 1 }),
        btn('▼', function () { if (mi < mods.length - 1) reorderModules(mi, mi + 1); }, { cls: 'ico', 'aria-label': 'Move module ' + m.position + ' down', disabled: mi === mods.length - 1, 'data-w': 1 }),
        btn('✎', function () { box.replaceChildren(inlineForm([{ label: 'Module title', value: m.title, max: 200, required: true }], 'Rename', function (vals) { write({ action: 'update_module', id: m.id, title: vals[0] }, 'Module renamed.'); }, renderOutline)); }, { cls: 'ico', 'aria-label': 'Rename module ' + m.position, 'data-w': 1 })]);
      box.appendChild(head);
      var ls = lessonsOf(m.id), lbox = el('div', { style: 'padding:4px' });
      ls.forEach(function (l, li) {
        var row = el('div', { cls: 'row' + (String(l.id) === String(S.lessonId) ? ' sel' : ''), 'data-id': l.id }, [editable() ? el('span', { cls: 'drag', 'aria-hidden': 'true', text: '⠿' }) : null,
          btn(m.position + '.' + l.position + ' ' + l.title, function () { guard(function () { selectLesson(l.id); }); }, { cls: 't', 'aria-current': String(l.id) === String(S.lessonId) ? 'true' : null }),
          btn('▲', function () { if (li > 0) reorderLessons(m.id, li, li - 1); }, { cls: 'ico', 'aria-label': 'Move lesson ' + m.position + '.' + l.position + ' up', disabled: li === 0, 'data-w': 1 }),
          btn('▼', function () { if (li < ls.length - 1) reorderLessons(m.id, li, li + 1); }, { cls: 'ico', 'aria-label': 'Move lesson ' + m.position + '.' + l.position + ' down', disabled: li === ls.length - 1, 'data-w': 1 })]);
        lbox.appendChild(row);
      });
      if (!ls.length) lbox.appendChild(el('p', { cls: 'hint', style: 'padding:4px 8px', text: 'No lessons yet.' }));
      var addL = btn('+ Lesson', function () { addL.replaceWith(inlineForm([{ label: 'Lesson title', max: 200, required: true }, { label: 'Minutes', type: 'number', min: 1, maxv: 30, value: 12 }], 'Add lesson', function (vals) { write({ action: 'create_lesson', module_id: m.id, title: vals[0], est_minutes: Number(vals[1]) || 12 }, 'Lesson added.'); }, renderOutline)); }, { 'data-w': 1, style: 'margin:4px' });
      lbox.appendChild(addL); box.appendChild(lbox); list.appendChild(box);
      sortable(lbox, '.row', function (f, t) { reorderLessons(m.id, f, t); });
    });
    card.appendChild(list);
    sortable(list, '.mod', reorderModules);
    var addM = btn('+ Module', function () { addM.replaceWith(inlineForm([{ label: 'Module title', max: 200, required: true }], 'Add module', function (vals) { write({ action: 'create_module', version_id: VERSION, title: vals[0], objectives: [] }, 'Module added.'); }, renderOutline)); }, { 'data-w': 1 });
    card.appendChild(addM);
    p.appendChild(card);
    if (!editable()) lockInputs(p);
  }
  function renderSaveBar(text) {
    var b = $('#saveBar'); if (!b) return;
    b.replaceChildren(el('span', { cls: 'grow small ' + (S.dirty ? '' : 'muted'), text: text || (S.dirty ? 'Unsaved changes' : 'All changes saved') }),
      btn('Discard changes', function () { var l = lessonById(S.lessonId); S.blocks = loadBlocks(l.blocks); S.dirty = false; S.sel = Math.min(S.sel, S.blocks.length - 1); renderEdit(); renderSaveBar(); schedulePreview(0); }, { cls: 'warn', disabled: !S.dirty || S.busy, 'data-w': 1 }),
      btn('Save lesson', save, { cls: 'pri', disabled: !S.dirty || S.busy || !editable(), 'data-w': 1 }));
  }
  function renderEdit() {
    var p = $('#pEdit'); if (!p) return; p.replaceChildren();
    var l = S.lessonId ? lessonById(S.lessonId) : null;
    if (!l) {
      p.appendChild(el('div', { cls: 'card' }, [el('h2', { text: 'Lesson screens' }), el('p', { cls: 'muted', text: modulesSorted().length ? 'Choose a lesson in the outline to edit its screens.' : 'Start by adding the first module in the outline.' })]));
      return;
    }
    var m = moduleById(l.module_id), est = l.est_content_minutes;
    var head = el('div', { cls: 'card' });
    head.appendChild(el('div', { cls: 'bar' }, [el('h2', { cls: 'grow', style: 'margin:0', text: 'Lesson ' + lessonNo(l) + ' · ' + l.title })]));
    head.appendChild(el('p', { cls: 'hint', text: 'Stated ' + l.est_minutes + ' min · the saved screens read as about ' + est + ' min. ' + (m ? 'Module ' + m.position + ': ' + m.title : '') }));
    var details = el('div', { cls: 'bar' }, [
      btn('Rename / minutes', function () { details.replaceWith(inlineForm([{ label: 'Lesson title', value: l.title, max: 200, required: true }, { label: 'Minutes', type: 'number', min: 1, maxv: 30, value: l.est_minutes }], 'Save details', function (vals) { write({ action: 'update_lesson', id: l.id, title: vals[0], est_minutes: Number(vals[1]) }, 'Lesson details saved.'); }, renderEdit)); }, { 'data-w': 1 }),
      S.confirm === 'lesson' ? btn('Confirm: remove this lesson and its screens', function () { S.confirm = null; write({ action: 'delete_lesson', id: l.id }, 'Lesson removed.'); }, { cls: 'warn', 'data-w': 1 }) : btn('Remove lesson…', function () { S.confirm = 'lesson'; renderEdit(); }, { cls: 'warn', 'data-w': 1 }),
      S.confirm === 'lesson' ? btn('Keep it', function () { S.confirm = null; renderEdit(); }) : null]);
    head.appendChild(details);
    p.appendChild(head);
    var bar = el('div', { cls: 'card sticky bar', id: 'saveBar', style: 'top:0' });
    p.appendChild(bar); renderSaveBar();
    var list = el('div', { id: 'blocks' });
    S.blocks.forEach(function (b, i) {
      var sel = i === S.sel;
      var card = el('div', { cls: 'blk' + (sel ? ' sel' : ''), 'data-i': i });
      var title = btn('', function () { S.sel = sel ? -1 : i; S.addOpen = false; placing = null; renderEdit(); if (!sel && S.player && S.player.go) try { S.player.go(i); } catch (_) { /* keep */ } focusKey('h' + i); }, { cls: 't', 'aria-expanded': String(sel), 'data-fk': 'h' + i });
      title.append(el('span', { cls: 'k', text: (i + 1) + ' · ' + KIND[b.kind].label }), el('span', { cls: 's', text: blockSummary(b) }));
      card.appendChild(el('div', { cls: 'blk-h' }, [editable() ? el('span', { cls: 'drag', 'aria-hidden': 'true', text: '⠿' }) : null, title,
        btn('▲', function () { if (i > 0) { S.blocks = moved(S.blocks, i, i - 1); S.sel = i - 1; structural('up' + (i - 1)); } }, { cls: 'ico', 'aria-label': 'Move screen ' + (i + 1) + ' up', disabled: i === 0, 'data-w': 1, 'data-fk': 'up' + i }),
        btn('▼', function () { if (i < S.blocks.length - 1) { S.blocks = moved(S.blocks, i, i + 1); S.sel = i + 1; structural('dn' + (i + 1)); } }, { cls: 'ico', 'aria-label': 'Move screen ' + (i + 1) + ' down', disabled: i === S.blocks.length - 1, 'data-w': 1, 'data-fk': 'dn' + i }),
        btn('⧉', function () { if (S.blocks.length >= 40) return; S.blocks.splice(i + 1, 0, copy(b)); S.sel = i + 1; structural('h' + (i + 1)); }, { cls: 'ico', 'aria-label': 'Duplicate screen ' + (i + 1), disabled: b.kind === 'objectives' || S.blocks.length >= 40, 'data-w': 1 }),
        S.confirm === 'b' + i ? btn('Remove?', function () { S.confirm = null; S.blocks.splice(i, 1); S.sel = Math.min(i, S.blocks.length - 1); structural(); }, { cls: 'warn', 'aria-label': 'Confirm removing screen ' + (i + 1), 'data-w': 1 })
          : btn('🗑', function () { S.confirm = 'b' + i; renderEdit(); focusKey('rm' + i); }, { cls: 'ico warn', 'aria-label': 'Remove screen ' + (i + 1), 'data-w': 1, 'data-fk': 'rm' + i })]));
      card.appendChild(el('div', { cls: 'flags', style: 'padding:0 10px 6px' }, blockIssues(b).map(function (x) { return pill(x[1], x[0]); })));
      if (sel) card.appendChild(editor(b, i));
      list.appendChild(card);
    });
    if (!S.blocks.length) list.appendChild(note('This lesson has no screens yet. Start with its objectives.'));
    p.appendChild(list);
    sortable(list, '.blk', function (f, t) { S.blocks = moved(S.blocks, f, t); S.sel = t; structural(); });
    // add a screen
    var addBox = el('div', { cls: 'card' });
    if (!S.addOpen) addBox.appendChild(btn('+ Add a screen', function () { S.addOpen = true; renderEdit(); focusKey('add-0'); }, { cls: 'pri', disabled: S.blocks.length >= 40, 'data-w': 1 }));
    else {
      addBox.appendChild(el('div', { cls: 'bar' }, [el('h3', { cls: 'grow', style: 'margin:0', text: 'Add a screen ' + (S.sel >= 0 ? 'after screen ' + (S.sel + 1) : 'at the end') }), btn('Close', function () { S.addOpen = false; renderEdit(); })]));
      var g = el('div', { cls: 'add-grid' });
      ORDER.forEach(function (k, n) {
        var has = S.blocks.some(function (b) { return b.kind === 'objectives'; });
        var b = btn('', function () {
          var nb = newBlock(k), at;
          if (k === 'objectives') at = 0; else at = S.sel >= 0 ? S.sel + 1 : S.blocks.length;
          if (at === 0 && k !== 'objectives' && S.blocks[0] && S.blocks[0].kind === 'objectives') at = 1;
          S.blocks.splice(at, 0, nb); S.sel = at; S.addOpen = false; structural('h' + at);
        }, { disabled: (k === 'objectives' && has) || S.blocks.length >= 40, 'data-w': 1, 'data-fk': 'add-' + n });
        b.append(el('span', { text: KIND[k].label }), el('small', { text: k === 'objectives' && has ? 'Already the first screen.' : KIND[k].help }));
        g.appendChild(b);
      });
      addBox.appendChild(g);
    }
    p.appendChild(addBox);
    if (!editable()) lockInputs(p);
  }
  function renderPreviewPane() {
    var p = $('#pPreview'); if (!p) return; p.replaceChildren();
    var widths = [['desktop', 'Desktop', 1240], ['phone', 'Phone 390', 390]];
    var seg = el('div', { cls: 'bar', role: 'group', 'aria-label': 'Preview width' });
    var frame = el('div', { cls: 'frame', id: 'pvFrame' }, [el('div', { id: 'player' })]);
    var setW = function (k) { S.width = k; frame.style.maxWidth = widths.filter(function (w) { return w[0] === k; })[0][2] + 'px'; Array.prototype.forEach.call(seg.children, function (b, n) { b.setAttribute('aria-pressed', String(widths[n][0] === k)); b.className = widths[n][0] === k ? 'pri' : ''; }); };
    widths.forEach(function (w) { seg.appendChild(btn(w[1], function () { setW(w[0]); })); });
    p.appendChild(el('div', { cls: 'card' }, [el('div', { cls: 'bar' }, [el('h2', { cls: 'grow', style: 'margin:0', text: 'Live preview' }), seg]), el('p', { cls: 'hint', id: 'pvStatus', text: S.lessonId ? 'Loading…' : 'Choose a lesson to preview it.' })]));
    p.appendChild(frame); setW(S.width);
    if (S.lessonId) schedulePreview(0);
  }

  /* --- Question bank --- */
  function tagsText(a) { return (a || []).join(', '); }
  function renderBank() {
    var v = $('#view'), R = S.d.readiness.bank;
    var qs = S.d.questions || [], F = S.bank;
    var top = el('div', { cls: 'card' }, [el('h2', { text: 'Question bank' }),
      el('p', { cls: 'sub', text: R.usable + ' usable exam questions (' + R.scenarios + ' customer scenarios); each attempt draws ' + R.needed + '. ' + qs.filter(function (q) { return q.use === 'practice' && q.status === 'active'; }).length + ' active practice questions for lesson checks. Answer keys are shown on this screen only.' })]);
    var filters = el('div', { cls: 'bar', style: 'margin-top:8px' });
    var mk = function (label, key, opts) { var s = el('select', { 'aria-label': label }, opts.map(function (o) { return el('option', { value: o[0], text: o[1] }); })); s.value = F[key]; s.addEventListener('change', function () { F[key] = s.value; renderBank(); }); return el('div', { style: 'min-width:150px' }, [s]); };
    filters.append(mk('Use', 'use', [['', 'Exam and practice'], ['exam', 'Exam'], ['practice', 'Practice']]),
      mk('Module', 'module', [['', 'All modules'], ['none', 'No module']].concat(modulesSorted().map(function (m) { return [m.id, 'Module ' + m.position + ' · ' + m.title]; }))),
      mk('Status', 'status', [['active', 'Active'], ['retired', 'Retired'], ['', 'All']]));
    var search = el('input', { type: 'search', placeholder: 'Search the questions', 'aria-label': 'Search the questions', value: F.q });
    search.addEventListener('input', function () { F.q = search.value; clearTimeout(search._t); search._t = setTimeout(function () { renderBank(); var s = document.querySelector('input[type=search]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 300); });
    filters.append(el('div', { cls: 'grow', style: 'min-width:180px' }, [search]), btn('+ New question', function () { S.editQ = { _new: true, use: 'exam', kind: 'single', module_id: '', prompt: '', choices: [{ id: 'a', text: '' }, { id: 'b', text: '' }, { id: 'c', text: '' }, { id: 'd', text: '' }], answer_key: 'a', explanation: '', objective_tags: [] }; renderBank(); }, { cls: 'pri', 'data-w': 1 }));
    top.appendChild(filters);
    v.replaceChildren(top);
    if (S.editQ) v.appendChild(questionForm(S.editQ));
    var fi = factIndex();
    var refsOf = function (qid) { return (S.d.refs || []).filter(function (r) { return String(r.question_id) === String(qid); }); };
    var shown = qs.filter(function (q) {
      if (F.use && q.use !== F.use) return false;
      if (F.status && q.status !== F.status) return false;
      if (F.module === 'none' && q.module_id) return false;
      if (F.module && F.module !== 'none' && String(q.module_id) !== F.module) return false;
      if (F.q && (q.prompt + ' ' + (q.choices || []).map(function (c) { return c.text; }).join(' ')).toLowerCase().indexOf(F.q.toLowerCase()) < 0) return false;
      return true;
    }).sort(function (a, b) { var ma = moduleById(a.module_id), mb = moduleById(b.module_id); return ((ma ? ma.position : 99) - (mb ? mb.position : 99)) || (a.use < b.use ? -1 : a.use > b.use ? 1 : 0); });
    var list = el('div');
    if (!shown.length) list.appendChild(el('div', { cls: 'card' }, [el('p', { cls: 'muted', text: qs.length ? 'No questions match these filters.' : 'No questions yet. Add the first one.' })]));
    shown.forEach(function (q) {
      var mod = moduleById(q.module_id), refs = refsOf(q.id);
      var unverified = refs.some(function (r) { var f = fi[factKey(r.manufacturer_slug, r.model_code, r.field)]; return !f || f.status !== 'verified'; });
      var keys = [].concat(q.answer_key);
      var card = el('div', { cls: 'q' }, [
        el('div', { cls: 'flags' }, [pill(q.use === 'exam' ? 'Exam' : 'Practice', q.use === 'exam' ? '' : 'ok'), pill({ single: 'One answer', multi: 'Several answers', scenario: 'Scenario' }[q.kind] || q.kind),
          pill(mod ? 'Module ' + mod.position : 'No module', mod ? '' : (q.use === 'exam' ? 'bad' : 'adv')), q.status === 'retired' ? pill('Retired', 'adv') : null,
          refs.length ? pill(refs.length + ' fact link' + (refs.length > 1 ? 's' : ''), unverified ? 'bad' : 'ok') : null,
          unverified && q.use === 'exam' ? pill('Fact not verified — not drawn', 'bad') : null]),
        el('p', { style: 'margin:8px 0;font-weight:700', text: q.prompt }),
        el('ul', { style: 'margin:0 0 6px 18px;padding:0' }, (q.choices || []).map(function (c) { var ok = keys.indexOf(c.id) >= 0; return el('li', { style: ok ? 'font-weight:700;color:var(--b-green)' : null, text: c.id.toUpperCase() + '. ' + c.text + (ok ? '  ✓ correct' : '') }); })),
        el('p', { cls: 'small muted', style: 'margin:4px 0', text: 'Explanation: ' + q.explanation }),
        el('p', { cls: 'small muted', style: 'margin:4px 0', text: 'Topics: ' + tagsText(q.objective_tags) }),
        el('div', { cls: 'bar', style: 'margin-top:6px' }, [
          btn('Edit', function () { S.editQ = copy(q); renderBank(); window.scrollTo(0, 0); }, { 'data-w': 1 }),
          q.status === 'active' ? btn('Retire…', function () { retireForm(card, q); }, { cls: 'warn', 'data-w': 1 }) : btn('Restore', function () { write({ action: 'question_status', id: q.id, status: 'active' }, 'Question restored.'); }, { 'data-w': 1 })])]);
      list.appendChild(card);
    });
    v.appendChild(list);
    if (!editable()) lockInputs(v);
  }
  function retireForm(card, q) {
    var f = inlineForm([{ label: 'Why is it retired?', max: 500, required: true }], 'Retire question', function (vals) { if (!vals[0]) return; write({ action: 'question_status', id: q.id, status: 'retired', reason: vals[0] }, 'Question retired.'); }, renderBank);
    card.appendChild(f);
  }
  function questionForm(q) {
    var box = el('div', { cls: 'card' }, [el('h2', { text: q._new ? 'New question' : 'Edit question' })]);
    var useG = el('div', { cls: 'bar', role: 'radiogroup', 'aria-label': 'Use' });
    [['exam', 'Exam question'], ['practice', 'Practice (lesson check)']].forEach(function (x) { useG.appendChild(btn(x[1], function () { q.use = x[0]; renderBank(); }, { role: 'radio', 'aria-checked': String(q.use === x[0]), cls: q.use === x[0] ? 'pri' : '', 'data-w': 1 })); });
    box.appendChild(el('label', { cls: 'f', text: 'Use' })); box.appendChild(useG);
    box.appendChild(fSelect('Kind', q, 'kind', [['single', 'One correct answer'], ['multi', 'Several correct answers'], ['scenario', 'Customer scenario (one best answer)']], { onchange: function () { q.answer_key = q.kind === 'multi' ? [].concat(q.answer_key || []).slice(0, 1) : [].concat(q.answer_key || ['a'])[0]; renderBank(); } }));
    box.appendChild(fSelect('Module', q, 'module_id', [['', q.use === 'exam' ? '— choose (exam questions need a module) —' : 'No module']].concat(modulesSorted().map(function (m) { return [m.id, 'Module ' + m.position + ' · ' + m.title]; })), { onchange: function () {} }));
    box.appendChild(fText(q.kind === 'scenario' ? 'The situation and question' : 'Question', q, 'prompt', { max: 2000, multiline: true, onchange: function () {} }));
    box.appendChild(el('label', { cls: 'f', text: 'Choices (2–6) — mark the correct ' + (q.kind === 'multi' ? 'ones' : 'one') }));
    var keys = [].concat(q.answer_key || []);
    var gname = 'ans' + (++fkCounter);
    q.choices.forEach(function (c, k) {
      var mark = el('input', { type: q.kind === 'multi' ? 'checkbox' : 'radio', name: gname, checked: keys.indexOf(c.id) >= 0, 'aria-label': 'Choice ' + c.id.toUpperCase() + ' is correct' });
      mark.addEventListener('change', function () {
        if (q.kind === 'multi') { var a = [].concat(q.answer_key || []).filter(function (x) { return x !== c.id; }); if (mark.checked) a.push(c.id); q.answer_key = a.sort(); }
        else q.answer_key = c.id;
      });
      var t = el('input', { type: 'text', maxlength: 500, 'aria-label': 'Choice ' + c.id.toUpperCase(), value: c.text });
      t.addEventListener('input', function () { c.text = t.value; });
      box.appendChild(el('div', { cls: 'bar', style: 'margin-bottom:6px' }, [el('label', { cls: 'bar', style: 'min-height:44px;min-width:60px;font-weight:700' }, [mark, ' ' + c.id.toUpperCase()]), el('div', { cls: 'grow' }, [t]),
        btn('×', function () { q.choices.splice(k, 1); q.choices.forEach(function (x, n) { var old = x.id; x.id = 'abcdef'.charAt(n); if (q.kind === 'multi') q.answer_key = [].concat(q.answer_key).map(function (y) { return y === old ? x.id : y; }); else if (q.answer_key === old) q.answer_key = x.id; }); if (q.kind === 'multi') q.answer_key = [].concat(q.answer_key).filter(function (y) { return q.choices.some(function (x) { return x.id === y; }); }); else if (!q.choices.some(function (x) { return x.id === q.answer_key; })) q.answer_key = 'a'; renderBank(); }, { cls: 'ico warn', 'aria-label': 'Remove choice ' + c.id.toUpperCase(), disabled: q.choices.length <= 2, 'data-w': 1 })]));
    });
    box.appendChild(btn('+ Add choice', function () { q.choices.push({ id: 'abcdef'.charAt(q.choices.length), text: '' }); renderBank(); }, { disabled: q.choices.length >= 6, 'data-w': 1 }));
    box.appendChild(fText('Explanation (shown after answering a practice question; staff only for exam questions)', q, 'explanation', { max: 2000, multiline: true, onchange: function () {} }));
    var tg = { v: tagsText(q.objective_tags) };
    box.appendChild(fText('Topics (1–10, comma separated, e.g. comfort-zones, weight-capacity)', tg, 'v', { max: 600, onchange: function () { q.objective_tags = tg.v.split(',').map(function (s) { return s.trim().toLowerCase().replace(/\s+/g, '-'); }).filter(Boolean); } }));
    // fact links (saved questions only)
    if (!q._new) {
      var refs = (S.d.refs || []).filter(function (r) { return String(r.question_id) === String(q.id); }), fi = factIndex();
      box.appendChild(el('h3', { text: 'Product facts this question depends on' }));
      box.appendChild(el('p', { cls: 'hint', text: 'An exam question is drawn only while every fact it depends on is recorded and verified.' }));
      refs.forEach(function (r) {
        var f = r.field ? fi[factKey(r.manufacturer_slug, r.model_code, r.field)] : null;
        box.appendChild(el('div', { cls: 'bar', style: 'margin-bottom:4px' }, [el('span', { cls: 'grow', text: mfrName(r.manufacturer_slug) + ' · ' + r.model_code + (r.field ? ' · ' + r.field : ' (whole model)') }),
          r.field ? pill(!f ? 'Not recorded' : f.status === 'verified' ? 'Verified' : 'Awaiting confirmation', !f ? 'bad' : f.status === 'verified' ? 'ok' : 'adv') : null,
          btn('Unlink', function () { write({ action: 'unlink_fact', id: r.id }, 'Fact link removed.'); }, { cls: 'warn', 'data-w': 1 })]));
      });
      var link = { manufacturer_slug: courseMfr(), model_code: '', field: '' };
      var row = el('div', { cls: 'sub-card' }, [fSelect('Manufacturer', link, 'manufacturer_slug', mfrOptions(), { onchange: function () {} }),
        fText('Model', link, 'model_code', { max: 40, upper: true, list: modelsOf(courseMfr()), onchange: function () {} }),
        fText('Specification (optional; blank = the whole model)', link, 'field', { max: 60, list: fieldsOf(courseMfr()), onchange: function () {} }),
        btn('Link fact', function () { if (!link.model_code) { toast('Enter the model code.', true); return; } var body = { action: 'link_question_fact', question_id: q.id, manufacturer_slug: link.manufacturer_slug, model_code: link.model_code }; if (link.field) body.field = link.field; write(body, 'Fact linked.'); }, { 'data-w': 1, style: 'margin-top:8px' })]);
      box.appendChild(row);
    }
    box.appendChild(el('div', { cls: 'bar', style: 'margin-top:12px' }, [btn(q._new ? 'Create question' : 'Save question', function () {
      var payload = { module_id: q.module_id || null, kind: q.kind, use: q.use, prompt: q.prompt, choices: q.choices.map(function (c) { return { id: c.id, text: c.text }; }), answer_key: q.answer_key, explanation: q.explanation, objective_tags: q.objective_tags };
      var body = q._new ? { action: 'create_question', version_id: VERSION, question: payload } : { action: 'update_question', id: q.id, changes: payload };
      api(body).then(function (r) {
        if (r.status !== 200) { toast(msgOf(r, 'The question could not be saved.'), true); return; }
        S.editQ = null; toast(q._new ? 'Question created.' : 'Question saved.'); refreshData();
      });
    }, { cls: 'pri', 'data-w': 1 }), btn('Cancel', function () { S.editQ = null; renderBank(); })]));
    return box;
  }

  /* --- Exam distribution --- */
  function renderDist() {
    var v = $('#view'), R = S.d.readiness.bank, mods = modulesSorted();
    var setMode = mods.some(function (m) { return m.exam_quota != null; });
    var draft = {}; mods.forEach(function (m) { draft[m.id] = m.exam_quota != null ? m.exam_quota : ''; });
    var state = { mode: setMode ? 'set' : 'auto' };
    var card = el('div', { cls: 'card' }, [el('h2', { text: 'Exam distribution' }),
      el('p', { cls: 'sub', text: 'Each attempt draws ' + R.needed + ' questions at random from the active, verified exam questions, and every module is represented. Choose automatic spreading, or set how many questions each module gives.' })]);
    var g = el('div', { cls: 'bar', role: 'radiogroup', 'aria-label': 'Distribution' });
    var body = el('div');
    var draw = function () {
      g.replaceChildren(); [['auto', 'Automatic'], ['set', 'Set per module']].forEach(function (x) { g.appendChild(btn(x[1], function () { state.mode = x[0]; draw(); }, { role: 'radio', 'aria-checked': String(state.mode === x[0]), cls: state.mode === x[0] ? 'pri' : '', 'data-w': 1 })); });
      body.replaceChildren();
      var t = el('table', { cls: 'cmp', style: 'margin-top:10px' }, [el('thead', null, el('tr', null, [el('th', { text: 'Module' }), el('th', { text: 'Usable exam questions' }), el('th', { text: state.mode === 'set' ? 'Questions per attempt' : '' })]))]);
      var tb = el('tbody'); var sumEl = el('b');
      var sum = function () { return mods.reduce(function (a, m) { return a + (Number(draft[m.id]) || 0); }, 0); };
      mods.forEach(function (m) {
        var have = R.per_module[String(m.id)] || 0, cell = el('td');
        if (state.mode === 'set') {
          var inp = el('input', { type: 'number', min: 1, max: 200, value: draft[m.id], 'aria-label': 'Questions from module ' + m.position, style: 'max-width:120px' });
          inp.addEventListener('input', function () { draft[m.id] = inp.value === '' ? '' : Math.floor(Number(inp.value)); sumEl.textContent = sum() + ' of ' + R.needed; flag(); });
          cell.appendChild(inp);
        }
        tb.appendChild(el('tr', null, [el('td', { text: m.position + '. ' + m.title }), el('td', { cls: have ? '' : 'miss', text: String(have) }), cell]));
      });
      t.appendChild(tb); body.appendChild(el('div', { cls: 'grid-wrap' }, t));
      var msg = el('div');
      var flag = function () {
        msg.replaceChildren();
        if (state.mode !== 'set') return;
        var s = sum();
        if (mods.some(function (m) { return !(Number(draft[m.id]) >= 1); })) msg.appendChild(note('Every module gives at least 1 question.', 'err'));
        else if (s !== R.needed) msg.appendChild(note('The modules add up to ' + s + '; each attempt draws ' + R.needed + '.', 'err'));
        mods.forEach(function (m) { if (Number(draft[m.id]) > (R.per_module[String(m.id)] || 0)) msg.appendChild(note('Module ' + m.position + ' gives ' + draft[m.id] + ' but has ' + (R.per_module[String(m.id)] || 0) + ' usable questions. You can save it; the course is not ready until the bank catches up.')); });
      };
      if (state.mode === 'set') { sumEl.textContent = sum() + ' of ' + R.needed; body.appendChild(el('p', null, ['Total: ', sumEl])); }
      body.appendChild(msg); flag();
      body.appendChild(btn('Save distribution', function () {
        var quotas = null;
        if (state.mode === 'set') { quotas = {}; mods.forEach(function (m) { quotas[m.id] = Number(draft[m.id]); }); }
        write({ action: 'set_distribution', version_id: VERSION, quotas: quotas }, 'Distribution saved.');
      }, { cls: 'pri', 'data-w': 1, style: 'margin-top:10px' }));
      if (!editable()) lockInputs(card);
    };
    card.append(g, body); v.replaceChildren(card); draw();
    if (!mods.length) card.appendChild(note('Add modules first.'));
  }

  /* --- Pictures & media --- */
  function bytes(n) { return n == null ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function renderMedia() {
    var v = $('#view'); v.replaceChildren(el('div', { cls: 'card' }, [el('p', { cls: 'muted', text: 'Loading pictures and media…' })]));
    api({ action: 'media_library' }).then(function (r) {
      if (S.tab !== 'media') return;
      if (r.status !== 200) { v.replaceChildren(note(msgOf(r, 'The media library could not be loaded.'), 'err')); return; }
      S.lib = r.body; drawMedia();
    });
  }
  function drawMedia() {
    var v = $('#view'), L = S.lib, pres = president();
    v.replaceChildren();
    // upload
    var up = el('div', { cls: 'card' }, [el('h2', { text: 'Add a picture or document' }),
      el('p', { cls: 'sub', text: 'JPEG, PNG or WebP pictures, or PDF documents, up to 3 MB. Files are stored privately and cannot be used in a lesson until the President approves them' + (pres ? ' (you).' : '.') + ' No Golden photography is added without the President approving the specific file.' })]);
    var file = el('input', { type: 'file', accept: '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf', 'aria-label': 'File to upload' });
    var folder = { v: '' };
    var sel = fSelect('Whose file is it?', folder, 'v', [['', 'HCPS']].concat(mfrOptions()), { onchange: function () {} });
    var status = el('p', { cls: 'hint', role: 'status' });
    var go1 = btn('Upload', function () {
      var f = file.files && file.files[0]; if (!f) { status.textContent = 'Choose a file first.'; return; }
      if (f.size > 3 * 1024 * 1024) { status.textContent = 'That file is ' + bytes(f.size) + '; the limit is 3 MB. Export a smaller version.'; return; }
      status.textContent = 'Uploading…'; go1.disabled = true;
      var rd = new FileReader();
      rd.onload = function () {
        var data = String(rd.result).split(',')[1] || '';
        var body = { action: 'upload_media', file_name: f.name, data: data }; if (folder.v) body.manufacturer_slug = folder.v;
        api(body, { 'x-academy-upload': '1' }).then(function (x) {
          go1.disabled = false;
          if (x.status !== 200) { status.textContent = msgOf(x, 'The file could not be uploaded.'); return; }
          toast(x.body.note || 'Uploaded.'); renderMedia();
        });
      };
      rd.onerror = function () { go1.disabled = false; status.textContent = 'The file could not be read.'; };
      rd.readAsDataURL(f);
    }, { cls: 'pri' });
    up.append(field('File', file), sel, el('div', { cls: 'bar', style: 'margin-top:10px' }, [go1]), status);
    v.appendChild(up);
    // waiting for approval
    var wait = el('div', { cls: 'card' }, [el('h2', { text: 'Waiting for the President’s approval (' + L.candidates.length + ')' })]);
    if (!L.candidates.length) wait.appendChild(el('p', { cls: 'muted', text: 'Nothing is waiting.' }));
    L.candidates.forEach(function (c) {
      var item = el('div', { cls: 'q' });
      item.appendChild(el('div', { cls: 'bar' }, [c.kind === 'image' && c.preview_url ? el('img', { src: c.preview_url, alt: '', style: 'width:180px;max-width:100%;border-radius:8px;background:#eef1f5' }) : pill(c.kind === 'pdf' ? 'PDF document' : 'Picture'),
        el('div', { cls: 'grow small' }, [el('div', { text: c.storage_path, style: 'overflow-wrap:anywhere' }), el('div', { cls: 'muted', text: (c.folder === 'hcps' ? 'HCPS' : mfrName(c.folder)) + ' · ' + bytes(c.size) + (c.created_at ? ' · uploaded ' + String(c.created_at).slice(0, 10) : '') }),
          c.preview_url ? el('a', { href: c.preview_url, target: '_blank', rel: 'noopener', text: 'Open the file (link valid 10 minutes)' }) : null])]));
      if (pres) item.appendChild(approveForm(c)); else item.appendChild(el('p', { cls: 'hint', text: 'Waiting for the President to approve or discard it.' }));
      wait.appendChild(item);
    });
    v.appendChild(wait);
    // video / link
    var lk = { kind: 'video', url: '', title: '', rights: 'link_only', manufacturer_slug: '', permission_ref: '' };
    var lc = el('div', { cls: 'card' }, [el('h2', { text: 'Add a video or a link' }), el('p', { cls: 'sub', text: 'Videos are embed links from youtube-nocookie.com/embed/… or player.vimeo.com/video/…. Links are never copied to HCPS storage.' }),
      fSelect('Kind', lk, 'kind', [['video', 'Video'], ['link', 'Web page'], ['pdf', 'PDF on the web']], { onchange: function () {} }),
      fText('Link (https)', lk, 'url', { type: 'url', max: 1000, onchange: function () {} }),
      fText('Title / description', lk, 'title', { max: 300, onchange: function () {} }),
      fSelect('Rights', lk, 'rights', [['link_only', 'Link only (not hosted by HCPS)'], ['manufacturer_permitted', 'Manufacturer permitted']], { onchange: function () {} }),
      fSelect('Manufacturer (optional)', lk, 'manufacturer_slug', [['', '—']].concat(mfrOptions()), { onchange: function () {} }),
      fText('Permission (needed for “manufacturer permitted”)', lk, 'permission_ref', { max: 300, onchange: function () {} }),
      btn('Add', function () { var body = { action: 'add_link_media', kind: lk.kind, url: lk.url, title: lk.title, rights: lk.rights }; if (lk.manufacturer_slug) body.manufacturer_slug = lk.manufacturer_slug; if (lk.permission_ref) body.permission_ref = lk.permission_ref; api(body).then(function (x) { if (x.status !== 200) { toast(msgOf(x), true); return; } toast('Added.'); refreshData().then(renderMedia); }); }, { cls: 'pri', style: 'margin-top:10px' })]);
    v.appendChild(lc);
    // approved library
    var lib = el('div', { cls: 'card' }, [el('h2', { text: 'Approved pictures, videos and documents (' + L.records.length + ')' })]);
    if (!L.records.length) lib.appendChild(el('p', { cls: 'muted', text: 'None yet.' }));
    L.records.forEach(function (m) {
      var stored = !!m.storage_path, canEdit = !stored || pres;
      var row = el('div', { cls: 'q bar' }, [m.kind === 'image' && m.signed_url ? el('img', { src: m.signed_url, alt: '', style: 'width:120px;border-radius:8px' }) : pill({ image: 'Picture', video: 'Video', pdf: 'PDF', link: 'Link' }[m.kind] || m.kind),
        el('div', { cls: 'grow small' }, [el('div', { style: 'font-weight:700;overflow-wrap:anywhere', text: m.alt_text ? m.alt_text : (m.kind === 'image' ? 'Decorative (no alt text)' : '(no title)') }),
          el('div', { cls: 'muted', style: 'overflow-wrap:anywhere', text: ({ hcps_owned: 'HCPS owned', manufacturer_permitted: 'Manufacturer permitted', link_only: 'Link only' }[m.rights] || m.rights) + (m.manufacturer_slug ? ' · ' + mfrName(m.manufacturer_slug) : '') + (m.permission_ref ? ' · permission: ' + m.permission_ref : '') + ' · ' + (m.external_url || m.storage_path) })]),
        canEdit ? btn('Edit text', function () { row.appendChild(inlineForm([{ label: m.kind === 'image' ? 'Alt text (blank = decorative)' : 'Title', value: m.alt_text || '', max: 300 }], 'Save', function (vals) { api({ action: 'update_media', id: m.id, alt_text: vals[0] }).then(function (x) { if (x.status !== 200) { toast(msgOf(x), true); return; } toast('Saved.'); refreshData().then(renderMedia); }); }, drawMedia)); }) : null,
        canEdit ? btn('Remove…', function () { row.appendChild(el('div', { cls: 'note' }, ['Remove this record? It is refused while a lesson uses it. ', btn('Remove', function () { api({ action: 'delete_media', id: m.id }).then(function (x) { if (x.status !== 200) { toast(msgOf(x), true); return; } toast('Removed.'); refreshData().then(renderMedia); }); }, { cls: 'warn' })])); }, { cls: 'warn' }) : null]);
      lib.appendChild(row);
    });
    v.appendChild(lib);
  }
  function approveForm(c) {
    var a = { rights: 'manufacturer_permitted', decorative: false, alt_text: '', manufacturer_slug: c.folder === 'hcps' ? '' : c.folder, permission_ref: '' };
    var box = el('div', { cls: 'sub-card' }, [el('b', { text: 'Approve for lessons' })]);
    var draw = function () {
      box.replaceChildren(el('b', { text: 'Approve for lessons' }));
      box.appendChild(fSelect('Rights', a, 'rights', [['hcps_owned', 'HCPS owned'], ['manufacturer_permitted', 'Manufacturer permitted (e.g. approved Golden photography)']], { onchange: draw }));
      if (c.kind === 'image') {
        var dec = el('input', { type: 'checkbox', checked: a.decorative, id: 'dec' + (++fkCounter) });
        dec.addEventListener('change', function () { a.decorative = dec.checked; draw(); });
        box.appendChild(el('label', { for: dec.id, cls: 'bar', style: 'min-height:44px;font-size:13px' }, [dec, ' Decorative only (hidden from screen readers)']));
        if (!a.decorative) box.appendChild(fText('Alt text — what the picture shows (10–300 characters)', a, 'alt_text', { max: 300, onchange: function () {} }));
      } else box.appendChild(fText('Document title', a, 'alt_text', { max: 300, onchange: function () {} }));
      if (a.rights === 'manufacturer_permitted') {
        box.appendChild(fSelect('Manufacturer', a, 'manufacturer_slug', [['', '— choose —']].concat(mfrOptions()), { onchange: function () {} }));
        box.appendChild(fText('Permission (e.g. “Golden confirmation 10 Oct 2026: approved photography”)', a, 'permission_ref', { max: 300, onchange: function () {} }));
      }
      box.appendChild(el('div', { cls: 'bar', style: 'margin-top:10px' }, [
        btn('Approve', function () { var body = { action: 'approve_media', storage_path: c.storage_path, rights: a.rights, decorative: a.decorative, alt_text: a.alt_text }; if (a.rights === 'manufacturer_permitted') { body.manufacturer_slug = a.manufacturer_slug; body.permission_ref = a.permission_ref; } api(body).then(function (x) { if (x.status !== 200) { toast(msgOf(x), true); return; } toast('Approved — it can now be used in lessons.'); refreshData().then(renderMedia); }); }, { cls: 'pri' }),
        btn('Discard…', function () { box.appendChild(inlineForm([{ label: 'Why is it discarded?', max: 300, required: true }], 'Discard file', function (vals) { api({ action: 'discard_upload', storage_path: c.storage_path, reason: vals[0] }).then(function (x) { if (x.status !== 200) { toast(msgOf(x), true); return; } toast('Discarded.'); renderMedia(); }); }, draw)); }, { cls: 'warn' })]));
    };
    draw();
    return box;
  }

  /* --- Readiness --- */
  function renderReady() {
    var v = $('#view'), R = S.d.readiness;
    var card = el('div', { cls: 'card' }, [el('h2', { text: R.ready ? 'Ready for review' : 'Not ready yet' }),
      el('p', { cls: 'sub', text: R.ready ? 'Nothing blocks this version. The President still reviews and publishes it; the suggestions below are optional.' : R.counts.blocking + ' item(s) must be fixed before this version can be submitted and published. Missing pictures, unconfirmed facts and incomplete content are listed here; the database refuses to publish them anyway.' }),
      el('p', { cls: 'sub', text: 'Exam bank: ' + R.bank.usable + ' usable of ' + R.bank.exam_active + ' active exam questions; ' + R.bank.needed + ' per attempt; distribution ' + (R.bank.mode === 'set' ? 'set per module' : 'automatic') + '.' })]);
    v.replaceChildren(card);
    [['blocking', 'Must fix'], ['advice', 'Suggestions']].forEach(function (lv) {
      var items = R.items.filter(function (x) { return x.level === lv[0]; });
      var c = el('div', { cls: 'card' }, [el('h2', { text: lv[1] + ' (' + items.length + ')' })]);
      if (!items.length) c.appendChild(el('p', { cls: 'muted', text: 'None.' }));
      items.forEach(function (x) {
        var open = null;
        if (x.lesson_id) open = btn('Open lesson', function () { S.tab = 'lessons'; guard(function () { selectLesson(x.lesson_id); renderTabs(); }); });
        else if (x.question_id) open = btn('Open question', function () { var q = (S.d.questions || []).filter(function (y) { return y.id === x.question_id; })[0]; if (q) S.editQ = copy(q); go('bank'); });
        else if (/distribution/i.test(x.where) || x.module_id) open = btn('Open distribution', function () { go('dist'); });
        else if (/bank/i.test(x.where)) open = btn('Open question bank', function () { go('bank'); });
        c.appendChild(el('div', { cls: 'ready-item' }, [pill(lv[0] === 'blocking' ? 'Fix' : 'Tip', lv[0] === 'blocking' ? 'bad' : 'adv'), el('div', { cls: 'grow' }, [el('b', { text: x.where }), el('br'), x.message]), open]));
      });
      v.appendChild(c);
    });
  }

  /* ------------------------------------------------------------------ start */
  function gate(msg) {
    var g = $('#gate'); g.replaceChildren(); var box = el('div', { cls: 'gate' });
    var em = el('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', 'aria-label': 'Email' });
    var pw = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
    var er = el('p', { cls: 'muted', text: msg || '' });
    var go2 = function () {
      er.textContent = 'Signing in…';
      fetch('/.netlify/functions/staff-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login', email: em.value.trim(), password: pw.value }) })
        .then(function (r) { return r.json(); }).then(function (j) { if (!j || !j.ok) { er.textContent = (j && j.message) || 'Could not sign in.'; return; } HCPS.setSession(j); TOKEN = j.token; g.replaceChildren(); boot(); })
        .catch(function () { er.textContent = 'Could not reach the server. Try again.'; });
    };
    var b = btn('Sign in', go2, { cls: 'pri' });
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') go2(); });
    box.append(el('h2', { text: 'Staff sign-in' }), em, pw, b, er); g.appendChild(box); em.focus();
  }
  function fail(text) { $('#app').hidden = false; $('#view').replaceChildren(note(text, 'err')); }
  function boot() {
    if (!VERSION) { fail('No course version was chosen. Open the builder from a version in the Academy Command Center.'); return; }
    api({ action: 'whoami' }).then(function (r) {
      var w = r.body || {}; S.who = w;
      if (r.status !== 200) { fail(msgOf(r, 'Not available.')); return; }
      if (!w.may || !w.may.administer) { fail('The course builder is limited to the President and HCPS administrators.'); return; }
      if (!w.enabled) { fail('The Academy Command Center is switched off, so the course builder is not available.'); return; }
      $('#app').hidden = false;
      var h = (location.hash || '').replace(/^#/, '').split('/');
      if (TABS.some(function (t) { return t[0] === h[0]; })) S.tab = h[0];
      return refreshData().then(function () {
        if (!S.d) { fail('The course could not be loaded.'); return; }
        renderTabs();
        if (S.tab === 'lessons' && UUID.test(h[1] || '') && lessonById(h[1])) selectLesson(h[1]);
      });
    });
  }
  if (!TOKEN) gate(); else boot();
  window.__builder = { state: S, clean: clean, loadBlocks: loadBlocks, blockIssues: blockIssues };
})();
