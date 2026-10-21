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
    b.appendChild(icon(t.icon));
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

  const fingerBtn = button('ticon', { label: 'Finger drawing', title: 'Finger drawing', onClick: () => actions.onToggleFingerDrawing() });
  rightPill.appendChild(fingerBtn);
  rightPill.appendChild(divider());

  const moreBtn = button('ticon', { label: 'More', title: 'More', onClick: (e) => actions.onOpenMore(e.currentTarget) });
  moreBtn.appendChild(icon('more'));
  rightPill.appendChild(moreBtn);

  bar.appendChild(rightPill);

  // ------------------------------------------------------------- pages pill
  const pagesPill = el('div', 'pill pill-pages');
  const prevBtn = button('ticon', {
    label: 'Previous page',
    title: 'Previous page',
    onClick: () => actions.onPrevPage(),
  });
  prevBtn.appendChild(icon('back'));
  const pageLabel = el('span', 'page-label', '1 / 1');
  const nextBtn = button('ticon', {
    label: 'Next page',
    title: 'Next page',
    onClick: () => actions.onNextPage(),
  });
  nextBtn.appendChild(icon('chevronRight'));
  pagesPill.appendChild(prevBtn);
  pagesPill.appendChild(pageLabel);
  pagesPill.appendChild(nextBtn);
  bar.appendChild(pagesPill);

  root.appendChild(bar);

  // ------------------------------------------------------------------ state
  let expanded = false;

  function setExpanded(on) {
    expanded = on;
    island.classList.toggle('is-expanded', expanded);
    expandBtn.setAttribute('aria-expanded', String(expanded));
    expandBtn.title = expanded ? 'Fewer options' : 'More options';
  }
  setExpanded(false);

  return {
    element: bar,
    setExpanded,
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
      undoBtn.disabled = !state.canUndo;
      redoBtn.disabled = !state.canRedo;
      fingerBtn.setAttribute('aria-pressed', String(!!state.fingerDrawing));
      fingerBtn.title = state.fingerDrawing
        ? 'Finger drawing ON — fingers draw as well as the Pencil. Tap for pen only.'
        : 'Pen only — fingers are ignored (palm rejection). Tap to allow finger drawing.';
      fingerBtn.setAttribute('aria-label', fingerBtn.title);
      const wantKey = state.fingerDrawing ? 'nibFinger' : 'nib';
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
      const count = state.pageCount ?? 1;
      const index = state.pageIndex ?? 0;
      pageLabel.textContent = `${index + 1} / ${count}`;
      prevBtn.disabled = index <= 0;
      nextBtn.disabled = index >= count - 1;
      pagesPill.hidden = count <= 1;
    },
  };
}
