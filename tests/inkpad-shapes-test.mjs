// Node test for src/shapes.js and src/ui/shape-editor.js.
//
//   node tests/inkpad-shapes-test.mjs
//
// The repo is a static site with no test runner, so this is a plain script:
// it prints "ALL N CHECKS PASSED" and exits non-zero on the first failure.
// The canvas is faked — no real 2D context needed.

import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const {
  SHAPE_KINDS,
  SHAPE_LABELS,
  SHAPE_MODES,
  MAX_CUSTOM_VERTICES,
  shapePoints,
  shapeVertices,
  simplifyPath,
  snapAngle,
  snapSquare,
  snapToGrid,
  snapVertex,
  setVertex,
  toSquare,
  vertexPositions,
  shapeOutline,
  shapeHitTest,
  renderShape,
  createShapeStroke,
  isShapeStroke,
  isClosedShape,
} = await import(pathToFileURL(`${SRC}/shapes.js`).href);

let checks = 0;

function check(name, cond) {
  checks += 1;
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
}

function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function samePoint(a, b, eps = 1e-6) {
  return near(a.x, b.x, eps) && near(a.y, b.y, eps);
}

// A fake 2D context: it only counts the calls the renderer makes.
function makeCtx() {
  const calls = {
    stroke: 0, fill: 0, beginPath: 0, moveTo: 0, lineTo: 0,
    closePath: 0, save: 0, restore: 0, setLineDash: 0,
  };
  return {
    calls,
    dash: null,
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    save() { calls.save += 1; },
    restore() { calls.restore += 1; },
    beginPath() { calls.beginPath += 1; },
    closePath() { calls.closePath += 1; },
    moveTo() { calls.moveTo += 1; },
    lineTo() { calls.lineTo += 1; },
    setLineDash(d) { calls.setLineDash += 1; this.dash = d; },
    stroke() { calls.stroke += 1; },
    fill() { calls.fill += 1; },
  };
}

const BOX = { x0: 0, y0: 0, x1: 100, y1: 50 };

// --- the module imports cleanly in Node -------------------------------------
check(
  'shapes.js exports the expected API',
  SHAPE_KINDS.length === 6 &&
    SHAPE_MODES.length === 2 &&
    MAX_CUSTOM_VERTICES === 6 &&
    typeof shapePoints === 'function' &&
    typeof shapeVertices === 'function' &&
    typeof simplifyPath === 'function' &&
    typeof vertexPositions === 'function' &&
    typeof setVertex === 'function' &&
    typeof toSquare === 'function' &&
    typeof snapVertex === 'function' &&
    typeof snapAngle === 'function' &&
    typeof snapSquare === 'function' &&
    typeof snapToGrid === 'function' &&
    typeof shapeOutline === 'function' &&
    typeof shapeHitTest === 'function' &&
    typeof renderShape === 'function' &&
    typeof createShapeStroke === 'function',
);
check('every shape kind has a label', SHAPE_KINDS.every((k) => typeof SHAPE_LABELS[k] === 'string'));
check('the draw modes are boxed and freeform', SHAPE_MODES[0] === 'boxed' && SHAPE_MODES[1] === 'freeform');

// --- boxed mode -------------------------------------------------------------
const boxLine = shapeVertices('line', 'boxed', { box: BOX });
check('a boxed line has 2 vertices', boxLine.length === 2);
check(
  'a boxed line is the diagonal of the box',
  samePoint(boxLine[0], { x: 0, y: 0 }) && samePoint(boxLine[1], { x: 100, y: 50 }),
);

const boxRect = shapeVertices('rect', 'boxed', { box: BOX });
check('a boxed rect has 4 vertices', boxRect.length === 4);
check(
  'a boxed rect uses the corners of the box',
  samePoint(boxRect[0], { x: 0, y: 0 }) &&
    samePoint(boxRect[1], { x: 100, y: 0 }) &&
    samePoint(boxRect[2], { x: 100, y: 50 }) &&
    samePoint(boxRect[3], { x: 0, y: 50 }),
);

const boxEllipse = shapeVertices('ellipse', 'boxed', { box: BOX });
check('a boxed ellipse has 24 vertices', boxEllipse.length === 24);
check(
  'every vertex of a boxed ellipse lies inside the box',
  boxEllipse.every(
    (p) => p.x >= -1e-9 && p.x <= 100 + 1e-9 && p.y >= -1e-9 && p.y <= 50 + 1e-9,
  ),
);
const ellW = Math.max(...boxEllipse.map((p) => p.x)) - Math.min(...boxEllipse.map((p) => p.x));
const ellH = Math.max(...boxEllipse.map((p) => p.y)) - Math.min(...boxEllipse.map((p) => p.y));
check('a boxed ellipse fills its box', near(ellW, 100) && near(ellH, 50));

const boxTriangle = shapeVertices('triangle', 'boxed', { box: BOX });
check('a boxed triangle has 3 vertices', boxTriangle.length === 3);
check(
  'a boxed triangle uses three corners of the box',
  boxTriangle.every((p) =>
    (near(p.x, 0) || near(p.x, 100)) && (near(p.y, 0) || near(p.y, 50))),
);

const boxArrow = shapeVertices('arrow', 'boxed', { box: BOX });
check('a boxed arrow has 5 vertices', boxArrow.length === 5);
check('a boxed arrow starts at the box corner', samePoint(boxArrow[0], { x: 0, y: 0 }));
check('a boxed arrow ends at the far corner', samePoint(boxArrow[1], { x: 100, y: 50 }));

const boxCustom = shapeVertices('custom', 'boxed', { box: BOX });
check('a boxed custom shape starts as the box corners', boxCustom.length === 4);
check(
  'a boxed custom shape uses the corners of the box',
  samePoint(boxCustom[0], { x: 0, y: 0 }) && samePoint(boxCustom[3], { x: 0, y: 50 }),
);

// A box dragged the other way round still gives the same rectangle.
const flipped = shapeVertices('rect', 'boxed', { box: { x0: 100, y0: 50, x1: 0, y1: 0 } });
check(
  'a reversed box gives the same rect',
  samePoint(flipped[0], { x: 0, y: 0 }) && samePoint(flipped[2], { x: 100, y: 50 }),
);

// --- freeform mode ----------------------------------------------------------
const freeRectPath = [
  { x: 10, y: 10 },
  { x: 90, y: 12 },
  { x: 88, y: 70 },
  { x: 8, y: 68 },
];
const freeRect = shapeVertices('rect', 'freeform', { path: freeRectPath });
check('a freeform rect has 4 vertices', freeRect.length === 4);
check(
  'a freeform rect keeps the points of the path, in order',
  freeRect.every((p, i) => samePoint(p, freeRectPath[i])),
);

const freeLine = shapeVertices('line', 'freeform', {
  path: [{ x: 0, y: 0 }, { x: 30, y: 30 }, { x: 60, y: 60 }],
});
check('a freeform line has 2 vertices', freeLine.length === 2);
check(
  'a freeform line runs from the start to the end of the path',
  samePoint(freeLine[0], { x: 0, y: 0 }) && samePoint(freeLine[1], { x: 60, y: 60 }),
);

const freeTriangle = shapeVertices('triangle', 'freeform', {
  path: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 40 }],
});
check('a freeform triangle has 3 vertices', freeTriangle.length === 3);
check(
  'a freeform triangle keeps the points of the path',
  freeTriangle.every((p, i) => samePoint(p, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 40 }][i])),
);

const freeArrow = shapeVertices('arrow', 'freeform', {
  path: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
});
check('a freeform arrow has 5 vertices', freeArrow.length === 5);
check(
  'a freeform arrow runs along the path',
  samePoint(freeArrow[0], { x: 0, y: 0 }) && samePoint(freeArrow[1], { x: 100, y: 0 }),
);

const circle = [];
for (let i = 0; i < 40; i += 1) {
  const a = (i / 40) * Math.PI * 2;
  circle.push({ x: 50 + 40 * Math.cos(a), y: 50 + 40 * Math.sin(a) });
}
const freeEllipse = shapeVertices('ellipse', 'freeform', { path: circle });
check('a freeform ellipse has 24 vertices', freeEllipse.length === 24);
check(
  'a freeform ellipse stays inside the drawn outline',
  freeEllipse.every((p) => Math.hypot(p.x - 50, p.y - 50) <= 40 + 1e-6),
);

const longPath = [];
for (let i = 0; i < 30; i += 1) longPath.push({ x: i * 10, y: (i % 3) * 4 });
const freeCustom = shapeVertices('custom', 'freeform', { path: longPath });
check(
  `a freeform custom shape has at most ${MAX_CUSTOM_VERTICES} vertices`,
  freeCustom.length <= MAX_CUSTOM_VERTICES && freeCustom.length >= 3,
);
check(
  'a freeform custom shape keeps the ends of the path',
  samePoint(freeCustom[0], longPath[0]) && samePoint(freeCustom[freeCustom.length - 1], longPath[longPath.length - 1]),
);

// --- simplifyPath -----------------------------------------------------------
const many = [];
for (let i = 0; i < 20; i += 1) many.push({ x: i * 5, y: 0 });
const simple = simplifyPath(many, 5);
check('simplifyPath reduces a long path to at most N points', simple.length === 5);
check('simplifyPath keeps the first point', samePoint(simple[0], many[0]));
check('simplifyPath keeps the last point', samePoint(simple[4], many[19]));
const short = simplifyPath([{ x: 1, y: 1 }, { x: 2, y: 2 }], 6);
check('simplifyPath leaves a short path alone', short.length === 2);
const closed = simplifyPath(
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }],
  4,
);
check('simplifyPath drops the duplicated closing point', closed.length === 4);

// --- outlines ---------------------------------------------------------------
const rectStroke = createShapeStroke({ kind: 'rect', mode: 'boxed', box: BOX, color: '#123456', width: 2 });
const rectOutline = shapeOutline(rectStroke);
check(
  'a rect outline is a closed loop',
  rectOutline.length === 5 &&
    rectOutline[0][0] === rectOutline[4][0] &&
    rectOutline[0][1] === rectOutline[4][1],
);
const ellipseOutline = shapeOutline(createShapeStroke({ kind: 'ellipse', mode: 'boxed', box: BOX }));
check(
  'an ellipse outline is a closed loop',
  ellipseOutline.length === 25 &&
    ellipseOutline[0][0] === ellipseOutline[ellipseOutline.length - 1][0] &&
    ellipseOutline[0][1] === ellipseOutline[ellipseOutline.length - 1][1],
);
const triangleOutline = shapeOutline(createShapeStroke({ kind: 'triangle', mode: 'boxed', box: BOX }));
check(
  'a triangle outline is a closed loop',
  triangleOutline.length === 4 &&
    triangleOutline[0][0] === triangleOutline[3][0] &&
    triangleOutline[0][1] === triangleOutline[3][1],
);
const customOutline = shapeOutline(
  createShapeStroke({ kind: 'custom', mode: 'boxed', box: BOX }),
);
check(
  'a custom shape outline is a closed loop',
  customOutline.length === 5 &&
    customOutline[0][0] === customOutline[4][0] &&
    customOutline[0][1] === customOutline[4][1],
);
const lineOutline = shapeOutline(createShapeStroke({ kind: 'line', mode: 'boxed', box: BOX }));
check('a line outline stays open', lineOutline.length === 2);
const arrowOutline = shapeOutline(createShapeStroke({ kind: 'arrow', mode: 'boxed', box: BOX }));
check('an arrow outline stays open', arrowOutline.length === 5);
check('shapeOutline returns null for plain ink', shapeOutline({ points: [{ x: 0, y: 0 }] }) === null);

// --- hit-testing ------------------------------------------------------------
check('a point inside a rect hits', shapeHitTest(rectStroke, 50, 25));
check('a point outside a rect misses', !shapeHitTest(rectStroke, 150, 150));
check('a point on the rect edge hits', shapeHitTest(rectStroke, 100, 25));
const lineStroke = createShapeStroke({ kind: 'line', mode: 'boxed', box: BOX });
check('a point near a line segment hits', shapeHitTest(lineStroke, 50, 28));
check('a point far from a line segment misses', !shapeHitTest(lineStroke, 50, 60));
const triStroke = createShapeStroke({ kind: 'triangle', mode: 'boxed', box: BOX });
check('a point inside a triangle hits', shapeHitTest(triStroke, 90, 40));
check('a point outside a triangle misses', !shapeHitTest(triStroke, 5, 45));
const ellStroke = createShapeStroke({ kind: 'ellipse', mode: 'boxed', box: BOX });
check('a point inside an ellipse hits', shapeHitTest(ellStroke, 50, 25));
check('a point outside an ellipse misses', !shapeHitTest(ellStroke, 150, 25));

// --- rendering ---------------------------------------------------------------
const ctx = makeCtx();
renderShape(ctx, rectStroke);
check('renderShape strokes exactly once', ctx.calls.stroke === 1);
check('renderShape does not fill by default', ctx.calls.fill === 0);
check('renderShape sets the stroke colour', ctx.strokeStyle === '#123456');
check('renderShape sets the stroke width', ctx.lineWidth === 2);
check('renderShape uses round joins and caps', ctx.lineJoin === 'round' && ctx.lineCap === 'round');
check('renderShape traces the outline once', ctx.calls.moveTo === 1 && ctx.calls.lineTo === 4);

const filledCtx = makeCtx();
renderShape(filledCtx, { ...rectStroke, fill: true });
check('renderShape fills when fill is set', filledCtx.calls.fill === 1);
check('renderShape still strokes once when it fills', filledCtx.calls.stroke === 1);

const dashedCtx = makeCtx();
renderShape(dashedCtx, { ...rectStroke, lineStyle: 'dashed' });
check('renderShape dashes a dashed shape', dashedCtx.calls.setLineDash > 0 && dashedCtx.dash.length > 0);

const inkCtx = makeCtx();
renderShape(inkCtx, { points: [{ x: 0, y: 0 }], color: '#000', width: 3 });
check('renderShape ignores plain ink', inkCtx.calls.stroke === 0);

// --- shape strokes ----------------------------------------------------------
check('createShapeStroke marks the shape', isShapeStroke(rectStroke));
check('createShapeStroke sets kind', rectStroke.kind === 'shape');
check('createShapeStroke sets shape', rectStroke.shape === 'rect');
check('createShapeStroke records the draw mode', rectStroke.mode === 'boxed');
check('createShapeStroke defaults to no fill', rectStroke.fill === false);
check('createShapeStroke builds the points', rectStroke.points.length === 5);
check(
  'a closed shape polyline includes the closing edge',
  rectStroke.points[4].x === rectStroke.points[0].x && rectStroke.points[4].y === rectStroke.points[0].y,
);
check(
  'createShapeStroke keeps the ink fields',
  rectStroke.color === '#123456' && rectStroke.width === 2 && rectStroke.pressureTaper === false,
);
const filledStroke = createShapeStroke({ kind: 'rect', mode: 'boxed', box: BOX, fill: true });
check('createShapeStroke can set fill', filledStroke.fill === true);
const freeStroke = createShapeStroke({ kind: 'rect', mode: 'freeform', path: freeRectPath });
check('createShapeStroke can build a freeform shape', freeStroke.mode === 'freeform' && freeStroke.points.length === 5);
check('isClosedShape knows the closed kinds', isClosedShape('rect') && isClosedShape('custom') && !isClosedShape('line'));

// --- editable vertices ------------------------------------------------------
const editable = createShapeStroke({ kind: 'rect', mode: 'boxed', box: BOX });
const verts = vertexPositions(editable);
check('a closed shape has one vertex per corner', verts.length === 4);
check(
  'the editable vertices are the corners of the box',
  samePoint(verts[0], { x: 0, y: 0 }) && samePoint(verts[2], { x: 100, y: 50 }),
);
const before = vertexPositions(editable);
setVertex(editable, 1, 40, 20);
const after = vertexPositions(editable);
check('setVertex moves the vertex it is given', samePoint(after[1], { x: 40, y: 20 }));
check('setVertex leaves the other vertices alone', samePoint(after[0], before[0]) && samePoint(after[2], before[2]) && samePoint(after[3], before[3]));
check(
  'setVertex keeps the closing point with the first vertex',
  editable.points[4].x === editable.points[0].x && editable.points[4].y === editable.points[0].y,
);
setVertex(editable, 0, 5, 6);
check(
  'setVertex moves the closing point with the first vertex',
  editable.points[4].x === 5 && editable.points[4].y === 6,
);
check('setVertex refuses an index that is out of range', setVertex(editable, 99, 0, 0) === false);

// --- the square preset ------------------------------------------------------
const square = createShapeStroke({ kind: 'rect', mode: 'boxed', box: { x0: 0, y0: 0, x1: 100, y1: 50 } });
check('toSquare changes a rectangle', toSquare(square) === true);
const sqVerts = vertexPositions(square);
const sqW = Math.max(...sqVerts.map((p) => p.x)) - Math.min(...sqVerts.map((p) => p.x));
const sqH = Math.max(...sqVerts.map((p) => p.y)) - Math.min(...sqVerts.map((p) => p.y));
check('a 100x50 rect becomes a 100x100 square', near(sqW, 100) && near(sqH, 100));
check(
  'the square keeps the centre of the rectangle',
  near((Math.min(...sqVerts.map((p) => p.x)) + Math.max(...sqVerts.map((p) => p.x))) / 2, 50) &&
    near((Math.min(...sqVerts.map((p) => p.y)) + Math.max(...sqVerts.map((p) => p.y))) / 2, 25),
);
const alreadySquare = createShapeStroke({ kind: 'rect', mode: 'boxed', box: { x0: 0, y0: 0, x1: 80, y1: 80 } });
check('toSquare reports that an unchanged shape did not change', toSquare(alreadySquare) === false);

const tri = createShapeStroke({ kind: 'triangle', mode: 'boxed', box: { x0: 0, y0: 0, x1: 90, y1: 60 } });
const triBefore = vertexPositions(tri);
const triCx = triBefore.reduce((s, p) => s + p.x, 0) / 3;
const triCy = triBefore.reduce((s, p) => s + p.y, 0) / 3;
check('toSquare changes a triangle', toSquare(tri) === true);
const triAfter = vertexPositions(tri);
check('the regular triangle has the same vertex count', triAfter.length === 3);
const triR = triAfter.map((p) => Math.hypot(p.x - triCx, p.y - triCy));
check('the regular triangle keeps the centroid', near(triCx, triAfter.reduce((s, p) => s + p.x, 0) / 3) && near(triCy, triAfter.reduce((s, p) => s + p.y, 0) / 3));
check('the regular triangle has three equal radii', near(triR[0], triR[1]) && near(triR[1], triR[2]));
const triAngles = triAfter.map((p) => Math.atan2(p.y - triCy, p.x - triCx)).sort((a, b) => a - b);
check('the regular triangle is spread evenly', near((triAngles[1] - triAngles[0]) * 180 / Math.PI, 120, 1e-6));

// --- vertex snapping --------------------------------------------------------
const neighbour = createShapeStroke({ kind: 'rect', mode: 'boxed', box: { x0: 100, y0: 100, x1: 200, y1: 200 } });
const dragged = createShapeStroke({ kind: 'rect', mode: 'boxed', box: { x0: 0, y0: 0, x1: 50, y1: 50 } });

const snappedVertex = snapVertex(dragged, 0, 103, 101, { others: [neighbour] });
check('a nearby vertex is snapped onto exactly', snappedVertex.snapped === true);
check('the snapped vertex is the neighbour corner', samePoint(snappedVertex, { x: 100, y: 100 }));
check('the snap target says it is a vertex', snappedVertex.target?.kind === 'vertex');
check('the snap target names the other shape', snappedVertex.target?.id === neighbour.id);

const snappedEdge = snapVertex(dragged, 0, 150, 104, { others: [neighbour] });
check('a nearby edge is snapped onto', snappedEdge.snapped === true);
check('the snapped edge point is the closest point on the edge', samePoint(snappedEdge, { x: 150, y: 100 }));
check('the snap target says it is an edge', snappedEdge.target?.kind === 'edge');

const notSnapped = snapVertex(dragged, 0, 400, 400, { others: [neighbour] });
check('a point far from everything is left alone', notSnapped.snapped === false);
check('the unsnapped point keeps its coordinates', notSnapped.x === 400 && notSnapped.y === 400);
check('the unsnapped point has no target', notSnapped.target === null);

const selfSnap = snapVertex(dragged, 0, 1, 1, { others: [dragged] });
check('a shape is never snapped to itself', selfSnap.snapped === false);
const toleranced = snapVertex(dragged, 0, 150, 104, { others: [neighbour], tolerance: 1 });
check('the tolerance can be tightened', toleranced.snapped === false);

// --- the vertex editor imports in Node --------------------------------------
const editor = await import(pathToFileURL(`${SRC}/ui/shape-editor.js`).href);
check('the shape editor exports buildShapeEditor', typeof editor.buildShapeEditor === 'function');
check('the shape editor does not touch the document at import time', typeof document === 'undefined');

console.log(`ALL ${checks} CHECKS PASSED`);
