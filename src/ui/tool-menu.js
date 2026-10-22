// ui/tool-menu.js — the per-tool quick menu.
//
// Tapping the tool that is already active opens a small floating card with
// that tool's own presets: a row of colours and a row of thicknesses for the
// ink tools, a row of sizes for the eraser. Notability puts the same thing
// behind each tool button; it keeps a colour change to one tap instead of
// "open the palette card, find the hue, close it".
//
// The full palette (hundreds of hues, the wheel) and the full stroke panel
// (the slider, line styles) stay where they were — this card is the quick
// path, and the app still owns every value (tools.js holds the state).
//
// Stateless renderer like the other menus: build once, update(state), act
// through callbacks. Styles ship in tool-menu.css, linked at runtime.

import { el } from './popover.js';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('tool-menu-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./tool-menu.css', import.meta.url).href;
  link.id = 'tool-menu-css';
  document.head.appendChild(link);
}

const MIN_DOT = 5;
const MAX_DOT = 17;

// Five evenly spaced presets across a range, deduplicated. The eraser's value
// is a radius and an ink tool's is a width, but to this card they are all
// just "the size".
export function sizePresets(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const out = [];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const v = Math.round(lo + (hi - lo) * f);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function buildToolMenu({ onPickColor, onPickSize, onClose } = {}) {
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

  const root = el('div', 'tool-menu');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Tool options');
  root.hidden = true;

  const title = el('div', 'tool-menu-title', 'Pen');
  root.appendChild(title);

  const colors = el('div', 'tool-menu-colors');
  colors.setAttribute('role', 'group');
  colors.setAttribute('aria-label', 'Colour');
  root.appendChild(colors);

  const sizes = el('div', 'tool-menu-sizes');
  sizes.setAttribute('role', 'group');
  sizes.setAttribute('aria-label', 'Thickness');
  root.appendChild(sizes);

  document.body.appendChild(root);

  // --- state ---
  const state = {
    label: '',
    color: '#000000',
    colorList: [],
    size: 4,
    sizeList: [],
    min: 1,
    max: 20,
  };
  let anchor = null;
  const colorBtns = [];
  const sizeBtns = [];

  // Buttons are created lazily up to the list length and REUSED across
  // updates; their handlers read the state at click time, so a repaint of
  // the lists never leaves a stale closure behind.
  function ensureButtons() {
    while (colorBtns.length < state.colorList.length) {
      const i = colorBtns.length;
      const b = el('button', 'tool-dot');
      b.type = 'button';
      b.title = 'Colour';
      b.addEventListener('click', () => onPickColor?.(state.colorList[i]));
      colors.appendChild(b);
      colorBtns.push(b);
    }
    while (sizeBtns.length < state.sizeList.length) {
      const i = sizeBtns.length;
      const b = el('button', 'tool-size');
      b.type = 'button';
      b.appendChild(el('span', 'tool-size-dot'));
      b.addEventListener('click', () => onPickSize?.(state.sizeList[i]));
      sizes.appendChild(b);
      sizeBtns.push(b);
    }
  }

  function dotPx(value) {
    if (!(state.max > state.min)) return (MIN_DOT + MAX_DOT) / 2;
    const t = (value - state.min) / (state.max - state.min);
    return Math.round(MIN_DOT + Math.max(0, Math.min(1, t)) * (MAX_DOT - MIN_DOT));
  }

  function paint() {
    title.textContent = state.label || 'Tool';
    colors.hidden = state.colorList.length === 0;
    state.colorList.forEach((hex, i) => {
      const b = colorBtns[i];
      if (!b) return;
      b.style.background = hex;
      b.classList.toggle('is-white', hex.toLowerCase() === '#ffffff');
      const on = hex.toLowerCase() === String(state.color).toLowerCase();
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', `Colour ${hex}`);
      b.classList.toggle('is-active', on);
    });
    state.sizeList.forEach((v, i) => {
      const b = sizeBtns[i];
      if (!b) return;
      const dot = b.firstChild;
      const d = dotPx(v);
      if (dot) {
        dot.style.width = `${d}px`;
        dot.style.height = `${d}px`;
      }
      b.title = String(v);
      b.setAttribute('aria-label', `Size ${v}`);
      const on = Math.abs(v - state.size) < 0.001;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-active', on);
    });
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
    ensureButtons();
    paint();
    place();
    requestAnimationFrame(place);
    return root;
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    anchor = null;
    onClose?.();
  }

  return {
    element: root,
    update(next = {}) {
      if (typeof next.label === 'string') state.label = next.label;
      if (Array.isArray(next.colors)) state.colorList = next.colors;
      if (typeof next.color === 'string') state.color = next.color;
      if (Array.isArray(next.sizes)) state.sizeList = next.sizes;
      if (Number.isFinite(next.size)) state.size = next.size;
      if (Number.isFinite(next.min)) state.min = next.min;
      if (Number.isFinite(next.max)) state.max = next.max;
      ensureButtons();
      paint();
    },
    open,
    close,
    isOpen: () => !root.hidden,
    reposition: place,
  };
}
