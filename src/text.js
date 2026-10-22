// text.js — the TEXT OBJECT model: a BOX of text on the page.
//
// WHY A BOX AND NOT A POINT: a text box is dragged out on the page, so the
// object has to remember a RECTANGLE (x, y, w, h) and the text has to be
// WRAPPED to that width. A single anchor point cannot say where the second
// line goes, nor how wide the text may grow.
//
// WHY IT STILL LOOKS LIKE A STROKE: a page owns ONE ordered list of ink
// (`page.strokes`), so a text box lives in that same list and gets undo,
// persistence, the lasso, the eraser and the PNG export for free. It is a
// stroke with `kind: 'text'` whose single point is the box's TOP-LEFT corner.
//
// THE ANCHOR IS THE POINT, NOT x/y: the transforms in src/transform.js move
// the POINTS, so the anchor has to be points[0] — otherwise a moved text box
// would stay behind while its point travelled. x/y mirror the anchor.
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

// Slack for float comparisons: a wrapped height lands a hair over the box.
const EPSILON = 0.01;

let nextId = 1;

function makeId() {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through to the counter-based id
  }
  nextId += 1;
  return `text-${Date.now()}-${nextId}`;
}

function now() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

// The top-left corner of a text object: the point if there is one, else x/y.
function anchorOf(obj) {
  const p = obj?.points?.[0];
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  return { x: num(obj?.x), y: num(obj?.y) };
}

// Copy the anchor point back onto x/y: the transforms move the points.
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
// text box has no line width, and `points` holds the single top-left corner.
// `w`/`h` are the box in PAGE units; 0 means "size me to the text".
export function createText({
  x = 0, y = 0, w = 0, h = 0, text = '', size = DEFAULT_TEXT_SIZE, color = '#1b1b1b',
} = {}) {
  const px = num(x);
  const py = num(y);
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
    x: px,
    y: py,
    w: Math.max(0, num(w)),
    h: Math.max(0, num(h)),
    size: clampTextSize(size),
    text: String(text ?? ''),
    points: [{ x: px, y: py, pressure: 0.5, t: now() }],
    // Filled in by measureText(): { width, height, lines, size, text, w }.
    measured: null,
  };
}

// --- wrapping ---------------------------------------------------------------

function widthOf(ctx, text) {
  return num(ctx.measureText(text)?.width);
}

// Split one paragraph into the lines that fit a box width. Words are kept
// whole while they fit; a word wider than the box (a long URL) is broken at
// the character level, so it cannot run off the side of the page.
function wrapParagraph(ctx, paragraph, limit) {
  const words = String(paragraph).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(ctx, candidate) <= limit) {
      line = candidate;
      continue;
    }
    if (line) { lines.push(line); line = ''; }
    if (widthOf(ctx, word) <= limit) { line = word; continue; }
    // The word is wider than the box: cut it into pieces that fit.
    let chunk = '';
    for (const ch of word) {
      if (chunk && widthOf(ctx, chunk + ch) > limit) {
        lines.push(chunk);
        chunk = '';
      }
      chunk += ch;
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}

// The lines of a text object, wrapped to a box width. A box width of 0 means
// the box is auto-sized: every "\n" starts a new line and nothing else
// breaks.
function wrapText(ctx, text, limit) {
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (limit <= 0) {
      out.push(paragraph);
      continue;
    }
    for (const line of wrapParagraph(ctx, paragraph, limit)) out.push(line);
  }
  return out.length ? out : [''];
}

// Measure a text object with a 2D context.
//
// The result is cached on the object, together with the text, the size and the
// box width it was measured for, so editing any of them invalidates the cache
// by itself — no explicit invalidation call to forget. The width is the
// WIDEST wrapped line, the height the lines times the line height.
export function measureText(ctx, obj) {
  if (!ctx || !obj) return { width: 0, height: 0, lines: [] };
  const size = clampTextSize(obj.size);
  const text = String(obj.text ?? '');
  const w = Math.max(0, num(obj.w));
  const cached = obj.measured;
  if (cached && cached.size === size && cached.text === text && cached.w === w) return cached;

  ctx.save?.();
  ctx.font = textFont(size);
  const lines = wrapText(ctx, text, w);
  let width = 0;
  for (const line of lines) width = Math.max(width, widthOf(ctx, line));
  ctx.restore?.();

  const measured = { width, height: lines.length * size * LINE_HEIGHT_RATIO, lines, size, text, w };
  obj.measured = measured;
  return measured;
}

// Draw a text object into a 2D context, in PAGE coordinates.
//
// One fillText per wrapped line. The baseline of the first line sits `ascent`
// below the top-left corner of the box, so the corner is the TOP-LEFT of the
// text box. Text that is taller than its box is NOT clipped: it overflows,
// drawn a little faint so the overflow reads as a warning.
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

  const lines = Array.isArray(measured?.lines) ? measured.lines : [];
  ctx.save?.();
  ctx.font = textFont(size);
  ctx.fillStyle = obj.color ?? '#1b1b1b';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const boxH = num(obj.h);
  const overflows = boxH > 0 && num(measured?.height) > boxH + EPSILON;
  ctx.globalAlpha = num(obj.opacity, 1) * (overflows ? 0.7 : 1);

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
// The drawn box wins. When the box is auto-sized (w/h are 0) the measured
// text is used instead, and without a measurement a size x size square.
export function textBounds(obj) {
  const size = clampTextSize(obj?.size);
  const anchor = anchorOf(obj);
  const m = obj?.measured;
  const w = num(obj?.w) > 0 ? num(obj.w) : num(m?.width, size);
  const h = num(obj?.h) > 0 ? num(obj.h) : num(m?.height, size);
  return { minX: anchor.x, minY: anchor.y, maxX: anchor.x + w, maxY: anchor.y + h };
}

// --- auto-fit ---------------------------------------------------------------

// Does the text fit the box at this size?
function fitsInBox(ctx, obj, size) {
  const measured = measureText(ctx, { ...obj, size });
  const w = num(obj.w);
  const h = num(obj.h);
  if (w > 0 && num(measured?.width) > w + EPSILON) return false;
  if (h > 0 && num(measured?.height) > h + EPSILON) return false;
  return true;
}

// The largest font size at which the text still fits its box.
//
// A big font in a small box shrinks to fit, but never below `min`: text that
// is too small to read is worse than text that overflows. A box with no width
// or no height constrains nothing on that axis. The size is returned, not
// applied: the caller sets it on the object.
export function fitTextSize(ctx, obj, { min = MIN_TEXT_SIZE } = {}) {
  if (!ctx || !obj) return clampTextSize(obj?.size);
  const max = clampTextSize(obj.size);
  const lo = Math.max(1, Math.min(max, num(min, MIN_TEXT_SIZE)));
  if (lo >= max) return fitsInBox(ctx, obj, max) ? max : lo;
  // Binary search on the integer sizes: the text needs less room as the font
  // gets smaller, so the search is monotone.
  let best = lo;
  let low = lo;
  let high = Math.floor(max);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (!fitsInBox(ctx, obj, mid)) high = mid - 1;
    else {
      best = mid;
      low = mid + 1;
    }
  }
  return best;
}
