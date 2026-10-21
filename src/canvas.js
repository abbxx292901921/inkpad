// canvas.js — drawing surface: Pointer Events, render loop, incremental draw.
//
// Rules followed here (spec):
// - Pointer Events ONLY. No mouse/touch events, no drag-and-drop.
// - getCoalescedEvents() in pointermove (fallback: the event itself).
// - setPointerCapture() on pointerdown so strokes survive the edge.
// - pointercancel finishes/discards gracefully — never leaves a dangling stroke.
// - One stroke per pointerId (multi-touch draws multiple strokes; palm
//   rejection arrives in step 3).
//
// Tools: kind 'ink' draws a stroke (committed via hooks.commitStroke).
// kind 'eraser' collects a page-space path and hands it to hooks.erasePath —
// no ink is painted for the eraser gesture.
//
// Rendering: pointermove only QUEUES page-space points; a rAF loop drains the
// queue and draws just the new chunks (drawStrokeRange). Full repaints happen
// only on resize / undo / redo / erase. hooks.getStrokes() supplies committed
// strokes for repaints.

import { screenToPage, applyTransform } from './coord.js';
import {
  createStroke,
  addPoint,
  pressureOf,
  drawStrokeRange,
  chunkCount,
  renderStroke,
} from './strokes.js';
import { getCurrentTool } from './tools.js';

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

export function createDrawingSurface(canvas, viewport, hooks) {
  const ctx = canvas.getContext('2d');
  // pointerId -> { stroke|null, erasing, queue: [{x,y,pressure}], path: [{x,y}],
  //                 drawnChunks, coalescedTotal }
  const active = new Map();
  let rafId = 0;
  let debugOn = false;

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
    // A resize wipes in-progress ink too: repaint it fully and reset its
    // incremental counter so nothing is drawn twice. (Eraser entries hold no
    // ink; their path survives untouched.)
    for (const entry of active.values()) {
      if (!entry.stroke) continue;
      entry.queue.length = 0;
      renderStroke(ctx, entry.stroke);
      entry.drawnChunks = chunkCount(entry.stroke);
    }
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

  // Drain queued points and draw only new chunks. Runs on rAF.
  function drain() {
    if (active.size === 0) return;
    applyTransform(ctx, viewport);
    for (const entry of active.values()) {
      if (!entry.stroke || entry.queue.length === 0) continue;
      for (const q of entry.queue) addPoint(entry.stroke, q.x, q.y, q.pressure);
      entry.queue.length = 0;
      entry.drawnChunks = drawStrokeRange(ctx, entry.stroke, entry.drawnChunks);
    }
  }

  function scheduleDrain() {
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      drain();
    });
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
        `strokes=${hooks.getStrokes().length} active=${active.size}`,
      ].join('\n'),
    );
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button draws
    if (active.has(e.pointerId)) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn('[inkpad] setPointerCapture failed (non-fatal)', err);
    }
    const tool = getCurrentTool();
    const erasing = tool.kind === 'eraser';
    const entry = {
      stroke: erasing
        ? null
        : createStroke({
            tool: tool.id,
            color: tool.options.color,
            width: tool.options.width,
            pointerType: e.pointerType,
          }),
      erasing,
      queue: [],
      path: [],
      drawnChunks: 0,
      coalescedTotal: 0,
    };
    active.set(e.pointerId, entry);
    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce);
      if (erasing) entry.path.push({ x: pt.x, y: pt.y });
      else entry.queue.push(pt);
    }
    scheduleDrain();
    reportDebug(e, erasing ? 'down(erase)' : 'down', list.length);
  }

  function onPointerMove(e) {
    const entry = active.get(e.pointerId);
    if (!entry) {
      reportDebug(e, 'hover', 1); // not drawing: still useful for coord checks
      return;
    }
    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce);
      if (entry.erasing) entry.path.push({ x: pt.x, y: pt.y });
      else entry.queue.push(pt);
    }
    scheduleDrain();
    reportDebug(e, entry.erasing ? 'move(erase)' : 'move', list.length);
  }

  // Shared finish path for pointerup, pointercancel, lostpointercapture.
  // Eraser: hand the path to hooks.erasePath (no ink painted, nothing to flush).
  // Ink: flush the queue, paint what's left, commit (or discard if empty).
  // Never leaves a dangling in-progress stroke.
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
    for (const q of entry.queue) addPoint(entry.stroke, q.x, q.y, q.pressure);
    entry.queue.length = 0;
    entry.drawnChunks = drawStrokeRange(ctx, entry.stroke, entry.drawnChunks);
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
