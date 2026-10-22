// ui/select-menu.js — the selection mode submenu.
//
// The select tool has two gesture modes, and like the shape picker they live
// behind a small floating card: Freeform (draw a lasso loop) or Boxed (drag a
// marquee rectangle). Same segmented-control pattern as ui/shape-menu.js.
//
// Like the rest of the UI layer this is a stateless renderer: build once,
// push state in with update(state), act through the callbacks. It owns no
// data — the app holds the current mode in tools.js.
//
// theme.css belongs to another agent, so the card styles ship in their own
// file (src/ui/select-menu.css) and are linked in at runtime.

import { icon } from './icons.js';
import { el } from './popover.js';

const MODES = [
  { id: 'freeform', label: 'Freeform', icon: 'lasso', help: 'Draw a loop around the ink.' },
  { id: 'boxed', label: 'Boxed', icon: 'boxed', help: 'Drag a rectangle around the ink.' },
];

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('select-menu-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./select-menu.css', import.meta.url).href;
  link.id = 'select-menu-css';
  document.head.appendChild(link);
}

export function buildSelectMenu({ onSelectMode, onClose } = {}) {
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

  const root = el('div', 'select-menu');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Selection mode');
  root.hidden = true;

  const seg = el('div', 'select-menu-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'How to select');
  const segBtns = new Map();
  for (const mode of MODES) {
    const b = el('button', 'select-seg');
    b.type = 'button';
    b.dataset.mode = mode.id;
    b.title = `${mode.label} — ${mode.help}`;
    b.setAttribute('aria-label', `${mode.label}: ${mode.help}`);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(icon(mode.icon, { size: 16 }));
    b.appendChild(el('span', 'select-seg-label', mode.label));
    b.addEventListener('click', () => {
      current.mode = mode.id;
      paint();
      onSelectMode?.(mode.id);
      // Picking a mode means "select this way": the submenu gets out of the way.
      close();
    });
    seg.appendChild(b);
    segBtns.set(mode.id, b);
  }
  root.appendChild(seg);

  document.body.appendChild(root);

  // --- state ---
  const current = { mode: 'freeform' };
  let anchor = null;

  function paint() {
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
      if (state.mode && MODES.some((m) => m.id === state.mode)) current.mode = state.mode;
      paint();
    },
    open,
    close,
    isOpen: () => !root.hidden,
    reposition: place,
  };
}
