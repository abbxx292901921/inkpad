// ui/ruler.js — the Notability-style ruler.
//
// Notability overlays a ruler on the page: a horizontal band across the top
// and a vertical band down the left, both numbered in PAGE units so they
// scroll and zoom with the ink. The ticks live on a canvas (a DOM node per
// tick would be hundreds of nodes) and every position comes from coord.js —
// this module never does its own screen<->page arithmetic.
//
// UNITS: 1 page unit = 1 CSS pixel at zoom 1. A short tick every 10 units, a
// longer one every 50, and a labelled one every 100. A label counts hundreds
// of units from the ruler's zero (the page origin by default), which is what
// the reference shows: `5 4 3 2 1 | 1 2 3 4 5`, the zero itself unnumbered.
//
// The whole layer is pointer-events: none so the user can still draw through
// it. getHitInfo() exposes the band geometry so the app can later implement
// "capture the pen against the ruler edge".
//
// Nothing here touches `document` at import time, so the module is import
// safe and the pure helpers can be tested in Node.

import { pageToScreen, screenToPage } from '../coord.js';
import { el } from './popover.js';

// Band thickness in CSS px.
const RULER_SIZE = 28;
// Tick steps, in page units.
const MINOR_STEP = 10;
const MEDIUM_STEP = 50;
const MAJOR_STEP = 100;
// A label counts this many page units.
const LABEL_UNIT = 100;
// Never draw ticks closer together than this on screen.
const MIN_TICK_PX = 5;

// theme.css is owned by another agent, so the ruler styles ship in their own
// file and are linked in at runtime. No build step, no import side effects.
// ui/rotation-dial.js shares this file, hence the shared injector.
//
// onReady() fires once the stylesheet is in: the band sizes come from the CSS,
// so a canvas measured before the stylesheet lands would be the wrong size.
export function injectRulerStyles(onReady) {
  if (typeof document === 'undefined') return;
  let link = document.getElementById('ruler-css');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./ruler.css', import.meta.url).href;
    link.id = 'ruler-css';
    link.addEventListener('load', () => onReady?.());
    link.addEventListener('error', () => onReady?.());
    document.head.appendChild(link);
    return;
  }
  if (link.sheet) onReady?.();
  else link.addEventListener('load', () => onReady?.());
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

// The short-tick step grows when the page is zoomed far out, so the ticks
// never collapse into a grey smear. At zoom 1 it is the plain 10 units.
function minorStepFor(zoom) {
  const z = Math.abs(zoom) || 1;
  for (const step of [MINOR_STEP, 20, 50]) {
    if (step * z >= MIN_TICK_PX) return step;
  }
  return 50;
}

// The label of a tick: hundreds of page units from the ruler's zero. The zero
// is unnumbered, like the reference. A trailing ".0" is dropped.
export function formatTickLabel(offsetValue) {
  if (!Number.isFinite(offsetValue) || offsetValue === 0) return null;
  const units = Math.abs(offsetValue) / LABEL_UNIT;
  const rounded = Math.round(units * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Every tick that falls inside a ruler band of `length` CSS px.
//
//   viewport  the live viewport { zoom, panX, panY, dpr }
//   axis      'h' (horizontal band) or 'v' (vertical band)
//   length    the band's length along its axis, in CSS px
//   origin    the ruler's zero on that axis, in page units (default 0 = the
//             page origin)
//
// Returns { pageValue, screenPos, major, medium, label } per tick:
//   pageValue  the true page coordinate of the tick
//   screenPos  where it lands, in the ruler's own coordinate system
//   major      a labelled tick (every 100 units)
//   medium     a half-length tick (every 50 units)
//   label      the text to draw, or null (the zero is unnumbered)
export function tickPositions(viewport, axis, length, origin = 0) {
  const vp = viewport ?? { zoom: 1, panX: 0, panY: 0 };
  const zoom = vp.zoom || 1;
  const vertical = axis === 'v';

  // The visible page range along the axis, via coord.js only.
  const a = vertical ? screenToPage(0, 0, vp).y : screenToPage(0, 0, vp).x;
  const b = vertical ? screenToPage(0, length, vp).y : screenToPage(length, 0, vp).x;
  const lo = Math.min(a, b) - origin;
  const hi = Math.max(a, b) - origin;
  const step = minorStepFor(zoom);

  // Collect the three tick levels and keep the longest match for a page value
  // that falls on more than one (e.g. 100 is minor, medium AND major).
  const found = new Map();
  const levels = [[step, 'minor'], [MEDIUM_STEP, 'medium'], [MAJOR_STEP, 'major']];
  for (const [level, kind] of levels) {
    for (let i = Math.ceil(lo / level); i <= Math.floor(hi / level); i += 1) {
      const offsetValue = i * level;
      const prev = found.get(offsetValue);
      if (prev) prev.kind = kind;
      else found.set(offsetValue, { offsetValue, kind });
    }
  }

  const out = [];
  for (const { offsetValue, kind } of found.values()) {
    const pageValue = origin + offsetValue;
    const p = vertical ? pageToScreen(0, pageValue, vp) : pageToScreen(pageValue, 0, vp);
    const screenPos = vertical ? p.y : p.x;
    if (screenPos < -1 || screenPos > length + 1) continue;
    out.push({
      pageValue,
      screenPos,
      major: kind === 'major',
      medium: kind === 'medium',
      label: kind === 'major' ? formatTickLabel(offsetValue) : null,
    });
  }
  out.sort((p, q) => p.screenPos - q.screenPos);
  return out;
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

// The tick colours live in ruler.css as custom properties; a canvas cannot
// read `var(--x)`, so they are pulled out of the computed style. The
// fallbacks mirror ruler.css.
function readTokens(node) {
  const fallback = { minor: '#c7c7cc', major: '#8e8e93', text: '#4a4a4a' };
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const cs = window.getComputedStyle(node);
  const pick = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  return {
    minor: pick('--ruler-tick', fallback.minor),
    major: pick('--ruler-tick-major', fallback.major),
    text: pick('--ruler-text', fallback.text),
  };
}

function drawBand(canvas, axis, vp, origin) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cssW = canvas.clientWidth || 0;
  const cssH = canvas.clientHeight || 0;
  if (cssW <= 0 || cssH <= 0) return;

  // The backing store is sized for the device pixel ratio; the context is
  // scaled so everything below is drawn in CSS pixels.
  const dpr = vp.dpr || (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const horizontal = axis === 'h';
  const ticks = tickPositions(vp, axis, horizontal ? cssW : cssH, origin);
  const styles = readTokens(canvas);
  ctx.lineWidth = 1;
  ctx.font = '9px system-ui, -apple-system, "Segoe UI", sans-serif';

  for (const tick of ticks) {
    const len = tick.major ? 13 : tick.medium ? 9 : 5;
    const pos = Math.round(tick.screenPos) + 0.5; // crisp 1px lines
    ctx.strokeStyle = tick.major ? styles.major : styles.minor;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(pos, cssH - len);
      ctx.lineTo(pos, cssH);
    } else {
      ctx.moveTo(0, pos);
      ctx.lineTo(len, pos);
    }
    ctx.stroke();

    if (!tick.label) continue;
    ctx.fillStyle = styles.text;
    ctx.textAlign = 'left';
    if (horizontal) {
      const x = tick.screenPos + 3;
      if (x + ctx.measureText(tick.label).width > cssW) continue;
      ctx.textBaseline = 'top';
      ctx.fillText(tick.label, x, 3);
    } else {
      ctx.textBaseline = 'middle';
      ctx.fillText(tick.label, 15, tick.screenPos);
    }
  }
}

// ---------------------------------------------------------------------------
// the ruler
// ---------------------------------------------------------------------------

// getViewport() must return the live viewport object (coord.js mutates it in
// place); onChange() is called with { visible, origin } whenever the ruler's
// own state changes.
export function buildRuler({ getViewport, onChange } = {}) {
  const layer = el('div', 'ruler-layer');
  layer.setAttribute('aria-hidden', 'true');

  const hBand = el('div', 'ruler ruler-h');
  const hCanvas = el('canvas', 'ruler-canvas');
  hBand.appendChild(hCanvas);

  const vBand = el('div', 'ruler ruler-v');
  const vCanvas = el('canvas', 'ruler-canvas');
  vBand.appendChild(vCanvas);

  // The vertical band is added last so it paints over the corner square.
  layer.appendChild(hBand);
  layer.appendChild(vBand);
  layer.hidden = true;

  // The ruler's zero, in page units. (0, 0) = the page origin.
  let origin = { x: 0, y: 0 };

  function viewport() {
    const vp = typeof getViewport === 'function' ? getViewport() : null;
    return vp ?? { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  }

  function state() {
    return { visible: !layer.hidden, origin: { ...origin } };
  }

  function update() {
    if (layer.hidden) return;
    const vp = viewport();
    drawBand(hCanvas, 'h', vp, origin.x);
    drawBand(vCanvas, 'v', vp, origin.y);
  }

  // A resize changes the band lengths, so the ticks have to be redrawn.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => update());
    ro.observe(layer);
  }

  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(layer);
  }

  // Linked in last: the stylesheet carries the band sizes, so the first
  // measurement has to wait for it.
  injectRulerStyles(() => update());

  return {
    element: layer,

    setVisible(visible) {
      const next = Boolean(visible);
      if (next === !layer.hidden) return;
      layer.hidden = !next;
      if (next) update();
      onChange?.(state());
    },

    isVisible: () => !layer.hidden,

    update,

    // The ruler's zero, in page units. Shifting it moves the numbers with it
    // — the Notability ruler can be dragged along the page.
    setOriginOffset(x, y) {
      origin = { x: Number(x) || 0, y: Number(y) || 0 };
      update();
      onChange?.(state());
    },

    getOriginOffset: () => ({ ...origin }),

    // Which band is under the pointer? x and y are CSS pixels relative to the
    // page area's top-left (the same space as coord.js screen coordinates).
    // `offset` is the signed distance in CSS px from the band's inner edge:
    // negative inside the band, positive out in the page.
    getHitInfo(x, y) {
      if (layer.hidden) return null;
      const vp = viewport();
      if (y >= 0 && y <= RULER_SIZE) {
        return { axis: 'h', pageValue: screenToPage(x, y, vp).x, offset: y - RULER_SIZE };
      }
      if (x >= 0 && x <= RULER_SIZE) {
        return { axis: 'v', pageValue: screenToPage(x, y, vp).y, offset: x - RULER_SIZE };
      }
      return null;
    },
  };
}

export { RULER_SIZE };
