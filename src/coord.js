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

// --- pan & zoom ------------------------------------------------------------
// The viewport is mutated in place; every helper here is the ONLY place that
// knows the relationship between zoom, pan and the page.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

export function clampZoom(z) {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

// Zoom by `factor` keeping the page point under the screen point (sx, sy)
// exactly where it is.
export function zoomAt(viewport, sx, sy, factor) {
  const z0 = viewport.zoom;
  const z1 = clampZoom(z0 * factor);
  if (z1 === z0) return false;
  const px = (sx - viewport.panX) / z0;
  const py = (sy - viewport.panY) / z0;
  viewport.zoom = z1;
  viewport.panX = sx - px * z1;
  viewport.panY = sy - py * z1;
  return true;
}

// Pan by a screen-space delta (positive dx moves the content right).
export function panBy(viewport, dx, dy) {
  viewport.panX += dx;
  viewport.panY += dy;
}

// A two-finger gesture: the fingers may pinch (the distance changes) AND
// move (the midpoint translates) at the same time.
//
//   from = { midX, midY, dist, zoom, panX, panY }  the gesture baseline
//   to   = { midX, midY, dist }                    where the fingers are now
//
// The page point under the baseline midpoint stays under the new midpoint.
//
// The baseline carries the zoom and pan from the moment the gesture started:
// the transform must be computed from THERE, not from the current viewport,
// or every pointermove would multiply the zoom again and the gesture would
// run away to the zoom limit.
export function applyPinch(viewport, from, to) {
  const z0 = from.zoom;
  const panX0 = from.panX;
  const panY0 = from.panY;
  const scale = from.dist > 1 ? to.dist / from.dist : 1;
  const z1 = clampZoom(z0 * scale);
  // Use the CLAMPED ratio so the anchor stays correct at the zoom limits.
  const eff = z1 / z0;
  viewport.zoom = z1;
  viewport.panX = to.midX - (from.midX - panX0) * eff;
  viewport.panY = to.midY - (from.midY - panY0) * eff;
}

export function resetViewport(viewport) {
  viewport.zoom = 1;
  viewport.panX = 0;
  viewport.panY = 0;
}
