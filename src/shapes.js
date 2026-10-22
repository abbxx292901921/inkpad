// shapes.js — pure geometry for the shape tools.
//
// WHY VERTICES: a shape is not a picture, it is a polygon the user can
// reshape. A shape IS a stroke (there is no parallel shape model): an
// ordinary stroke with `kind: 'shape'` whose `points` are the shape's
// VERTICES. Undo/redo, persistence, PNG export, hit-testing and the eraser
// therefore work on shapes for free — and the very same vertex list is what
// the vertex editor (src/ui/shape-editor.js) drags.
//
// THE TWO DRAW MODES differ in HOW YOU DRAW, not in what the shape looks
// like afterwards:
//   'boxed'    you drag out a RECTANGLE and the chosen shape is FITTED into
//              that box (a rectangle becomes its four corners, an ellipse a
//              polyline inscribed in it, a line the box's diagonal).
//   'freeform' you draw an OUTLINE and the shape IS that outline.
//
// DOM-free on purpose: the canvas, the shape menu, the vertex editor and a
// Node test all import this module, so nothing here may touch `document`.
//
// Shapes are drawn by renderShape(), not by the ink renderer in strokes.js:
// the midpoint-forward renderer smooths corners, and a rectangle must have
// corners. renderShape strokes the whole outline in ONE path, so a
// translucent shape never stacks its own alpha.

import { LINE_STYLES, createStroke } from './strokes.js';
import { pointInPolygon } from './transform.js';

export const SHAPE_KINDS = ['line', 'rect', 'ellipse', 'triangle', 'arrow', 'custom'];

export const SHAPE_LABELS = {
  line: 'Line',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  arrow: 'Arrow',
  custom: 'Custom',
};

// The two ways to draw a shape.
export const SHAPE_MODES = ['boxed', 'freeform'];

// A custom shape is a polygon the user draws by hand. Six vertices is the
// most the vertex editor can usefully show.
export const MAX_CUSTOM_VERTICES = 6;

// The kinds that enclose an area: they can be filled, they are
// point-in-polygon for hit-testing, and their polyline is closed.
const CLOSED_KINDS = new Set(['rect', 'ellipse', 'triangle', 'custom']);

// The kinds that are a real polygon, so the square preset can turn them into
// a REGULAR polygon of the same size.
const POLYGON_KINDS = new Set(['triangle', 'custom']);

// An ellipse is a polyline, so it has vertices like every other shape — and
// the vertex editor can reshape it.
const ELLIPSE_POINTS = 24;

const DEG = Math.PI / 180;
const SNAP_STEP_DEG = 45;
const ARROW_BARB_DEG = 25;
const ARROW_BARB_RATIO = 0.1;
const FILL_ALPHA = 0.12;
// Two points closer than this are the same point.
const EPS = 1e-6;

// A stroke is a shape when it says so, or when it carries a known shape kind.
export function isShapeStroke(stroke) {
  return Boolean(stroke) && (stroke.kind === 'shape' || SHAPE_KINDS.includes(stroke.shape));
}

export function isClosedShape(kind) {
  return CLOSED_KINDS.has(kind);
}

// --- small geometry helpers -------------------------------------------------

const isFinitePoint = (p) => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y);

const samePoint = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// A normalised rectangle: x0 < x1 and y0 < y1.
export function normalizeBox(box) {
  if (!box) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(box.x0, box.x1),
    y0: Math.min(box.y0, box.y1),
    x1: Math.max(box.x0, box.x1),
    y1: Math.max(box.y0, box.y1),
  };
}

// The four corners of a box, clockwise from the top-left.
function boxCorners(b) {
  return [
    { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
  ];
}

// The closest point to (px, py) on the segment a-b.
function closestOnSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// --- snapping ---------------------------------------------------------------

// Snap the END of a drag to the nearest multiple of `stepDeg` around the
// start. The distance is preserved, so a 30-degree drag becomes 45 degrees
// without the shape shrinking.
export function snapAngle(x0, y0, x1, y1, stepDeg = SNAP_STEP_DEG) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!len) return { x1, y1 };
  const step = (stepDeg || SNAP_STEP_DEG) * DEG;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x1: x0 + Math.cos(angle) * len, y1: y0 + Math.sin(angle) * len };
}

// Lock a drag to a square: the dominant axis keeps its length and the other
// one is stretched to match. A zero axis is left alone (a perfectly
// horizontal drag stays horizontal instead of turning into a diagonal).
//
// NOTE: a helper, not something the shape tools apply on their own —
// squaring a rectangle is the explicit square preset (toSquare).
export function snapSquare(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === ay || ax === 0 || ay === 0) return { x1, y1 };
  if (ax > ay) return { x1, y1: y0 + Math.sign(dy) * ax };
  return { x1: x0 + Math.sign(dx) * ay, y1 };
}

// Snap a point to the nearest grid intersection.
export function snapToGrid(x, y, size = 20) {
  const s = size > 0 ? size : 1;
  return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
}

// --- the vertex list --------------------------------------------------------

// Reduce a path to at most `maxPoints` points, keeping the shape.
//
// Distance-based decimation: the point whose neighbours are closest together
// is the least significant one, so it is the first to go. The first and the
// last point always survive. A path that closes on itself repeats its first
// point at the end; the duplicate is dropped first, because the closure is
// implied by the shape kind, not by the vertex list.
export function simplifyPath(path, maxPoints) {
  const pts = [];
  for (const p of Array.isArray(path) ? path : []) if (isFinitePoint(p)) pts.push({ x: p.x, y: p.y });
  const max = Math.max(2, Math.trunc(maxPoints) || 2);
  if (pts.length <= max) return pts;
  if (pts.length > 2 && samePoint(pts[0], pts[pts.length - 1])) pts.pop();
  while (pts.length > max) {
    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = Math.hypot(pts[i + 1].x - pts[i - 1].x, pts[i + 1].y - pts[i - 1].y);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    pts.splice(bestIndex, 1);
  }
  return pts;
}

// Resample a closed outline to `count` points spread evenly along its
// perimeter. This is how a hand-drawn outline becomes an ellipse.
function resampleClosed(path, count) {
  const ring = [];
  for (const p of Array.isArray(path) ? path : []) {
    if (!isFinitePoint(p)) continue;
    const last = ring[ring.length - 1];
    if (!last || !samePoint(last, p)) ring.push({ x: p.x, y: p.y });
  }
  if (ring.length > 2 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
  if (ring.length < 3) return ring;
  const cum = [0];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[ring.length];
  if (!(total > 0)) return ring;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const target = (i / count) * total;
    let seg = 0;
    while (seg < ring.length - 1 && cum[seg + 1] < target) seg += 1;
    const a = ring[seg];
    const b = ring[(seg + 1) % ring.length];
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? (target - cum[seg]) / len : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// The vertices of a shape drawn in a mode.
//
//   kind: 'line' | 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'custom'
//   mode: 'boxed' | 'freeform'
//   box:  { x0, y0, x1, y1 } — the rectangle the shape is fitted into
//   path: [{x, y}, ...]      — the user's own outline
//
// BOXED: the shape is fitted into the box. A line and an arrow use the box's
// two corners as the SEGMENT's ends, so the direction of the drag survives;
// every other kind uses a normalised rectangle. A custom shape starts as the
// box's corners and is edited afterwards.
//
// FREEFORM: the shape IS the path, and each kind takes its natural vertex
// count from it: line 2, triangle 3, rect 4, arrow 5 (the shaft plus two
// barbs), ellipse 24 (resampled along the outline), custom the path
// simplified to at most MAX_CUSTOM_VERTICES vertices.
export function shapeVertices(kind, mode, { box = null, path = null } = {}) {
  const m = SHAPE_MODES.includes(mode) ? mode : 'boxed';
  // A freeform shape with no path yet falls back to the box: the shape is
  // never empty, so a half-finished gesture still shows something.
  const free = m === 'freeform' && Array.isArray(path) && path.length > 0;
  if (!free) return boxedVertices(kind, box);
  return freeformVertices(kind, path);
}

function boxedVertices(kind, box) {
  const b = box ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  if (kind === 'line') return [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 }];
  if (kind === 'arrow') return arrowVertices({ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 });
  const r = normalizeBox(b);
  const { x0, y0, x1, y1 } = r;
  switch (kind) {
    case 'rect':
    case 'custom':
      return boxCorners(r);
    case 'ellipse': {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      return ellipseVertices(cx, cy, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, ELLIPSE_POINTS);
    }
    case 'triangle':
      // Three of the box's four corners.
      return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }];
    default:
      throw new Error(`[inkpad] unknown shape kind: ${kind}`);
  }
}

function freeformVertices(kind, path) {
  const pts = [];
  for (const p of Array.isArray(path) ? path : []) if (isFinitePoint(p)) pts.push({ x: p.x, y: p.y });
  if (!pts.length) return [];
  switch (kind) {
    case 'line':
      return pts.length < 2 ? pts : [pts[0], pts[pts.length - 1]];
    case 'arrow':
      return arrowVertices(pts[0], pts[pts.length - 1]);
    case 'rect':
      return fitPolygon(pts, 4);
    case 'triangle':
      return fitPolygon(pts, 3);
    case 'ellipse':
      return resampleClosed(pts, ELLIPSE_POINTS);
    case 'custom':
      return simplifyPath(pts, MAX_CUSTOM_VERTICES);
    default:
      throw new Error(`[inkpad] unknown shape kind: ${kind}`);
  }
}

// Fit an outline to a polygon of `n` corners. A path that already has n
// points is used as it is (in the order it was drawn); a longer one is
// decimated; a shorter one falls back to the corners of its bounding box.
function fitPolygon(pts, n) {
  if (pts.length === n) return pts;
  if (pts.length > n) return simplifyPath(pts, n);
  const b = boundsOf(pts);
  return boxCorners({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY }).slice(0, n);
}

// A polyline around an ellipse.
function ellipseVertices(cx, cy, rx, ry, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

// The shaft plus two barbs, as ONE polyline, so the free eraser reaches
// every branch.
function arrowVertices(start, tip) {
  const dx = tip.x - start.x;
  const dy = tip.y - start.y;
  const barb = Math.hypot(dx, dy) * ARROW_BARB_RATIO;
  const back = Math.atan2(dy, dx) + Math.PI;
  const a1 = back - ARROW_BARB_DEG * DEG;
  const a2 = back + ARROW_BARB_DEG * DEG;
  return [
    { x: start.x, y: start.y },
    { x: tip.x, y: tip.y },
    { x: tip.x + Math.cos(a1) * barb, y: tip.y + Math.sin(a1) * barb },
    { x: tip.x, y: tip.y },
    { x: tip.x + Math.cos(a2) * barb, y: tip.y + Math.sin(a2) * barb },
  ];
}

// --- editable vertices ------------------------------------------------------

// The editable vertices of a shape: the stroke's points, minus the closing
// duplicate a closed shape carries. The closure is implied by the kind, and
// a duplicated handle would be a second handle for the same corner.
export function vertexPositions(stroke) {
  const out = [];
  for (const p of stroke?.points ?? []) if (isFinitePoint(p)) out.push({ x: p.x, y: p.y });
  if (isClosedShape(stroke?.shape) && out.length > 1 && samePoint(out[0], out[out.length - 1])) {
    out.pop();
  }
  return out;
}

// Move one vertex in place. `index` counts the EDITABLE vertices (see
// vertexPositions), so moving a closed shape's first vertex also moves the
// closing point that repeats it.
export function setVertex(stroke, index, x, y) {
  const pts = stroke?.points ?? [];
  if (!pts.length) return false;
  const i = Math.trunc(index);
  if (!Number.isFinite(i) || i < 0) return false;
  let count = pts.length;
  let closing = -1;
  if (isClosedShape(stroke?.shape) && count > 1 && samePoint(pts[0], pts[count - 1])) {
    closing = count - 1;
    count -= 1;
  }
  if (i >= count) return false;
  pts[i].x = x;
  pts[i].y = y;
  if (closing >= 0 && i === 0) {
    pts[closing].x = x;
    pts[closing].y = y;
  }
  return true;
}

// Write a new vertex list into the stroke, keeping the closing point a
// closed shape needs.
function applyVertices(stroke, verts) {
  const pts = stroke.points ?? [];
  const t = Date.now();
  const next = verts.map((v, i) => ({ x: v.x, y: v.y, pressure: pts[i]?.pressure ?? 0.5, t }));
  if (isClosedShape(stroke.shape) && next.length > 1) next.push({ ...next[0] });
  stroke.points = next;
}

// --- the square preset ------------------------------------------------------

// The square preset.
//
// A rectangle becomes a square (the same centre, the larger side), an
// ellipse becomes a circle, and a polygon becomes a REGULAR polygon with the
// same vertex count, the same centroid and the same size. A line and an
// arrow have no square form. Returns true if the shape changed.
export function toSquare(stroke) {
  const kind = stroke?.shape;
  const verts = vertexPositions(stroke);
  if (verts.length < 2) return false;
  const b = boundsOf(verts);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  let next = null;
  if (kind === 'rect') {
    const h = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2;
    if (!(h > 0)) return false;
    next = boxCorners({ x0: cx - h, y0: cy - h, x1: cx + h, y1: cy + h });
  } else if (kind === 'ellipse') {
    const r = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2;
    if (!(r > 0)) return false;
    next = ellipseVertices(cx, cy, r, r, verts.length);
  } else if (POLYGON_KINDS.has(kind)) {
    next = regularPolygon(verts);
  } else {
    return false;
  }
  if (!next) return false;
  if (next.length === verts.length && next.every((v, i) => samePoint(v, verts[i]))) return false;
  applyVertices(stroke, next);
  return true;
}

// A regular polygon with the same number of vertices, the same centroid and
// the same size. The size is the mean distance from the centroid, which is
// the circumradius a regular polygon of that size has. The first vertex
// keeps its angle, so the polygon does not spin.
function regularPolygon(verts) {
  const n = verts.length;
  if (n < 3) return null;
  let cx = 0;
  let cy = 0;
  for (const v of verts) {
    cx += v.x;
    cy += v.y;
  }
  cx /= n;
  cy /= n;
  let r = 0;
  for (const v of verts) r += Math.hypot(v.x - cx, v.y - cy);
  r /= n;
  if (!(r > 0)) return null;
  const a0 = Math.atan2(verts[0].y - cy, verts[0].x - cx);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = a0 + (i / n) * Math.PI * 2;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

// --- vertex snapping --------------------------------------------------------

// The vertices of another shape: `.vertices` when the caller has them,
// otherwise the stroke's own points.
function verticesOf(other) {
  const list = Array.isArray(other?.vertices) ? other.vertices : other?.points;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) if (isFinitePoint(p)) out.push({ x: p.x, y: p.y });
  return out;
}

// Snap a dragged vertex to the geometry around it.
//
//  - a VERTEX of another shape within `tolerance` -> snap exactly onto it
//  - an EDGE (segment) of another shape within `tolerance` -> snap onto the
//    closest point ON that segment
//  - otherwise the input is returned unchanged
//
// `tolerance` is in PAGE units. A vertex wins over an edge: it is the
// precise anchor the user aimed at. `index` is the dragged vertex; the
// shape's own geometry is excluded by id, so a shape is never snapped to
// itself.
export function snapVertex(stroke, index, x, y, { others = [], tolerance = 8 } = {}) {
  const tol = Math.max(0, Number.isFinite(tolerance) ? tolerance : 0);
  const selfId = stroke?.id ?? null;
  let bestVertex = null;
  let bestEdge = null;
  for (const other of others ?? []) {
    if (!other || other === stroke) continue;
    if (selfId && other.id && other.id === selfId) continue;
    const verts = verticesOf(other);
    if (verts.length < 2) continue;
    const id = other.id ?? null;
    for (const v of verts) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d <= tol && (!bestVertex || d < bestVertex.dist)) bestVertex = { x: v.x, y: v.y, dist: d, id };
    }
    const edges = verts.length - 1 + (isClosedShape(other.shape) ? 1 : 0);
    for (let i = 0; i < edges; i += 1) {
      const p = closestOnSegment(x, y, verts[i], verts[(i + 1) % verts.length]);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= tol && (!bestEdge || d < bestEdge.dist)) bestEdge = { x: p.x, y: p.y, dist: d, id };
    }
  }
  const hit = bestVertex ?? bestEdge;
  if (!hit) return { x, y, snapped: false, target: null };
  return {
    x: hit.x,
    y: hit.y,
    snapped: true,
    target: { kind: bestVertex ? 'vertex' : 'edge', id: hit.id },
  };
}

// --- outline & hit-testing --------------------------------------------------

// The outline of a shape stroke as a flat array of [x, y] pairs.
// A closed shape (rect, ellipse, triangle, custom) repeats its first point
// at the end so the loop is closed by construction; `line` and `arrow` stay
// open. Returns null for anything that is not a shape.
export function shapeOutline(stroke) {
  if (!isShapeStroke(stroke)) return null;
  const pts = stroke.points ?? [];
  if (!pts.length) return null;
  const out = pts.map((p) => [p.x, p.y]);
  if (isClosedShape(stroke.shape)) {
    // Close the loop, but do not double-close it: the stroke's own polyline
    // may already end where it started.
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length < 2 || first[0] !== last[0] || first[1] !== last[1]) {
      out.push([first[0], first[1]]);
    }
  }
  return out;
}

// True when the page point is inside the shape or within `tolerance` of its
// outline. Closed shapes use point-in-polygon plus a boundary test; open ones
// (line, arrow) use the distance to the segments.
export function shapeHitTest(stroke, px, py, tolerance = 8) {
  const outline = shapeOutline(stroke);
  if (!outline || outline.length < 2) return false;
  const closed = isClosedShape(stroke.shape);
  const poly = outline.map(([x, y]) => ({ x, y }));
  const tol = Math.max(0, tolerance);
  // The last edge of a closed shape is the closing one.
  const edges = poly.length - 1 + (closed ? 1 : 0);
  for (let i = 0; i < edges; i += 1) {
    const p = closestOnSegment(px, py, poly[i], poly[(i + 1) % poly.length]);
    if (Math.hypot(p.x - px, p.y - py) <= tol) return true;
  }
  return closed && pointInPolygon(px, py, poly);
}

// --- rendering --------------------------------------------------------------

function traceOutline(ctx, outline) {
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i += 1) ctx.lineTo(outline[i][0], outline[i][1]);
}

// Draw a shape stroke into a 2D context, in PAGE coordinates.
//
// The outline is stroked (never filled by default): a shape is ink on the
// page, not a filled object. With `stroke.fill` the closed shape is filled
// first, at a low alpha, so the outline still reads on top of it. The whole
// outline is ONE path, so a translucent shape never stacks its own alpha.
export function renderShape(ctx, stroke) {
  if (!ctx || !isShapeStroke(stroke)) return;
  const outline = shapeOutline(stroke);
  if (!outline) return;

  const closed = isClosedShape(stroke.shape);
  const color = stroke.color ?? '#1b1b1b';
  const width = Math.max(0.5, stroke.width ?? 3);
  const opacity = stroke.opacity ?? 1;
  // Same dash factors as strokes.js: the pattern scales with the line width.
  const spec = LINE_STYLES[stroke.lineStyle] ?? LINE_STYLES.solid;

  ctx.save();
  // One path for both the fill and the stroke: the outline is only traced
  // once, so a translucent shape never stacks its own alpha.
  ctx.beginPath();
  traceOutline(ctx, outline);
  if (closed) ctx.closePath();
  if (stroke.fill && closed) {
    ctx.globalAlpha = opacity * FILL_ALPHA;
    ctx.fillStyle = color;
    ctx.fill();
  }
  if (spec.dash) {
    ctx.setLineDash(spec.dash.map((f) => Math.max(0.1, f * Math.max(0.5, width))));
  } else if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, width * spec.widthScale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

// --- building a shape -------------------------------------------------------

// The box a drag describes. Only a line and an arrow are snapped to a 45
// degree angle: a rectangle is drawn exactly as it was dragged, because
// squaring it is the explicit square preset now.
function dragBox(kind, x0, y0, x1, y1, snap) {
  if (snap && (kind === 'line' || kind === 'arrow')) {
    const s = snapAngle(x0, y0, x1, y1);
    return { x0, y0, x1: s.x1, y1: s.y1 };
  }
  return { x0, y0, x1, y1 };
}

// The vertices of a shape dragged from (x0, y0) to (x1, y1), in page coords:
// the boxed mode's geometry in its simplest form.
export function shapePoints(kind, x0, y0, x1, y1, { snap = true } = {}) {
  const t = Date.now();
  return shapeVertices(kind, 'boxed', { box: dragBox(kind, x0, y0, x1, y1, snap) })
    .map((v) => ({ x: v.x, y: v.y, pressure: 0.5, t }));
}

// A shape stroke that is ready to be committed: an ordinary stroke with the
// shape fields set. `kind` marks it as a shape, `shape` says which one,
// `mode` says how it was drawn and `fill` fills a closed shape.
export function createShapeStroke({
  kind = 'rect',
  mode = 'boxed',
  box = null,
  path = null,
  x0 = 0, y0 = 0, x1 = 0, y1 = 0, // the legacy drag form
  color = '#1b1b1b',
  width = 3,
  opacity = 1,
  lineStyle = 'solid',
  pointerType = 'mouse',
  fill = false,
  snap = true,
} = {}) {
  // LEGACY: the old shape tools passed the draw MODE in `fill` (the strings
  // 'freeform' and 'boxed'). Accept it so an old call site keeps working.
  let modeId = mode;
  let filled = fill;
  if (typeof fill === 'string') {
    if (SHAPE_MODES.includes(fill)) modeId = fill;
    filled = false;
  }
  if (!SHAPE_MODES.includes(modeId)) modeId = 'boxed';

  const stroke = createStroke({
    tool: 'shape',
    color,
    width,
    opacity,
    pointerType,
    lineStyle,
    // A shape has no pressure: its width is constant.
    pressureTaper: false,
  });
  stroke.kind = 'shape';
  stroke.shape = kind;
  stroke.mode = modeId;
  stroke.fill = Boolean(filled);

  const vertices = shapeVertices(kind, modeId, {
    box: box ?? dragBox(kind, x0, y0, x1, y1, snap),
    path,
  });
  const t = Date.now();
  const points = vertices.map((v) => ({ x: v.x, y: v.y, pressure: 0.5, t }));
  // A closed shape's polyline must include the closing edge, or the free
  // eraser (which treats the points as an open polyline) cannot reach it.
  if (isClosedShape(kind) && points.length > 1) points.push({ ...points[0] });
  stroke.points = points;
  return stroke;
}
