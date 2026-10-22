// ui/text-input.js — the floating text input the user types into.
//
// WHY A DOM FIELD AND NOT CANVAS TEXT: typing needs a real text field — a
// caret, an on-screen keyboard, an IME, selection inside the field. The
// canvas can provide none of that, so the app opens a transparent <textarea>
// over the box the user drew, the user types into it, and the result is
// committed as a text object.
//
// THE FIELD IS THE BOX: the user drags out a rectangle with the text tool and
// the textarea is sized to that rectangle, so the text appears inside the box
// and wraps at the same width the canvas will wrap it at.
//
// ENTER IS A NEWLINE, NOT A COMMIT: a text box holds paragraphs, so Enter
// breaks the line. The text is committed by the "Done" button (or
// Cmd/Ctrl+Enter) and cancelled with Escape.
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
// build step, so a CSS import would not work. The module is DOM-free at
// import time, so a Node test can import it.

import { el } from './popover.js';
import { DEFAULT_TEXT_SIZE, TEXT_FONT_STACK } from '../text.js';

// iOS zooms the whole page when a focused field is smaller than 16px, so the
// input never goes below that. The size the user picked is still what gets
// committed to the page.
const MIN_INPUT_FONT_PX = 16;

// The gap kept between the field and the edge of the visible area.
const MARGIN = 8;

// The size of the field when the app has no box to match (a plain tap).
const DEFAULT_WIDTH = 260;
const DEFAULT_HEIGHT = 64;

// The room the hint and the Done button need under the field.
const ACTIONS_H = 44;

// The class that lets the box shrink to the size of the field.
const SIZED = 'txi-box--sized';

function hasDom() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function injectStyles() {
  if (!hasDom()) return;
  if (document.getElementById('text-input-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./text-input.css', import.meta.url).href;
  link.id = 'text-input-css';
  document.head.appendChild(link);
}

export function buildTextInput({ onCommit, onCancel } = {}) {
  // Without a DOM there is nothing to build: hand back an inert handle so a
  // Node test can call this without exploding.
  if (!hasDom()) {
    return {
      element: null,
      openAt() {},
      close() {},
      isOpen() { return false; },
      getValue() { return ''; },
      setValue() {},
    };
  }

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

  const hint = el('div', 'txi-hint', 'Enter adds a line. Done saves.');

  const done = el('button', 'txi-done', 'Done');
  done.type = 'button';

  // The hint and the button hang BELOW the field, so they are not squeezed by
  // the width of the box the user drew.
  const actions = el('div', 'txi-actions');
  actions.appendChild(hint);
  actions.appendChild(done);

  box.appendChild(field);
  box.appendChild(actions);
  root.appendChild(box);

  if (document.body) document.body.appendChild(root);

  let open = false;
  let anchorX = 0;
  let anchorY = 0;
  // The size of the box the user drew, in CSS pixels. 0 means "no box".
  let boxW = 0;
  let boxH = 0;

  // The visible part of the screen, in CSS pixels. The on-screen keyboard
  // shrinks visualViewport, so that — not window.innerHeight — is the area
  // the field has to stay inside.
  function visibleArea() {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv) {
      return { left: vv.offsetLeft || 0, top: vv.offsetTop || 0, width: vv.width, height: vv.height };
    }
    if (typeof window === 'undefined') return { left: 0, top: 0, width: 0, height: 0 };
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  // Size the field to the drawn box and put it at the drawn corner.
  //
  // The field is clamped to the visible area as well: with the on-screen
  // keyboard up there is only so much room, and a field taller than that would
  // be hidden behind the keyboard instead of scrolled.
  function place() {
    if (!open) return;
    const area = visibleArea();
    const availW = Math.max(120, area.width - MARGIN * 2);
    const availH = Math.max(80, area.height - MARGIN * 2);
    const actionsH = actions.offsetHeight || ACTIONS_H;

    const wantW = boxW > 0 ? boxW : DEFAULT_WIDTH;
    const wantH = boxH > 0 ? boxH : DEFAULT_HEIGHT;
    const fieldW = Math.max(80, Math.min(wantW, availW));
    const fieldH = Math.max(28, Math.min(wantH, Math.max(28, availH - actionsH - 6)));

    box.classList.toggle(SIZED, boxW > 0);
    field.style.width = boxW > 0 ? `${Math.round(fieldW)}px` : '';
    field.style.height = `${Math.round(fieldH)}px`;

    const w = field.offsetWidth || fieldW;
    const h = field.offsetHeight || fieldH;
    const totalH = h + 6 + actionsH;
    const maxLeft = area.left + area.width - w - MARGIN;
    const maxTop = area.top + area.height - totalH - MARGIN;
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
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') cancel();
      else commit();
    }
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
    // The canvas listens for keys too: a key typed in the field is not a
    // shortcut for the page.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    // Cmd/Ctrl+Enter commits the box. A plain Enter (with or without Shift) is
    // the textarea's own newline: letting it through is what breaks the line.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
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
    // viewport, not to the canvas). `size` is the font size in CSS pixels;
    // `width` and `height` are the size of the box the user drew, also in CSS
    // pixels, so the field is the box the text is typed into.
    openAt(screenX, screenY, { color = '#1b1b1b', size = DEFAULT_TEXT_SIZE, width = 0, height = 0 } = {}) {
      anchorX = num(screenX);
      anchorY = num(screenY);
      boxW = Math.max(0, num(width));
      boxH = Math.max(0, num(height));
      field.value = '';
      field.style.color = color;
      field.style.fontFamily = TEXT_FONT_STACK;
      field.style.fontSize = `${Math.max(MIN_INPUT_FONT_PX, num(size))}px`;
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
