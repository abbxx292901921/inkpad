// tools.js — tool registry.
//
// Tool shape: { id, name, kind: 'ink' | 'eraser', icon, options, widthRange }
//   ink options:    { color, width, opacity, lineStyle, pressureTaper }
//   eraser options: { radius }   (page-coordinate hit radius)
//
// The toolbar is built from the registry, so adding a tool here is enough to
// make it appear in the UI. Lasso / shapes / "ask AI" register here later.

export const QUICK_COLORS = [
  '#000000', '#0a84ff', '#34c759', '#ff3b30', '#af52de', '#ffffff',
];

export const LINE_STYLE_SOLID = 'solid';

const registry = new Map();
let currentId = 'pen';

export function registerTool(id, def) {
  registry.set(id, { id, ...def });
}

export function getTool(id) {
  return registry.get(id);
}

export function getTools() {
  return [...registry.values()];
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

export function getWidthRange(id) {
  const t = registry.get(id);
  return t?.widthRange ?? { min: 1, max: 20 };
}

// A translucent tool cannot use a dashed/dotted style: textured strokes
// re-stroke their whole path as you draw, which would stack the alpha and
// make the marker darken. The marker is therefore always a solid band.
export function supportsLineStyle(id) {
  const t = registry.get(id);
  if (!t) return false;
  if (t.kind !== 'ink') return false;
  return (t.options.opacity ?? 1) >= 1;
}

registerTool('pen', {
  name: 'Pen',
  kind: 'ink',
  icon: 'pen',
  // Pressure-sensitive: the width follows how hard the Pencil is pressed.
  options: { color: '#000000', width: 3, opacity: 1, lineStyle: LINE_STYLE_SOLID, pressureTaper: true },
  widthRange: { min: 1, max: 20 },
});

registerTool('marker', {
  name: 'Marker',
  kind: 'ink',
  icon: 'marker',
  // Translucent chisel marker: constant width, drawn behind the ink.
  options: { color: '#ffd60a', width: 18, opacity: 0.5, lineStyle: LINE_STYLE_SOLID, pressureTaper: false },
  widthRange: { min: 6, max: 48 },
});

registerTool('pencil', {
  name: 'Pencil',
  kind: 'ink',
  icon: 'pencil',
  // Graphite: constant width, no pressure taper, opaque.
  options: { color: '#3a3a3a', width: 2, opacity: 1, lineStyle: LINE_STYLE_SOLID, pressureTaper: false },
  widthRange: { min: 1, max: 12 },
});

registerTool('eraser', {
  name: 'Eraser',
  kind: 'eraser',
  icon: 'eraser',
  options: { radius: 14 },
});
