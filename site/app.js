/* Kindle-style scroll reader — vanilla JS, no build step. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const BOOK_ID = 'laws-of-human-nature';
  const KEY = (k) => `reader:${BOOK_ID}:${k}`;
  const CHARS_PER_LOC = 128;        // Kindle "locations" are ~128 bytes
  const DEFAULT_WPM = 230;

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(KEY(k), JSON.stringify(v)); } catch { /* quota */ } },
    del(k) { localStorage.removeItem(KEY(k)); },
  };

  const DEFAULT_SETTINGS = {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    fontSize: 18, font: 'literata', lineHeight: '1.65', margin: 'normal', align: 'left',
    brightness: 100, tapZones: false, hyphens: true, bold: false, keepAwake: false,
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  let bookmarks = store.get('bookmarks', []);     // {id, block, excerpt, created, pct}
  let highlights = store.get('highlights', []);   // {id, group, block, start, end, color, text, note, created}
  let stats = store.get('stats', { ms: 0, chars: 0, sessions: 0, wpm: DEFAULT_WPM, maxPct: 0, firstOpened: Date.now() });
  let position = store.get('position', null);    // {block, frac}

  // ---------------------------------------------------------------- dom refs
  const content = $('#content');
  const reader = $('#reader');
  const scrubber = $('#scrubber');
  const infoLeft = $('#info-left'), infoMid = $('#info-mid'), infoRight = $('#info-right');
  const barChapter = $('#bar-chapter');
  const ribbon = $('#bookmark-ribbon');
  const selPop = $('#sel-pop');
  const definePop = $('#define-pop');
  const toastEl = $('#toast');

  // ---------------------------------------------------------------- book model
  let meta = null;
  let sectionsData = [];
  let blocks = [];        // [{id, el, sec, start, chars, text}]
  let blockById = new Map();
  let sectionStart = [];  // cumulative chars at section start
  let blockTops = null;   // cached offsetTop for binary search
  let totalChars = 1;
  let anchor = { index: 0, frac: 0 };  // current reading anchor (block index + fraction within)
  let chromeHidden = false;
  let suppressScroll = 0;
  let backPos = null;

  // ---------------------------------------------------------------- utilities
  function toast(msg, ms = 1800) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (toastEl.hidden = true), ms);
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const topOffset = () => 56 + safeTop();
  function safeTop() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--safe-top');
    const n = parseFloat(v); return isNaN(n) ? 0 : n;
  }
  function fmtMin(min) {
    if (!isFinite(min) || min < 0) return '';
    if (min < 1) return 'less than a minute';
    if (min < 60) return `${Math.round(min)} min`;
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  function sectionTitle(sec, withNum = true) {
    if (sec.kind === 'chapter') return (withNum ? `${sec.number}. ` : '') + sec.title;
    return sec.title;
  }

  // ---------------------------------------------------------------- settings
  function applySettings(keepPlace = true) {
    const run = () => {
      const h = document.documentElement;
      h.dataset.theme = settings.theme;
      h.dataset.font = settings.font;
      h.dataset.margin = settings.margin;
      h.style.setProperty('--font-size', settings.fontSize + 'px');
      h.style.setProperty('--line-height', settings.lineHeight);
      h.style.setProperty('--align', settings.align);
      h.style.setProperty('--hyphens', settings.hyphens ? 'auto' : 'manual');
      h.style.setProperty('--weight', settings.bold ? '600' : '400');
      $('#dimmer').style.opacity = String((100 - settings.brightness) / 100 * 0.85);
      const bg = getComputedStyle(h).getPropertyValue('--bg').trim();
      $('#theme-color').setAttribute('content', bg);
      // reflect in UI
      $$('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === settings.theme));
      $$('#font-seg button').forEach((b) => b.classList.toggle('active', b.dataset.font === settings.font));
      $$('#lh-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lh === String(settings.lineHeight)));
      $$('#margin-seg button').forEach((b) => b.classList.toggle('active', b.dataset.margin === settings.margin));
      $$('#align-seg button').forEach((b) => b.classList.toggle('active', b.dataset.align === settings.align));
      $('#font-val').textContent = settings.fontSize;
      $('#brightness').value = settings.brightness;
      $('#opt-tapzones').checked = settings.tapZones;
      $('#opt-hyphens').checked = settings.hyphens;
      $('#opt-bold').checked = settings.bold;
      $('#opt-keepawake').checked = settings.keepAwake;
    };
    if (keepPlace && blocks.length) keepAnchor(run); else run();
    store.set('settings', settings);
    updateWakeLock();
  }

  // ---------------------------------------------------------------- loading
  async function loadBook() {
    meta = await (await fetch('book/meta.json')).json();
    document.title = `${meta.title} — Reader`;
    $('#bar-book').textContent = meta.title;
    sectionsData = await Promise.all(meta.sections.map((s) => fetch('book/' + s.file).then((r) => r.json())));
    render();
  }

  function render() {
    const frag = document.createDocumentFragment();
    let cum = 0;
    totalChars = Math.max(1, meta.totalChars);
    blocks = []; blockById = new Map(); sectionStart = [];
    sectionsData.forEach((sec, si) => {
      sectionStart.push(cum);
      const el = document.createElement('section');
      el.className = `sec ${sec.kind}`;
      el.id = sec.id;
      el.dataset.si = si;
      if (sec.kind === 'cover') {
        const b = sec.blocks[0];
        el.innerHTML = `<img class="page-img" src="book/${b.src}" width="${b.w}" height="${b.h}" alt="${esc(b.alt || '')}" fetchpriority="high">
          <div class="cover-hint"><span>Scroll down to begin reading</span><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
          ${position && position.block && position.block !== '0-0' ? '<button class="chip" id="btn-continue">Continue where you left off</button>' : ''}</div>`;
      } else if (sec.kind === 'chapter') {
        el.innerHTML = `<header class="chap-head"><div class="num">CHAPTER ${sec.number}</div><h1>${esc(sec.title)}</h1>
          <img class="ornament" src="book/img/ornament.png" alt="">
          ${sec.subtitle ? `<div class="subtitle">${esc(sec.subtitle)}</div>` : ''}</header>`;
      } else if (sec.kind === 'part') {
        el.innerHTML = `<header class="chap-head"><h1>${esc(sec.title)}</h1><img class="ornament" src="book/img/ornament.png" alt=""></header>`;
      } else if (sec.kind === 'front' && sec.blocks.length && sec.blocks[0].t !== 'img') {
        el.innerHTML = `<div class="front-title">${esc(sec.title)}</div>`;
      }
      let firstP = sec.kind === 'chapter' || sec.kind === 'part';
      sec.blocks.forEach((b, bi) => {
        if (sec.kind === 'cover') return;
        const id = `${si}-${bi}`;
        let node;
        switch (b.t) {
          case 'p': node = document.createElement('p'); node.innerHTML = b.html; if (firstP) { node.classList.add('first'); } break;
          case 'h2': node = document.createElement('h2'); node.innerHTML = b.html; break;
          case 'h3': node = document.createElement('h3'); node.innerHTML = b.html; break;
          case 'quote': node = document.createElement('p'); node.className = 'quote'; node.innerHTML = b.html; break;
          case 'cite': node = document.createElement('p'); node.className = 'cite'; node.innerHTML = b.html; break;
          case 'small': node = document.createElement('p'); node.className = 'small'; node.innerHTML = b.html; break;
          case 'center': node = document.createElement('p'); node.className = 'center'; node.innerHTML = b.html; break;
          case 'hr': node = document.createElement('hr'); break;
          case 'img': node = document.createElement('img'); node.className = 'page-img' + (b.src.includes('title') ? ' title-img' : ''); node.src = 'book/' + b.src; node.width = b.w; node.height = b.h; node.alt = b.alt || ''; node.loading = 'lazy'; break;
          default: node = document.createElement('p'); node.innerHTML = b.html || '';
        }
        if (b.t === 'p') firstP = false;
        node.id = 'b-' + id;
        node.dataset.b = id;
        const text = node.textContent || '';
        const chars = b.t === 'hr' || b.t === 'img' ? 0 : text.length;
        blocks.push({ id, el: node, sec: si, start: cum, chars, text });
        blockById.set(id, blocks.length - 1);
        cum += chars;
        el.appendChild(node);
      });
      // end-of-section "continue" card
      const next = meta.sections[si + 1];
      if (next && (sec.kind === 'chapter' || sec.kind === 'part') && (next.kind === 'chapter' || next.kind === 'part')) {
        const card = document.createElement('div');
        card.className = 'chap-end';
        card.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg><div>Keep scrolling to continue<b>${esc(sectionTitle(next))}</b></div>`;
        card.addEventListener('click', () => goToSection(si + 1));
        el.appendChild(card);
      }
      if (si === meta.sections.length - 1) {
        const end = document.createElement('div');
        end.className = 'book-end';
        end.textContent = 'The End';
        el.appendChild(end);
      }
      frag.appendChild(el);
    });
    content.replaceChildren(frag);
    totalChars = Math.max(1, cum);
    buildToc();
    applyAllHighlights();
    blockTops = null;
    $('#btn-continue')?.addEventListener('click', () => restorePosition(true));
    // restore
    requestAnimationFrame(() => {
      restorePosition(false);
      $('#loading').classList.add('hide');
      setTimeout(() => $('#loading').remove(), 400);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { blockTops = null; restorePosition(false); });
      setTimeout(() => { blockTops = null; restorePosition(false); }, 1200);
    });
  }

  // ---------------------------------------------------------------- position
  function computeTops() {
    blockTops = new Float64Array(blocks.length);
    const base = content.getBoundingClientRect().top + window.scrollY;
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].el.getBoundingClientRect();
      blockTops[i] = r.top + window.scrollY;
    }
    void base;
  }
  function currentAnchor() {
    if (!blocks.length) return { index: 0, frac: 0 };
    if (!blockTops) computeTops();
    const y = window.scrollY + topOffset() + 8;
    // binary search: last block whose top <= y
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (blockTops[mid] <= y) lo = mid; else hi = mid - 1; }
    const el = blocks[lo].el;
    const h = el.offsetHeight || 1;
    const frac = clamp((y - blockTops[lo]) / h, 0, 1);
    return { index: lo, frac };
  }
  function scrollToAnchor(a, smooth = false) {
    const b = blocks[a.index]; if (!b) return;
    const top = b.el.getBoundingClientRect().top + window.scrollY;
    const y = top + (b.el.offsetHeight || 0) * (a.frac || 0) - topOffset() - 8;
    suppressScroll = Date.now() + 400;
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
  }
  function keepAnchor(fn) {
    const a = currentAnchor();
    fn();
    blockTops = null;
    requestAnimationFrame(() => { scrollToAnchor(a); blockTops = null; updateUI(); });
  }
  function savePosition() {
    const b = blocks[anchor.index]; if (!b) return;
    position = { block: b.id, frac: anchor.frac, pct: progressPct(), t: Date.now() };
    store.set('position', position);
  }
  function restorePosition(announce) {
    if (!position || !position.block) return;
    const idx = blockById.get(position.block);
    if (idx == null) return;
    scrollToAnchor({ index: idx, frac: position.frac || 0 });
    anchor = { index: idx, frac: position.frac || 0 };
    updateUI();
    if (announce) toast('Continuing where you left off');
  }
  function charsAt(a) { const b = blocks[a.index]; return b ? b.start + b.chars * (a.frac || 0) : 0; }
  function progressPct() { return clamp(charsAt(anchor) / totalChars * 100, 0, 100); }

  // ---------------------------------------------------------------- UI updates
  let uiRaf = 0;
  function scheduleUI() { if (!uiRaf) uiRaf = requestAnimationFrame(() => { uiRaf = 0; updateUI(); }); }
  function updateUI() {
    if (!blocks.length) return;
    anchor = currentAnchor();
    const b = blocks[anchor.index];
    const sec = meta.sections[b.sec];
    const pct = progressPct();
    $('#progress-line-fill').style.width = pct.toFixed(2) + '%';
    if (document.activeElement !== scrubber) scrubber.value = Math.round(pct * 100);
    const loc = Math.floor(charsAt(anchor) / CHARS_PER_LOC) + 1;
    const totalLoc = Math.ceil(totalChars / CHARS_PER_LOC);
    infoLeft.textContent = `${pct < 1 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
    infoRight.textContent = `Loc ${loc} of ${totalLoc}`;
    // time left in chapter
    const cpm = (stats.wpm || DEFAULT_WPM) * 5.7;
    const secEnd = sectionStart[b.sec] + sec.chars;
    const leftChapter = (secEnd - charsAt(anchor)) / cpm;
    const leftBook = (totalChars - charsAt(anchor)) / cpm;
    if (sec.kind === 'chapter' || sec.kind === 'part') infoMid.textContent = `${fmtMin(leftChapter)} left in chapter · ${fmtMin(leftBook)} in book`;
    else infoMid.textContent = '';
    barChapter.textContent = sec.kind === 'cover' ? meta.author : sectionTitle(sec);
    ribbon.classList.toggle('on', bookmarks.some((bm) => bm.block === b.id));
    // toc current
    const cur = $('#toc-list .toc-item.current'); if (cur) cur.classList.remove('current');
    const item = $(`#toc-list .toc-item[data-sec="${b.sec}"]`); if (item) item.classList.add('current');
    savePositionThrottled();
    trackReading();
  }
  let saveT = 0;
  function savePositionThrottled() { clearTimeout(saveT); saveT = setTimeout(savePosition, 300); }

  // ---------------------------------------------------------------- reading stats
  let lastActive = 0, lastChars = null, sessionStarted = false;
  function trackReading() {
    const now = Date.now();
    const c = charsAt(anchor);
    if (!sessionStarted) { sessionStarted = true; stats.sessions++; lastActive = now; lastChars = c; return; }
    const dt = now - lastActive;
    if (dt > 0 && dt < 90000) {  // ignore idle gaps > 90 s
      stats.ms += dt;
      const dc = c - lastChars;
      if (dc > 0 && dc < 20000) {
        stats.chars += dc;
        // update WPM estimate from the last 5+ minutes of reading
        if (stats.ms > 5 * 60000 && stats.chars > 5000) {
          const measured = (stats.chars / 5.7) / (stats.ms / 60000);
          stats.wpm = clamp(Math.round(stats.wpm * 0.7 + measured * 0.3), 80, 900);
        }
      }
    }
    lastActive = now; lastChars = c;
    stats.maxPct = Math.max(stats.maxPct || 0, progressPct());
    store.set('stats', stats);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { savePosition(); lastActive = 0; } else { lastActive = Date.now(); } });
  window.addEventListener('pagehide', savePosition);

  // ---------------------------------------------------------------- scroll / chrome
  let lastY = window.scrollY, hideT = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (Date.now() > suppressScroll) {
      if (backPos && Math.abs(y - backPos.y) > innerHeight * 4) { /* keep */ }
      if (y > lastY + 12 && !chromeHidden && !document.body.classList.contains('drawer-open') && y > 80) setChrome(false);
      else if (y < lastY - 40 && chromeHidden) setChrome(true);
    }
    lastY = y;
    scheduleUI();
  }, { passive: true });
  function setChrome(show) {
    chromeHidden = !show;
    document.body.classList.toggle('chrome-hidden', chromeHidden);
  }
  // tap center toggles chrome; edges page (if enabled)
  let tStart = null;
  reader.addEventListener('pointerdown', (e) => { tStart = { x: e.clientX, y: e.clientY, t: Date.now(), target: e.target }; });
  reader.addEventListener('pointerup', (e) => {
    if (!tStart) return;
    const dx = Math.abs(e.clientX - tStart.x), dy = Math.abs(e.clientY - tStart.y), dt = Date.now() - tStart.t;
    tStart = null;
    if (dx > 10 || dy > 10 || dt > 400) return;
    if (e.target.closest('a, button, mark.hl, .chap-end')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (!definePop.hidden) { definePop.hidden = true; return; }
    const w = innerWidth, x = e.clientX;
    if (settings.tapZones && x < w * 0.22) { pageBy(-1); return; }
    if (settings.tapZones && x > w * 0.78) { pageBy(1); return; }
    setChrome(chromeHidden);
  });
  function pageBy(dir) {
    const h = innerHeight - topOffset() - 40;
    suppressScroll = Date.now() + 500;
    window.scrollBy({ top: dir * h, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- navigation
  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  function rememberBack() {
    backPos = { y: window.scrollY, a: anchor };
    const btn = $('#btn-back'); btn.hidden = false;
    clearTimeout(rememberBack._t); rememberBack._t = setTimeout(() => { btn.hidden = true; backPos = null; }, 60000);
  }
  function goToBlock(id, opts = {}) {
    const idx = blockById.get(id); if (idx == null) return;
    if (!opts.noBack) rememberBack();
    closeDrawers();
    scrollToAnchor({ index: idx, frac: 0 }, opts.smooth);
    if (opts.flash !== false) setTimeout(() => flash(blocks[idx].el), opts.smooth ? 400 : 50);
    setChrome(true);
    setTimeout(scheduleUI, 50);
  }
  function goToSection(si) {
    rememberBack(); closeDrawers();
    const sec = document.getElementById(meta.sections[si].id); if (!sec) return;
    const y = sec.getBoundingClientRect().top + window.scrollY - topOffset() + 1;
    suppressScroll = Date.now() + 500;
    window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
    setChrome(true);
    setTimeout(scheduleUI, 50);
  }
  $('#btn-prev').addEventListener('click', () => {
    const si = blocks[anchor.index].sec;
    const secEl = document.getElementById(meta.sections[si].id);
    const atTop = secEl.getBoundingClientRect().top > -innerHeight * 0.5;
    goToSection(Math.max(0, atTop ? si - 1 : si));
  });
  $('#btn-next').addEventListener('click', () => goToSection(Math.min(meta.sections.length - 1, blocks[anchor.index].sec + 1)));
  $('#btn-back').addEventListener('click', () => {
    if (!backPos) return;
    const p = backPos; backPos = null; $('#btn-back').hidden = true;
    suppressScroll = Date.now() + 500;
    window.scrollTo({ top: p.y, behavior: 'auto' });
    setTimeout(scheduleUI, 50);
  });

  // scrubber
  let scrubbing = false;
  scrubber.addEventListener('input', () => {
    scrubbing = true;
    const target = scrubber.value / 10000 * totalChars;
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (blocks[mid].start <= target) lo = mid; else hi = mid - 1; }
    const sec = meta.sections[blocks[lo].sec];
    infoMid.textContent = sectionTitle(sec);
    infoLeft.textContent = `${(scrubber.value / 100).toFixed(0)}%`;
    scrubber._target = lo;
  });
  scrubber.addEventListener('change', () => {
    if (scrubber._target == null) return;
    rememberBack();
    scrollToAnchor({ index: scrubber._target, frac: 0 });
    scrubbing = false; scrubber.blur();
    setTimeout(scheduleUI, 50);
  });

  // ---------------------------------------------------------------- drawers
  const drawers = { toc: $('#drawer-toc'), notes: $('#drawer-notes'), search: $('#drawer-search'), settings: $('#drawer-settings') };
  let openDrawer = null;
  function toggleDrawer(name) {
    if (openDrawer === name) { closeDrawers(); return; }
    closeDrawers();
    openDrawer = name;
    drawers[name].classList.add('open');
    document.body.classList.add('drawer-open');
    if (name === 'toc') { renderTocProgress(); setTimeout(() => $('#toc-list .toc-item.current')?.scrollIntoView({ block: 'center' }), 50); }
    if (name === 'notes') renderNotes();
    if (name === 'search') setTimeout(() => $('#search-input').focus(), 300);
  }
  function closeDrawers() {
    if (!openDrawer) return;
    drawers[openDrawer].classList.remove('open');
    document.body.classList.remove('drawer-open');
    openDrawer = null;
  }
  $('#scrim').addEventListener('click', closeDrawers);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));
  $('#btn-toc').addEventListener('click', () => toggleDrawer('toc'));
  $('#btn-notes').addEventListener('click', () => toggleDrawer('notes'));
  $('#btn-search').addEventListener('click', () => toggleDrawer('search'));
  $('#btn-settings').addEventListener('click', () => toggleDrawer('settings'));
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  }));

  // ---------------------------------------------------------------- TOC
  function buildToc() {
    const list = $('#toc-list');
    list.innerHTML = '';
    meta.sections.forEach((sec, si) => {
      if (sec.kind === 'cover') return;
      const wrap = document.createElement('div');
      wrap.className = 'toc-chapter-wrap';
      const btn = document.createElement('button');
      btn.className = 'toc-item' + (sec.kind === 'front' ? ' front' : '');
      btn.dataset.sec = si;
      btn.innerHTML = `<span class="pct" data-pct></span><span class="t">${sec.kind === 'chapter' ? `<span class="num">${sec.number}</span>` : ''}${esc(sec.title)}</span>${sec.subtitle ? `<span class="s">${esc(sec.subtitle)}</span>` : ''}`;
      btn.addEventListener('click', () => goToSection(si));
      wrap.appendChild(btn);
      sec.headings.forEach((h) => {
        const sub = document.createElement('button');
        sub.className = 'toc-item ' + (h.t === 'h3' ? 'sub3' : 'sub');
        sub.textContent = h.text;
        sub.addEventListener('click', () => goToBlock(`${si}-${h.b}`, { flash: false }));
        wrap.appendChild(sub);
      });
      list.appendChild(wrap);
    });
  }
  function renderTocProgress() {
    const cur = charsAt(anchor);
    $$('#toc-list .toc-item[data-sec]').forEach((b) => {
      const si = +b.dataset.sec, sec = meta.sections[si];
      const start = sectionStart[si], end = start + sec.chars;
      let txt = '';
      if (sec.chars > 500) {
        if (cur >= end) txt = '✓';
        else if (cur > start) txt = Math.round((cur - start) / sec.chars * 100) + '%';
        else txt = fmtMin(sec.chars / ((stats.wpm || DEFAULT_WPM) * 5.7));
      }
      b.querySelector('[data-pct]').textContent = txt;
    });
  }

  // ---------------------------------------------------------------- bookmarks
  function toggleBookmark() {
    const b = blocks[anchor.index]; if (!b) return;
    const i = bookmarks.findIndex((bm) => bm.block === b.id);
    if (i >= 0) { bookmarks.splice(i, 1); toast('Bookmark removed'); }
    else {
      bookmarks.push({ id: uid(), block: b.id, excerpt: b.text.slice(0, 140), created: Date.now(), pct: progressPct() });
      toast('Bookmark added');
    }
    bookmarks.sort((a, c) => blockById.get(a.block) - blockById.get(c.block));
    store.set('bookmarks', bookmarks);
    updateUI();
  }
  ribbon.addEventListener('click', toggleBookmark);

  function renderNotes() {
    const bm = $('#tab-bookmarks');
    bm.innerHTML = bookmarks.length ? '' : '<p class="muted">No bookmarks yet. Tap the ribbon in the top-right corner (or press B) to bookmark where you are.</p>';
    bookmarks.forEach((x) => {
      const idx = blockById.get(x.block); if (idx == null) return;
      const sec = meta.sections[blocks[idx].sec];
      const d = document.createElement('div');
      d.className = 'note-item';
      d.innerHTML = `<div class="where"><span>${esc(sectionTitle(sec))} · ${Math.round(x.pct)}%</span><button class="del" aria-label="Delete">Delete</button></div><div class="excerpt">${esc(x.excerpt)}…</div>`;
      d.addEventListener('click', (e) => { if (e.target.closest('.del')) { bookmarks = bookmarks.filter((y) => y.id !== x.id); store.set('bookmarks', bookmarks); renderNotes(); updateUI(); } else goToBlock(x.block); });
      bm.appendChild(d);
    });
    const hl = $('#tab-highlights');
    const groups = new Map();
    highlights.forEach((h) => { const g = groups.get(h.group) || []; g.push(h); groups.set(h.group, g); });
    const list = Array.from(groups.values()).sort((a, c) => blockById.get(a[0].block) - blockById.get(c[0].block));
    hl.innerHTML = list.length ? '' : '<p class="muted">Select any text to highlight it, add a note, or look up a definition.</p>';
    list.forEach((g) => {
      const first = g[0];
      const idx = blockById.get(first.block); if (idx == null) return;
      const sec = meta.sections[blocks[idx].sec];
      const text = g.map((h) => h.text).join(' ');
      const note = g.find((h) => h.note)?.note;
      const d = document.createElement('div');
      d.className = 'note-item';
      d.innerHTML = `<div class="where"><span>${esc(sectionTitle(sec))}</span><button class="del">Delete</button></div><div class="excerpt hl-${first.color}">${esc(text)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}`;
      d.addEventListener('click', (e) => { if (e.target.closest('.del')) removeHighlightGroup(first.group); else goToBlock(first.block); });
      hl.appendChild(d);
    });
    // stats
    const st = $('#tab-stats');
    const hours = stats.ms / 3600000;
    const words = Math.round(stats.chars / 5.7);
    const pctRead = Math.round(stats.maxPct || 0);
    const leftMin = (totalChars - charsAt(anchor)) / ((stats.wpm || DEFAULT_WPM) * 5.7);
    st.innerHTML = [
      ['Progress', `${pctRead}%`],
      ['Time spent reading', fmtMin(stats.ms / 60000) || '0 min'],
      ['Words read', words.toLocaleString()],
      ['Your reading speed', `${stats.wpm || DEFAULT_WPM} words / min`],
      ['Time left in book', fmtMin(leftMin)],
      ['Reading sessions', stats.sessions],
      ['Highlights', groups.size],
      ['Bookmarks', bookmarks.length],
      ['Total length', `${Math.round(totalChars / 5.7).toLocaleString()} words · ${Math.ceil(totalChars / CHARS_PER_LOC)} locations`],
      ['Started', new Date(stats.firstOpened).toLocaleDateString()],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('') + `<div class="stat"><span>${hours > 0 ? '' : ''}</span><button class="chip" id="btn-reset-stats">Reset stats</button></div>`;
    $('#btn-reset-stats').addEventListener('click', () => { if (confirm('Reset reading statistics?')) { stats = { ms: 0, chars: 0, sessions: 1, wpm: DEFAULT_WPM, maxPct: progressPct(), firstOpened: Date.now() }; store.set('stats', stats); renderNotes(); } });
  }
  $('#btn-clear-notes').addEventListener('click', () => {
    if (!confirm('Delete all bookmarks and highlights?')) return;
    bookmarks = []; highlights = []; store.set('bookmarks', []); store.set('highlights', []);
    $$('mark.hl', content).forEach(unwrap); renderNotes(); updateUI();
  });
  $('#btn-export').addEventListener('click', () => {
    const lines = [`# ${meta.title} — ${meta.author}`, `Exported ${new Date().toLocaleString()}`, ''];
    const groups = new Map();
    highlights.forEach((h) => { const g = groups.get(h.group) || []; g.push(h); groups.set(h.group, g); });
    const list = Array.from(groups.values()).sort((a, c) => blockById.get(a[0].block) - blockById.get(c[0].block));
    if (list.length) lines.push('## Highlights', '');
    list.forEach((g) => {
      const sec = meta.sections[blocks[blockById.get(g[0].block)].sec];
      lines.push(`> ${g.map((h) => h.text).join(' ')}`, `— ${sectionTitle(sec)}`);
      const note = g.find((h) => h.note)?.note; if (note) lines.push(`Note: ${note}`);
      lines.push('');
    });
    if (bookmarks.length) lines.push('## Bookmarks', '');
    bookmarks.forEach((b) => { const sec = meta.sections[blocks[blockById.get(b.block)].sec]; lines.push(`- ${sectionTitle(sec)} (${Math.round(b.pct)}%): ${b.excerpt}…`); });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'laws-of-human-nature-notes.md'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------------------------------------------------------------- highlights
  function textNodes(el) {
    const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) out.push(n); return out;
  }
  function offsetIn(el, node, off) {
    let total = 0;
    for (const t of textNodes(el)) { if (t === node) return total + off; total += t.length; }
    // node may be an element: count text before child index
    if (node === el || el.contains(node)) {
      let c = 0;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) {
        const pos = node.compareDocumentPoint ? 0 : 0; void pos;
        if (node.nodeType === 1 && node.childNodes[off] && (node.childNodes[off] === t || node.childNodes[off].contains(t))) return c;
        if (node.nodeType === 1 && node.contains(t) && off >= node.childNodes.length) { c += t.length; continue; }
        c += t.length;
      }
      return c;
    }
    return total;
  }
  function wrapRange(blockEl, start, end, cls, hid) {
    let pos = 0;
    for (const t of textNodes(blockEl)) {
      const tStart = pos, tEnd = pos + t.length; pos = tEnd;
      if (tEnd <= start || tStart >= end) continue;
      let node = t;
      if (tStart < start) node = node.splitText(start - tStart);
      if (tEnd > end) node.splitText(end - (tStart < start ? start : tStart));
      const m = document.createElement('mark');
      m.className = cls; m.dataset.h = hid;
      node.parentNode.insertBefore(m, node); m.appendChild(node);
    }
  }
  function unwrap(m) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); }
  function applyHighlight(h) {
    const idx = blockById.get(h.block); if (idx == null) return;
    const el = blocks[idx].el;
    wrapRange(el, h.start, h.end, `hl ${h.color}${h.note ? ' has-note' : ''}`, h.id);
  }
  function applyAllHighlights() { highlights.forEach(applyHighlight); }
  function removeHighlightGroup(group) {
    highlights.filter((h) => h.group === group).forEach((h) => $$(`mark[data-h="${h.id}"]`, content).forEach(unwrap));
    highlights = highlights.filter((h) => h.group !== group);
    store.set('highlights', highlights);
    renderNotes(); hideSelPop();
  }
  function createHighlightFromSelection(color) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const group = uid();
    const made = [];
    const blockEls = blocks.map((b) => b.el).filter((el) => range.intersectsNode(el) && el.textContent.trim());
    blockEls.forEach((el) => {
      const len = el.textContent.length;
      let s = 0, e = len;
      if (el.contains(range.startContainer)) s = offsetIn(el, range.startContainer, range.startOffset);
      if (el.contains(range.endContainer)) e = offsetIn(el, range.endContainer, range.endOffset);
      s = clamp(s, 0, len); e = clamp(e, 0, len);
      if (e <= s) return;
      const text = el.textContent.slice(s, e);
      if (!text.trim()) return;
      made.push({ id: uid(), group, block: el.dataset.b, start: s, end: e, color, text, note: '', created: Date.now() });
    });
    if (!made.length) return null;
    // remove any existing highlights overlapping the same ranges to avoid nesting
    made.forEach((h) => {
      highlights.filter((x) => x.block === h.block && x.start < h.end && x.end > h.start).forEach((x) => {
        $$(`mark[data-h="${x.id}"]`, content).forEach(unwrap);
        highlights = highlights.filter((y) => y.id !== x.id);
      });
    });
    highlights.push(...made);
    store.set('highlights', highlights);
    made.forEach(applyHighlight);
    sel.removeAllRanges();
    hideSelPop();
    return group;
  }

  // selection popover
  let selTimer = 0, popGroup = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { if (!popGroup) hideSelPop(); return; }
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) { hideSelPop(); return; }
      popGroup = null;
      showSelPop(range.getBoundingClientRect(), false);
    }, 180);
  });
  function showSelPop(rect, existing) {
    selPop.hidden = false;
    $('[data-act="remove"]', selPop).hidden = !existing;
    $('[data-act="define"]', selPop).hidden = existing;
    const pw = selPop.offsetWidth, ph = selPop.offsetHeight;
    let x = rect.left + rect.width / 2 - pw / 2;
    x = clamp(x, 8, innerWidth - pw - 8);
    let y = rect.top - ph - 12;
    if (y < topOffset()) y = rect.bottom + 12;
    selPop.style.left = x + 'px'; selPop.style.top = y + 'px';
  }
  function hideSelPop() { selPop.hidden = true; popGroup = null; }
  selPop.addEventListener('pointerdown', (e) => e.preventDefault()); // keep selection
  selPop.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.color) {
      if (popGroup) {
        highlights.filter((h) => h.group === popGroup).forEach((h) => { h.color = btn.dataset.color; $$(`mark[data-h="${h.id}"]`, content).forEach((m) => { m.className = `hl ${h.color}${h.note ? ' has-note' : ''}`; }); });
        store.set('highlights', highlights); hideSelPop();
      } else {
        createHighlightFromSelection(btn.dataset.color);
        toast('Highlighted');
      }
    } else if (btn.dataset.act === 'note') {
      const group = popGroup || createHighlightFromSelection('yellow');
      if (group) openNoteDialog(group);
    } else if (btn.dataset.act === 'copy') {
      const text = popGroup ? highlights.filter((h) => h.group === popGroup).map((h) => h.text).join(' ') : String(window.getSelection());
      navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'));
      hideSelPop();
    } else if (btn.dataset.act === 'define') {
      define(String(window.getSelection()).trim());
      hideSelPop();
    } else if (btn.dataset.act === 'remove') {
      if (popGroup) removeHighlightGroup(popGroup);
    }
  });
  content.addEventListener('click', (e) => {
    const m = e.target.closest('mark.hl'); if (!m) return;
    const h = highlights.find((x) => x.id === m.dataset.h); if (!h) return;
    e.stopPropagation();
    popGroup = h.group;
    const rects = $$(`mark[data-h="${h.id}"]`, content).map((x) => x.getBoundingClientRect());
    const r = rects[0];
    showSelPop(r, true);
    if (h.note) toast(h.note, 3500);
  });

  // note dialog
  const noteDialog = $('#note-dialog');
  function openNoteDialog(group) {
    const g = highlights.filter((h) => h.group === group); if (!g.length) return;
    $('#note-quote').textContent = g.map((h) => h.text).join(' ');
    $('#note-text').value = g.find((h) => h.note)?.note || '';
    noteDialog.returnValue = '';
    noteDialog.showModal();
    noteDialog.onclose = () => {
      if (noteDialog.returnValue !== 'save') return;
      const note = $('#note-text').value.trim();
      g.forEach((h, i) => { h.note = i === 0 ? note : ''; $$(`mark[data-h="${h.id}"]`, content).forEach((m) => m.classList.toggle('has-note', !!note && i === 0)); });
      store.set('highlights', highlights);
      toast(note ? 'Note saved' : 'Note removed');
    };
    hideSelPop();
  }

  // ---------------------------------------------------------------- dictionary
  async function define(phrase) {
    const word = phrase.replace(/[^\p{L}\p{M}'’-]+/gu, ' ').trim().split(/\s+/)[0];
    if (!word) return;
    definePop.hidden = false;
    definePop.innerHTML = `<button class="icon-btn small x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button><h4>${esc(word)}</h4><div class="muted" style="padding:0">Looking up…</div>`;
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
      if (!res.ok) throw new Error('nf');
      const data = await res.json();
      const entry = data[0];
      const phon = entry.phonetics?.find((p) => p.text)?.text || '';
      let html = `<button class="icon-btn small x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button><h4>${esc(entry.word)}</h4>${phon ? `<div class="phon">${esc(phon)}</div>` : ''}`;
      entry.meanings.slice(0, 3).forEach((m) => {
        html += `<div class="pos">${esc(m.partOfSpeech)}</div><ol>${m.definitions.slice(0, 3).map((d) => `<li>${esc(d.definition)}${d.example ? ` <em class="phon">“${esc(d.example)}”</em>` : ''}</li>`).join('')}</ol>`;
      });
      definePop.innerHTML = html;
    } catch {
      definePop.innerHTML = `<button class="icon-btn small x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button><h4>${esc(word)}</h4><div class="muted" style="padding:0">No definition found${navigator.onLine ? '' : ' (offline)'}. <a href="https://www.google.com/search?q=define+${encodeURIComponent(word)}" target="_blank" rel="noopener">Search the web</a></div>`;
    }
  }
  definePop.addEventListener('click', (e) => { if (e.target.closest('.x')) definePop.hidden = true; });

  // ---------------------------------------------------------------- search
  const searchInput = $('#search-input'), searchResults = $('#search-results');
  let searchT = 0;
  searchInput.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(runSearch, 200); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); searchInput.blur(); } });
  function runSearch() {
    const q = searchInput.value.trim();
    searchResults.innerHTML = '';
    if (q.length < 2) { searchResults.innerHTML = '<p class="muted">Type at least 2 characters.</p>'; return; }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let count = 0; const max = 300;
    const frag = document.createDocumentFragment();
    for (const b of blocks) {
      if (!b.chars) continue;
      re.lastIndex = 0; let m;
      while ((m = re.exec(b.text)) && count < max) {
        count++;
        const s = Math.max(0, m.index - 60), e = Math.min(b.text.length, m.index + q.length + 80);
        const ctx = (s > 0 ? '…' : '') + esc(b.text.slice(s, m.index)) + '<mark>' + esc(m[0]) + '</mark>' + esc(b.text.slice(m.index + q.length, e)) + (e < b.text.length ? '…' : '');
        const btn = document.createElement('button');
        btn.className = 'sr';
        btn.innerHTML = `<div class="where">${esc(sectionTitle(meta.sections[b.sec]))}</div>${ctx}`;
        btn.addEventListener('click', () => goToBlock(b.id));
        frag.appendChild(btn);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (count >= max) break;
    }
    const head = document.createElement('div'); head.className = 'sr-count';
    head.textContent = count ? `${count}${count >= max ? '+' : ''} result${count === 1 ? '' : 's'}` : 'No results';
    searchResults.appendChild(head); searchResults.appendChild(frag);
  }

  // ---------------------------------------------------------------- settings UI
  $('#theme-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.theme = b.dataset.theme; applySettings(); } });
  $('#font-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.font = b.dataset.font; applySettings(); } });
  $('#lh-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.lineHeight = b.dataset.lh; applySettings(); } });
  $('#margin-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.margin = b.dataset.margin; applySettings(); } });
  $('#align-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.align = b.dataset.align; applySettings(); } });
  $('#font-dec').addEventListener('click', () => { settings.fontSize = clamp(settings.fontSize - 1, 12, 34); applySettings(); });
  $('#font-inc').addEventListener('click', () => { settings.fontSize = clamp(settings.fontSize + 1, 12, 34); applySettings(); });
  $('#brightness').addEventListener('input', (e) => { settings.brightness = +e.target.value; $('#dimmer').style.opacity = String((100 - settings.brightness) / 100 * 0.85); });
  $('#brightness').addEventListener('change', () => store.set('settings', settings));
  $('#opt-tapzones').addEventListener('change', (e) => { settings.tapZones = e.target.checked; applySettings(false); });
  $('#opt-hyphens').addEventListener('change', (e) => { settings.hyphens = e.target.checked; applySettings(); });
  $('#opt-bold').addEventListener('change', (e) => { settings.bold = e.target.checked; applySettings(); });
  $('#opt-keepawake').addEventListener('change', (e) => { settings.keepAwake = e.target.checked; applySettings(false); });
  $('#btn-reset-settings').addEventListener('click', () => { settings = Object.assign({}, DEFAULT_SETTINGS); applySettings(); });
  $('#btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    else toast('Add to Home Screen for a full-screen reading experience');
    closeDrawers();
  });

  // pinch-to-zoom font size (iOS Safari doesn't give us zoom, so map pinch -> font size)
  let pinch = null;
  reader.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: dist(e.touches), size: settings.fontSize }; }, { passive: true });
  reader.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    const ratio = dist(e.touches) / pinch.d;
    const size = clamp(Math.round(pinch.size * ratio), 12, 34);
    if (size !== settings.fontSize) { settings.fontSize = size; applySettings(); }
  }, { passive: true });
  reader.addEventListener('touchend', () => { pinch = null; }, { passive: true });
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  // wake lock
  let wakeLock = null;
  async function updateWakeLock() {
    try {
      if (settings.keepAwake && !wakeLock && 'wakeLock' in navigator && !document.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!settings.keepAwake && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateWakeLock(); });

  // ---------------------------------------------------------------- autoscroll
  let auto = null;
  const autoCtl = $('#autoscroll-ctl'), autoSpeed = $('#autoscroll-speed');
  autoSpeed.value = store.get('autospeed', 45);
  function startAuto() {
    if (auto) return;
    auto = { last: performance.now(), acc: 0 };
    autoCtl.hidden = false; $('#btn-autoscroll').classList.add('active'); setChrome(false);
    const step = (t) => {
      if (!auto) return;
      const dt = (t - auto.last) / 1000; auto.last = t;
      auto.acc += autoSpeed.value * dt;
      const px = Math.floor(auto.acc); auto.acc -= px;
      if (px) { suppressScroll = Date.now() + 100; window.scrollBy(0, px); }
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) { stopAuto(); return; }
      auto.raf = requestAnimationFrame(step);
    };
    auto.raf = requestAnimationFrame(step);
  }
  function stopAuto() { if (!auto) return; cancelAnimationFrame(auto.raf); auto = null; autoCtl.hidden = true; $('#btn-autoscroll').classList.remove('active'); }
  $('#btn-autoscroll').addEventListener('click', () => (auto ? stopAuto() : startAuto()));
  $('#autoscroll-stop').addEventListener('click', stopAuto);
  autoSpeed.addEventListener('change', () => store.set('autospeed', +autoSpeed.value));
  reader.addEventListener('touchstart', () => { if (auto) { auto.paused = true; } }, { passive: true });
  reader.addEventListener('wheel', () => { if (auto) stopAuto(); }, { passive: true });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea') || noteDialog.open) { if (e.key === 'Escape') { closeDrawers(); e.target.blur(); } return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'Escape': closeDrawers(); hideSelPop(); definePop.hidden = true; stopAuto(); break;
      case 't': case 'T': toggleDrawer('toc'); break;
      case 'b': case 'B': toggleBookmark(); break;
      case 'n': case 'N': toggleDrawer('notes'); break;
      case '/': case 'f': case 'F': e.preventDefault(); toggleDrawer('search'); break;
      case 's': case 'S': toggleDrawer('settings'); break;
      case '+': case '=': settings.fontSize = clamp(settings.fontSize + 1, 12, 34); applySettings(); break;
      case '-': case '_': settings.fontSize = clamp(settings.fontSize - 1, 12, 34); applySettings(); break;
      case 'ArrowRight': case 'l': pageBy(1); break;
      case 'ArrowLeft': case 'h': pageBy(-1); break;
      case ']': $('#btn-next').click(); break;
      case '[': $('#btn-prev').click(); break;
      case 'a': case 'A': auto ? stopAuto() : startAuto(); break;
      case 'd': case 'D': { const o = ['light', 'sepia', 'green', 'dark', 'black']; settings.theme = o[(o.indexOf(settings.theme) + 1) % o.length]; applySettings(); break; }
      case 'c': case 'C': setChrome(chromeHidden); break;
      default: return;
    }
  });

  // ---------------------------------------------------------------- resize
  let resizeT = 0, lastW = innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    const a = anchor;
    resizeT = setTimeout(() => {
      blockTops = null;
      if (innerWidth !== lastW) { lastW = innerWidth; scrollToAnchor(a); }
      scheduleUI();
    }, 120);
  });
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { blockTops = null; }).observe(content);
  }
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  // ---------------------------------------------------------------- service worker
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // ---------------------------------------------------------------- go
  applySettings(false);
  loadBook().catch((err) => {
    console.error(err);
    $('#loading').innerHTML = `<div>Could not load the book.<br><small>${esc(String(err))}</small></div><button class="chip" onclick="location.reload()">Retry</button>`;
  });
})();
