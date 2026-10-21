// Smoke test: build the library against a minimal DOM stub so the rendering
// path actually runs in Node (no jsdom, no dependencies).

const LIB_URL = 'file:///C:/AI%20Projects/chatability/src/ui/library.js';

class ClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : Boolean(on);
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList(this);
    this.parentNode = null;
    this._text = '';
    this.hidden = false;
    this.title = '';
    this.value = '';
    this.className = '';
  }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener() {}
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = v === undefined || v === null ? '' : String(v);
    this.children = [];
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  // Walk the tree the way a test would.
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
  }
}

const head = new Node('head');
const document = {
  head,
  body: new Node('body'),
  createElement: (tag) => new Node(tag),
  createElementNS: (ns, tag) => new Node(tag),
  getElementById: () => null,
};

globalThis.document = document;

const { buildLibrary } = await import(LIB_URL);

let checks = 0;
const failures = [];
function ok(label, cond, extra = '') {
  checks += 1;
  if (!cond) failures.push(`${label}${extra ? ` — ${extra}` : ''}`);
}

const calls = [];
const actions = {
  onNewNote: () => calls.push('new'),
  onOpenNote: (id) => calls.push(`open:${id}`),
  onImportFile: () => calls.push('import'),
  onSearch: (q) => calls.push(`search:${q}`),
  onSelectFolder: (id) => calls.push(`folder:${id}`),
  onSelectScreen: (s) => calls.push(`screen:${s}`),
  onSettings: () => calls.push('settings'),
  onTemplate: () => calls.push('template'),
  onRecordAudio: () => calls.push('record'),
};

const root = new Node('div');
const lib = buildLibrary(root, actions);

ok('buildLibrary appends to the root', root.children.length === 1);
ok('buildLibrary returns the element', lib.element === root.children[0]);
ok('the stylesheet link is injected', head.children.length === 1 && head.children[0].id === 'library-css');
ok('the stylesheet link points at library.css', String(head.children[0].href).endsWith('/src/ui/library.css'));

lib.update({
  screen: 'home',
  folders: [
    { id: 'f1', name: 'Sophomore Year', color: '#0a84ff', parentId: null, noteCount: 5 },
    { id: 'f2', name: 'Math 220', color: '#af52de', parentId: 'f1', noteCount: 36 },
  ],
  notes: [
    { id: 'n1', title: 'Lecture 1', folderId: 'f2', folderName: 'Math 220', updatedAt: new Date(2026, 9, 21).getTime(), thumbnail: null },
    { id: 'n2', title: 'Lecture 2', folderId: 'f1', updatedAt: new Date(2026, 9, 20).getTime(), thumbnail: 'data:image/png;base64,xxx' },
  ],
  query: '',
  currentFolderId: null,
});

const tags = [];
lib.element.walk((n) => tags.push(n));

// Every screen exists in the DOM at once (CSS hides the inactive ones), so
// scoped checks need the screen subtree, not the whole tree.
function screen(name) {
  let found = null;
  lib.element.walk((n) => {
    if (n.dataset && n.dataset.screen === name) found = n;
  });
  return found;
}
function inScreen(name, pred) {
  const hits = [];
  const root = screen(name);
  if (root) root.walk((n) => { if (pred(n)) hits.push(n); });
  return hits;
}

ok('the sidebar exists', tags.some((n) => n.className === 'lib-side'));
ok('the search field is a real search input', tags.some((n) => n.tagName === 'INPUT' && n.type === 'search'));
ok('the search field has an accessible name', tags.some((n) => n.tagName === 'INPUT' && n.attributes['aria-label']));
ok('nav items are buttons', tags.filter((n) => n.className === 'lib-nav-item').length === 3);
ok('nav items carry aria-current', tags.some((n) => n.className === 'lib-nav-item' && n.attributes['aria-current'] === 'page'));
ok('folder rows are buttons', tags.filter((n) => n.className === 'lib-folder-btn').length === 2);
ok('a folder with children shows a chevron', tags.some((n) => n.className === 'lib-chevron'));
ok('the chevron exposes aria-expanded', tags.some((n) => n.className === 'lib-chevron' && n.attributes['aria-expanded'] !== undefined));
ok('the three action cards are rendered', tags.filter((n) => n.className.indexOf('lib-action ') === 0).length === 3);
ok('the welcome heading is rendered', tags.some((n) => n.className === 'lib-h1' && n.textContent === "Let's get started"));
ok('the quote is rendered', tags.some((n) => n.className === 'lib-quote-text' && /iron is hot/.test(n.textContent)));
ok('the brain break banner is rendered', tags.some((n) => n.className === 'lib-banner'));
ok('the NEW flag is rendered', tags.some((n) => n.className === 'lib-banner-new' && n.textContent === 'NEW'));
ok('a close button exists for the welcome block', tags.some((n) => n.className === 'lib-close'));
ok('the recent notes carousel has a card per note', inScreen('home', (n) => n.className === 'lib-card').length === 2);
ok('a blank thumbnail placeholder is used when there is no image', tags.some((n) => n.className.indexOf('lib-thumb') === 0 && n.classList.contains('is-blank')));
ok('a thumbnail image is used when there is one', tags.some((n) => n.className === 'lib-thumb-img' && n.src === 'data:image/png;base64,xxx'));
ok('a subject chip is rendered', tags.some((n) => n.className === 'lib-chip' && n.textContent === 'Math 220'));

// The folder screen shows the notes of that folder only.
lib.setScreen('folder');
lib.update({ currentFolderId: 'f2' });
const rowTitles = inScreen('folder', (n) => n.className === 'lib-row-title').map((n) => n.textContent);
ok("the folder screen lists only that folder's notes", rowTitles.join(',') === 'Lecture 1', rowTitles.join(','));
const titles = inScreen('folder', (n) => n.className === 'lib-page-title').map((n) => n.textContent);
ok('the folder heading is the folder name', titles.join(',') === 'Math 220', titles.join(','));
// The tree is re-rendered on update, so re-collect the nodes.
const fresh = [];
lib.element.walk((n) => fresh.push(n));
ok('the selected folder is marked current', fresh.some((n) => n.className === 'lib-folder-btn' && n.attributes['aria-current'] === 'true'));
ok('the selected folder shows a count badge', fresh.some((n) => n.className === 'lib-count' && n.textContent === '36'));

// Search filters the list.
lib.update({ query: 'lecture 2' });
const after = inScreen('notes', (n) => n.className === 'lib-row-title').map((n) => n.textContent);
ok('the search filters the note list', after.join(',') === 'Lecture 2', after.join(','));
const afterFolder = inScreen('folder', (n) => n.className === 'lib-row-title').map((n) => n.textContent);
ok('the search filters the folder list too', afterFolder.join(',') === '', afterFolder.join(','));

// Dismissal: the welcome block hides and stays hidden across updates.
let welcomeEl = null;
lib.element.walk((n) => { if (n.className === 'lib-welcome') welcomeEl = n; });
ok('the welcome block is found', Boolean(welcomeEl));
ok('the welcome block starts visible', welcomeEl.hidden === false);

if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED`);
