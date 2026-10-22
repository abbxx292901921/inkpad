// The page sidebar: DOM stub + rendering checks, matching the style of
// tests/inkpad-library-dom-test.mjs. No jsdom, no dependencies.

const PANEL_URL = new URL('../src/ui/pages-panel.js', import.meta.url).href;

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

const { buildPagesPanel, pageSignature, filterPageEntries } = await import(PANEL_URL);

let checks = 0;
const failures = [];
function ok(label, cond, extra = '') {
  checks += 1;
  if (!cond) failures.push(`${label}${extra ? ` — ${extra}` : ''}`);
}

function points(n) {
  return Array.from({ length: n }, (_, i) => ({ x: i, y: i }));
}
function makePage(id, name, nStrokes = 1, nPoints = 2, nLayers = 0) {
  return {
    id,
    name,
    w: 794,
    h: 1123,
    strokes: Array.from({ length: nStrokes }, () => ({ points: points(nPoints) })),
    layers: Array.from({ length: nLayers }, () => ({ id: `l-${id}` })),
  };
}

const pages = [
  makePage('p1', 'Algebra', 1, 3, 0),
  makePage('p2', 'Biology', 2, 4, 1),
  makePage('p3', 'Chemistry', 0, 0, 0),
];

const renders = [];
const calls = [];
const panel = buildPagesPanel({
  onScrollToPage: (i) => calls.push(`scroll:${i}`),
  onAddPage: () => calls.push('add'),
  onDuplicatePage: (i) => calls.push(`dupe:${i}`),
  onDeletePage: (i) => calls.push(`delete:${i}`),
  onClearPage: (i) => calls.push(`clear:${i}`),
  renderThumbnail: async (page) => {
    renders.push(page.id);
    return `data:image/png;base64,${page.id}`;
  },
});

function findAll(root, cls) {
  const out = [];
  root.walk((n) => {
    if (String(n.className).split(/\s+/).includes(cls)) out.push(n);
  });
  return out;
}
function textOf(root, cls) {
  return findAll(root, cls).map((n) => n.textContent);
}

ok('the panel element is a pages panel', panel.element.className === 'pages-panel');
ok('the panel starts closed', panel.element.hidden === true);
ok('the stylesheet link is injected', head.children.length === 1 && head.children[0].id === 'pages-panel-css');
ok('the stylesheet link points at pages-panel.css', String(head.children[0].href).endsWith('/src/ui/pages-panel.css'));

panel.update({ pages, pageIndex: 1 });

ok('one card per page', findAll(panel.element, 'pp-card').length === 3);
ok('the page numbers are rendered under the cards', textOf(panel.element, 'pp-num').join(',') === '1,2,3');
ok('the header count is the number of pages', textOf(panel.element, 'pp-count').join(',') === '3');
ok('the current page card is highlighted', findAll(panel.element, 'pp-card').some((n) => n.classList.contains('is-current') && n.getAttribute('aria-current') === 'page'));
ok('the highlighted card is the current page', findAll(panel.element, 'pp-card').some((n) => n.classList.contains('is-current') && findAll(n, 'pp-num')[0].textContent === '2'));
ok('the add-page card is rendered', findAll(panel.element, 'pp-add').length === 1);
ok('the search field filters by name', findAll(panel.element, 'pp-search-input').length === 1);

// Search is a NAME filter and keeps the original page index.
panel.update({ query: 'bio' });
ok('search filters the page list', findAll(panel.element, 'pp-card').length === 1);
ok('search keeps the page number', textOf(panel.element, 'pp-num').join(',') === '2');
ok('search updates the header count', textOf(panel.element, 'pp-count').join(',') === '1');
ok('the panel exposes the filter helper', filterPageEntries(pages, 'chem').map((e) => e.index).join(',') === '2');
ok('an empty search matches every page', filterPageEntries(pages, '').length === 3);

panel.update({ query: '' });
ok('clearing the search restores every page', findAll(panel.element, 'pp-card').length === 3);

// The signature is the thumbnail cache key.
ok('the signature counts strokes, points and layers', pageSignature(pages[1]) === '2:8:1', pageSignature(pages[1]));
ok('a stroke change changes the signature', pageSignature(pages[0]) !== pageSignature({ ...pages[0], strokes: [{ points: points(4) }] }));

// Thumbnails are queued lazily: nothing has rendered before the queue runs.
ok('no thumbnail renders before the queue is drained', renders.length === 0);
ok('cards show an empty placeholder until then', findAll(panel.element, 'pp-thumb').every((n) => n.classList.contains('is-empty')));

await panel.flush();
ok('one thumbnail per page is rendered', renders.length === 3, `renders=${renders.length}`);
ok('the thumbnails replace the placeholders', findAll(panel.element, 'pp-thumb').every((n) => !n.classList.contains('is-empty')));
ok('the cached image is used', findAll(panel.element, 'pp-thumb-img').length === 3);
ok('the image src is the rendered thumbnail', findAll(panel.element, 'pp-thumb-img')[0].src === 'data:image/png;base64,p1');

// Same content -> cached; changed content -> only that page re-renders.
panel.update({ pages, pageIndex: 1 });
await panel.flush();
ok('unchanged pages reuse the cached thumbnail', renders.length === 3, `renders=${renders.length}`);

pages[0].strokes.push({ points: points(2) });
panel.update({ pages, pageIndex: 1 });
await panel.flush();
ok('only the changed page is re-rendered', renders.length === 4 && renders[renders.length - 1] === 'p1', renders.join(','));

// A layer change is also a content change.
pages[2].layers.push({ id: 'layer-new' });
panel.update({ pages, pageIndex: 1 });
await panel.flush();
ok('a layer change invalidates the thumbnail', renders.length === 5 && renders[renders.length - 1] === 'p3', renders.join(','));

// Panel open/close.
panel.open();
ok('open shows the panel', panel.element.hidden === false);
panel.close();
ok('close hides the panel', panel.element.hidden === true);

if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED`);
