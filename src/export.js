// export.js — PNG export and print-to-PDF for a note.
//
// WHY OFF-SCREEN: the live canvas is a screen-space surface clipped by the
// window, so exporting it as it is gives a screenshot of the viewport, not a
// picture of the document. The export therefore renders the page AGAIN, on
// its own canvas, in PAGE coordinates, with the same draw call the app makes
// (renderStroke). The file is a real picture of the page, independent of
// zoom, pan and window size.
//
// WHAT IS RENDERED, in order: the page background, the imported image LAYERS
// (UNDER the ink, exactly like canvas.js drawLayers), then the strokes.
//
// CROPPING: an export is cropped to the CONTENT of the page (the ink's
// bounding box, plus any layer that carries page geometry) with a small
// margin, so a page with one line does not become a huge blank sheet. An
// explicit `bounds` replaces the computed region entirely.
//
// TRANSLUCENT INK: a marker stroke is drawn with 'destination-over', which
// puts it BEHIND everything already on the canvas — including the opaque
// background we just filled, where it would simply disappear. The marker
// strokes are therefore drawn onto their own transparent scratch sheet
// (where 'destination-over' only re-orders them against each other, so they
// do not stack their alpha) and that sheet is composited over the
// background and the layers. The opaque ink goes on top, last.
//
// PRINT: printNote renders every page to a PNG and hands the images to the
// browser's print dialog as one hidden <section> per page. The print styles
// are injected as a <style> element with a fixed id (never inline on the
// elements), so the style is added only once. The container, the object URLs
// and the document title are restored afterwards, and again on 'afterprint'.
//
// The module must stay importable outside a browser (the test imports it in
// Node), so every DOM access happens inside a function and is guarded.

import { isTranslucent, renderStroke } from './strokes.js';
import { isShapeStroke, renderShape } from './shapes.js';
import { isTextObject, renderText } from './text.js';
import { containFit } from './pages.js';

// Shapes are strokes, but they are drawn as a hard-edged path: the ink
// renderer's midpoint smoothing would round a rectangle's corners.
function drawStroke(ctx, stroke) {
  if (isTextObject(stroke)) renderText(ctx, stroke);
  else if (isShapeStroke(stroke)) renderShape(ctx, stroke);
  else renderStroke(ctx, stroke);
}

// Page units of breathing room kept around the content of an export.
const EXPORT_PADDING = 16;
// Device pixels per page unit. 2 keeps the ink crisp without huge files.
const DEFAULT_SCALE = 2;
// The print sheet is a raster too, so it gets the same treatment.
const PRINT_SCALE = 2;
// A4 portrait at 96 CSS px per inch: the size of a blank sheet.
const DEFAULT_PAGE_WIDTH = 794;
const DEFAULT_PAGE_HEIGHT = 1123;
// Browsers refuse canvases beyond roughly 16k pixels per edge.
const MAX_CANVAS_EDGE = 16384;
const PRINT_STYLE_ID = 'inkpad-print-style';
const PRINT_ROOT_ID = 'inkpad-print-root';
// Revoking an object URL in the same tick as the click can cancel the
// download before the browser read the blob, so it is revoked a moment later.
const URL_REVOKE_MS = 4000;
// Safety net for browsers that never fire 'afterprint'.
const PRINT_CLEANUP_MS = 120000;

// --- environment ------------------------------------------------------------

function hasDocument() {
  return typeof document !== 'undefined' && document !== null;
}

function requireBrowser(what) {
  if (!hasDocument()) throw new Error(`[inkpad] ${what} needs a browser canvas.`);
}

// --- geometry ---------------------------------------------------------------

// A layer only has page geometry once it carries an explicit rectangle.
// The v1 layers are screen-fitted, so they have none and simply fill the
// exported region.
function layerRect(layer) {
  if (!layer) return null;
  const r = layer.rect;
  if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0) {
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  const flat = [layer.x, layer.y, layer.width, layer.height];
  if (flat.every(Number.isFinite) && layer.width > 0 && layer.height > 0) {
    return { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
  }
  return null;
}

function layerIsReady(layer) {
  if (!layer || !layer.img) return false;
  // Some callers build a layer by hand and never set `loaded`.
  return Boolean(layer.loaded || (layer.img.complete && layer.img.naturalWidth > 0));
}

// A running bounding box.
function emptyBox() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function growBox(box, x, y) {
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
}

// The bounding box of everything on the page, in page units. Null when the
// page is empty.
function contentBounds(page) {
  const box = emptyBox();
  for (const stroke of Array.isArray(page?.strokes) ? page.strokes : []) {
    // The ink is wider than its centre line, so the visible extent reaches
    // half a stroke width past the outermost point.
    const half = Number.isFinite(stroke?.width) ? stroke.width / 2 : 0;
    let any = false;
    for (const p of Array.isArray(stroke?.points) ? stroke.points : []) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      growBox(box, p.x - half, p.y - half);
      growBox(box, p.x + half, p.y + half);
      any = true;
    }
    if (!any) continue; // degenerate: nothing drawable
  }
  for (const layer of Array.isArray(page?.layers) ? page.layers : []) {
    const rect = layerRect(layer);
    if (!rect) continue;
    growBox(box, rect.x, rect.y);
    growBox(box, rect.x + rect.w, rect.y + rect.h);
  }
  if (box.minX === Infinity) return null;
  return { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
}

// The bounding box of the page content. An empty page reports the unit
// rectangle at the origin.
export function pageBounds(page) {
  return contentBounds(page) ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

// The size of the page in page units: the extent of its content, or a blank
// sheet when the page is empty.
export function estimatePageSize(page) {
  const b = contentBounds(page);
  if (!b) return { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
  return { width: b.maxX - b.minX, height: b.maxY - b.minY };
}

// The region of the page an export covers, in page units. An explicit
// bounds object is used verbatim — the caller owns the framing.
function exportRegion(page, bounds) {
  const given = bounds && [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite);
  if (given) return { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY };
  const b = contentBounds(page);
  if (!b) return { minX: 0, minY: 0, maxX: DEFAULT_PAGE_WIDTH, maxY: DEFAULT_PAGE_HEIGHT };
  return {
    minX: b.minX - EXPORT_PADDING,
    minY: b.minY - EXPORT_PADDING,
    maxX: b.maxX + EXPORT_PADDING,
    maxY: b.maxY + EXPORT_PADDING,
  };
}

// --- rendering --------------------------------------------------------------

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

// The imported files, drawn UNDER the ink. A layer with page geometry is
// drawn into that rectangle; a layer without one fills the exported region,
// which is what the screen does with the visible canvas.
function drawLayers(ctx, page, region) {
  const regionW = region.maxX - region.minX;
  const regionH = region.maxY - region.minY;
  for (const layer of Array.isArray(page?.layers) ? page.layers : []) {
    if (!layerIsReady(layer)) continue;
    const srcW = layer.naturalWidth || layer.img.naturalWidth || 0;
    const srcH = layer.naturalHeight || layer.img.naturalHeight || 0;
    const dst = layerRect(layer) ?? { x: region.minX, y: region.minY, w: regionW, h: regionH };
    const box = containFit(srcW, srcH, dst.x, dst.y, dst.w, dst.h);
    ctx.drawImage(layer.img, box.x, box.y, box.w, box.h);
  }
}

// Render the page onto its own canvas. Returns the canvas.
function renderPage(page, { scale = DEFAULT_SCALE, background = '#ffffff', bounds = null } = {}) {
  requireBrowser('PNG export');
  const region = exportRegion(page, bounds);
  const regionW = Math.max(1e-6, region.maxX - region.minX);
  const regionH = Math.max(1e-6, region.maxY - region.minY);

  let s = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SCALE;
  // Shrink rather than fail when the region is enormous.
  if (regionW * s > MAX_CANVAS_EDGE || regionH * s > MAX_CANVAS_EDGE) s = Math.min(s, MAX_CANVAS_EDGE / Math.max(regionW, regionH));

  const width = Math.max(1, Math.ceil(regionW * s));
  const height = Math.max(1, Math.ceil(regionH * s));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[inkpad] could not get a 2D context for the export canvas.');

  // (a) the page background
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // Page coordinates -> device pixels of the export canvas.
  const tx = -region.minX * s;
  const ty = -region.minY * s;
  const toPage = () => ctx.setTransform(s, 0, 0, s, tx, ty);
  toPage();

  // (b) the layers, under the ink
  drawLayers(ctx, page, region);

  const strokes = Array.isArray(page?.strokes) ? page.strokes : [];
  const translucent = strokes.filter((st) => isTranslucent(st));
  const opaque = strokes.filter((st) => !isTranslucent(st));

  // (c1) the marker strokes, on a transparent scratch sheet
  if (translucent.length > 0) {
    const scratch = makeCanvas(width, height);
    const sctx = scratch.getContext('2d');
    sctx.setTransform(s, 0, 0, s, tx, ty);
    for (const st of translucent) drawStroke(sctx, st);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scratch, 0, 0);
  }

  // (c2) the opaque ink, on top of everything
  toPage();
  for (const st of opaque) drawStroke(ctx, st);

  return canvas;
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') return reject(new Error('[inkpad] this canvas cannot be exported.'));
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('[inkpad] the export canvas produced no image.'));
    }, type);
  });
}

// Render a page to a PNG blob. Resolves with a Blob (type image/png).
export async function pageToPngBlob(page, { scale = DEFAULT_SCALE, background = '#ffffff', bounds = null } = {}) {
  const canvas = renderPage(page, { scale, background, bounds });
  try {
    return await canvasToBlob(canvas);
  } finally {
    canvas.width = 0; // release the backing store as soon as the bitmap exists
    canvas.height = 0;
  }
}

// A PNG of part of the page, as a data URL. This is how a selection (or the
// whole page) is sent to an AI provider that can read images.
export async function pageRegionToDataUrl(page, { bounds = null, scale = 1, background = '#ffffff' } = {}) {
  const blob = await pageToPngBlob(page, { scale, background, bounds });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('[inkpad] this browser cannot read a blob as a data URL.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// --- downloads --------------------------------------------------------------

// A filename-safe version of a title: spaces become dashes and the
// characters that are illegal on Windows are dropped.
function slug(text) {
  return String(text ?? '').trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/^[.-]+|[.-]+$/g, '');
}

function triggerDownload(blob, filename) {
  requireBrowser('Downloading a PNG');
  if (typeof URL?.createObjectURL !== 'function') throw new Error('[inkpad] this browser cannot create object URLs.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  if (document.body) document.body.appendChild(a);
  a.click();
  if (typeof a.remove === 'function') a.remove();
  setTimeout(() => URL.revokeObjectURL(url), URL_REVOKE_MS);
}

// Download one page as a PNG. Resolves with the filename used.
export async function downloadPageAsPng(page, { scale = DEFAULT_SCALE, filename } = {}) {
  const blob = await pageToPngBlob(page, { scale });
  const name = filename || `${slug(page?.name) || 'page'}.png`;
  triggerDownload(blob, name);
  return name;
}

// Download every page of a note as its own PNG, named "<title>-p1.png",
// "<title>-p2.png" and so on. Resolves with the list of filenames.
export async function downloadNoteAsPng(note, { scale = DEFAULT_SCALE } = {}) {
  const pages = Array.isArray(note?.pages) ? note.pages : [];
  const base = slug(note?.title) || 'note';
  const names = [];
  for (let i = 0; i < pages.length; i++) {
    const name = `${base}-p${i + 1}.png`;
    await downloadPageAsPng(pages[i], { scale, filename: name });
    names.push(name);
  }
  return names;
}

// --- printing ---------------------------------------------------------------

const PRINT_CSS = `
#${PRINT_ROOT_ID} { display: none; }
@media print {
  html, body { background: #fff !important; }
  body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  #${PRINT_ROOT_ID} { display: block !important; }
  #${PRINT_ROOT_ID} .inkpad-print-title { font: 600 16px/1.3 -apple-system, system-ui, sans-serif; color: #111; margin: 0 0 12px; }
  #${PRINT_ROOT_ID} .inkpad-print-page { break-after: page; page-break-after: always; }
  #${PRINT_ROOT_ID} .inkpad-print-page:last-child { break-after: auto; page-break-after: auto; }
  #${PRINT_ROOT_ID} img { display: block; width: 100%; height: auto; }
}
`;

function ensurePrintStyle() {
  if (!hasDocument()) return null;
  const existing = document.getElementById(PRINT_STYLE_ID);
  if (existing) return existing;
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = PRINT_CSS;
  (document.head || document.documentElement)?.appendChild(style);
  return style;
}

function removePrintRoot() {
  const root = hasDocument() ? document.getElementById(PRINT_ROOT_ID) : null;
  if (root && typeof root.remove === 'function') root.remove();
}

async function runPrint(note, { title } = {}) {
  requireBrowser('Printing');
  const pages = Array.isArray(note?.pages) ? note.pages : [];
  const heading = title || note?.title || 'Untitled';

  // Every page image must exist BEFORE the print dialog opens, otherwise
  // the preview shows empty sheets.
  const blobs = await Promise.all(pages.map((p) => pageToPngBlob(p, { scale: PRINT_SCALE })));

  removePrintRoot();
  ensurePrintStyle();

  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');

  const head = document.createElement('h1');
  head.className = 'inkpad-print-title';
  head.textContent = heading;
  root.appendChild(head);

  const urls = [];
  blobs.forEach((blob, i) => {
    const section = document.createElement('section');
    section.className = 'inkpad-print-page';
    const img = document.createElement('img');
    const url = URL.createObjectURL(blob);
    urls.push(url);
    img.src = url;
    img.alt = `Page ${i + 1}`;
    section.appendChild(img);
    root.appendChild(section);
  });

  const parent = document.body || document.documentElement;
  if (parent) parent.appendChild(root);

  const prevTitle = document.title;
  document.title = heading;

  const win = typeof window !== 'undefined' ? window : null;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    for (const url of urls) URL.revokeObjectURL(url);
    removePrintRoot();
    document.title = prevTitle;
    if (typeof win?.removeEventListener === 'function') win.removeEventListener('afterprint', cleanup);
  };

  if (typeof win?.addEventListener === 'function') win.addEventListener('afterprint', cleanup);
  if (typeof win?.print === 'function') win.print();
  // Safety net: some browsers never fire 'afterprint'.
  setTimeout(cleanup, PRINT_CLEANUP_MS);
}

// Open the browser's print dialog with one sheet per page of the note.
// The returned promise resolves once the print view is up; it rejects if the
// page images could not be rendered.
export function printNote(note, { title } = {}) {
  return runPrint(note, { title });
}
