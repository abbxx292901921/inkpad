// workspace.js — the document store.
//
// Owns WHICH notes exist, WHICH one is open, and how they are persisted. The
// UI (app.js) reads from here; this module never touches the DOM except to
// rasterise a thumbnail.
//
// PERSISTENCE: IndexedDB via src/storage.js. If IndexedDB is unavailable
// (private mode, blocked storage) the app still works — it just forgets
// everything on reload, and says so.
//
// AUTOSAVE: any change marks the note dirty and schedules a save. Saving is
// debounced so a burst of strokes writes once.

import { createNote, createPage, pageHasContent } from './pages.js';
import * as storage from './storage.js';
import { pageToPngBlob } from './export.js';

const AUTOSAVE_MS = 700;
// A thumbnail is a small data URL. Regenerating one costs a canvas render,
// so it is refreshed when the content changes rather than on every save.
const THUMBNAIL_MAX_EDGE = 240;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function createWorkspace({ onChange } = {}) {
  const ws = {
    notes: [], // note summaries, newest first
    folders: [],
    current: null, // the open note
    pageIndex: 0,
    persistent: false, // is IndexedDB actually working?
    lastError: null,
  };

  let saveTimer = 0;
  let saving = false;
  let dirty = false;
  // noteId -> the content signature the stored thumbnail was rendered from.
  const lastSignature = new Map();

  function notify() {
    if (onChange) onChange(ws);
  }

  function currentPage() {
    return ws.current ? ws.current.pages[ws.pageIndex] : null;
  }

  function currentPages() {
    return ws.current ? ws.current.pages : [];
  }

  // --- boot ----------------------------------------------------------------

  async function init() {
    if (!storage.isSupported()) {
      ws.persistent = false;
      return false;
    }
    try {
      await storage.open();
      ws.persistent = true;
      ws.notes = await storage.listNotes();
      ws.folders = await storage.listFolders();
      return true;
    } catch (err) {
      ws.lastError = err;
      ws.persistent = false;
      return false;
    }
  }

  // --- notes ---------------------------------------------------------------

  function newNote({ title = 'Untitled' } = {}) {
    const note = createNote({ title });
    ws.current = note;
    ws.pageIndex = 0;
    dirty = true;
    scheduleSave();
    notify();
    return note;
  }

  async function openNote(id) {
    if (!ws.persistent) {
      const local = ws.notes.find((n) => n.id === id);
      if (local && local._note) {
        ws.current = local._note;
        ws.pageIndex = 0;
        notify();
        return ws.current;
      }
      return null;
    }
    try {
      const record = await storage.loadNote(id);
      if (!record) return null;
      const note = await storage.hydrateNote(record);
      ws.current = note;
      ws.pageIndex = 0;
      notify();
      return note;
    } catch (err) {
      ws.lastError = err;
      return null;
    }
  }

  async function deleteNote(id) {
    if (ws.persistent) {
      try {
        await storage.deleteNote(id);
      } catch (err) {
        ws.lastError = err;
      }
    }
    ws.notes = ws.notes.filter((n) => n.id !== id);
    if (ws.current && ws.current.id === id) ws.current = null;
    notify();
  }

  async function renameNote(title) {
    if (!ws.current) return;
    ws.current.title = title;
    ws.current.updatedAt = Date.now();
    markDirty();
    notify();
  }

  // --- saving --------------------------------------------------------------

  function markDirty() {
    dirty = true;
    scheduleSave();
  }

  function scheduleSave() {
    if (!ws.current) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      save();
    }, AUTOSAVE_MS);
  }

  async function save() {
    if (!ws.current || !ws.persistent || !dirty || saving) return;
    saving = true;
    dirty = false;
    const note = ws.current;
    try {
      note.updatedAt = Date.now();
      await refreshThumbnail(note);
      await storage.saveNote(note);
      const summaries = await storage.listNotes();
      ws.notes = summaries;
      notify();
    } catch (err) {
      ws.lastError = err;
      dirty = true; // try again on the next change
    } finally {
      saving = false;
    }
  }

  // Rasterise the first page of the note as a small thumbnail for the
  // library list. Regenerated whenever the CONTENT changes (not on a timer):
  // a note saved empty at boot must pick up its ink as soon as there is ink.
  async function refreshThumbnail(note) {
    const first = note.pages[0];
    if (!first) return;
    const sig = contentSignature(first);
    if (note.thumbnail && sig === lastSignature.get(note.id)) return;
    try {
      const region = thumbnailRegion(first);
      const longest = Math.max(region.maxX - region.minX, region.maxY - region.minY);
      const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(longest, 1));
      const blob = await pageToPngBlob(first, { scale, bounds: region });
      note.thumbnail = await blobToDataUrl(blob);
      lastSignature.set(note.id, sig);
    } catch {
      // A thumbnail is a nicety; never let it break a save.
    }
  }

  // A cheap fingerprint of the page content. If it changes, the thumbnail is
  // out of date.
  function contentSignature(page) {
    let points = 0;
    for (const s of page.strokes) points += s.points.length;
    return `${page.strokes.length}:${points}:${page.layers.length}`;
  }

  // The thumbnail shows a PORTRAIT page, like the reference, with the content
  // centred on it — not a tight crop of the ink, which would look like a
  // letterbox in the card.
  function thumbnailRegion(page) {
    const b = contentBounds(page);
    if (!b) return { minX: 0, minY: 0, maxX: 794, maxY: 1123 };
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const contentW = Math.max(b.maxX - b.minX, 1);
    const contentH = Math.max(b.maxY - b.minY, 1);
    const aspect = 794 / 1123;
    let w = contentW + 120;
    let h = contentH + 120;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    return { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 };
  }

  function contentBounds(page) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of page.strokes) {
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  // --- pages ---------------------------------------------------------------

  function setPage(index) {
    if (!ws.current) return;
    const count = ws.current.pages.length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, index));
    ws.pageIndex = next;
    notify();
  }

  function addPage() {
    if (!ws.current) return;
    const page = createPage({ name: `Page ${ws.current.pages.length + 1}` });
    ws.current.pages.push(page);
    ws.pageIndex = ws.current.pages.length - 1;
    markDirty();
    notify();
    return page;
  }

  // --- folders -------------------------------------------------------------

  async function saveFolder(folder) {
    if (!ws.persistent) {
      ws.folders.push(folder);
      notify();
      return folder;
    }
    try {
      await storage.saveFolder(folder);
      ws.folders = await storage.listFolders();
      notify();
    } catch (err) {
      ws.lastError = err;
    }
    return folder;
  }

  async function createFolder(name, color = '#0a84ff') {
    const folder = {
      id: `folder-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      name: String(name || 'New folder').trim() || 'New folder',
      color,
      parentId: null,
      createdAt: Date.now(),
    };
    await saveFolder(folder);
    return folder;
  }

  async function renameFolder(id, name) {
    const folder = ws.folders.find((f) => f.id === id);
    if (!folder) return null;
    folder.name = String(name || '').trim() || folder.name;
    if (ws.persistent) {
      try {
        await storage.saveFolder(folder);
      } catch (err) {
        ws.lastError = err;
      }
    }
    notify();
    return folder;
  }

  async function deleteFolder(id) {
    if (ws.persistent) {
      try {
        await storage.deleteFolder(id);
      } catch (err) {
        ws.lastError = err;
      }
    }
    ws.folders = ws.folders.filter((f) => f.id !== id);
    // Notes in that folder fall back to no folder rather than disappearing.
    for (const note of ws.notes) {
      if (note.folderId === id) note.folderId = null;
    }
    if (ws.current && ws.current.folderId === id) ws.current.folderId = null;
    notify();
  }

  async function moveToFolder(noteId, folderId) {
    const note = ws.notes.find((n) => n.id === noteId);
    if (note) note.folderId = folderId;
    if (ws.current && ws.current.id === noteId) ws.current.folderId = folderId;
    await save();
    notify();
  }

  // --- library state -------------------------------------------------------

  function libraryState({ screen = 'home', query = '', folderId = null } = {}) {
    return {
      screen,
      query,
      currentFolderId: folderId,
      folders: ws.folders.map((f) => ({
        ...f,
        noteCount: ws.notes.filter((n) => n.folderId === f.id).length,
      })),
      notes: ws.notes,
      showWelcome: true,
      showBrainBreak: true,
    };
  }

  return {
    ws,
    get current() {
      return ws.current;
    },
    get notes() {
      return ws.notes;
    },
    get folders() {
      return ws.folders;
    },
    get page() {
      return currentPage();
    },
    get pages() {
      return currentPages();
    },
    get pageIndex() {
      return ws.pageIndex;
    },
    init,
    newNote,
    openNote,
    deleteNote,
    renameNote,
    markDirty,
    scheduleSave,
    save,
    setPage,
    addPage,
    saveFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    moveToFolder,
    libraryState,
    get persistent() {
      return ws.persistent;
    },
  };
}
