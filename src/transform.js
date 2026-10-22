// transform.js — the pure geometry behind the selection + transform layer.
//
// WHY A SEPARATE MODULE: src/ui/selection.js only ever reports GESTURES
// ("the top-left handle moved 12, -4 px"); it must never know how a stroke
// becomes geometry. All the maths lives here so it can be unit-tested in Node
// (no DOM at all), and so the lasso, the shape tools and the undo entries can
// reuse exactly the same code.
//
// COORDINATES: every function here works in PAGE units — the same space as
// stroke.points[]. src/coord.js is the only place that converts to screen
// pixels; this module never converts. The app converts the screen deltas the
// UI reports back into page units before calling in here.
//
// MUTATION: translate / scale / rotate edit the strokes IN PLACE. The app
// keeps ONE strokes array and ONE history entry for a whole gesture, so the
// live stroke objects have to be transformed rather than replaced. Every
// field other than points (and width, for a scale) is left untouched.

export const HANDLE_NAMES = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];

// A stroke thinner than this is invisible and un-hittable, so a scale is
// never allowed to take it below the floor.
export const MIN_STROKE_WIDTH = 0.5;

function eachPoint(strokes, fn) {
  for (const s of strokes ?? []) {
    for (const p of s?.points ?? []) fn(p, s);
  }
}

// --- bounds -----------------------------------------------------------------

// The bounding box of a set of points, or null when there are none.
function boxOfPoints(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return minX > maxX ? null : { minX, minY, maxX, maxY };
}

// The bounding box of a set of strokes, in page coordinates.
// Returns null for an empty set (no strokes, or strokes without points).
export function boundsOf(strokes) {
  const pts = [];
  let textBox = null;
  for (const s of strokes ?? []) {
    // A text object is a box, not a polyline: use its measured size.
    if (s && s.kind === 'text') {
      const b = textBoxOf(s);
      if (b) {
        textBox = textBox
          ? {
              minX: Math.min(textBox.minX, b.minX),
              minY: Math.min(textBox.minY, b.minY),
              maxX: Math.max(textBox.maxX, b.maxX),
              maxY: Math.max(textBox.maxY, b.maxY),
            }
          : b;
      }
      continue;
    }
    for (const p of s?.points ?? []) pts.push(p);
  }
  const box = boxOfPoints(pts);
  if (!textBox) return box;
  if (!box) return textBox;
  return {
    minX: Math.min(box.minX, textBox.minX),
    minY: Math.min(box.minY, textBox.minY),
    maxX: Math.max(box.maxX, textBox.maxX),
    maxY: Math.max(box.maxY, textBox.maxY),
  };
}

// The box of a text object, in page units. The DRAWN box wins: that is the
// rectangle the user dragged, and the selection should follow it rather than
// hugging the glyphs.
function textBoxOf(s) {
  const anchor = s.points?.[0] ?? { x: s.x, y: s.y };
  if (!Number.isFinite(anchor?.x)) return null;
  const w = s.w > 0 ? s.w : s.measured?.width ?? s.size ?? 0;
  const h = s.h > 0 ? s.h : s.measured?.height ?? s.size ?? 0;
  return {
    minX: anchor.x,
    minY: anchor.y,
    maxX: anchor.x + w,
    maxY: anchor.y + h,
  };
}

// --- transforms -------------------------------------------------------------

// Translate every stroke by (dx, dy). Mutates in place and returns them.
export function translateStrokes(strokes, dx, dy) {
  eachPoint(strokes, (p) => {
    p.x += dx;
    p.y += dy;
  });
  return strokes ?? [];
}

// Scale every stroke about a fixed point, by (sx, sy).
//
// The stroke WIDTH scales with the geometric mean of |sx| and |sy|: a stroke
// scaled 2x in both axes is 2x wider, and a stroke stretched 4x in x and left
// alone in y is 2x wider (the mean), which is what the eye expects.
export function scaleStrokes(strokes, originX, originY, sx, sy) {
  const fx = Number.isFinite(sx) ? sx : 1;
  const fy = Number.isFinite(sy) ? sy : 1;
  const factor = Math.sqrt(Math.abs(fx) * Math.abs(fy));
  for (const s of strokes ?? []) {
    // A text object is a BOX, not a polyline: its anchor point moves, its box
    // and its font size scale, and the wrap memo is invalidated.
    if (s && s.kind === 'text') {
      const p = s.points && s.points[0];
      if (p) {
        p.x = originX + (p.x - originX) * fx;
        p.y = originY + (p.y - originY) * fy;
      }
      s.w = (Number.isFinite(s.w) ? s.w : 0) * Math.abs(fx);
      s.h = (Number.isFinite(s.h) ? s.h : 0) * Math.abs(fy);
      s.size = Math.max(1, (Number.isFinite(s.size) ? s.size : 28) * factor);
      s.measured = null;
      continue;
    }
    for (const p of s?.points ?? []) {
      p.x = originX + (p.x - originX) * fx;
      p.y = originY + (p.y - originY) * fy;
    }
    const w = Number.isFinite(s.width) ? s.width : 1;
    s.width = Math.max(MIN_STROKE_WIDTH, w * factor);
  }
  return strokes ?? [];
}

// Rotate every stroke about a fixed point, by an angle in RADIANS.
// The width is left alone: a rotated stroke is the same stroke.
export function rotateStrokes(strokes, originX, originY, radians) {
  const a = Number.isFinite(radians) ? radians : 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  eachPoint(strokes, (p) => {
    const dx = p.x - originX;
    const dy = p.y - originY;
    p.x = originX + dx * cos - dy * sin;
    p.y = originY + dx * sin + dy * cos;
  });
  return strokes ?? [];
}

// --- handles ----------------------------------------------------------------

// The 8 handle positions of a bounding box, in page coordinates:
// tl, t, tr, r, br, b, bl, l  (t/r/b/l are the edge midpoints).
export function handlePositions(bounds) {
  if (!bounds) return null;
  const { minX, minY, maxX, maxY } = bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    tl: { x: minX, y: minY },
    t: { x: cx, y: minY },
    tr: { x: maxX, y: minY },
    r: { x: maxX, y: cy },
    br: { x: maxX, y: maxY },
    b: { x: cx, y: maxY },
    bl: { x: minX, y: maxY },
    l: { x: minX, y: cy },
  };
}

// Which handle is within `tolerance` of the page point (x, y)?
// The tolerance is in PAGE units; the nearest handle wins.
export function hitHandle(bounds, x, y, tolerance = 8) {
  const pos = handlePositions(bounds);
  if (!pos) return null;
  const tol = Math.max(0, Number.isFinite(tolerance) ? tolerance : 0);
  let best = null;
  let bestDist = Infinity;
  for (const name of HANDLE_NAMES) {
    const p = pos[name];
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= tol && d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

// --- lasso ------------------------------------------------------------------

// Point-in-polygon, ray casting.
export function pointInPolygon(x, y, polygon) {
  const pts = Array.isArray(polygon) ? polygon : [];
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInBox(p, box) {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

function strokeBox(stroke) {
  return boxOfPoints(stroke?.points ?? []);
}

// The bounds of one stroke in page units: a text object is its BOX, while ink
// and shapes are the bounds of their points (a shape's points are vertices).
function strokeBounds(stroke) {
  if (stroke && stroke.kind === 'text') return textBoxOf(stroke);
  return strokeBox(stroke);
}

function rectBounds(box) {
  if (!box) return null;
  if (Number.isFinite(box.x) && Number.isFinite(box.y)) {
    const w = Number.isFinite(box.w) ? box.w : 0;
    const h = Number.isFinite(box.h) ? box.h : 0;
    return {
      minX: Math.min(box.x, box.x + w),
      minY: Math.min(box.y, box.y + h),
      maxX: Math.max(box.x, box.x + w),
      maxY: Math.max(box.y, box.y + h),
    };
  }
  if (
    Number.isFinite(box.minX) &&
    Number.isFinite(box.minY) &&
    Number.isFinite(box.maxX) &&
    Number.isFinite(box.maxY)
  ) {
    return { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
  }
  return null;
}

// The strokes a dragged rectangle catches. The rectangle is in PAGE units as
// { x, y, w, h }; touching an edge counts, so a marquee that just clips a
// stroke still selects it.
export function strokesInRect(strokes, box) {
  const rect = rectBounds(box);
  if (!rect) return [];
  const caught = [];
  for (const s of Array.isArray(strokes) ? strokes : []) {
    const b = strokeBounds(s);
    if (!b) continue;
    if (b.maxX < rect.minX || b.minX > rect.maxX) continue;
    if (b.maxY < rect.minY || b.minY > rect.maxY) continue;
    caught.push(s);
  }
  return caught;
}

function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointOnSegment(a, b, p) {
  if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x)) return false;
  if (p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) return false;
  return Math.abs(cross(a.x, a.y, b.x, b.y, p.x, p.y)) < 1e-9;
}

// Do the segments a-b and c-d cross (touching counts)?
function segmentsCross(a, b, c, d) {
  const d1 = cross(c.x, c.y, d.x, d.y, a.x, a.y);
  const d2 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
  const d3 = cross(a.x, a.y, b.x, b.y, c.x, c.y);
  const d4 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    pointOnSegment(c, d, a) ||
    pointOnSegment(c, d, b) ||
    pointOnSegment(a, b, c) ||
    pointOnSegment(a, b, d)
  );
}

// Does the segment a-b touch the axis-aligned box?
function segmentHitsBox(a, b, box) {
  if (pointInBox(a, box) || pointInBox(b, box)) return true;
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  for (let i = 0; i < 4; i += 1) {
    if (segmentsCross(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

// The strokes a lasso polygon catches.
//
// Deliberately generous: a stroke counts as caught when ANY of its points is
// inside the polygon, OR when the polygon crosses the stroke's bounding box
// (the lasso cut the stroke in half without any of its points landing
// inside). A lasso that misses a stroke it visibly sliced would feel broken.
export function strokesInPolygon(strokes, polygon) {
  const list = Array.isArray(strokes) ? strokes : [];
  const poly = Array.isArray(polygon) ? polygon : [];
  if (poly.length < 3) return [];
  const caught = [];
  for (const s of list) {
    const pts = s?.points ?? [];
    if (pts.length === 0) continue;
    let inside = false;
    for (const p of pts) {
      if (pointInPolygon(p.x, p.y, poly)) {
        inside = true;
        break;
      }
    }
    if (inside) {
      caught.push(s);
      continue;
    }
    const box = strokeBox(s);
    if (!box) continue;
    let crossed = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      if (segmentHitsBox(poly[j], poly[i], box)) {
        crossed = true;
        break;
      }
    }
    if (!crossed) {
      // The whole polygon may sit inside the stroke's box.
      for (const p of poly) {
        if (pointInBox(p, box)) {
          crossed = true;
          break;
        }
      }
    }
    if (crossed) caught.push(s);
  }
  return caught;
}
