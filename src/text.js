// text.js — the TEXT OBJECT model.
//
// WHY A TEXT OBJECT LOOKS LIKE A STROKE: a page owns ONE ordered list of ink
// (`page.strokes`). A text box has to live in that same list, or it would need
// a parallel model for undo, persistence, the lasso, the eraser and the PNG
// export. So a text object is a stroke with `kind: 'text'` and two extra
// fields — the string and the font size — whose single point is the text
// ANCHOR (the top-left of the text box).
//
// THE ANCHOR IS THE POINT, NOT x/y: every transform in src/transform.js moves
// the POINTS, so the anchor has to be points[0] — otherwise a moved text box
// would stay behind while its point travelled. x/y mirror the anchor for code
// that reads a position directly; syncTextAnchor() copies the point back.
//
// DOM-free on purpose: the canvas, the export and a Node test all import this
// module, so nothing here may touch `document` or `window`.

export const DEFAULT_TEXT_SIZE = 28;
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 96;

// The app's font. The same stack the theme uses, so a text object reads as
// part of the UI rather than as a canvas special.
export const TEXT_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// The baseline sits this far below the top of the box, and the lines are this
// far apart. Both are ratios of the font size, so they scale with it.
const ASCENT_RATIO = 0.8;
const LINE_HEIGHT_RATIO = 1.2;

let nextId = 1;

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through to the counter-based id
    }
  }
  nextId += 1;
  return `text-${Date.now()}-${nextId}`;
}

function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// The CSS font shorthand for a size, in page units.
export function textFont(size) {
  return `${clampTextSize(size)}px ${TEXT_FONT_STACK}`;
}

export function clampTextSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return DEFAULT_TEXT_SIZE;
  return Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, n));
}

// A text object is anything that says it is one.
export function isTextObject(obj) {
  return Boolean(obj) && obj.kind === 'text';
}

// The anchor of a text object: the point if there is one, else x/y.
function anchorOf(obj) {
  const p = obj?.points?.[0];
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  return { x: Number(obj?.x) || 0, y: Number(obj?.y) || 0 };
}

// Copy the anchor point back onto x/y. Call this after a move, a scale or a
// rotation: the transforms move the points, and x/y are only a mirror.
export function syncTextAnchor(obj) {
  if (!obj || !obj.points || obj.points.length === 0) return obj;
  const p = obj.points[0];
  obj.x = p.x;
  obj.y = p.y;
  return obj;
}

// A text object ready to be committed to a page.
//
// It carries every field a stroke carries, so the existing history, storage,
// export and selection code accepts it unchanged. `width` is 0 because a
// text box has no line width, and `points` holds the single anchor point.
export function createText({
  x = 0,
  y = 0,
  text = '',
  size = DEFAULT_TEXT_SIZE,
  color = '#1b1b1b',
} = {}) {
  const px = Number.isFinite(Number(x)) ? Number(x) : 0;
  const py = Number.isFinite(Number(y)) ? Number(y) : 0;
  return {
    id: makeId(),
    kind: 'text',
    tool: 'text',
    color,
    width: 0,
    opacity: 1,
    pointerType: 'mouse',
    lineStyle: 'solid',
    pressureTaper: false,
    size: clampTextSize(size),
    x: px,
    y: py,
    text: String(text ?? ''),
    points: [{ x: px, y: py, pressure: 0.5, t: now() }],
    // Filled in by measureText(): { width, height, size, text }.
    measured: null,
  };
}

// Measure a text object with a 2D context.
//
// The result is cached on the object. The cache records the size and the
// string it was measured for, so editing the text or resizing it invalidates
// the cache by itself — no explicit invalidation call to forget.
//
// A multi-line text is measured as the WIDEST line: that is the box width.
export function measureText(ctx, obj) {
  if (!ctx || !obj) return { width: 0, height: 0 };
  const size = clampTextSize(obj.size);
  const text = String(obj.text ?? '');
  const cached = obj.measured;
  if (cached && cached.size === size && cached.text === text) return cached;

  ctx.save?.();
  ctx.font = textFont(size);
  const lines = text.split('\n');
  let width = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    const w = Number(m?.width);
    if (Number.isFinite(w) && w > width) width = w;
  }
  ctx.restore?.();

  const measured = {
    width,
    height: lines.length * size * LINE_HEIGHT_RATIO,
    size,
    text,
  };
  obj.measured = measured;
  return measured;
}

// Draw a text object into a 2D context, in PAGE coordinates.
//
// One fillText per line. The baseline of the first line sits `ascent` below
// the anchor, so the anchor is the TOP-LEFT of the text box — which is what
// a user means by "the text goes here".
//
// The measured box is returned, so the caller can use it for the selection
// rectangle without measuring again.
export function renderText(ctx, obj) {
  if (!ctx || !obj) return null;
  const size = clampTextSize(obj.size);
  const text = String(obj.text ?? '');
  const anchor = anchorOf(obj);
  const measured = measureText(ctx, obj);
  if (!text) return measured;

  ctx.save?.();
  ctx.font = textFont(size);
  ctx.fillStyle = obj.color ?? '#1b1b1b';
  ctx.globalAlpha = obj.opacity ?? 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const lines = text.split('\n');
  const lineHeight = size * LINE_HEIGHT_RATIO;
  const ascent = size * ASCENT_RATIO;
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], anchor.x, anchor.y + ascent + i * lineHeight);
  }
  ctx.restore?.();
  return measured;
}

// The bounding box of a text object, in page units.
//
// Uses the measured box when there is one. Without a measurement — the object
// has never been drawn — it falls back to a size x size square at the anchor,
// so the box is still usable for a hit test or a selection rectangle.
export function textBounds(obj) {
  const size = clampTextSize(obj?.size);
  const anchor = anchorOf(obj);
  const m = obj?.measured;
  const width = m && Number.isFinite(m.width) ? m.width : size;
  const height = m && Number.isFinite(m.height) ? m.height : size;
  return {
    minX: anchor.x,
    minY: anchor.y,
    maxX: anchor.x + width,
    maxY: anchor.y + height,
  };
}
