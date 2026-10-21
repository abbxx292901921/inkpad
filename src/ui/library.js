// ui/library.js — the Notability-style library screen.
//
// Inkpad is a canvas app; the library is the one screen that is NOT a canvas.
// It is the two-pane browser from the Notability screenshots transcribed in
// design/notability-ui-spec.md §7: a folder sidebar on the left, a main pane
// on the right that shows the home dashboard, all notes, the gallery or the
// contents of one folder.
//
// Like ui/toolbar.js it is a stateless renderer: buildLibrary(root, actions)
// creates the DOM once, update(state) pushes a new state in, setScreen(name)
// switches the right-hand pane. The module never mutates the app's data — the
// only way out is the actions callbacks.
//
// The pure helpers (filterNotes, sortNotes, buildFolderTree, formatDate) are
// exported on their own so they can be tested in Node without a DOM. Nothing
// here touches `document` at import time, so the module is import-safe.

import { icon, ICONS } from './icons.js';
import { el, NS } from './popover.js';

// Icons the shared set does not have yet. Kept local (rather than edited into
// ui/icons.js) because this module must not touch other agents' files. Same
// 24x24 grid, same stroke conventions.
const LOCAL_ICONS = {
  search: { paths: [
    { d: 'M16 10.5 A 5.5 5.5 0 1 1 5 10.5 A 5.5 5.5 0 1 1 16 10.5', fill: false },
    { d: 'M14.4 14.4 L20 20', fill: false },
  ] },
  bell: { paths: [
    { d: 'M6.5 10 a5.5 5.5 0 0 1 11 0 c0 3.5 1.5 5 1.5 5 h-14 s1.5 -1.5 1.5 -5 Z', fill: false },
    { d: 'M10 18.5 a2 2 0 0 0 4 0', fill: false },
  ] },
  home: { paths: [
    { d: 'M4 11 L12 4 L20 11 L20 20 L14 20 L14 14.5 L10 14.5 L10 20 L4 20 Z', fill: false },
  ] },
  notes: { paths: [
    { d: 'M5 4 L14 4 L14 20 L5 20 Z', fill: false },
    { d: 'M8.5 4 L8.5 20', fill: false },
    { d: 'M15 13.5 L19.5 9 L21.5 11 L17 15.5 L14.5 16 Z', fill: false },
  ] },
  download: { paths: [
    { d: 'M12 3 L12 14', fill: false },
    { d: 'M8 10.5 L12 14.5 L16 10.5', fill: false },
    { d: 'M4.5 16 L4.5 20.5 L19.5 20.5 L19.5 16', fill: false },
  ] },
};

const DEFAULT_QUOTE = {
  text: 'Do not wait to strike till the iron is hot; but make it hot by striking.',
  author: 'William Butler Yeats',
};

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'gallery', label: 'Gallery', icon: 'image' },
];

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

// Notes that match the query, by title or by folder name. An empty query
// matches everything (the caller decides how many to show).
export function filterNotes(notes, query) {
  const list = Array.isArray(notes) ? notes : [];
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return list.slice();
  return list.filter((n) => {
    const title = String(n?.title ?? '').toLowerCase();
    const folder = String(n?.folderName ?? '').toLowerCase();
    return title.includes(q) || folder.includes(q);
  });
}

// Newest first. The input array is never mutated.
export function sortNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  return list.slice().sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
}

// Folders -> a nested tree of { id, name, color, noteCount, children }.
// Roots are the folders with no parent, plus any folder whose parent is
// missing from the list (an orphan becomes a root rather than vanishing).
// Siblings are sorted by name.
export function buildFolderTree(folders) {
  const list = Array.isArray(folders) ? folders.filter(Boolean) : [];
  const byId = new Map();
  for (const f of list) {
    if (f.id === undefined || f.id === null) continue;
    byId.set(f.id, f);
  }

  const childrenOf = new Map();
  const roots = [];
  for (const f of byId.values()) {
    const parentId = f.parentId ?? null;
    if (parentId === null || !byId.has(parentId) || parentId === f.id) {
      roots.push(f);
      continue;
    }
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(f);
  }

  // Anything unreachable from a root is in a parent cycle: promote it so the
  // folder is never silently lost.
  const reachable = new Set();
  const stack = roots.map((f) => f.id);
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const kid of childrenOf.get(id) ?? []) {
      if (!reachable.has(kid.id)) stack.push(kid.id);
    }
  }
  for (const f of byId.values()) {
    if (!reachable.has(f.id)) {
      roots.push(f);
      reachable.add(f.id);
    }
  }

  const byName = (a, b) =>
    String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, { sensitivity: 'base' });

  const build = (node, ancestors) => {
    const seen = new Set(ancestors);
    seen.add(node.id);
    const kids = (childrenOf.get(node.id) ?? [])
      .filter((k) => !seen.has(k.id))
      .sort(byName);
    return {
      id: node.id,
      name: node.name ?? '',
      color: node.color ?? null,
      noteCount: node.noteCount ?? 0,
      children: kids.map((k) => build(k, seen)),
    };
  };

  return roots.sort(byName).map((r) => build(r, new Set()));
}

// "Oct 21, 2026". Returns '' for a missing or unparseable timestamp.
export function formatDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  return DATE_FMT.format(d);
}

// ---------------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------------

// An icon from the shared set when it exists, from LOCAL_ICONS otherwise.
function glyph(name, { size = 20, className = '' } = {}) {
  if (ICONS[name]) return icon(name, { size, className });
  const def = LOCAL_ICONS[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ico ${className}`.trim());
  svg.setAttribute('data-icon', name);
  if (!def) return svg;
  for (const p of def.paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', p.d);
    if (p.fill) path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
  }
  return svg;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return `rgba(142, 142, 147, ${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// theme.css is owned by another agent, so the library styles ship in their own
// file and are linked in at runtime. No build step, no import side effects at
// module load.
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('library-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./library.css', import.meta.url).href;
  link.id = 'library-css';
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// the screen
// ---------------------------------------------------------------------------

export function buildLibrary(root, actions = {}) {
  injectStyles();

  const lib = el('div', 'lib');
  lib.setAttribute('data-screen', 'home');

  // --- state we own (mirrors of what the app pushed in) -------------------
  let screen = 'home';
  let currentFolderId = null;
  let query = '';
  let notes = [];
  let folders = [];
  let folderById = new Map();
  let quote = DEFAULT_QUOTE;
  // A folder is expanded unless it was explicitly collapsed.
  const collapsed = new Set();
  let welcomeDismissed = false;
  let breakDismissed = false;
  let lastShowWelcome;
  let lastShowBreak;

  // ---------------------------------------------------------------- sidebar
  const side = el('aside', 'lib-side');
  side.setAttribute('aria-label', 'Library navigation');

  const gearBtn = el('button', 'lib-icon-btn');
  gearBtn.type = 'button';
  gearBtn.title = 'Settings';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.appendChild(glyph('gear'));
  gearBtn.addEventListener('click', () => actions.onSettings?.());
  side.appendChild(gearBtn);

  const searchWrap = el('div', 'lib-search');
  searchWrap.appendChild(glyph('search', { size: 16, className: 'lib-search-ico' }));
  const searchInput = el('input', 'lib-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search';
  searchInput.setAttribute('aria-label', 'Search notes');
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    actions.onSearch?.(query);
    render();
  });
  searchWrap.appendChild(searchInput);
  side.appendChild(searchWrap);

  const nav = el('nav', 'lib-nav');
  nav.setAttribute('aria-label', 'Sections');
  const navBtns = new Map();
  for (const item of NAV_ITEMS) {
    const b = el('button', 'lib-nav-item');
    b.type = 'button';
    b.appendChild(glyph(item.icon, { size: 18 }));
    b.appendChild(el('span', 'lib-nav-label', item.label));
    b.addEventListener('click', () => {
      screen = item.id;
      actions.onSelectScreen?.(item.id);
      render();
    });
    nav.appendChild(b);
    navBtns.set(item.id, b);
  }
  side.appendChild(nav);

  const foldersHead = el('div', 'lib-folders-head');
  foldersHead.appendChild(el('span', 'lib-label', 'Folders'));
  const newFolderBtn = el('button', 'lib-icon-btn lib-icon-btn-sm');
  newFolderBtn.type = 'button';
  newFolderBtn.title = 'New folder';
  newFolderBtn.setAttribute('aria-label', 'New folder');
  newFolderBtn.appendChild(glyph('add', { size: 18 }));
  newFolderBtn.addEventListener('click', () => actions.onNewFolder?.());
  foldersHead.appendChild(newFolderBtn);
  side.appendChild(foldersHead);

  const tree = el('ul', 'lib-tree');
  side.appendChild(tree);

  // ------------------------------------------------------------- main pane
  const main = el('main', 'lib-main');

  const top = el('header', 'lib-top');
  const topActions = el('div', 'lib-top-actions');

  const bellBtn = el('button', 'lib-icon-btn');
  bellBtn.type = 'button';
  bellBtn.title = 'Notifications';
  bellBtn.setAttribute('aria-label', 'Notifications');
  bellBtn.appendChild(glyph('bell'));
  bellBtn.addEventListener('click', () => actions.onNotifications?.());
  topActions.appendChild(bellBtn);

  const moreBtn = el('button', 'lib-icon-btn');
  moreBtn.type = 'button';
  moreBtn.title = 'More';
  moreBtn.setAttribute('aria-label', 'More options');
  moreBtn.appendChild(glyph('more'));
  moreBtn.addEventListener('click', () => actions.onMore?.());
  topActions.appendChild(moreBtn);

  const newBtn = el('button', 'lib-new');
  newBtn.type = 'button';
  newBtn.appendChild(el('span', 'lib-new-plus', '+'));
  newBtn.appendChild(el('span', null, 'New'));
  newBtn.addEventListener('click', () => actions.onNewNote?.());
  topActions.appendChild(newBtn);

  top.appendChild(topActions);
  main.appendChild(top);

  const scroll = el('div', 'lib-scroll');
  main.appendChild(scroll);

  // ------------------------------------------------------------ home screen
  const homeScreen = el('section', 'lib-screen lib-home');
  homeScreen.dataset.screen = 'home';
  const homeInner = el('div', 'lib-home-inner');

  // "Let's get started" — placeholder content the user can dismiss.
  const welcome = el('div', 'lib-welcome');
  const welcomeClose = closeButton('Dismiss the welcome block', () => {
    welcomeDismissed = true;
    welcome.hidden = true;
  });
  welcome.appendChild(welcomeClose);

  const logo = el('div', 'lib-logo');
  const logoImg = document.createElement('img');
  logoImg.className = 'lib-logo-img';
  logoImg.src = new URL('../../assets/logo.svg', import.meta.url).href;
  logoImg.alt = 'Inkpad';
  logoImg.width = 72;
  logoImg.height = 72;
  logo.appendChild(logoImg);
  welcome.appendChild(logo);

  welcome.appendChild(el('h1', 'lib-h1', "Let's get started"));

  const quoteBox = el('blockquote', 'lib-quote');
  const quoteText = el('p', 'lib-quote-text');
  const quoteCite = el('footer', 'lib-quote-cite');
  quoteBox.appendChild(quoteText);
  quoteBox.appendChild(quoteCite);
  welcome.appendChild(quoteBox);

  const actionRow = el('div', 'lib-actions');
  actionRow.appendChild(actionCard('mic', 'Record a lecture', 'lib-tint-orange', () => actions.onRecordAudio?.()));
  actionRow.appendChild(actionCard('download', 'Import a file', 'lib-tint-blue', () => actions.onImportFile?.()));
  actionRow.appendChild(actionCard('page', 'Find a template', 'lib-tint-grey', () => actions.onTemplate?.()));
  welcome.appendChild(actionRow);

  homeInner.appendChild(welcome);

  // Recent notes carousel.
  const recentSection = el('div', 'lib-section');
  recentSection.appendChild(el('h2', 'lib-h2', 'Recent notes'));
  const carousel = el('div', 'lib-carousel');
  recentSection.appendChild(carousel);
  homeInner.appendChild(recentSection);

  // Daily Brain Break — placeholder content the user can dismiss.
  const breakSection = el('div', 'lib-section');
  const breakHead = el('div', 'lib-section-head');
  breakHead.appendChild(el('h2', 'lib-h2', 'Daily Brain Break'));
  const breakClose = closeButton('Hide Daily Brain Break', () => {
    breakDismissed = true;
    breakSection.hidden = true;
  });
  breakHead.appendChild(breakClose);
  breakSection.appendChild(breakHead);

  const banner = el('div', 'lib-banner');
  banner.appendChild(el('span', 'lib-banner-new', 'NEW'));
  const bannerText = el('div', 'lib-banner-text');
  bannerText.appendChild(el('div', 'lib-banner-day', 'Day 1'));
  bannerText.appendChild(el('div', 'lib-banner-sub', 'Sliding Puzzle'));
  banner.appendChild(bannerText);
  const art = el('div', 'lib-banner-art');
  art.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 8; i += 1) {
    const tile = el('span', 'lib-tile');
    if (i === 4) tile.classList.add('is-slide');
    art.appendChild(tile);
  }
  banner.appendChild(art);
  breakSection.appendChild(banner);

  homeInner.appendChild(breakSection);
  homeScreen.appendChild(homeInner);
  scroll.appendChild(homeScreen);

  // ----------------------------------------------------------- notes screen
  const notesScreen = el('section', 'lib-screen');
  notesScreen.dataset.screen = 'notes';
  const notesPane = el('div', 'lib-pane');
  notesPane.appendChild(el('h1', 'lib-page-title', 'Notes'));
  const notesList = el('ul', 'lib-list');
  notesPane.appendChild(notesList);
  notesScreen.appendChild(notesPane);
  scroll.appendChild(notesScreen);

  // --------------------------------------------------------- gallery screen
  const galleryScreen = el('section', 'lib-screen');
  galleryScreen.dataset.screen = 'gallery';
  const galleryPane = el('div', 'lib-pane');
  galleryPane.appendChild(el('h1', 'lib-page-title', 'Gallery'));
  const galleryGrid = el('div', 'lib-grid');
  galleryPane.appendChild(galleryGrid);
  galleryScreen.appendChild(galleryPane);
  scroll.appendChild(galleryScreen);

  // ---------------------------------------------------------- folder screen
  const folderScreen = el('section', 'lib-screen');
  folderScreen.dataset.screen = 'folder';
  const folderPane = el('div', 'lib-pane');
  const folderTitle = el('h1', 'lib-page-title');
  folderPane.appendChild(folderTitle);
  const folderList = el('ul', 'lib-list');
  folderPane.appendChild(folderList);
  folderScreen.appendChild(folderPane);
  scroll.appendChild(folderScreen);

  lib.appendChild(side);
  lib.appendChild(main);
  if (root && typeof root.appendChild === 'function') root.appendChild(lib);

  // -------------------------------------------------------------- builders
  function closeButton(label, onClick) {
    const b = el('button', 'lib-close');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(glyph('close', { size: 14 }));
    b.addEventListener('click', onClick);
    return b;
  }

  function actionCard(iconName, label, tint, onClick) {
    const b = el('button', `lib-action ${tint}`);
    b.type = 'button';
    b.appendChild(glyph(iconName, { size: 32 }));
    b.appendChild(el('span', 'lib-action-label', label));
    b.addEventListener('click', onClick);
    return b;
  }

  // A page preview, or a blank page placeholder when there is no thumbnail.
  function thumbnail(note, extra = '') {
    const wrap = el('div', `lib-thumb ${extra}`.trim());
    if (note?.thumbnail) {
      const img = document.createElement('img');
      img.className = 'lib-thumb-img';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.remove();
        wrap.classList.add('is-blank');
      });
      img.src = note.thumbnail;
      wrap.appendChild(img);
    } else {
      wrap.classList.add('is-blank');
    }
    return wrap;
  }

  function chipFor(note) {
    const folder = folderById.get(note?.folderId);
    const name = folder?.name || note?.folderName;
    if (!name) return null;
    const chip = el('span', 'lib-chip');
    chip.textContent = name;
    const color = folder?.color;
    if (color) {
      chip.style.color = color;
      chip.style.background = hexToRgba(color, 0.16);
    }
    return chip;
  }

  // A vertical list row: thumbnail, title, date on the right.
  function noteRow(note) {
    const li = el('li', 'lib-row');
    const b = el('button', 'lib-row-btn');
    b.type = 'button';
    b.appendChild(thumbnail(note, 'lib-thumb-row'));
    b.appendChild(el('span', 'lib-row-title', note.title || 'Untitled'));
    b.appendChild(el('span', 'lib-row-date', formatDate(note.updatedAt)));
    b.addEventListener('click', () => actions.onOpenNote?.(note.id));
    li.appendChild(b);
    return li;
  }

  // A card for the carousel and the gallery.
  function noteCard(note, extra = '') {
    const b = el('button', `lib-card ${extra}`.trim());
    b.type = 'button';
    b.setAttribute('aria-label', `Open note ${note.title || 'Untitled'}`);
    b.appendChild(thumbnail(note, 'lib-thumb-card'));
    b.appendChild(el('span', 'lib-card-title', note.title || 'Untitled'));
    const meta = el('span', 'lib-card-meta');
    meta.appendChild(el('span', 'lib-card-date', formatDate(note.updatedAt)));
    b.appendChild(meta);
    const chip = chipFor(note);
    if (chip) b.appendChild(chip);
    b.addEventListener('click', () => actions.onOpenNote?.(note.id));
    return b;
  }

  function emptyState(text) {
    return el('div', 'lib-empty', text);
  }

  // ------------------------------------------------------------- rendering
  function renderTree(nodes, container) {
    for (const node of nodes) {
      const li = el('li', 'lib-tree-item');
      const row = el('div', 'lib-folder-row');

      if (node.children.length) {
        const chev = el('button', 'lib-chevron');
        chev.type = 'button';
        const isOpen = !collapsed.has(node.id);
        chev.setAttribute('aria-expanded', String(isOpen));
        chev.setAttribute('aria-label', `${isOpen ? 'Collapse' : 'Expand'} ${node.name}`);
        chev.title = isOpen ? 'Collapse' : 'Expand';
        chev.appendChild(glyph('chevronRight', { size: 14 }));
        chev.addEventListener('click', () => {
          if (collapsed.has(node.id)) collapsed.delete(node.id);
          else collapsed.add(node.id);
          render();
        });
        row.appendChild(chev);
      }

      const btn = el('button', 'lib-folder-btn');
      btn.type = 'button';
      const selected = node.id === currentFolderId;
      if (selected) btn.setAttribute('aria-current', 'true');
      const dot = el('span', 'lib-dot');
      dot.style.background = node.color || 'var(--muted)';
      btn.appendChild(dot);
      btn.appendChild(el('span', 'lib-folder-name', node.name));
      if (selected) btn.appendChild(el('span', 'lib-count', String(node.noteCount ?? 0)));
      btn.addEventListener('click', () => {
        currentFolderId = node.id;
        screen = 'folder';
        actions.onSelectFolder?.(node.id);
        render();
      });
      row.appendChild(btn);
      li.appendChild(row);

      if (node.children.length && !collapsed.has(node.id)) {
        const sub = el('ul', 'lib-tree lib-tree-sub');
        renderTree(node.children, sub);
        li.appendChild(sub);
      }
      container.appendChild(li);
    }
  }

  function renderHome() {
    const recent = filterNotes(notes, query);
    carousel.textContent = '';
    if (recent.length === 0) {
      carousel.appendChild(emptyState('No notes yet — tap + New to start one.'));
    } else {
      for (const note of recent) carousel.appendChild(noteCard(note));
    }
  }

  function renderNotes() {
    const list = filterNotes(notes, query);
    notesList.textContent = '';
    if (list.length === 0) {
      notesList.appendChild(emptyState('No notes match.'));
      return;
    }
    for (const note of list) notesList.appendChild(noteRow(note));
  }

  function renderGallery() {
    const list = filterNotes(notes, query);
    galleryGrid.textContent = '';
    if (list.length === 0) {
      galleryGrid.appendChild(emptyState('Nothing in the gallery yet.'));
      return;
    }
    for (const note of list) galleryGrid.appendChild(noteCard(note, 'lib-card-grid'));
  }

  function renderFolder() {
    const folder = folderById.get(currentFolderId);
    folderTitle.textContent = folder?.name ?? 'Folder';
    const list = filterNotes(
      notes.filter((n) => n.folderId === currentFolderId),
      query,
    );
    folderList.textContent = '';
    if (list.length === 0) {
      folderList.appendChild(emptyState('This folder is empty.'));
      return;
    }
    for (const note of list) folderList.appendChild(noteRow(note));
  }

  function render() {
    lib.dataset.screen = screen;

    // A folder is a kind of note list, so it keeps the "Notes" nav item lit.
    const activeNav = screen === 'folder' ? 'notes' : screen;
    for (const [id, b] of navBtns) {
      const active = id === activeNav;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }

    tree.textContent = '';
    renderTree(buildFolderTree(folders), tree);

    quoteText.textContent = quote?.text ?? DEFAULT_QUOTE.text;
    quoteCite.textContent = quote?.author ?? DEFAULT_QUOTE.author;

    welcome.hidden = welcomeDismissed;
    breakSection.hidden = breakDismissed;

    homeScreen.classList.toggle('is-active', screen === 'home');
    notesScreen.classList.toggle('is-active', screen === 'notes');
    galleryScreen.classList.toggle('is-active', screen === 'gallery');
    folderScreen.classList.toggle('is-active', screen === 'folder');

    renderHome();
    renderNotes();
    renderGallery();
    renderFolder();
  }

  render();

  return {
    element: lib,

    update(state = {}) {
      if (state.screen) screen = state.screen;
      if (state.currentFolderId !== undefined) currentFolderId = state.currentFolderId;
      if (state.query !== undefined && state.query !== query) {
        query = state.query;
        if (searchInput.value !== query) searchInput.value = query;
      }
      if (state.notes) notes = sortNotes(state.notes);
      if (state.folders) {
        // Fall back to a count derived from the notes when the app did not
        // supply one.
        const counts = new Map();
        for (const n of notes) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);
        folders = state.folders.map((f) => ({ ...f, noteCount: f.noteCount ?? counts.get(f.id) ?? 0 }));
      }
      if (state.quote !== undefined) quote = state.quote ?? DEFAULT_QUOTE;

      folderById = new Map(folders.map((f) => [f.id, f]));

      // An explicit change of showWelcome / showBrainBreak overrides a local
      // dismissal; a routine update with the same value does not.
      if (state.showWelcome !== undefined && state.showWelcome !== lastShowWelcome) {
        welcomeDismissed = state.showWelcome === false;
        lastShowWelcome = state.showWelcome;
      }
      if (state.showBrainBreak !== undefined && state.showBrainBreak !== lastShowBreak) {
        breakDismissed = state.showBrainBreak === false;
        lastShowBreak = state.showBrainBreak;
      }

      render();
    },

    setScreen(name) {
      if (name !== 'home' && name !== 'notes' && name !== 'gallery' && name !== 'folder') return;
      screen = name;
      render();
    },
  };
}
