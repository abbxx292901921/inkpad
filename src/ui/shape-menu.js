// ui/shape-menu.js — the shape submenu.
//
// Notability hides the shape kinds behind a small floating card: a row of
// five shape icons plus the Freeform / Boxed segmented control (design/
// notability-ui-spec.md §2 row 2 and §5b).
//
// Like the rest of the UI layer this is a stateless renderer: build once,
// push state in with update(state), act through the callbacks. It owns no
// data — the app holds the current shape and fill mode.
//
// theme.css belongs to another agent, so the card styles ship in their own
// file (src/ui/shape-menu.css) and are linked in at runtime.

import { icon } from './icons.js';
import { el } from './popover.js';
import { SHAPE_KINDS, SHAPE_LABELS } from '../shapes.js';

// The glyph for each shape kind (src/ui/icons.js).
const SHAPE_ICONS = {
  line: 'shapeLine',
  rect: 'shapeRect',
  ellipse: 'shapeEllipse',
  triangle: 'shapeTriangle',
  arrow: 'shapeArrow',
  custom: 'shapeCustom',
};

// The two DRAW modes. They differ in HOW you draw, not in how the shape is
// filled:
//   Boxed    — drag out a rectangle; the shape is fitted into it.
//   Freeform — draw the outline yourself; the shape IS that outline.
const DRAW_MODES = [
  { id: 'boxed', label: 'Boxed', icon: 'boxed', help: 'Drag a box and the shape fits inside it.' },
  { id: 'freeform', label: 'Freeform', icon: 'freeform', help: 'Draw the outline yourself.' },
];

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('shape-menu-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./shape-menu.css', import.meta.url).href;
  link.id = 'shape-menu-css';
  document.head.appendChild(link);
}

export function buildShapeMenu({ onSelectShape, onSelectMode, onClose } = {}) {
  // Import-safe: the module can be pulled into a Node test without a DOM.
  if (typeof document === 'undefined') {
    return {
      element: null,
      update() {},
      open() {},
      close() {},
      isOpen: () => false,
    };
  }

  injectStyles();

  const root = el('div', 'shape-menu');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Shapes');
  root.hidden = true;

  // --- the shape kinds ---
  const shapeRow = el('div', 'shape-menu-shapes');
  shapeRow.setAttribute('role', 'group');
  shapeRow.setAttribute('aria-label', 'Shape');
  const shapeBtns = new Map();
  for (const kind of SHAPE_KINDS) {
    const label = SHAPE_LABELS[kind] ?? kind;
    const b = el('button', 'shape-btn');
    b.type = 'button';
    b.dataset.shape = kind;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(icon(SHAPE_ICONS[kind] ?? 'shapes', { size: 22 }));
    b.addEventListener('click', () => {
      current.shape = kind;
      paint();
      onSelectShape?.(kind);
      // Picking a shape means "draw with this": the submenu gets out of the way.
      close();
    });
    shapeRow.appendChild(b);
    shapeBtns.set(kind, b);
  }
  root.appendChild(shapeRow);

  // --- boxed / freeform ---
  const seg = el('div', 'shape-menu-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'How to draw the shape');
  const segBtns = new Map();
  for (const mode of DRAW_MODES) {
    const b = el('button', 'shape-seg');
    b.type = 'button';
    b.dataset.mode = mode.id;
    b.title = `${mode.label} — ${mode.help}`;
    b.setAttribute('aria-label', `${mode.label}: ${mode.help}`);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(icon(mode.icon, { size: 16 }));
    b.appendChild(el('span', 'shape-seg-label', mode.label));
    b.addEventListener('click', () => {
      current.mode = mode.id;
      paint();
      onSelectMode?.(mode.id);
    });
    seg.appendChild(b);
    segBtns.set(mode.id, b);
  }
  root.appendChild(seg);

  document.body.appendChild(root);

  // --- state ---
  const current = { shape: 'rect', mode: 'boxed' };
  let anchor = null;

  function paint() {
    for (const [kind, b] of shapeBtns) {
      const on = kind === current.shape;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-active', on);
    }
    for (const [id, b] of segBtns) {
      const on = id === current.mode;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-active', on);
    }
  }

  // Place the card under the anchor, clamped to the viewport; flip above the
  // anchor when there is no room below. Same rule as the other popovers.
  function place() {
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const margin = 10;
    let left = a.left + a.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    let top = a.bottom + 8;
    if (top + h > window.innerHeight - margin) {
      const above = a.top - h - 8;
      top = above > margin ? above : Math.max(margin, window.innerHeight - h - margin);
    }
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  // Outside tap / pen -> close. Capture phase, so we see it before the canvas.
  function onDocPointerDown(e) {
    if (root.hidden) return;
    if (root.contains(e.target)) return;
    if (anchor && anchor.contains(e.target)) return;
    close();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && !root.hidden) {
      e.stopPropagation();
      close();
    }
  }

  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);

  function open(anchorEl) {
    anchor = anchorEl ?? anchor;
    root.hidden = false;
    place();
    // Re-place after layout settles.
    requestAnimationFrame(place);
    return root;
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    anchor = null;
    onClose?.();
  }

  paint();

  return {
    element: root,
    update(state = {}) {
      if (state.shape && SHAPE_KINDS.includes(state.shape)) current.shape = state.shape;
      if (state.mode && DRAW_MODES.some((m) => m.id === state.mode)) current.mode = state.mode;
      paint();
    },
    open,
    close,
    isOpen: () => !root.hidden,
    reposition: place,
  };
}
