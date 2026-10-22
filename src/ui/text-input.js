// ui/text-input.js — the floating text input the user types into.
//
// WHY A DOM FIELD AND NOT CANVAS TEXT: typing needs a real text field — a
// caret, an on-screen keyboard, an IME, selection inside the field. The
// canvas can provide none of that, so the app opens a transparent <textarea>
// over the page, the user types into it, and the result is committed as a
// text object.
//
// THE OVERLAY MUST NOT STEAL A STROKE: the root is pointer-events: none and
// only the field and the Done button take pointer events, so a stroke can
// still start anywhere else on the page.
//
// THE KEYBOARD MUST NOT COVER THE TEXT: the on-screen keyboard shrinks the
// VISUAL viewport, so the field is clamped to visualViewport, not to
// window.innerHeight. When there is no room below the tap, the field slides
// up and sits above the keyboard.
//
// The styles ship in their own file and are linked in at runtime: there is no
// build step, so a CSS import would not work.

import { el } from './popover.js';
import { DEFAULT_TEXT_SIZE, TEXT_FONT_STACK } from '../text.js';

// iOS zooms the whole page when a focused field is smaller than 16px, so the
// input never goes below that. The size the user picked is still what gets
// committed to the page.
const MIN_INPUT_FONT_PX = 16;

// The gap kept between the field and the edge of the visible area.
const MARGIN = 8;

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('text-input-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./text-input.css', import.meta.url).href;
  link.id = 'text-input-css';
  document.head.appendChild(link);
}

export function buildTextInput({ onCommit, onCancel } = {}) {
  injectStyles();

  const root = el('div', 'txi');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Add text');
  root.hidden = true;

  const box = el('div', 'txi-box');

  const field = el('textarea', 'txi-field');
  field.rows = 2;
  field.setAttribute('aria-label', 'Text');
  field.setAttribute('autocapitalize', 'sentences');
  field.setAttribute('autocorrect', 'off');
  field.setAttribute('spellcheck', 'false');

  const hint = el('div', 'txi-hint', 'Type, then press Done');

  const done = el('button', 'txi-done', 'Done');
  done.type = 'button';

  box.appendChild(field);
  box.appendChild(hint);
  box.appendChild(done);
  root.appendChild(box);

  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(root);
  }

  let open = false;
  let anchorX = 0;
  let anchorY = 0;

  // The visible part of the screen, in CSS pixels. The on-screen keyboard
  // shrinks visualViewport, so that — not window.innerHeight — is the area
  // the field has to stay inside.
  function visibleArea() {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv) {
      return {
        left: vv.offsetLeft || 0,
        top: vv.offsetTop || 0,
        width: vv.width,
        height: vv.height,
      };
    }
    if (typeof window === 'undefined') return { left: 0, top: 0, width: 0, height: 0 };
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  // Put the field at the tap point, clamped into the visible area. When the
  // keyboard has eaten the lower half of the screen, the field slides up so
  // it ends up ABOVE the keyboard instead of behind it.
  function place() {
    if (!open) return;
    const area = visibleArea();
    const w = box.offsetWidth || 260;
    const h = box.offsetHeight || 120;
    const maxLeft = area.left + area.width - w - MARGIN;
    const maxTop = area.top + area.height - h - MARGIN;
    const left = Math.max(area.left + MARGIN, Math.min(anchorX, maxLeft));
    const top = Math.max(area.top + MARGIN, Math.min(anchorY, maxTop));
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  }

  function close() {
    open = false;
    root.hidden = true;
    // Blur drops the on-screen keyboard.
    try {
      field.blur();
    } catch {
      // Not focusable in this environment; nothing to do.
    }
  }

  function cancel() {
    if (!open) return;
    close();
    if (onCancel) onCancel();
  }

  function commit() {
    if (!open) return;
    const text = field.value.trim();
    // Nothing typed is a cancel, not an empty text box on the page.
    if (!text) {
      cancel();
      return;
    }
    close();
    if (onCommit) onCommit(text);
  }

  // A tap anywhere outside the field dismisses the input. Capture phase, so
  // the canvas sees the tap too and can start a stroke right after.
  function onDocPointerDown(e) {
    if (!open) return;
    if (box.contains(e.target)) return;
    cancel();
  }

  function onDocKeyDown(e) {
    if (!open) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }

  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  // The field and the button must not reach the canvas.
  for (const node of [field, done]) {
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  done.addEventListener('click', (e) => {
    e.stopPropagation();
    commit();
  });

  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter commits; Shift+Enter is the newline, for a multi-line text.
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  // The keyboard opening changes the visible area, so the field moves.
  if (typeof window !== 'undefined') {
    const vv = window.visualViewport;
    if (vv && typeof vv.addEventListener === 'function') {
      vv.addEventListener('resize', place);
      vv.addEventListener('scroll', place);
    }
    window.addEventListener('resize', place);
  }

  return {
    element: root,

    // Open the field at a SCREEN position (CSS pixels relative to the
    // viewport, not to the canvas). `size` is the size in CSS pixels.
    openAt(screenX, screenY, { color = '#1b1b1b', size = DEFAULT_TEXT_SIZE } = {}) {
      anchorX = Number(screenX) || 0;
      anchorY = Number(screenY) || 0;
      field.value = '';
      field.style.color = color;
      field.style.fontFamily = TEXT_FONT_STACK;
      field.style.fontSize = `${Math.max(MIN_INPUT_FONT_PX, Number(size) || 0)}px`;
      root.hidden = false;
      open = true;
      place();
      // The keyboard only comes up when the focus happens inside a user
      // gesture — openAt() is called from a pointer handler.
      try {
        field.focus({ preventScroll: true });
      } catch {
        field.focus();
      }
      place();
    },

    close,

    isOpen() {
      return open;
    },

    getValue() {
      return field.value;
    },

    setValue(text) {
      field.value = text === undefined || text === null ? '' : String(text);
    },
  };
}
