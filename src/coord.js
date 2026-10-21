// coord.js — the ONLY place screen<->page coordinate conversion happens.
//
// Coordinate system: one page-coordinate space. Screen (CSS pixel, relative to
// the canvas top-left) converts to page via the viewport { zoom, panX, panY }.
// devicePixelRatio is accounted for ONLY in applyTransform() (backing-store
// scaling) — nowhere else. Callers must never multiply by dpr themselves.
//
// Step 1: zoom = 1, pan = (0,0), so page == screen. Pan/zoom arrive in step 3
// by mutating the viewport object; no call-site changes needed.

export function createViewport() {
  return { zoom: 1, panX: 0, panY: 0, dpr: 1 };
}

export function screenToPage(sx, sy, viewport) {
  return {
    x: (sx - viewport.panX) / viewport.zoom,
    y: (sy - viewport.panY) / viewport.zoom,
  };
}

export function pageToScreen(px, py, viewport) {
  return {
    x: px * viewport.zoom + viewport.panX,
    y: py * viewport.zoom + viewport.panY,
  };
}

// Set the context transform so that drawing in PAGE coordinates lands in the
// right device pixels. Call before any page-space drawing.
export function applyTransform(ctx, viewport) {
  const s = viewport.dpr * viewport.zoom;
  ctx.setTransform(s, 0, 0, s, viewport.dpr * viewport.panX, viewport.dpr * viewport.panY);
}
