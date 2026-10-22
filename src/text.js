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

// Rich-text families. SYSTEM stacks only: no webfont is fetched, so a note
// renders the same with the network off (and on every platform that has the
// face, with a sensible fallback when it does not).
export const TEXT_FONT_FAMILIES = {
  sans: TEXT_FONT_STACK,
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Courier New", monospace',
  hand: '"Bradley Hand", "Segoe Script", cursive',
};

export const TEXT_FAMILIES = ['sans', 'serif', 'mono', 'hand'];
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const TEXT_LISTS = ['none', 'bullet', 'number'];

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

// The CSS font shorthand for a size, in page units. A family is one of
// TEXT_FAMILIES; bold/italic are part of the shorthand the canvas needs.
export function textFont(size, family = 'sans', { bold = false, italic = false } = {}) {
  const style = `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}`;
  return `${style}${clampTextSize(size)}px ${fontStack(family)}`;
}

export function fontStack(family) {
  return TEXT_FONT_FAMILIES[family] ?? TEXT_FONT_STACK;
}

export function clampTextSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return DEFAULT_TEXT_SIZE;
  return Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, n));
}

function normalizeFamily(family) {
  return TEXT_FAMILIES.includes(family) ? family : 'sans';
}

function normalizeAlign(align) {
  return TEXT_ALIGNS.includes(align) ? align : 'left';
}

function normalizeList(list) {
  return TEXT_LISTS.includes(list) ? list : 'none';
}

// The rich-text fields, with old records and partial updates normalised to
// the defaults that preserve the original plain text look.
function textStyle(obj) {
  return {
    family: normalizeFamily(obj?.family),
    bold: obj?.bold === true,
    italic: obj?.italic === true,
    underline: obj?.underline === true,
    align: normalizeAlign(obj?.align),
    list: normalizeList(obj?.list),
  };
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
  family = 'sans', bold = false, italic = false, underline = false,
  align = 'left', list = 'none',
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
    family: normalizeFamily(family),
    bold: bold === true,
    italic: italic === true,
    underline: underline === true,
    align: normalizeAlign(align),
    list: normalizeList(list),
    points: [{ x: px, y: py, pressure: 0.5, t: now() }],
    // Filled in by measureText(): the wrapped lines and their list markers.
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

// The lines of a text object, wrapped to a box width, together with the list
// marker and left inset of each line.
//
// A box width of 0 means the box is auto-sized: every "\n" starts a new line
// and nothing else breaks. For a list, the marker reserves an inset on EVERY
// line of its item, so a wrapped continuation stays aligned under the text,
// not under the bullet. Only the first line of an item carries the marker.
function wrapText(ctx, text, limit, list) {
  const out = [];
  const markers = [];
  const indents = [];
  let number = 0;
  for (const paragraph of String(text ?? '').split('\n')) {
    const blank = paragraph.trim() === '';
    let marker = '';
    if (list !== 'none' && !blank) {
      number += 1;
      marker = list === 'bullet' ? '•' : `${number}.`;
    }
    const indent = marker ? widthOf(ctx, `${marker} `) : 0;
    const available = limit > 0 ? Math.max(0, limit - indent) : 0;
    const lines = blank
      ? ['']
      : available > 0
        ? wrapParagraph(ctx, paragraph, available)
        : [paragraph];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]);
      markers.push(i === 0 ? marker : '');
      indents.push(blank ? 0 : indent);
    }
  }
  if (!out.length) {
    out.push('');
    markers.push('');
    indents.push(0);
  }
  return { lines: out, markers, indents };
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
  const style = textStyle(obj);
  const cached = obj.measured;
  if (
    cached &&
    cached.size === size &&
    cached.text === text &&
    cached.w === w &&
    cached.family === style.family &&
    cached.bold === style.bold &&
    cached.italic === style.italic &&
    cached.underline === style.underline &&
    cached.align === style.align &&
    cached.list === style.list
  ) {
    return cached;
  }

  ctx.save?.();
  ctx.font = textFont(size, style.family, style);
  const { lines, markers, indents } = wrapText(ctx, text, w, style.list);
  const lineWidths = [];
  let width = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineWidth = widthOf(ctx, lines[i]);
    lineWidths.push(lineWidth);
    width = Math.max(width, indents[i] + lineWidth);
  }
  ctx.restore?.();

  const measured = {
    width,
    height: lines.length * size * LINE_HEIGHT_RATIO,
    lines,
    markers,
    indents,
    lineWidths,
    size,
    text,
    w,
    ...style,
  };
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
  const style = textStyle(obj);
  const measured = measureText(ctx, obj);
  if (!text) return measured;

  const lines = Array.isArray(measured?.lines) ? measured.lines : [];
  const markers = Array.isArray(measured?.markers) ? measured.markers : [];
  const indents = Array.isArray(measured?.indents) ? measured.indents : [];
  const lineWidths = Array.isArray(measured?.lineWidths) ? measured.lineWidths : [];
  const color = obj.color ?? '#1b1b1b';

  ctx.save?.();
  ctx.font = textFont(size, style.family, style);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const boxH = num(obj.h);
  const overflows = boxH > 0 && num(measured?.height) > boxH + EPSILON;
  ctx.globalAlpha = num(obj.opacity, 1) * (overflows ? 0.7 : 1);

  const lineHeight = size * LINE_HEIGHT_RATIO;
  const ascent = size * ASCENT_RATIO;
  // Align relative to the DRAWN box; an auto-sized box aligns inside its
  // measured width, which is a no-op for every line shorter than the widest.
  const boxW = num(obj.w) > 0 ? num(obj.w) : num(measured?.width);
  for (let i = 0; i < lines.length; i += 1) {
    const lineWidth = lineWidths[i] ?? 0;
    const indent = indents[i] ?? 0;
    const fullWidth = indent + lineWidth;
    const offset =
      style.align === 'center'
        ? (boxW - fullWidth) / 2
        : style.align === 'right'
          ? boxW - fullWidth
          : 0;
    const y = anchor.y + ascent + i * lineHeight;
    const x = anchor.x + offset + indent;
    if (markers[i]) ctx.fillText(markers[i], anchor.x + offset, y);
    ctx.fillText(lines[i], x, y);
    if (style.underline && lineWidth > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.beginPath?.();
      ctx.moveTo?.(x, y + size * 0.18);
      ctx.lineTo?.(x + lineWidth, y + size * 0.18);
      ctx.stroke?.();
    }
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
