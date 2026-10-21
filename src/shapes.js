// shapes.js — pure geometry for the shape tools.
//
// A shape IS a stroke: there is no parallel shape model. A shape stroke is an
// ordinary stroke with two extra fields — `kind: 'shape'` and `shape: 'rect'` —
// whose points are the VERTICES of the shape. Undo/redo, persistence, PNG
// export, hit-testing and the eraser therefore work on shapes for free.
//
// DOM-free on purpose: the canvas, the shape menu and a Node test all import
// this module, so nothing here may touch `document` or `window`.
//
// Shapes are drawn by renderShape(), not by the ink renderer in strokes.js:
// the midpoint-forward renderer smooths corners, and a rectangle must have
// corners. renderShape strokes the whole outline in ONE path, so a
// translucent shape never stacks its own alpha.

import { LINE_STYLES, createStroke } from './strokes.js';

export const SHAPE_KINDS = ['line', 'rect', 'ellipse', 'triangle', 'arrow'];

export const SHAPE_LABELS = {
  line: 'Line',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  arrow: 'Arrow',
};

// The shapes that enclose an area: they can be filled, and they are
// point-in-polygon for hit-testing. `line` and `arrow` are open polylines.
const CLOSED_KINDS = new Set(['rect', 'ellipse', 'triangle']);

const DEG = Math.PI / 180;
const SNAP_STEP_DEG = 45;
const ELLIPSE_POINTS = 48;
const ARROW_BARB_DEG = 25;
const ARROW_BARB_RATIO = 0.1;
const FILL_ALPHA = 0.12;

// A stroke is a shape when it says so, or when it carries a known shape kind.
export function isShapeStroke(stroke) {
  return Boolean(stroke) && (stroke.kind === 'shape' || SHAPE_KINDS.includes(stroke.shape));
}

export function isClosedShape(kind) {
  return CLOSED_KINDS.has(kind);
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

// --- geometry ---------------------------------------------------------------

// The vertices of a shape dragged from (x0,y0) to (x1,y1), in page coords.
//
// Point counts are fixed per kind so the app can reason about a shape without
// knowing its geometry:
//   line     2   start, end
//   rect     4   corners, clockwise from the top-left
//   ellipse  48  a polyline around the bounding box
//   triangle 3   top-centre, bottom-left, bottom-right
//   arrow    5   shaft, tip, barb, tip, barb (one polyline, so the free
//                    eraser hits every branch)
export function shapePoints(kind, x0, y0, x1, y1, { snap = true } = {}) {
  const t = Date.now();
  const pts = [];
  const push = (x, y) => pts.push({ x, y, pressure: 0.5, t });

  switch (kind) {
    case 'line': {
      const end = snap ? snapAngle(x0, y0, x1, y1) : { x1, y1 };
      push(x0, y0);
      push(end.x1, end.y1);
      break;
    }
    case 'rect': {
      const end = snap ? snapSquare(x0, y0, x1, y1) : { x1, y1 };
      const left = Math.min(x0, end.x1);
      const right = Math.max(x0, end.x1);
      const top = Math.min(y0, end.y1);
      const bottom = Math.max(y0, end.y1);
      push(left, top);
      push(right, top);
      push(right, bottom);
      push(left, bottom);
      break;
    }
    case 'ellipse': {
      const end = snap ? snapSquare(x0, y0, x1, y1) : { x1, y1 };
      const cx = (x0 + end.x1) / 2;
      const cy = (y0 + end.y1) / 2;
      const rx = Math.abs(end.x1 - x0) / 2;
      const ry = Math.abs(end.y1 - y0) / 2;
      for (let i = 0; i < ELLIPSE_POINTS; i += 1) {
        const a = (i / ELLIPSE_POINTS) * Math.PI * 2;
        push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
      break;
    }
    case 'triangle': {
      const left = Math.min(x0, x1);
      const right = Math.max(x0, x1);
      const top = Math.min(y0, y1);
      const bottom = Math.max(y0, y1);
      push((left + right) / 2, top);
      push(left, bottom);
      push(right, bottom);
      break;
    }
    case 'arrow': {
      const end = snap ? snapAngle(x0, y0, x1, y1) : { x1, y1 };
      const tipX = end.x1;
      const tipY = end.y1;
      const len = Math.hypot(tipX - x0, tipY - y0);
      const back = Math.atan2(tipY - y0, tipX - x0) + Math.PI;
      const barb = len * ARROW_BARB_RATIO;
      const a1 = back - ARROW_BARB_DEG * DEG;
      const a2 = back + ARROW_BARB_DEG * DEG;
      push(x0, y0);
      push(tipX, tipY);
      push(tipX + Math.cos(a1) * barb, tipY + Math.sin(a1) * barb);
      push(tipX, tipY);
      push(tipX + Math.cos(a2) * barb, tipY + Math.sin(a2) * barb);
      break;
    }
    default:
      throw new Error(`[inkpad] unknown shape kind: ${kind}`);
  }

  return pts;
}

// --- outline & hit-testing --------------------------------------------------

// The outline of a shape stroke as a flat array of [x, y] pairs.
// A closed shape (rect, ellipse, triangle) repeats its first point at the end
// so the loop is closed by construction; `line` and `arrow` stay open.
// Returns null for anything that is not a shape.
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

// Squared distance from a point to a segment. Same maths as the eraser in
// strokes.js, kept local because that one is not exported.
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

// Ray-casting point-in-polygon.
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// True when the page point is inside the shape or within `tolerance` of its
// outline. Closed shapes use point-in-polygon plus a boundary test; open ones
// (line, arrow) use the distance to the segments.
export function shapeHitTest(stroke, px, py, tolerance = 8) {
  const outline = shapeOutline(stroke);
  if (!outline || outline.length < 2) return false;
  const closed = isClosedShape(stroke.shape);
  const poly = closed ? outline.slice(0, -1) : outline;
  const tol = Math.max(0, tolerance);
  const tolSq = tol * tol;

  for (let i = 1; i < poly.length; i += 1) {
    if (distToSegmentSq(px, py, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]) <= tolSq) {
      return true;
    }
  }
  if (!closed) return false;

  // The closing edge of a closed shape.
  const last = poly[poly.length - 1];
  if (distToSegmentSq(px, py, last[0], last[1], poly[0][0], poly[0][1]) <= tolSq) return true;
  return pointInPolygon(px, py, poly);
}

// --- rendering --------------------------------------------------------------

// Same dash factors as strokes.js: the pattern scales with the line width.
function applyLineStyle(ctx, stroke) {
  const spec = LINE_STYLES[stroke.lineStyle] ?? LINE_STYLES.solid;
  if (spec.dash) {
    const w = Math.max(0.5, stroke.width ?? 3);
    ctx.setLineDash(spec.dash.map((f) => Math.max(0.1, f * w)));
  } else if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash([]);
  }
  return spec;
}

function traceOutline(ctx, outline) {
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i += 1) ctx.lineTo(outline[i][0], outline[i][1]);
}

// Draw a shape stroke into a 2D context, in PAGE coordinates.
//
// The outline is stroked (never filled by default): a shape is ink on the
// page, not a filled object. With `stroke.fill` the closed shape is filled
// first, at a low alpha, so the outline still reads on top of it — that is
// what the "Boxed" mode means.
export function renderShape(ctx, stroke) {
  if (!ctx || !isShapeStroke(stroke)) return;
  const outline = shapeOutline(stroke);
  if (!outline) return;

  const closed = isClosedShape(stroke.shape);
  const color = stroke.color ?? '#1b1b1b';
  const width = Math.max(0.5, stroke.width ?? 3);
  const opacity = stroke.opacity ?? 1;

  ctx.save();
  if (stroke.fill && closed) {
    ctx.globalAlpha = opacity * FILL_ALPHA;
    ctx.fillStyle = color;
    ctx.beginPath();
    traceOutline(ctx, outline);
    ctx.closePath();
    ctx.fill();
  }
  const spec = applyLineStyle(ctx, stroke);
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, width * spec.widthScale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  traceOutline(ctx, outline);
  if (closed) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

// A shape stroke that is ready to be committed: an ordinary stroke with the
// shape fields set. `kind` marks it as a shape, `shape` says which one and
// `fill` is the freeform/boxed mode.
export function createShapeStroke({
  kind,
  x0,
  y0,
  x1,
  y1,
  color = '#1b1b1b',
  width = 3,
  opacity = 1,
  lineStyle = 'solid',
  pointerType = 'mouse',
  fill = false,
  snap = true,
} = {}) {
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
  stroke.fill = Boolean(fill);
  const points = shapePoints(kind, x0, y0, x1, y1, { snap });
  // A closed shape's polyline must include the closing edge, or the free
  // eraser (which treats the points as an open polyline) cannot reach it.
  if (isClosedShape(kind) && points.length > 1) {
    points.push({ ...points[0] });
  }
  stroke.points = points;
  return stroke;
}
