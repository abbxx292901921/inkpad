// pages.js — the document / page model.
//
// A NOTE owns an ordered list of PAGES. A page owns two layers:
//
//   layers   background objects (an imported PDF page, a photo of your
//            homework). Drawn BEHIND the ink.
//   strokes  the ink, in z-order.
//
// The layer order is layers -> strokes. That is the whole point: when you
// import a PDF or a photo of your maths homework, you write ON TOP of it,
// exactly like Notability. The imported file is the page; your ink is the
// annotation.
//
// Pages are plain data. Rendering lives in src/canvas.js; persistence
// (IndexedDB) comes in a later phase.

let nextId = 1;

function makeId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through
    }
  }
  nextId += 1;
  return `${prefix}-${Date.now()}-${nextId}`;
}

export function createPage({ name = 'Page 1' } = {}) {
  return {
    id: makeId('page'),
    name,
    layers: [],
    strokes: [],
  };
}

export function createNote({ title = 'Untitled', folderId = null } = {}) {
  const now = Date.now();
  return {
    id: makeId('note'),
    title,
    folderId,
    createdAt: now,
    updatedAt: now,
    pages: [createPage()],
  };
}

// --- layers ----------------------------------------------------------------

// An imported image (a photo of your homework, a screenshot, a diagram).
// The blob is kept so it can be written to IndexedDB later; `url` is the
// object URL used to display it now.
export function createImageLayer({ blob, url, name = 'image' }) {
  const layer = {
    id: makeId('layer'),
    kind: 'image',
    name,
    blob: blob ?? null,
    url,
    img: null,
    naturalWidth: 0,
    naturalHeight: 0,
    loaded: false,
  };
  const img = new Image();
  img.decoding = 'async';
  layer.img = img;
  img.addEventListener('load', () => {
    layer.naturalWidth = img.naturalWidth;
    layer.naturalHeight = img.naturalHeight;
    layer.loaded = true;
    if (layer.onLoad) layer.onLoad(layer);
  });
  img.addEventListener('error', () => {
    layer.failed = true;
    if (layer.onLoad) layer.onLoad(layer);
  });
  img.src = url;
  return layer;
}

// A rasterised PDF page. Same contract as an image layer, but the pixels
// come from pdf.js once it is wired up.
export function createPdfLayer({ name = 'PDF', pageNumber = 1, width = 0, height = 0 }) {
  return {
    id: makeId('layer'),
    kind: 'pdf',
    name,
    pageNumber,
    width,
    height,
    img: null,
    loaded: false,
  };
}

// --- geometry --------------------------------------------------------------

// Contain-fit a source rectangle into a destination rectangle.
// Returns the destination rect actually used.
export function containFit(srcW, srcH, dstX, dstY, dstW, dstH) {
  if (!srcW || !srcH || !dstW || !dstH) {
    return { x: dstX, y: dstY, w: dstW, h: dstH };
  }
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: dstX + (dstW - w) / 2, y: dstY + (dstH - h) / 2, w, h };
}

// --- page operations -------------------------------------------------------

export function addLayer(page, layer) {
  page.layers.push(layer);
  return layer;
}

export function removeLayer(page, layerId) {
  const i = page.layers.findIndex((l) => l.id === layerId);
  if (i < 0) return null;
  const [removed] = page.layers.splice(i, 1);
  if (removed.url) URL.revokeObjectURL(removed.url);
  return removed;
}

export function pageHasContent(page) {
  return page.strokes.length > 0 || page.layers.length > 0;
}
