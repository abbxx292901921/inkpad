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
import { downloadPageAsPng, downloadNoteAsPng, printNote, pageRegionToDataUrl } from './export.js';
import { registerServiceWorker } from './sw-register.js';
import { buildAskAi } from './ui/ask-ai.js';
import { buildTextInput } from './ui/text-input.js';
import { buildTextBar } from './ui/text-bar.js';
import { buildShapeEditor } from './ui/shape-editor.js';
import {
  createText,
  isTextObject,
  syncTextAnchor,
  fitTextSize,
  clampTextSize,
  DEFAULT_TEXT_SIZE,
} from './text.js';
import { isShapeStroke, setVertex, toSquare, createShapeStroke } from './shapes.js';
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
import { annotationPrompt, parseAnnotations } from './ai/annotate.js';
import { fetchModels } from './ai/models.js';
import { describeKind, PROVIDER_KINDS } from './ai/providers.js';
import { buildShapeMenu } from './ui/shape-menu.js';
import { buildSelectMenu } from './ui/select-menu.js';
import { buildPagesPanel } from './ui/pages-panel.js';
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
  PAGE_TEMPLATES,
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
      positionTextChrome();
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

// --- more menu (B3) ---------------------------------------------------------
// The document menu. Page-level actions live in the page sidebar; this card is
// about exporting, printing, the sheet template, the zoom presets and the
// note's identity.
function menuRow(label, value, onClick, { disabled = false, sub = false } = {}) {
  const b = el('button', `menu-item ${sub ? 'menu-item-sub' : ''}`.trim());
  b.type = 'button';
  b.appendChild(el('span', 'menu-label', label));
  if (value) b.appendChild(el('span', 'menu-value', value));
  b.disabled = disabled;
  if (disabled) b.setAttribute('aria-disabled', 'true');
  if (onClick && !disabled) b.addEventListener('click', onClick);
  return b;
}

function formatCreated(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'Unknown';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

// Zoom while keeping the ACTIVE page's top edge anchored at the top margin,
// so picking a preset never drops the reader into the middle of a sheet.
function setDocumentZoom(zoom) {
  const pages = workspace.pages;
  if (!pages.length) return;
  const r = pageRect(pages, workspace.pageIndex) ?? pageRect(pages, 0);
  viewport.zoom = clampZoom(zoom);
  zoomPct = Math.round(viewport.zoom * 100);
  if (r) surface.panTo({ x: 0, y: r.y - PAGE_MARGIN / viewport.zoom });
  else surface.redraw();
}

function buildMoreMenu() {
  morePopover.el.textContent = '';
  const note = workspace.current;
  const page = workspace.page;
  const rect = canvas.getBoundingClientRect();

  // --- quick export -------------------------------------------------------
  morePopover.el.appendChild(el('div', 'menu-head', 'Quick export'));
  morePopover.el.appendChild(menuRow('PDF, All Pages', null, async () => {
    morePopover.close();
    if (!note) return;
    try {
      await printNote(note, { title: note.title });
    } catch (err) {
      console.warn('[inkpad] print failed', err);
      toast('Could not open the print view.');
    }
  }));

  // --- export as ----------------------------------------------------------
  morePopover.el.appendChild(el('div', 'menu-head', 'Export as'));
  morePopover.el.appendChild(menuRow('PNG this page', null, async () => {
    morePopover.close();
    if (!page) return;
    try {
      await downloadPageAsPng(page);
      toast('Saved this page as a PNG.');
    } catch (err) {
      console.warn('[inkpad] PNG export failed', err);
      toast('Could not export the PNG.');
    }
  }));
  morePopover.el.appendChild(menuRow('PNG all pages', null, async () => {
    morePopover.close();
    if (!note) return;
    try {
      await downloadNoteAsPng(note);
      toast('Saved the pages as PNG.');
    } catch (err) {
      console.warn('[inkpad] PNG export failed', err);
      toast('Could not export the PNG.');
    }
  }));

  // --- sharing (placeholders, deliberately disabled) ----------------------
  morePopover.el.appendChild(el('div', 'menu-head', 'Share'));
  for (const label of ['Publish to Gallery', 'Create link', 'Start study session']) {
    morePopover.el.appendChild(menuRow(label, 'Coming soon', null, { disabled: true }));
  }

  // --- template -----------------------------------------------------------
  morePopover.el.appendChild(el('div', 'menu-head', 'Template settings'));
  const currentTemplate = page?.template ?? note?.template ?? 'lined';
  for (const kind of PAGE_TEMPLATES) {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    morePopover.el.appendChild(menuRow(label, kind === currentTemplate ? 'On' : null, () => {
      if (!workspace.current) return;
      // The note's template is the default for NEW pages; the page keeps its
      // own so an imported PDF sheet can stay blank. Setting both makes the
      // choice visible immediately on the sheet in front of the user.
      workspace.current.template = kind;
      if (workspace.page) workspace.page.template = kind;
      workspace.markDirty();
      surface.redraw();
      syncUI();
      buildMoreMenu();
    }, { sub: true }));
  }

  // --- view settings ------------------------------------------------------
  morePopover.el.appendChild(el('div', 'menu-head', 'View settings'));
  const sheet = pageSizeOf(page);
  morePopover.el.appendChild(menuRow('Fit page', `${zoomPct}%`, () => {
    morePopover.close();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    setDocumentZoom(Math.min(rect.width / sheet.w, rect.height / sheet.h));
  }, { sub: true }));
  morePopover.el.appendChild(menuRow('Fit width', null, () => {
    morePopover.close();
    if (!(rect.width > 0)) return;
    setDocumentZoom(rect.width / sheet.w);
  }, { sub: true }));
  morePopover.el.appendChild(menuRow('100%', null, () => {
    morePopover.close();
    setDocumentZoom(1);
  }, { sub: true }));

  // --- note info ----------------------------------------------------------
  morePopover.el.appendChild(el('div', 'menu-head', 'Note info'));
  const info = el('div', 'menu-info');
  info.appendChild(el('div', 'menu-info-title', note?.title || 'Untitled'));
  info.appendChild(el('div', 'menu-info-sub', `Created: ${formatCreated(note?.createdAt)}`));
  morePopover.el.appendChild(info);
  morePopover.el.appendChild(menuRow('Rename note', null, () => {
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
  }));
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
  onOpenPages: () => togglePagesPanel(),
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

// --- pages panel (B3) --------------------------------------------------------
// The page sidebar is a READ-ONLY view of the workspace. Every page mutation
// goes through workspace.js, which notifies syncUI(); syncUI() then pushes the
// new page list back into the panel. Thumbnails are cached by content and
// rendered one per frame inside the panel, never in a burst.
const pagesPanel = buildPagesPanel({
  onScrollToPage: (index) => scrollToPage(index),
  onAddPage: () => {
    workspace.addPage();
    scrollToPage(workspace.pageIndex);
    surface.redraw();
    syncUI();
  },
  onDuplicatePage: (index) => {
    const copy = workspace.duplicatePage(index, { onLayerLoad: () => surface.redraw() });
    if (!copy) return;
    scrollToPage(workspace.pageIndex);
    surface.redraw();
    syncUI();
  },
  onDeletePage: (index) => {
    workspace.removePage(index);
    scrollToPage(workspace.pageIndex);
    surface.redraw();
    syncUI();
  },
  onClearPage: (index) => {
    const page = workspace.pages[index];
    if (!page) return;
    if (!pageHasContent(page)) {
      toast('Nothing to clear.');
      return;
    }
    page.strokes.length = 0;
    for (const layer of [...page.layers]) removeLayer(page, layer.id);
    if (index === workspace.pageIndex) history.clear();
    workspace.markDirty();
    surface.redraw();
    syncUI();
    toast('Page cleared.');
  },
});
document.body.appendChild(pagesPanel.element);

function togglePagesPanel() {
  if (pagesPanel.isOpen()) {
    pagesPanel.close();
    return;
  }
  syncPagesPanel();
  pagesPanel.open();
}

function syncPagesPanel() {
  pagesPanel.update({ pages: workspace.pages, pageIndex: workspace.pageIndex });
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
  syncTextChrome();
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
  onSubmit: (question, options) => sendToAi(question, options),
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

// The FULL page as a JPEG. Annotations come back on a page-normalized grid,
// so the model must see the whole sheet, never a cropped selection. The
// render is sized to the vision budget: no edge over 1568px.
const AI_IMAGE_MAX_EDGE = 1568;
const AI_IMAGE_QUALITY = 0.85;
const AI_ANNOTATION_COLOR = '#0a84ff';
const AI_ANNOTATION_WIDTH = 2.5;

async function pageImageForAi() {
  const page = workspace.page;
  if (!page) return null;
  // The ink is PAGE-local, so the layout rect contributes its size, not its
  // document-space origin.
  const rect = pageRect(workspace.pages, workspace.pageIndex);
  const size = rect ?? pageSizeOf(page);
  const maxEdge = Math.max(1, size.w, size.h);
  const scale = Math.min(2, AI_IMAGE_MAX_EDGE / maxEdge);
  const bounds = { minX: 0, minY: 0, maxX: size.w, maxY: size.h };
  const dataUrl = await pageRegionToDataUrl(page, {
    bounds,
    scale,
    type: 'image/jpeg',
    quality: AI_IMAGE_QUALITY,
  });
  return { dataUrl, mimeType: 'image/jpeg' };
}

// Turn normalized annotations into real page objects. rect, ellipse and
// arrow are shape strokes; a callout is a text object with the label.
function applyAiAnnotations(page, annotations) {
  const rect = pageRect(workspace.pages, workspace.pageIndex);
  const size = rect ?? pageSizeOf(page);
  const sx = size.w / 1000;
  const sy = size.h / 1000;
  const added = [];
  for (const annotation of annotations) {
    const x = annotation.x * sx;
    const y = annotation.y * sy;
    const w = annotation.w * sx;
    const h = annotation.h * sy;
    if (annotation.type === 'callout') {
      if (!annotation.label) continue;
      added.push(createText({
        x, y, w, h, text: annotation.label, size: 20, color: AI_ANNOTATION_COLOR,
      }));
      continue;
    }
    added.push(createShapeStroke({
      kind: annotation.type,
      mode: 'boxed',
      box: { x0: x, y0: y, x1: x + w, y1: y + h },
      color: AI_ANNOTATION_COLOR,
      width: AI_ANNOTATION_WIDTH,
      opacity: 1,
    }));
  }
  if (added.length === 0) return 0;

  // One history entry for the whole batch, so a single Undo removes every
  // annotation the model added. Redo puts them back at their original z-order.
  const start = page.strokes.length;
  const placed = added.map((stroke, i) => ({ stroke, index: start + i }));
  page.strokes.push(...added);
  history.commit(onPage(page, {
    undo: (strokes) => {
      removeStrokesById(strokes, added.map((stroke) => stroke.id));
    },
    redo: (strokes) => {
      insertStrokesAt(strokes, placed);
    },
  }));
  workspace.markDirty();
  surface.redraw();
  syncUI();
  return added.length;
}

async function sendToAi(question, { annotate = false } = {}) {
  const preset = activePreset();
  if (!preset) {
    syncAi();
    askAi.update({ ...aiState, error: 'Choose a provider first.' });
    return;
  }
  syncAi();
  askAi.update({ ...aiState, busy: true, error: '', answer: '', annotating: 0 });
  try {
    const messages = annotate
      ? [{ role: 'system', content: annotationPrompt() }, { role: 'user', content: question }]
      : [{ role: 'user', content: question }];
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
    if (!annotate) {
      aiState = { ...aiState, busy: false, answer: res.text || '', error: '', annotating: 0 };
    } else {
      const parsed = parseAnnotations(res.text);
      if (!parsed.ok) {
        aiState = { ...aiState, busy: false, answer: '', error: '', annotating: 0 };
        toast('Could not read any annotations from that reply.');
      } else {
        const page = workspace.page;
        const added = page ? applyAiAnnotations(page, parsed.annotations) : 0;
        aiState = { ...aiState, busy: false, answer: '', error: '', annotating: added };
        if (added === 0) toast('That reply had no annotations to add.');
      }
    }
  } catch (err) {
    console.warn('[inkpad] AI request failed', err);
    aiState = { ...aiState, busy: false, answer: '', error: describeError(err), annotating: 0 };
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
      family: tool.options.family ?? 'sans',
      bold: tool.options.bold === true,
      italic: tool.options.italic === true,
      underline: tool.options.underline === true,
      align: tool.options.align ?? 'left',
      list: tool.options.list ?? 'none',
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

// --- text bar (B1) ----------------------------------------------------------
// The formatting bar is shown while the text tool is active or a text object
// is selected. A patch on a selected text object is a live, undoable edit; a
// patch with nothing selected becomes the default for the NEXT text box.
const TEXT_FORMAT_FIELDS = [
  'family', 'size', 'color', 'bold', 'italic', 'underline', 'align', 'list',
];
const TEXT_SNAPSHOT_FIELDS = [...TEXT_FORMAT_FIELDS, 'text', 'w', 'h', 'x', 'y'];

let textBar = null;
let titleEl = null;
let textBarPaletteCycle = false;
let lastTextColor = null;

function selectedTextObjects() {
  return selected.filter(isTextObject);
}

function textFormatState() {
  const source = selectedTextObjects()[0] ?? getToolOptions('text') ?? {};
  return {
    family: source.family ?? 'sans',
    size: source.size ?? DEFAULT_TEXT_SIZE,
    color: source.color ?? '#1b1b1b',
    bold: source.bold === true,
    italic: source.italic === true,
    underline: source.underline === true,
    align: source.align ?? 'left',
    list: source.list ?? 'none',
  };
}

function snapshotTextObjects(objects) {
  return objects.map((obj) => {
    const fields = {};
    for (const key of TEXT_SNAPSHOT_FIELDS) fields[key] = obj[key];
    return { obj, fields, points: (obj.points ?? []).map((p) => ({ ...p })) };
  });
}

function restoreTextObjects(snapshot) {
  for (const snap of snapshot) {
    Object.assign(snap.obj, snap.fields);
    snap.obj.points = snap.points.map((p) => ({ ...p }));
    // The wrapped lines, markers and underline positions must be recomputed
    // for the restored fields on the next paint.
    snap.obj.measured = null;
  }
}

function applyTextPatch(patch) {
  const objects = selectedTextObjects();
  if (objects.length === 0) {
    // Nothing selected: remember the choice for the next text box.
    const defaults = {};
    for (const key of TEXT_FORMAT_FIELDS) {
      if (!(key in patch)) continue;
      defaults[key] = key === 'size' ? clampTextSize(patch.size) : patch[key];
    }
    setToolOptions('text', defaults);
    syncUI();
    return;
  }

  const before = snapshotTextObjects(objects);
  for (const obj of objects) {
    for (const key of TEXT_FORMAT_FIELDS) {
      if (!(key in patch)) continue;
      obj[key] = key === 'size' ? clampTextSize(patch.size) : patch[key];
    }
    obj.measured = null;
  }
  const after = snapshotTextObjects(objects);

  const page = workspace.page;
  if (page) {
    history.commit(onPage(page, {
      undo: () => restoreTextObjects(before),
      redo: () => restoreTextObjects(after),
    }));
  }
  workspace.markDirty();
  surface.redraw();
  syncSelection();
}

// The palette belongs to the app, not to the bar. When it was opened from the
// bar WITH a text selection, intercept the colour choice before the palette's
// own handler can change the drawing tool's default, then patch the text.
function interceptTextBarColor(e) {
  if (!textBarPaletteCycle || selectedTextObjects().length === 0) return;
  const target = e.target;
  let hex = null;
  const swatch = target && target.closest ? target.closest('.pal-swatch') : null;
  if (swatch) {
    hex = swatch.title;
  } else if (target && target.classList && target.classList.contains('wheel-input')) {
    hex = target.value;
    if (hex === lastTextColor) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const userPalette = palettes[1];
    if (!userPalette.includes(hex)) userPalette.unshift(hex);
    paletteIndex = 1;
  }
  if (!hex) return;
  e.preventDefault();
  e.stopPropagation();
  if (hex === lastTextColor) return;
  lastTextColor = hex;
  applyTextPatch({ color: hex });
  palette.update({ color: hex, palettes, paletteIndex });
}

function openTextColor(anchor) {
  textBarPaletteCycle = true;
  lastTextColor = null;
  palette.update({ color: textFormatState().color, palettes, paletteIndex });
  openOnly(palettePopover);
  palettePopover.open(anchor, {
    onDismiss: () => {
      textBarPaletteCycle = false;
      lastTextColor = null;
    },
  });
}

function positionNoteTitle() {
  if (!titleEl) return;
  const title = workspace.current ? workspace.current.title : '';
  titleEl.textContent = title || 'Untitled';
  const rect = workspace.pages.length ? pageRect(workspace.pages, 0) : null;
  if (!rect || screen !== 'editor') {
    titleEl.hidden = true;
    return;
  }
  const s = pageToScreen(rect.x, rect.y, viewport);
  let top = Math.round(s.y - 36);
  // "Fit page" leaves only a small margin above page 1, so a title sitting
  // strictly above it would be clipped. Keep it in that margin while the page
  // top is on screen; once the page scrolls away the title scrolls with it.
  if (s.y >= 0 && top < 2) top = 2;
  titleEl.style.left = `${Math.round(s.x)}px`;
  titleEl.style.top = `${top}px`;
  titleEl.style.width = `${Math.max(80, Math.round(rect.w * viewport.zoom))}px`;
  titleEl.hidden = false;
}

function openNoteTitlePrompt() {
  openTextPrompt({
    title: 'Note name',
    value: workspace.current ? workspace.current.title : '',
    placeholder: 'Untitled',
    onSubmit: (text) => {
      workspace.renameNote(text);
      syncUI();
      positionNoteTitle();
    },
  });
}

function syncTextChrome() {
  const visible =
    screen === 'editor' &&
    (getCurrentTool().kind === 'text' || selectedTextObjects().length > 0);
  if (textBar) textBar.update({ ...textFormatState(), visible });
  positionNoteTitle();
}

function positionTextChrome() {
  if (textBar) textBar.reposition();
  positionNoteTitle();
}

textBar = buildTextBar({ onPatch: applyTextPatch, onOpenColor: openTextColor });
if (textBar.element) (editorEl || document.body).appendChild(textBar.element);

if (editorEl && document.createElement) {
  titleEl = document.createElement('button');
  titleEl.type = 'button';
  titleEl.className = 'note-title';
  titleEl.setAttribute('aria-label', 'Rename this note');
  titleEl.addEventListener('click', openNoteTitlePrompt);
  editorEl.appendChild(titleEl);
}

palettePopover.el.addEventListener('click', interceptTextBarColor, true);
palettePopover.el.addEventListener('input', interceptTextBarColor, true);

syncTextChrome();

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
  syncPagesPanel();
  syncTextChrome();
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
