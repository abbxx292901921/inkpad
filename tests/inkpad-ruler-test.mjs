// inkpad-ruler-test.mjs — Node checks for the pure parts of the ruler and
// the rotation dial. No DOM: both modules are import-safe on their own.
//
//   node inkpad-ruler-test.mjs
//
// Exits non-zero on the FIRST failing check.

import { pathToFileURL } from 'node:url';
import process from 'node:process';

const REPO = 'C:\\AI Projects\\chatability';

const ruler = await import(pathToFileURL(`${REPO}\\src\\ui\\ruler.js`).href);
const dial = await import(pathToFileURL(`${REPO}\\src\\ui\\rotation-dial.js`).href);

const { tickPositions, formatTickLabel } = ruler;
const { angleFromPoint, snapAngle } = dial;

let checks = 0;

function check(label, ok, extra = '') {
  checks += 1;
  if (!ok) {
    console.error(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
    process.exit(1);
  }
  console.log(`ok   ${label}`);
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// --- the ruler -------------------------------------------------------------

const vp = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const hTicks = tickPositions(vp, 'h', 500);

check('tickPositions returns ticks', Array.isArray(hTicks) && hTicks.length > 0);

const at0 = hTicks.find((t) => t.pageValue === 0);
check('page 0 exists at zoom 1 / pan 0', Boolean(at0));
check('page 0 is at screen 0', near(at0.screenPos, 0), `got ${at0.screenPos}`);

const at100 = hTicks.find((t) => t.pageValue === 100);
check('page 100 exists', Boolean(at100));
check('page 100 is at screen 100', near(at100.screenPos, 100), `got ${at100.screenPos}`);

const at10 = hTicks.find((t) => t.pageValue === 10);
check('page 10 is at screen 10', near(at10.screenPos, 10), `got ${at10.screenPos}`);

// Every 10th unit is a tick, every 100th is a major (labelled) one.
const everyTen = hTicks.filter((t) => t.pageValue % 10 === 0);
check('every 10th unit has a tick', everyTen.length === 51, `got ${everyTen.length}`);
check(
  'every 10th unit is a minor tick',
  everyTen.every((t) => t.major === (t.pageValue % 100 === 0)),
);
check(
  'every 100th unit is major',
  hTicks.filter((t) => t.major).every((t) => t.pageValue % 100 === 0)
    && hTicks.filter((t) => t.major).length === 6,
  `got ${hTicks.filter((t) => t.major).length}`,
);
check(
  'non-major ticks are unlabelled and major ones are labelled',
  hTicks.every((t) => {
    if (!t.major) return t.label === null;
    if (t.pageValue === 0) return t.label === null; // the zero is unnumbered
    return typeof t.label === 'string';
  }),
);
check('the origin is unnumbered', at0.label === null);

// Spacing between neighbours is 10 screen px at zoom 1.
const gap = at10.screenPos - at0.screenPos;
check('tick spacing is 10px at zoom 1', near(gap, 10), `got ${gap}`);

// Zooming in 2x halves the screen spacing.
const z2 = tickPositions({ zoom: 2, panX: 0, panY: 0, dpr: 1 }, 'h', 500);
const z2at0 = z2.find((t) => t.pageValue === 0);
const z2at10 = z2.find((t) => t.pageValue === 10);
const z2at100 = z2.find((t) => t.pageValue === 100);
check('zoom 2: page 0 is at screen 0', near(z2at0.screenPos, 0), `got ${z2at0.screenPos}`);
check('zoom 2: page 100 is at screen 200', near(z2at100.screenPos, 200), `got ${z2at100.screenPos}`);
const gap2 = z2at10.screenPos - z2at0.screenPos;
check('zoom 2 doubles the tick spacing', near(gap2, gap * 2), `got ${gap2}`);

// Zooming OUT 2x halves the screen spacing (page 10 lands at screen 5).
const zHalf = tickPositions({ zoom: 0.5, panX: 0, panY: 0, dpr: 1 }, 'h', 500);
const zHalf0 = zHalf.find((t) => t.pageValue === 0);
const zHalf10 = zHalf.find((t) => t.pageValue === 10);
const gapHalf = zHalf10.screenPos - zHalf0.screenPos;
check('zoom 0.5 halves the tick spacing', near(gapHalf, gap / 2), `got ${gapHalf}`);

// Panning shifts the ticks by the pan distance.
const panned = tickPositions({ zoom: 1, panX: 37, panY: 0, dpr: 1 }, 'h', 500);
const panned0 = panned.find((t) => t.pageValue === 0);
check('panX shifts page 0 to the pan offset', near(panned0.screenPos, 37), `got ${panned0.screenPos}`);
const panned100 = panned.find((t) => t.pageValue === 100);
check('panX shifts page 100 too', near(panned100.screenPos, 137), `got ${panned100.screenPos}`);

// The vertical axis uses panY and the y coordinate.
const vTicks = tickPositions({ zoom: 1, panX: 0, panY: 21, dpr: 1 }, 'v', 400);
const v0 = vTicks.find((t) => t.pageValue === 0);
const v100 = vTicks.find((t) => t.pageValue === 100);
check('vertical: page 0 is at screen 21', near(v0.screenPos, 21), `got ${v0.screenPos}`);
check('vertical: page 100 is at screen 121', near(v100.screenPos, 121), `got ${v100.screenPos}`);

// Labels count hundreds of units from the ruler's zero.
check('label of 100 units is "1"', formatTickLabel(100) === '1', `got ${formatTickLabel(100)}`);
check('label of 500 units is "5"', formatTickLabel(500) === '5', `got ${formatTickLabel(500)}`);
check('label of 250 units is "2.5"', formatTickLabel(250) === '2.5', `got ${formatTickLabel(250)}`);
check('label of 0 is null (unnumbered)', formatTickLabel(0) === null);

// The DOM builders must exist and must not have thrown on import.
check('buildRuler is exported', typeof ruler.buildRuler === 'function');
check('buildRotationDial is exported', typeof dial.buildRotationDial === 'function');

// --- the rotation dial -----------------------------------------------------

const cx = 100;
const cy = 100;
check('up is 0 degrees', near(angleFromPoint(cx, cy, cx, cy - 50), 0));
check('right is 90 degrees', near(angleFromPoint(cx, cy, cx + 50, cy), 90));
check('down is 180 degrees', near(angleFromPoint(cx, cy, cx, cy + 50), 180));
check('left is 270 degrees', near(angleFromPoint(cx, cy, cx - 50, cy), 270));
check('the centre has no angle', near(angleFromPoint(cx, cy, cx, cy), 0));

check('snapping rounds to 15', snapAngle(7, 15) === 0);
check('snapping rounds up to 15', snapAngle(8, 15) === 15);
check('snapping rounds down to 15', snapAngle(22, 15) === 15);
check('snapping rounds up to 30', snapAngle(23, 15) === 30);
check('snapping keeps the sign', snapAngle(-10, 15) === -15);
check('the default step is 15', snapAngle(8) === 15);
check('a step of 1 is exact', snapAngle(37, 1) === 37);

console.log(`\nALL ${checks} CHECKS PASSED`);
