// ui/text-bar.js — the bottom formatting bar for text objects.
//
// Notability puts text formatting at the bottom of the screen, within thumb
// reach: family, size, colour, bold/italic/underline, list and alignment. The
// bar is shown while the text tool is active OR while a text object is in the
// selection.
//
// Like ui/toolbar.js this module is a stateless renderer: the app owns the
// document and the formatting defaults, buildTextBar() creates the DOM once,
// update(state) pushes a state in, and every control reports a PATCH through
// onPatch. The app decides whether that patch lands on the selected text or
// becomes the default for the next text box.
//
// DOM-free at import time, so a Node test can import this module.

import { el } from './popover.js';
import { TEXT_FAMILIES, MIN_TEXT_SIZE, MAX_TEXT_SIZE, clampTextSize } from '../text.js';

const FAMILY_LABELS = {
  sans: 'Sans',
  serif: 'Serif',
  mono: 'Mono',
  hand: 'Hand',
};

const LIST_ORDER = ['none', 'bullet', 'number'];
const ALIGN_ORDER = ['left', 'center', 'right'];
const ALIGN_LABELS = { left: 'Left', center: 'Center', right: 'Right' };

const DEFAULT_STATE = {
  visible: false,
  family: 'sans',
  size: 28,
  color: '#1b1b1b',
  bold: false,
  italic: false,
  underline: false,
  list: 'none',
  align: 'left',
};

function hasDom() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function injectStyles() {
  if (!hasDom()) return;
  if (document.getElementById('text-bar-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./text-bar.css', import.meta.url).href;
  link.id = 'text-bar-css';
  document.head.appendChild(link);
}

export function cycleList(list) {
  const i = LIST_ORDER.indexOf(list);
  return LIST_ORDER[(i + 1) % LIST_ORDER.length];
}

export function cycleAlign(align) {
  const i = ALIGN_ORDER.indexOf(align);
  return ALIGN_ORDER[(i + 1) % ALIGN_ORDER.length];
}

export function buildTextBar({ onPatch, onOpenColor } = {}) {
  // Without a DOM there is nothing to build: hand back an inert handle so a
  // Node test can call this without exploding.
  if (!hasDom()) {
    return {
      element: null,
      update() {},
      setVisible() {},
      isVisible() { return false; },
      reposition() {},
    };
  }

  injectStyles();

  let state = { ...DEFAULT_STATE };

  const root = el('div', 'text-bar');
  root.hidden = true;
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Text formatting');

  // The root is a click-through strip; only the card takes pointer events, so
  // a stroke can still start beside the bar.
  const card = el('div', 'tb-card');
  root.appendChild(card);

  function patch(next) {
    if (onPatch) onPatch(next);
  }

  // --- family ---------------------------------------------------------------
  const family = el('select', 'tb-select');
  family.setAttribute('aria-label', 'Font');
  for (const id of TEXT_FAMILIES) {
    const option = el('option', null, FAMILY_LABELS[id] ?? id);
    option.value = id;
    family.appendChild(option);
  }
  family.addEventListener('change', () => patch({ family: family.value }));
  card.appendChild(family);

  card.appendChild(el('span', 'tb-sep'));

  // --- size stepper ---------------------------------------------------------
  const sizeGroup = el('div', 'tb-size');
  const smaller = el('button', 'tb-step', '−');
  smaller.type = 'button';
  smaller.setAttribute('aria-label', 'Smaller text');
  const sizeValue = el('span', 'tb-size-value');
  const larger = el('button', 'tb-step', '+');
  larger.type = 'button';
  larger.setAttribute('aria-label', 'Larger text');
  smaller.addEventListener('click', () => {
    const next = clampTextSize(Number(state.size) - 1);
    if (next !== Number(state.size)) patch({ size: next });
  });
  larger.addEventListener('click', () => {
    const next = clampTextSize(Number(state.size) + 1);
    if (next !== Number(state.size)) patch({ size: next });
  });
  sizeGroup.appendChild(smaller);
  sizeGroup.appendChild(sizeValue);
  sizeGroup.appendChild(larger);
  card.appendChild(sizeGroup);

  // --- colour ---------------------------------------------------------------
  const swatch = el('button', 'tb-swatch');
  swatch.type = 'button';
  swatch.setAttribute('aria-label', 'Text colour');
  swatch.title = 'Text colour';
  swatch.addEventListener('click', () => {
    if (onOpenColor) onOpenColor(swatch);
  });
  card.appendChild(swatch);

  card.appendChild(el('span', 'tb-sep'));

  // --- bold / italic / underline -------------------------------------------
  const bold = el('button', 'tb-toggle tb-bold', 'B');
  bold.type = 'button';
  bold.setAttribute('aria-label', 'Bold');
  bold.addEventListener('click', () => patch({ bold: !state.bold }));

  const italic = el('button', 'tb-toggle tb-italic', 'I');
  italic.type = 'button';
  italic.setAttribute('aria-label', 'Italic');
  italic.addEventListener('click', () => patch({ italic: !state.italic }));

  const underline = el('button', 'tb-toggle tb-underline', 'U');
  underline.type = 'button';
  underline.setAttribute('aria-label', 'Underline');
  underline.addEventListener('click', () => patch({ underline: !state.underline }));

  card.appendChild(bold);
  card.appendChild(italic);
  card.appendChild(underline);

  card.appendChild(el('span', 'tb-sep'));

  // --- list -----------------------------------------------------------------
  const list = el('button', 'tb-toggle tb-list', '•');
  list.type = 'button';
  list.addEventListener('click', () => patch({ list: cycleList(state.list) }));
  card.appendChild(list);

  // --- align ----------------------------------------------------------------
  const align = el('button', 'tb-toggle tb-align', 'L');
  align.type = 'button';
  align.addEventListener('click', () => patch({ align: cycleAlign(state.align) }));
  card.appendChild(align);

  function setPressed(button, on) {
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(Boolean(on)));
  }

  function render() {
    const visible = state.visible === true;
    root.hidden = !visible;
    root.classList.toggle('is-on', visible);
    if (!visible) return;

    family.value = state.family;
    sizeValue.textContent = String(Math.round(Number(state.size)));
    smaller.disabled = Number(state.size) <= MIN_TEXT_SIZE;
    larger.disabled = Number(state.size) >= MAX_TEXT_SIZE;
    swatch.style.background = state.color || '#1b1b1b';
    swatch.setAttribute('aria-label', `Text colour ${state.color || ''}`.trim());

    setPressed(bold, state.bold);
    setPressed(italic, state.italic);
    setPressed(underline, state.underline);
    setPressed(list, state.list !== 'none');
    setPressed(align, state.align !== 'left');

    list.textContent = state.list === 'number' ? '1.' : '•';
    list.title = `List: ${state.list}`;
    list.setAttribute('aria-label', `List: ${state.list}`);
    align.textContent = { left: 'L', center: 'C', right: 'R' }[state.align] ?? 'L';
    align.title = `Align: ${ALIGN_LABELS[state.align] ?? 'Left'}`;
    align.setAttribute('aria-label', `Align: ${ALIGN_LABELS[state.align] ?? 'Left'}`);
  }

  render();

  return {
    element: root,
    update(next = {}) {
      state = { ...state, ...next };
      render();
    },
    setVisible(on) {
      state = { ...state, visible: on === true };
      render();
    },
    isVisible() {
      return state.visible === true;
    },
    // A fixed, full-width bar needs no per-frame placement. The hook exists so
    // the app can treat it like the other floating chrome.
    reposition() {},
  };
}
