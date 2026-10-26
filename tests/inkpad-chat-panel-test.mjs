// tests/inkpad-chat-panel-test.mjs — the chat sidebar, against a stub DOM.
//
// WHY: the sidebar is the app's chat surface, so its BEHAVIOUR matters as
// much as its looks: the log grows, a streaming answer is rewritten in
// place, the send button turns into a stop button while a reply is in
// flight, and a new chat empties the log.
//
// Plain Node, no dependencies: the same minimal DOM stub the library test
// uses.

const PANEL_URL = 'file:///C:/AI%20Projects/chatability/src/ui/ask-ai.js';

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
    this.id = '';
    this.type = '';
    this.rows = 0;
    this.scrollHeight = 0;
    this.scrollTop = 0;
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
  addEventListener(type, fn) { (this.handlers ||= {})[type] = fn; }
  click() { this.handlers?.click?.({ currentTarget: this }); }
  focus() { this.focused = true; }
  get textContent() {
    // The real DOM concatenates an element's own text with its children's.
    return this._text + this.children.map((c) => c.textContent).join('');
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
globalThis.document = {
  head,
  body: new Node('body'),
  createElement: (tag) => new Node(tag),
  createElementNS: (ns, tag) => new Node(tag),
  getElementById: () => null,
};

const { buildChatPanel } = await import(PANEL_URL);

let checks = 0;
const failures = [];
function ok(label, cond, extra = '') {
  checks += 1;
  if (!cond) failures.push(`${label}${extra ? ` — ${extra}` : ''}`);
}

// --- the panel is built -------------------------------------------------------

const sent = [];
const stopped = [];
const closed = [];
const settingsOpened = [];
let cleared = false;

const panel = buildChatPanel({
  // The app adds the user turn to the log when it accepts a question.
  onSend: (text, options) => {
    sent.push([text, options]);
    panel.addUser(text);
  },
  onStop: () => stopped.push(true),
  onClose: () => closed.push(true),
  onOpenSettings: () => settingsOpened.push(true),
});
panel.onClear(() => { cleared = true; });

ok('the stylesheet link is injected', head.children.length === 1 && head.children[0].id === 'ask-ai-css');
ok('the stylesheet link points at ask-ai.css', String(head.children[0].href).endsWith('/src/ui/ask-ai.css'));
ok('the panel is an aside', panel.element.tagName === 'ASIDE');
ok('the panel has an accessible name', panel.element.getAttribute('aria-label') === 'AI chat');
ok('the panel starts closed', panel.isOpen() === false);
ok('the panel starts hidden', panel.element.hidden === true);

// --- open and close ------------------------------------------------------------

panel.open();
ok('the panel opens', panel.isOpen() === true);
ok('the panel is visible when open', panel.element.hidden === false);
panel.close();
ok('the panel closes', panel.isOpen() === false);
panel.toggle();
ok('the panel toggles open', panel.isOpen() === true);
panel.toggle();
ok('the panel toggles closed', panel.isOpen() === false);

// --- the provider state --------------------------------------------------------

panel.setState({ ready: false, providerLabel: 'No provider', canSendImage: false });
const nodes = [];
panel.element.walk((n) => nodes.push(n));
ok('the empty state is shown without a provider', nodes.some((n) => n.className === 'chat-empty' && n.hidden === false));
ok('the composer is hidden without a provider', nodes.some((n) => n.className === 'chat-composer' && n.hidden === true));

panel.setState({ ready: true, providerLabel: 'NVIDIA NIM (relay)', canSendImage: true });
const withProvider = [];
panel.element.walk((n) => withProvider.push(n));
ok('the composer appears with a provider', withProvider.some((n) => n.className === 'chat-composer' && n.hidden === false));
ok('the empty state is gone with a provider', withProvider.some((n) => n.className === 'chat-empty' && n.hidden === true));
ok('the provider name is shown', withProvider.some((n) => n.className === 'chat-provider' && n.textContent === 'NVIDIA NIM (relay)'));
ok('the page toggle starts on', withProvider.some((n) => n.className.indexOf('chat-btn-toggle') >= 0 && n.classList.contains('is-on')));

// --- sending -------------------------------------------------------------------

const input = withProvider.find((n) => n.className === 'chat-input');
ok('there is a composer field', Boolean(input));
input.value = 'What is on this page?';
input.handlers.click; // the field listens for input/keydown, not click
input.value = 'What is on this page?';

const sendBtn = withProvider.find((n) => n.className === 'chat-send');
ok('there is a send button', Boolean(sendBtn));
sendBtn.click();
ok('the question is sent', sent.length === 1, JSON.stringify(sent));
eqText(sent[0]?.[0], 'What is on this page?');
ok('the sent options carry the page attachment', sent[0]?.[1]?.attachPage === true);
ok('the composer is emptied after sending', input.value === '');
ok('the user turn is in the log', panel.messages.some((m) => m.role === 'user' && m.content === 'What is on this page?'));

// --- annotating ----------------------------------------------------------------

const annotateBtn = withProvider.find((n) => n.className === 'chat-btn' && n.textContent === 'Annotate');
ok('there is an annotate button', Boolean(annotateBtn));
input.value = 'Mark the key terms';
annotateBtn.click();
ok('the annotate request is sent', sent.length === 2);
ok('the annotate request is flagged', sent[1]?.[1]?.annotate === true);
ok('an annotate request always sends the page', sent[1]?.[1]?.attachPage === true);

// --- a streaming answer --------------------------------------------------------

const entry = panel.addAssistant();
ok('an assistant turn starts empty', panel.messages.some((m) => m.id === entry.id));
panel.updateAssistant(entry, 'Hello', { streaming: true });
panel.updateAssistant(entry, 'Hello there', { streaming: true });
const streamed = [];
panel.element.walk((n) => streamed.push(n));
ok('the streaming text is shown', streamed.some((n) => n.className === 'chat-bubble' && n.textContent.startsWith('Hello there')));
ok('the streaming turn is marked', streamed.some((n) => n.className.indexOf('chat-msg is-ai') === 0 && n.classList.contains('is-streaming')));
panel.updateAssistant(entry, 'Hello there.', { streaming: false });
const done = [];
panel.element.walk((n) => done.push(n));
ok('the finished turn is not streaming any more', done.some((n) => n.className.indexOf('chat-msg is-ai') === 0 && !n.classList.contains('is-streaming')));

// --- a failed answer ------------------------------------------------------------

const failed = panel.addAssistant();
panel.failAssistant(failed, 'That provider rejected the API key.');
const failedNodes = [];
panel.element.walk((n) => failedNodes.push(n));
ok('a failed turn is marked as an error', failedNodes.some((n) => n.className.indexOf('chat-msg is-ai') === 0 && n.classList.contains('is-error')));
ok('the error text is shown', failedNodes.some((n) => n.className === 'chat-bubble' && n.textContent === 'That provider rejected the API key.'));

// --- notices ---------------------------------------------------------------------

panel.addNotice('Added 3 annotations — undo removes them.');
const notices = [];
panel.element.walk((n) => notices.push(n));
ok('a notice is rendered', notices.some((n) => n.className.indexOf('chat-notice') === 0 && n.textContent.includes('Added 3 annotations')));

// --- busy state ------------------------------------------------------------------

panel.setBusy(true);
const busyNodes = [];
panel.element.walk((n) => busyNodes.push(n));
ok('the send button becomes a stop button', busyNodes.some((n) => n.className === 'chat-send' && n.classList.contains('is-stop')));
const busySend = busyNodes.find((n) => n.className === 'chat-send');
busySend.click();
ok('the stop button stops the request', stopped.length === 1);

panel.setBusy(false);
const idleNodes = [];
panel.element.walk((n) => idleNodes.push(n));
ok('the stop button goes back to send', idleNodes.some((n) => n.className === 'chat-send' && !n.classList.contains('is-stop')));

// --- the error strip ---------------------------------------------------------------

panel.setError('Choose a provider first.');
const errorNodes = [];
panel.element.walk((n) => errorNodes.push(n));
ok('the error strip is shown', errorNodes.some((n) => n.className === 'chat-error' && n.hidden === false && n.textContent === 'Choose a provider first.'));
panel.setError('');
const clearedErrors = [];
panel.element.walk((n) => clearedErrors.push(n));
ok('the error strip is hidden again', clearedErrors.some((n) => n.className === 'chat-error' && n.hidden === true));

// --- a new chat --------------------------------------------------------------------

panel.clearChat();
const afterClear = [];
panel.element.walk((n) => afterClear.push(n));
ok('a new chat empties the log', afterClear.filter((n) => n.className.indexOf('chat-msg') === 0).length === 0);
ok('a new chat tells the app', cleared === true);
ok('a new chat leaves the composer alone', afterClear.some((n) => n.className === 'chat-input'));

function eqText(actual, expected) {
  ok(`the text is "${expected}"`, actual === expected, `got ${actual}`);
}

if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED`);
