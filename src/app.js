// app.js — bootstrap: wire modules together.
//
// Owns the toolbar state, the popovers, the file importer and the two
// screens (library / editor). The DOCUMENT itself lives in src/workspace.js.
//
// Screen model:
//   library  the Notability-style notes/folders screen
//   editor   the canvas + floating toolbar

import { createViewport, pageToScreen, clampZoom } from './coord.js';
import { createDrawingSurface } from './canvas.js';
import {
  createHistory,
  addEntry,
  deleteEntry,
  removeStrokesById,
  insertStrokesAt,
  cloneStroke,
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
  fingerAction,
  toggleFingerDrawing,
  resetFingerDrawing,
  subscribeInput,
} from './input.js';
import { createImageLayer, addLayer, removeLayer, pageHasContent, createPage, containFit } from './pages.js';
import { rasterizePdf } from './pdf.js';
import { createWorkspace } from './workspace.js';
import { downloadNoteAsPng, printNote, pageRegionToDataUrl } from './export.js';
import { registerServiceWorker } from './sw-register.js';
import { buildAskAi } from './ui/ask-ai.js';
import { buildTextInput } from './ui/text-input.js';
import { buildShapeEditor } from './ui/shape-editor.js';
import { createText, isTextObject, syncTextAnchor, fitTextSize } from './text.js';
import { isShapeStroke, setVertex, toSquare } from './shapes.js';
import { buildSettings } from './ui/settings.js';
import {
  loadPresets,
  addPreset,
  updatePreset,
  deletePreset,
  setActivePreset,
  getActivePresetId,
  getPreset,
} from './ai/presets.js';
import { callProvider, describeError } from './ai/client.js';
import { fetchModels } from './ai/models.js';
import { describeKind, PROVIDER_KINDS } from './ai/providers.js';
import { buildShapeMenu } from './ui/shape-menu.js';
import { buildSelectMenu } from './ui/select-menu.js';
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
  strokesInRect,
} from './transform.js';
import { snapshotStrokes, restoreStrokes, transformEntry } from './strokes.js';
import {
  pageRect,
  docSize,
  resolvePageAt,
  PAGE_MARGIN,
  DEFAULT_PAGE_W,
  DEFAULT_PAGE_H,
} from './layout.js';

const canvas = document.getElementById('page');
const paperCanvas = document.getElementById('paper');
const debugEl = document.getElementById('debug');
const toolbarEl = document.getElementById('toolbar');
const bottomNavEl = document.getElementById('bottomnav');
const scrollbarEl = document.getElementById('scrollbar');
const scrollThumbEl = document.getElementById('scrollbar-thumb');
const penRingEl = document.getElementById('penring');
const fileInput = document.getElementById('file-input');
const toastEl = document.getElementById('toast');
const libraryEl = document.getElementById('library');
const editorEl = document.getElementById('editor');

const viewport = createViewport();
const history = createHistory();

// History is global, pages are not. An entry is bound to the page's strokes
// array when it is recorded, so Undo after scrolling to another sheet still
// reverses the edit that was actually made instead of poking the wrong page.
function onPage(page, entry) {
  return {
    undo: () => entry.undo(page.strokes),
    redo: () => entry.redo(page.strokes),
  };
}

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
let toastAction = null;

function toast(message, ms = 3200, action = null) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastAction = action;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      const fn = toastAction?.onClick;
      hideToast();
      if (fn) fn();
    });
    toastEl.appendChild(btn);
  }
  toastEl.hidden = false;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  if (!toastEl) return;
  toastEl.classList.remove('is-on');
  toastAction = null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastEl.textContent = '';
  }, 200);
}

// --- workspace -------------------------------------------------------------
const workspace = createWorkspace({ onChange: () => syncUI() });

// --- pages in document space -----------------------------------------------
// Ink is stored in PAGE-local coordinates. The selection overlay, the shape
// editor and the pen ring speak SCREEN pixels, so they are handed a viewport
// SHIFTED by the active page's origin: pageToScreen(local) then lands exactly
// where the ink was drawn, at any zoom and pan.
function pageViewport(index = workspace.pageIndex) {
  const r = workspace.pages.length ? pageRect(workspace.pages, index) : null;
  if (!r) return viewport;
  return {
    ...viewport,
    panX: viewport.panX + r.x * viewport.zoom,
    panY: viewport.panY + r.y * viewport.zoom,
  };
}

function pageSizeOf(page) {
  return {
    w: Number.isFinite(page?.w) && page.w > 0 ? page.w : DEFAULT_PAGE_W,
    h: Number.isFinite(page?.h) && page.h > 0 ? page.h : DEFAULT_PAGE_H,
  };
}

// The page a tool is acting on. Switching pages drops the selection: those
// strokes live on the old sheet, and their overlay would land in the wrong
// place.
function activatePage(index) {
  if (!workspace.pages[index] || workspace.pageIndex === index) return;
  workspace.setPage(index);
  if (selected.length > 0) {
    selected = [];
    syncSelection();
  }
}

// While scrolling, the page indicator follows the page in the middle of the
// screen. Debounced so a continuous scroll does not thrash the store.
let pageSyncTimer = 0;

function schedulePageSync() {
  clearTimeout(pageSyncTimer);
  pageSyncTimer = setTimeout(() => {
    const index = centeredPageIndex();
    if (index >= 0 && index !== workspace.pageIndex) activatePage(index);
    updatePageChrome();
  }, 160);
}

function centeredPageIndex() {
  const pages = workspace.pages;
  if (pages.length === 0) return -1;
  const rect = canvas.getBoundingClientRect();
  const cx = -viewport.panX / viewport.zoom + rect.width / (2 * viewport.zoom);
  const cy = -viewport.panY / viewport.zoom + rect.height / (2 * viewport.zoom);
  const hit = resolvePageAt(pages, cx, cy);
  if (hit) return hit.index;
  // In a gap: the page whose bottom is closest below the centre wins.
  for (let i = 0; i < pages.length; i++) {
    const r = pageRect(pages, i);
    if (cy < r.y + r.h) return i;
  }
  return pages.length - 1;
}

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
  const s = pageToScreen(x, y, pageViewport(info.pageIndex ?? workspace.pageIndex));
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
// The ink canvas sits ON TOP of the paper canvas: sheets, ruling and imported
// layers are painted underneath, so translucent ink can keep its
// 'destination-over' behaviour and still show over the paper (see canvas.js).
const AUTO_APPEND_MARGIN = 56;

function strokeBottom(stroke) {
  let maxY = -Infinity;
  for (const p of stroke.points ?? []) if (p.y > maxY) maxY = p.y;
  if (isTextObject(stroke)) maxY = Math.max(maxY, (stroke.y ?? 0) + (stroke.h ?? 0));
  return maxY;
}

const surface = createDrawingSurface(
  canvas,
  viewport,
  {
    getPages: () => workspace.pages,
    onActivePage: (index) => activatePage(index),
    commitStroke: (stroke, pageIndex) => {
      const page = workspace.pages[pageIndex] ?? workspace.page;
      if (!page) return;
      history.commit(onPage(page, addEntry(stroke, page.strokes.length)));
      page.strokes.push(stroke);
      // Writing at the bottom of the LAST page grows the notebook, so you
      // never hit a wall. The new sheet appears BELOW; the active page does
      // not change, so the stroke stays exactly where it was put.
      if (pageIndex === workspace.pages.length - 1) {
        const size = pageSizeOf(page);
        if (strokeBottom(stroke) > size.h - AUTO_APPEND_MARGIN) {
          workspace.addPage({ select: false });
        }
      }
      workspace.markDirty();
      syncUI();
    },
    erasePath: (path, pageIndex) => {
      const page = workspace.pages[pageIndex] ?? workspace.page;
      if (!page || path.length === 0) return;
      const ids = eraseHitIds(page.strokes, path, getToolOptions('eraser').radius);
      if (ids.length === 0) return; // hit nothing: no history entry, no repaint
      history.commit(onPage(page, deleteEntry(removeStrokesById(page.strokes, ids))));
      workspace.markDirty();
      surface.redraw();
      syncUI();
    },
    onPenHover,
    onViewportChange: () => {
      zoomPct = Math.round(viewport.zoom * 100);
      if (rulerVisible) ruler.update();
      // The selection box is drawn in screen pixels, so it has to follow a
      // pan or a zoom just like the ink does.
      if (selected.length > 0) syncSelection();
      updatePageChrome();
      schedulePageSync();
    },
    onLasso: (path, pageIndex) => {
      const page = workspace.pages[pageIndex] ?? workspace.page;
      if (!page) return;
      activatePage(pageIndex);
      // A tap clears the selection.
      if (path.length < 3) {
        selected = [];
        syncSelection();
        return;
      }
      selected = strokesInPolygon(page.strokes, path);
      syncSelection();
    },
    onSelectBox: (box, pageIndex) => {
      const page = workspace.pages[pageIndex] ?? workspace.page;
      if (!page) return;
      activatePage(pageIndex);
      selected = strokesInRect(page.strokes, box);
      syncSelection();
    },
    onTextBox: ({ x, y, w, h }, pageIndex) => {
      // A tap with no drag gets a default box, so the tool still works.
      const box = { x, y, w: w || 260, h: h || 64, pageIndex };
      pendingTextBox = box;
      const s = pageToScreen(box.x, box.y, pageViewport(pageIndex));
      const rect = canvas.getBoundingClientRect();
      const tool = getCurrentTool();
      const zoom = viewport.zoom;
      textInput.openAt(rect.left + s.x, rect.top + s.y, {
        color: tool.options.color,
        size: Math.max(16, (tool.options.size ?? 28) * zoom),
        width: box.w * zoom,
        height: box.h * zoom,
      });
    },
    debug: (text) => {
      debugEl.textContent = text;
    },
  },
  { paper: paperCanvas },
);

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
    else if (tool.kind === 'text') setToolOptions('text', { size: v });
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

// --- the "more" menu (B3) ---------------------------------------------------
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
    scrollToPage(workspace.pageIndex);
    morePopover.close();
  });
  morePopover.el.appendChild(addPageBtn);

  const resetView = el('button', 'menu-item');
  resetView.type = 'button';
  resetView.appendChild(el('span', 'menu-label', 'Fit page to width'));
  resetView.appendChild(el('span', 'menu-value', `${zoomPct}%`));
  resetView.addEventListener('click', () => {
    fitPage();
    zoomPct = Math.round(viewport.zoom * 100);
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
  fingerItem.appendChild(el('span', 'menu-label', 'Finger'));
  const fingerState = el('span', 'menu-value');
  fingerItem.appendChild(fingerState);
  fingerItem.addEventListener('click', () => {
    toggleFingerDrawing();
    syncUI();
    buildMoreMenu();
  });
  morePopover.el.appendChild(fingerItem);
  fingerState.textContent = { draw: 'Draws', pan: 'Pans', none: 'Ignored' }[fingerAction()];

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
//
// A layer is placed in PAGE space, at the part of the page that is visible
// right now. That is what makes it pan and zoom with the ink: zoom in to
// write on an imported photo and the photo comes with you.

// The page-space rectangle of the visible area, ON THE ACTIVE PAGE and in
// PAGE-LOCAL coordinates. A new image is contain-fitted into this, so an
// import lands in front of the user instead of on some other sheet.
function visiblePageRect() {
  const rect = canvas.getBoundingClientRect();
  const doc = {
    x: -viewport.panX / viewport.zoom,
    y: -viewport.panY / viewport.zoom,
    w: rect.width / viewport.zoom,
    h: rect.height / viewport.zoom,
  };
  const pr = workspace.pages.length
    ? pageRect(workspace.pages, workspace.pageIndex)
    : null;
  if (!pr) return doc;
  const x1 = Math.max(pr.x, doc.x);
  const y1 = Math.max(pr.y, doc.y);
  const x2 = Math.min(pr.x + pr.w, doc.x + doc.w);
  const y2 = Math.min(pr.y + pr.h, doc.y + doc.h);
  return {
    x: x1 - pr.x,
    y: y1 - pr.y,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1),
  };
}

// Fit an image into the visible page area.
function placeLayer(layer, view) {
  layer.rect = containFit(
    layer.naturalWidth,
    layer.naturalHeight,
    view.x,
    view.y,
    view.w,
    view.h,
  );
}

async function importFile(file) {
  if (!workspace.current) {
    workspace.newNote();
    fitPage();
  }
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
  const view = visiblePageRect();
  layer.onLoad = (l) => {
    placeLayer(l, view);
    surface.redraw();
  };
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
      // A PDF page keeps its own aspect ratio at the notebook's page width,
      // so a landscape slide is a landscape sheet, not a letterbox.
      const aspect = p.width > 0 ? p.height / p.width : DEFAULT_PAGE_H / DEFAULT_PAGE_W;
      const w = DEFAULT_PAGE_W;
      const h = Math.round(w * aspect);
      const pg = createPage({ name: `Page ${p.pageNumber}`, w, h, template: 'blank' });
      const layer = createImageLayer({
        blob: p.blob,
        url: p.url,
        name: file.name,
        kind: 'pdf',
        // The raster IS the page, so it occupies the whole sheet exactly.
        rect: { x: 0, y: 0, w, h },
      });
      layer.onLoad = () => surface.redraw();
      layer.pageNumber = p.pageNumber;
      pg.layers.push(layer);
      return pg;
    });

    // A PDF into an empty note REPLACES it (no blank page 1 in front);
    // into a note with content it is appended.
    const pages = workspace.pages;
    const only = pages[0];
    const noteIsEmpty = pages.length === 1 && !pageHasContent(only);
    let target = 0;
    if (noteIsEmpty) {
      for (const layer of only.layers) removeLayer(only, layer.id);
      workspace.current.pages = newPages;
      workspace.setPage(0);
    } else {
      target = workspace.current.pages.length;
      workspace.current.pages.push(...newPages);
      workspace.setPage(target);
    }
    workspace.markDirty();
    fitPage();
    scrollToPage(target);
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
    { id: 'text', label: 'Text', icon: 'text' },
    { id: 'eraser', label: 'Eraser', icon: 'eraser' },
  ],
  quickColors: QUICK_COLORS,
  onSelectTool: (id) => {
    if (id === 'shape') {
      // Tapping the shape button selects the shape tool AND opens the
      // picker, so you can pick a shape or just draw the default one.
      setCurrentTool('shape');
      syncUI();
      openShapeMenu(toolbarEl.querySelector('[data-tool="shape"]') || toolbarEl);
      return;
    }
    if (id === 'select') {
      // Tapping the select button selects the tool AND opens the lasso /
      // boxed picker, so the gesture mode is always one tap away.
      setCurrentTool('select');
      syncUI();
      openSelectMenu(toolbarEl.querySelector('[data-tool="select"]') || toolbarEl);
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
  onAskAi: (anchor) => {
    syncAi();
    askAiPopover.open(anchor);
    askAi.focus();
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
    scrollToPage(workspace.pageIndex - 1);
  },
  onNextPage: () => {
    scrollToPage(workspace.pageIndex + 1);
  },
  onBack: () => {
    workspace.save();
    showScreen('library');
  },
});

// The page navigator lives at the BOTTOM of the screen: the document is
// scrollable now, so "which page am I on" belongs next to the thumb, not in
// the top bar where the tools are.
if (bottomNavEl && toolbar.pagesElement) bottomNavEl.appendChild(toolbar.pagesElement);

// --- scrolling + page chrome (B3) ------------------------------------------
// The page navigator, the scrollbar and "fit the page" all move the
// viewport through surface.panTo(), so clamping and repainting happen in one
// place (canvas.js).

// Fit the ACTIVE page to the width of the screen. Capped at 100% so a wide
// desktop window does not blow one page up to fill the screen.
function fitPage() {
  const rect = canvas.getBoundingClientRect();
  const pages = workspace.pages;
  if (!pages.length || !(rect.width > 0)) return;
  const r = pageRect(pages, workspace.pageIndex) ?? pageRect(pages, 0);
  if (!r) return;
  const fit = (rect.width - PAGE_MARGIN * 2) / r.w;
  viewport.zoom = clampZoom(Math.min(1, fit));
  surface.panTo({ x: 0, y: r.y - PAGE_MARGIN / viewport.zoom });
}

// Bring a page to the top of the screen without changing the zoom.
function scrollToPage(index) {
  const pages = workspace.pages;
  if (!pages.length) return;
  const i = Math.max(0, Math.min(pages.length - 1, index));
  workspace.setPage(i);
  const r = pageRect(pages, i);
  surface.panTo({ x: 0, y: r.y - PAGE_MARGIN / viewport.zoom });
  syncUI();
}

function updateScrollbar() {
  if (!scrollbarEl || !scrollThumbEl) return;
  const pages = workspace.pages;
  // Measure only once the bar is laid out: a `hidden` element has no height,
  // so asking before showing it would keep it hidden forever.
  scrollbarEl.hidden = false;
  const trackH = scrollbarEl.clientHeight;
  const rect = canvas.getBoundingClientRect();
  if (!pages.length || trackH <= 0 || !(rect.height > 0)) {
    scrollbarEl.hidden = true;
    return;
  }
  const doc = docSize(pages);
  const viewH = rect.height / viewport.zoom;
  if (doc.h <= viewH + PAGE_MARGIN * 2) {
    // The whole document fits: a scrollbar would be noise.
    scrollbarEl.hidden = true;
    return;
  }
  scrollbarEl.hidden = false;
  const thumbH = Math.max(36, Math.round(trackH * Math.min(1, viewH / doc.h)));
  const top = -viewport.panY / viewport.zoom;
  const frac = Math.max(0, Math.min(1, top / (doc.h - viewH)));
  const y = Math.round(frac * (trackH - thumbH));
  scrollThumbEl.style.height = `${thumbH}px`;
  scrollThumbEl.style.transform = `translateY(${y}px)`;
}

function updatePageChrome() {
  updateScrollbar();
  if (toolbar && toolbar.setPage) toolbar.setPage(workspace.pageIndex, workspace.pages.length);
  if (scrollbarEl) scrollbarEl.dataset.page = String(workspace.pageIndex + 1);
}

// Drag the thumb to scroll. The thumb maps the whole document, so grabbing it
// near the middle goes to the middle, like a normal scrollbar.
let scrollDrag = null;

if (scrollThumbEl && scrollbarEl) {
  scrollThumbEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    const pages = workspace.pages;
    if (!pages.length) return;
    const doc = docSize(pages);
    const rect = canvas.getBoundingClientRect();
    const viewH = rect.height / viewport.zoom;
    const trackH = scrollbarEl.clientHeight;
    const thumbH = scrollThumbEl.offsetHeight;
    scrollDrag = {
      id: e.pointerId,
      startY: e.clientY,
      startTop: -viewport.panY / viewport.zoom,
      span: Math.max(0, doc.h - viewH),
      travel: Math.max(1, trackH - thumbH),
    };
    try {
      scrollThumbEl.setPointerCapture(e.pointerId);
    } catch {
      // ignore: capture is an optimisation here
    }
  });
  scrollThumbEl.addEventListener('pointermove', (e) => {
    if (!scrollDrag || e.pointerId !== scrollDrag.id) return;
    const dy = e.clientY - scrollDrag.startY;
    surface.panTo({ y: scrollDrag.startTop + (dy / scrollDrag.travel) * scrollDrag.span });
  });
  const endDrag = (e) => {
    if (!scrollDrag || e.pointerId !== scrollDrag.id) return;
    scrollDrag = null;
    try {
      if (scrollThumbEl.hasPointerCapture(e.pointerId)) {
        scrollThumbEl.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
  };
  scrollThumbEl.addEventListener('pointerup', endDrag);
  scrollThumbEl.addEventListener('pointercancel', endDrag);
}

// --- selection + transform (B2) --------------------------------------------
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

// A text object's anchor lives in points[0]; keep x/y in step with it.
function syncTextAnchors() {
  for (const s of selected) {
    if (isTextObject(s)) syncTextAnchor(s);
  }
}

const selection = buildSelection({
  getViewport: () => pageViewport(),
  getCanvasRect: () => canvas.getBoundingClientRect(),
  showEdgeHandles: false,
  onMove: ({ dx, dy }) => {
    if (selected.length === 0) return;
    beginTransform();
    translateStrokes(selected, dx / viewport.zoom, dy / viewport.zoom);
    syncTextAnchors();
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
    syncTextAnchors();
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
      syncTextAnchors();
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
  onDuplicateSelection: () => duplicateSelection(),
  onDeleteSelection: () => deleteSelection(),
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
  syncShapeEditor();
}

function clearSelection() {
  if (selected.length === 0) return;
  selected = [];
  syncSelection();
}

// --- selection (B2) --------------------------------------------------------
// Boxed select, the lasso / boxed picker, and the selection actions.

const selectMenu = buildSelectMenu({
  onSelectMode: (mode) => {
    setToolOptions('select', { mode });
    syncUI();
  },
});

if (selectMenu.element) document.body.appendChild(selectMenu.element);

function openSelectMenu(anchor) {
  const mode = getToolOptions('select')?.mode ?? 'freeform';
  selectMenu.update({ mode });
  for (const p of ALL_POPOVERS) p.close();
  selectMenu.open(anchor);
}

// Duplicate every selected stroke, offset by 24 page units, with the copy
// inserted directly after its original. ONE history entry covers the batch.
function duplicateSelection() {
  const page = workspace.page;
  if (!page || selected.length === 0) return;
  const originals = selected
    .map((stroke) => ({ stroke, index: page.strokes.indexOf(stroke) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (originals.length === 0) return;

  const placed = [];
  let offset = 0;
  for (const { stroke, index } of originals) {
    const clone = cloneStroke(stroke);
    translateStrokes([clone], 24, 24);
    if (isTextObject(clone)) syncTextAnchor(clone);
    placed.push({ stroke: clone, index: index + offset + 1 });
    offset += 1;
  }

  insertStrokesAt(page.strokes, placed);
  const ids = placed.map((entry) => entry.stroke.id);
  history.commit(
    onPage(page, {
      undo: (strokes) => removeStrokesById(strokes, ids),
      redo: (strokes) => insertStrokesAt(strokes, placed),
    }),
  );
  selected = placed.map((entry) => entry.stroke);
  workspace.markDirty();
  surface.redraw();
  syncSelection();
  syncUI();
}

// Delete the selected strokes under one history entry.
function deleteSelection() {
  const page = workspace.page;
  if (!page || selected.length === 0) return;
  const removed = removeStrokesById(page.strokes, selected.map((stroke) => stroke.id));
  if (removed.length === 0) return;
  history.commit(onPage(page, deleteEntry(removed)));
  selected = [];
  workspace.markDirty();
  surface.redraw();
  syncSelection();
  syncUI();
}

// --- the shape menu --------------------------------------------------------
const shapeMenu = buildShapeMenu({
  onSelectShape: (kind) => {
    setToolOptions('shape', { shape: kind });
    setCurrentTool('shape');
    shapeMenu.close();
    syncUI();
  },
  onSelectMode: (mode) => {
    setToolOptions('shape', { mode });
    syncUI();
  },
});
document.body.appendChild(shapeMenu.element);

function openShapeMenu(anchor) {
  const tool = getCurrentTool();
  shapeMenu.update({
    shape: tool.options.shape ?? 'rect',
    mode: tool.options.mode ?? 'boxed',
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

// --- AI (B4) -----------------------------------------------------------------
// The user picks the provider; the app never rotates between providers on
// its own. Keys live in localStorage only and are never logged.

const AI_KINDS = PROVIDER_KINDS.map((kind) => describeKind(kind));

// The settings sheet is a full-screen overlay, so the anchor is only a hint.
function settingsAnchor() {
  return toolbarEl.querySelector('.pill-right') || toolbarEl;
}

const settings = buildSettings({
  onSave: (preset, { isNew }) => {
    if (isNew) addPreset(preset);
    else updatePreset(preset.id, preset);
    refreshSettings();
    syncAi();
  },
  onDelete: (preset) => {
    deletePreset(preset.id);
    refreshSettings();
    syncAi();
  },
  onSetActive: (id) => {
    setActivePreset(id);
    refreshSettings();
    syncAi();
  },
  onTest: async (preset) => {
    try {
      await callProvider(preset, { messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
      return { ok: true, message: `Connected to ${preset.label}.` };
    } catch (err) {
      return { ok: false, message: describeError(err) };
    }
  },
  onFetchModels: async (preset) => {
    const models = await fetchModels(preset);
    return models.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  },
});
document.body.appendChild(settings.element);

const askAi = buildAskAi({
  onSubmit: (question) => sendToAi(question),
  onClose: () => askAiPopover.close(),
  onOpenSettings: () => {
    askAiPopover.close();
    refreshSettings();
    settings.open(settingsAnchor());
  },
});
const askAiPopover = createPopover({ className: 'pop-ai', label: 'Ask AI' });
askAiPopover.el.appendChild(askAi.el);

let aiState = { ready: false, busy: false, answer: '', error: '' };

function activePreset() {
  const id = getActivePresetId();
  if (!id) return null;
  return getPreset(id) || null;
}

function refreshSettings() {
  settings.update({
    presets: loadPresets(),
    activeId: getActivePresetId(),
    kinds: AI_KINDS,
  });
}

function syncAi() {
  const preset = activePreset();
  const ready = Boolean(preset && preset.apiKey) || Boolean(preset && preset.auth === 'none');
  aiState = {
    ...aiState,
    ready,
    providerLabel: preset ? preset.label : 'No provider',
    canSendImage: preset ? preset.vision !== false : false,
    hasSelection: selected.length > 0,
  };
  askAi.update(aiState);
}

// The page (or the selection) as an image, for a provider that can read
// images. The selection is cropped to its bounds, so the AI sees the ink the
// user actually highlighted.
async function pageImageForAi() {
  const page = workspace.page;
  if (!page) return null;
  const bounds = selected.length > 0 ? boundsOf(selected) : null;
  const dataUrl = await pageRegionToDataUrl(page, { bounds, scale: 1 });
  return { dataUrl, mimeType: 'image/png' };
}

async function sendToAi(question) {
  const preset = activePreset();
  if (!preset) {
    syncAi();
    askAi.update({ ...aiState, error: 'Choose a provider first.' });
    return;
  }
  syncAi();
  askAi.update({ ...aiState, busy: true, error: '', answer: '' });
  try {
    const messages = [{ role: 'user', content: question }];
    let image = null;
    if (preset.vision !== false) {
      try {
        image = await pageImageForAi();
      } catch (err) {
        // A page with no ink renders to a blank image; that is fine.
        image = null;
      }
    }
    const res = await callProvider(preset, { messages, image, model: preset.model });
    aiState = { ...aiState, busy: false, answer: res.text || '', error: '' };
  } catch (err) {
    console.warn('[inkpad] AI request failed', err);
    aiState = { ...aiState, busy: false, answer: '', error: describeError(err) };
  }
  syncAi();
}

// --- shape editor ----------------------------------------------------------
// When exactly one shape is selected, its vertices become draggable. A vertex
// snaps to a nearby vertex or edge of another shape.
const shapeEditor = buildShapeEditor({
  getViewport: () => pageViewport(),
  getCanvasRect: () => canvas.getBoundingClientRect(),
  onChange: ({ stroke, index, x, y }) => {
    beginTransform();
    setVertex(stroke, index, x, y);
    surface.redraw();
    syncShapeEditor();
  },
  onCommit: () => {
    workspace.markDirty();
  },
  onSquare: (stroke) => {
    beginTransform();
    if (toSquare(stroke)) {
      surface.redraw();
      syncShapeEditor();
    }
  },
  onDelete: (stroke) => {
    const page = workspace.page;
    if (!page) return;
    const removed = removeStrokesById(page.strokes, [stroke.id]);
    if (removed.length === 0) return;
    history.commit(onPage(page, deleteEntry(removed)));
    selected = [];
    workspace.markDirty();
    surface.redraw();
    syncSelection();
    syncShapeEditor();
  },
});
document.body.appendChild(shapeEditor.element);

function syncShapeEditor() {
  const page = workspace.page;
  const shape = selected.length === 1 && isShapeStroke(selected[0]) ? selected[0] : null;
  if (!shape || !page) {
    shapeEditor.setVisible(false);
    return;
  }
  const others = page.strokes.filter((s) => s !== shape);
  // The editor must be VISIBLE before it positions its handles, or it
  // bails out of update() and never creates them.
  shapeEditor.setVisible(true);
  shapeEditor.update({ stroke: shape, others, visible: true });
}

// --- text tool (B1) ----------------------------------------------------------
// Tap with the text tool and a caret appears where you tapped. The typed
// text becomes a real object on the page, so it can be selected, moved,
// saved and exported like any other ink.
let pendingTextBox = null;

// A canvas for measuring text, so the font can be fitted to its box.
const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');

const textInput = buildTextInput({
  onCommit: (text) => {
    const box = pendingTextBox;
    pendingTextBox = null;
    // The box remembers which page it was dragged on, so the text lands on
    // that sheet even if the user scrolled while typing.
    const page = box ? workspace.pages[box.pageIndex ?? workspace.pageIndex] : workspace.page;
    if (!page || !box || !text) {
      setCurrentTool('pen');
      syncUI();
      return;
    }
    const tool = getCurrentTool();
    const obj = createText({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      text,
      size: tool.options.size ?? 28,
      color: tool.options.color,
    });
    // Shrink the font until the text fits the box the user drew.
    if (obj.w > 0 && obj.h > 0) obj.size = fitTextSize(measureCtx, obj);
    history.commit(onPage(page, addEntry(obj, page.strokes.length)));
    page.strokes.push(obj);
    workspace.markDirty();
    surface.redraw();
    setCurrentTool('pen');
    syncUI();
  },
  onCancel: () => {
    pendingTextBox = null;
    setCurrentTool('pen');
    syncUI();
  },
});
document.body.appendChild(textInput.element);

// --- library screen --------------------------------------------------------
const library = buildLibrary(libraryEl, {
  onNewNote: () => {
    workspace.newNote();
    showScreen('editor');
    fitPage();
    syncUI();
  },
  onOpenNote: async (id) => {
    await workspace.openNote(id);
    showScreen('editor');
    fitPage();
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
    refreshSettings();
    settings.open(settingsAnchor());
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
  // The text tool's slider is the FONT SIZE, not a stroke width.
  if (tool.kind === 'text') return tool.options.size ?? 28;
  return tool.options.width;
}

function strokeRange() {
  const tool = getCurrentTool();
  if (tool.kind === 'eraser') return { min: 4, max: 40 };
  if (tool.kind === 'select') return { min: 1, max: 20 };
  if (tool.kind === 'text') return { min: 10, max: 96 };
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
    fingerAction: fingerAction(),
    pageIndex: workspace.pageIndex,
    pageCount: workspace.pages.length,
    showColors: tool.kind === 'ink' || tool.kind === 'shape' || tool.kind === 'text',
    showWidths: tool.kind !== 'select',
  });
  syncStrokePanel();
  updatePageChrome();
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
  fitPage();
  syncUI();
  setDebug(false);
  if (!persistent) {
    toast('Notes cannot be saved here (storage is blocked).', 5000);
  }
}

boot();

refreshSettings();
syncAi();

registerServiceWorker({
  onUpdate: (registration) => {
    // A new build is waiting. Say so, and offer the reload — otherwise the
    // old build keeps running and the app behaves like it ignored you.
    toast('A new version is ready.', 20000, {
      label: 'Reload',
      onClick: () => {
        if (registration && registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        window.location.reload();
      },
    });
  },
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
  get pages() {
    return workspace.pages;
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
  fitPage,
  scrollToPage,
  setPage: (i) => scrollToPage(i),
};
