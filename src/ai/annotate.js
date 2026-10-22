// ai/annotate.js — the AI page-annotation contract.
//
// WHY A NORMALIZED GRID: the model reads a picture of the page, so it cannot
// know the page's size in page units (a PDF page and an A4 sheet differ). It
// answers on a 0-1000 grid instead; the app multiplies by pageRect.w/1000 and
// pageRect.h/1000 before it creates real shapes. That keeps the prompt stable
// across every provider and every page size.
//
// THE PARSER IS DELIBERATELY TOLERANT: models wrap JSON in prose or code
// fences, add a trailing sentence, or return one bad row. parseAnnotations()
// finds the object, drops invalid rows, clamps what it can and never throws.
// A malformed reply is a normal answer to handle, not an exception.
//
// PURE MODULE: no DOM, no fetch, no storage. The test suite imports it in
// Node, exactly like providers.js.

export const ANNOTATION_TYPES = ['rect', 'ellipse', 'arrow', 'callout'];
export const MAX_ANNOTATIONS = 12;
export const MAX_LABEL_CHARS = 80;

// The system text for an annotate request. It is the ONLY instruction the
// model gets about the response shape; the user's own text stays the prompt.
export function annotationPrompt() {
  return [
    'You annotate a handwritten notebook page. Read the page image and the user request, then mark the parts of the page that matter.',
    'Return ONLY a JSON object. Do not write prose, and do not wrap it in code fences.',
    'The object must have exactly this shape:',
    '{"annotations":[{"type":"rect"|"ellipse"|"arrow"|"callout","x":n,"y":n,"w":n,"h":n,"label":"short"}]}',
    'x, y, w and h are numbers on a 0-1000 grid: (0, 0) is the page top-left and (1000, 1000) is the bottom-right. w and h are positive sizes.',
    'type must be rect, ellipse, arrow or callout.',
    'label is optional and at most 80 characters. Only a callout shows it.',
    `Return at most ${MAX_ANNOTATIONS} annotations. If nothing should be marked, return {"annotations":[]}.`,
  ].join('\n');
}

function fail(error) {
  return { ok: false, error };
}

// The first fenced block, when the model wrapped its answer. A fence with no
// closing backticks is left alone: the brace search below may still find it.
function fencedBody(text) {
  const match = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/.exec(text);
  return match ? match[1] : text;
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The index of the `}` that closes the `{` at `start`, respecting JSON
// strings and escapes. Returns -1 when the object is not closed.
function closingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The JSON value in a reply that may also contain prose. The whole text is
// tried first; then every balanced object is tried from its opening brace, so
// a stray "{" in the prose cannot hide the real answer.
function findJson(text) {
  const direct = parseJson(text.trim());
  if (direct.ok) return direct;
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = closingBrace(text, start);
    if (end < 0) continue;
    const found = parseJson(text.slice(start, end + 1));
    if (found.ok) return found;
  }
  return { ok: false };
}

function clampCoordinate(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return null;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1000, n));
}

// A label is one short line: control characters become spaces, runs of
// whitespace collapse, and the result is capped at 80 characters.
function sanitizeLabel(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

// One validated annotation, or null when the row cannot become a real shape.
// The type whitelist is the safety boundary: an unknown type must never reach
// createShapeStroke().
function normalizeAnnotation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!ANNOTATION_TYPES.includes(type)) return null;

  const x = clampCoordinate(raw.x);
  const y = clampCoordinate(raw.y);
  const w = clampCoordinate(raw.w);
  const h = clampCoordinate(raw.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (!(w > 0) || !(h > 0)) return null;

  const annotation = { type, x, y, w, h };
  const label = sanitizeLabel(raw.label);
  if (label) annotation.label = label;
  return annotation;
}

// Parse a model reply into page-normalized annotations.
//
// Returns { ok: true, annotations } or { ok: false, error }. Bad input is
// never an exception: a non-string, missing JSON, a wrong top-level shape and
// individual bad rows all have a defined answer.
export function parseAnnotations(text) {
  try {
    if (typeof text !== 'string') return fail('The reply was not text.');

    const source = fencedBody(text);
    const found = findJson(source);
    if (!found.ok) return fail('The reply did not contain a JSON annotations object.');

    const value = found.value;
    const list = Array.isArray(value) ? value : value?.annotations;
    if (!Array.isArray(list)) return fail('The reply did not contain an annotations list.');

    const annotations = [];
    for (const raw of list) {
      const annotation = normalizeAnnotation(raw);
      if (!annotation) continue;
      annotations.push(annotation);
      if (annotations.length >= MAX_ANNOTATIONS) break;
    }
    return { ok: true, annotations };
  } catch {
    return fail('The annotations could not be read.');
  }
}
