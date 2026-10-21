// ui.js — toolbar UI (step 2): tool buttons, pen colors, widths, undo/redo.
//
// Stateless DOM renderer: buildToolbar() creates the bar once and returns a
// controller with update(state). All behavior lives in app.js via actions:
//   { colors, onSelectTool(id), onSelectColor(c), onSelectWidth(w), onUndo(), onRedo() }
// State pushed via update():
//   { tool, color, width, widths[], showColors, canUndo, canRedo }

const TOOL_DEFS = [
  { id: 'pen', label: 'Pen' },
  { id: 'highlighter', label: 'Highlighter' },
  { id: 'eraser', label: 'Eraser' },
];

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function group(a11yLabel) {
  const g = el('div', 'tgroup');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', a11yLabel);
  return g;
}

function divider() {
  const d = el('span', 'tdiv');
  d.setAttribute('aria-hidden', 'true');
  return d;
}

// Inline SVG icons (no network, no icon font). 24x24 viewBox, currentColor.
function svgIcon(paths, extra = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  if (extra.class) svg.setAttribute('class', extra.class);
  return svg;
}

// A pen nib. Used for the "pen only" state of the finger-drawing toggle.
const ICON_NIB = [
  'M12 2.5 L18.5 9 L12 21.5 L5.5 9 Z',
  'M12 2.5 L12 21.5',
];
// A pen nib plus a fingertip dot: "pen and finger".
const ICON_NIB_FINGER = [
  'M13.5 2.5 L19 8 L13.5 18.5 L8 8 Z',
  'M13.5 2.5 L13.5 18.5',
  'M4.5 15 m-2.2 0 a2.2 2.2 0 1 0 4.4 0 a2.2 2.2 0 1 0 -4.4 0',
];

export function buildToolbar(root, actions) {
  const bar = el('div', 'toolbar-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Drawing tools');

  // Tool buttons.
  const toolGroup = group('Tool');
  const toolBtns = new Map();
  for (const t of TOOL_DEFS) {
    const b = el('button', 'tbtn', t.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => actions.onSelectTool(t.id));
    toolGroup.appendChild(b);
    toolBtns.set(t.id, b);
  }
  bar.appendChild(toolGroup);

  // Pen color swatches (visible for pen only; highlighter color is fixed).
  bar.appendChild(divider());
  const colorGroup = group('Pen color');
  const swatches = new Map();
  for (const c of actions.colors) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', `Pen color ${c}`);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => actions.onSelectColor(c));
    colorGroup.appendChild(b);
    swatches.set(c, b);
  }
  bar.appendChild(colorGroup);

  // Width buttons (rebuilt when the width set changes per tool).
  bar.appendChild(divider());
  const widthGroup = group('Stroke width');
  bar.appendChild(widthGroup);
  let widthKey = null;
  let widthBtns = [];

  // Undo / redo.
  bar.appendChild(divider());
  const histGroup = group('History');
  const undoBtn = el('button', 'tbtn', 'Undo');
  undoBtn.type = 'button';
  undoBtn.addEventListener('click', () => actions.onUndo());
  const redoBtn = el('button', 'tbtn', 'Redo');
  redoBtn.type = 'button';
  redoBtn.addEventListener('click', () => actions.onRedo());
  histGroup.appendChild(undoBtn);
  histGroup.appendChild(redoBtn);
  bar.appendChild(histGroup);

  // Finger-drawing toggle (palm rejection). Pressed = fingers may draw.
  bar.appendChild(divider());
  const inputGroup = group('Input');
  const fingerBtn = el('button', 'tbtn tbtn-icon');
  fingerBtn.type = 'button';
  fingerBtn.setAttribute('aria-pressed', 'false');
  fingerBtn.addEventListener('click', () => actions.onToggleFingerDrawing());
  inputGroup.appendChild(fingerBtn);
  bar.appendChild(inputGroup);

  root.appendChild(bar);

  function rebuildWidths(widths) {
    widthGroup.textContent = '';
    widthBtns = widths.map((w) => {
      const b = el('button', 'tbtn', String(w));
      b.type = 'button';
      b.title = `${w}px`;
      b.setAttribute('aria-label', `Stroke width ${w} pixels`);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => actions.onSelectWidth(w));
      widthGroup.appendChild(b);
      return { w, btn: b };
    });
    widthKey = widths.join(',');
  }

  return {
    update(state) {
      for (const [id, b] of toolBtns) b.setAttribute('aria-pressed', String(id === state.tool));
      colorGroup.style.display = state.showColors ? '' : 'none';
      for (const [c, b] of swatches) b.setAttribute('aria-pressed', String(c === state.color));
      widthGroup.style.display = state.widths.length > 0 ? '' : 'none';
      if (state.widths.join(',') !== widthKey) rebuildWidths(state.widths);
      for (const { w, btn } of widthBtns) btn.setAttribute('aria-pressed', String(w === state.width));
      undoBtn.disabled = !state.canUndo;
      redoBtn.disabled = !state.canRedo;

      // Finger-drawing toggle.
      const fingerOn = !!state.fingerDrawing;
      fingerBtn.setAttribute('aria-pressed', String(fingerOn));
      fingerBtn.title = fingerOn
        ? 'Finger drawing ON — fingers draw as well as the Pencil. Tap for pen only.'
        : 'Pen only — fingers are ignored (palm rejection). Tap to allow finger drawing.';
      fingerBtn.setAttribute('aria-label', fingerBtn.title);
      const wantPaths = fingerOn ? ICON_NIB_FINGER : ICON_NIB;
      const cur = fingerBtn.querySelector('svg');
      const curKey = cur ? cur.getAttribute('data-icon') : null;
      const wantKey = fingerOn ? 'nib-finger' : 'nib';
      if (curKey !== wantKey) {
        fingerBtn.textContent = '';
        const icon = svgIcon(wantPaths);
        icon.setAttribute('data-icon', wantKey);
        fingerBtn.appendChild(icon);
      }
    },
  };
}
