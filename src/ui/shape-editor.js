// ui/shape-editor.js — the vertex editor for shapes.
//
// WHY A DOM OVERLAY: the handles have to be real, tappable elements. A dot
// painted on the canvas cannot be hit-tested by a fingertip and cannot take
// keyboard focus, so the outline, the vertex handles and the two small
// buttons are DOM elements in a fixed, click-through layer above the canvas.
// Same pattern as ui/selection.js, which does the same job for the bounding
// box of a selection.
//
// COORDINATES: the app owns the geometry. This module turns PAGE vertices
// into screen pixels through src/coord.js (pageToScreen) — the only place
// that conversion happens — and turns a dragged handle back into PAGE
// units before it reports anything.
//
// CALLBACK PAYLOADS:
//   onChange({ stroke, index, x, y, snapped, target })  a vertex moved; x/y
//       are PAGE units, already snapped to any nearby geometry
//   onCommit(stroke)      the drag ended
//   onSquare(stroke)      the square preset was tapped
//   onDelete(stroke)      the delete button was tapped
//
// The editor NEVER mutates the shape itself: it reports the move and the app
// decides what to do with it (setVertex, a history entry, a redraw).

import { pageToScreen, screenToPage } from '../coord.js';
import { el } from './popover.js';
import { icon } from './icons.js';
import { isClosedShape, isShapeStroke, snapVertex, vertexPositions } from '../shapes.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// theme.css is owned by another agent, so the editor styles ship in their
// own file and are linked in at runtime. Same pattern as ui/library.js.
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('shape-editor-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./shape-editor.css', import.meta.url).href;
  link.id = 'shape-editor-css';
  document.head.appendChild(link);
}

// A pointer drag on one handle.
//
// The pointer is captured so the gesture survives the finger leaving the
// handle.
//
// `busy` is shared by every handle: only ONE drag may run at a time, or a
// second finger (a palm on an iPad) would move two vertices at once.
function dragify(target, onMove, onEnd, busy) {
  target.addEventListener('pointerdown', (e) => {
    if (busy.active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Keep the gesture away from the canvas: the app must not start a stroke
    // under a handle.
    e.stopPropagation();
    e.preventDefault();
    const pointerId = e.pointerId;
    busy.active = true;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Capture is a nicety; the drag still works without it.
    }
    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.stopPropagation();
      onMove?.(ev);
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
      onEnd?.(ev);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
  });
}

export function buildShapeEditor({
  onChange,
  onCommit,
  onDelete,
  onSquare,
  // The viewport (zoom + pan) used to place the handles. The app owns it.
  getViewport = () => ({ zoom: 1, panX: 0, panY: 0 }),
  // Where the canvas sits in the viewport. pageToScreen() returns canvas
  // relative pixels, so the overlay (which is fixed to the window) has to add
  // this offset.
  getCanvasRect = () => ({ left: 0, top: 0 }),
} = {}) {
  // Import-safe: the module can be pulled into a Node test without a DOM.
  if (typeof document === 'undefined') {
    return {
      element: null,
      update() {},
      setVisible() {},
      isVisible: () => false,
      destroy() {},
    };
  }

  injectStyles();

  const root = el('div', 'shape-editor');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Shape vertices');
  root.hidden = true;

  // The dashed outline of the shape. It is an SVG polyline, because a shape
  // can be any polygon and a border on a div can only be a rectangle.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'shape-editor-svg');
  svg.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(SVG_NS, 'polyline');
  outline.setAttribute('class', 'shape-editor-outline');
  svg.appendChild(outline);
  root.appendChild(svg);

  // The two small buttons: the square preset and delete.
  const tools = el('div', 'shape-editor-tools');
  const squareBtn = el('button', 'shape-editor-btn');
  squareBtn.type = 'button';
  squareBtn.title = 'Make it a square';
  squareBtn.setAttribute('aria-label', 'Make it a square');
  squareBtn.appendChild(icon('shapeRect', { size: 16 }));
  const deleteBtn = el('button', 'shape-editor-btn shape-editor-del');
  deleteBtn.type = 'button';
  deleteBtn.title = 'Delete the shape';
  deleteBtn.setAttribute('aria-label', 'Delete the shape');
  deleteBtn.appendChild(icon('trash', { size: 16 }));
  tools.appendChild(squareBtn);
  tools.appendChild(deleteBtn);
  root.appendChild(tools);

  const busy = { active: false };
  const handles = [];
  let stroke = null;
  let others = [];
  let visible = false;

  squareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (stroke) onSquare?.(stroke);
  });
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (stroke) onDelete?.(stroke);
  });

  // One handle per vertex. The handles are rebuilt only when the vertex count
  // changes, so a drag is never interrupted by a DOM rebuild.
  function ensureHandles(count) {
    while (handles.length < count) {
      const index = handles.length;
      const h = el('div', 'shape-editor-handle');
      h.setAttribute('role', 'button');
      h.setAttribute('tabindex', '0');
      h.setAttribute('aria-label', `Vertex ${index + 1}`);
      h.title = 'Drag to move this vertex';
      dragify(
        h,
        (ev) => dragVertex(index, ev),
        // Only a real lift commits: a cancelled pointer (the OS took the
        // gesture away) must not leave a history entry behind.
        (ev) => {
          if (ev.type === 'pointerup') onCommit?.(stroke);
        },
        busy,
      );
      root.appendChild(h);
      handles.push(h);
    }
    while (handles.length > count) {
      const h = handles.pop();
      h.remove();
    }
  }

  // A dragged handle: client pixels -> page units -> snapped page units.
  function dragVertex(index, ev) {
    if (!stroke) return;
    const viewport = getViewport() ?? { zoom: 1, panX: 0, panY: 0 };
    const rect = getCanvasRect() ?? { left: 0, top: 0 };
    const page = screenToPage(ev.clientX - (rect.left ?? 0), ev.clientY - (rect.top ?? 0), viewport);
    const snapped = snapVertex(stroke, index, page.x, page.y, { others });
    onChange?.({
      stroke,
      index,
      x: snapped.x,
      y: snapped.y,
      snapped: snapped.snapped,
      target: snapped.target,
    });
  }

  function hide() {
    root.hidden = true;
  }

  function update(state = {}) {
    if (state.visible !== undefined) visible = Boolean(state.visible);
    stroke = state.stroke ?? null;
    others = state.others ?? [];
    if (!visible || !stroke || !isShapeStroke(stroke)) {
      hide();
      return;
    }

    const viewport = getViewport() ?? { zoom: 1, panX: 0, panY: 0 };
    const rect = getCanvasRect() ?? { left: 0, top: 0 };
    const ox = rect.left ?? 0;
    const oy = rect.top ?? 0;
    const verts = vertexPositions(stroke);
    ensureHandles(verts.length);
    // A shape with many vertices (an ellipse) gets smaller handles, or they
    // would cover the shape they are editing.
    root.classList.toggle('is-dense', verts.length > 8);

    let points = '';
    let minX = Infinity;
    let minY = Infinity;
    for (let i = 0; i < verts.length; i += 1) {
      const s = pageToScreen(verts[i].x, verts[i].y, viewport);
      const x = s.x + ox;
      const y = s.y + oy;
      const h = handles[i];
      h.style.left = `${x}px`;
      h.style.top = `${y}px`;
      points += `${x},${y} `;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
    // Close the outline for a closed shape.
    if (isClosedShape(stroke.shape) && verts.length > 1) {
      const s = pageToScreen(verts[0].x, verts[0].y, viewport);
      points += `${s.x + ox},${s.y + oy}`;
    }
    outline.setAttribute('points', points.trim());

    // The buttons sit just above the shape's top-left corner.
    tools.style.left = `${Math.max(4, minX)}px`;
    tools.style.top = `${Math.max(4, minY - 36)}px`;

    root.hidden = false;
  }

  function setVisible(on) {
    visible = Boolean(on);
    if (visible) root.hidden = false;
    else hide();
  }

  return {
    element: root,
    update,
    setVisible,
    isVisible: () => !root.hidden,
    destroy() {
      root.remove();
    },
  };
}
