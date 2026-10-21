// inkpad-transform-test.mjs — Node test for src/transform.js.
//
// Run:  node inkpad-transform-test.mjs [path-to-repo]
// The transform module is pure maths (no DOM), so it imports straight into
// Node — that is the whole reason it lives outside the UI layer.

import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? process.env.INKPAD_ROOT ?? 'C:\\AI Projects\\chatability';
const mod = await import(pathToFileURL(`${root}\\src\\transform.js`).href);
const {
  boundsOf,
  translateStrokes,
  scaleStrokes,
  rotateStrokes,
  handlePositions,
  hitHandle,
  pointInPolygon,
  strokesInPolygon,
} = mod;

let checks = 0;

function check(cond, msg) {
  checks += 1;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function makeStroke(points, extra = {}) {
  return {
    id: 's1',
    tool: 'pen',
    color: '#ff0000',
    width: 4,
    opacity: 1,
    pointerType: 'mouse',
    lineStyle: 'solid',
    pressureTaper: true,
    ...extra,
    points: points.map(([x, y]) => ({ x, y, pressure: 0.5, t: 0 })),
  };
}

// --- boundsOf ---------------------------------------------------------------

check(boundsOf([]) === null, 'boundsOf([]) should be null');
check(boundsOf([makeStroke([])]) === null, 'boundsOf of a point-less stroke should be null');

const dot = makeStroke([[5, 7]], { id: 'dot' });
const single = boundsOf([dot]);
check(single !== null, 'boundsOf of a single-point stroke should not be null');
check(near(single.minX, 5) && near(single.minY, 7), 'single-point bounds min');
check(near(single.maxX, 5) && near(single.maxY, 7), 'single-point bounds max');

const a = makeStroke([[0, 0], [10, 2]], { id: 'a' });
const b = makeStroke([[-5, 8], [3, 4]], { id: 'b' });
const box = boundsOf([a, b]);
check(near(box.minX, -5), 'bounds minX');
check(near(box.minY, 0), 'bounds minY');
check(near(box.maxX, 10), 'bounds maxX');
check(near(box.maxY, 8), 'bounds maxY');
check(boundsOf([dot, a, b]).minX === -5, 'bounds ignore the dot only when it is the only stroke');

// --- translateStrokes -------------------------------------------------------

const t = makeStroke([[1, 2], [3, 4]], { id: 't', color: '#00ff00', width: 7 });
const returned = translateStrokes([t], 10, -5);
check(returned[0] === t, 'translateStrokes returns the same array/strokes');
check(near(t.points[0].x, 11) && near(t.points[0].y, -3), 'translate moves point 0');
check(near(t.points[1].x, 13) && near(t.points[1].y, -1), 'translate moves point 1');
check(t.color === '#00ff00', 'translate leaves color alone');
check(t.width === 7, 'translate leaves width alone');
check(t.points[0].pressure === 0.5, 'translate leaves pressure alone');

// --- scaleStrokes -----------------------------------------------------------

const s = makeStroke([[2, 2], [4, 6]], { id: 's', width: 4 });
scaleStrokes([s], 0, 0, 2, 2);
check(near(s.points[0].x, 4) && near(s.points[0].y, 4), 'scale 2x about the origin');
check(near(s.points[1].x, 8) && near(s.points[1].y, 12), 'scale 2x about the origin (far point)');
check(near(s.width, 8), 'scale 2x doubles the width');

// The width follows the geometric mean of |sx| and |sy|.
const s2 = makeStroke([[0, 0]], { id: 's2', width: 4 });
scaleStrokes([s2], 0, 0, 4, 1);
check(near(s2.width, 8), 'scale 4x/1x scales the width by the mean factor (2)');
check(near(s2.points[0].x, 0) && near(s2.points[0].y, 0), 'scale about the origin keeps the origin');

// Scaling about a point that is not the origin.
const s3 = makeStroke([[5, 5]], { id: 's3', width: 2 });
scaleStrokes([s3], 10, 10, 2, 2);
check(near(s3.points[0].x, 0) && near(s3.points[0].y, 0), 'scale about (10,10)');

// A tiny scale must not take the width below the floor.
const s4 = makeStroke([[0, 0]], { id: 's4', width: 4 });
scaleStrokes([s4], 0, 0, 0.01, 0.01);
check(s4.width === 0.5, `scaled-down width clamps to 0.5 (got ${s4.width})`);

// --- rotateStrokes ----------------------------------------------------------

const r = makeStroke([[1, 0]], { id: 'r', width: 4 });
rotateStrokes([r], 0, 0, Math.PI / 2);
check(near(r.points[0].x, 0) && near(r.points[0].y, 1), 'rotate 90 degrees about the origin');
check(r.width === 4, 'rotate leaves the width alone');

const r2 = makeStroke([[10, 0]], { id: 'r2' });
rotateStrokes([r2], 10, 10, Math.PI / 2);
check(near(r2.points[0].x, 20) && near(r2.points[0].y, 10), 'rotate 90 degrees about (10,10)');
check(
  near(Math.hypot(r2.points[0].x - 10, r2.points[0].y - 10), 10),
  'rotate keeps the distance to the centre',
);

const r3 = makeStroke([[1, 0]], { id: 'r3' });
rotateStrokes([r3], 0, 0, Math.PI);
check(near(r3.points[0].x, -1) && near(r3.points[0].y, 0), 'rotate 180 degrees');

// --- handlePositions --------------------------------------------------------

const hp = handlePositions({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
check(Object.keys(hp).length === 8, 'handlePositions returns 8 handles');
check(near(hp.tl.x, 0) && near(hp.tl.y, 0), 'tl');
check(near(hp.t.x, 50) && near(hp.t.y, 0), 't');
check(near(hp.tr.x, 100) && near(hp.tr.y, 0), 'tr');
check(near(hp.r.x, 100) && near(hp.r.y, 25), 'r');
check(near(hp.br.x, 100) && near(hp.br.y, 50), 'br');
check(near(hp.b.x, 50) && near(hp.b.y, 50), 'b');
check(near(hp.bl.x, 0) && near(hp.bl.y, 50), 'bl');
check(near(hp.l.x, 0) && near(hp.l.y, 25), 'l');

// --- hitHandle --------------------------------------------------------------

const hb = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
check(hitHandle(hb, 2, 2, 8) === 'tl', 'hitHandle finds tl');
check(hitHandle(hb, 48, 1, 8) === 't', 'hitHandle finds t');
check(hitHandle(hb, 98, 2, 8) === 'tr', 'hitHandle finds tr');
check(hitHandle(hb, 99, 25, 8) === 'r', 'hitHandle finds r');
check(hitHandle(hb, 98, 48, 8) === 'br', 'hitHandle finds br');
check(hitHandle(hb, 50, 49, 8) === 'b', 'hitHandle finds b');
check(hitHandle(hb, 2, 48, 8) === 'bl', 'hitHandle finds bl');
check(hitHandle(hb, 1, 25, 8) === 'l', 'hitHandle finds l');
check(hitHandle(hb, 500, 500, 8) === null, 'hitHandle returns null far away');
check(hitHandle(hb, 20, 20, 8) === null, 'hitHandle respects the tolerance');
check(hitHandle(hb, 0, 0, 0) === 'tl', 'hitHandle with a zero tolerance still finds the exact corner');

// --- pointInPolygon ---------------------------------------------------------

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
check(pointInPolygon(5, 5, square) === true, 'pointInPolygon: inside');
check(pointInPolygon(0.001, 0.001, square) === true, 'pointInPolygon: near a corner, inside');
check(pointInPolygon(-1, 5, square) === false, 'pointInPolygon: left of the square');
check(pointInPolygon(5, 11, square) === false, 'pointInPolygon: below the square');
check(pointInPolygon(50, 5, square) === false, 'pointInPolygon: right of the square');
check(pointInPolygon(5, 5, []) === false, 'pointInPolygon: a degenerate polygon contains nothing');

// --- strokesInPolygon -------------------------------------------------------

const inside = makeStroke([[2, 2], [8, 8]], { id: 'inside' });
const outside = makeStroke([[50, 50], [60, 60]], { id: 'outside' });
const caught = strokesInPolygon([inside, outside], square);
check(caught.length === 1, `strokesInPolygon catches one stroke (got ${caught.length})`);
check(caught[0] === inside, 'strokesInPolygon catches the stroke inside the polygon');
check(!caught.includes(outside), 'strokesInPolygon leaves the outside stroke alone');

// A stroke the lasso slices in half (no point of it inside the polygon, but
// the polygon crosses its bounding box) is still caught.
const sliced = makeStroke([[-5, 5], [15, 5]], { id: 'sliced' });
const caught2 = strokesInPolygon([sliced], square);
check(caught2.includes(sliced), 'strokesInPolygon catches a sliced stroke');
check(strokesInPolygon([inside], []).length === 0, 'strokesInPolygon with a degenerate polygon');

// --- done -------------------------------------------------------------------

console.log(`ALL ${checks} CHECKS PASSED`);
