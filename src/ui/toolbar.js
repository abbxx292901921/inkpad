// ui/toolbar.js — the Notability-style floating toolbar.
//
// Layout (all floating, all icon-only, all touch-sized):
//
//   ┌────────────── the island ──────────────┐   ┌── right pill ──┐
//   │ pen marker pencil eraser │ + │  v      │   │ u r │ finger ⋯ │
//   │ ● ● ● ● ● ●  + │ ═ stroke              │   └────────────────┘
//   └────────────────────────────────────────┘
//
// Row 1 is the tool row and is always visible. Tapping the chevron expands
// the island to reveal row 2, the context-sensitive options row. The island
// is ONE card that grows — matching the screenshots, where the expanded pill
// is a taller rounded rectangle, not a separate panel.
//
// The whole toolbar is a stateless renderer: build once, then push state in
// with update(state). All behaviour lives in the actions callbacks.

import { icon } from './icons.js';
import { el } from './popover.js';

function button(cls, { label, title, onClick } = {}) {
  const b = el('button', cls);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  if (title) b.title = title;
  b.setAttribute('aria-pressed', 'false');
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function divider() {
  const d = el('span', 'tdiv');
  d.setAttribute('aria-hidden', 'true');
  return d;
}

export function buildToolbar(root, actions) {
  const bar = el('div', 'topbar');

  // ---------------------------------------------------------------- island
  const pill = el('div', 'pill pill-center');
  const island = el('div', 'island');
  island.setAttribute('role', 'toolbar');
  island.setAttribute('aria-label', 'Drawing tools');

  // --- row 1: tools ---
  const rowTools = el('div', 'island-row');

  const toolBtns = new Map();
  for (const t of actions.tools) {
    const b = button('ticon', {
      label: t.label,
      title: t.label,
      onClick: () => actions.onSelectTool(t.id),
    });
    b.dataset.tool = t.id;
    b.appendChild(icon(t.id === 'select' ? 'lasso' : t.icon));
    rowTools.appendChild(b);
    toolBtns.set(t.id, b);
  }

  rowTools.appendChild(divider());

  const importBtn = button('ticon', {
    label: 'Import a file',
    title: 'Import a file (image or PDF)',
    onClick: (e) => actions.onImport(e.currentTarget),
  });
  importBtn.appendChild(icon('add'));
  rowTools.appendChild(importBtn);

  rowTools.appendChild(divider());

  const expandBtn = button('ticon ticon-chevron', {
    label: 'More options',
    title: 'More options',
    onClick: () => setExpanded(!expanded),
  });
  expandBtn.appendChild(icon('chevronDown'));
  rowTools.appendChild(expandBtn);

  island.appendChild(rowTools);

  // --- row 2: options (context sensitive) ---
  const rowOpts = el('div', 'island-row island-opts');

  const quickGroup = el('div', 'optgroup');
  const quickBtns = new Map();
  for (const hex of actions.quickColors) {
    const b = button('qswatch', {
      label: `Colour ${hex}`,
      title: hex,
      onClick: () => actions.onSelectColor(hex),
    });
    b.style.background = hex;
    if (hex.toLowerCase() === '#ffffff') b.classList.add('is-white');
    quickGroup.appendChild(b);
    quickBtns.set(hex, b);
  }
  const moreColors = button('qswatch qswatch-more', {
    label: 'All colours',
    title: 'All colours',
    onClick: (e) => actions.onOpenPalette(e.currentTarget),
  });
  moreColors.appendChild(icon('add', { size: 16 }));
  quickGroup.appendChild(moreColors);
  rowOpts.appendChild(quickGroup);

  rowOpts.appendChild(divider());

  const strokeGroup = el('div', 'optgroup');
  const strokeBtn = button('ticon ticon-stroke', {
    label: 'Stroke options',
    title: 'Stroke options',
    onClick: (e) => actions.onOpenStroke(e.currentTarget),
  });
  const strokeGlyph = icon('strokeWidth');
  strokeGlyph.setAttribute('class', 'ico stroke-glyph');
  strokeBtn.appendChild(strokeGlyph);
  strokeGroup.appendChild(strokeBtn);
  rowOpts.appendChild(strokeGroup);

  island.appendChild(rowOpts);
  pill.appendChild(island);
  bar.appendChild(pill);

  // ------------------------------------------------------------ right pill
  const rightPill = el('div', 'pill pill-right');

  const undoBtn = button('ticon', { label: 'Undo', title: 'Undo', onClick: () => actions.onUndo() });
  undoBtn.appendChild(icon('undo'));
  const redoBtn = button('ticon', { label: 'Redo', title: 'Redo', onClick: () => actions.onRedo() });
  redoBtn.appendChild(icon('redo'));
  rightPill.appendChild(undoBtn);
  rightPill.appendChild(redoBtn);
  rightPill.appendChild(divider());

  const aiBtn = button('ticon ticon-ai', {
    label: 'Ask AI',
    title: 'Ask AI about this page',
    onClick: (e) => actions.onAskAi(e.currentTarget),
  });
  aiBtn.appendChild(icon('sparkle'));
  rightPill.appendChild(aiBtn);

  const pagesBtn = button('ticon', {
    label: 'Pages',
    title: 'Page thumbnails',
    onClick: (e) => actions.onOpenPages?.(e.currentTarget),
  });
  pagesBtn.dataset.panel = 'pages';
  pagesBtn.appendChild(icon('pages'));
  rightPill.appendChild(pagesBtn);

  const fingerBtn = button('ticon', { label: 'Finger drawing', title: 'Finger drawing', onClick: () => actions.onToggleFingerDrawing() });
  rightPill.appendChild(fingerBtn);
  rightPill.appendChild(divider());

  const moreBtn = button('ticon', { label: 'More', title: 'More', onClick: (e) => actions.onOpenMore(e.currentTarget) });
  moreBtn.appendChild(icon('more'));
  rightPill.appendChild(moreBtn);

  bar.appendChild(rightPill);

  // ------------------------------------------------------------- back pill
  // Top-left on its own, like the reference: the page navigator moved to the
  // bottom of the screen when the document became scrollable.
  const backPill = el('div', 'pill pill-back');
  const backBtn = button('ticon', {
    label: 'All notes',
    title: 'All notes',
    onClick: () => actions.onBack(),
  });
  backBtn.appendChild(icon('library'));
  backPill.appendChild(backBtn);
  bar.appendChild(backPill);

  // ------------------------------------------------------------- pages pill
  // Rendered here but MOUNTED by the app in #bottomnav (bottom centre), so it
  // does not fight the tool island for the top bar.
  const pagesPill = el('div', 'pill pill-pages');
  const prevBtn = button('ticon', {
    label: 'Previous page',
    title: 'Previous page',
    onClick: () => actions.onPrevPage(),
  });
  prevBtn.appendChild(icon('chevronUp'));
  const pageLabel = el('span', 'page-label', '1 / 1');
  const nextBtn = button('ticon', {
    label: 'Next page',
    title: 'Next page',
    onClick: () => actions.onNextPage(),
  });
  nextBtn.appendChild(icon('chevronDown'));
  pagesPill.appendChild(prevBtn);
  pagesPill.appendChild(pageLabel);
  pagesPill.appendChild(nextBtn);

  root.appendChild(bar);

  // ------------------------------------------------------------------ state
  let expanded = false;

  function setPage(index = 0, count = 1) {
    pageLabel.textContent = `${index + 1} / ${count}`;
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= count - 1;
    // With one page there is nothing to navigate, and the pill would just
    // hover over the canvas for no reason.
    pagesPill.classList.toggle('is-solo', count <= 1);
  }
  setPage(0, 1);

  function setExpanded(on) {
    expanded = on;
    island.classList.toggle('is-expanded', expanded);
    expandBtn.setAttribute('aria-expanded', String(expanded));
    expandBtn.title = expanded ? 'Fewer options' : 'More options';
  }
  setExpanded(false);

  return {
    element: bar,
    pagesElement: pagesPill,
    backElement: backPill,
    setExpanded,
    setPage,
    isExpanded: () => expanded,
    update(state) {
      for (const [id, b] of toolBtns) {
        const on = id === state.tool;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('is-active', on);
      }
      for (const [hex, b] of quickBtns) {
        b.setAttribute('aria-pressed', String(hex.toLowerCase() === (state.color ?? '').toLowerCase()));
      }
      // The quick colour row and the stroke button are context sensitive.
      quickGroup.style.display = state.showColors === false ? 'none' : '';
      strokeGroup.style.display = state.showWidths === false ? 'none' : '';
      undoBtn.disabled = !state.canUndo;
      redoBtn.disabled = !state.canRedo;
      // The finger toggle has three states: the finger draws, the finger pans
      // the page, or the finger is ignored.
      const action = state.fingerAction ?? (state.fingerDrawing ? 'draw' : 'none');
      fingerBtn.setAttribute('aria-pressed', String(action !== 'none'));
      fingerBtn.dataset.action = action;
      const fingerText = {
        draw: 'Finger draws — a finger adds ink.',
        pan: 'Finger pans — one finger scrolls the page.',
        none: 'Finger ignored — only the Pencil draws.',
      }[action];
      fingerBtn.title = `${fingerText} Tap to change.`;
      fingerBtn.setAttribute('aria-label', fingerBtn.title);
      const wantKey = action === 'draw' ? 'nibFinger' : action === 'pan' ? 'pan' : 'nib';
      const cur = fingerBtn.querySelector('svg');
      if (!cur || cur.getAttribute('data-icon') !== wantKey) {
        fingerBtn.textContent = '';
        const i = icon(wantKey);
        i.setAttribute('data-icon', wantKey);
        fingerBtn.appendChild(i);
      }
      // The stroke button previews the current thickness.
      if (strokeGlyph) {
        const w = Math.max(1, Math.min(6, state.width ?? 3));
        strokeGlyph.style.setProperty('--stroke-w', `${w}px`);
      }
      // Page navigation.
      setPage(state.pageIndex ?? 0, state.pageCount ?? 1);
    },
  };
}
