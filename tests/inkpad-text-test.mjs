// Node test for src/text.js and src/ui/text-input.js.
//
//   node tests/inkpad-text-test.mjs
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
  TEXT_FONT_STACK,
  TEXT_FONT_FAMILIES,
  TEXT_FAMILIES,
  TEXT_ALIGNS,
  TEXT_LISTS,
  isTextObject,
  createText,
  measureText,
  renderText,
  textBounds,
  textFont,
  fontStack,
  clampTextSize,
  syncTextAnchor,
  fitTextSize,
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

// The px size in a CSS font shorthand.
function fontSizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  return m ? Number(m[1]) : 10;
}

// A fake 2D context: every glyph is `charWidth` wide AT A 10px FONT, and the
// width scales with the font size the renderer asks for — like a proportional
// font, where a glyph is about one em wide.
function makeCtx(charWidth = 10) {
  const calls = { fillText: 0, measureText: 0, save: 0, restore: 0, beginPath: 0, stroke: 0 };
  const texts = [];
  const underlines = [];
  let path = [];
  const ctx = {
    calls,
    texts,
    underlines,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: '',
    textBaseline: '',
    measureText(s) {
      calls.measureText += 1;
      const size = fontSizeOf(ctx.font) || 10;
      return { width: String(s).length * charWidth * (size / 10) };
    },
    fillText(s, x, y) {
      calls.fillText += 1;
      texts.push({ text: String(s), x, y, font: ctx.font, fillStyle: ctx.fillStyle });
    },
    beginPath() {
      calls.beginPath += 1;
      path = [];
    },
    moveTo(x, y) {
      path = [{ x, y }];
    },
    lineTo(x, y) {
      path.push({ x, y });
    },
    stroke() {
      calls.stroke += 1;
      if (path.length >= 2) {
        underlines.push({
          from: path[0],
          to: path[path.length - 1],
          color: ctx.strokeStyle,
          width: ctx.lineWidth,
        });
      }
      path = [];
    },
    save() { calls.save += 1; },
    restore() { calls.restore += 1; },
  };
  return ctx;
}

// --- the module exports the expected API -------------------------------------
check(
  'text.js exports the expected API',
  DEFAULT_TEXT_SIZE > 0 &&
    MIN_TEXT_SIZE > 0 &&
    MAX_TEXT_SIZE > DEFAULT_TEXT_SIZE &&
    typeof TEXT_FONT_STACK === 'string' &&
    typeof TEXT_FONT_FAMILIES === 'object' &&
    Array.isArray(TEXT_FAMILIES) && TEXT_FAMILIES.length === 4 &&
    Array.isArray(TEXT_ALIGNS) && TEXT_ALIGNS.length === 3 &&
    Array.isArray(TEXT_LISTS) && TEXT_LISTS.length === 3 &&
    typeof isTextObject === 'function' &&
    typeof createText === 'function' &&
    typeof measureText === 'function' &&
    typeof renderText === 'function' &&
    typeof textBounds === 'function' &&
    typeof textFont === 'function' &&
    typeof fontStack === 'function' &&
    typeof clampTextSize === 'function' &&
    typeof syncTextAnchor === 'function' &&
    typeof fitTextSize === 'function',
);

// --- createText --------------------------------------------------------------
const t = createText({ x: 10, y: 20, w: 200, h: 60, text: 'Hello', size: 30, color: '#ff0000' });
check('createText marks the object as text', t.kind === 'text');
check('createText uses the text tool', t.tool === 'text');
check('createText keeps the text', t.text === 'Hello');
check('createText keeps the size', t.size === 30);
check('createText keeps the colour', t.color === '#ff0000');
check('createText keeps the box width', t.w === 200);
check('createText keeps the box height', t.h === 60);
check('createText has exactly one point', t.points.length === 1);
check('the one point is the top-left corner', t.points[0].x === 10 && t.points[0].y === 20);
check('x/y mirror the corner', t.x === 10 && t.y === 20);
check('a text object has no line width', t.width === 0);
check('a text object is fully opaque', t.opacity === 1);
check('a text object has no measurement yet', t.measured === null);
check(
  'the corner point carries pressure and a timestamp',
  t.points[0].pressure === 0.5 && typeof t.points[0].t === 'number' && Number.isFinite(t.points[0].t),
);
check('createText gives every object its own id', createText({}).id !== createText({}).id);

const plain = createText({});
check('createText defaults the size', plain.size === DEFAULT_TEXT_SIZE);
check('createText defaults the colour', plain.color === '#1b1b1b');
check('createText defaults the text to empty', plain.text === '');
check('createText defaults the box to auto-sized', plain.w === 0 && plain.h === 0);
check('createText defaults the family to sans', plain.family === 'sans');
check('createText defaults the weight to regular', plain.bold === false);
check('createText defaults italic off', plain.italic === false);
check('createText defaults underline off', plain.underline === false);
check('createText defaults the alignment to left', plain.align === 'left');
check('createText defaults the list to none', plain.list === 'none');
check('the size is clamped to the minimum', createText({ size: 1 }).size === MIN_TEXT_SIZE);
check('the size is clamped to the maximum', createText({ size: 1000 }).size === MAX_TEXT_SIZE);

const rich = createText({
  family: 'serif', bold: true, italic: true, underline: true,
  align: 'center', list: 'number',
});
check('createText keeps the family', rich.family === 'serif');
check('createText keeps bold', rich.bold === true);
check('createText keeps italic', rich.italic === true);
check('createText keeps underline', rich.underline === true);
check('createText keeps the alignment', rich.align === 'center');
check('createText keeps the list', rich.list === 'number');
check('an unknown family falls back to sans', createText({ family: 'comic' }).family === 'sans');
check('an unknown alignment falls back to left', createText({ align: 'justify' }).align === 'left');
check('an unknown list falls back to none', createText({ list: 'roman' }).list === 'none');
check('a truthy non-true bold is not bold', createText({ bold: 1 }).bold === false);

// --- isTextObject ------------------------------------------------------------
check('isTextObject is true for a text object', isTextObject(t) === true);
check(
  'isTextObject is false for a plain stroke',
  isTextObject({ id: 's1', tool: 'pen', color: '#000', width: 3, points: [] }) === false,
);
check('isTextObject is false for null', isTextObject(null) === false);
check('isTextObject is false for undefined', isTextObject(undefined) === false);

// --- the font helpers --------------------------------------------------------
check('textFont sets the size in px', /^28px /.test(textFont(28)));
check('textFont uses the app font stack', textFont(28).includes('system-ui'));
check('the serif stack is a system serif', fontStack('serif').includes('Georgia'));
check('the mono stack is a system mono', fontStack('mono').includes('ui-monospace'));
check('the hand stack is a system script face', fontStack('hand').includes('Bradley Hand'));
check('an unknown family uses the app stack', fontStack('nope') === TEXT_FONT_STACK);
check('textFont honours the family', textFont(20, 'serif').includes('Georgia'));
check('textFont writes bold into the shorthand', /^700 20px /.test(textFont(20, 'sans', { bold: true })));
check(
  'textFont writes italic into the shorthand',
  /^italic 20px /.test(textFont(20, 'sans', { italic: true })),
);
check(
  'textFont writes bold and italic in CSS order',
  /^italic 700 20px /.test(textFont(20, 'sans', { bold: true, italic: true })),
);
check('all four family stacks are distinct', new Set(TEXT_FAMILIES.map(fontStack)).size === 4);
check('clampTextSize clamps low', clampTextSize(1) === MIN_TEXT_SIZE);
check('clampTextSize clamps high', clampTextSize(999) === MAX_TEXT_SIZE);
check('clampTextSize falls back on nonsense', clampTextSize('abc') === DEFAULT_TEXT_SIZE);

// --- measureText: the wrapping -----------------------------------------------
// The fake context gives 10px per character at a 10px font, so a box 100 wide
// holds ten characters a line.
const wrapCtx = makeCtx(10);
const wrapped = createText({ x: 0, y: 0, w: 100, text: 'x'.repeat(30), size: 10 });
const wm = measureText(wrapCtx, wrapped);
check('the text wraps into three lines', wm.lines.length === 3);
check('every wrapped line holds ten characters', wm.lines.every((l) => l.length === 10));
check('the wrapped lines are the text', wm.lines.join('') === 'x'.repeat(30));
check('the measured width is the widest line', wm.width === 100);
check(
  'the measured height is the lines times the line height',
  near(wm.height, 3 * 10 * 1.2, 1e-9),
);
check('the measurement is cached on the object', wrapped.measured === wm);

// Words are kept whole while they fit.
const wordCtx = makeCtx(10);
const worded = createText({ x: 0, y: 0, w: 100, text: 'abcd efgh ijkl', size: 10 });
const wordM = measureText(wordCtx, worded);
check('words are wrapped, not split', wordM.lines.length === 2);
check('the first line holds the two words that fit', wordM.lines[0] === 'abcd efgh');
check('the second line holds the rest', wordM.lines[1] === 'ijkl');
check('the measured width is the widest line', wordM.width === 90);

// A box with no width does not wrap: only "\n" breaks the line.
const autoCtx = makeCtx(10);
const auto = createText({ x: 0, y: 0, text: 'x'.repeat(30), size: 10 });
const autoM = measureText(autoCtx, auto);
check('an auto-sized box does not wrap', autoM.lines.length === 1);
check('an auto-sized box measures the whole line', autoM.width === 300);

// --- measureText: several lines ----------------------------------------------
const multi = createText({ x: 0, y: 0, text: 'ab\nabcd', size: 10 });
const multiM = measureText(autoCtx, multi);
check('a multi-line text keeps its lines', multiM.lines.length === 2);
check('a multi-line text measures as the widest line', multiM.width === 40);
check(
  'a multi-line text is as tall as its lines',
  near(multiM.height, 2 * 10 * 1.2, 1e-6),
);

// --- measureText: the cache --------------------------------------------------
const cacheCtx = makeCtx(10);
const cached = createText({ x: 0, y: 0, w: 200, text: 'hello', size: 10 });
measureText(cacheCtx, cached);
const afterFirst = cacheCtx.calls.measureText;
measureText(cacheCtx, cached);
check('a second measurement is served from the cache', cacheCtx.calls.measureText === afterFirst);

cached.text = 'hi';
const m2 = measureText(cacheCtx, cached);
check('changing the text invalidates the cache', cacheCtx.calls.measureText > afterFirst);
check('the new measurement is for the new text', m2.text === 'hi' && m2.width === 20);

const afterText = cacheCtx.calls.measureText;
cached.size = 20;
const m3 = measureText(cacheCtx, cached);
check('changing the size invalidates the cache', cacheCtx.calls.measureText > afterText);
check('the new measurement is for the new size', m3.size === 20 && m3.width === 40);

const afterSize = cacheCtx.calls.measureText;
cached.w = 30;
const m4 = measureText(cacheCtx, cached);
check('changing the box width invalidates the cache', cacheCtx.calls.measureText > afterSize);
check('the new measurement wraps to the new width', m4.width === 20 && m4.lines.length === 2);

const afterWidth = cacheCtx.calls.measureText;
measureText(cacheCtx, cached);
check('the measurement is cached again', cacheCtx.calls.measureText === afterWidth);

// --- renderText --------------------------------------------------------------
const rctx = makeCtx(10);
const robj = createText({ x: 5, y: 6, w: 100, text: 'abcde\nfghij', size: 20, color: '#00ff00' });
const rendered = renderText(rctx, robj);
check('renderText calls fillText once per line', rctx.calls.fillText === 2);
check('renderText draws the lines in order', rctx.texts[0].text === 'abcde' && rctx.texts[1].text === 'fghij');
check('renderText uses the text colour', rctx.fillStyle === '#00ff00');
check('renderText paints with the text colour', rctx.texts[0].fillStyle === '#00ff00');
check('renderText sets the font size', /(^|\s)20px/.test(rctx.font));
check('renderText sets the app font stack', /system-ui/.test(rctx.font));
check('renderText draws with that font', /(^|\s)20px/.test(rctx.texts[0].font));
check('renderText draws at the box left edge', rctx.texts[0].x === 5);
check(
  'the first baseline sits 0.8 of a size below the top',
  near(rctx.texts[0].y, 6 + 0.8 * 20, 1e-9),
);
check(
  'the lines are 1.2 of a size apart',
  near(rctx.texts[1].y - rctx.texts[0].y, 1.2 * 20, 1e-9),
);
check('renderText respects the opacity', rctx.globalAlpha === 1);
check('renderText returns the measured box', rendered === robj.measured);

const emptyCtx = makeCtx(10);
renderText(emptyCtx, createText({ x: 0, y: 0, text: '' }));
check('renderText draws nothing for empty text', emptyCtx.calls.fillText === 0);

// A text taller than its box overflows: it is drawn, not clipped.
const overCtx = makeCtx(10);
const over = createText({ x: 0, y: 0, w: 100, h: 10, text: 'x'.repeat(30), size: 10 });
renderText(overCtx, over);
check('an overflowing text is still drawn', overCtx.calls.fillText === 3);
check('an overflowing text is still visible', overCtx.globalAlpha > 0);

// --- lists -------------------------------------------------------------------
const bulletCtx = makeCtx(10);
const bullet = createText({ x: 0, y: 0, text: 'alpha\nbeta', size: 10, list: 'bullet' });
const bulletM = measureText(bulletCtx, bullet);
check('a bullet list marks every item', bulletM.markers.join('|') === '•|•');
check('a bullet reserves the marker width on each line', bulletM.indents[0] === 20 && bulletM.indents[1] === 20);
check('the list width includes the marker inset', bulletM.width === 70);
check('the list height still counts the lines', near(bulletM.height, 2 * 10 * 1.2, 1e-9));

const numberM = measureText(bulletCtx, createText({ text: 'one\ntwo', size: 10, list: 'number' }));
check('a numbered list counts the items', numberM.markers.join('|') === '1.|2.');
check('the number inset fits the widest marker', numberM.indents[0] === 30 && numberM.indents[1] === 30);
check('the numbered width includes its inset', numberM.width === 60);

const listWrapCtx = makeCtx(10);
const listWrap = createText({ x: 0, y: 0, w: 100, text: 'aaaaa bbbbb', size: 10, list: 'bullet' });
const listWrapM = measureText(listWrapCtx, listWrap);
check('a list wraps inside the width left by the marker', listWrapM.lines.length === 2);
check('only the first wrapped line carries the marker', listWrapM.markers.join('|') === '•|');
check('a wrapped continuation keeps the marker inset', listWrapM.indents[0] === 20 && listWrapM.indents[1] === 20);
check('the continuation does not start under the bullet text', listWrapM.lines[1] === 'bbbbb');

const bulletDrawCtx = makeCtx(10);
renderText(bulletDrawCtx, bullet);
check('renderText draws the bullet before each item', bulletDrawCtx.texts[0].text === '•' && bulletDrawCtx.texts[2].text === '•');
check('renderText indents the text past the bullet', bulletDrawCtx.texts[1].x === 20 && bulletDrawCtx.texts[3].x === 20);
check('the bullet sits at the box edge', bulletDrawCtx.texts[0].x === 0 && bulletDrawCtx.texts[2].x === 0);

// A blank paragraph in a list is a blank line, not an empty numbered item.
const blankListM = measureText(bulletCtx, createText({ text: 'one\n\nthree', size: 10, list: 'number' }));
check('a blank line does not consume a number', blankListM.markers.join('|') === '1.||2.');
check('a blank line has no marker inset', blankListM.indents[1] === 0);

// --- bold / italic / alignment ----------------------------------------------
const styleCtx = makeCtx(10);
const styled = createText({ x: 0, y: 0, w: 100, text: 'abcd', size: 10, bold: true, italic: true, family: 'serif' });
renderText(styleCtx, styled);
check('renderText writes bold and italic into the font', /^italic 700 10px /.test(styleCtx.texts[0].font));
check('renderText uses the chosen family', styleCtx.texts[0].font.includes('Georgia'));

function lineX(align) {
  const ctx = makeCtx(10);
  const obj = createText({ x: 10, y: 20, w: 100, text: 'abcd', size: 10, align });
  renderText(ctx, obj);
  return ctx.texts[0].x;
}
check('left alignment starts at the box edge', lineX('left') === 10);
check('centre alignment centres the measured line', lineX('center') === 40);
check('right alignment ends at the box edge', lineX('right') === 70);
check(
  'alignment does not change the measured width',
  measureText(makeCtx(10), createText({ w: 100, text: 'abcd', size: 10, align: 'right' })).width === 40,
);

// --- underline ---------------------------------------------------------------
const underlineCtx = makeCtx(10);
const underlined = createText({ x: 5, y: 6, text: 'abc\nde', size: 10, underline: true });
renderText(underlineCtx, underlined);
check('renderText underlines each rendered line', underlineCtx.underlines.length === 2);
check(
  'the underline starts under the text',
  underlineCtx.underlines[0].from.x === 5 && underlineCtx.underlines[1].from.x === 5,
);
check(
  'the underline is as wide as the measured line',
  underlineCtx.underlines[0].to.x === 35 && underlineCtx.underlines[1].to.x === 25,
);
check(
  'the underline sits below the baseline',
  near(underlineCtx.underlines[0].from.y, 6 + 0.8 * 10 + 0.18 * 10, 1e-9),
);
check('the underline uses the text colour', underlineCtx.underlines[0].color === '#1b1b1b');
const noUnderlineCtx = makeCtx(10);
renderText(noUnderlineCtx, createText({ text: 'plain', size: 10 }));
check('text is not underlined by default', noUnderlineCtx.underlines.length === 0);

// --- the measure cache keys on every style field -----------------------------
const keyCtx = makeCtx(10);
const keyed = createText({ x: 0, y: 0, w: 100, text: 'hello', size: 10 });
measureText(keyCtx, keyed);
let beforeKey = keyCtx.calls.measureText;
for (const [field, value] of [
  ['family', 'serif'],
  ['bold', true],
  ['italic', true],
  ['underline', true],
  ['align', 'center'],
  ['list', 'bullet'],
]) {
  keyed[field] = value;
  measureText(keyCtx, keyed);
  check(`changing ${field} invalidates the measure cache`, keyCtx.calls.measureText > beforeKey);
  beforeKey = keyCtx.calls.measureText;
}
const cachedAgain = keyCtx.calls.measureText;
measureText(keyCtx, keyed);
check('the measurement is cached again after the style changes', keyCtx.calls.measureText === cachedAgain);

// --- textBounds --------------------------------------------------------------
const boxed = createText({ x: 10, y: 20, w: 200, h: 60, size: 20 });
const b = textBounds(boxed);
check(
  'textBounds uses the drawn box',
  b.minX === 10 && b.minY === 20 && b.maxX === 210 && b.maxY === 80,
);

const measuredOnly = createText({ x: 10, y: 20, text: 'abc', size: 10 });
measureText(autoCtx, measuredOnly);
const mb = textBounds(measuredOnly);
check(
  'textBounds falls back to the measured box',
  mb.minX === 10 && mb.minY === 20 && mb.maxX === 40 && mb.maxY === 32,
);

const unmeasured = createText({ x: 10, y: 20, size: 20 });
const ub = textBounds(unmeasured);
check(
  'textBounds falls back to a size square without a measurement',
  ub.minX === 10 && ub.minY === 20 && ub.maxX === 30 && ub.maxY === 40,
);

// The anchor is the POINT, so the existing move/scale code carries the text
// along with it.
boxed.points[0].x = 40;
boxed.points[0].y = 45;
const moved = textBounds(boxed);
check('the bounds follow the anchor point', moved.minX === 40 && moved.minY === 45);

// --- syncTextAnchor ----------------------------------------------------------
const anchor = createText({ x: 1, y: 2, w: 10, h: 10 });
anchor.points[0].x = 7;
anchor.points[0].y = 9;
syncTextAnchor(anchor);
check('syncTextAnchor copies the point onto x/y', anchor.x === 7 && anchor.y === 9);
check('syncTextAnchor leaves the box alone', anchor.w === 10 && anchor.h === 10);

// --- fitTextSize -------------------------------------------------------------
// 30 characters in a box 100 wide: at 40px the characters are 40 wide, so the
// text needs eight lines and 720 of height. At 20px it needs six lines and
// exactly 144 — the box is 144 tall, so 20 is the largest size that fits.
const fitCtx = makeCtx(10);
const fit = createText({ x: 0, y: 0, w: 100, h: 144, text: 'x'.repeat(30), size: 40 });
const fitted = fitTextSize(fitCtx, fit);
check('fitTextSize shrinks the size until the text fits', fitted === 20);
check('fitTextSize does not change the object', fit.size === 40);

fit.size = fitted;
const fitM = measureText(fitCtx, fit);
check('the fitted text fits the box width', fitM.width <= 100);
check('the fitted text fits the box height', fitM.height <= 144);

// A box far too small: the size never goes below the minimum.
const tiny = createText({ x: 0, y: 0, w: 20, h: 5, text: 'x'.repeat(30), size: 40 });
const tinyFit = fitTextSize(fitCtx, tiny);
check('fitTextSize never goes below the minimum', tinyFit === MIN_TEXT_SIZE);
check('fitTextSize never goes below the minimum asked for', fitTextSize(fitCtx, tiny, { min: 24 }) === 24);

// A box with no size constrains nothing, so the size is left alone.
const loose = createText({ x: 0, y: 0, text: 'x'.repeat(30), size: 40 });
check('fitTextSize leaves a box with no size alone', fitTextSize(fitCtx, loose) === 40);

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

const input = ui.buildTextInput({});
check('buildTextInput works without a DOM', Boolean(input));
check(
  'the text input exposes the expected API',
  typeof input.openAt === 'function' &&
    typeof input.close === 'function' &&
    typeof input.isOpen === 'function' &&
    typeof input.getValue === 'function' &&
    typeof input.setValue === 'function',
);
check('the text input is closed by default', input.isOpen() === false);

// --- storage: the new rich-text fields round-trip ----------------------------
const storage = await import(pathToFileURL(`${SRC}/storage.js`).href);
const stored = createText({
  x: 12, y: 34, w: 200, h: 80, text: 'Rich text', size: 22, color: '#123456',
  family: 'mono', bold: true, italic: true, underline: true,
  align: 'right', list: 'bullet',
});
const noteRecord = storage.toRecord({
  id: 'note-rich',
  title: 'Rich',
  pages: [{ id: 'page-rich', strokes: [stored] }],
});
const noteBack = storage.fromRecord(noteRecord);
const storedBack = noteBack.pages[0].strokes[0];
check('storage keeps the text family', storedBack.family === 'mono');
check('storage keeps text bold', storedBack.bold === true);
check('storage keeps text italic', storedBack.italic === true);
check('storage keeps text underline', storedBack.underline === true);
check('storage keeps the text alignment', storedBack.align === 'right');
check('storage keeps the text list', storedBack.list === 'bullet');
check('storage still keeps the plain text fields', storedBack.text === 'Rich text' && storedBack.size === 22);
check('storage still keeps the text points', storedBack.points.length === 1 && storedBack.points[0].x === 12);

const legacyStroke = storage.fromRecord({
  id: 'note-legacy',
  pages: [{
    id: 'page-legacy',
    strokes: [{ id: 'old-text', kind: 'text', text: 'old', points: [{ x: 0, y: 0 }] }],
  }],
}).pages[0].strokes[0];
check('an old text record defaults to sans', legacyStroke.family === 'sans');
check('an old text record defaults to left', legacyStroke.align === 'left');
check('an old text record defaults to no list', legacyStroke.list === 'none');
check('an old text record defaults to no underline', legacyStroke.underline === false);

// --- the text-bar module imports in Node -------------------------------------
let barDocumentTouched = false;
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  get() {
    barDocumentTouched = true;
    return undefined;
  },
});
const barModule = await import(pathToFileURL(`${SRC}/ui/text-bar.js`).href);
delete globalThis.document;

check('the text-bar module imports without touching document', !barDocumentTouched);
check('the text-bar module exports buildTextBar', typeof barModule.buildTextBar === 'function');
const bar = barModule.buildTextBar({});
check('buildTextBar works without a DOM', Boolean(bar));
check(
  'the text bar exposes the expected API',
  typeof bar.update === 'function' &&
    typeof bar.setVisible === 'function' &&
    typeof bar.isVisible === 'function' &&
    typeof bar.reposition === 'function',
);
check('the text bar is hidden by default', bar.isVisible() === false);
check('the list toggles none to bullet', barModule.cycleList('none') === 'bullet');
check('the list toggles bullet to number', barModule.cycleList('bullet') === 'number');
check('the list toggles number back to none', barModule.cycleList('number') === 'none');
check('the alignment toggles left to centre', barModule.cycleAlign('left') === 'center');
check('the alignment toggles centre to right', barModule.cycleAlign('center') === 'right');
check('the alignment toggles right back to left', barModule.cycleAlign('right') === 'left');

console.log(`ALL ${checks} CHECKS PASSED`);
