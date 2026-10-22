// Node test for src/text.js and src/ui/text-input.js.
//
//   node inkpad-text-test.mjs
//
// The repo is a static site with no test runner, so this is a plain script:
// it prints "ALL N CHECKS PASSED" and exits non-zero on the first failure.
// The canvas is faked — no real 2D context needed.

import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const {
  DEFAULT_TEXT_SIZE,
  MIN_TEXT_SIZE,
  MAX_TEXT_SIZE,
  isTextObject,
  createText,
  measureText,
  renderText,
  textBounds,
} = await import(pathToFileURL(`${SRC}/text.js`).href);

let checks = 0;

function check(name, cond) {
  checks += 1;
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// A fake 2D context: every glyph is `charWidth` wide, and it records what the
// renderer asked for.
function makeCtx(charWidth = 10) {
  const calls = { fillText: 0, measureText: 0, save: 0, restore: 0 };
  const texts = [];
  return {
    calls,
    texts,
    font: '',
    fillStyle: '',
    globalAlpha: 1,
    textAlign: '',
    textBaseline: '',
    measureText(s) {
      calls.measureText += 1;
      return { width: String(s).length * charWidth };
    },
    fillText(s, x, y) {
      calls.fillText += 1;
      texts.push({ text: String(s), x, y });
    },
    save() { calls.save += 1; },
    restore() { calls.restore += 1; },
  };
}

// --- the module exports the expected API -------------------------------------
check(
  'text.js exports the expected API',
  DEFAULT_TEXT_SIZE > 0 &&
    MIN_TEXT_SIZE > 0 &&
    MAX_TEXT_SIZE > DEFAULT_TEXT_SIZE &&
    typeof isTextObject === 'function' &&
    typeof createText === 'function' &&
    typeof measureText === 'function' &&
    typeof renderText === 'function' &&
    typeof textBounds === 'function',
);

// --- createText --------------------------------------------------------------
const t = createText({ x: 10, y: 20, text: 'Hello', size: 30, color: '#ff0000' });
check("createText marks the object as text", t.kind === 'text');
check('createText uses the text tool', t.tool === 'text');
check('createText keeps the text', t.text === 'Hello');
check('createText keeps the size', t.size === 30);
check('createText keeps the colour', t.color === '#ff0000');
check('createText has exactly one point', t.points.length === 1);
check('the one point is the anchor', t.points[0].x === 10 && t.points[0].y === 20);
check('x/y mirror the anchor', t.x === 10 && t.y === 20);
check('a text object has no line width', t.width === 0);
check('a text object is fully opaque', t.opacity === 1);
check('a text object has no measurement yet', t.measured === null);
check(
  'the anchor point carries pressure and a timestamp',
  t.points[0].pressure === 0.5 && typeof t.points[0].t === 'number' && Number.isFinite(t.points[0].t),
);
check('createText gives every object its own id', createText({}).id !== createText({}).id);

const plain = createText({});
check('createText defaults the size', plain.size === DEFAULT_TEXT_SIZE);
check('createText defaults the colour', plain.color === '#1b1b1b');
check('createText defaults the text to empty', plain.text === '');
check('the size is clamped to the minimum', createText({ size: 1 }).size === MIN_TEXT_SIZE);
check('the size is clamped to the maximum', createText({ size: 1000 }).size === MAX_TEXT_SIZE);

// --- isTextObject ------------------------------------------------------------
check('isTextObject is true for a text object', isTextObject(t) === true);
check(
  'isTextObject is false for a plain stroke',
  isTextObject({ id: 's1', tool: 'pen', color: '#000', width: 3, points: [] }) === false,
);
check('isTextObject is false for null', isTextObject(null) === false);
check('isTextObject is false for undefined', isTextObject(undefined) === false);

// --- measureText -------------------------------------------------------------
const ctx = makeCtx(10);
const m = measureText(ctx, t);
check('measureText returns the measured width', m.width === 50);
check('measureText returns a height', m.height > 0);
check('measureText caches on the object', t.measured === m);
check('the cache records the measured text', t.measured.text === 'Hello');
check('the cache records the measured size', t.measured.size === 30);

const callsAfterFirst = ctx.calls.measureText;
measureText(ctx, t);
check('a second measurement is served from the cache', ctx.calls.measureText === callsAfterFirst);

const wide = createText({ x: 0, y: 0, text: 'Hello world' });
const wideM = measureText(ctx, wide);
check('a wider text measures wider', wideM.width > m.width);

t.text = 'Hi';
const m2 = measureText(ctx, t);
check('changing the text invalidates the cache', ctx.calls.measureText > callsAfterFirst);
check('the new measurement is for the new text', m2.width === 20 && m2.text === 'Hi');

t.size = 40;
measureText(ctx, t);
check('changing the size invalidates the cache', t.measured.size === 40 && t.measured.text === 'Hi');

// --- multi-line --------------------------------------------------------------
const multi = createText({ x: 0, y: 0, text: 'ab\nabcd' });
const multiM = measureText(ctx, multi);
check('a multi-line text measures as the widest line', multiM.width === 40);
check(
  'a multi-line text is as tall as its lines',
  near(multiM.height, 2 * DEFAULT_TEXT_SIZE * 1.2, 1e-6),
);

// --- renderText --------------------------------------------------------------
const rctx = makeCtx(10);
const obj = createText({ x: 5, y: 6, text: 'one\ntwo', size: 20, color: '#00ff00' });
const rendered = renderText(rctx, obj);
check('renderText calls fillText once per line', rctx.calls.fillText === 2);
check('renderText draws the lines in order', rctx.texts[0].text === 'one' && rctx.texts[1].text === 'two');
check('renderText uses the text colour', rctx.fillStyle === '#00ff00');
check('renderText sets the font size', /(^|\s)20px/.test(rctx.font));
check('renderText sets the app font stack', /system-ui/.test(rctx.font));
check('renderText draws at the anchor x', rctx.texts[0].x === 5);
check('renderText puts the first baseline below the anchor', rctx.texts[0].y > 6);
check('renderText puts the second baseline lower', rctx.texts[1].y > rctx.texts[0].y);
check('renderText respects the opacity', rctx.globalAlpha === 1);
check('renderText returns the measured box', rendered === obj.measured);

const emptyCtx = makeCtx(10);
renderText(emptyCtx, createText({ x: 0, y: 0, text: '' }));
check('renderText draws nothing for empty text', emptyCtx.calls.fillText === 0);

// --- textBounds --------------------------------------------------------------
const boxed = createText({ x: 10, y: 20, size: 20 });
const fallback = textBounds(boxed);
check(
  'textBounds falls back to size x size without a measurement',
  fallback.minX === 10 && fallback.minY === 20 && fallback.maxX === 30 && fallback.maxY === 40,
);
boxed.measured = { width: 100, height: 50, size: 20, text: 'x' };
const measured = textBounds(boxed);
check(
  'textBounds uses the measured box',
  measured.minX === 10 && measured.minY === 20 && measured.maxX === 110 && measured.maxY === 70,
);

// The anchor is the POINT, so the existing move/scale code carries the text
// along with it.
boxed.points[0].x = 40;
boxed.points[0].y = 45;
const moved = textBounds(boxed);
check('the bounds follow the anchor point', moved.minX === 40 && moved.minY === 45);

// --- the UI module imports in Node -------------------------------------------
let documentTouched = false;
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  get() {
    documentTouched = true;
    return undefined;
  },
});
const ui = await import(pathToFileURL(`${SRC}/ui/text-input.js`).href);
delete globalThis.document;

check('the text-input module imports without touching document', !documentTouched);
check('the text-input module exports buildTextInput', typeof ui.buildTextInput === 'function');

console.log(`ALL ${checks} CHECKS PASSED`);
