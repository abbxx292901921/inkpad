// ui/stroke-panel.js — the "Stroke" card.
//
// Notability's stroke panel has two parts: a thickness slider with a value
// bubble, and a row of line styles (solid / hairline / dashed / dotted).
//
// The slider is a real <input type="range"> sitting invisibly over a custom
// tick track, so dragging, keyboard control and screen readers all work.

import { el } from './popover.js';

export const LINE_STYLES = [
  { id: 'solid', label: 'Solid' },
  { id: 'hairline', label: 'Hairline' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
];

const NS = 'http://www.w3.org/2000/svg';

function styleGlyph(id) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `sty-glyph sty-${id}`);
  svg.setAttribute('aria-hidden', 'true');
  const add = (d, fill) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    if (fill) {
      p.setAttribute('fill', 'currentColor');
    } else {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2.2');
      p.setAttribute('stroke-linecap', 'round');
    }
    svg.appendChild(p);
  };
  switch (id) {
    case 'hairline':
      add('M3 15 C6 8 10 18 13 11 C15.5 6 18 13 21 8');
      svg.setAttribute('style', 'stroke-width:1.2');
      break;
    case 'dashed':
      add('M3 12 L7 12');
      add('M10 12 L14 12');
      add('M17 12 L21 12');
      break;
    case 'dotted':
      add('M5 12 a1.3 1.3 0 1 0 0.01 0', true);
      add('M10.5 12 a1.3 1.3 0 1 0 0.01 0', true);
      add('M16 12 a1.3 1.3 0 1 0 0.01 0', true);
      add('M21 12 a1.3 1.3 0 1 0 0.01 0', true);
      break;
    default:
      add('M3 15 C6 8 10 18 13 11 C15.5 6 18 13 21 8');
      break;
  }
  return svg;
}

export function buildStrokePanel({ onSelectWidth, onSelectStyle }) {
  const root = el('div', 'sp');

  root.appendChild(el('div', 'sp-title', 'Stroke'));

  // --- thickness slider ---
  const slider = el('div', 'sp-slider');
  const track = el('div', 'sp-track');
  slider.appendChild(track);

  const bubble = el('div', 'sp-bubble');
  slider.appendChild(bubble);

  const range = el('input', 'sp-range');
  range.type = 'range';
  range.min = '1';
  range.max = '20';
  range.step = '1';
  range.setAttribute('aria-label', 'Stroke thickness');
  slider.appendChild(range);

  root.appendChild(slider);

  // --- line styles ---
  const styles = el('div', 'sp-styles');
  const styleBtns = new Map();
  for (const s of LINE_STYLES) {
    const b = el('button', 'sty');
    b.type = 'button';
    b.title = s.label;
    b.setAttribute('aria-label', `${s.label} stroke`);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(styleGlyph(s.id));
    b.addEventListener('click', () => onSelectStyle(s.id));
    styles.appendChild(b);
    styleBtns.set(s.id, b);
  }
  root.appendChild(styles);

  let current = 0;

  function setBubble(width) {
    const min = Number(range.min);
    const max = Number(range.max);
    const pct = max === min ? 0 : ((width - min) / (max - min)) * 100;
    bubble.textContent = String(width);
    bubble.style.left = `calc(14px + ${pct} * (100% - 28px))`;
  }

  range.addEventListener('input', () => {
    const v = Number(range.value);
    setBubble(v);
    onSelectWidth(v);
  });

  return {
    el: root,
    update(state) {
      const min = state.minWidth ?? Number(range.min);
      const max = state.maxWidth ?? Number(range.max);
      if (range.min !== String(min)) range.min = String(min);
      if (range.max !== String(max)) range.max = String(max);
      const w = Math.max(min, Math.min(max, state.width ?? 3));
      if (Number(range.value) !== w) range.value = String(w);
      setBubble(w);
      current = state.lineStyle;
      for (const [id, btn] of styleBtns) btn.setAttribute('aria-pressed', String(id === current));
      // Some tools (the translucent marker) cannot use a textured style.
      const showStyles = state.showStyles !== false;
      styles.style.display = showStyles ? '' : 'none';
      for (const [, btn] of styleBtns) btn.disabled = !showStyles;
    },
  };
}
