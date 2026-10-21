// ui/palette.js — the "Colors" card.
//
// Reproduces the Notability colour panel: a title, a colour-wheel button, a
// grid of swatches (the selected one carries a checkmark), and a row of dots
// that switch between colour palettes.

import { colorWheelButton, el } from './popover.js';

// The Notability default palette, read off the user's screenshot.
export const DEFAULT_PALETTE = [
  '#ffd60a', '#ff9f0a', '#ff3b30', '#ff2d95',
  '#a3e635', '#34c759', '#af52de', '#5e5ce6',
  '#1f7a3d', '#0a84ff', '#0b4fa8', '#1c1c4e',
  '#ffffff', '#8e8e93', '#000000', '#a2845e',
];

const CHECK = 'M4 12.5 L9.5 18 L20 6';

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // Rec. 709 luma.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
}

export function buildPalette({ onSelect, onAdd, onPickCustom, onSelectPalette }) {
  const root = el('div', 'pal');

  const head = el('div', 'pal-head');
  head.appendChild(el('span', 'pal-title', 'Colors'));
  const wheel = colorWheelButton({ onPick: (hex) => onPickCustom(hex) });
  head.appendChild(wheel);
  root.appendChild(head);

  const grid = el('div', 'pal-grid');
  root.appendChild(grid);

  const dots = el('div', 'pal-dots');
  root.appendChild(dots);

  let paletteIndex = 0;
  let palettes = [DEFAULT_PALETTE.slice()];
  let current = null;

  function renderGrid() {
    grid.textContent = '';
    const colors = palettes[paletteIndex] ?? [];
    for (const hex of colors) {
      const b = el('button', 'pal-swatch');
      b.type = 'button';
      b.style.background = hex;
      b.title = hex;
      b.setAttribute('aria-label', `Colour ${hex}`);
      b.setAttribute('aria-pressed', String(hex === current));
      if (hex === current) {
        b.classList.add('is-selected');
        // The checkmark is drawn in the contrasting colour so it reads on both
        // a black swatch and a white one.
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'pal-check');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', CHECK);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', isLight(hex) ? '#1b1b1b' : '#ffffff');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        b.appendChild(svg);
      }
      b.addEventListener('click', () => onSelect(hex));
      grid.appendChild(b);
    }
  }

  function renderDots() {
    dots.textContent = '';
    palettes.forEach((_, i) => {
      const d = el('button', 'pal-dot');
      d.type = 'button';
      d.setAttribute('aria-label', `Colour palette ${i + 1}`);
      d.setAttribute('aria-pressed', String(i === paletteIndex));
      if (i === paletteIndex) d.classList.add('is-active');
      d.addEventListener('click', () => onSelectPalette(i));
      dots.appendChild(d);
    });
  }

  return {
    el: root,
    update(state) {
      current = state.color;
      paletteIndex = state.paletteIndex ?? 0;
      palettes = state.palettes ?? palettes;
      renderGrid();
      renderDots();
    },
  };
}
