// strokes.js — stroke DATA MODEL (vector, not pixels) + render helpers.
//
// Stroke = { id, tool, color, width, pointerType, points[] }
// Point  = { x, y, pressure, t }               (x/y in PAGE coordinates)
// pointerType is stored on every stroke now so step 3 palm rejection
// ("ignore touch while pen is active") needs no rewrite.
//
// Rendering: midpoint-quadratic chunks, one chunk per point-to-point segment,
// each stroked with its own width (avg pressure × base width) so pressure
// tapers visibly along the line. round caps/joins hide the seams.

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

export function createStroke({ tool = 'pen', color = '#1b1b1b', width = 3, pointerType = 'mouse' } = {}) {
  return { id: makeId(), tool, color, width, pointerType, points: [] };
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

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Number of drawable chunks in a stroke: one per segment (n points -> n-1).
export function chunkCount(stroke) {
  return Math.max(0, stroke.points.length - 1);
}

// Full redraw of one stroke (used for resize / full repaints).
export function renderStroke(ctx, stroke) {
  drawStrokeRange(ctx, stroke, 0);
}

// Draw the segments not yet drawn. `drawnChunks` = how many segments are
// already on the canvas; segment i (1..n-1) joins point i-1 to point i.
// Returns the new drawn-chunk count, to be passed back as `drawnChunks`.
// NOTE: never re-draws an already-painted segment — a translucent stroke
// (highlighter) would stack its own alpha and get darker on every repaint.
export function drawStrokeRange(ctx, stroke, drawnChunks) {
  const pts = stroke.points;
  if (pts.length === 0) return 0;

  // Single-point stroke (a tap): draw a dot.
  if (pts.length === 1) {
    const r = Math.max(0.5, (stroke.width * pts[0].pressure) / 2);
    ctx.save();
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return 0;
  }

  const n = pts.length;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;
  // Highlighter paints BEHIND existing ink (destination-over), so it layers
  // correctly both incrementally and on full repaints, with no z-order pass.
  if (stroke.tool === 'highlighter') ctx.globalCompositeOperation = 'destination-over';
  const start = Math.max(1, (Math.floor(drawnChunks) || 0) + 1);
  for (let i = start; i < n; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const s = i === 1 ? prev : midpoint(prev, cur);
    const e = i === n - 1 ? cur : midpoint(cur, pts[i + 1]);
    ctx.lineWidth = Math.max(0.5, (stroke.width * (prev.pressure + cur.pressure)) / 2);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.quadraticCurveTo(cur.x, cur.y, e.x, e.y);
    ctx.stroke();
  }
  ctx.restore();
  return n - 1;
}

// --- History (undo/redo) ---------------------------------------------------
// Entries are inverse operations on the app's strokes array:
//   { undo(strokes), redo(strokes) }
// Only stroke references are stored — no pixels, no deep copies. History is
// intentionally in-memory (not persisted in step 4's IndexedDB).

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
