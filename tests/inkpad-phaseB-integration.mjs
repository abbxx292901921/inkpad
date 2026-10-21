// Phase B integration test: drives src/canvas.js with synthetic Pointer
// Events against a stubbed canvas. Verifies the iPad-critical behaviours:
// synchronous painting, palm rejection, squeeze-to-erase, pen hover.
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const { createDrawingSurface } = await import(pathToFileURL(`${SRC}/canvas.js`).href);
const { createViewport } = await import(pathToFileURL(`${SRC}/coord.js`).href);
const { setCurrentTool } = await import(pathToFileURL(`${SRC}/tools.js`).href);
const { createInputPolicy } = await import(pathToFileURL(`${SRC}/input.js`).href);

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`ok ${n} - ${name}`);
}

// ---- fake canvas ---------------------------------------------------------
function fakeCanvas() {
  const handlers = {};
  const ctx = {
    strokes: 0, fills: 0, arcs: 0, quads: 0, moves: 0,
    captured: new Set(),
    save() {}, restore() {}, beginPath() {}, moveTo() { this.moves = (this.moves || 0) + 1; },
    quadraticCurveTo() { this.quads = (this.quads || 0) + 1; },
    lineTo() {}, stroke() { this.strokes = (this.strokes || 0) + 1; },
    fill() { this.fills = (this.fills || 1) + 1; }, arc() { this.arcs = (this.arcs || 1) + 1; },
    clearRect() {}, setTransform() {},
    get globalCompositeOperation() { return 'source-over'; },
    set globalCompositeOperation(v) {},
  };
  return {
    ctx,
    handlers,
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    setPointerCapture(id) { ctx.captured.add(id); },
    hasPointerCapture(id) { return ctx.captured.has(id); },
    releasePointerCapture(id) { ctx.captured.delete(id); },
    fire(type, ev) { for (const fn of handlers[type] || []) fn(ev); },
  };
}

function ev(type, props) {
  return {
    type,
    pointerId: props.pointerId ?? 1,
    pointerType: props.pointerType ?? 'pen',
    clientX: props.clientX ?? 0,
    clientY: props.clientY ?? 0,
    pressure: props.pressure ?? 0.5,
    buttons: props.buttons ?? 1,
    button: props.button ?? 0,
    width: props.width ?? 0,
    height: props.height ?? 0,
    isPrimary: true,
    getCoalescedEvents() {
      return props.coalesced ?? [this];
    },
    preventDefault() {},
  };
}

// ---- harness -------------------------------------------------------------
let fakeNow = 1000;
const realPerformance = globalThis.performance;
globalThis.performance = { now: () => fakeNow };
globalThis.window = { devicePixelRatio: 2 };

function makeSurface() {
  const canvas = fakeCanvas();
  const viewport = createViewport();
  const calls = { committed: [], erased: [], hover: [], debug: [] };
  // Fresh, isolated input policy per surface so one test cannot leak state
  // into the next.
  const input = createInputPolicy({ persist: false });
  const surface = createDrawingSurface(canvas, viewport, {
    getStrokes: () => calls.committed.map((s) => s),
    commitStroke: (s) => calls.committed.push(s),
    erasePath: (p) => calls.erased.push(p),
    onPenHover: (h) => calls.hover.push(h),
    debug: (t) => calls.debug.push(t),
    input,
  });
  surface.resize();
  return { canvas, viewport, calls, surface, input };
}

// ---- 1. a pen stroke paints and commits --------------------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointerdown', ev('pointerdown', { clientX: 10, clientY: 20, pressure: 0.5 }));
  canvas.fire('pointermove', ev('pointermove', { clientX: 30, clientY: 20, pressure: 0.5 }));
  canvas.fire('pointermove', ev('pointermove', { clientX: 50, clientY: 20, pressure: 0.5 }));
  canvas.fire('pointerup', ev('pointerup', { clientX: 50, clientY: 20, pressure: 0.5 }));
  ok(calls.committed.length === 1, 'pen stroke commits one stroke');
  const s = calls.committed[0];
  ok(s.points.length === 3, 'stroke has 3 points');
  ok(s.pointerType === 'pen', 'stroke records pointerType');
  ok(s.points[0].x === 10 && s.points[0].y === 20, 'points are in page coords');
  ok(canvas.ctx.quads >= 1, 'geometry was painted during the stroke');
  ok(canvas.ctx.strokes >= 2, 'pieces + tail were stroked');
}

// ---- 2. coalesced events all land ---------------------------------------
{
  const { canvas, calls } = makeSurface();
  const batch = [
    { ...ev('pointermove', { clientX: 10, clientY: 10 }), clientX: 10, clientY: 10 },
    { ...ev('pointermove', { clientX: 12, clientY: 10 }), clientX: 12, clientY: 10 },
    { ...ev('pointermove', { clientX: 14, clientY: 10 }), clientX: 14, clientY: 10 },
    { ...ev('pointermove', { clientX: 16, clientY: 10 }), clientX: 16, clientY: 10 },
  ];
  canvas.fire('pointerdown', ev('pointerdown', { clientX: 8, clientY: 10 }));
  canvas.fire('pointermove', { ...ev('pointermove', { clientX: 16 }), getCoalescedEvents: () => batch });
  canvas.fire('pointerup', ev('pointerup', { clientX: 16 }));
  ok(calls.committed[0].points.length === 5, 'all coalesced points are kept');
}

// ---- 3. PALM REJECTION: touch does not draw once a pen has been seen -----
{
  const { canvas, calls } = makeSurface();
  // pen hover -> a pen has been seen, so a finger is a resting hand
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'pen', buttons: 0, clientX: 5, clientY: 5 }));
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 100 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 120, clientY: 100 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 7, clientX: 120, clientY: 100 }));
  ok(calls.committed.length === 0, 'touch does NOT draw while a pen has been seen');
  ok(calls.erased.length === 0, 'touch does not erase either');
}

// ---- 4. the pen latch does NOT expire (old grace window is gone) -------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'pen', buttons: 0, clientX: 5, clientY: 5 }));
  fakeNow += 60000; // a minute later — the pen is still "seen" this session
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 9, clientX: 100, clientY: 100 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 9, clientX: 120, clientY: 100 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 9, clientX: 120, clientY: 100 }));
  ok(calls.committed.length === 0, 'touch still blocked long after the pen event');
}

// ---- 4b. finger drawing works when NO pen has ever been seen -------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 11, clientX: 100, clientY: 100 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 11, clientX: 120, clientY: 100 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 11, clientX: 120, clientY: 100 }));
  ok(calls.committed.length === 1, 'touch draws when no pen is around');
  ok(calls.committed[0].pointerType === 'touch', 'touch stroke records pointerType');
}

// ---- 5. SQUEEZE / ERASER END: pen gesture erases ------------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointerdown', ev('pointerdown', { buttons: 32, clientX: 10, clientY: 10 }));
  canvas.fire('pointermove', ev('pointermove', { buttons: 32, clientX: 30, clientY: 10 }));
  canvas.fire('pointerup', ev('pointerup', { buttons: 32, clientX: 30, clientY: 10 }));
  ok(calls.erased.length === 1, 'pen eraser bit (32) produces an erase gesture');
  ok(calls.erased[0].length === 2, 'erase path has the gesture points');
  ok(calls.committed.length === 0, 'erase gesture paints no ink');
}

// ---- 6. barrel button also erases ---------------------------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointerdown', ev('pointerdown', { buttons: 2, clientX: 10, clientY: 10 }));
  canvas.fire('pointerup', ev('pointerup', { buttons: 2, clientX: 10, clientY: 10 }));
  ok(calls.erased.length === 1, 'barrel button (2) erases');
}

// ---- 7. pen hover drives the cursor ring --------------------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'pen', buttons: 0, clientX: 42, clientY: 24 }));
  ok(calls.hover.length === 1, 'pen hover reports a position');
  ok(calls.hover[0].x === 42 && calls.hover[0].y === 24, 'hover position is in page coords');
}

// ---- 8. mouse draws, right button does not ------------------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'mouse', button: 2, buttons: 2, clientX: 10, clientY: 10 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'mouse', button: 2, clientX: 10, clientY: 10 }));
  ok(calls.committed.length === 0, 'right mouse button does not draw');
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'mouse', button: 0, buttons: 1, clientX: 10, clientY: 10 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 }));
  ok(calls.committed.length === 1, 'left mouse button draws');
}

// ---- 9. the eraser TOOL produces an erase gesture (no ink) ---------------
{
  const { canvas, calls } = makeSurface();
  setCurrentTool('eraser');
  canvas.fire('pointerdown', ev('pointerdown', { clientX: 10, clientY: 10 }));
  canvas.fire('pointermove', ev('pointermove', { clientX: 40, clientY: 10 }));
  canvas.fire('pointerup', ev('pointerup', { clientX: 40, clientY: 10 }));
  setCurrentTool('pen');
  ok(calls.erased.length === 1, 'eraser tool erases');
  ok(calls.committed.length === 0, 'eraser tool paints no ink');
}

// ---- 10. pointercancel DISCARDS (does not commit) -----------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointerdown', ev('pointerdown', { clientX: 10, clientY: 10 }));
  canvas.fire('pointermove', ev('pointermove', { clientX: 30, clientY: 10 }));
  canvas.fire('pointercancel', ev('pointercancel', { clientX: 30, clientY: 10 }));
  ok(calls.committed.length === 0, 'pointercancel DISCARDS the stroke (no ink left behind)');
  const { surface } = makeSurface();
  ok(surface.activeCount() === 0, 'no pointer is left active');
}

// ---- 11. an in-flight finger stroke is thrown away when a pen lands -----
{
  const { canvas, calls } = makeSurface();
  // Hand rests on the screen first -> this finger stroke starts...
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 21, clientX: 40, clientY: 40 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 21, clientX: 55, clientY: 45 }));
  // ...then the Pencil touches down -> the hand stroke must be discarded.
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'pen', pointerId: 22, clientX: 80, clientY: 80 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 21, clientX: 55, clientY: 45 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'pen', pointerId: 22, clientX: 80, clientY: 80 }));
  ok(calls.committed.length === 1, 'the palm stroke is discarded, only the pen stroke commits');
  ok(calls.committed[0].pointerType === 'pen', 'the surviving stroke is the pen one');
}

// ---- 12. explicit "finger drawing ON" overrides the auto rule -----------
{
  const { canvas, calls, input } = makeSurface();
  input.setFingerDrawing(true); // explicit: fingers draw
  ok(input.fingerDrawingEnabled() === true, 'setFingerDrawing(true) turns finger drawing on');
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'pen', buttons: 0, clientX: 5, clientY: 5 }));
  ok(input.fingerDrawingEnabled() === true, 'an explicit choice survives the pen being seen');
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 31, clientX: 100, clientY: 100 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 31, clientX: 120, clientY: 100 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 31, clientX: 120, clientY: 100 }));
  ok(calls.committed.length === 1, 'fingers draw when the user explicitly allows it');
  ok(calls.committed[0].pointerType === 'touch', 'that stroke is the finger one');
}

// ---- 12b. explicit "pen only" survives too ------------------------------
{
  const { canvas, calls, input } = makeSurface();
  input.setFingerDrawing(false);
  ok(input.fingerDrawingEnabled() === false, 'setFingerDrawing(false) is pen only');
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 51, clientX: 100, clientY: 100 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 51, clientX: 120, clientY: 100 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 51, clientX: 120, clientY: 100 }));
  ok(calls.committed.length === 0, 'fingers are blocked in pen-only mode');
}

// ---- 13. a palm-sized contact is rejected even with no pen around ------
{
  const { canvas, calls } = makeSurface();
  // big contact ellipse = a resting hand, not a fingertip
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 41, clientX: 100, clientY: 100, width: 120, height: 95 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 41, clientX: 130, clientY: 110, width: 120, height: 95 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 41, clientX: 130, clientY: 110 }));
  ok(calls.committed.length === 0, 'a large touch contact is treated as a palm');
  // a normal fingertip still draws
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'touch', pointerId: 42, clientX: 100, clientY: 100, width: 18, height: 22 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'touch', pointerId: 42, clientX: 120, clientY: 100, width: 18, height: 22 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'touch', pointerId: 42, clientX: 120, clientY: 100 }));
  ok(calls.committed.length === 1, 'a fingertip-sized contact still draws');
}

// ---- 14. the mouse is never affected by palm rejection ------------------
{
  const { canvas, calls } = makeSurface();
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'pen', buttons: 0, clientX: 5, clientY: 5 }));
  canvas.fire('pointerdown', ev('pointerdown', { pointerType: 'mouse', button: 0, buttons: 1, clientX: 10, clientY: 10 }));
  canvas.fire('pointermove', ev('pointermove', { pointerType: 'mouse', button: 0, buttons: 1, clientX: 40, clientY: 10 }));
  canvas.fire('pointerup', ev('pointerup', { pointerType: 'mouse', button: 0, buttons: 1, clientX: 40, clientY: 10 }));
  ok(calls.committed.length === 1, 'the mouse still draws after a pen was seen');
}

globalThis.performance = realPerformance;
console.log(`\nALL ${n} INTEGRATION CHECKS PASSED`);
