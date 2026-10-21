// canvas.js — drawing surface: Pointer Events + synchronous incremental draw.
//
// WHY SYNCHRONOUS: iPadOS Safari drops pointer events when the main thread is
// busy on a slow animation frame, so deferring the paint to requestAnimationFrame
// loses points and produces visibly angular strokes. We therefore paint the new
// geometry INSIDE the pointermove handler. The handler stays cheap (one small
// path per event), so the main thread never falls behind.
//
// Rules followed here (spec):
// - Pointer Events ONLY. No mouse/touch events, no drag-and-drop.
// - getCoalescedEvents() in pointermove (fallback: the event itself).
// - setPointerCapture() on pointerdown so strokes survive the edge.
// - pointercancel finishes/discards gracefully — never leaves a dangling stroke.
// - One stroke per pointerId.
//
// TOOLS: kind 'ink' draws (committed via hooks.commitStroke). kind 'eraser'
// collects a page-space path and hands it to hooks.erasePath — no ink is
// painted for the eraser gesture.
//
// APPLE PENCIL:
// - Squeeze / flipped eraser end reports `buttons & 32` (button 5). That
//   gesture erases no matter which tool is selected.
// - Barrel button reports `buttons & 2` — also treated as erase.
// - A pen that is merely hovering sends pointermove with buttons === 0; that
//   drives the cursor ring (hooks.onPenHover) and never draws.

import { screenToPage, applyTransform } from './coord.js';
import {
  createStroke,
  addPoint,
  pressureOf,
  drawPieces,
  drawDot,
  drawTail,
  isTranslucent,
  renderStroke,
} from './strokes.js';
import { getCurrentTool } from './tools.js';

const PEN_ERASER_BIT = 32; // pen eraser end (Pointer Events spec)
const PEN_BARREL_BIT = 2; // pen barrel / side button
// A pen seen within this window keeps touch input blocked (palm rejection).
const PEN_GRACE_MS = 1500;

function coalescedList(e) {
  if (typeof e.getCoalescedEvents === 'function') {
    try {
      const list = e.getCoalescedEvents();
      if (list && list.length > 0) return list;
    } catch {
      // fall through to [e]
    }
  }
  return [e];
}

// A pen eraser/barrel gesture is a stroke-level decision.
function isPenEraseGesture(e) {
  if (e.pointerType !== 'pen') return false;
  return (e.buttons & PEN_ERASER_BIT) !== 0 || (e.buttons & PEN_BARREL_BIT) !== 0 || e.button === 5;
}

export function createDrawingSurface(canvas, viewport, hooks) {
  // `desynchronized` asks the compositor for a low-latency surface. Not all
  // browsers honour it; it is a hint only.
  const ctx = canvas.getContext('2d', { desynchronized: true, alpha: true });
  // pointerId -> { stroke, erasing, path[], renderedPieces, coalescedTotal }
  const active = new Map();
  let debugOn = false;
  let lastPenAt = 0; // timestamp of the most recent pen event (hover or contact)

  function penRecentlyActive(now) {
    return now - lastPenAt < PEN_GRACE_MS;
  }

  function clearDevicePixels() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function redraw() {
    clearDevicePixels();
    applyTransform(ctx, viewport);
    for (const s of hooks.getStrokes()) renderStroke(ctx, s);
  }

  function resize() {
    viewport.dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * viewport.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * viewport.dpr));
    redraw();
  }

  function toPagePoint(rawEvent) {
    const rect = canvas.getBoundingClientRect();
    const sx = rawEvent.clientX - rect.left;
    const sy = rawEvent.clientY - rect.top;
    const p = screenToPage(sx, sy, viewport);
    return { x: p.x, y: p.y, pressure: pressureOf(rawEvent) };
  }

  // Paint the pieces that became drawable with the new points.
  // piece i needs p[i+1], so after adding points the last drawable piece is
  // (pointCount - 2) in 1-based piece numbering.
  function paintNewPieces(ctx2, stroke, entry) {
    const n = stroke.points.length;
    if (n < 3) {
      // First point: an immediate dot for opaque ink so the pen feels
      // responsive. It is covered by the first real piece later.
      if (n === 1 && !isTranslucent(stroke)) {
        drawDot(ctx2, stroke, stroke.points[0]);
        entry.renderedPieces = 0;
      }
      return;
    }
    const to = n - 2; // 1-based index of the last drawable piece
    if (to <= entry.renderedPieces) return;
    const from = Math.max(1, entry.renderedPieces + 1);
    drawPieces(ctx2, stroke, from, to);
    entry.renderedPieces = to;
  }

  function reportDebug(e, phase, coalescedCount) {
    if (!debugOn) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const p = screenToPage(sx, sy, viewport);
    hooks.debug(
      [
        `phase=${phase} type=${e.pointerType} id=${e.pointerId} button=${e.button} buttons=${e.buttons}`,
        `screen=(${sx.toFixed(1)}, ${sy.toFixed(1)})  page=(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`,
        `pressure=${pressureOf(e).toFixed(3)} coalesced=${coalescedCount} zoom=${viewport.zoom} pan=(${viewport.panX},${viewport.panY}) dpr=${viewport.dpr}`,
        `strokes=${hooks.getStrokes().length} active=${active.size} pen=${penRecentlyActive(performance.now()) ? 'yes' : 'no'}`,
      ].join('\n'),
    );
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button draws
    if (active.has(e.pointerId)) return;

    if (e.pointerType === 'pen') {
      lastPenAt = performance.now();
    } else if (e.pointerType === 'touch' && penRecentlyActive(performance.now())) {
      // PALM REJECTION: a pen has been seen recently, so a finger is a palm
      // resting on the screen — it must not draw.
      reportDebug(e, 'down (ignored: palm rejection)', 1);
      return;
    }

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn('[inkpad] setPointerCapture failed (non-fatal)', err);
    }

    const tool = getCurrentTool();
    const erasing = tool.kind === 'eraser' || isPenEraseGesture(e);
    const entry = {
      stroke: erasing
        ? null
        : createStroke({
            tool: tool.id,
            color: tool.options.color,
            width: tool.options.width,
            opacity: tool.options.opacity ?? 1,
            pointerType: e.pointerType,
          }),
      erasing,
      path: [],
      renderedPieces: 0,
      coalescedTotal: 0,
    };
    active.set(e.pointerId, entry);

    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce);
      if (erasing) entry.path.push({ x: pt.x, y: pt.y });
      else addPoint(entry.stroke, pt.x, pt.y, pt.pressure);
    }
    if (!erasing) {
      applyTransform(ctx, viewport);
      paintNewPieces(ctx, entry.stroke, entry);
    }
    reportDebug(e, erasing ? 'down(erase)' : 'down', list.length);
  }

  function onPointerMove(e) {
    if (e.pointerType === 'pen') {
      lastPenAt = performance.now();
      // Hovering (no buttons) -> show the cursor ring, never draw.
      if (e.buttons === 0) {
        const pt = toPagePoint(e);
        hooks.onPenHover({ x: pt.x, y: pt.y, pressure: pt.pressure });
        reportDebug(e, 'hover(pen)', 1);
        return;
      }
      // Pen made contact -> the hover ring is no longer meaningful.
      hooks.onPenHover(null);
    }

    const entry = active.get(e.pointerId);
    if (!entry) {
      reportDebug(e, 'move (not drawing)', 1);
      return;
    }

    // A pen that turns into an eraser mid-gesture switches the stroke over.
    if (!entry.erasing && isPenEraseGesture(e)) {
      // Commit the ink drawn so far so no orphan line is left on the canvas.
      if (entry.stroke && entry.stroke.points.length > 0) hooks.commitStroke(entry.stroke);
      entry.erasing = true;
      entry.path = entry.stroke ? entry.stroke.points.map((p) => ({ x: p.x, y: p.y })) : [];
      entry.stroke = null;
    }

    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce);
      if (entry.erasing) entry.path.push({ x: pt.x, y: pt.y });
      else addPoint(entry.stroke, pt.x, pt.y, pt.pressure);
    }
    if (!entry.erasing) {
      applyTransform(ctx, viewport);
      paintNewPieces(ctx, entry.stroke, entry);
    }
    reportDebug(e, entry.erasing ? 'move(erase)' : 'move', list.length);
  }

  // Shared finish path for pointerup, pointercancel, lostpointercapture.
  function finishStroke(e, kind) {
    const entry = active.get(e.pointerId);
    if (!entry) return;
    active.delete(e.pointerId);
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore: capture already released
    }
    if (entry.erasing) {
      reportDebug(e, `${kind} (erase path, ${entry.path.length} pts)`, 0);
      hooks.erasePath(entry.path);
      return;
    }
    applyTransform(ctx, viewport);
    drawTail(ctx, entry.stroke);
    const n = entry.stroke.points.length;
    if (n === 0) {
      reportDebug(e, `${kind} (discarded: no points)`, 0);
      return;
    }
    hooks.commitStroke(entry.stroke);
    reportDebug(e, `${kind} (committed, ${n} pts, ${entry.coalescedTotal} coalesced)`, 0);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', (e) => finishStroke(e, 'up'));
  canvas.addEventListener('pointercancel', (e) => finishStroke(e, 'cancel'));
  canvas.addEventListener('lostpointercapture', (e) => finishStroke(e, 'lostcapture'));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    resize,
    redraw,
    activeCount: () => active.size,
    setDebugEnabled(on) {
      debugOn = on;
    },
  };
}
