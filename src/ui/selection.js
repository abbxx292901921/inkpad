// ui/selection.js — the selection + transform overlay.
//
// WHY A DOM OVERLAY AND NOT CANVAS PIXELS: the handles have to be real,
// tappable, focusable elements. A 12px dot painted on the canvas cannot be
// hit-tested by a fingertip and cannot take keyboard focus, so the box, the
// eight handles and the rotation handle are DOM elements in a fixed,
// click-through layer above the canvas.
//
// The look comes from design/notability-ui-spec.md §5: a blue dashed box with
// rounded corners, round blue corner handles centred on the corners, and a
// short line leaving the right edge midpoint ending in a small dark dot.
//
// COORDINATES: the app owns the geometry. This module turns PAGE bounds into
// screen pixels through src/coord.js (pageToScreen) — the only place that
// conversion happens — and reports every drag back in SCREEN PIXELS. The app
// divides by the zoom to get page units before calling src/transform.js.
//
// CALLBACK PAYLOADS (all distances in screen pixels):
//   dx, dy      the movement since the previous callback (what the app
//               applies to the live strokes)
//   x, y        the current pointer position, in viewport (client) pixels
//   startX/Y    where the pointer went down, in viewport pixels
//   totalDx/Y   the total movement since the pointer went down
// The absolute positions are there so a rotation can work out the angle of
// the finger around the centre of the box.

import { pageToScreen } from '../coord.js';
import { handlePositions, HANDLE_NAMES } from '../transform.js';
import { icon } from './icons.js';
import { el } from './popover.js';

const HANDLE_LABELS = {
  tl: 'Resize from top-left',
  t: 'Resize from top edge',
  tr: 'Resize from top-right',
  r: 'Resize from right edge',
  br: 'Resize from bottom-right',
  b: 'Resize from bottom edge',
  bl: 'Resize from bottom-left',
  l: 'Resize from left edge',
  rot: 'Rotate',
};

// The four edge midpoints get a quieter handle than the corners.
const EDGE_HANDLES = new Set(['t', 'r', 'b', 'l']);

// theme.css is owned by another agent, so the selection styles ship in their
// own file and are linked in at runtime. Same pattern as ui/library.js.
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('selection-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./selection.css', import.meta.url).href;
  link.id = 'selection-css';
  document.head.appendChild(link);
}

// A pointer drag on one element.
//
// The pointer is captured so the gesture survives the finger leaving the
// handle, and the moves are reported incrementally (dx, dy) together with
// the absolute pointer position.
//
// `busy` is shared by every handle: only ONE drag may run at a time, or a
// second finger (a palm on an iPad) would move the selection twice.
function dragify(target, onMove, busy) {
  target.addEventListener('pointerdown', (e) => {
    if (busy.active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Keep the gesture away from the canvas: the app must not start a stroke
    // under a handle.
    e.stopPropagation();
    e.preventDefault();
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;
    busy.active = true;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Capture is a nicety; the drag still works without it.
    }
    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      onMove?.({
        dx,
        dy,
        x: ev.clientX,
        y: ev.clientY,
        startX,
        startY,
        totalDx: ev.clientX - startX,
        totalDy: ev.clientY - startY,
      });
    };
    const end = (ev) => {
      if (ev.pointerId !== pointerId) return;
      busy.active = false;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      target.removeEventListener('lostpointercapture', end);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
  });
}

export function buildSelection({
  onMove,
  onScale,
  onRotate,
  onSelectAll,
  onDeselect,
  onDuplicateSelection,
  onDeleteSelection,
  // The viewport (zoom + pan) used to place the box. The app owns it.
  getViewport = () => ({ zoom: 1, panX: 0, panY: 0 }),
  // Where the canvas sits in the viewport. pageToScreen() returns canvas
  // relative pixels, so the overlay (which is fixed to the window) has to add
  // this offset.
  getCanvasRect = () => ({ left: 0, top: 0 }),
  // The reference screenshot shows corner handles only. The edge handles are
  // here because they are useful; turn them off to match the photo exactly.
  showEdgeHandles = true,
} = {}) {
  injectStyles();

  const overlay = el('div', 'sel-overlay');
  overlay.setAttribute('role', 'group');
  overlay.setAttribute('aria-label', 'Selection');

  const box = el('div', 'sel-box');
  overlay.appendChild(box);

  const handles = new Map();
  const busy = { active: false };
  for (const name of HANDLE_NAMES) {
    const h = el('div', `sel-handle sel-handle-${name}${EDGE_HANDLES.has(name) ? ' is-edge' : ''}`);
    h.setAttribute('role', 'button');
    h.setAttribute('tabindex', '0');
    h.setAttribute('aria-label', HANDLE_LABELS[name]);
    h.title = HANDLE_LABELS[name];
    if (!showEdgeHandles && EDGE_HANDLES.has(name)) h.hidden = true;
    dragify(h, (payload) => onScale?.(name, payload), busy);
    overlay.appendChild(h);
    handles.set(name, h);
  }

  // The rotation handle: a short line leaving the right edge midpoint,
  // ending in a small dark dot.
  const rot = el('div', 'sel-rot');
  rot.setAttribute('role', 'button');
  rot.setAttribute('tabindex', '0');
  rot.setAttribute('aria-label', HANDLE_LABELS.rot);
  rot.title = HANDLE_LABELS.rot;
  rot.appendChild(el('div', 'sel-rot-line'));
  rot.appendChild(el('div', 'sel-rot-dot'));
  dragify(rot, (payload) => onRotate?.(payload), busy);
  overlay.appendChild(rot);

  // The action row sits above the box: small white pills that match the blue
  // accent of the handles.
  const actionRow = el('div', 'sel-actions');
  const duplicateBtn = el('button', 'sel-action');
  duplicateBtn.type = 'button';
  duplicateBtn.title = 'Duplicate';
  duplicateBtn.setAttribute('aria-label', 'Duplicate selection');
  duplicateBtn.appendChild(icon('pages', { size: 14 }));
  duplicateBtn.appendChild(el('span', 'sel-action-label', 'Duplicate'));
  duplicateBtn.addEventListener('click', () => onDuplicateSelection?.());

  const deleteBtn = el('button', 'sel-action sel-action-danger');
  deleteBtn.type = 'button';
  deleteBtn.title = 'Delete';
  deleteBtn.setAttribute('aria-label', 'Delete selection');
  deleteBtn.appendChild(icon('trash', { size: 14 }));
  deleteBtn.appendChild(el('span', 'sel-action-label', 'Delete'));
  deleteBtn.addEventListener('click', () => onDeleteSelection?.());

  actionRow.appendChild(duplicateBtn);
  actionRow.appendChild(deleteBtn);
  overlay.appendChild(actionRow);

  // Dragging the interior of the box moves the selection.
  dragify(box, (payload) => onMove?.(payload), busy);

  let visible = false;

  function hide() {
    overlay.hidden = true;
  }

  function update(state = {}) {
    if (state.visible !== undefined) visible = Boolean(state.visible);
    const b = state.bounds;
    if (!visible || !b) {
      hide();
      return;
    }
    const viewport = getViewport() ?? { zoom: 1, panX: 0, panY: 0 };
    const rect = getCanvasRect() ?? { left: 0, top: 0 };
    const ox = rect.left ?? 0;
    const oy = rect.top ?? 0;

    const tl = pageToScreen(b.minX, b.minY, viewport);
    const br = pageToScreen(b.maxX, b.maxY, viewport);
    box.style.left = `${tl.x + ox}px`;
    box.style.top = `${tl.y + oy}px`;
    box.style.width = `${Math.max(0, br.x - tl.x)}px`;
    box.style.height = `${Math.max(0, br.y - tl.y)}px`;
    // A rotated selection supplies its own handle positions; the box then
    // turns with them.
    box.style.transform = typeof state.angle === 'number' ? `rotate(${state.angle}rad)` : '';

    const pos = state.handles ?? handlePositions(b);
    for (const name of HANDLE_NAMES) {
      const h = handles.get(name);
      const p = pos?.[name];
      if (!h) continue;
      if (!p) {
        h.style.display = 'none';
        continue;
      }
      h.style.display = '';
      const s = pageToScreen(p.x, p.y, viewport);
      h.style.left = `${s.x + ox}px`;
      h.style.top = `${s.y + oy}px`;
    }

    // The rotation handle hangs off the right edge midpoint.
    const rp = pos?.r ?? handlePositions(b)?.r;
    if (rp) {
      const rs = pageToScreen(rp.x, rp.y, viewport);
      rot.style.left = `${rs.x + ox}px`;
      rot.style.top = `${rs.y + oy}px`;
      rot.style.display = '';
    } else {
      rot.style.display = 'none';
    }

    // The action row hangs above the box, or below it when the box is too
    // close to the top of the screen.
    const above = tl.y + oy > 48;
    actionRow.style.left = `${(tl.x + br.x) / 2 + ox}px`;
    actionRow.style.top = `${(above ? tl.y : br.y) + oy + (above ? -8 : 8)}px`;
    actionRow.classList.toggle('is-below', !above);

    overlay.hidden = false;
  }

  function setVisible(on) {
    visible = Boolean(on);
    if (visible) overlay.hidden = false;
    else hide();
  }

  // Escape drops the selection, Cmd/Ctrl+A extends it to the whole page.
  function onKeyDown(e) {
    if (!visible) return;
    if (e.key === 'Escape') {
      onDeselect?.();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      onSelectAll?.();
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
  }

  return {
    element: overlay,
    update,
    setVisible,
    isVisible: () => !overlay.hidden,
    destroy() {
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onKeyDown);
      }
      overlay.remove();
    },
  };
}
