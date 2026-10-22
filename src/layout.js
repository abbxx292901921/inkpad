// layout.js — the geometry of the document: pages on a long table.
//
// WHY THIS MODULE EXISTS: a note is an ORDERED LIST OF PAGES, and the editor
// scrolls through them as one continuous document (the Notability model).
// Page coordinates are LOCAL to their page — a stroke at (10, 20) is 10pt
// from the left edge of ITS page — so moving a page or inserting one never
// rewrites ink. This module is the ONLY place that knows how the pages are
// stacked in document space:
//
//     page 0 top  = 0
//     page 0 bottom = h0
//     page 1 top  = h0 + PAGE_GAP
//     ...
//
// Document space is what the viewport pans and zooms (src/coord.js). It is
// DOM-free and importable in Node, so the layout suite can test the maths
// without a browser.
//
// THE SHEET IS DRAWN HERE TOO: canvas.js paints it on the paper canvas and
// export.js can reuse the same routine, so a page never looks different in
// the editor and in a PNG.

// A4 portrait at 96 CSS px per inch: 210mm x 297mm.
export const DEFAULT_PAGE_W = 794;
export const DEFAULT_PAGE_H = 1123;
// The table between two sheets. Big enough to read as "separate pages",
// small enough that a scroll does not feel like a gap.
export const PAGE_GAP = 28;
// Breathing room kept between the document and the edge of the screen.
export const PAGE_MARGIN = 24;
// Ruling: 32pt is the classic college-rule spacing at this page width.
export const RULING_STEP = 32;

export const PAGE_TEMPLATES = ['blank', 'lined', 'grid', 'dotted'];

const RULING_COLOR = '#e8ecf2';
const DOT_COLOR = '#d9dee6';
const BORDER_COLOR = 'rgba(15, 23, 42, 0.12)';

// A page's own size. Imported PDF pages carry their own w/h; everything else
// falls back to A4, so old notes (which have neither) still render.
export function pageSize(page) {
  const w = Number.isFinite(page?.w) && page.w > 0 ? page.w : DEFAULT_PAGE_W;
  const h = Number.isFinite(page?.h) && page.h > 0 ? page.h : DEFAULT_PAGE_H;
  return { w, h };
}

// The document-space Y of every page top. One pass, no allocation per rect.
export function pageOffsets(pages) {
  const offsets = [];
  let y = 0;
  for (const page of pages ?? []) {
    offsets.push(y);
    y += pageSize(page).h + PAGE_GAP;
  }
  return offsets;
}

// A page's rectangle IN DOCUMENT SPACE. Pages are left-aligned at x = 0 and
// stacked downwards; a narrower page (a square PDF page) simply leaves the
// table visible to its right.
export function pageRect(pages, index) {
  if (!pages || index < 0 || index >= pages.length) return null;
  const offsets = pageOffsets(pages);
  const { w, h } = pageSize(pages[index]);
  return { x: 0, y: offsets[index], w, h };
}

// The size of the whole document, for scroll clamping and the scrollbar.
export function docSize(pages) {
  const list = pages ?? [];
  if (list.length === 0) return { w: DEFAULT_PAGE_W, h: DEFAULT_PAGE_H };
  let w = 0;
  let h = 0;
  const offsets = pageOffsets(list);
  for (let i = 0; i < list.length; i++) {
    const size = pageSize(list[i]);
    if (size.w > w) w = size.w;
    h = offsets[i] + size.h;
  }
  return { w, h };
}

// Which page is under a DOCUMENT point, and where that is LOCALLY.
// The gaps between pages and the table around them return null.
//
// Why local: the stroke tools, the eraser, the lasso and the text box all
// work in page coords, so the gesture layer subtracts the page origin once
// (see canvas.js) and nothing downstream changes.
export function resolvePageAt(pages, docX, docY) {
  if (!pages) return null;
  const offsets = pageOffsets(pages);
  for (let i = 0; i < pages.length; i++) {
    const { w, h } = pageSize(pages[i]);
    const top = offsets[i];
    if (docX >= 0 && docX <= w && docY >= top && docY <= top + h) {
      return { index: i, x: docX, y: docY - top };
    }
  }
  return null;
}

// The pages that intersect the viewport, in document coordinates:
//   [{ page, index, rect }]
// Only these are drawn, so a 200-page PDF does not cost 200 sheet fills per
// pointermove.
export function visiblePages(pages, viewport, viewW, viewH) {
  const list = pages ?? [];
  const zoom = viewport?.zoom > 0 ? viewport.zoom : 1;
  const left = -(viewport?.panX ?? 0) / zoom;
  const top = -(viewport?.panY ?? 0) / zoom;
  const right = left + viewW / zoom;
  const bottom = top + viewH / zoom;
  // One screen pixel of slack keeps a page that is exactly at the edge from
  // flickering in and out while scrolling.
  const pad = 1 / zoom;
  const out = [];
  const offsets = pageOffsets(list);
  for (let i = 0; i < list.length; i++) {
    const { w, h } = pageSize(list[i]);
    const pageTop = offsets[i];
    const rect = { x: 0, y: pageTop, w, h };
    if (rect.y > bottom + pad) break; // pages are sorted; nothing below fits
    if (rect.y + rect.h < top - pad) continue;
    if (rect.x > right + pad || rect.x + rect.w < left - pad) continue;
    out.push({ page: list[i], index: i, rect });
  }
  return out;
}

// Keep the document reachable: never let the user pan the sheet completely
// off the screen, and centre it when it is smaller than the viewport.
//
// Returns true when it had to move the viewport, so callers can skip a
// repaint if they care (the editor always repaints anyway).
export function clampPan(viewport, viewW, viewH, docW, docH, margin = PAGE_MARGIN) {
  if (!viewport || !(viewW > 0) || !(viewH > 0)) return false;
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const width = Math.max(1, docW) * zoom;
  const height = Math.max(1, docH) * zoom;
  const beforeX = viewport.panX;
  const beforeY = viewport.panY;

  if (width <= viewW - margin * 2) {
    // Smaller than the screen: centre it, so a zoomed-out page sits in the
    // middle instead of drifting against an edge.
    viewport.panX = (viewW - width) / 2;
  } else {
    viewport.panX = Math.min(margin, Math.max(viewW - width - margin, viewport.panX));
  }

  if (height <= viewH - margin * 2) {
    viewport.panY = (viewH - height) / 2;
  } else {
    viewport.panY = Math.min(margin, Math.max(viewH - height - margin, viewport.panY));
  }

  return viewport.panX !== beforeX || viewport.panY !== beforeY;
}

// Draw one sheet: the white page, its paper template, and a hairline border.
//
// The caller has ALREADY applied the page/document transform, so everything
// here is in page units. `lineWidth` lets the editor keep the border one
// DEVICE pixel at any zoom (pass 1 / zoom); the default is one page unit.
//
// The caller may set a shadow before calling; it applies to the sheet fill
// only, never to the ruling or the border, because the shadow is reset as
// soon as the white rectangle is down.
export function drawPageSheet(ctx, rect, template = 'blank', { lineWidth = 1 } = {}) {
  if (!ctx || !rect) return;
  const { x, y, w, h } = rect;
  if (!(w > 0) || !(h > 0)) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  // The page shadow must not smear the ruling.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Clip the ruling to the sheet: a grid line must not leak into the table.
  ctx.clip();

  const kind = PAGE_TEMPLATES.includes(template) ? template : 'blank';
  if (kind === 'lined') {
    ctx.strokeStyle = RULING_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const first = 96;
    for (let ly = first; ly < h - 40; ly += RULING_STEP) {
      ctx.moveTo(0, y + ly);
      ctx.lineTo(w, y + ly);
    }
    ctx.stroke();
  } else if (kind === 'grid') {
    ctx.strokeStyle = RULING_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ly = RULING_STEP; ly < h; ly += RULING_STEP) {
      ctx.moveTo(0, y + ly);
      ctx.lineTo(w, y + ly);
    }
    for (let lx = RULING_STEP; lx < w; lx += RULING_STEP) {
      ctx.moveTo(x + lx, y);
      ctx.lineTo(x + lx, y + h);
    }
    ctx.stroke();
  } else if (kind === 'dotted') {
    ctx.fillStyle = DOT_COLOR;
    // A dot is 1.6 page units; at 8x zoom it stays a dot rather than a blob.
    const r = 0.8;
    for (let ly = RULING_STEP; ly < h; ly += RULING_STEP) {
      for (let lx = RULING_STEP; lx < w; lx += RULING_STEP) {
        ctx.beginPath();
        ctx.arc(x + lx, y + ly, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // Border last, unclipped by the ruling path, and always crisp.
  ctx.save();
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = Math.max(0.5, lineWidth);
  ctx.strokeRect(x + lineWidth / 2, y + lineWidth / 2, w - lineWidth, h - lineWidth);
  ctx.restore();
}
