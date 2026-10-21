// inkpad-export-test.mjs — Node test for src/export.js.
//
// The pure parts (pageBounds, estimatePageSize) are tested directly. The
// canvas-dependent parts run against a tiny fake DOM/canvas so the whole
// render -> blob -> download -> print path is exercised without a browser.
//
// Run: node inkpad-export-test.mjs

import { pathToFileURL } from 'node:url';

const REPO = process.env.INKPAD_REPO || 'C:\\AI Projects\\chatability';
const MODULE = `${REPO}\\src\\export.js`;

let checks = 0;

function check(name, cond, detail) {
  checks += 1;
  if (!cond) {
    console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`  ok  ${name}`);
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// --- fake DOM ----------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.style = {};
    this.attrs = {};
    this.className = '';
    this._id = '';
    this._text = '';
    this.clicked = false;
  }

  get id() {
    return this._id;
  }

  set id(v) {
    this._id = String(v);
  }

  get textContent() {
    return this._text;
  }

  set textContent(v) {
    this._text = String(v);
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  getAttribute(name) {
    return this.attrs[name];
  }

  click() {
    this.clicked = true;
  }

  descendants() {
    const out = [];
    for (const c of this.children) {
      out.push(c);
      out.push(...c.descendants());
    }
    return out;
  }
}

function makeFakeCtx(canvas) {
  const ops = [];
  return {
    ops,
    canvas,
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    setTransform(...a) {
      ops.push(['setTransform', ...a]);
    },
    save() {
      ops.push(['save']);
    },
    restore() {
      ops.push(['restore']);
    },
    beginPath() {
      ops.push(['beginPath']);
    },
    moveTo(x, y) {
      ops.push(['moveTo', x, y]);
    },
    lineTo(x, y) {
      ops.push(['lineTo', x, y]);
    },
    quadraticCurveTo(cx, cy, x, y) {
      ops.push(['quadraticCurveTo', cx, cy, x, y]);
    },
    arc(x, y, r) {
      ops.push(['arc', x, y, r]);
    },
    fill() {
      ops.push(['fill']);
    },
    stroke() {
      ops.push(['stroke']);
    },
    fillRect(x, y, w, h) {
      ops.push(['fillRect', x, y, w, h]);
    },
    drawImage(img, ...a) {
      ops.push(['drawImage', ...a]);
    },
    setLineDash(d) {
      ops.push(['setLineDash', d]);
    },
  };
}

class FakeCanvas extends FakeElement {
  constructor() {
    super('canvas');
    this.width = 0;
    this.height = 0;
    this.ctx = makeFakeCtx(this);
  }

  getContext() {
    return this.ctx;
  }

  toBlob(cb, type) {
    // The module frees the backing store once the blob exists, so the size
    // has to be captured here.
    this.exportedSize = { width: this.width, height: this.height };
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    cb(new Blob([bytes], { type: type || 'image/png' }));
  }
}

function makeFakeDocument() {
  const doc = {
    title: 'Inkpad',
    body: new FakeElement('body'),
    head: new FakeElement('head'),
    documentElement: new FakeElement('html'),
    created: [],
    createElement(tag) {
      const el = tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag);
      doc.created.push(el);
      return el;
    },
    getElementById(id) {
      const find = (root) => {
        for (const el of [root, ...root.descendants()]) {
          if (el.id === id) return el;
        }
        return null;
      };
      return find(doc.body) || find(doc.head) || find(doc.documentElement);
    },
  };
  return doc;
}

function makeFakeWindow() {
  const win = {
    printCalls: 0,
    listeners: new Map(),
    print() {
      win.printCalls += 1;
    },
    addEventListener(type, fn) {
      if (!win.listeners.has(type)) win.listeners.set(type, []);
      win.listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = win.listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type) {
      for (const fn of [...(win.listeners.get(type) || [])]) fn();
    },
  };
  return win;
}

// --- fake browser globals ----------------------------------------------------

const createdUrls = [];
const revokedUrls = [];

function installFakeBrowser() {
  globalThis.document = makeFakeDocument();
  globalThis.window = makeFakeWindow();
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:fake/${createdUrls.length}`;
    createdUrls.push(url);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => {
    revokedUrls.push(url);
  };
}

function uninstallFakeBrowser() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.URL.createObjectURL;
  delete globalThis.URL.revokeObjectURL;
}

// --- fixtures ----------------------------------------------------------------

function stroke(points, width = 4, extra = {}) {
  return {
    id: `s${Math.round(points[0]?.x ?? 0)}-${points.length}`,
    tool: 'pen',
    color: '#111111',
    width,
    opacity: 1,
    pointerType: 'pen',
    lineStyle: 'solid',
    pressureTaper: false,
    points: points.map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i })),
    ...extra,
  };
}

function page(strokes = [], layers = []) {
  return { id: 'page-1', name: 'Page 1', layers, strokes };
}

// --- run ---------------------------------------------------------------------

console.log('inkpad export test');

let mod;
try {
  mod = await import(pathToFileURL(MODULE).href);
} catch (err) {
  console.error('FAIL: importing src/export.js in Node threw');
  console.error(err);
  process.exit(1);
}
check('module imports in Node without throwing', Boolean(mod));

for (const name of [
  'pageToPngBlob',
  'downloadPageAsPng',
  'downloadNoteAsPng',
  'printNote',
  'pageBounds',
  'estimatePageSize',
]) {
  check(`exports ${name}()`, typeof mod[name] === 'function');
}

const { pageBounds, estimatePageSize, pageToPngBlob, downloadPageAsPng, downloadNoteAsPng, printNote } = mod;

// --- pageBounds --------------------------------------------------------------

const empty = pageBounds(page());
check('pageBounds of an empty page is the unit rect', 
  empty.minX === 0 && empty.minY === 0 && empty.maxX === 1 && empty.maxY === 1,
  JSON.stringify(empty));

const one = pageBounds(page([stroke([{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }])]));
check('pageBounds of one stroke covers its points plus half a width',
  one.minX === 8 && one.minY === 18 && one.maxX === 52 && one.maxY === 62,
  JSON.stringify(one));

const many = pageBounds(page([
  stroke([{ x: 10, y: 20 }, { x: 30, y: 40 }]),
  stroke([{ x: -5, y: 100 }, { x: 0, y: 120 }]),
]));
check('pageBounds of several strokes is their union',
  many.minX === -7 && many.minY === 18 && many.maxX === 32 && many.maxY === 122,
  JSON.stringify(many));

const dot = pageBounds(page([stroke([{ x: 5, y: 7 }])]));
check('pageBounds of a single-point stroke is the dot extent',
  dot.minX === 3 && dot.minY === 5 && dot.maxX === 7 && dot.maxY === 9,
  JSON.stringify(dot));

const degenerate = pageBounds(page([
  { id: 'empty', points: [], width: 4 },
  { id: 'nan', points: [{ x: NaN, y: 1 }, { x: 2, y: NaN }], width: 4 },
]));
check('pageBounds ignores degenerate strokes',
  degenerate.minX === 0 && degenerate.minY === 0 && degenerate.maxX === 1 && degenerate.maxY === 1,
  JSON.stringify(degenerate));

const withLayer = pageBounds(page([stroke([{ x: 10, y: 20 }])], [
  { id: 'l1', kind: 'image', name: 'a.png', url: '', img: null, naturalWidth: 0, naturalHeight: 0, loaded: false, rect: { x: 0, y: 0, w: 100, h: 200 } },
]));
check('pageBounds includes a layer that carries page geometry',
  withLayer.minX === 0 && withLayer.minY === 0 && withLayer.maxX === 100 && withLayer.maxY === 200,
  JSON.stringify(withLayer));

const layerNoGeometry = pageBounds(page([], [
  { id: 'l1', kind: 'image', name: 'a.png', url: '', img: null, naturalWidth: 0, naturalHeight: 0, loaded: false },
]));
check('pageBounds ignores a layer without geometry',
  layerNoGeometry.maxX === 1 && layerNoGeometry.maxY === 1,
  JSON.stringify(layerNoGeometry));

// --- estimatePageSize --------------------------------------------------------

const sizeEmpty = estimatePageSize(page());
check('estimatePageSize of an empty page is a blank A4 sheet',
  sizeEmpty.width === 794 && sizeEmpty.height === 1123,
  JSON.stringify(sizeEmpty));

const sizeOne = estimatePageSize(page([stroke([{ x: 10, y: 20 }, { x: 30, y: 40 }])]));
check('estimatePageSize reports the content extent',
  sizeOne.width === 24 && sizeOne.height === 24,
  JSON.stringify(sizeOne));

// --- canvas path -------------------------------------------------------------

installFakeBrowser();

try {
  const blob = await pageToPngBlob(page([stroke([{ x: 10, y: 10 }, { x: 30, y: 20 }, { x: 50, y: 40 }])]), { scale: 2 });
  check('pageToPngBlob returns a PNG blob', blob instanceof Blob && blob.type === 'image/png', String(blob && blob.type));

  const canvasEl = globalThis.document.created.find((el) => el.tagName === 'CANVAS');
  check('the export canvas is cropped to the content plus padding',
    canvasEl.exportedSize.width === 152 && canvasEl.exportedSize.height === 132,
    `${canvasEl.exportedSize.width}x${canvasEl.exportedSize.height}`);

  const ops = canvasEl.ctx.ops;
  check('the background is filled first', ops.some((o) => o[0] === 'fillRect' && o[1] === 0 && o[2] === 0 && o[3] === 152 && o[4] === 132));
  check('the ink is stroked', ops.some((o) => o[0] === 'stroke'));
  check('the ink is drawn in page space (no dpr in the transform)',
    ops.filter((o) => o[0] === 'setTransform').some((o) => o[1] === 2 && o[2] === 0 && o[3] === 0 && o[4] === 2));

  const blankBlob = await pageToPngBlob(page(), { scale: 2 });
  check('an empty page still produces a valid PNG', blankBlob instanceof Blob && blankBlob.type === 'image/png');
  const blankCanvas = globalThis.document.created.filter((el) => el.tagName === 'CANVAS').pop();
  check('an empty page exports as a blank A4 sheet',
    blankCanvas.exportedSize.width === 1588 && blankCanvas.exportedSize.height === 2246,
    `${blankCanvas.exportedSize.width}x${blankCanvas.exportedSize.height}`);

  const markerPage = page([
    stroke([{ x: 10, y: 10 }, { x: 40, y: 40 }], 18, { opacity: 0.5, tool: 'marker' }),
    stroke([{ x: 0, y: 0 }, { x: 20, y: 20 }]),
  ]);
  await pageToPngBlob(markerPage, { scale: 2 });
  // The export sheet is the one that carries the background fill; the
  // scratch sheet (the translucent strokes) is created after it.
  const markerCanvas = globalThis.document.created
    .filter((el) => el.tagName === 'CANVAS')
    .filter((el) => el.ctx.ops.some((o) => o[0] === 'fillRect'))
    .pop();
  check('a translucent stroke is composited on its own scratch sheet',
    markerCanvas.ctx.ops.some((o) => o[0] === 'drawImage'));

  const explicit = await pageToPngBlob(page([stroke([{ x: 10, y: 10 }])]), {
    scale: 1,
    bounds: { minX: 0, minY: 0, maxX: 50, maxY: 40 },
  });
  check('explicit bounds are used verbatim', explicit instanceof Blob);
  const explicitCanvas = globalThis.document.created.filter((el) => el.tagName === 'CANVAS').pop();
  check('explicit bounds set the export size',
    explicitCanvas.exportedSize.width === 50 && explicitCanvas.exportedSize.height === 40,
    `${explicitCanvas.exportedSize.width}x${explicitCanvas.exportedSize.height}`);

  // --- downloads -------------------------------------------------------------

  const dlName = await downloadPageAsPng(page([stroke([{ x: 1, y: 1 }])]), {});
  check('downloadPageAsPng names the file after the page', dlName === 'Page-1.png', dlName);
  const anchors = globalThis.document.created.filter((el) => el.tagName === 'A');
  check('downloadPageAsPng clicks a download anchor',
    anchors.length === 1 && anchors[0].clicked && anchors[0].download === 'Page-1.png');

  const note = {
    id: 'n1',
    title: 'Math 101',
    createdAt: 0,
    updatedAt: 0,
    pages: [page([stroke([{ x: 1, y: 1 }])]), page([stroke([{ x: 2, y: 2 }])])],
  };
  const names = await downloadNoteAsPng(note, {});
  check('downloadNoteAsPng names one file per page',
    names.length === 2 && names[0] === 'Math-101-p1.png' && names[1] === 'Math-101-p2.png',
    names.join(', '));

  // --- print -----------------------------------------------------------------

  const printPromise = printNote(note, {});
  check('printNote returns a promise', typeof printPromise.then === 'function');
  await printPromise;

  check('printNote opens the print dialog', globalThis.window.printCalls === 1, String(globalThis.window.printCalls));

  const root = globalThis.document.getElementById('inkpad-print-root');
  check('printNote builds a print container', Boolean(root));
  check('the print container holds one section per page',
    root.children.filter((el) => el.className === 'inkpad-print-page').length === 2);
  check('the print container holds a title',
    root.children.some((el) => el.className === 'inkpad-print-title' && el.textContent === 'Math 101'));
  check('every print page holds an image',
    root.children
      .filter((el) => el.className === 'inkpad-print-page')
      .every((el) => el.children.length === 1 && el.children[0].tagName === 'IMG'));

  const styleEl = globalThis.document.getElementById('inkpad-print-style');
  check('printNote injects a print stylesheet', Boolean(styleEl));
  check('the print stylesheet is only added once', globalThis.document.head.children.filter((el) => el.id === 'inkpad-print-style').length === 1);

  globalThis.window.dispatch('afterprint');
  check('afterprint tears the print container down', globalThis.document.getElementById('inkpad-print-root') === null);
  check('afterprint restores the document title', globalThis.document.title === 'Inkpad', globalThis.document.title);
  check('afterprint revokes the print object URLs', revokedUrls.length >= 2, String(revokedUrls.length));
} finally {
  uninstallFakeBrowser();
}

console.log(`ALL ${checks} CHECKS PASSED`);
process.exit(0);
