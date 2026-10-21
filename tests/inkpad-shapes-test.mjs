// Node test for src/shapes.js.
//
//   node inkpad-shapes-test.mjs
//
// The repo is a static site with no test runner, so this is a plain script:
// it prints "ALL N CHECKS PASSED" and exits non-zero on the first failure.
// The canvas is faked — no real 2D context needed.

import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = process.env.INKPAD_REPO || fileURLToPath(new URL('..', import.meta.url));

const {
  SHAPE_KINDS,
  SHAPE_LABELS,
  shapePoints,
  snapAngle,
  snapSquare,
  snapToGrid,
  shapeOutline,
  shapeHitTest,
  renderShape,
  createShapeStroke,
  isShapeStroke,
} = await import(pathToFileURL(`${REPO}/src/shapes.js`).href);

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

// --- the module imports cleanly in Node -------------------------------------
check(
  'shapes.js exports the expected API',
  SHAPE_KINDS.length === 5 &&
    typeof shapePoints === 'function' &&
    typeof snapAngle === 'function' &&
    typeof snapSquare === 'function' &&
    typeof snapToGrid === 'function' &&
    typeof shapeOutline === 'function' &&
    typeof shapeHitTest === 'function' &&
    typeof renderShape === 'function' &&
    typeof createShapeStroke === 'function',
);
check('every shape kind has a label', SHAPE_KINDS.every((k) => typeof SHAPE_LABELS[k] === 'string'));

// --- line --------------------------------------------------------------------
const line = shapePoints('line', 10, 10, 100, 10, { snap: false });
check('a line has 2 points', line.length === 2);
check('a line starts at the drag origin', near(line[0].x, 10) && near(line[0].y, 10));
check('a line ends at the drag end', near(line[1].x, 100) && near(line[1].y, 10));
check(
  'shape points carry pressure 0.5 and a timestamp',
  line.every((p) => p.pressure === 0.5 && typeof p.t === 'number' && Number.isFinite(p.t)),
);

// --- rect --------------------------------------------------------------------
const rect = shapePoints('rect', 200, 200, 100, 100, { snap: false });
check('a rect has 4 points', rect.length === 4);
const rectXs = rect.map((p) => p.x);
const rectYs = rect.map((p) => p.y);
check('a rect dragged up-left still has min < max', Math.min(...rectXs) < Math.max(...rectXs));
check('a rect dragged up-left still has min < max in y', Math.min(...rectYs) < Math.max(...rectYs));
check(
  'a rect starts at the top-left corner',
  near(rect[0].x, 100) && near(rect[0].y, 100),
);
check(
  'a rect runs clockwise from the top-left',
  near(rect[1].x, 200) && near(rect[1].y, 100) &&
    near(rect[2].x, 200) && near(rect[2].y, 200) &&
    near(rect[3].x, 100) && near(rect[3].y, 200),
);

// --- square snapping ---------------------------------------------------------
const sq = shapePoints('rect', 0, 0, 100, 50);
const sqW = Math.max(...sq.map((p) => p.x)) - Math.min(...sq.map((p) => p.x));
const sqH = Math.max(...sq.map((p) => p.y)) - Math.min(...sq.map((p) => p.y));
check('a 100x50 rect drag snaps to 100x100', near(sqW, 100) && near(sqH, 100));
const sqDirect = snapSquare(0, 0, 100, 50);
check('snapSquare locks 100x50 to 100x100', near(sqDirect.x1, 100) && near(sqDirect.y1, 100));
const sqTall = snapSquare(0, 0, 50, 100);
check('snapSquare locks 50x100 to 100x100', near(sqTall.x1, 100) && near(sqTall.y1, 100));

// --- ellipse -----------------------------------------------------------------
const ell = shapePoints('ellipse', 10, 20, 110, 60, { snap: false });
check('an ellipse has 48 points', ell.length === 48);
check(
  'every ellipse point lies inside the bounding box',
  ell.every(
    (p) =>
      p.x >= 10 - 1e-9 && p.x <= 110 + 1e-9 &&
      p.y >= 20 - 1e-9 && p.y <= 60 + 1e-9,
  ),
);
const ellW = Math.max(...ell.map((p) => p.x)) - Math.min(...ell.map((p) => p.x));
const ellH = Math.max(...ell.map((p) => p.y)) - Math.min(...ell.map((p) => p.y));
check('the ellipse fills its bounding box', near(ellW, 100, 1e-6) && near(ellH, 40, 1e-6));

// --- triangle ----------------------------------------------------------------
const tri = shapePoints('triangle', 0, 0, 100, 50, { snap: false });
check('a triangle has 3 points', tri.length === 3);
check("a triangle's first point is the top-centre", near(tri[0].x, 50) && near(tri[0].y, 0));
check(
  'a triangle closes on the bounding box corners',
  near(tri[1].x, 0) && near(tri[1].y, 50) && near(tri[2].x, 100) && near(tri[2].y, 50),
);

// --- arrow -------------------------------------------------------------------
const arr = shapePoints('arrow', 0, 0, 100, 0, { snap: false });
check('an arrow has 5 points', arr.length === 5);
check('an arrow starts at the origin', near(arr[0].x, 0) && near(arr[0].y, 0));
check('the arrow tip is the drag end', near(arr[1].x, 100) && near(arr[1].y, 0));
const barbLen = Math.hypot(arr[2].x - 100, arr[2].y - 0);
check('an arrow barb is 10% of the shaft', near(barbLen, 10, 1e-6));
check('an arrow barb points back along the shaft', arr[2].x < 100);
check('the two arrow barbs are mirrored', near(arr[2].x, arr[4].x) && near(arr[2].y, -arr[4].y));

// --- angle snapping ----------------------------------------------------------
const dragLen = Math.hypot(100, 100 * Math.tan((30 * Math.PI) / 180));
const snapped = snapAngle(0, 0, 100, 100 * Math.tan((30 * Math.PI) / 180));
const snapDeg = (Math.atan2(snapped.y1 - 0, snapped.x1 - 0) * 180) / Math.PI;
check('a 30-degree drag snaps to a multiple of 45', near(((snapDeg % 45) + 45) % 45, 0, 1e-6));
check('a 30-degree drag snaps to 45 degrees', near(snapDeg, 45, 1e-6));
check('angle snapping keeps the drag length', near(Math.hypot(snapped.x1, snapped.y1), dragLen, 1e-6));
const snappedLine = shapePoints('line', 0, 0, 100, 100 * Math.tan((30 * Math.PI) / 180));
const lineDeg = (Math.atan2(snappedLine[1].y, snappedLine[1].x) * 180) / Math.PI;
check('a snapped line points at 45 degrees', near(lineDeg, 45, 1e-6));
const unsnappedLine = shapePoints('line', 0, 0, 100, 100 * Math.tan((30 * Math.PI) / 180), { snap: false });
check(
  'snapping can be switched off',
  near(unsnappedLine[1].y, 100 * Math.tan((30 * Math.PI) / 180), 1e-6),
);

// --- grid snapping -----------------------------------------------------------
const grid = snapToGrid(37, 44, 20);
check('snapToGrid rounds to the nearest grid point', grid.x === 40 && grid.y === 40);

// --- shape strokes -----------------------------------------------------------
const rectStroke = createShapeStroke({
  kind: 'rect', x0: 0, y0: 0, x1: 100, y1: 100, color: '#123456', width: 2,
});
check('createShapeStroke marks the shape', isShapeStroke(rectStroke));
check('createShapeStroke sets kind', rectStroke.kind === 'shape');
check('createShapeStroke sets shape', rectStroke.shape === 'rect');
check('createShapeStroke defaults to freeform', rectStroke.fill === false);
check('createShapeStroke builds the points', rectStroke.points.length === 5);
check('a closed shape polyline includes the closing edge', rectStroke.points[4].x === rectStroke.points[0].x && rectStroke.points[4].y === rectStroke.points[0].y);
check(
  'createShapeStroke keeps the ink fields',
  rectStroke.color === '#123456' && rectStroke.width === 2 && rectStroke.pressureTaper === false,
);
const boxedStroke = createShapeStroke({
  kind: 'rect', x0: 0, y0: 0, x1: 10, y1: 10, fill: true,
});
check('createShapeStroke can set fill', boxedStroke.fill === true);

// --- outlines ----------------------------------------------------------------
const rectOutline = shapeOutline(rectStroke);
check(
  'a rect outline is a closed loop',
  rectOutline.length === 5 &&
    rectOutline[0][0] === rectOutline[4][0] &&
    rectOutline[0][1] === rectOutline[4][1],
);
const ellOutline = shapeOutline(createShapeStroke({ kind: 'ellipse', x0: 0, y0: 0, x1: 100, y1: 100 }));
check(
  'an ellipse outline is a closed loop',
  ellOutline.length === 49 &&
    ellOutline[0][0] === ellOutline[ellOutline.length - 1][0] &&
    ellOutline[0][1] === ellOutline[ellOutline.length - 1][1],
);
const triOutline = shapeOutline(createShapeStroke({ kind: 'triangle', x0: 0, y0: 0, x1: 100, y1: 100 }));
check(
  'a triangle outline is a closed loop',
  triOutline.length === 4 &&
    triOutline[0][0] === triOutline[3][0] &&
    triOutline[0][1] === triOutline[3][1],
);
const lineOutline = shapeOutline(createShapeStroke({ kind: 'line', x0: 0, y0: 0, x1: 100, y1: 0 }));
check('a line outline stays open', lineOutline.length === 2);
const arrowOutline = shapeOutline(createShapeStroke({ kind: 'arrow', x0: 0, y0: 0, x1: 100, y1: 0 }));
check('an arrow outline stays open', arrowOutline.length === 5);
check('shapeOutline returns null for plain ink', shapeOutline({ points: [{ x: 0, y: 0 }] }) === null);

// --- hit-testing -------------------------------------------------------------
check('a point inside a rect hits', shapeHitTest(rectStroke, 50, 50));
check('a point outside a rect misses', !shapeHitTest(rectStroke, 150, 150));
check('a point on the rect edge hits', shapeHitTest(rectStroke, 100, 50));
const lineStroke = createShapeStroke({ kind: 'line', x0: 0, y0: 0, x1: 100, y1: 0 });
check('a point near a line segment hits', shapeHitTest(lineStroke, 50, 3));
check('a point far from a line segment misses', !shapeHitTest(lineStroke, 50, 40));
const triStroke = createShapeStroke({ kind: 'triangle', x0: 0, y0: 0, x1: 100, y1: 100 });
check('a point inside a triangle hits', shapeHitTest(triStroke, 50, 80));
check('a point outside a triangle misses', !shapeHitTest(triStroke, 5, 5));
const ellStroke = createShapeStroke({ kind: 'ellipse', x0: 0, y0: 0, x1: 100, y1: 100 });
check('a point inside an ellipse hits', shapeHitTest(ellStroke, 50, 50));
check('a point outside an ellipse misses', !shapeHitTest(ellStroke, 150, 50));

// --- rendering ---------------------------------------------------------------
const ctx = makeCtx();
renderShape(ctx, rectStroke);
check('renderShape strokes exactly once', ctx.calls.stroke === 1);
check('renderShape does not fill by default', ctx.calls.fill === 0);
check('renderShape sets the stroke colour', ctx.strokeStyle === '#123456');
check('renderShape sets the stroke width', ctx.lineWidth === 2);
check('renderShape uses round joins and caps', ctx.lineJoin === 'round' && ctx.lineCap === 'round');
check('renderShape traces the outline', ctx.calls.moveTo === 1 && ctx.calls.lineTo === 4);

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

console.log(`ALL ${checks} CHECKS PASSED`);
