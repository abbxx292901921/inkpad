// ui/rotation-dial.js — the Notability-style rotation dial.
//
// The circular dial from the reference: a white face with a ring of fine tick
// marks and the current angle in the centre. Dragging it rotates to the
// nearest snap step (15 degrees by default; hold Shift or Alt for single
// degrees).
//
// ANGLE CONVENTION: 0 degrees points UP (12 o'clock) and the angle grows
// CLOCKWISE, so the marker at the top is the zero reference — what a person
// expects from a compass-style dial. angleFromPoint() follows the same rule.
//
// Nothing here touches `document` at import time, so the module is import
// safe and the pure helpers can be tested in Node.

import { el } from './popover.js';
import { injectRulerStyles } from './ruler.js';

// The dial's face, in CSS px (the reference is ~110pt across).
const DIAL_SIZE = 110;
const SNAP_DEFAULT = 15;
// The ring's ticks.
const RING_STEP = 10;
const RING_MEDIUM = 30;
const RING_MAJOR = 90;

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

// The compass angle of the point (x, y) seen from the centre (cx, cy), in
// degrees: 0 = up, 90 = right, 180 = down, 270 = left.
export function angleFromPoint(cx, cy, x, y) {
  const deg = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

// The nearest multiple of `step`. The sign is kept — snapping is rounding,
// not wrapping — so snapAngle(-10, 15) is -15.
export function snapAngle(deg, step = SNAP_DEFAULT) {
  const s = Math.abs(Number(step)) || SNAP_DEFAULT;
  const snapped = Math.round(Number(deg) / s) * s;
  return Object.is(snapped, -0) ? 0 : snapped;
}

function normalize(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

// A point on a ring: 0 degrees is up, angles grow clockwise.
function ringPoint(deg, radius, cx, cy) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) };
}

// ---------------------------------------------------------------------------
// the dial
// ---------------------------------------------------------------------------

// onChange(deg) fires while the user drags the dial. snap is the drag step in
// degrees (15 by default).
export function buildRotationDial({ onChange, snap = SNAP_DEFAULT } = {}) {
  const dial = el('div', 'dial');
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', 'Rotation angle');
  dial.hidden = true;

  const canvas = el('canvas', 'dial-canvas');
  const readout = el('div', 'dial-angle', '0°');
  dial.appendChild(canvas);
  dial.appendChild(readout);

  let angle = 0;
  let dragging = false;

  // The tick colours live in ruler.css as custom properties; a canvas cannot
  // read `var(--x)`, so they are pulled out of the computed style.
  function readTokens() {
    const fallback = { minor: '#c7c7cc', major: '#8e8e93', mark: '#0a84ff' };
    if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
    const cs = window.getComputedStyle(dial);
    const pick = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    return {
      minor: pick('--dial-tick', fallback.minor),
      major: pick('--dial-tick-major', fallback.major),
      mark: pick('--accent', fallback.mark),
    };
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cssW = canvas.clientWidth || DIAL_SIZE;
    const cssH = canvas.clientHeight || DIAL_SIZE;
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW / 2;
    const cy = cssH / 2;
    const r = Math.min(cssW, cssH) / 2 - 7;
    const styles = readTokens();

    // The faint circle the ticks sit on.
    ctx.strokeStyle = styles.minor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // The ring: a short tick every 10 degrees, longer ones every 30 and 90.
    for (let deg = 0; deg < 360; deg += RING_STEP) {
      const major = deg % RING_MAJOR === 0;
      const len = major ? 9 : deg % RING_MEDIUM === 0 ? 6 : 3.5;
      const outer = ringPoint(deg, r, cx, cy);
      const inner = ringPoint(deg, r - len, cx, cy);
      ctx.strokeStyle = major ? styles.major : styles.minor;
      ctx.beginPath();
      ctx.moveTo(outer.x, outer.y);
      ctx.lineTo(inner.x, inner.y);
      ctx.stroke();
    }

    // The marker at the current angle.
    const markOuter = ringPoint(angle, r + 3, cx, cy);
    const markInner = ringPoint(angle, r - 13, cx, cy);
    ctx.strokeStyle = styles.mark;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(markOuter.x, markOuter.y);
    ctx.lineTo(markInner.x, markInner.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(markOuter.x, markOuter.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = styles.mark;
    ctx.fill();
  }

  function applyPointer(e, fine) {
    const rect = dial.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const raw = angleFromPoint(cx, cy, e.clientX, e.clientY);
    const next = normalize(snapAngle(raw, fine ? 1 : snap));
    setAngle(next);
    onChange?.(next);
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (e && e.pointerId !== undefined && dial.hasPointerCapture?.(e.pointerId)) {
      dial.releasePointerCapture(e.pointerId);
    }
  }

  // The dial is a control, so the gesture belongs to it and not to the canvas
  // underneath.
  function drag(e) {
    e.preventDefault();
    e.stopPropagation();
    applyPointer(e, e.shiftKey || e.altKey);
  }

  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    dial.setPointerCapture?.(e.pointerId);
    drag(e);
  });
  dial.addEventListener('pointermove', (e) => {
    if (dragging) drag(e);
  });
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);
  dial.addEventListener('lostpointercapture', endDrag);

  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(dial);
  }

  // Linked in last: the stylesheet carries the dial's size, so the first
  // measurement has to wait for it.
  injectRulerStyles(() => draw());

  function setAngle(deg) {
    angle = normalize(deg);
    readout.textContent = `${Math.round(angle)}°`;
    dial.setAttribute('aria-valuenow', String(Math.round(angle)));
    draw();
  }

  return {
    element: dial,

    // Put the dial's CENTRE at the given screen coordinates.
    show(x, y) {
      dial.style.left = `${Math.round(x - DIAL_SIZE / 2)}px`;
      dial.style.top = `${Math.round(y - DIAL_SIZE / 2)}px`;
      dial.hidden = false;
      draw();
    },

    hide() {
      dial.hidden = true;
    },

    isVisible: () => !dial.hidden,

    setAngle,

    getAngle: () => angle,
  };
}

export { DIAL_SIZE };
