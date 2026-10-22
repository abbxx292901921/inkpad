// ui/icons.js — the icon set.
//
// Every icon is inline SVG (no network, no icon font, no sprite sheet).
// Icons are drawn on a 24x24 grid with `fill: none; stroke: currentColor`,
// so a single CSS colour rule tints them all and the active state is just a
// colour change.
//
// A path may opt into `fill: true` (solid dots) and `dash: '4 3'`.

const P = (d) => ({ d, fill: false });
const F = (d) => ({ d, fill: true });

export const ICONS = {
  // --- navigation ---
  back: { paths: [P('M15 5 L8 12 L15 19')] },
  // Four squares: the library / notes grid.
  library: {
    paths: [
      P('M3.5 3.5 L10.5 3.5 L10.5 10.5 L3.5 10.5 Z'),
      P('M13.5 3.5 L20.5 3.5 L20.5 10.5 L13.5 10.5 Z'),
      P('M3.5 13.5 L10.5 13.5 L10.5 20.5 L3.5 20.5 Z'),
      P('M13.5 13.5 L20.5 13.5 L20.5 20.5 L13.5 20.5 Z'),
    ],
  },
  close: { paths: [P('M6 6 L18 18'), P('M18 6 L6 18')] },
  chevronRight: { paths: [P('M9 5 L16 12 L9 19')] },
  chevronDown: { paths: [P('M5 9 L12 16 L19 9')] },
  chevronUp: { paths: [P('M5 15 L12 8 L19 15')] },

  // --- tools ---
  // Fountain-pen nib, tip down: outline, breather hole, slit.
  pen: {
    paths: [
      P('M12 21.5 L6 10 L12 3 L18 10 Z'),
      P('M12 3 L12 7.6'),
      P('M12 12.4 L12 21.5'),
      P('M9.7 10 a2.3 2.3 0 1 0 4.6 0 a2.3 2.3 0 1 0 -4.6 0'),
    ],
  },
  // Chisel highlighter / marker: slanted body with a flat chisel tip.
  marker: {
    paths: [P('M15 3 L21 9 L12 18 L6 12 Z'), P('M6 12 L3 15 L6 18 L9 15 Z')],
  },
  // Slanted pencil with a sharpened tip.
  pencil: { paths: [P('M4 20 L5 15.5 L16 4.5 L19.5 8 L8.5 19 Z'), P('M5 15.5 L8.5 19'), P('M13.5 6.5 L17 10')] },
  // Block eraser, tilted.
  eraser: { paths: [P('M5 19 L9 6 L20 9 L16 19 Z'), P('M7.3 12.8 L18.2 15.8')] },
  // Square + circle.
  shapes: { paths: [P('M3 3 L11 3 L11 11 L3 11 Z'), P('M21 16 a4 4 0 1 0 -8 0 a4 4 0 1 0 8 0')] },
  // Corner brackets = selection.
  select: {
    paths: [
      P('M4 8 L4 4 L8 4'),
      P('M16 4 L20 4 L20 8'),
      P('M20 16 L20 20 L16 20'),
      P('M8 20 L4 20 L4 16'),
    ],
  },
  // A dashed freeform loop: the lasso selection gesture.
  lasso: {
    paths: [
      P('M12 4.5 C17 3.8 20.8 7.3 20.3 12.2 C19.8 17.2 15.4 20.4 10.2 19.4 C5.5 18.5 3.2 14.2 5.1 9.6 C6.3 6.7 9 4.6 12 4.5 Z'),
    ],
    dash: '3 2.5',
  },
  // Circle with a plus: "add element".
  add: {
    paths: [
      P('M21 12 a9 9 0 1 0 -18 0 a9 9 0 1 0 18 0'),
      P('M12 8 L12 16'),
      P('M8 12 L16 12'),
    ],
  },
  mic: {
    paths: [
      P('M12 3 a3 3 0 0 1 3 3 L15 11 a3 3 0 0 1 -6 0 L9 6 a3 3 0 0 1 3 -3 Z'),
      P('M5.5 11 a6.5 6.5 0 0 0 13 0'),
      P('M12 17.5 L12 21'),
    ],
  },
  gear: {
    paths: [
      P('M12 8.5 a3.5 3.5 0 1 0 0 7 a3.5 3.5 0 1 0 0 -7'),
      P('M12 2 L12 5.5'),
      P('M12 18.5 L12 22'),
      P('M2 12 L5.5 12'),
      P('M18.5 12 L22 12'),
      P('M4.9 4.9 L7.4 7.4'),
      P('M16.6 16.6 L19.1 19.1'),
      P('M19.1 4.9 L16.6 7.4'),
      P('M7.4 16.6 L4.9 19.1'),
    ],
  },
  // A freeform polygon: the "custom" shape the user edits themselves.
  shapeCustom: {
    paths: [P('M12 3 L20 8 L17.5 18 L6.5 18 L4 8 Z')],
  },
  // A capital T: the text tool.
  text: { paths: [P('M5 6 L19 6'), P('M12 6 L12 19')] },
  // A four-way move arrow: a finger that pans the page.
  pan: {
    paths: [
      P('M12 4 L12 20 M4 12 L20 12'),
      P('M12 4 L9.6 6.4 M12 4 L14.4 6.4'),
      P('M12 20 L9.6 17.6 M12 20 L14.4 17.6'),
      P('M4 12 L6.4 9.6 M4 12 L6.4 14.4'),
      P('M20 12 L17.6 9.6 M20 12 L17.6 14.4'),
    ],
  },
  // A four-pointed star, like the app's own mark: the "Ask AI" button.
  sparkle: {
    paths: [P('M12 2.5 L13.9 9.1 L20.5 11 L13.9 12.9 L12 19.5 L10.1 12.9 L3.5 11 L10.1 9.1 Z')],
  },
  // Pen only / pen + finger, for the palm-rejection toggle.
  nib: { paths: [P('M12 2.5 L18.5 9 L12 21.5 L5.5 9 Z'), P('M12 2.5 L12 21.5')] },
  nibFinger: {
    paths: [
      P('M14 2.5 L19.5 8 L14 18.5 L8.5 8 Z'),
      P('M14 2.5 L14 18.5'),
      F('M4.6 15 a2.2 2.2 0 1 0 0.01 0'),
    ],
  },

  // --- history / actions ---
  undo: { paths: [P('M9 14 L4 9 L9 4'), P('M4 9 L14 9 a5 5 0 0 1 0 10 L8 19')] },
  redo: { paths: [P('M15 14 L20 9 L15 4'), P('M20 9 L10 9 a5 5 0 0 0 0 10 L16 19')] },
  more: { paths: [F('M6 12 a1.5 1.5 0 1 0 0.01 0'), F('M12 12 a1.5 1.5 0 1 0 0.01 0'), F('M18 12 a1.5 1.5 0 1 0 0.01 0')] },
  trash: {
    paths: [
      P('M4 7 L20 7'),
      P('M9 7 L9 4 L15 4 L15 7'),
      P('M6 7 L7 20 L17 20 L18 7'),
      P('M10 11 L10 17'),
      P('M14 11 L14 17'),
    ],
  },

  // --- documents ---
  // Page with a folded corner.
  page: { paths: [P('M6 3 L14 3 L18 7 L18 21 L6 21 Z'), P('M14 3 L14 7 L18 7')] },
  pages: { paths: [P('M9 2 L15 2 L15 4 L9 4 Z'), P('M5 6 L19 6 L19 22 L5 22 Z')] },
  // Picture frame with a mountain.
  image: {
    paths: [
      P('M4 5 L20 5 L20 19 L4 19 Z'),
      P('M4 15 L9 10 L13 14 L16 11 L20 15'),
      F('M8.6 9 a1.4 1.4 0 1 0 0.01 0'),
    ],
  },
  ruler: { paths: [P('M3 8 L8 3 L21 16 L16 21 Z'), P('M7.5 8.5 L9.5 10.5'), P('M11 5 L13 7'), P('M14.5 11.5 L16.5 13.5')] },
  // A single line whose thickness previews the current stroke width.
  strokeWidth: { paths: [P('M3 12 L21 12')] },
  // Horizontal "freeform / boxed" glyphs used by the shape fill-mode control.
  freeform: { paths: [P('M3 14 C6 7 10 18 13 11 C15.5 6 18 12 21 8')] },
  boxed: { paths: [P('M4 6 L20 6 L20 18 L4 18 Z', )], dash: '3 2.5' },

  // --- shapes (the shape submenu) ---
  // One glyph per shape kind. Same 24x24 grid, same stroke conventions, so
  // they tint with the toolbar colour like every other icon.
  shapeLine: { paths: [P('M4.5 19.5 L19.5 4.5')] },
  shapeRect: { paths: [P('M4 6 L20 6 L20 18 L4 18 Z')] },
  shapeEllipse: { paths: [P('M19 12 a7 7 0 1 0 -14 0 a7 7 0 1 0 14 0')] },
  shapeTriangle: { paths: [P('M12 4.5 L20.5 19 L3.5 19 Z')] },
  shapeArrow: { paths: [P('M4.5 19.5 L18.5 5.5'), P('M11 5.5 L18.5 5.5 L18.5 13')] },
};

const NS = 'http://www.w3.org/2000/svg';

// Build an <svg> element for the named icon.
export function icon(name, { size = 20, className = '' } = {}) {
  const def = ICONS[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ico ${className}`.trim());
  svg.setAttribute('data-icon', name);
  if (!def) return svg;
  for (const p of def.paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', p.d);
    if (p.fill) path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
  }
  if (def.dash) {
    for (const path of svg.querySelectorAll('path')) path.setAttribute('stroke-dasharray', def.dash);
  }
  return svg;
}

export function hasIcon(name) {
  return Boolean(ICONS[name]);
}
