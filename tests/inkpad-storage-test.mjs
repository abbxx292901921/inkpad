// inkpad-storage-test.mjs — tests for src/storage.js.
//
// Node has no IndexedDB and no DOM, so the module must be importable without
// touching either. The test therefore runs in two parts:
//   1. the pure parts (toRecord / fromRecord / buildSummary / isSupported)
//      with no IndexedDB in the environment at all;
//   2. the full database flow against a minimal fake IndexedDB installed on
//      globalThis, so the transaction plumbing is exercised too.

import { pathToFileURL } from 'node:url';

const ROOT = process.env.INKPAD_ROOT ?? 'C:\\AI Projects\\chatability';
const storage = await import(pathToFileURL(`${ROOT}\\src\\storage.js`).href);

let checks = 0;
let failures = 0;

function ok(cond, label) {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

function throwsWithCode(fn, code, label) {
  try {
    fn();
    ok(false, `${label} (did not throw)`);
  } catch (err) {
    ok(err && err.code === code, `${label} (code ${err && err.code})`);
  }
}

async function rejectsWithCode(fn, code, label) {
  try {
    await fn();
    ok(false, `${label} (did not reject)`);
  } catch (err) {
    ok(err && err.code === code, `${label} (code ${err && err.code})`);
  }
}

// --- a minimal fake IndexedDB ----------------------------------------------

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = null;
  }
}

class FakeIndex {
  constructor(store, name) {
    this.store = store;
    this.keyPath = store.indexes.get(name);
  }

  getAll() {
    const rows = [];
    for (const value of this.store.records.values()) {
      const key = value[this.keyPath];
      if (key === undefined || key === null) continue;
      rows.push({ key, value });
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return rows.map((r) => r.value);
  }
}

class FakeStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexes = new Map();
  }

  createIndex(name, keyPath) {
    this.indexes.set(name, keyPath);
  }

  put(value) {
    const key = value?.[this.keyPath];
    if (key === undefined || key === null) {
      throw new Error(`DataError: ${this.name} record has no ${this.keyPath}`);
    }
    this.records.set(key, value);
    return key;
  }

  get(key) {
    return this.records.get(key);
  }

  delete(key) {
    this.records.delete(key);
  }

  getAll() {
    return [...this.records.values()];
  }

  clear() {
    this.records.clear();
  }
}

// The real API hands out a per-transaction view of a store: every method
// returns an IDBRequest and keeps the transaction alive until it settles.
function makeStoreFacade(store, tx) {
  return {
    name: store.name,
    keyPath: store.keyPath,
    createIndex: (name, keyPath) => store.createIndex(name, keyPath),
    put: (value) => tx._request(() => store.put(value)),
    get: (key) => tx._request(() => store.get(key)),
    delete: (key) => tx._request(() => store.delete(key)),
    getAll: () => tx._request(() => store.getAll()),
    clear: () => tx._request(() => store.clear()),
    index: (name) => ({
      getAll: () =>
        tx._request(() => {
          const rows = [];
          for (const value of store.records.values()) {
            const key = value[store.indexes.get(name)];
            if (key === undefined || key === null) continue;
            rows.push({ key, value });
          }
          rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          return rows.map((r) => r.value);
        }),
    }),
  };
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.mode = mode;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this.error = null;
    this._pending = 0;
    this._finished = false;
    this._names = names;
  }

  objectStore(name) {
    return makeStoreFacade(this.db.stores.get(name), this);
  }

  _request(run) {
    const req = new FakeRequest();
    this._pending += 1;
    queueMicrotask(() => {
      let value;
      try {
        value = run();
      } catch (err) {
        req.error = err;
        this._pending -= 1;
        if (req.onerror) req.onerror({ target: req });
        this._abort(err);
        return;
      }
      req.result = value;
      if (req.onsuccess) req.onsuccess({ target: req });
      this._pending -= 1;
      if (this._pending === 0) this._complete();
    });
    return req;
  }

  _complete() {
    if (this._finished) return;
    this._finished = true;
    queueMicrotask(() => {
      if (this.oncomplete) this.oncomplete({ target: this });
    });
  }

  _abort(err) {
    if (this._finished) return;
    this._finished = true;
    this.error = err;
    queueMicrotask(() => {
      if (this.onabort) this.onabort({ target: this });
    });
  }
}

class FakeDb {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.onversionchange = null;
  }

  get objectStoreNames() {
    return { contains: (n) => this.stores.has(n) };
  }

  createObjectStore(name, { keyPath }) {
    const store = new FakeStore(name, keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(names, mode = 'readonly') {
    return new FakeTransaction(this, [].concat(names), mode);
  }

  close() {}
}

function makeFakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name, version) {
      const req = new FakeRequest();
      let db = dbs.get(name);
      const isNew = !db;
      if (isNew) {
        db = new FakeDb(name, version);
        dbs.set(name, db);
      }
      queueMicrotask(() => {
        req.result = db;
        if (isNew) {
          db.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

// --- fixtures ---------------------------------------------------------------

function makeStroke(id, points = 3) {
  return {
    id,
    tool: 'pen',
    color: '#1b1b1b',
    width: 3,
    opacity: 1,
    pointerType: 'pen',
    lineStyle: 'solid',
    pressureTaper: true,
    points: Array.from({ length: points }, (_, i) => ({
      x: i * 10,
      y: i * 5,
      pressure: 0.5,
      t: 1000 + i,
    })),
  };
}

function makeNote(id, over = {}) {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
  return {
    id,
    title: `Note ${id}`,
    folderId: null,
    createdAt: 1000,
    updatedAt: 1000,
    pages: [
      {
        id: `${id}-p1`,
        name: 'Page 1',
        layers: [
          {
            id: `${id}-l1`,
            kind: 'image',
            name: 'photo.png',
            blob,
            url: 'blob:fake-url',
            img: { nodeName: 'IMG' },
            naturalWidth: 800,
            naturalHeight: 600,
            loaded: true,
          },
        ],
        strokes: [makeStroke(`${id}-s1`), makeStroke(`${id}-s2`)],
      },
    ],
    ...over,
  };
}

// --- part 1: no IndexedDB, no DOM ------------------------------------------

console.log('part 1 — importable and safe without IndexedDB');

ok(typeof storage.isSupported === 'function', 'isSupported is exported');
eq(storage.isSupported(), false, 'isSupported() is false with no IndexedDB');
await rejectsWithCode(() => storage.open(), 'unavailable', 'open() rejects as unavailable');
await rejectsWithCode(() => storage.listNotes(), 'unavailable', 'listNotes() rejects as unavailable');
await rejectsWithCode(() => storage.loadNote('x'), 'unavailable', 'loadNote() rejects as unavailable');
await rejectsWithCode(() => storage.getSetting('x'), 'unavailable', 'getSetting() rejects as unavailable');
eq(await storage.requestPersistence(), false, 'requestPersistence() is false without navigator.storage');
eq(await storage.estimateUsage(), null, 'estimateUsage() is null without navigator.storage');

console.log('part 2 — pure serialisation');

const note = makeNote('n1', { updatedAt: 5000 });
const record = storage.toRecord(note);

eq(record.id, 'n1', 'toRecord keeps the id');
eq(record.pages.length, 1, 'toRecord keeps the pages');
eq(record.pages[0].strokes.length, 2, 'toRecord keeps the strokes');
eq(record.pages[0].strokes[0].points.length, 3, 'toRecord keeps the points');
eq(record.pages[0].layers[0].url, undefined, 'toRecord drops the object URL');
eq(record.pages[0].layers[0].img, undefined, 'toRecord drops the DOM image');
ok(record.pages[0].layers[0].blob instanceof Blob, 'toRecord keeps the layer Blob');
eq(record.pages[0].layers[0].naturalWidth, 800, 'toRecord keeps the natural size');
throwsWithCode(() => storage.toRecord({ title: 'no id' }), 'invalid', 'toRecord rejects a note without an id');

const restored = storage.fromRecord(record);
eq(restored.id, 'n1', 'fromRecord keeps the id');
eq(restored.pages[0].layers[0].url, null, 'fromRecord resets the object URL');
eq(restored.pages[0].layers[0].img, null, 'fromRecord resets the DOM image');
eq(restored.pages[0].layers[0].loaded, false, 'fromRecord marks the layer as not loaded');
ok(restored.pages[0].layers[0].blob instanceof Blob, 'fromRecord keeps the layer Blob');
eq(restored.pages[0].strokes[0].points[1].x, 10, 'fromRecord copies the points');
ok(restored.pages[0].strokes[0] !== record.pages[0].strokes[0], 'fromRecord copies the strokes');

const summary = storage.buildSummary(record);
eq(
  {
    id: summary.id,
    pageCount: summary.pageCount,
    strokeCount: summary.strokeCount,
    hasLayers: summary.hasLayers,
    thumbnail: summary.thumbnail,
  },
  { id: 'n1', pageCount: 1, strokeCount: 2, hasLayers: true, thumbnail: null },
  'buildSummary counts pages, strokes and layers',
);
eq(storage.buildSummary({ id: 'x' }).strokeCount, 0, 'buildSummary copes with an empty record');
eq(
  storage.buildSummary({ id: 'x', thumbnail: 'data:image/png;base64,AA' }).thumbnail,
  'data:image/png;base64,AA',
  'buildSummary passes the thumbnail through',
);

console.log('part 3 — the database flow (fake IndexedDB)');

globalThis.indexedDB = makeFakeIndexedDB();
eq(storage.isSupported(), true, 'isSupported() is true once IndexedDB exists');

const db = await storage.open();
ok(db && typeof db.transaction === 'function', 'open() resolves with a database handle');
const notesStore = db.stores.get('notes');
ok(notesStore, 'the notes store exists');
eq(notesStore.keyPath, 'id', 'the notes store is keyed by id');
eq(notesStore.indexes.get('by-updated'), 'updatedAt', 'the notes store indexes updatedAt');
ok(db.stores.get('folders'), 'the folders store exists');
ok(db.stores.get('settings'), 'the settings store exists');

const saved = await storage.saveNote(note);
eq(saved.id, 'n1', 'saveNote() returns the stored record');

const loaded = await storage.loadNote('n1');
ok(loaded, 'loadNote() finds the note');
eq(loaded.pages[0].strokes.length, 2, 'loadNote() restores the strokes');
eq(loaded.pages[0].layers[0].blob instanceof Blob, true, 'loadNote() restores the layer Blob');
eq(loaded.pages[0].layers[0].url, null, 'loadNote() leaves the object URL empty');
eq(await storage.loadNote('missing'), null, 'loadNote() returns null for an unknown note');

// A save REPLACES the note: a stroke deleted in memory must stay deleted.
note.pages[0].strokes.pop();
note.pages[0].layers.length = 0;
await storage.saveNote(note);
const reloaded = await storage.loadNote('n1');
eq(reloaded.pages[0].strokes.length, 1, 'saveNote() replaces the strokes');
eq(reloaded.pages[0].layers.length, 0, 'saveNote() replaces the layers');

await storage.deleteNote('n1');
eq(await storage.loadNote('n1'), null, 'deleteNote() removes the note');

const older = makeNote('old', { createdAt: 10, updatedAt: 10 });
const newer = makeNote('new', { createdAt: 20, updatedAt: 20 });
await storage.saveNote(older);
await storage.saveNote(newer);
const summaries = await storage.listNotes();
eq(summaries.map((s) => s.id), ['new', 'old'], 'listNotes() is newest first');
eq(summaries[0].pageCount, 1, 'listNotes() reports the page count');
eq(summaries[0].strokeCount, 2, 'listNotes() reports the stroke count');
eq(summaries[0].hasLayers, true, 'listNotes() reports the layers');

await storage.saveFolder({ id: 'f1', name: 'Maths', color: '#f00', parentId: null, createdAt: 5 });
const folders = await storage.listFolders();
eq(folders.length, 1, 'listFolders() returns the folder');
eq(folders[0].name, 'Maths', 'listFolders() keeps the name');
eq(folders[0].color, '#f00', 'listFolders() keeps the colour');
await storage.deleteFolder('f1');
eq((await storage.listFolders()).length, 0, 'deleteFolder() removes the folder');

await storage.setSetting('lastNote', 'new');
eq(await storage.getSetting('lastNote'), 'new', 'setSetting()/getSetting() round-trip a string');
await storage.setSetting('palette', [1, 2, 3]);
eq(await storage.getSetting('palette'), [1, 2, 3], 'settings round-trip an array');
eq(await storage.getSetting('nope'), undefined, 'getSetting() returns undefined for an unknown key');

await storage.clearAll();
eq((await storage.listNotes()).length, 0, 'clearAll() wipes the notes');
eq((await storage.listFolders()).length, 0, 'clearAll() wipes the folders');
eq(await storage.getSetting('lastNote'), undefined, 'clearAll() wipes the settings');

await storage.close();

console.log('part 4 — layer hydration without a DOM');

const layer = storage.fromRecord(storage.toRecord(makeNote('n2'))).pages[0].layers[0];
await storage.hydrateLayer(layer);
ok(typeof layer.url === 'string' && layer.url.length > 0, 'hydrateLayer() regenerates the object URL');
eq(layer.img, null, 'hydrateLayer() leaves the image null when there is no DOM');
eq(layer.loaded, false, 'hydrateLayer() does not claim to be loaded without a DOM');
eq(await storage.hydrateLayer(null), null, 'hydrateLayer() copes with null');

const bare = { id: 'l', blob: null };
await storage.hydrateLayer(bare);
eq(bare.url, undefined, 'hydrateLayer() does nothing without a Blob');

console.log(`\n${failures === 0 ? 'ALL' : 'FAILED'} ${checks} CHECKS${failures === 0 ? ' PASSED' : ''}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
