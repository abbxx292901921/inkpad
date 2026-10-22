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
// PAGES: the document is a vertical stack of pages on one table (see
// src/layout.js). Document coordinates pan and zoom; INK LIVES IN PAGE-local
// coordinates. A gesture is PINNED to the page it started on: every point is
// converted by subtracting that page's origin, and drawing is clipped to the
// sheet. So a stroke can never wrap onto the page below, and inserting a page
// never rewrites existing ink.
//
// TWO CANVASES: the sheets, their ruling and the imported layers are painted
// on the PAPER canvas underneath; the ink goes on the transparent canvas on
// top. That separation is what lets translucent ink keep using
// 'destination-over' (the marker must sit behind ink but ON TOP of the paper).
// A single canvas could not do both: the white sheet would hide the marker.
//
// BACKWARD COMPATIBILITY: when `hooks.getPages` is absent the surface behaves
// exactly as the old single-page canvas (one implicit page at the origin,
// getStrokes/getLayers, no paper canvas). The integration suite drives that
// path.
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
import { isTextObject, renderText } from './text.js';
import {
  pageRect,
  docSize,
  resolvePageAt,
  visiblePages,
  clampPan,
  drawPageSheet,
} from './layout.js';

// Shapes are strokes, but they are drawn as a hard-edged path: the ink
// renderer's midpoint smoothing would round a rectangle's corners.
// Text objects are not strokes at all — they are their own thing.
function drawStroke(ctx, stroke) {
  if (isTextObject(stroke)) renderText(ctx, stroke);
  else if (isShapeStroke(stroke)) renderShape(ctx, stroke);
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

export function createDrawingSurface(canvas, viewport, hooks, options = {}) {
  // `desynchronized` asks the compositor for a low-latency surface. Not all
  // browsers honour it; it is a hint only. The ink canvas MUST be transparent
  // so the paper canvas shows through.
  const ctx = canvas.getContext('2d', { desynchronized: true, alpha: true });
  // The paper canvas is optional (the integration suite has none).
  const paperCanvas = options.paper ?? null;
  const paperCtx = paperCanvas
    ? paperCanvas.getContext('2d', { desynchronized: true, alpha: true })
    : null;
  // Pointer arbitration policy (pen vs finger). Injectable so tests can use
  // an isolated instance instead of the app-wide default.
  const policy = hooks.input ?? defaultInput;
  // pointerId -> { stroke, erasing, path[], renderedPieces, coalescedTotal,
  //                pointerType, pageIndex, rect, selectBox, box }
  const active = new Map();
  // Touch tracking for pan/zoom gestures: pointerId -> { x, y, downAt, moved }
  // (x/y in CSS pixels relative to the canvas).
  const touches = new Map();
  // The active two-finger gesture baseline, or null.
  let pinch = null;
  // The baseline of a ONE-finger pan: where the finger went down and where
  // the page was at that moment.
  let panBase = null;
  let debugOn = false;
  let lastPenAt = 0; // timestamp of the most recent pen event (hover or contact)

  // The document's pages, or null in single-page mode.
  function pagesNow() {
    return typeof hooks.getPages === 'function' ? hooks.getPages() : null;
  }

  function clearCanvas(target, element) {
    if (!target || !element) return;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, element.width, element.height);
    target.restore();
  }

  function clearDevicePixels() {
    clearCanvas(ctx, canvas);
    clearCanvas(paperCtx, paperCanvas);
  }

  // Run `fn` with the context in the given PAGE's coordinate space, clipped
  // to the sheet. A null rect means legacy single-page mode (no translate,
  // no clip) — exactly the old behaviour.
  function withPage(rect, fn) {
    ctx.save();
    applyTransform(ctx, viewport);
    if (rect) {
      ctx.translate(rect.x, rect.y);
      ctx.beginPath();
      ctx.rect(0, 0, rect.w, rect.h);
      ctx.clip();
    }
    fn(ctx);
    ctx.restore();
  }

  // Draw the page's background layers (imported PDF pages, photos of
  // homework). They sit UNDER the ink, which is what makes "import the
  // assignment and write on it" work. In multi-page mode they belong to a
  // page and their rect is PAGE-local, so they pan and zoom with the ink.
  function drawLayersLegacy() {
    const layers = hooks.getLayers ? hooks.getLayers() : [];
    if (layers.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    for (const layer of layers) {
      if (!layer.loaded || !layer.img) continue;
      const r = layer.rect;
      if (r && Number.isFinite(r.x) && r.w > 0 && r.h > 0) {
        ctx.save();
        applyTransform(ctx, viewport);
        ctx.drawImage(layer.img, r.x, r.y, r.w, r.h);
        ctx.restore();
        continue;
      }
      ctx.save();
      ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
      const fit = containFit(
        layer.naturalWidth,
        layer.naturalHeight,
        0,
        0,
        rect.width,
        rect.height,
      );
      ctx.drawImage(layer.img, fit.x, fit.y, fit.w, fit.h);
      ctx.restore();
    }
  }

  // The sheets and layers, on the paper canvas (or the ink canvas when the
  // caller did not supply a paper canvas).
  function drawPaper(visible) {
    const target = paperCtx || ctx;
    for (const { page, rect } of visible) {
      target.save();
      applyTransform(target, viewport);
      // A soft shadow under the sheet. Canvas shadows are in DEVICE pixels,
      // so they do not scale with the transform.
      target.shadowColor = 'rgba(15, 23, 42, 0.16)';
      target.shadowBlur = 10 * viewport.dpr;
      target.shadowOffsetY = 2 * viewport.dpr;
      drawPageSheet(target, rect, page.template ?? 'blank', {
        lineWidth: 1 / viewport.zoom,
      });
      target.restore();

      const layers = page.layers ?? [];
      if (layers.length === 0) continue;
      target.save();
      applyTransform(target, viewport);
      target.translate(rect.x, rect.y);
      target.beginPath();
      target.rect(0, 0, rect.w, rect.h);
      target.clip();
      for (const layer of layers) {
        if (!layer.loaded || !layer.img) continue;
        const r = layer.rect;
        if (r && Number.isFinite(r.x) && r.w > 0 && r.h > 0) {
          target.drawImage(layer.img, r.x, r.y, r.w, r.h);
        } else {
          // No rect: contain-fit it to the page it belongs to.
          const fit = containFit(
            layer.naturalWidth,
            layer.naturalHeight,
            0,
            0,
            rect.w,
            rect.h,
          );
          target.drawImage(layer.img, fit.x, fit.y, fit.w, fit.h);
        }
      }
      target.restore();
    }
  }

  function repaintLegacy() {
    clearDevicePixels();
    drawLayersLegacy();
    applyTransform(ctx, viewport);
    for (const s of hooks.getStrokes()) drawStroke(ctx, s);
    for (const entry of active.values()) {
      if (!entry.stroke || entry.erasing) continue;
      entry.renderedPieces = 0;
      applyTransform(ctx, viewport);
      paintNewPieces(ctx, entry.stroke, entry);
    }
  }

  // Full repaint: visible sheets + layers on the paper canvas, committed ink
  // on the ink canvas, then any stroke that is still in progress. The
  // in-progress part matters — its ink is already on the canvas but it is not
  // committed yet, so a bare committed-only redraw would wipe the line the
  // user is drawing right now.
  function repaintAll() {
    const pages = pagesNow();
    if (!pages) {
      repaintLegacy();
      return;
    }
    clearDevicePixels();
    const rect = canvas.getBoundingClientRect();
    const visible = visiblePages(pages, viewport, rect.width, rect.height);
    drawPaper(visible);
    for (const { page, rect: pr } of visible) {
      withPage(pr, () => {
        for (const s of page.strokes ?? []) drawStroke(ctx, s);
      });
    }
    for (const entry of active.values()) {
      if (!entry.stroke || entry.erasing) continue;
      entry.renderedPieces = 0;
      withPage(entry.rect, () => paintNewPieces(ctx, entry.stroke, entry));
    }
  }

  function redraw() {
    repaintAll();
  }

  function resize() {
    viewport.dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * viewport.dpr));
    const h = Math.max(1, Math.round(rect.height * viewport.dpr));
    canvas.width = w;
    canvas.height = h;
    if (paperCanvas) {
      paperCanvas.width = w;
      paperCanvas.height = h;
    }
    redraw();
  }

  // The viewport moved: keep the document on the table, repaint, and let the
  // app move the scrollbar and the page indicator.
  function afterViewChange() {
    clampView();
    repaintAll();
    if (hooks.onViewportChange) hooks.onViewportChange();
  }

  function clampView() {
    const pages = pagesNow();
    if (!pages || pages.length === 0) return false;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    const doc = docSize(pages);
    return clampPan(viewport, rect.width, rect.height, doc.w, doc.h);
  }

  // CSS pixels relative to the canvas top-left.
  function screenPoint(rawEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: rawEvent.clientX - rect.left, y: rawEvent.clientY - rect.top };
  }

  // A DOCUMENT point (screen -> document space).
  function docPoint(rawEvent) {
    const p = screenPoint(rawEvent);
    return screenToPage(p.x, p.y, viewport);
  }

  // A PAGE-local point: the document point minus the page origin. All stroke
  // data is stored local, so this is the only place the offset is applied.
  function toPagePoint(rawEvent, rect) {
    const doc = docPoint(rawEvent);
    return {
      x: doc.x - (rect ? rect.x : 0),
      y: doc.y - (rect ? rect.y : 0),
      pressure: pressureOf(rawEvent),
    };
  }

  // Build the shape a gesture describes. 'boxed' mode fits the chosen shape
  // into the rectangle you dragged; 'freeform' mode uses the outline you
  // drew.
  function buildShape(draft, tool) {
    return createShapeStroke({
      kind: draft.kind,
      mode: draft.mode,
      box: { x0: draft.x0, y0: draft.y0, x1: draft.x1, y1: draft.y1 },
      path: draft.path,
      color: tool.options.color,
      width: tool.options.width,
      opacity: tool.options.opacity ?? 1,
      lineStyle: tool.options.lineStyle ?? 'solid',
      fill: draft.fill,
      snap: draft.snap !== false,
    });
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
    const doc = screenToPage(sx, sy, viewport);
    const pages = pagesNow();
    const hit = pages ? resolvePageAt(pages, doc.x, doc.y) : null;
    hooks.debug(
      [
        `phase=${phase} type=${e.pointerType} id=${e.pointerId} button=${e.button} buttons=${e.buttons}`,
        `screen=(${sx.toFixed(1)}, ${sy.toFixed(1)})  doc=(${doc.x.toFixed(1)}, ${doc.y.toFixed(1)})  page=${hit ? hit.index : '-'} local=(${(hit ? hit.x : doc.x).toFixed(1)}, ${(hit ? hit.y : doc.y).toFixed(1)})`,
        `pressure=${pressureOf(e).toFixed(3)} coalesced=${coalescedCount} zoom=${viewport.zoom} pan=(${viewport.panX},${viewport.panY}) dpr=${viewport.dpr}`,
        `strokes=${pages ? (hit ? (pages[hit.index].strokes?.length ?? 0) : 0) : hooks.getStrokes().length} active=${active.size} pen=${policy.isPenDetected() ? 'seen' : 'no'} finger=${policy.fingerDrawingEnabled() ? 'on' : 'off'}`,
      ].join('\n'),
    );
  }

  // A finger may draw only when the policy says so AND the contact is small
  // enough to be a fingertip rather than a resting palm.
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
    afterViewChange();
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
      // Two fingers always mean a pinch/zoom, whatever the finger policy is.
      if (touches.size >= 2) {
        if (startPinchIfPossible()) {
          reportDebug(e, 'down (gesture: pinch)', 1);
        }
        return;
      }
      // ONE finger: what it does depends on the policy.
      const action = policy.fingerAction();
      if (action === 'pan') {
        // A finger pans the page. This is what makes a resting hand safe
        // once the Pencil is in use: the hand cannot leave ink, but it can
        // still scroll the page.
        panBase = { id: e.pointerId, x: p.x, y: p.y, panX: viewport.panX, panY: viewport.panY };
        reportDebug(e, 'down (gesture: pan)', 1);
        return;
      }
      if (action === 'none') {
        reportDebug(e, 'down (ignored: palm rejection)', 1);
        return;
      }
      // action === 'draw': fall through to the normal stroke setup, unless
      // the contact is a resting palm rather than a fingertip.
      if (isPalmContact(e)) {
        reportDebug(e, 'down (ignored: palm contact)', 1);
        return;
      }
    }

    // Which page did the gesture start on? All stroke data is page-local, so
    // the page is resolved ONCE, here, and the gesture stays on it.
    const pages = pagesNow();
    const doc = docPoint(e);
    const hit = pages ? resolvePageAt(pages, doc.x, doc.y) : null;
    if (pages && !hit) {
      // The table, a gap between pages, or outside the document: there is
      // nothing to write on. Do not capture the pointer, so the browser can
      // still scroll normally on a trackpad.
      reportDebug(e, 'down (outside a page)', 1);
      return;
    }
    const pageIndex = pages ? hit.index : 0;
    const rect = pages ? pageRect(pages, pageIndex) : null;

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn('[inkpad] setPointerCapture failed (non-fatal)', err);
    }

    const tool = getCurrentTool();
    const erasing = tool.kind === 'eraser' || isPenEraseGesture(e);
    const selecting = tool.kind === 'select' && !erasing;
    const shaping = tool.kind === 'shape' && !erasing;
    const typing = tool.kind === 'text' && !erasing;
    // The select tool has two modes: a freeform lasso (the default) and a
    // dragged rectangle. The rectangle is collected here so the UI only has
    // to ask for it.
    const selectBox = selecting && tool.options.mode === 'boxed';

    // A shape or a lasso gesture collects a path instead of ink.
    const shapeDraft = shaping
      ? {
          kind: tool.options.shape ?? 'rect',
          mode: tool.options.mode ?? 'boxed',
          fill: tool.options.fill === true,
          x0: 0,
          y0: 0,
          x1: 0,
          y1: 0,
          path: [],
        }
      : null;

    const entry = {
      stroke: erasing || selecting || shaping || typing
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
      selectBox,
      box: selectBox ? { x0: 0, y0: 0, x1: 0, y1: 0 } : null,
      typing,
      shape: shapeDraft,
      path: [],
      renderedPieces: 0,
      coalescedTotal: 0,
      pointerType: e.pointerType,
      pageIndex,
      rect,
    };
    active.set(e.pointerId, entry);
    if (pages && typeof hooks.onActivePage === 'function') hooks.onActivePage(pageIndex);

    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce, rect);
      if (erasing || selecting || typing) entry.path.push({ x: pt.x, y: pt.y });
      else if (shaping) {
        entry.shape.x0 = pt.x;
        entry.shape.y0 = pt.y;
        entry.shape.x1 = pt.x;
        entry.shape.y1 = pt.y;
        entry.shape.path.push({ x: pt.x, y: pt.y });
      } else addPoint(entry.stroke, pt.x, pt.y, pt.pressure);
    }
    if (selectBox && entry.path.length > 0) {
      const p0 = entry.path[0];
      entry.box = { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y };
    }
    if (!erasing && !selecting && !shaping && !typing) {
      withPage(rect, (c2) => paintNewPieces(c2, entry.stroke, entry));
    }
    reportDebug(
      e,
      erasing
        ? 'down(erase)'
        : selecting
          ? 'down(select)'
          : shaping
            ? 'down(shape)'
            : typing
              ? 'down(text)'
              : 'down',
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
        const doc = docPoint(e);
        const pages = pagesNow();
        const hit = pages ? resolvePageAt(pages, doc.x, doc.y) : null;
        const rect = hit ? pageRect(pages, hit.index) : null;
        const local = toPagePoint(e, rect);
        hooks.onPenHover({
          x: local.x,
          y: local.y,
          pressure: local.pressure,
          pageIndex: hit ? hit.index : null,
        });
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
      if (panBase) {
        // A ONE-finger pan. The pan is in screen pixels, so the finger's
        // movement maps straight onto it.
        const p = screenPoint(e);
        viewport.panX = panBase.panX + (p.x - panBase.x);
        viewport.panY = panBase.panY + (p.y - panBase.y);
        afterViewChange();
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
      if (entry.stroke && entry.stroke.points.length > 0) {
        hooks.commitStroke(entry.stroke, entry.pageIndex);
      }
      entry.erasing = true;
      entry.path = entry.stroke ? entry.stroke.points.map((p) => ({ x: p.x, y: p.y })) : [];
      entry.stroke = null;
    }

    const list = coalescedList(e);
    entry.coalescedTotal += list.length;
    for (const ce of list) {
      const pt = toPagePoint(ce, entry.rect);
      if (entry.erasing || entry.selecting || entry.typing) {
        entry.path.push({ x: pt.x, y: pt.y });
      } else if (entry.shape) {
        entry.shape.x1 = pt.x;
        entry.shape.y1 = pt.y;
        entry.shape.snap = !e.shiftKey;
        entry.shape.path.push({ x: pt.x, y: pt.y });
      } else addPoint(entry.stroke, pt.x, pt.y, pt.pressure);
    }
    if (entry.shape) {
      // Redraw the scene and lay the shape preview on top.
      repaintAll();
      const tool = getCurrentTool();
      const draft = buildShape(entry.shape, tool);
      withPage(entry.rect, (c2) => renderShape(c2, draft));
    } else if (entry.selecting) {
      // Clear the previous preview first: the marquee/lasso is drawn straight
      // onto the ink canvas, so without a repaint every pointermove would
      // leave its dashed rectangle behind (a trail of boxes).
      repaintAll();
      if (entry.selectBox) {
        // Boxed selection: draw the rectangle the user is dragging.
        const p = entry.path[entry.path.length - 1];
        if (p) {
          entry.box.x1 = p.x;
          entry.box.y1 = p.y;
        }
        const b = normalizedBox(entry.box);
        if (b) {
          withPage(entry.rect, (c2) => {
            c2.save();
            c2.setLineDash([6, 5]);
            c2.strokeStyle = '#0a84ff';
            c2.lineWidth = 1.5 / viewport.zoom;
            c2.strokeRect(b.x, b.y, b.w, b.h);
            c2.restore();
          });
        }
      } else if (entry.path.length > 1) {
        // The lasso trail, so the gesture is visible while it is happening.
        withPage(entry.rect, (c2) => {
          c2.save();
          c2.setLineDash([5, 4]);
          c2.strokeStyle = '#0a84ff';
          c2.lineWidth = 1.5 / viewport.zoom;
          c2.beginPath();
          c2.moveTo(entry.path[0].x, entry.path[0].y);
          for (const p of entry.path) c2.lineTo(p.x, p.y);
          c2.stroke();
          c2.restore();
        });
      }
    } else if (!entry.erasing && !entry.typing) {
      withPage(entry.rect, (c2) => paintNewPieces(c2, entry.stroke, entry));
    }
    reportDebug(
      e,
      entry.erasing ? 'move(erase)' : entry.selecting ? 'move(select)' : entry.shape ? 'move(shape)' : 'move',
      list.length,
    );
  }

  function normalizedBox(box) {
    if (!box) return null;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    return { x, y, w, h };
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
      if (panBase && e.pointerId === panBase.id) {
        panBase = null;
      }
      // A one-finger pan is over when the finger lifts.
      if (touches.size === 0) {
        panBase = null;
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
      hooks.erasePath(entry.path, entry.pageIndex);
      return;
    }
    if (entry.selecting) {
      // Drop the dashed marquee/lasso preview from the ink canvas. The
      // selection overlay is DOM, so the canvas must not keep the gesture.
      repaintAll();
      if (entry.selectBox) {
        const b = normalizedBox(entry.box);
        // A click with nothing dragged is a deselect, not an empty box.
        if (b && (b.w >= 3 || b.h >= 3) && hooks.onSelectBox) {
          reportDebug(e, `${kind} (select box ${Math.round(b.w)}x${Math.round(b.h)})`, 0);
          hooks.onSelectBox(b, entry.pageIndex);
          return;
        }
        if (hooks.onLasso) hooks.onLasso([], entry.pageIndex);
        return;
      }
      reportDebug(e, `${kind} (lasso, ${entry.path.length} pts)`, 0);
      if (hooks.onLasso) hooks.onLasso(entry.path, entry.pageIndex);
      return;
    }
    if (entry.typing) {
      // The text tool drags a BOX: the text is typed inside it.
      const first = entry.path[0];
      const last = entry.path[entry.path.length - 1] || first;
      if (first && hooks.onTextBox) {
        hooks.onTextBox(
          {
            x: Math.min(first.x, last.x),
            y: Math.min(first.y, last.y),
            w: Math.abs(last.x - first.x),
            h: Math.abs(last.y - first.y),
          },
          entry.pageIndex,
        );
      }
      return;
    }
    if (entry.shape) {
      // Commit the shape as an ordinary stroke, so undo, persistence and
      // export all work on it for free.
      const tool = getCurrentTool();
      const shape = buildShape(entry.shape, tool);
      // A tap without a drag is not a shape.
      const moved =
        Math.abs(entry.shape.x1 - entry.shape.x0) + Math.abs(entry.shape.y1 - entry.shape.y0);
      if (moved < 3 && entry.shape.path.length < 3) {
        repaintAll();
        return;
      }
      reportDebug(e, `${kind} (shape ${shape.shape}, ${shape.points.length} pts)`, 0);
      hooks.commitStroke(shape, entry.pageIndex);
      return;
    }
    withPage(entry.rect, (c2) => {
      if (entry.stroke && isTextured(entry.stroke)) {
        // The textured path already includes the closing run.
        drawStrokePath(c2, entry.stroke);
      } else {
        drawTail(c2, entry.stroke);
      }
    });
    const n = entry.stroke.points.length;
    if (n === 0) {
      reportDebug(e, `${kind} (discarded: no points)`, 0);
      return;
    }
    hooks.commitStroke(entry.stroke, entry.pageIndex);
    reportDebug(e, `${kind} (committed, ${n} pts, ${entry.coalescedTotal} coalesced)`, 0);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', (e) => finishStroke(e, 'up'));
  canvas.addEventListener('pointercancel', (e) => finishStroke(e, 'cancel'));
  canvas.addEventListener('lostpointercapture', (e) => finishStroke(e, 'lostcapture'));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Wheel / trackpad. A plain wheel scrolls the document (like Notability and
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
          afterViewChange();
        }
      } else {
        panBy(viewport, -dx, -dy);
        afterViewChange();
      }
    },
    { passive: false },
  );

  return {
    resize,
    redraw,
    clampView,
    // Move the DOCUMENT point (x, y) to the top-left of the viewport. Used by
    // the page navigator, the scrollbar and the boot-time "fit the page"
    // step; it clamps, repaints and notifies, so callers never touch pan
    // directly.
    panTo({ x, y } = {}) {
      if (Number.isFinite(x)) viewport.panX = -x * viewport.zoom;
      if (Number.isFinite(y)) viewport.panY = -y * viewport.zoom;
      afterViewChange();
    },
    viewChanged() {
      afterViewChange();
    },
    activeCount: () => active.size,
    setDebugEnabled(on) {
      debugOn = on;
    },
  };
}
