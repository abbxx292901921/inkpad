// tools.js — tool registry: pen, highlighter, eraser.
// canvas.js reads getCurrentTool() at pointerdown; ui.js edits per-tool
// options via setToolOptions(). Lasso + "ask AI" register here in steps 6/8.
//
// Tool shape: { id, name, kind: 'ink' | 'eraser', options }
//   ink options:    { color, width }
//   eraser options: { radius }   (page-coordinate hit radius)

export const PEN_COLORS = ['#1b1b1b', '#2563eb', '#dc2626', '#16a34a'];
export const PEN_WIDTHS = [2, 3, 5];
export const HIGHLIGHTER_WIDTHS = [10, 14, 20];
export const HIGHLIGHTER_COLOR = 'rgba(255, 235, 59, 0.5)';

const registry = new Map();
let currentId = 'pen';

export function registerTool(id, def) {
  registry.set(id, { id, ...def });
}

export function getTool(id) {
  return registry.get(id);
}

export function getCurrentTool() {
  return registry.get(currentId);
}

export function setCurrentTool(id) {
  if (!registry.has(id)) throw new Error(`[inkpad] unknown tool: ${id}`);
  currentId = id;
}

export function getToolOptions(id) {
  const t = registry.get(id);
  return t ? t.options : undefined;
}

export function setToolOptions(id, patch) {
  const t = registry.get(id);
  if (!t) throw new Error(`[inkpad] unknown tool: ${id}`);
  Object.assign(t.options, patch);
}

registerTool('pen', {
  name: 'Pen',
  kind: 'ink',
  options: { color: PEN_COLORS[0], width: 3 },
});

registerTool('highlighter', {
  name: 'Highlighter',
  kind: 'ink',
  // Fixed translucent yellow; rendered behind ink via destination-over
  // (see strokes.js). Color choice for highlighter arrives later, if ever.
  options: { color: HIGHLIGHTER_COLOR, width: 14 },
});

registerTool('eraser', {
  name: 'Eraser',
  kind: 'eraser',
  options: { radius: 14 },
});
