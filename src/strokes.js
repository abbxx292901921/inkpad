// strokes.js — stroke DATA MODEL (vector, not pixels) + render helpers.
//
// Stroke = { id, tool, color, width, opacity, pointerType, points[] }
// Point  = { x, y, pressure, t }               (x/y in PAGE coordinates)
// pointerType is stored on every stroke so palm rejection (ignore touch while
// the pen is active) needs no rewrite.
//
// RENDERING MODEL — "midpoint-forward" incremental pieces.
// The smooth path through p0..pn-1 is a chain of quadratic pieces:
//   piece 1:  p0                     --(control p1)-->  mid(p1,p2)
//   piece i:  mid(p[i-1],p[i])       --(control p[i])--> mid(p[i],p[i+1])
//   tail:     mid(p[n-2],p[n-1])     -->                p[n-1]
// Properties that matter:
//  * piece i becomes drawable only when p[i+1] arrives, so each piece is
//    painted EXACTLY ONCE. Consecutive pieces share an endpoint, so the stroke
//    is continuous with no gap at the tip (the old scheme re-painted the tip
//    segment and left a half-segment gap).
//  * Because nothing is ever re-painted, a translucent stroke (highlighter)
//    cannot stack its own alpha and darken.
//  * Translucent strokes batch a whole pointermove batch into ONE path
//    (butt caps) so joints do not double-composite; opaque strokes may use
//    round caps and a per-piece width (pressure taper).

let nextId = 1;

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through to counter-based id
    }
  }
  nextId += 1;
  return `stroke-${Date.now()}-${nextId}`;
}

export function createStroke({
  tool = 'pen',
  color = '#1b1b1b',
  width = 3,
  opacity = 1,
  pointerType = 'mouse',
  lineStyle = 'solid',
  pressureTaper = true,
} = {}) {
  return {
    id: makeId(),
    tool,
    color,
    width,
    opacity,
    pointerType,
    lineStyle,
    pressureTaper,
    points: [],
  };
}

export function addPoint(stroke, x, y, pressure) {
  stroke.points.push({ x, y, pressure, t: performance.now() });
  return stroke.points.length;
}

// Normalize PointerEvent pressure. 0/undefined means "no pressure data"
// (mouse, some touch screens) -> fallback 0.5. Pen data passes through.
export function pressureOf(rawEvent) {
  const p = rawEvent.pressure;
  if (typeof p !== 'number' || !(p > 0)) return 0.5;
  return Math.min(p, 1);
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// True when the stroke is translucent (highlighter). Translucent strokes are
// drawn behind existing ink (destination-over) and must never repaint.
export function isTranslucent(stroke) {
  return (stroke.opacity ?? 1) < 1;
}

// Line styles. `dash` factors multiply the stroke width so the pattern
// scales with the line; `widthScale` thins the whole stroke.
export const LINE_STYLES = {
  solid: { dash: null, widthScale: 1 },
  hairline: { dash: null, widthScale: 0.55 },
  dashed: { dash: [3, 2.2], widthScale: 1 },
  dotted: { dash: [0.01, 2.4], widthScale: 1 },
};

// True for any style that is not a plain continuous line.
//
// TRANSLUCENT strokes are never textured. A textured stroke re-strokes its
// whole path on every pointermove, which would stack a translucent stroke's
// alpha and make the marker darken as you draw. Translucent strokes always
// use the batched (paint-once) path instead, so they stay solid-coloured.
export function isTextured(stroke) {
  if (isTranslucent(stroke)) return false;
  const s = stroke.lineStyle;
  return Boolean(s) && s !== 'solid';
}

function lineStyleSpec(stroke) {
  return LINE_STYLES[stroke.lineStyle] ?? LINE_STYLES.solid;
}

function applyLineStyle(ctx, stroke) {
  const spec = lineStyleSpec(stroke);
  if (spec.dash) {
    const w = Math.max(0.5, stroke.width);
    ctx.setLineDash(spec.dash.map((f) => Math.max(0.1, f * w)));
  } else if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash([]);
  }
  return spec;
}

// Piece i (1-based). Requires points i-1, i and i+1 to exist.
function pieceAt(stroke, i) {
  const p = stroke.points;
  const ctrl = p[i];
  const start = i === 1 ? p[0] : mid(p[i - 1], p[i]);
  const end = mid(p[i], p[i + 1]);
  // A pressure-tapered stroke follows the stylus pressure; a pencil or a
  // chisel marker has a constant width.
  const width =
    stroke.pressureTaper === false
      ? stroke.width
      : (stroke.width * (p[i - 1].pressure + ctrl.pressure)) / 2;
  return {
    sx: start.x,
    sy: start.y,
    cx: ctrl.x,
    cy: ctrl.y,
    ex: end.x,
    ey: end.y,
    width,
  };
}

function applyStyle(ctx, stroke) {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineJoin = 'round';
  // Translucent strokes use butt caps: consecutive batches meet exactly at the
  // shared endpoint, so there is neither a gap nor a double-composited disc.
  ctx.lineCap = isTranslucent(stroke) ? 'butt' : 'round';
  ctx.globalAlpha = stroke.opacity ?? 1;
  if (isTranslucent(stroke)) ctx.globalCompositeOperation = 'destination-over';
}

// Draw pieces [fromI..toI] (1-based, inclusive). Returns the index of the
// next piece that would be drawn.
export function drawPieces(ctx, stroke, fromI, toI) {
  const n = stroke.points.length;
  const from = Math.max(1, fromI);
  const to = Math.min(toI, n - 2);
  if (to < from) return from;

  if (isTranslucent(stroke)) {
    // One path for the whole batch: a single stroke() call means the alpha is
    // applied once, so overlapping joints do not darken.
    ctx.save();
    applyStyle(ctx, stroke);
    ctx.lineWidth = Math.max(0.5, stroke.width);
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const q = pieceAt(stroke, i);
      if (i === from) ctx.moveTo(q.sx, q.sy);
      ctx.quadraticCurveTo(q.cx, q.cy, q.ex, q.ey);
    }
    ctx.stroke();
    ctx.restore();
  } else {
    // Opaque ink: one stroke() per piece so the width can follow pressure.
    for (let i = from; i <= to; i++) {
      const q = pieceAt(stroke, i);
      ctx.save();
      applyStyle(ctx, stroke);
      ctx.lineWidth = Math.max(0.5, q.width);
      ctx.beginPath();
      ctx.moveTo(q.sx, q.sy);
      ctx.quadraticCurveTo(q.cx, q.cy, q.ex, q.ey);
      ctx.stroke();
      ctx.restore();
    }
  }
  return to + 1;
}

// A single-point stroke (a tap): a dot.
export function drawDot(ctx, stroke, pt) {
  ctx.save();
  applyStyle(ctx, stroke);
  const r = Math.max(0.5, (stroke.width * pt.pressure) / 2);
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// The closing piece: the straight run from mid(p[n-2],p[n-1]) to the last
// point. Also handles the 1-point (dot) and 2-point (line) cases.
export function drawTail(ctx, stroke) {
  const p = stroke.points;
  const n = p.length;
  if (n === 0) return;
  if (n === 1) {
    drawDot(ctx, stroke, p[0]);
    return;
  }
  const s = n === 2 ? p[0] : mid(p[n - 2], p[n - 1]);
  const e = p[n - 1];
  const w =
    stroke.pressureTaper === false
      ? stroke.width
      : n === 2
        ? stroke.width * p[0].pressure
        : (stroke.width * (p[n - 2].pressure + p[n - 1].pressure)) / 2;
  ctx.save();
  applyStyle(ctx, stroke);
  ctx.lineWidth = Math.max(0.5, w);
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(e.x, e.y);
  ctx.stroke();
  ctx.restore();
}

// Stroke a whole stroke as ONE path. Used for the textured styles (dashed,
// dotted, hairline) so the dash pattern is continuous along the entire
// stroke instead of restarting on every piece.
//
// Re-stroking the whole path is safe: the stroke is opaque, and the path
// prefix never changes, so the dash phase is identical to the previous
// version and no stale pixels are left behind.
export function drawStrokePath(ctx, stroke) {
  const p = stroke.points;
  const n = p.length;
  if (n === 0) return;
  if (n === 1) {
    drawDot(ctx, stroke, p[0]);
    return;
  }
  ctx.save();
  applyStyle(ctx, stroke);
  const spec = applyLineStyle(ctx, stroke);
  ctx.lineWidth = Math.max(0.5, stroke.width * spec.widthScale);
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i <= n - 2; i++) {
    const q = pieceAt(stroke, i);
    ctx.quadraticCurveTo(q.cx, q.cy, q.ex, q.ey);
  }
  if (n === 2) ctx.lineTo(p[1].x, p[1].y);
  else ctx.lineTo(p[n - 1].x, p[n - 1].y);
  ctx.stroke();
  ctx.restore();
}

// Full redraw of one stroke (resize / undo / redo / repaint).
export function renderStroke(ctx, stroke) {
  const n = stroke.points.length;
  if (n === 0) return;
  if (isTextured(stroke)) {
    drawStrokePath(ctx, stroke);
    return;
  }
  if (n <= 2) {
    drawTail(ctx, stroke);
    return;
  }
  drawPieces(ctx, stroke, 1, n - 2);
  drawTail(ctx, stroke);
}

// --- History (undo/redo) ---------------------------------------------------
// Entries are inverse operations on the app's strokes array:
//   { undo(strokes), redo(strokes) }
// Only stroke references are stored — no pixels, no deep copies. History is
// intentionally in-memory (not persisted).

export function createHistory() {
  const undoStack = [];
  const redoStack = [];
  return {
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    commit(entry) {
      undoStack.push(entry);
      redoStack.length = 0;
    },
    undo(strokes) {
      const e = undoStack.pop();
      if (!e) return false;
      e.undo(strokes);
      redoStack.push(e);
      return true;
    },
    redo(strokes) {
      const e = redoStack.pop();
      if (!e) return false;
      e.redo(strokes);
      undoStack.push(e);
      return true;
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}

// Remove strokes by id, in place. Returns removed [{ stroke, index }] sorted
// ASCENDING by index so they can be re-inserted at the same positions.
export function removeStrokesById(strokes, ids) {
  const wanted = new Set(ids);
  const removed = [];
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (wanted.has(strokes[i].id)) removed.push({ stroke: strokes[i], index: i });
  }
  for (const r of removed) strokes.splice(r.index, 1); // descending: safe
  removed.reverse();
  return removed;
}

export function insertStrokesAt(strokes, removed) {
  for (const r of removed) strokes.splice(Math.min(r.index, strokes.length), 0, r.stroke);
}

// Entry factories (app.js uses these so undo/redo stay consistent).
export function addEntry(stroke, index) {
  return {
    undo: (strokes) => {
      removeStrokesById(strokes, [stroke.id]);
    },
    redo: (strokes) => {
      insertStrokesAt(strokes, [{ stroke, index }]);
    },
  };
}

export function deleteEntry(removed) {
  const ids = removed.map((r) => r.stroke.id);
  return {
    undo: (strokes) => {
      insertStrokesAt(strokes, removed);
    },
    redo: (strokes) => {
      removeStrokesById(strokes, ids);
    },
  };
}

// --- Eraser hit-testing (stroke eraser: whole-stroke delete) ---------------

function distToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

// True if page point (x,y) is within radius of the stroke's path.
export function strokeHitTest(stroke, x, y, radius) {
  const pts = stroke.points;
  if (pts.length === 0) return false;
  const r2 = radius * radius;
  // Cheap bbox reject, padded by radius + half line width.
  const pad = radius + stroke.width / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (x < minX - pad || x > maxX + pad || y < minY - pad || y > maxY + pad) return false;
  if (pts.length === 1) {
    const dx = x - pts[0].x;
    const dy = y - pts[0].y;
    return dx * dx + dy * dy <= r2;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegmentSq(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r2) return true;
  }
  return false;
}

// Ids of committed strokes touched by any point of the eraser path.
export function eraseHitIds(strokes, path, radius) {
  const hit = new Set();
  for (const p of path) {
    for (const s of strokes) {
      if (!hit.has(s.id) && strokeHitTest(s, p.x, p.y, radius)) hit.add(s.id);
    }
  }
  return [...hit];
}
