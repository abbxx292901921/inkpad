// app.js — bootstrap: wire modules together.
//
// Owns the document (note -> pages -> strokes/layers), the undo/redo history,
// the toolbar state, the popovers and the file importer.

import { createViewport, pageToScreen } from './coord.js';
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
  getWidthRange,
  supportsLineStyle,
  QUICK_COLORS,
} from './tools.js';
import { buildToolbar } from './ui/toolbar.js';
import { buildPalette, DEFAULT_PALETTE } from './ui/palette.js';
import { buildStrokePanel } from './ui/stroke-panel.js';
import { createPopover, el } from './ui/popover.js';
import {
  fingerDrawingEnabled,
  toggleFingerDrawing,
  resetFingerDrawing,
  subscribeInput,
} from './input.js';
import {
  createNote,
  createPage,
  createImageLayer,
  addLayer,
  removeLayer,
  pageHasContent,
} from './pages.js';
import { rasterizePdf } from './pdf.js';

const canvas = document.getElementById('page');
const debugEl = document.getElementById('debug');
const toolbarEl = document.getElementById('toolbar');
const penRingEl = document.getElementById('penring');
const fileInput = document.getElementById('file-input');
const toastEl = document.getElementById('toast');

const viewport = createViewport();

// --- document --------------------------------------------------------------
// A note owns pages. A page owns background layers (imported files) and ink.
// The layers render UNDER the ink, so importing your homework and writing on
// it is the normal case, not a special one.
const state = {
  note: createNote({ title: 'Untitled' }),
  pageIndex: 0,
  get page() {
    return this.note.pages[this.pageIndex];
  },
};
const history = createHistory();

let debugOn = false;

// --- colours ---------------------------------------------------------------
// Palette 0 is the Notability default. Palette 1 collects custom colours.
const palettes = [DEFAULT_PALETTE.slice(), []];
let paletteIndex = 0;

function colorForTool() {
  const tool = getCurrentTool();
  return tool.kind === 'eraser' ? '#000000' : tool.options.color;
}

// --- toast -----------------------------------------------------------------
let toastTimer = 0;
function toast(message, ms = 3200) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-on');
    setTimeout(() => {
      toastEl.hidden = true;
    }, 200);
  }, ms);
}

// --- Apple Pencil cursor ring ---------------------------------------------
// The ring follows the pen while it hovers (pointermove with buttons === 0).
// Positioned in CSS pixels via coord.js — the only place conversions happen.
function onPenHover(info) {
  if (!penRingEl) return;
  if (!info) {
    hidePenRing();
    return;
  }
  const { x, y } = info;
  const s = pageToScreen(x, y, viewport);
  const tool = getCurrentTool();
  const width = tool.kind === 'eraser' ? tool.options.radius * 2 : tool.options.width;
  const size = Math.max(8, width * viewport.zoom);
  penRingEl.style.width = `${size}px`;
  penRingEl.style.height = `${size}px`;
  penRingEl.style.transform = `translate(${s.x - size / 2}px, ${s.y - size / 2}px)`;
  penRingEl.hidden = false;
}

function hidePenRing() {
  if (penRingEl) penRingEl.hidden = true;
}

// --- drawing surface -------------------------------------------------------
const surface = createDrawingSurface(canvas, viewport, {
  getStrokes: () => state.page.strokes,
  getLayers: () => state.page.layers,
  commitStroke: (stroke) => {
    history.commit(addEntry(stroke, state.page.strokes.length));
    state.page.strokes.push(stroke);
    syncUI();
  },
  erasePath: (path) => {
    if (path.length === 0) return;
    const ids = eraseHitIds(state.page.strokes, path, getToolOptions('eraser').radius);
    if (ids.length === 0) return; // hit nothing: no history entry, no repaint
    history.commit(deleteEntry(removeStrokesById(state.page.strokes, ids)));
    surface.redraw();
    syncUI();
  },
  onPenHover,
  debug: (text) => {
    debugEl.textContent = text;
  },
});

// --- popovers --------------------------------------------------------------
// Only one panel is open at a time, like the reference: opening the colour
// card closes the stroke card, and vice versa.
const palettePopover = createPopover({ className: 'pop-palette', label: 'Colours' });
const strokePopover = createPopover({ className: 'pop-stroke', label: 'Stroke options' });
const morePopover = createPopover({ className: 'pop-menu', label: 'More options' });

const ALL_POPOVERS = [palettePopover, strokePopover, morePopover];

function openOnly(popover) {
  for (const p of ALL_POPOVERS) {
    if (p !== popover) p.close();
  }
}

const palette = buildPalette({
  onSelect: (hex) => {
    setToolOptions(getCurrentTool().id, { color: hex });
    syncUI();
  },
  onSelectPalette: (i) => {
    paletteIndex = i;
    palette.update({ color: colorForTool(), palettes, paletteIndex });
  },
  onPickCustom: (hex) => {
    // A custom colour joins the user's palette, which becomes active.
    const userPalette = palettes[1];
    if (!userPalette.includes(hex)) userPalette.unshift(hex);
    paletteIndex = 1;
    setToolOptions(getCurrentTool().id, { color: hex });
    syncUI();
  },
  onAdd: () => {},
});
palettePopover.el.appendChild(palette.el);

const strokePanel = buildStrokePanel({
  onSelectWidth: (v) => {
    const tool = getCurrentTool();
    if (tool.kind === 'eraser') setToolOptions('eraser', { radius: v });
    else setToolOptions(tool.id, { width: v });
    syncUI();
  },
  onSelectStyle: (style) => {
    const tool = getCurrentTool();
    if (!supportsLineStyle(tool.id)) {
      toast(`${tool.name} is translucent, so it stays a solid band.`);
      return;
    }
    setToolOptions(tool.id, { lineStyle: style });
    syncUI();
  },
});
strokePopover.el.appendChild(strokePanel.el);

// --- the "more" menu -------------------------------------------------------
function buildMoreMenu() {
  morePopover.el.textContent = '';
  morePopover.el.appendChild(el('div', 'menu-head', 'Page'));

  const clearBtn = el('button', 'menu-item');
  clearBtn.type = 'button';
  clearBtn.appendChild(el('span', 'menu-label', 'Clear this page'));
  clearBtn.addEventListener('click', () => {
    if (!pageHasContent(state.page)) {
      toast('Nothing to clear.');
      return;
    }
    state.page.strokes.length = 0;
    for (const layer of [...state.page.layers]) removeLayer(state.page, layer.id);
    history.clear();
    surface.redraw();
    syncUI();
    morePopover.close();
    toast('Page cleared.');
  });
  morePopover.el.appendChild(clearBtn);

  const addPageBtn = el('button', 'menu-item');
  addPageBtn.type = 'button';
  addPageBtn.appendChild(el('span', 'menu-label', 'Add a blank page'));
  addPageBtn.addEventListener('click', () => {
    addBlankPage();
    morePopover.close();
  });
  morePopover.el.appendChild(addPageBtn);

  const fingerItem = el('button', 'menu-item');
  fingerItem.type = 'button';
  fingerItem.appendChild(el('span', 'menu-label', 'Finger drawing'));
  const fingerState = el('span', 'menu-value');
  fingerItem.appendChild(fingerState);
  fingerItem.addEventListener('click', () => {
    toggleFingerDrawing();
    syncUI();
    buildMoreMenu();
  });
  morePopover.el.appendChild(fingerItem);

  const autoItem = el('button', 'menu-item');
  autoItem.type = 'button';
  autoItem.appendChild(el('span', 'menu-label', 'Input mode: Automatic'));
  autoItem.addEventListener('click', () => {
    resetFingerDrawing();
    syncUI();
    buildMoreMenu();
  });
  morePopover.el.appendChild(autoItem);

  const state_ = fingerDrawingEnabled();
  fingerState.textContent = state_ ? 'On' : 'Off';
}

// --- pages -----------------------------------------------------------------
function setPage(index) {
  const count = state.note.pages.length;
  if (count === 0) return;
  const next = Math.max(0, Math.min(count - 1, index));
  if (next === state.pageIndex) {
    surface.redraw();
    return;
  }
  state.pageIndex = next;
  history.clear();
  surface.redraw();
  syncUI();
}

function addBlankPage() {
  const page = createPage({ name: `Page ${state.note.pages.length + 1}` });
  state.note.pages.push(page);
  setPage(state.note.pages.length - 1);
}

// --- file import -----------------------------------------------------------
// Import a file onto the page.
//
// Images become a background layer of the current page, so you write on top
// of them. PDFs become one page of the note per PDF page, each with the
// rasterised page as its background.
async function importFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    await importPdfFile(file);
    return;
  }
  if (!file.type.startsWith('image/')) {
    toast(`Cannot import "${file.name}" yet — images and PDFs are the targets.`);
    return;
  }
  const url = URL.createObjectURL(file);
  const layer = createImageLayer({ blob: file, url, name: file.name });
  layer.onLoad = () => surface.redraw();
  addLayer(state.page, layer);
  toast(`Imported ${file.name} — write on top of it.`);
}

async function importPdfFile(file) {
  toast(`Reading ${file.name}…`, 60000);
  try {
    const rendered = await rasterizePdf(file, {
      onProgress: (n, total) => toast(`Rendering page ${n} of ${total}…`, 60000),
    });
    if (rendered.length === 0) {
      toast('That PDF has no pages.');
      return;
    }

    const newPages = rendered.map((p) => {
      const pg = createPage({ name: `Page ${p.pageNumber}` });
      const layer = createImageLayer({
        blob: p.blob,
        url: p.url,
        name: file.name,
        kind: 'pdf',
      });
      layer.onLoad = () => surface.redraw();
      pg.layers.push(layer);
      return pg;
    });

    // A PDF into an empty note REPLACES it (no blank page 1 in front);
    // into a note with content it is appended.
    const only = state.note.pages[0];
    const noteIsEmpty = state.note.pages.length === 1 && !pageHasContent(only);
    if (noteIsEmpty) {
      for (const layer of only.layers) removeLayer(only, layer.id);
      state.note.pages = newPages;
      state.pageIndex = 0;
    } else {
      state.note.pages.push(...newPages);
      state.pageIndex = state.note.pages.length - newPages.length;
    }
    surface.redraw();
    syncUI();
    const word = newPages.length === 1 ? 'page' : 'pages';
    toast(`Imported ${newPages.length} ${word} from ${file.name} — write on top.`);
  } catch (err) {
    console.warn('[inkpad] PDF import failed', err);
    toast(err && err.message ? err.message : 'That PDF could not be imported.');
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  importFile(file);
});

// --- toolbar ---------------------------------------------------------------
const toolbar = buildToolbar(toolbarEl, {
  tools: [
    { id: 'pen', label: 'Pen', icon: 'pen' },
    { id: 'marker', label: 'Marker', icon: 'marker' },
    { id: 'pencil', label: 'Pencil', icon: 'pencil' },
    { id: 'eraser', label: 'Eraser', icon: 'eraser' },
  ],
  quickColors: QUICK_COLORS,
  onSelectTool: (id) => {
    setCurrentTool(id);
    syncUI();
  },
  onSelectColor: (hex) => {
    setToolOptions(getCurrentTool().id, { color: hex });
    syncUI();
  },
  onOpenPalette: (anchor) => {
    if (palettePopover.isOpen()) {
      palettePopover.close();
      return;
    }
    palette.update({ color: colorForTool(), palettes, paletteIndex });
    openOnly(palettePopover);
    palettePopover.open(anchor);
  },
  onOpenStroke: (anchor) => {
    if (strokePopover.isOpen()) {
      strokePopover.close();
      return;
    }
    syncStrokePanel();
    openOnly(strokePopover);
    strokePopover.open(anchor);
  },
  onUndo: () => {
    if (history.undo(state.page.strokes)) {
      surface.redraw();
      syncUI();
    }
  },
  onRedo: () => {
    if (history.redo(state.page.strokes)) {
      surface.redraw();
      syncUI();
    }
  },
  onImport: () => {
    fileInput.click();
  },
  onToggleFingerDrawing: () => {
    toggleFingerDrawing();
    syncUI();
  },
  onOpenMore: (anchor) => {
    if (morePopover.isOpen()) {
      morePopover.close();
      return;
    }
    buildMoreMenu();
    openOnly(morePopover);
    morePopover.open(anchor);
  },
  onPrevPage: () => setPage(state.pageIndex - 1),
  onNextPage: () => setPage(state.pageIndex + 1),
});

// --- state sync ------------------------------------------------------------
function strokeValue() {
  const tool = getCurrentTool();
  return tool.kind === 'eraser' ? tool.options.radius : tool.options.width;
}

function strokeRange() {
  const tool = getCurrentTool();
  if (tool.kind === 'eraser') return { min: 4, max: 40 };
  return getWidthRange(tool.id);
}

function syncStrokePanel() {
  const tool = getCurrentTool();
  const range = strokeRange();
  strokePanel.update({
    width: strokeValue(),
    minWidth: range.min,
    maxWidth: range.max,
    lineStyle: tool.options.lineStyle ?? 'solid',
    showStyles: supportsLineStyle(tool.id),
  });
}

function syncUI() {
  const tool = getCurrentTool();
  toolbar.update({
    tool: tool.id,
    color: colorForTool(),
    width: strokeValue(),
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    fingerDrawing: fingerDrawingEnabled(),
    pageIndex: state.pageIndex,
    pageCount: state.note.pages.length,
  });
  syncStrokePanel();
  if (palettePopover.isOpen()) {
    palette.update({ color: colorForTool(), palettes, paletteIndex });
  }
  canvas.style.cursor = tool.id === 'eraser' ? 'pointer' : 'crosshair';
}

// Palm rejection arms itself the moment a pen is seen, so the toolbar
// button has to follow the policy, not the other way round.
subscribeInput(() => syncUI());

// --- misc ------------------------------------------------------------------
function setDebug(on) {
  debugOn = on;
  debugEl.hidden = !on;
  surface.setDebugEnabled(on);
  if (!on) debugEl.textContent = '';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') setDebug(!debugOn);
  if (e.key === 'Escape') {
    palettePopover.close();
    strokePopover.close();
    morePopover.close();
  }
});

window.addEventListener('resize', () => {
  surface.resize();
  palettePopover.reposition();
  strokePopover.reposition();
  morePopover.reposition();
});
// The pen leaves the digitizer -> hide the hover ring.
window.addEventListener('pointerout', (e) => {
  if (e.pointerType === 'pen') hidePenRing();
});
window.addEventListener('blur', hidePenRing);

surface.resize();
syncUI();
setDebug(false);

// Console handle for diagnosis: inspect live state with
//   __inkpad.strokes.length, __inkpad.viewport, ...
window.__inkpad = {
  get note() {
    return state.note;
  },
  get page() {
    return state.page;
  },
  get pageIndex() {
    return state.pageIndex;
  },
  get strokes() {
    return state.page.strokes;
  },
  state,
  viewport,
  surface,
  history,
  palettes,
  setPage,
  importFile,
};
