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
//
// PALM REJECTION (see src/input.js for the policy):
// - `pointercancel` DISCARDS the stroke instead of committing it. iPadOS
//   cancels a finger pointer when a pen takes over the digitizer, so a
//   cancelled finger is a hand, not ink.
// - Once a pen has been seen, a finger never draws (unless the user asks).
// - A finger that was already down when the pen landed is thrown away.
// - A touch contact much larger than a fingertip is treated as a palm.

import { screenToPage, applyTransform, zoomAt, panBy, applyPinch } from './coord.js';
import {
  createStroke,
  addPoint,
  pressureOf,
  drawPieces,
  drawDot,
  drawTail,
  drawStrokePath,
  isTranslucent,
  isTextured,
  renderStroke,
} from './strokes.js';
import { getCurrentTool } from './tools.js';
import { defaultInput } from './input.js';
import { containFit } from './pages.js';
import { isShapeStroke, renderShape, createShapeStroke } from './shapes.js';

// Shapes are strokes, but they are drawn as a hard-edged path: the ink
// renderer's midpoint smoothing would round a rectangle's corners.
function drawStroke(ctx, stroke) {
  if (isShapeStroke(stroke)) renderShape(ctx, stroke);
  else renderStroke(ctx, stroke);
}

const PEN_ERASER_BIT = 32; // pen eraser end (Pointer Events spec)
const PEN_BARREL_BIT = 2; // pen barrel / side button
// A resting palm or knuckle reports a far larger touch contact ellipse than a
// fingertip (roughly 15-30 CSS px for a fingertip, 80+ for a resting palm).
// Anything above this is treated as a palm, not a fingertip. iOS reports 0
// when the contact geometry is unknown, in which case this filter stays quiet.
const PALM_CONTACT_PX = 70;
// A touch that has been down this long without moving is a resting hand, not
// a deliberate gesture finger. Only used to break ties when 3+ touches are
// down (a resting hand plus a deliberate pinch).
const PALM_IDLE_MS = 600;

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
  // Pointer arbitration policy (pen vs finger). Injectable so tests can use
  // an isolated instance instead of the app-wide default.
  const policy = hooks.input ?? defaultInput;
  // pointerId -> { stroke, erasing, path[], renderedPieces, coalescedTotal,
  //                pointerType }
  const active = new Map();
  // Touch tracking for pan/zoom gestures: pointerId -> { x, y, downAt, moved }
  // (x/y in CSS pixels relative to the canvas).
  const touches = new Map();
  // The active two-finger gesture baseline, or null.
  let pinch = null;
  let debugOn = false;
  let lastPenAt = 0; // timestamp of the most recent pen event (hover or contact)

  function clearDevicePixels() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // Draw the page's background layers (imported PDF pages, photos of
  // homework). They sit UNDER the ink, which is what makes "import the
  // assignment and write on it" work.
  //
  // v1 draws layers in screen space, fitted to the visible canvas. Once
  // pan/zoom lands they become page-space objects.
  function drawLayers() {
    const layers = hooks.getLayers ? hooks.getLayers() : [];
    if (layers.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    ctx.save();
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    for (const layer of layers) {
      if (!layer.loaded || !layer.img) continue;
      const fit = containFit(
        layer.naturalWidth,
        layer.naturalHeight,
        0,
        0,
        rect.width,
        rect.height,
      );
      ctx.drawImage(layer.img, fit.x, fit.y, fit.w, fit.h);
    }
    ctx.restore();
  }

  // Full repaint: background layers, committed strokes, then any stroke that
  // is still in progress. The in-progress part matters — its ink is already on
  // the canvas but it is not committed yet, so a bare committed-only redraw
  // would wipe the line the user is drawing right now.
  function repaintAll() {
    clearDevicePixels();
    drawLayers();
    applyTransform(ctx, viewport);
    for (const s of hooks.getStrokes()) drawStroke(ctx, s);
    for (const entry of active.values()) {
      if (!entry.stroke || entry.erasing) continue;
      entry.renderedPieces = 0;
      applyTransform(ctx, viewport);
      paintNewPieces(ctx, entry.stroke, entry);
    }
  }

  function redraw() {
    repaintAll();
  }

  function resize() {
    viewport.dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * viewport.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * viewport.dpr));
    redraw();
  }

  function toPagePoint(rawEvent) {
    const p = screenPoint(rawEvent);
    const page = screenToPage(p.x, p.y, viewport);
    return { x: page.x, y: page.y, pressure: pressureOf(rawEvent) };
  }

  // CSS pixels relative to the canvas top-left.
  function screenPoint(rawEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: rawEvent.clientX - rect.left, y: rawEvent.clientY - rect.top };
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
    if (isTextured(stroke)) {
      // Dashed / dotted / hairline strokes are stroked as ONE path so the
      // pattern is continuous. Re-stroking the whole path is safe: it is
      // opaque and the path prefix never changes, so the pattern phase is
      // identical and no stale pixels are left behind.
      drawStrokePath(ctx2, stroke);
      entry.renderedPieces = to;
      return;
    }
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
        `strokes=${hooks.getStrokes().length} active=${active.size} pen=${policy.isPenDetected() ? 'seen' : 'no'} finger=${policy.fingerDrawingEnabled() ? 'on' : 'off'}`,
      ].join('\n'),
    );
  }

  // A finger may draw only when the user has finger drawing enabled AND the
  // contact is small enough to be a fingertip rather than a resting palm.
  function touchMayDraw(e) {
    if (!policy.fingerDrawingEnabled()) return false;
    return !isPalmContact(e);
  }

  function isPalmContact(e) {
    const w = e.width || 0;
    const h = e.height || 0;
    if (w <= 0 && h <= 0) return false; // geometry unknown -> do not guess
    return Math.max(w, h) > PALM_CONTACT_PX;
  }

  // --- pan / zoom gestures --------------------------------------------------

  // The touches that could take part in a gesture. With three or more down
  // (a resting hand plus a deliberate pinch) the ones that have been sitting
  // still are dropped, so the hand cannot drag the page around.
  function gestureCandidates(now) {
    const all = [...touches.values()];
    if (all.length <= 2) return all;
    const fresh = all.filter((t) => t.moved || now - t.downAt < PALM_IDLE_MS);
    return fresh.length >= 2 ? fresh : all;
  }

  // Start a pinch if two touches are down. Returns true if one started.
  function startPinchIfPossible() {
    const now = performance.now();
    const candidates = gestureCandidates(now);
    if (candidates.length < 2) return false;
    // The two most recent touches win: a hand that has been resting since
    // before the pinch started is older, so it loses.
    const a = candidates[candidates.length - 2];
    const b = candidates[candidates.length - 1];
    pinch = {
      aId: a.id,
      bId: b.id,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      // The baseline zoom/pan: the gesture transform is computed from here,
      // not from the live viewport.
      zoom: viewport.zoom,
      panX: viewport.panX,
      panY: viewport.panY,
    };
    // A finger that was drawing is not a gesture.
    cancelStroke(pinch.aId);
    cancelStroke(pinch.bId);
    return true;
  }

  function endPinch() {
    pinch = null;
  }

  function updatePinch() {
    if (!pinch) return;
    const a = touches.get(pinch.aId);
    const b = touches.get(pinch.bId);
    if (!a || !b) {
      endPinch();
      return;
    }
    applyPinch(
      viewport,
      {
        midX: pinch.midX,
        midY: pinch.midY,
        dist: pinch.dist,
        zoom: pinch.zoom,
        panX: pinch.panX,
        panY: pinch.panY,
      },
      {
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        dist: Math.hypot(a.x - b.x, a.y - b.y),
      },
    );
    repaintAll();
    if (hooks.onViewportChange) hooks.onViewportChange();
  }

  // Discard an in-flight stroke without committing it.
  function cancelStroke(pointerId) {
    const entry = active.get(pointerId);
    if (!entry) return;
    active.delete(pointerId);
    try {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch {
      // ignore
    }
  }

  // Throw away every in-flight finger stroke. Called when a pen goes down:
  // a hand that was already resting on the screen is not ink.
  function discardTouchStrokes() {
    let changed = false;
    for (const [id, entry] of active) {
      if (entry.pointerType !== 'touch') continue;
      active.delete(id);
      changed = true;
      try {
        if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      } catch {
        // ignore: capture already released
      }
    }
    if (changed) repaintAll();
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button draws
    if (active.has(e.pointerId)) return;

    if (e.pointerType === 'pen') {
      // A pen landing means any finger on the screen is a hand. Arm the
      // palm-rejection rule and throw away a hand that was already down.
      policy.notePenSeen();
      discardTouchStrokes();
    } else if (e.pointerType === 'touch') {
      const p = screenPoint(e);
      touches.set(e.pointerId, {
        id: e.pointerId,
        x: p.x,
        y: p.y,
        downAt: performance.now(),
        moved: false,
      });
      // A second finger turns the gesture into a pan/zoom.
      if (startPinchIfPossible()) {
        reportDebug(e, 'down (gesture: pinch)', 1);
        return;
      }
      if (!touchMayDraw(e)) {
        // PALM REJECTION: either a pen has been seen (so a finger is a
        // resting hand) or the contact is too large to be a fingertip.
        reportDebug(e, 'down (ignored: palm rejection)', 1);
        return;
      }
    }

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn('[inkpad] setPointerCapture failed (non-fatal)', err);
    }

    const tool = getCurrentTool();
    const erasing = tool.kind === 'eraser' || isPenEraseGesture(e);
    const selecting = tool.kind === 'select' && !erasing;
    const shaping = tool.kind === 'shape' && !erasing;

    // A shape or a lasso gesture collects a path instead of ink.
    const shapeDraft = shaping
      ? {
          kind: tool.options.shape ?? 'rect',
          fill: tool.options.fill === 'boxed',
          x0: 0,
          y0: 0,
          x1: 0,
          y1: 0,
        }
      : null;

    const entry = {
      stroke: erasing || selecting || shaping
        ? null
        : createStroke({
            tool: tool.id,
            color: tool.options.color,
            width: tool.options.width,
            opacity: tool.options.opacity ?? 1,
            pointerType: e.pointerType,
            lineStyle: tool.options.lineStyle ?? 'solid',
            pressureTaper: tool.options.pressureTaper !== false,
          }),
      erasing,
      selecting,
      shape: shapeDraft,
      path: [],
      renderedPieces: 0,
      coalescedTotal: 0,
      pointerType: e.pointerType,
    };
    active.set(e.pointerId, entry);

    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce);
      if (erasing || selecting) entry.path.push({ x: pt.x, y: pt.y });
      else if (shaping) {
        entry.shape.x0 = pt.x;
        entry.shape.y0 = pt.y;
        entry.shape.x1 = pt.x;
        entry.shape.y1 = pt.y;
      } else addPoint(entry.stroke, pt.x, pt.y, pt.pressure);
    }
    if (!erasing && !selecting && !shaping) {
      applyTransform(ctx, viewport);
      paintNewPieces(ctx, entry.stroke, entry);
    }
    reportDebug(
      e,
      erasing ? 'down(erase)' : selecting ? 'down(select)' : shaping ? 'down(shape)' : 'down',
      list.length,
    );
  }

  function onPointerMove(e) {
    if (e.pointerType === 'pen') {
      lastPenAt = performance.now();
      // Even a hovering pen arms palm rejection: once the user has picked up
      // the pencil, a finger on the screen is a hand.
      policy.notePenSeen();
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

    if (e.pointerType === 'touch') {
      const t = touches.get(e.pointerId);
      if (t) {
        const p = screenPoint(e);
        if (Math.hypot(p.x - t.x, p.y - t.y) > 3) t.moved = true;
        t.x = p.x;
        t.y = p.y;
      }
      // A finger that is part of a gesture never draws.
      if (pinch) {
        if (e.pointerId === pinch.aId || e.pointerId === pinch.bId) {
          updatePinch();
        }
        return;
      }
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
      if (entry.erasing || entry.selecting) entry.path.push({ x: pt.x, y: pt.y });
      else if (entry.shape) {
        entry.shape.x1 = pt.x;
        entry.shape.y1 = pt.y;
        entry.shape.snap = !e.shiftKey;
      } else addPoint(entry.stroke, pt.x, pt.y, pt.pressure);
    }
    if (entry.shape) {
      // Redraw the scene and lay the shape preview on top.
      repaintAll();
      applyTransform(ctx, viewport);
      const tool = getCurrentTool();
      const draft = createShapeStroke({
        kind: entry.shape.kind,
        x0: entry.shape.x0,
        y0: entry.shape.y0,
        x1: entry.shape.x1,
        y1: entry.shape.y1,
        color: tool.options.color,
        width: tool.options.width,
        opacity: tool.options.opacity ?? 1,
        lineStyle: tool.options.lineStyle ?? 'solid',
        fill: entry.shape.fill,
        snap: entry.shape.snap !== false,
      });
      renderShape(ctx, draft);
    } else if (entry.selecting) {
      // The lasso trail, so the gesture is visible while it is happening.
      if (entry.path.length > 1) {
        applyTransform(ctx, viewport);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#0a84ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(entry.path[0].x, entry.path[0].y);
        for (const p of entry.path) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.restore();
      }
    } else if (!entry.erasing) {
      applyTransform(ctx, viewport);
      paintNewPieces(ctx, entry.stroke, entry);
    }
    reportDebug(
      e,
      entry.erasing ? 'move(erase)' : entry.selecting ? 'move(select)' : entry.shape ? 'move(shape)' : 'move',
      list.length,
    );
  }

  // Shared finish path for pointerup, pointercancel, lostpointercapture.
  function finishStroke(e, kind) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      // A gesture ends when either of its fingers lifts.
      if (pinch && (e.pointerId === pinch.aId || e.pointerId === pinch.bId)) {
        endPinch();
        // Any finger still down starts a fresh gesture when the next one lands.
      }
    }
    const entry = active.get(e.pointerId);
    if (!entry) return;
    active.delete(e.pointerId);
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore: capture already released
    }
    if (kind === 'cancel') {
      // The browser or iPadOS took the pointer away: a gesture recogniser
      // started, the OS cancelled a finger because a pen took over the
      // digitizer, or the device was removed. DISCARD — committing here is
      // exactly what makes a resting hand leave ink behind.
      reportDebug(e, 'cancel (discarded)', 0);
      // The stroke may already have been painted incrementally, so repaint to
      // wipe it off the canvas.
      repaintAll();
      return;
    }
    if (entry.erasing) {
      reportDebug(e, `${kind} (erase path, ${entry.path.length} pts)`, 0);
      hooks.erasePath(entry.path);
      return;
    }
    if (entry.selecting) {
      reportDebug(e, `${kind} (lasso, ${entry.path.length} pts)`, 0);
      if (hooks.onLasso) hooks.onLasso(entry.path);
      return;
    }
    if (entry.shape) {
      // Commit the shape as an ordinary stroke, so undo, persistence and
      // export all work on it for free.
      const tool = getCurrentTool();
      const shape = createShapeStroke({
        kind: entry.shape.kind,
        x0: entry.shape.x0,
        y0: entry.shape.y0,
        x1: entry.shape.x1,
        y1: entry.shape.y1,
        color: tool.options.color,
        width: tool.options.width,
        opacity: tool.options.opacity ?? 1,
        lineStyle: tool.options.lineStyle ?? 'solid',
        pointerType: e.pointerType,
        fill: entry.shape.fill,
        snap: entry.shape.snap !== false,
      });
      // A tap without a drag is not a shape.
      const moved =
        Math.abs(entry.shape.x1 - entry.shape.x0) + Math.abs(entry.shape.y1 - entry.shape.y0);
      if (moved < 3) {
        repaintAll();
        return;
      }
      reportDebug(e, `${kind} (shape ${shape.shape}, ${shape.points.length} pts)`, 0);
      hooks.commitStroke(shape);
      return;
    }
    applyTransform(ctx, viewport);
    if (entry.stroke && isTextured(entry.stroke)) {
      // The textured path already includes the closing run.
      drawStrokePath(ctx, entry.stroke);
    } else {
      drawTail(ctx, entry.stroke);
    }
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

  // Wheel / trackpad. A plain wheel scrolls the page (like Notability and
  // Excalidraw); ctrl+wheel is the trackpad pinch gesture and zooms about
  // the cursor.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Normalise line/page deltas to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const p = screenPoint(e);
      if (e.ctrlKey) {
        // 0.0025 keeps a physical ctrl+wheel notch at ~1.28x while still
        // feeling smooth for a trackpad pinch (which sends tiny deltas).
        if (zoomAt(viewport, p.x, p.y, Math.exp(-dy * 0.0025))) {
          repaintAll();
          if (hooks.onViewportChange) hooks.onViewportChange();
        }
      } else {
        panBy(viewport, -dx, -dy);
        repaintAll();
        if (hooks.onViewportChange) hooks.onViewportChange();
      }
    },
    { passive: false },
  );

  return {
    resize,
    redraw,
    activeCount: () => active.size,
    setDebugEnabled(on) {
      debugOn = on;
    },
  };
}
