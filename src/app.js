// app.js — bootstrap: wire modules together. Owns the strokes array, the
// undo/redo history, and the toolbar state.

import { createViewport } from './coord.js';
import { createDrawingSurface } from './canvas.js';
import {
  createHistory,
  addEntry,
  deleteEntry,
  removeStrokesById,
  eraseHitIds,
} from './strokes.js';
import {
  setCurrentTool,
  getCurrentTool,
  getToolOptions,
  setToolOptions,
  PEN_COLORS,
  PEN_WIDTHS,
  HIGHLIGHTER_WIDTHS,
} from './tools.js';
import { buildToolbar } from './ui.js';

const canvas = document.getElementById('page');
const debugEl = document.getElementById('debug');
const toolbarEl = document.getElementById('toolbar');

const viewport = createViewport();
// Strokes live in memory only for now. IndexedDB autosave arrives in step 4.
const strokes = [];
const history = createHistory();

let debugOn = false;

const surface = createDrawingSurface(canvas, viewport, {
  getStrokes: () => strokes,
  commitStroke: (stroke) => {
    history.commit(addEntry(stroke, strokes.length));
    strokes.push(stroke);
    syncUI();
  },
  erasePath: (path) => {
    if (path.length === 0) return;
    const ids = eraseHitIds(strokes, path, getToolOptions('eraser').radius);
    if (ids.length === 0) return; // hit nothing: no history entry, no repaint
    history.commit(deleteEntry(removeStrokesById(strokes, ids)));
    surface.redraw();
    syncUI();
  },
  debug: (text) => {
    debugEl.textContent = text;
  },
});

function widthsFor(toolId) {
  if (toolId === 'pen') return PEN_WIDTHS;
  if (toolId === 'highlighter') return HIGHLIGHTER_WIDTHS;
  return []; // eraser: no width row
}

function syncUI() {
  const tool = getCurrentTool();
  toolbar.update({
    tool: tool.id,
    color: tool.options.color,
    width: tool.options.width,
    widths: widthsFor(tool.id),
    showColors: tool.id === 'pen',
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  });
  canvas.style.cursor = tool.id === 'eraser' ? 'pointer' : 'crosshair';
}

const toolbar = buildToolbar(toolbarEl, {
  colors: PEN_COLORS,
  onSelectTool: (id) => {
    setCurrentTool(id);
    syncUI();
  },
  onSelectColor: (color) => {
    setToolOptions('pen', { color });
    syncUI();
  },
  onSelectWidth: (width) => {
    setToolOptions(getCurrentTool().id, { width });
    syncUI();
  },
  onUndo: () => {
    if (history.undo(strokes)) {
      surface.redraw();
      syncUI();
    }
  },
  onRedo: () => {
    if (history.redo(strokes)) {
      surface.redraw();
      syncUI();
    }
  },
});

function setDebug(on) {
  debugOn = on;
  debugEl.hidden = !on;
  surface.setDebugEnabled(on);
  if (!on) debugEl.textContent = '';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') setDebug(!debugOn);
});

window.addEventListener('resize', () => surface.resize());

surface.resize();
syncUI();
setDebug(false);

// Console handle for diagnosis (rule 6): inspect live state with
//   __inkpad.strokes.length, __inkpad.viewport, ...
window.__inkpad = { strokes, viewport, surface, history };
