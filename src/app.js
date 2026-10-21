// app.js — bootstrap: wire modules together.
//
// Owns the toolbar state, the popovers, the file importer and the two
// screens (library / editor). The DOCUMENT itself lives in src/workspace.js.
//
// Screen model:
//   library  the Notability-style notes/folders screen
//   editor   the canvas + floating toolbar

import { createViewport, pageToScreen, resetViewport } from './coord.js';
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
import { buildLibrary } from './ui/library.js';
import { createPopover, el } from './ui/popover.js';
import {
  fingerDrawingEnabled,
  toggleFingerDrawing,
  resetFingerDrawing,
  subscribeInput,
} from './input.js';
import { createImageLayer, addLayer, removeLayer, pageHasContent, createPage } from './pages.js';
import { rasterizePdf } from './pdf.js';
import { createWorkspace } from './workspace.js';
import { downloadNoteAsPng, printNote } from './export.js';
import { registerServiceWorker } from './sw-register.js';
import { buildShapeMenu } from './ui/shape-menu.js';
import { buildTextPrompt, buildListPrompt } from './ui/prompt.js';
import { buildSelection } from './ui/selection.js';
import { buildRuler } from './ui/ruler.js';
import { buildRotationDial } from './ui/rotation-dial.js';
import {
  boundsOf,
  translateStrokes,
  scaleStrokes,
  rotateStrokes,
  handlePositions,
  strokesInPolygon,
} from './transform.js';
import { snapshotStrokes, restoreStrokes, transformEntry } from './strokes.js';

const canvas = document.getElementById('page');
const debugEl = document.getElementById('debug');
const toolbarEl = document.getElementById('toolbar');
const penRingEl = document.getElementById('penring');
const fileInput = document.getElementById('file-input');
const toastEl = document.getElementById('toast');
const libraryEl = document.getElementById('library');
const editorEl = document.getElementById('editor');

const viewport = createViewport();
const history = createHistory();

let debugOn = false;
let zoomPct = 100;

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

// --- workspace -------------------------------------------------------------
const workspace = createWorkspace({ onChange: () => syncUI() });

// --- screens ---------------------------------------------------------------
let screen = 'editor';

function showScreen(name) {
  screen = name;
  if (editorEl) editorEl.hidden = name !== 'editor';
  if (libraryEl) libraryEl.hidden = name !== 'library';
  if (name === 'library') {
    library.update(workspace.libraryState({ screen: 'home' }));
  } else {
    surface.resize();
  }
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
  getStrokes: () => (workspace.page ? workspace.page.strokes : []),
  getLayers: () => (workspace.page ? workspace.page.layers : []),
  commitStroke: (stroke) => {
    const page = workspace.page;
    if (!page) return;
    history.commit(addEntry(stroke, page.strokes.length));
    page.strokes.push(stroke);
    workspace.markDirty();
    syncUI();
  },
  erasePath: (path) => {
    const page = workspace.page;
    if (!page || path.length === 0) return;
    const ids = eraseHitIds(page.strokes, path, getToolOptions('eraser').radius);
    if (ids.length === 0) return; // hit nothing: no history entry, no repaint
    history.commit(deleteEntry(removeStrokesById(page.strokes, ids)));
    workspace.markDirty();
    surface.redraw();
    syncUI();
  },
  onPenHover,
  onViewportChange: () => {
    zoomPct = Math.round(viewport.zoom * 100);
    if (rulerVisible) ruler.update();
  },
  onLasso: (path) => {
    const page = workspace.page;
    if (!page) return;
    if (path.length < 3) {
      // A tap clears the selection.
      selected = [];
      syncSelection();
      return;
    }
    selected = strokesInPolygon(page.strokes, path);
    syncSelection();
  },
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
  morePopover.el.appendChild(el('div', 'menu-head', 'This page'));

  const clearBtn = el('button', 'menu-item');
  clearBtn.type = 'button';
  clearBtn.appendChild(el('span', 'menu-label', 'Clear this page'));
  clearBtn.addEventListener('click', () => {
    const page = workspace.page;
    if (!page || !pageHasContent(page)) {
      toast('Nothing to clear.');
      return;
    }
    page.strokes.length = 0;
    for (const layer of [...page.layers]) removeLayer(page, layer.id);
    history.clear();
    workspace.markDirty();
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
    workspace.addPage();
    surface.redraw();
    morePopover.close();
  });
  morePopover.el.appendChild(addPageBtn);

  const resetView = el('button', 'menu-item');
  resetView.type = 'button';
  resetView.appendChild(el('span', 'menu-label', 'Reset the view'));
  resetView.appendChild(el('span', 'menu-value', `${zoomPct}%`));
  resetView.addEventListener('click', () => {
    resetViewport(viewport);
    zoomPct = 100;
    surface.redraw();
    buildMoreMenu();
  });
  morePopover.el.appendChild(resetView);

  morePopover.el.appendChild(el('div', 'menu-head', 'Note'));

  const renameBtn = el('button', 'menu-item');
  renameBtn.type = 'button';
  renameBtn.appendChild(el('span', 'menu-label', 'Rename this note'));
  renameBtn.addEventListener('click', () => {
    morePopover.close();
    openTextPrompt({
      title: 'Note name',
      value: workspace.current ? workspace.current.title : '',
      placeholder: 'Untitled',
      onSubmit: (text) => {
        workspace.renameNote(text);
        syncUI();
      },
    });
  });
  morePopover.el.appendChild(renameBtn);

  const folderBtn = el('button', 'menu-item');
  folderBtn.type = 'button';
  folderBtn.appendChild(el('span', 'menu-label', 'Move to a folder'));
  folderBtn.addEventListener('click', () => {
    morePopover.close();
    openFolderPicker();
  });
  morePopover.el.appendChild(folderBtn);

  const newFolderBtn = el('button', 'menu-item');
  newFolderBtn.type = 'button';
  newFolderBtn.appendChild(el('span', 'menu-label', 'New folder'));
  newFolderBtn.addEventListener('click', () => {
    morePopover.close();
    openTextPrompt({
      title: 'Folder name',
      placeholder: 'Math 220',
      onSubmit: async (text) => {
        await workspace.createFolder(text);
        toast(`Created the folder "${text}".`);
      },
    });
  });
  morePopover.el.appendChild(newFolderBtn);

  const printBtn = el('button', 'menu-item');
  printBtn.type = 'button';
  printBtn.appendChild(el('span', 'menu-label', 'Print / Save as PDF'));
  printBtn.addEventListener('click', async () => {
    morePopover.close();
    if (!workspace.current) return;
    try {
      await printNote(workspace.current, { title: workspace.current.title });
    } catch (err) {
      console.warn('[inkpad] print failed', err);
      toast('Could not open the print view.');
    }
  });
  morePopover.el.appendChild(printBtn);

  const pngBtn = el('button', 'menu-item');
  pngBtn.type = 'button';
  pngBtn.appendChild(el('span', 'menu-label', 'Download as PNG'));
  pngBtn.addEventListener('click', async () => {
    morePopover.close();
    if (!workspace.current) return;
    try {
      await downloadNoteAsPng(workspace.current);
      toast('Saved the pages as PNG.');
    } catch (err) {
      console.warn('[inkpad] PNG export failed', err);
      toast('Could not export the PNG.');
    }
  });
  morePopover.el.appendChild(pngBtn);

  const deleteBtn = el('button', 'menu-item menu-item-danger', 'Delete this note');
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', () => {
    morePopover.close();
    openTextPrompt({
      title: 'Delete this note?',
      placeholder: 'Type DELETE to confirm',
      onSubmit: (text) => {
        if (text.toUpperCase() !== 'DELETE') {
          toast('Not deleted — type DELETE to confirm.');
          return;
        }
        const id = workspace.current.id;
        workspace.deleteNote(id).then(() => {
          toast('Note deleted.');
          showScreen('library');
        });
      },
    });
  });
  morePopover.el.appendChild(deleteBtn);

  morePopover.el.appendChild(el('div', 'menu-head', 'Input'));

  const rulerItem = el('button', 'menu-item');
  rulerItem.type = 'button';
  rulerItem.appendChild(el('span', 'menu-label', 'Ruler'));
  const rulerState = el('span', 'menu-value');
  rulerItem.appendChild(rulerState);
  rulerItem.addEventListener('click', () => {
    rulerVisible = !rulerVisible;
    ruler.setVisible(rulerVisible);
    if (rulerVisible) ruler.update();
    buildMoreMenu();
  });
  morePopover.el.appendChild(rulerItem);
  rulerState.textContent = rulerVisible ? 'On' : 'Off';

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

  fingerState.textContent = fingerDrawingEnabled() ? 'On' : 'Off';
}

// --- file import -----------------------------------------------------------
// Import a file onto the page.
//
// Images become a background layer of the current page, so you write on top
// of them. PDFs become one page of the note per PDF page, each with the
// rasterised page as its background.
async function importFile(file) {
  if (!workspace.current) workspace.newNote();
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
  addLayer(workspace.page, layer);
  workspace.markDirty();
  if (workspace.current.title === 'Untitled') {
    workspace.renameNote(file.name.replace(/\.[^.]+$/, ''));
  }
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
    const pages = workspace.pages;
    const only = pages[0];
    const noteIsEmpty = pages.length === 1 && !pageHasContent(only);
    if (noteIsEmpty) {
      for (const layer of only.layers) removeLayer(only, layer.id);
      workspace.current.pages = newPages;
      workspace.setPage(0);
    } else {
      workspace.current.pages.push(...newPages);
      workspace.setPage(workspace.current.pages.length - newPages.length);
    }
    workspace.markDirty();
    surface.redraw();
    syncUI();
    if (workspace.current.title === 'Untitled') {
      workspace.renameNote(file.name.replace(/\.[^.]+$/, ''));
    }
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
    { id: 'shape', label: 'Shapes', icon: 'shapeRect' },
    { id: 'select', label: 'Select', icon: 'select' },
    { id: 'eraser', label: 'Eraser', icon: 'eraser' },
  ],
  quickColors: QUICK_COLORS,
  onSelectTool: (id) => {
    if (id === 'shape') {
      // The shape button opens the shape picker, like the reference.
      openShapeMenu(toolbarEl.querySelector('[data-tool="shape"]') || toolbarEl);
      return;
    }
    if (id !== 'select') clearSelection();
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
    const page = workspace.page;
    if (page && history.undo(page.strokes)) {
      workspace.markDirty();
      surface.redraw();
      syncUI();
    }
  },
  onRedo: () => {
    const page = workspace.page;
    if (page && history.redo(page.strokes)) {
      workspace.markDirty();
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
  onPrevPage: () => {
    workspace.setPage(workspace.pageIndex - 1);
    surface.redraw();
    syncUI();
  },
  onNextPage: () => {
    workspace.setPage(workspace.pageIndex + 1);
    surface.redraw();
    syncUI();
  },
  onBack: () => {
    workspace.save();
    showScreen('library');
  },
});

// --- selection + transform -------------------------------------------------
// `selected` is the subset of the current page's strokes that the selection
// box is acting on.
let selected = [];
let transformBefore = null; // point snapshot taken when a gesture starts
let transformStrokes = null;
let transformTimer = 0;
let rotateLast = null;
let rotateStart = null;

// The transforms mutate the strokes in place, so a gesture has to be
// bracketed by a snapshot for undo to work. The overlay reports incremental
// movement with no start/end event, so the gesture is closed by a short
// quiet period.
function beginTransform() {
  if (!transformBefore) {
    transformStrokes = [...selected];
    transformBefore = snapshotStrokes(transformStrokes);
  }
  clearTimeout(transformTimer);
  transformTimer = setTimeout(() => {
    if (transformBefore && transformStrokes) {
      const after = snapshotStrokes(transformStrokes);
      history.commit(transformEntry(transformStrokes, transformBefore, after));
      workspace.markDirty();
    }
    transformBefore = null;
    transformStrokes = null;
  }, 500);
}

const selection = buildSelection({
  getViewport: () => viewport,
  getCanvasRect: () => canvas.getBoundingClientRect(),
  showEdgeHandles: false,
  onMove: ({ dx, dy }) => {
    if (selected.length === 0) return;
    beginTransform();
    translateStrokes(selected, dx / viewport.zoom, dy / viewport.zoom);
    surface.redraw();
    syncSelection();
  },
  onScale: (handle, { dx, dy }) => {
    if (selected.length === 0) return;
    beginTransform();
    const b = boundsOf(selected);
    if (!b) return;
    const ux = dx / viewport.zoom;
    const uy = dy / viewport.zoom;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    // How far each edge moves: +1 means the right/bottom edge follows the
    // pointer, -1 means the left/top edge does.
    const DX = { tl: -1, l: -1, bl: -1, t: 0, b: 0, r: 1, tr: 1, br: 1 };
    const DY = { tl: -1, t: -1, tr: -1, l: 0, r: 0, bl: 1, b: 1, br: 1 };
    const sx = w > 0 ? (w + DX[handle] * ux) / w : 1;
    const sy = h > 0 ? (h + DY[handle] * uy) / h : 1;
    // The opposite corner/edge stays put.
    const anchor = {
      tl: { x: b.maxX, y: b.maxY },
      t: { x: (b.minX + b.maxX) / 2, y: b.maxY },
      tr: { x: b.minX, y: b.maxY },
      r: { x: b.minX, y: (b.minY + b.maxY) / 2 },
      br: { x: b.minX, y: b.minY },
      b: { x: (b.minX + b.maxX) / 2, y: b.minY },
      bl: { x: b.maxX, y: b.minY },
      l: { x: b.maxX, y: (b.minY + b.maxY) / 2 },
    }[handle];
    scaleStrokes(selected, anchor.x, anchor.y, sx, sy);
    surface.redraw();
    syncSelection();
  },
  onRotate: ({ x, y, startX, startY }) => {
    if (selected.length === 0) return;
    beginTransform();
    const b = boundsOf(selected);
    if (!b) return;
    if (rotateStart !== startX) {
      rotateLast = null;
      rotateStart = startX;
    }
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const c = pageToScreen(cx, cy, viewport);
    const a1 = Math.atan2(y - c.y, x - c.x);
    if (rotateLast !== null) {
      rotateStrokes(selected, cx, cy, a1 - rotateLast);
      surface.redraw();
      syncSelection();
    }
    rotateLast = a1;
    const deg = ((a1 * 180) / Math.PI + 450) % 360;
    dial.show(c.x, c.y);
    dial.setAngle(deg);
  },
  onDeselect: () => {
    selected = [];
    syncSelection();
  },
  onSelectAll: () => {
    const page = workspace.page;
    if (!page) return;
    selected = [...page.strokes];
    syncSelection();
  },
});
document.body.appendChild(selection.element);

// The rotation dial, shown while the selection is being rotated.
const dial = buildRotationDial({
  onChange: (deg) => {
    if (selected.length === 0) return;
    const b = boundsOf(selected);
    if (!b) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    rotateStrokes(selected, cx, cy, (deg * Math.PI) / 180);
    surface.redraw();
    syncSelection();
  },
});
document.body.appendChild(dial.element);

// The ruler, which follows the viewport.
const ruler = buildRuler({ getViewport: () => viewport });
document.body.appendChild(ruler.element);
let rulerVisible = false;

function syncSelection() {
  const b = selected.length > 0 ? boundsOf(selected) : null;
  selection.update({ bounds: b, visible: Boolean(b) });
}

function clearSelection() {
  if (selected.length === 0) return;
  selected = [];
  syncSelection();
}

// --- the shape menu --------------------------------------------------------
const shapeMenu = buildShapeMenu({
  onSelectShape: (kind) => {
    setToolOptions('shape', { shape: kind });
    setCurrentTool('shape');
    shapeMenu.close();
    syncUI();
  },
  onSelectFill: (fill) => {
    setToolOptions('shape', { fill });
    syncUI();
  },
});
document.body.appendChild(shapeMenu.element);

function openShapeMenu(anchor) {
  const tool = getCurrentTool();
  shapeMenu.update({
    shape: tool.options.shape ?? 'rect',
    fill: tool.options.fill ?? 'freeform',
  });
  for (const p of ALL_POPOVERS) p.close();
  shapeMenu.open(anchor);
}

// --- prompts ---------------------------------------------------------------
// A text prompt and a list prompt, both floating cards over the canvas.
const textPromptPopover = createPopover({ className: 'pop-prompt', label: 'Prompt' });
const listPromptPopover = createPopover({ className: 'pop-prompt', label: 'Choose' });

function openTextPrompt({ title, value = '', placeholder = '', onSubmit }) {
  const prompt = buildTextPrompt({
    title,
    value,
    placeholder,
    onSubmit: (text) => {
      textPromptPopover.close();
      onSubmit(text);
    },
    onCancel: () => textPromptPopover.close(),
  });
  textPromptPopover.el.textContent = '';
  textPromptPopover.el.appendChild(prompt.el);
  for (const p of ALL_POPOVERS) p.close();
  textPromptPopover.open(toolbarEl.querySelector('.pill-right') || toolbarEl);
  prompt.focus();
}

function openFolderPicker() {
  const items = [
    { id: null, label: 'No folder' },
    ...workspace.folders.map((f) => ({ id: f.id, label: f.name, color: f.color })),
  ];
  const list = buildListPrompt({
    title: 'Move to a folder',
    items,
    emptyText: 'No folders yet.',
    onSelect: async (item) => {
      listPromptPopover.close();
      if (workspace.current) {
        await workspace.moveToFolder(workspace.current.id, item.id);
        toast(item.id ? `Moved to "${item.label}".` : 'Removed from its folder.');
      }
    },
    onCancel: () => listPromptPopover.close(),
  });
  listPromptPopover.el.textContent = '';
  listPromptPopover.el.appendChild(list.el);
  for (const p of ALL_POPOVERS) p.close();
  listPromptPopover.open(toolbarEl.querySelector('.pill-right') || toolbarEl);
}

// --- library screen --------------------------------------------------------
const library = buildLibrary(libraryEl, {
  onNewNote: () => {
    workspace.newNote();
    showScreen('editor');
    surface.redraw();
    syncUI();
  },
  onOpenNote: async (id) => {
    await workspace.openNote(id);
    showScreen('editor');
    surface.redraw();
    syncUI();
  },
  onImportFile: () => {
    if (!workspace.current) workspace.newNote();
    fileInput.click();
  },
  onSearch: (q) => {
    library.update(workspace.libraryState({ screen: 'home', query: q }));
  },
  onSelectFolder: (id) => {
    library.update(workspace.libraryState({ screen: 'folder', folderId: id }));
  },
  onSelectScreen: (name) => {
    library.update(workspace.libraryState({ screen: name }));
  },  onNewFolder: () => {
    openTextPrompt({
      title: 'Folder name',
      placeholder: 'Math 220',
      onSubmit: async (text) => {
        await workspace.createFolder(text);
        toast(`Created the folder "${text}".`);
      },
    });
  },
  onSettings: () => {
    toast('Settings come next.');
  },
  onTemplate: () => {
    toast('Templates come next.');
  },
  onRecordAudio: () => {
    toast('Audio recording comes next.');
  },
  onNotifications: () => {
    toast('No notifications yet.');
  },
  onMore: () => {
    toast('Nothing else here yet.');
  },
});

// --- state sync ------------------------------------------------------------
function strokeValue() {
  const tool = getCurrentTool();
  if (tool.kind === 'eraser') return tool.options.radius;
  if (tool.kind === 'select') return 3;
  return tool.options.width;
}

function strokeRange() {
  const tool = getCurrentTool();
  if (tool.kind === 'eraser') return { min: 4, max: 40 };
  if (tool.kind === 'select') return { min: 1, max: 20 };
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
    pageIndex: workspace.pageIndex,
    pageCount: workspace.pages.length,
    showColors: tool.kind === 'ink' || tool.kind === 'shape',
    showWidths: tool.kind !== 'select',
  });
  syncStrokePanel();
  if (palettePopover.isOpen()) {
    palette.update({ color: colorForTool(), palettes, paletteIndex });
  }
  canvas.style.cursor =
    tool.id === 'eraser' ? 'pointer' : tool.id === 'select' ? 'default' : 'crosshair';
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
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return;
  }
  if (e.key === 'd' || e.key === 'D') setDebug(!debugOn);
  if (e.key === 'Escape') {
    palettePopover.close();
    strokePopover.close();
    morePopover.close();
  }
  // Ctrl/Cmd + Z / Shift + Z for undo / redo.
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const page = workspace.page;
    if (!page) return;
    if (e.shiftKey) {
      if (history.redo(page.strokes)) {
        workspace.markDirty();
        surface.redraw();
        syncUI();
      }
    } else if (history.undo(page.strokes)) {
      workspace.markDirty();
      surface.redraw();
      syncUI();
    }
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

// Save when the tab is hidden, so a swipe-to-close does not lose work.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') workspace.save();
});
window.addEventListener('pagehide', () => workspace.save());

// --- boot ------------------------------------------------------------------
async function boot() {
  const persistent = await workspace.init();
  if (!persistent) {
    // Not fatal: the app works as a scratchpad.
    console.warn('[inkpad] storage unavailable - notes will not be saved');
  }
  if (workspace.notes.length > 0) {
    await workspace.openNote(workspace.notes[0].id);
  } else {
    workspace.newNote();
  }
  surface.resize();
  syncUI();
  setDebug(false);
  if (!persistent) {
    toast('Notes cannot be saved here (storage is blocked).', 5000);
  }
}

boot();

registerServiceWorker({
  onUpdate: () => toast('A new version is ready — reopen Inkpad to update.', 6000),
});

// Console handle for diagnosis: inspect live state with
//   __inkpad.strokes.length, __inkpad.viewport, ...
window.__inkpad = {
  get note() {
    return workspace.current;
  },
  get selected() {
    return selected;
  },
  get page() {
    return workspace.page;
  },
  get pageIndex() {
    return workspace.pageIndex;
  },
  get strokes() {
    return workspace.page ? workspace.page.strokes : [];
  },
  get notes() {
    return workspace.ws.notes;
  },
  workspace,
  viewport,
  surface,
  history,
  palettes,
  showScreen,
  importFile,
  setPage: (i) => {
    workspace.setPage(i);
    surface.redraw();
    syncUI();
  },
};
