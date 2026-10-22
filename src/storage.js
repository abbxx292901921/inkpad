// storage.js — IndexedDB persistence for Inkpad.
//
// WHY: the document lives in memory only (src/app.js owns it), so a reload —
// or Safari evicting the tab — loses every stroke and every imported file.
// This module is the ONLY place in the app that talks to IndexedDB, so the
// storage shape is described in exactly one file.
//
// SCHEMA (version 1) — one object store per concern:
//   notes     keyPath 'id'.  ONE record per note: pages, layers, strokes,
//             thumbnail. A note is written whole, in a single transaction,
//             so a save is atomic and a deleted stroke stays deleted.
//   folders   keyPath 'id'.  One record per folder.
//   settings  keyPath 'key'. One record per key/value pair.
// Migrations must be ADDITIVE: bump DB_VERSION and add new stores / indexes
// inside `contains()` guards, never rewrite an existing store.
//
// BLOBS: an imported file (a photo, a rasterised PDF page) is kept as a Blob,
// which IndexedDB stores natively — no base64, no data-URL inflation, and the
// bytes stay on disk. The layer's `url` is an OBJECT URL: a handle that is
// only valid inside the session that created it, so it is NEVER persisted.
// On load the URL is regenerated from the stored Blob and the `img` element
// is rebuilt (see hydrateLayer).
//
// GRACEFUL DEGRADATION: a private window (or a locked-down browser) can
// expose `indexedDB` and still refuse to open a database. isSupported()
// answers that question up front, and every entry point rejects with a
// StorageError carrying a `code`, so the app can fall back to a scratchpad
// instead of dying.
//
// THUMBNAILS: the app owns the canvas, so the app produces the thumbnail (a
// small data URL) and hangs it on `note.thumbnail`. Storage persists that
// string verbatim and never renders one itself.

const DB_NAME = 'inkpad';
const DB_VERSION = 1;

const STORE_NOTES = 'notes';
const STORE_FOLDERS = 'folders';
const STORE_SETTINGS = 'settings';

export class StorageError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
  }
}

// --- environment probes -----------------------------------------------------

function idbFactory() {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return null;
    return indexedDB;
  } catch {
    // Some browsers throw on touching the global at all.
    return null;
  }
}

// True when IndexedDB is present. It says nothing about whether the database
// can actually be OPENED — private windows lie — so callers should also catch
// the rejection from open().
export function isSupported() {
  return idbFactory() !== null;
}

// --- open / close -----------------------------------------------------------

let dbPromise = null;

function createOpenPromise() {
  const factory = idbFactory();
  const p = new Promise((resolve, reject) => {
    let req;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new StorageError('Could not open the Inkpad database.', 'open', err));
      return;
    }
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => {
      const db = req.result;
      // Another tab wants a newer schema: let go instead of blocking it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () =>
      reject(new StorageError('Could not open the Inkpad database.', 'open', req.error));
    req.onblocked = () =>
      reject(new StorageError('Another tab is upgrading the Inkpad database.', 'blocked'));
  });
  // A failed open must not poison the next call.
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

// Create the stores. Every step is guarded so a future version only ADDS.
function upgrade(db) {
  if (!db.objectStoreNames.contains(STORE_NOTES)) {
    const notes = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
    notes.createIndex('by-updated', 'updatedAt');
    notes.createIndex('by-folder', 'folderId');
  }
  if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
    db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
    db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
  }
}

// Open (and upgrade, if needed) the database. Resolves with the IDBDatabase.
export async function open() {
  if (!isSupported()) {
    throw new StorageError(
      'IndexedDB is not available here (private browsing or a locked-down browser).',
      'unavailable',
    );
  }
  if (!dbPromise) dbPromise = createOpenPromise();
  return dbPromise;
}

export async function close() {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;
  try {
    const db = await pending;
    db.close();
  } catch {
    // It never opened; nothing to close.
  }
}

// --- transaction helpers ----------------------------------------------------

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new StorageError('The write was aborted.', 'aborted', tx.error));
    tx.onerror = () => reject(new StorageError('The write failed.', 'failed', tx.error));
  });
}

function requestResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new StorageError('The database request failed.', 'failed', req.error));
  });
}

async function readStore(storeName, run) {
  const db = await open();
  const tx = db.transaction(storeName, 'readonly');
  return run(tx.objectStore(storeName));
}

async function writeStore(storeName, run) {
  const db = await open();
  const tx = db.transaction(storeName, 'readwrite');
  run(tx.objectStore(storeName));
  await txDone(tx);
}

// --- serialisation (pure) ---------------------------------------------------

// A layer as it goes into the database: the Blob survives, the object URL and
// the <img> element do not (they are session state).
export function toLayerRecord(layer) {
  const record = {
    id: layer.id,
    kind: layer.kind ?? 'image',
    name: layer.name ?? '',
    blob: layer.blob ?? null,
    naturalWidth: layer.naturalWidth ?? 0,
    naturalHeight: layer.naturalHeight ?? 0,
  };
  if (layer.pageNumber != null) record.pageNumber = layer.pageNumber;
  if (layer.width != null) record.width = layer.width;
  if (layer.height != null) record.height = layer.height;
  // The page-space rectangle the layer occupies. Without it the layer would
  // have to be re-fitted to the screen on every load, and it would not pan
  // or zoom with the ink.
  if (layer.rect && Number.isFinite(layer.rect.x)) {
    record.rect = {
      x: layer.rect.x,
      y: layer.rect.y,
      w: layer.rect.w,
      h: layer.rect.h,
    };
  }
  return record;
}

// A stroke as it goes into the database: plain JSON, copied field by field so
// nothing DOM-shaped can sneak in.
export function toStrokeRecord(stroke) {
  const record = {
    id: stroke.id,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    opacity: stroke.opacity,
    pointerType: stroke.pointerType,
    lineStyle: stroke.lineStyle,
    pressureTaper: stroke.pressureTaper,
    points: (stroke.points ?? []).map((p) => ({
      x: p.x,
      y: p.y,
      pressure: p.pressure,
      t: p.t,
    })),
  };
  // A text object carries its string and its size; a shape carries its kind
  // and fill mode. Without these they would load back as blank ink.
  if (stroke.kind === 'text') {
    record.kind = 'text';
    record.text = stroke.text ?? '';
    record.size = stroke.size ?? 28;
    record.w = stroke.w ?? 0;
    record.h = stroke.h ?? 0;
    record.x = stroke.x ?? stroke.points?.[0]?.x ?? 0;
    record.y = stroke.y ?? stroke.points?.[0]?.y ?? 0;
  }
  if (stroke.kind === 'shape') {
    record.kind = 'shape';
    record.shape = stroke.shape;
    record.fill = stroke.fill === true;
  }
  return record;
}

// A note as it goes into the database: one structured-cloneable record.
export function toRecord(note) {
  if (!note || typeof note.id !== 'string' || !note.id) {
    throw new StorageError('A note needs an id to be saved.', 'invalid');
  }
  const now = Date.now();
  const pages = Array.isArray(note.pages) ? note.pages : [];
  return {
    id: note.id,
    title: note.title ?? 'Untitled',
    folderId: note.folderId ?? null,
    createdAt: Number.isFinite(note.createdAt) ? note.createdAt : now,
    updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : now,
    thumbnail: typeof note.thumbnail === 'string' ? note.thumbnail : null,
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name ?? 'Page',
      layers: (page.layers ?? []).map(toLayerRecord),
      strokes: (page.strokes ?? []).map(toStrokeRecord),
    })),
  };
}

// A record as the app sees it again. The layers come back WITHOUT their
// object URL and image element — call hydrateLayer / hydrateNote for those.
export function fromRecord(record) {
  const pages = Array.isArray(record.pages) ? record.pages : [];
  return {
    id: record.id,
    title: record.title ?? 'Untitled',
    folderId: record.folderId ?? null,
    createdAt: record.createdAt ?? 0,
    updatedAt: record.updatedAt ?? 0,
    thumbnail: typeof record.thumbnail === 'string' ? record.thumbnail : null,
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name ?? 'Page',
      layers: (page.layers ?? []).map((layer) => ({
        ...toLayerRecord(layer),
        url: null,
        img: null,
        loaded: false,
      })),
      strokes: (page.strokes ?? []).map((stroke) => ({
        ...stroke,
        points: (stroke.points ?? []).map((p) => ({ ...p })),
      })),
    })),
  };
}

// The library row for a note record.
export function buildSummary(record) {
  const pages = Array.isArray(record.pages) ? record.pages : [];
  let strokeCount = 0;
  let hasLayers = false;
  for (const page of pages) {
    strokeCount += Array.isArray(page.strokes) ? page.strokes.length : 0;
    if (!hasLayers && Array.isArray(page.layers) && page.layers.length > 0) {
      hasLayers = true;
    }
  }
  return {
    id: record.id,
    title: record.title ?? 'Untitled',
    folderId: record.folderId ?? null,
    createdAt: record.createdAt ?? 0,
    updatedAt: record.updatedAt ?? 0,
    pageCount: pages.length,
    strokeCount,
    hasLayers,
    thumbnail: typeof record.thumbnail === 'string' ? record.thumbnail : null,
  };
}

// --- notes ------------------------------------------------------------------

// Upsert a whole note in ONE transaction. `put` replaces the record, so what
// is missing from the note (a deleted stroke, a removed layer) stays deleted.
export async function saveNote(note) {
  const record = toRecord(note);
  await writeStore(STORE_NOTES, (store) => store.put(record));
  return record;
}

// Load a note, or null when it does not exist. The layers come back
// un-hydrated — see hydrateLayer.
export async function loadNote(id) {
  const record = await readStore(STORE_NOTES, (store) => requestResult(store.get(id)));
  return record ? fromRecord(record) : null;
}

export async function deleteNote(id) {
  await writeStore(STORE_NOTES, (store) => store.delete(id));
}

// Note summaries, newest first.
export async function listNotes() {
  const records = await readStore(STORE_NOTES, (store) =>
    requestResult(store.index('by-updated').getAll()),
  );
  records.sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  return records.map(buildSummary);
}

// --- folders ----------------------------------------------------------------

export async function listFolders() {
  const records = await readStore(STORE_FOLDERS, (store) => requestResult(store.getAll()));
  records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return records;
}

export async function saveFolder(folder) {
  if (!folder || typeof folder.id !== 'string' || !folder.id) {
    throw new StorageError('A folder needs an id to be saved.', 'invalid');
  }
  const record = {
    id: folder.id,
    name: folder.name ?? '',
    color: folder.color ?? null,
    parentId: folder.parentId ?? null,
    createdAt: Number.isFinite(folder.createdAt) ? folder.createdAt : Date.now(),
  };
  await writeStore(STORE_FOLDERS, (store) => store.put(record));
  return record;
}

export async function deleteFolder(id) {
  await writeStore(STORE_FOLDERS, (store) => store.delete(id));
}

// --- settings ---------------------------------------------------------------

// The stored value, or undefined when the key is unknown.
export async function getSetting(key) {
  const record = await readStore(STORE_SETTINGS, (store) => requestResult(store.get(key)));
  return record ? record.value : undefined;
}

export async function setSetting(key, value) {
  await writeStore(STORE_SETTINGS, (store) => store.put({ key, value }));
  return value;
}

// --- bulk -------------------------------------------------------------------

// Wipe notes, folders and settings in one transaction.
export async function clearAll() {
  const db = await open();
  const tx = db.transaction([STORE_NOTES, STORE_FOLDERS, STORE_SETTINGS], 'readwrite');
  tx.objectStore(STORE_NOTES).clear();
  tx.objectStore(STORE_FOLDERS).clear();
  tx.objectStore(STORE_SETTINGS).clear();
  await txDone(tx);
}

// --- layers -----------------------------------------------------------------

// Rebuild the runtime half of a layer: a fresh object URL from the stored
// Blob, and the <img> that displays it. Await this for every layer of a
// loaded note, then redraw.
export async function hydrateLayer(layer) {
  if (!layer || !layer.blob) return layer;
  if (layer.loaded && layer.img) return layer;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return layer;
  if (!layer.url) layer.url = URL.createObjectURL(layer.blob);
  if (typeof document === 'undefined' || typeof Image === 'undefined') return layer;
  const img = new Image();
  img.decoding = 'async';
  try {
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new StorageError('A stored image could not be decoded.', 'decode'));
      img.src = layer.url;
    });
  } catch {
    // One broken image must not stop the rest of the note from loading.
    layer.failed = true;
    return layer;
  }
  layer.img = img;
  layer.naturalWidth = img.naturalWidth || layer.naturalWidth || 0;
  layer.naturalHeight = img.naturalHeight || layer.naturalHeight || 0;
  layer.loaded = true;
  return layer;
}

// Hydrate every layer of a note in place.
export async function hydrateNote(note) {
  if (!note || !Array.isArray(note.pages)) return note;
  for (const page of note.pages) {
    for (const layer of page.layers ?? []) {
      await hydrateLayer(layer);
    }
  }
  return note;
}

// --- storage manager --------------------------------------------------------

// Ask the browser to keep the database around (no eviction after 7 days of
// silence, and a bigger quota). Returns false when it is not possible.
export async function requestPersistence() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage) return false;
    if (typeof navigator.storage.persisted === 'function') {
      if (await navigator.storage.persisted()) return true;
    }
    if (typeof navigator.storage.persist !== 'function') return false;
    return (await navigator.storage.persist()) === true;
  } catch {
    return false;
  }
}

// Bytes used and bytes available, or null when the browser will not say.
export async function estimateUsage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage) return null;
    if (typeof navigator.storage.estimate !== 'function') return null;
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
    };
  } catch {
    return null;
  }
}
