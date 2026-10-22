// inkpad-layout-test.mjs — Node test for src/layout.js.
//
// Run:  node inkpad-layout-test.mjs [path-to-repo]
//
// layout.js is the geometry of the scrollable notebook: pages stacked on a
// table in DOCUMENT space, while ink lives in PAGE-local space. It has no DOM
// dependency, so the maths (and the sheet painter, driven by a fake context)
// can be tested straight in Node.

import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? process.env.INKPAD_ROOT ?? 'C:\\AI Projects\\chatability';
const L = await import(pathToFileURL(`${root}\\src\\layout.js`).href);
const {
  DEFAULT_PAGE_W,
  DEFAULT_PAGE_H,
  PAGE_GAP,
  PAGE_MARGIN,
  PAGE_TEMPLATES,
  pageSize,
  pageOffsets,
  pageRect,
  docSize,
  resolvePageAt,
  visiblePages,
  clampPan,
  drawPageSheet,
} = L;

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

function page(extra = {}) {
  return { id: 'p', name: 'Page', layers: [], strokes: [], ...extra };
}

// A context that records what the sheet painter did. Every method used by
// drawPageSheet is present; properties are plain assignments.
function fakeCtx() {
  const calls = {
    fill: 0,
    clip: 0,
    strokeRect: [],
    moveTo: 0,
    lineTo: 0,
    arcs: 0,
    saves: 0,
    restores: 0,
  };
  return {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {
      calls.saves += 1;
    },
    restore() {
      calls.restores += 1;
    },
    beginPath() {},
    rect() {},
    fill() {
      calls.fill += 1;
    },
    clip() {
      calls.clip += 1;
    },
    strokeRect(x, y, w, h) {
      calls.strokeRect.push({ x, y, w, h });
    },
    moveTo() {
      calls.moveTo += 1;
    },
    lineTo() {
      calls.lineTo += 1;
    },
    stroke() {},
    arc() {
      calls.arcs += 1;
    },
  };
}

// --- constants --------------------------------------------------------------

check(DEFAULT_PAGE_W === 794, 'A4 page width is 794 CSS px');
check(DEFAULT_PAGE_H === 1123, 'A4 page height is 1123 CSS px');
check(PAGE_GAP > 0, 'pages are separated by a gap');
check(PAGE_MARGIN > 0, 'the document keeps a margin from the screen edge');
check(
  PAGE_TEMPLATES.join(',') === 'blank,lined,grid,dotted',
  'the four paper templates are declared',
);

// --- pageSize ---------------------------------------------------------------

check(
  pageSize(page()).w === DEFAULT_PAGE_W && pageSize(page()).h === DEFAULT_PAGE_H,
  'a page without its own size falls back to A4',
);
check(pageSize(page({ w: 612, h: 900 })).w === 612, 'a page can carry its own width');
check(pageSize(page({ w: 612, h: 900 })).h === 900, 'a page can carry its own height');
check(pageSize(page({ w: 0, h: -5 })).w === DEFAULT_PAGE_W, 'a zero width is ignored');
check(pageSize(null).h === DEFAULT_PAGE_H, 'pageSize(null) is A4');

// --- pageOffsets ------------------------------------------------------------

const stack = [page(), page({ w: 500, h: 500 }), page({ h: 200 })];
const offsets = pageOffsets(stack);
check(offsets.length === 3, 'one offset per page');
check(offsets[0] === 0, 'the first page starts at the document origin');
check(offsets[1] === DEFAULT_PAGE_H + PAGE_GAP, 'the second page starts after page one + gap');
check(offsets[2] === DEFAULT_PAGE_H + PAGE_GAP + 500 + PAGE_GAP, 'offsets accumulate custom heights');
check(pageOffsets([]).length === 0, 'an empty document has no offsets');
check(pageOffsets(null).length === 0, 'null pages are tolerated');

// --- pageRect ---------------------------------------------------------------

const r0 = pageRect(stack, 0);
check(r0.x === 0 && r0.y === 0, 'page 0 sits at the origin');
check(r0.w === DEFAULT_PAGE_W && r0.h === DEFAULT_PAGE_H, 'page 0 has its own size');
const r1 = pageRect(stack, 1);
check(r1.y === offsets[1] && r1.w === 500 && r1.h === 500, 'page 1 uses its own rect');
check(pageRect(stack, 3) === null, 'an out-of-range page has no rect');
check(pageRect(stack, -1) === null, 'a negative index has no rect');
check(pageRect([], 0) === null, 'an empty document has no page rect');

// --- docSize ----------------------------------------------------------------

const size = docSize(stack);
check(size.w === DEFAULT_PAGE_W, 'document width is the widest page');
check(size.h === offsets[2] + 200, 'document height reaches the bottom of the last page');
check(docSize([]).w === DEFAULT_PAGE_W, 'an empty document still has A4 width');
check(docSize([]).h === DEFAULT_PAGE_H, 'an empty document still has A4 height');

// --- resolvePageAt ----------------------------------------------------------

const hit0 = resolvePageAt(stack, 100, 200);
check(hit0 && hit0.index === 0, 'a point in page 0 resolves to page 0');
check(hit0 && hit0.x === 100 && hit0.y === 200, 'page 0 local coords equal document coords');
const hit1 = resolvePageAt(stack, 50, offsets[1] + 30);
check(hit1 && hit1.index === 1, 'a point in page 1 resolves to page 1');
check(hit1 && near(hit1.y, 30), 'page 1 local Y subtracts the page origin');
check(resolvePageAt(stack, 10, DEFAULT_PAGE_H + 5) === null, 'the gap between pages resolves to nothing');
check(resolvePageAt(stack, 700, offsets[1] + 10) === null, 'past a narrow page right edge is a miss');
check(resolvePageAt(stack, -1, 0) === null, 'left of the page is a miss');
check(resolvePageAt(stack, 0, 0).index === 0, 'the top-left corner belongs to page 0');
check(resolvePageAt([], 0, 0) === null, 'an empty document has no page under a point');

// --- visiblePages -----------------------------------------------------------

const vp = (zoom = 1, panX = 0, panY = 0) => ({ zoom, panX, panY, dpr: 1 });
let vis = visiblePages(stack, vp(), 800, 600);
check(vis.length === 1 && vis[0].index === 0, 'only page 0 is visible at the top of the document');
check(vis[0].rect.y === 0 && vis[0].rect.w === DEFAULT_PAGE_W, 'the visible entry carries the page rect');

vis = visiblePages(stack, vp(1, 0, -1100), 800, 600);
check(vis.length >= 1 && vis[0].index === 0, 'page 0 is still on screen just above page 1');
check(vis.some((v) => v.index === 1), 'page 1 appears when the viewport reaches it');

vis = visiblePages(stack, vp(1, 0, -offsets[2]), 800, 600);
check(vis.length === 1 && vis[0].index === 2, 'scrolling to the last page shows only it');

vis = visiblePages(stack, vp(10, 0, -offsets[1] * 10), 800, 600);
check(vis.length === 1 && vis[0].index === 1, 'zoomed in, culling still picks the right page');

vis = visiblePages([], vp(), 800, 600);
check(vis.length === 0, 'no pages means nothing to draw');

vis = visiblePages([page({ h: 1500 })], vp(1, 0, -1400), 800, 600);
check(vis.length === 1, 'a tall page stays visible while its bottom half is on screen');

// --- clampPan ---------------------------------------------------------------

const tall = { zoom: 1, panX: 500, panY: 500, dpr: 1 };
let moved = clampPan(tall, 800, 600, DEFAULT_PAGE_W, 3000);
check(moved === true, 'clampPan reports that it moved the viewport');
check(tall.panX === PAGE_MARGIN, 'the left edge of the document stops at the margin');
check(tall.panY === PAGE_MARGIN, 'the top of the document stops at the margin');

tall.panY = -100000;
clampPan(tall, 800, 600, DEFAULT_PAGE_W, 3000);
check(tall.panY === 600 - 3000 - PAGE_MARGIN, 'the bottom of the document stops at the margin');

const shortDoc = { zoom: 1, panX: -5000, panY: -5000, dpr: 1 };
clampPan(shortDoc, 800, 600, 700, 400);
check(shortDoc.panX === 50 && shortDoc.panY === 100, 'a short document is centred both ways');

const narrow = { zoom: 1, panX: 1000, panY: 500, dpr: 1 };
clampPan(narrow, 800, 600, 700, 3000);
check(narrow.panX === 50, 'a document narrower than the screen is centred horizontally');
check(narrow.panY === PAGE_MARGIN, 'its vertical position is still clamped');

const zoomed = { zoom: 2, panX: 0, panY: 0, dpr: 1 };
clampPan(zoomed, 800, 600, 794, 1123);
check(zoomed.panX === 0 && zoomed.panY === 0,
  'a valid zoomed position is left alone');

zoomed.panX = 5000;
clampPan(zoomed, 800, 600, 794, 1123);
check(zoomed.panX === PAGE_MARGIN, 'the clamp accounts for zoom when the document is wider than the screen');

const zoomedOut = { zoom: 0.5, panX: 0, panY: 0, dpr: 1 };
clampPan(zoomedOut, 800, 600, 794, 1123);
check(near(zoomedOut.panX, (800 - 397) / 2), 'a zoomed-out document is centred by its on-screen width');

const bad = clampPan(null, 800, 600, 794, 1123);
check(bad === false, 'clampPan ignores a missing viewport');
check(clampPan({ zoom: 1, panX: 0, panY: 0 }, 0, 0, 794, 1123) === false,
  'clampPan ignores a zero-sized viewport');

// --- drawPageSheet ----------------------------------------------------------

const rect = { x: 10, y: 20, w: 794, h: 1123 };
let c = fakeCtx();
drawPageSheet(c, rect, 'blank');
check(c.calls.fill === 1, 'a blank sheet fills its white page');
check(c.calls.clip === 1, 'the ruling is clipped to the sheet');
check(c.calls.moveTo === 0, 'a blank sheet has no ruling');
check(c.calls.strokeRect.length === 1, 'a sheet gets a border');
const border = c.calls.strokeRect[0];
check(near(border.x, 10.5) && near(border.y, 20.5), 'the border sits just inside the sheet origin');
check(near(border.w, 793) && near(border.h, 1122), 'the border covers the sheet');
check(c.calls.saves === c.calls.restores, 'drawPageSheet balances save/restore');

c = fakeCtx();
drawPageSheet(c, rect, 'lined');
check(c.calls.moveTo > 20, 'a lined page draws horizontal rules');
check(c.calls.moveTo === c.calls.lineTo, 'every rule is one line segment');
check(c.calls.arcs === 0, 'a lined page has no dots');
const linedRules = c.calls.moveTo;

c = fakeCtx();
drawPageSheet(c, rect, 'grid');
check(c.calls.moveTo === 35 + 24, 'a grid rules both ways at the ruling spacing');
check(c.calls.moveTo === c.calls.lineTo, 'grid rules are line segments');

c = fakeCtx();
drawPageSheet(c, rect, 'dotted');
check(c.calls.arcs > 0, 'a dotted page draws dots');
check(c.calls.arcs % 35 === 0, 'the dots form rows at the ruling spacing');
check(c.calls.fill === 1 + c.calls.arcs, 'each dot is filled once on top of the sheet');

c = fakeCtx();
drawPageSheet(c, rect, 'not-a-template');
check(c.calls.moveTo === 0, 'an unknown template falls back to blank');

c = fakeCtx();
drawPageSheet(c, { x: 0, y: 0, w: 0, h: 0 }, 'lined');
check(c.calls.fill === 0 && c.calls.strokeRect.length === 0, 'a zero-sized sheet draws nothing');

c = fakeCtx();
drawPageSheet(c, rect, 'lined', { lineWidth: 0.5 });
check(near(c.calls.strokeRect[0].w, 793.5), 'the border width follows the lineWidth option');

c = fakeCtx();
drawPageSheet(c, null, 'lined');
check(c.calls.fill === 0, 'drawPageSheet tolerates a missing rect');

console.log(`\nALL ${checks} CHECKS PASSED`);
