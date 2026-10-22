// ui/pages-panel.js — the Notability-style page sidebar.
//
// A list of page thumbnails down the right edge of the editor. It is a
// stateless renderer like ui/library.js: buildPagesPanel(actions) creates the
// DOM once, update(state) pushes the current document in. The app owns the
// document; this module only reads it and reports taps through the callbacks.
//
// THUMBNAILS ARE CACHED BY CONTENT, NOT BY TIME. A page's cheap signature is
// its stroke count, its total point count and its layer count. If that has not
// changed, the cached image is reused. When it has, the page is queued and
// rendered ONE PER FRAME, so a note with many pages (or a fast pen) never
// creates a burst of canvases in a single animation frame.
//
// The module is import-safe in Node: nothing touches `document` at import
// time, and the thumbnail renderer can be replaced for tests.

import { el } from './popover.js';
import { pageToPngBlob } from '../export.js';
import { DEFAULT_PAGE_W, DEFAULT_PAGE_H } from '../layout.js';

// A thumbnail is a page preview, not a print sheet. 0.18 of the page's own
// size keeps a full A4 page around 143 x 202 CSS px.
const THUMB_SCALE = 0.18;
const CSS_ID = 'pages-panel-css';

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

// The cheap content fingerprint used by the thumbnail cache. Deliberately the
// same shape workspace.js uses for the library thumbnail: it changes when the
// visible content changes, without hashing every point.
export function pageSignature(page) {
  const strokes = Array.isArray(page?.strokes) ? page.strokes : [];
  let points = 0;
  for (const stroke of strokes) {
    points += Array.isArray(stroke?.points) ? stroke.points.length : 0;
  }
  const layers = Array.isArray(page?.layers) ? page.layers.length : 0;
  return `${strokes.length}:${points}:${layers}`;
}

// Filter pages by NAME. Hidden is only a name match — there is no ink OCR.
// Returns the ORIGINAL indices so a filtered card still opens the right page.
export function filterPageEntries(pages, query) {
  const list = Array.isArray(pages) ? pages : [];
  const q = String(query ?? '').trim().toLowerCase();
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const name = String(list[i]?.name ?? '').toLowerCase();
    if (!q || name.includes(q)) out.push({ page: list[i], index: i });
  }
  return out;
}

// A page's own size, with the same A4 fallback layout.js uses.
export function pageSizeOf(page) {
  return {
    w: Number.isFinite(page?.w) && page.w > 0 ? page.w : DEFAULT_PAGE_W,
    h: Number.isFinite(page?.h) && page.h > 0 ? page.h : DEFAULT_PAGE_H,
  };
}

// The full sheet in page coordinates. Passed to pageToPngBlob so the card is a
// picture of the PAGE, not a tight crop of whatever ink is on it.
export function fullPageBounds(page) {
  const { w, h } = pageSizeOf(page);
  return { minX: 0, minY: 0, maxX: w, maxY: h };
}

function textureFor(page) {
  return pageToPngBlob(page, { scale: THUMB_SCALE, bounds: fullPageBounds(page) });
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

// Same runtime injection as ui/library.js: no bundler, no import side effects.
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./pages-panel.css', import.meta.url).href;
  link.id = CSS_ID;
  (document.head || document.documentElement)?.appendChild(link);
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

export function buildPagesPanel(actions = {}) {
  injectStyles();

  const root = el('aside', 'pages-panel');
  root.hidden = true;
  root.setAttribute('aria-label', 'Pages');

  // --- state mirrored from the app ----------------------------------------
  let pages = [];
  let pageIndex = 0;
  let query = '';

  // key -> { signature, url, objectUrl }
  const cache = new Map();
  // key -> { signature, slot } for the cards currently on screen.
  let wanted = new Map();
  // key -> signature currently being rendered (or queued).
  const pending = new Map();
  let queue = [];
  let scheduled = false;

  // ---------------------------------------------------------------- header
  const head = el('div', 'pp-head');
  head.appendChild(el('span', 'pp-title', 'All Pages'));
  const countEl = el('span', 'pp-count', '0');
  head.appendChild(countEl);
  const closeBtn = el('button', 'pp-close', '\u00d7');
  closeBtn.type = 'button';
  closeBtn.title = 'Close pages';
  closeBtn.setAttribute('aria-label', 'Close pages');
  closeBtn.addEventListener('click', () => close());
  head.appendChild(closeBtn);
  root.appendChild(head);

  // ---------------------------------------------------------------- search
  const searchWrap = el('div', 'pp-search');
  const searchInput = el('input', 'pp-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search pages';
  searchInput.setAttribute('aria-label', 'Search pages by name');
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    renderList();
  });
  searchWrap.appendChild(searchInput);
  root.appendChild(searchWrap);

  // ------------------------------------------------------------------ list
  const list = el('div', 'pp-list');
  root.appendChild(list);

  // --------------------------------------------------------------- add page
  const addBtn = el('button', 'pp-add');
  addBtn.type = 'button';
  addBtn.appendChild(el('span', 'pp-add-plus', '+'));
  addBtn.appendChild(el('span', 'pp-add-label', 'Add page'));
  addBtn.addEventListener('click', () => actions.onAddPage?.());
  root.appendChild(addBtn);

  // --------------------------------------------------------------- helpers
  function pageKey(page, index) {
    return page?.id != null ? `id:${page.id}` : `index:${index}`;
  }

  function sourceUrl(source) {
    if (typeof source === 'string') return { url: source, objectUrl: false };
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return { url: URL.createObjectURL(source), objectUrl: true };
    }
    return { url: '', objectUrl: false };
  }

  function revoke(entry) {
    if (entry?.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(entry.url);
    }
  }

  function applyThumb(slot, url) {
    if (!slot || !url) return;
    slot.textContent = '';
    slot.classList.remove('is-empty');
    const img = document.createElement('img');
    img.className = 'pp-thumb-img';
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    slot.appendChild(img);
  }

  function schedulePump() {
    if (scheduled) return;
    scheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (raf) {
      raf(() => {
        scheduled = false;
        pump();
      });
      return;
    }
    setTimeout(() => {
      scheduled = false;
      pump();
    }, 16);
  }

  // One thumbnail per frame. A page that is no longer on screen (or whose
  // content changed again while it waited) is dropped rather than rendered.
  function pump() {
    const job = queue.shift();
    if (job) runJob(job);
    if (queue.length) schedulePump();
  }

  function queueThumb(key, signature, page) {
    if (pending.get(key) === signature) return;
    pending.set(key, signature);
    queue.push({ key, signature, page });
    schedulePump();
  }

  async function runJob(job) {
    if (pending.get(job.key) !== job.signature) return;
    const want = wanted.get(job.key);
    if (!want || want.signature !== job.signature) {
      pending.delete(job.key);
      return;
    }
    let source;
    try {
      const render = actions.renderThumbnail || textureFor;
      source = await render(job.page, job.key);
    } catch {
      // A thumbnail is a nicety: never let one break the list.
      pending.delete(job.key);
      return;
    }
    if (pending.get(job.key) !== job.signature) return;
    const { url, objectUrl } = sourceUrl(source);
    if (!url) {
      pending.delete(job.key);
      return;
    }
    const prev = cache.get(job.key);
    if (prev && prev.url !== url) revoke(prev);
    cache.set(job.key, { signature: job.signature, url, objectUrl });
    pending.delete(job.key);
    const slot = wanted.get(job.key);
    if (slot && slot.signature === job.signature) applyThumb(slot.slot, url);
  }

  // Test/automation hook: drain the queue synchronously instead of waiting for
  // frames. The editor never needs it; the panel test does.
  async function flush() {
    while (queue.length > 0) {
      const job = queue.shift();
      await runJob(job);
    }
  }

  function menuItem(label, onClick, extra = '') {
    const b = el('button', `pp-menu-item ${extra}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // -------------------------------------------------------------- rendering
  function renderList() {
    const entries = filterPageEntries(pages, query);
    countEl.textContent = String(entries.length);
    list.textContent = '';

    const nextWanted = new Map();
    const liveKeys = new Set();

    for (const entry of entries) {
      const { page, index } = entry;
      const key = pageKey(page, index);
      const signature = pageSignature(page);
      const size = pageSizeOf(page);
      liveKeys.add(key);

      const card = el('div', 'pp-card');
      if (index === pageIndex) {
        card.classList.add('is-current');
        card.setAttribute('aria-current', 'page');
      }

      const main = el('button', 'pp-card-main');
      main.type = 'button';
      const name = String(page?.name ?? '').trim();
      main.setAttribute('aria-label', name ? `Page ${index + 1}: ${name}` : `Page ${index + 1}`);

      const thumb = el('div', 'pp-thumb');
      thumb.style.aspectRatio = `${size.w} / ${size.h}`;
      const cached = cache.get(key);
      if (cached && cached.signature === signature) {
        applyThumb(thumb, cached.url);
      } else {
        thumb.classList.add('is-empty');
        queueThumb(key, signature, page);
      }
      main.appendChild(thumb);
      main.addEventListener('click', () => actions.onScrollToPage?.(index));
      card.appendChild(main);

      // The card footer: page number under the thumbnail, and the page menu.
      const foot = el('div', 'pp-foot');
      foot.appendChild(el('span', 'pp-num', String(index + 1)));

      const menu = el('div', 'pp-menu');
      menu.hidden = true;
      menu.appendChild(
        menuItem('Duplicate page', () => {
          menu.hidden = true;
          actions.onDuplicatePage?.(index);
        }),
      );
      menu.appendChild(
        menuItem('Clear page', () => {
          menu.hidden = true;
          actions.onClearPage?.(index);
        }),
      );
      menu.appendChild(
        menuItem('Delete page', () => {
          menu.hidden = true;
          actions.onDeletePage?.(index);
        }, 'pp-menu-item-danger'),
      );

      const moreBtn = el('button', 'pp-more', '\u22ef');
      moreBtn.type = 'button';
      moreBtn.title = 'Page options';
      moreBtn.setAttribute('aria-label', 'Page options');
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      foot.appendChild(moreBtn);
      card.appendChild(foot);
      card.appendChild(menu);

      list.appendChild(card);
      nextWanted.set(key, { signature, slot: thumb });
    }

    wanted = nextWanted;

    // Drop thumbnails for pages that no longer exist.
    for (const [key, entry] of [...cache]) {
      if (liveKeys.has(key)) continue;
      revoke(entry);
      cache.delete(key);
      pending.delete(key);
    }
    for (const key of [...pending.keys()]) {
      if (!liveKeys.has(key)) pending.delete(key);
    }
  }

  renderList();

  // ------------------------------------------------------------- public API
  function open() {
    root.hidden = false;
    // Catch up on anything that changed while the panel was closed.
    renderList();
  }

  function close() {
    root.hidden = true;
  }

  return {
    element: root,
    update(state = {}) {
      if (state.pages) pages = state.pages;
      if (state.pageIndex !== undefined) pageIndex = state.pageIndex;
      if (state.query !== undefined && state.query !== query) {
        query = state.query;
        if (searchInput.value !== query) searchInput.value = query;
      }
      renderList();
    },
    setQuery(value) {
      query = value;
      searchInput.value = value;
      renderList();
    },
    open,
    close,
    toggle() {
      if (root.hidden) open();
      else close();
    },
    isOpen: () => !root.hidden,
    flush,
  };
}
