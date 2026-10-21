// Phase B logic test: strokes.js (model, rendering model, history, hit-test)
// + tools.js. Run: node <this file>. Exits nonzero on the first failure.
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const S = await import(pathToFileURL(`${SRC}/strokes.js`).href);
const T = await import(pathToFileURL(`${SRC}/tools.js`).href);

const {
  createStroke, addPoint, pressureOf, isTranslucent, isTextured,
  drawPieces, drawDot, drawTail, drawStrokePath, renderStroke,
  createHistory, addEntry, deleteEntry,
  removeStrokesById, insertStrokesAt,
  strokeHitTest, eraseHitIds,
} = S;
const {
  getCurrentTool, setCurrentTool, getToolOptions, setToolOptions, getTool,
  getTools, getWidthRange, supportsLineStyle, QUICK_COLORS,
} = T;

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`ok ${n} - ${name}`);
}

// Fake 2D context: records path geometry and style per stroke() call.
function fakeCtx() {
  const c = {
    strokes: 0,
    fills: 0,
    arcs: 0,
    paths: [],          // one entry per stroke() call
    moves: [],
    quads: [],
    lines: [],
    widths: [],
    caps: [],
    alphas: [],
    composite: [],
    dash: null,
    _cur: null,
  };
  return {
    c,
    save() {}, restore() {},
    setLineDash(v) { c.dash = v; },
    beginPath() { this._cur = { move: null, quads: [], line: null }; },
    moveTo(x, y) { this._cur.move = [x, y]; c.moves.push([x, y]); },
    quadraticCurveTo(cx, cy, x, y) { this._cur.quads.push([cx, cy, x, y]); c.quads.push([cx, cy, x, y]); },
    lineTo(x, y) { this._cur.line = [x, y]; c.lines.push([x, y]); },
    stroke() { c.strokes += 1; c.paths.push(this._cur); c.widths.push(this.lineWidth); c.caps.push(this.lineCap); c.alphas.push(this.globalAlpha); },
    fill() { c.fills += 1; },
    arc() { c.arcs += 1; },
    set globalCompositeOperation(v) { c.composite.push(v); },
    get globalCompositeOperation() { return 'source-over'; },
  };
}

// --- model ---
const s = createStroke({ tool: 'pen', color: '#000', width: 3, pointerType: 'pen' });
ok(s.points.length === 0 && typeof s.id === 'string', 'createStroke shape');
ok(s.pointerType === 'pen', 'pointerType stored on stroke');
ok(s.opacity === 1, 'default opacity 1');
ok(isTranslucent(s) === false, 'opaque stroke is not translucent');
ok(pressureOf({ pressure: 0 }) === 0.5, 'pressure 0 -> fallback 0.5');
ok(pressureOf({}) === 0.5, 'pressure undefined -> fallback 0.5');
ok(pressureOf({ pressure: 0.7 }) === 0.7, 'pressure passthrough');
ok(pressureOf({ pressure: 5 }) === 1, 'pressure clamped to 1');

const hl = createStroke({ tool: 'highlighter', color: '#ffeb3b', width: 14, opacity: 0.5 });
ok(isTranslucent(hl) === true, 'highlighter is translucent');

// --- rendering: midpoint-forward pieces ---
// Points p0..p4 on a straight line at 10px spacing.
// piece 1: p0 -> (ctrl p1) -> mid(p1,p2) = 15
// piece 2: mid(p1,p2)=15 -> (ctrl p2) -> mid(p2,p3) = 25
// piece 3: mid(p2,p3)=25 -> (ctrl p3) -> mid(p3,p4) = 35
// tail:    35 -> p4 = 40
const line = createStroke({ width: 4 });
for (let i = 0; i < 5; i++) addPoint(line, i * 10, 0, 0.5);

const ctx = fakeCtx();
drawPieces(ctx, line, 1, 3);
ok(ctx.c.strokes === 3, 'one stroke() call per piece (opaque)');
ok(ctx.c.moves[0][0] === 0, 'piece 1 starts at the first point');
ok(ctx.c.quads[0][0] === 10 && ctx.c.quads[0][1] === 0, 'piece 1 control = p1');
ok(ctx.c.quads[0][2] === 15, 'piece 1 ends at mid(p1,p2)');
ok(ctx.c.quads[1][0] === 20, 'piece 2 control = p2');
ok(ctx.c.quads[1][2] === 25, 'piece 2 ends at mid(p2,p3)');
ok(ctx.c.quads[2][2] === 35, 'piece 3 ends at mid(p3,p4)');
ok(ctx.c.widths[0] === 2, 'piece width = base width * avg pressure (4 * 0.5)');
ok(ctx.c.caps[0] === 'round', 'opaque stroke uses round caps');
ok(ctx.c.alphas[0] === 1, 'opaque stroke alpha 1');

// Continuity: each piece must start exactly where the previous ended.
const ends = ctx.c.quads.map((q) => [q[2], q[3]]);
const starts = ctx.c.paths.map((p) => p.move);
let continuous = true;
for (let i = 1; i < ends.length; i++) {
  if (Math.abs(ends[i - 1][0] - starts[i][0]) > 1e-9 || Math.abs(ends[i - 1][1] - starts[i][1]) > 1e-9) continuous = false;
}
ok(continuous, 'consecutive pieces share their endpoint (no gap)');

// Incremental: drawing the next piece must not repaint the previous one.
const inc = fakeCtx();
drawPieces(inc, line, 1, 1);
ok(inc.c.strokes === 1, 'first batch draws one piece');
drawPieces(inc, line, 2, 2);
ok(inc.c.strokes === 2, 'second batch draws only the new piece');
ok(inc.c.quads.length === 2, 'no segment is ever painted twice');

// Tail
const tctx = fakeCtx();
drawTail(tctx, line);
ok(tctx.c.strokes === 1, 'tail is one stroke() call');
ok(tctx.c.moves[0][0] === 35, 'tail starts at mid(p3,p4)');
ok(tctx.c.lines[0][0] === 40, 'tail ends at the last point');

// Translucent: one path per batch, butt caps, destination-over.
const t2 = fakeCtx();
const hline = createStroke({ width: 14, opacity: 0.5 });
for (let i = 0; i < 5; i++) addPoint(hline, i * 10, 0, 0.5);
drawPieces(t2, hline, 1, 3);
ok(t2.c.strokes === 1, 'translucent batch = ONE stroke() call (no alpha stacking)');
ok(t2.c.paths[0].quads.length === 3, 'all three pieces in one path');
ok(t2.c.caps[0] === 'butt', 'translucent uses butt caps (no double-composited joints)');
ok(t2.c.alphas[0] === 0.5, 'translucent alpha applied');
ok(t2.c.composite.includes('destination-over'), 'translucent renders behind ink');

// Dot / short strokes
const dot = createStroke({ width: 4 });
addPoint(dot, 5, 5, 0.5);
const dctx = fakeCtx();
drawDot(dctx, dot, dot.points[0]);
ok(dctx.c.arcs === 1 && dctx.c.fills === 1, 'single point = a dot');
const two = createStroke({ width: 4 });
addPoint(two, 0, 0, 0.5);
addPoint(two, 10, 0, 0.5);
const tctx2 = fakeCtx();
drawTail(tctx2, two);
ok(tctx2.c.strokes === 1 && tctx2.c.lines[0][0] === 10, 'two points = a straight line');

// Full redraw
const fctx = fakeCtx();
renderStroke(fctx, line);
ok(fctx.c.strokes === 4, 'full redraw = 3 pieces + tail');
ok(fctx.c.moves[0][0] === 0 && fctx.c.lines[0][0] === 40, 'full redraw spans p0..p4');
const fctx2 = fakeCtx();
renderStroke(fctx2, dot);
ok(fctx2.c.fills === 1, 'full redraw of a dot');
const fctx3 = fakeCtx();
renderStroke(fctx3, two);
ok(fctx3.c.strokes === 1, 'full redraw of a 2-point stroke');
const fctx4 = fakeCtx();
renderStroke(fctx4, createStroke({}));
ok(fctx4.c.strokes === 0, 'full redraw of an empty stroke draws nothing');

// --- hit-test ---
ok(strokeHitTest(line, 20, 0, 14) === true, 'hit on segment');
ok(strokeHitTest(line, 20, 50, 14) === false, 'miss far from segment');
ok(strokeHitTest(line, 20, 10, 14) === true, 'hit within radius');
ok(strokeHitTest(dot, 5, 5, 14) === true, 'hit single-point dot');
ok(strokeHitTest(dot, 100, 100, 14) === false, 'miss single-point dot');
ok(strokeHitTest(createStroke({}), 0, 0, 14) === false, 'empty stroke never hits');

// --- history ---
const arr = [];
const h = createHistory();
ok(h.canUndo === false && h.canRedo === false, 'history starts empty');
const a = createStroke({});
const b = createStroke({});
h.commit(addEntry(a, 0));
arr.push(a);
h.commit(addEntry(b, 1));
arr.push(b);
ok(h.undo(arr) === true && arr.length === 1 && arr[0] === a, 'undo removes b');
ok(h.undo(arr) === true && arr.length === 0, 'undo removes a');
ok(h.undo(arr) === false, 'undo on empty returns false');
ok(h.redo(arr) === true && arr.length === 1 && arr[0] === a, 'redo restores a at index 0');
ok(h.redo(arr) === true && arr.length === 2 && arr[1] === b, 'redo restores b at index 1');
h.undo(arr);
h.commit(addEntry(createStroke({}), 1));
ok(h.canRedo === false, 'new commit clears redo stack');

const arr2 = [createStroke({}), createStroke({}), createStroke({})];
const h2 = createHistory();
const removed = removeStrokesById(arr2, [arr2[1].id]);
ok(arr2.length === 2 && removed.length === 1 && removed[0].index === 1, 'remove middle stroke');
h2.commit(deleteEntry(removed));
h2.undo(arr2);
ok(arr2.length === 3 && arr2[1] === removed[0].stroke, 'undo delete restores z-order');
h2.redo(arr2);
ok(arr2.length === 2, 'redo delete removes again');
insertStrokesAt(arr2, [{ stroke: createStroke({}), index: 99 }]);
ok(arr2.length === 3, 'insert clamps over-large index to end');

// --- erase ---
const e1 = createStroke({});
addPoint(e1, 0, 0, 0.5);
addPoint(e1, 100, 0, 0.5);
const e2 = createStroke({});
addPoint(e2, 0, 200, 0.5);
addPoint(e2, 100, 200, 0.5);
const hits = eraseHitIds([e1, e2], [{ x: 50, y: 5 }], 14);
ok(hits.length === 1 && hits[0] === e1.id, 'eraseHitIds hits only touched stroke');
ok(eraseHitIds([e1, e2], [{ x: 500, y: 500 }], 14).length === 0, 'eraseHitIds empty on miss');

// --- tools ---
ok(getCurrentTool().id === 'pen', 'default tool is pen');
ok(getToolOptions('pen').width === 3, 'pen default width');
ok(getToolOptions('pen').pressureTaper === true, 'pen tapers with pressure');
ok(getToolOptions('marker').width === 18, 'marker default width');
ok(getToolOptions('marker').opacity === 0.5, 'marker is translucent');
ok(getToolOptions('marker').pressureTaper === false, 'marker has a constant width');
ok(getToolOptions('pencil').opacity === 1, 'pencil is opaque');
ok(getToolOptions('pencil').pressureTaper === false, 'pencil has a constant width');
ok(getToolOptions('eraser').radius === 14, 'eraser radius default');
setToolOptions('pen', { color: '#ff0000' });
ok(getToolOptions('pen').color === '#ff0000', 'setToolOptions patches pen colour');
ok(getTools().length === 6, 'six tools registered');
ok(getTools().every((t) => t.name && t.icon), 'every tool has a name and an icon');
ok(getWidthRange('pen').max === 20, 'pen width range');
ok(getWidthRange('marker').min === 6, 'marker width range');
ok(supportsLineStyle('pen') === true, 'pen supports line styles');
ok(supportsLineStyle('pencil') === true, 'pencil supports line styles');
ok(supportsLineStyle('marker') === false, 'translucent marker does NOT support line styles');
ok(supportsLineStyle('eraser') === false, 'eraser does not support line styles');
ok(supportsLineStyle('shape') === true, 'shape supports line styles');
ok(supportsLineStyle('select') === false, 'select does not support line styles');
ok(getToolOptions('shape').shape === 'rect', 'shape tool default kind');
ok(getToolOptions('shape').fill === 'freeform', 'shape tool default fill mode');
ok(getToolOptions('shape').pressureTaper === false, 'shape has a constant width');
ok(getTool('select').kind === 'select', 'select tool is a select tool');
ok(getTool('shape').kind === 'shape', 'shape tool is a shape tool');
ok(QUICK_COLORS.length === 6, 'quick colour row has six swatches');
let threw = false;
try { setCurrentTool('nope'); } catch { threw = true; }
ok(threw === true, 'unknown tool throws');

// --- line styles ---------------------------------------------------------
{
  const dashed = createStroke({ width: 4, lineStyle: 'dashed' });
  ok(isTextured(dashed) === true, 'dashed stroke is textured');
  ok(isTextured(createStroke({ lineStyle: 'solid' })) === false, 'solid stroke is not textured');
  ok(isTextured(createStroke({ lineStyle: 'dashed', opacity: 0.5 })) === false,
    'translucent stroke is never textured (no alpha stacking)');

  for (let i = 0; i < 5; i++) addPoint(dashed, i * 10, 0, 0.5);
  const dctx = fakeCtx();
  drawStrokePath(dctx, dashed);
  ok(dctx.c.strokes === 1, 'textured stroke is ONE path / ONE stroke() call');
  ok(dctx.c.quads.length === 3, 'all pieces are in the single path');
  ok(Array.isArray(dctx.c.dash) && dctx.c.dash.length === 2, 'a dash pattern is applied');
  ok(dctx.c.dash[0] > 0, 'dash length scales with the stroke width');

  // The path must be continuous: piece i starts where piece i-1 ended.
  const d = fakeCtx();
  drawStrokePath(d, dashed);
  ok(d.c.moves[0][0] === 0, 'textured path starts at the first point');
  ok(d.c.lines.length === 1 && d.c.lines[0][0] === 40, 'textured path includes the tail');

  // A constant-width (pencil) stroke does not follow pressure.
  const pencil = createStroke({ width: 4, pressureTaper: false });
  for (let i = 0; i < 5; i++) addPoint(pencil, i * 10, 0, 0.1);
  const pctx = fakeCtx();
  drawPieces(pctx, pencil, 1, 3);
  ok(pctx.c.widths[0] === 4, 'a constant-width tool ignores pressure');
}

// --- page model ----------------------------------------------------------
{
  const P = await import(pathToFileURL(`${SRC}/pages.js`).href);
  const note = P.createNote({ title: 'HW 3' });
  ok(note.pages.length === 1, 'a new note has one page');
  ok(note.pages[0].strokes.length === 0 && note.pages[0].layers.length === 0,
    'a new page has no strokes and no layers');
  ok(typeof note.id === 'string' && note.id.length > 0, 'a note has an id');

  const page = note.pages[0];
  const layer = { id: 'l1', kind: 'image', url: 'blob:x', loaded: true };
  P.addLayer(page, layer);
  ok(page.layers.length === 1, 'a layer can be added to a page');
  ok(P.pageHasContent(page) === true, 'a page with a layer has content');

  const fit = P.containFit(200, 400, 0, 0, 100, 100);
  ok(fit.w === 50 && fit.h === 100, 'containFit keeps the aspect ratio');
  ok(fit.x === 25, 'containFit centres the fitted rect');
  const wide = P.containFit(400, 200, 0, 0, 100, 100);
  ok(wide.w === 100 && wide.h === 50, 'containFit fits a landscape source');
}

console.log(`\nALL ${n} CHECKS PASSED`);
