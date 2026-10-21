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
    },
  };
}
