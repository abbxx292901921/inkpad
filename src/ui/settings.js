// ui/settings.js — the provider settings panel.
//
// WHY: the AI layer is BYOK (bring your own key): the user points Inkpad at
// whichever provider they already pay for. Somebody has to be able to type an
// endpoint, paste a key and pick a model — with a FINGER on an iPad, where a
// little popover behind the on-screen keyboard is unusable.
//
// So this is a full-screen SHEET, not a popover: a provider list on the left
// and the selected provider's form on the right. It is a stateless renderer
// like ui/library.js — build once, push state in with update(state), act
// through the callbacks.
//
// The panel NEVER makes a network call and NEVER touches the preset store. It
// hands a draft preset to onSave / onDelete / onTest / onFetchModels and the
// app decides what to do with it.
//
// THE KEY IS NEVER DISPLAYED: it only ever lives in a password input (the
// show/hide toggle switches the input type, nothing more). It never reaches
// a text node, a title or an aria-label, and the list shows maskKey().
//
// theme.css belongs to another agent, so the styles ship in their own file
// (src/ui/settings.css) and are linked in at runtime.

import { icon } from './icons.js';
import { el } from './popover.js';
import { maskKey } from '../ai/presets.js';

// The kinds the panel offers when the app does not supply its own list.
const DEFAULT_KINDS = [
  { kind: 'openai', label: 'OpenAI-compatible', authStyle: 'bearer', supportsVision: true,
    help: 'Any endpoint that speaks the OpenAI chat-completions dialect.',
    defaultEndpoint: 'https://api.openai.com/v1', defaultModelsUrl: 'https://api.openai.com/v1/models' },
  { kind: 'gemini-generate', label: 'Google AI Studio', authStyle: 'x-goog-api-key', supportsVision: true,
    help: 'Gemini generateContent. The key travels in the x-goog-api-key header.',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    defaultModelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { kind: 'gemini-interactions', label: 'Gemini interactions', authStyle: 'x-goog-api-key',
    supportsVision: true, help: 'The Gemini interactions endpoint.',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta', defaultModelsUrl: '' },
  { kind: 'anthropic', label: 'Anthropic', authStyle: 'x-api-key', supportsVision: true,
    help: 'Claude messages API. The key travels in the x-api-key header.',
    defaultEndpoint: 'https://api.anthropic.com', defaultModelsUrl: 'https://api.anthropic.com/v1/models' },
  { kind: 'raw', label: 'Custom (raw)', authStyle: 'bearer', supportsVision: false,
    help: 'You write the request body yourself and say where the answer is.',
    defaultEndpoint: '', defaultModelsUrl: '' },
];

// How the key is attached to the request.
const AUTH_STYLES = [
  { id: 'bearer', label: 'Authorization: Bearer' },
  { id: 'x-api-key', label: 'x-api-key header' },
  { id: 'x-goog-api-key', label: 'x-goog-api-key header' },
  { id: 'query', label: '?key= in the query string' },
  { id: 'none', label: 'No key' },
];

const CUSTOM_MODEL = '__custom__';

let uidCounter = 0;

function nextUid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

// theme.css is owned by another agent, so the panel styles ship in their own
// file and are linked in at runtime. No build step, no import side effect.
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('settings-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./settings.css', import.meta.url).href;
  link.id = 'settings-css';
  document.head.appendChild(link);
}

// A copy of a preset. The panel edits its own copy: it never mutates the
// app's objects, it hands a draft back through onSave.
function copyPreset(preset) {
  const p = preset && typeof preset === 'object' ? preset : {};
  const s = (v) => (typeof v === 'string' ? v : '');
  return {
    id: s(p.id), label: s(p.label), kind: s(p.kind) || 'openai', endpoint: s(p.endpoint),
    modelsUrl: s(p.modelsUrl), apiKey: s(p.apiKey), model: s(p.model), auth: s(p.auth) || 'bearer',
    vision: !!p.vision, requestTemplate: s(p.requestTemplate), responseTextPath: s(p.responseTextPath),
    extraHeaders: { ...(p.extraHeaders && typeof p.extraHeaders === 'object' ? p.extraHeaders : {}) },
  };
}

// A label tied to its control. Every field has one — no placeholder-only
// inputs, so the form is readable with the keyboard dismissed. `extra` is a
// hint line (a string) or an element; `sibling` sits next to the control.
function labelled(text, control, extra = '', sibling = null) {
  const wrap = el('div', 'set-field');
  const label = el('label', 'set-label', text);
  label.setAttribute('for', control.id);
  wrap.appendChild(label);
  if (sibling) {
    const row = el('div', 'set-keywrap');
    row.appendChild(control);
    row.appendChild(sibling);
    wrap.appendChild(row);
  } else {
    wrap.appendChild(control);
  }
  if (extra) wrap.appendChild(typeof extra === 'string' ? el('div', 'set-hint', extra) : extra);
  return wrap;
}

function textInput(uid, cls = 'set-input') {
  const n = el('input', cls);
  n.type = 'text';
  n.id = nextUid(uid);
  n.autocomplete = 'off';
  n.spellcheck = false;
  return n;
}

function makeSelect(uid, cls = 'set-input set-select') {
  const n = el('select', cls);
  n.id = nextUid(uid);
  return n;
}

function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function buildSettings({
  onClose, onTest, onFetchModels, onSave, onDelete, onSetActive,
} = {}) {
  // Import-safe: the module can be pulled into a Node test without a DOM.
  if (typeof document === 'undefined') {
    return { element: null, update() {}, open() {}, close() {}, isVisible: () => false };
  }
  injectStyles();

  // --- state the panel owns -------------------------------------------------
  let presets = [];
  let activeId = null;
  let kinds = DEFAULT_KINDS;
  let selectedId = null;
  let draft = null;
  let unsaved = false; // the draft has never been handed to the store
  let confirmDelete = false;
  let anchor = null;
  let headerRows = [];

  // --- the sheet ------------------------------------------------------------
  const root = el('div', 'set-panel');
  root.hidden = true;
  const backdrop = el('div', 'set-backdrop');
  backdrop.addEventListener('click', () => close());
  root.appendChild(backdrop);
  const card = el('div', 'set-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Settings');
  card.tabIndex = -1;
  root.appendChild(card);
  const head = el('header', 'set-head');
  head.appendChild(el('h2', 'set-title', 'Settings'));
  head.appendChild(el('span', 'set-subtitle', 'AI providers'));
  const closeBtn = button('', 'set-icon-btn', () => close());
  closeBtn.title = 'Close settings';
  closeBtn.setAttribute('aria-label', 'Close settings');
  closeBtn.appendChild(icon('close', { size: 18 }));
  head.appendChild(closeBtn);
  card.appendChild(head);
  const body = el('div', 'set-body');

  // --- provider list --------------------------------------------------------
  const listPane = el('aside', 'set-list');
  const listHead = el('div', 'set-list-head');
  listHead.appendChild(el('span', 'set-section-title', 'Providers'));
  listHead.appendChild(button('New provider', 'set-btn set-btn-ghost set-btn-sm', () => addProvider()));
  listPane.appendChild(listHead);
  const listItems = el('ul', 'set-items');
  listPane.appendChild(listItems);
  body.appendChild(listPane);

  // --- the form -------------------------------------------------------------
  const detail = el('main', 'set-detail');
  const form = el('form', 'set-form');
  form.setAttribute('aria-label', 'Provider');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  // A labelled control, appended to the form. Returns the control.
  function field(text, control, extra = '', sibling = null, cls = '') {
    const wrap = labelled(text, control, extra, sibling);
    if (cls) wrap.classList.add(cls);
    form.appendChild(wrap);
    return control;
  }

  const labelInput = field('Label', textInput('set-label'));
  const endpointInput = field('Endpoint', textInput('set-endpoint'), 'The base URL of the provider.');
  const modelsUrlInput = field('Models URL', textInput('set-models-url'), 'Where “Fetch models” looks.');
  const kindHelp = el('div', 'set-hint');
  const kindSelect = field('Kind', makeSelect('set-kind'), kindHelp);
  kindSelect.addEventListener('change', () => onKindChange());
  const authSelect = makeSelect('set-auth');
  for (const style of AUTH_STYLES) {
    const opt = el('option', null, style.label);
    opt.value = style.id;
    authSelect.appendChild(opt);
  }
  field('Key is sent as', authSelect);

  // The key: a password input and a toggle. The value never reaches a text
  // node, a title or an aria-label.
  const keyInput = textInput('set-key', 'set-input set-key');
  keyInput.type = 'password';
  keyInput.setAttribute('autocapitalize', 'off');
  keyInput.setAttribute('autocorrect', 'off');
  const showKeyBtn = button('Show', 'set-btn set-btn-inline', () => {
    const showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    showKeyBtn.textContent = showing ? 'Show' : 'Hide';
    showKeyBtn.setAttribute('aria-pressed', String(!showing));
  });
  showKeyBtn.setAttribute('aria-pressed', 'false');
  field('API key', keyInput, 'Stored on this device only. Never logged.', showKeyBtn);

  // --- model + fetch --------------------------------------------------------
  const modelInput = textInput('set-model');
  const modelSelect = makeSelect('set-model-pick');
  modelSelect.hidden = true;
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value === CUSTOM_MODEL) {
      showModelPicker(false);
      modelInput.focus();
      return;
    }
    if (draft) draft.model = modelSelect.value;
  });
  const modelLabel = el('label', 'set-label', 'Model');
  modelLabel.setAttribute('for', modelInput.id);
  const modelRow = el('div', 'set-row');
  modelRow.appendChild(modelInput);
  modelRow.appendChild(modelSelect);
  const fetchBtn = button('Fetch models', 'set-btn set-btn-ghost', () => fetchModels());
  modelRow.appendChild(fetchBtn);
  const modelStatus = el('div', 'set-hint');
  const modelField = el('div', 'set-field');
  modelField.appendChild(modelLabel);
  modelField.appendChild(modelRow);
  modelField.appendChild(modelStatus);
  form.appendChild(modelField);

  // --- vision ---------------------------------------------------------------
  const visionInput = el('input', 'set-check');
  visionInput.type = 'checkbox';
  visionInput.id = nextUid('set-vision');
  field('Supports images', visionInput, 'Turn on for models that accept page images.', null, 'set-field-check');

  // --- raw-only -------------------------------------------------------------
  const rawBox = el('div', 'set-raw');
  const templateInput = el('textarea', 'set-input set-textarea');
  templateInput.id = nextUid('set-template');
  templateInput.rows = 6;
  templateInput.spellcheck = false;
  rawBox.appendChild(labelled('Request body template', templateInput, 'JSON with {{prompt}} in it.'));
  const pathInput = textInput('set-path');
  rawBox.appendChild(labelled('Response text path', pathInput, 'Dotted path, e.g. choices.0.message.content'));
  form.appendChild(rawBox);

  // --- extra headers --------------------------------------------------------
  const headersField = el('div', 'set-field');
  headersField.appendChild(el('span', 'set-label', 'Extra headers'));
  const headersList = el('div', 'set-headers');
  headersField.appendChild(headersList);
  headersField.appendChild(button('Add header', 'set-btn set-btn-ghost set-btn-sm', () => addHeaderRow('', '')));
  form.appendChild(headersField);
  detail.appendChild(form);

  // --- actions --------------------------------------------------------------
  const result = el('div', 'set-result');
  result.setAttribute('role', 'status');
  const actions = el('div', 'set-actions');
  const activeBtn = button('Use this provider', 'set-btn', () => {
    const next = collect();
    if (!next) return;
    onSetActive?.(next.id);
    showResult('This provider is now the default.', true);
  });
  const testBtn = button('Test connection', 'set-btn', () => test());
  const saveBtn = button('Save', 'set-btn set-btn-primary', () => save());
  const deleteBtn = button('Delete', 'set-btn set-btn-danger', () => remove());
  actions.appendChild(activeBtn);
  actions.appendChild(testBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(deleteBtn);
  actions.appendChild(button('Close', 'set-btn set-btn-ghost', () => close()));
  detail.appendChild(result);
  detail.appendChild(actions);
  body.appendChild(detail);
  card.appendChild(body);
  document.body.appendChild(root);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) {
      e.stopPropagation();
      close();
    }
  }, true);

  // --- small helpers --------------------------------------------------------
  function kindInfo(kind) {
    return kinds.find((k) => k.kind === kind) ?? null;
  }

  function buildKindOptions() {
    kindSelect.textContent = '';
    for (const k of kinds) {
      const opt = el('option', null, k.label || k.kind);
      opt.value = k.kind;
      kindSelect.appendChild(opt);
    }
  }

  function blankPreset() {
    const info = kinds[0] ?? null;
    return {
      id: `preset-${Date.now().toString(36)}-${uidCounter += 1}`,
      label: 'New provider', apiKey: '', model: '', extraHeaders: {},
      kind: info ? info.kind : 'openai', endpoint: info ? info.defaultEndpoint || '' : '',
      modelsUrl: info ? info.defaultModelsUrl || '' : '', auth: info ? info.authStyle || 'bearer' : 'bearer',
      vision: !!info?.supportsVision, requestTemplate: '', responseTextPath: '',
    };
  }

  function addHeaderRow(name, value) {
    const row = el('div', 'set-header-row');
    const key = textInput('set-header-key', 'set-input set-input-sm');
    const val = textInput('set-header-value', 'set-input set-input-sm');
    key.value = name;
    val.value = value;
    key.placeholder = 'Header name';
    val.placeholder = 'Header value';
    key.setAttribute('aria-label', 'Header name');
    val.setAttribute('aria-label', 'Header value');
    const rm = button('', 'set-btn set-btn-inline set-btn-icon', () => {
      row.remove();
      headerRows = headerRows.filter((r) => r.row !== row);
    });
    rm.title = 'Remove header';
    rm.setAttribute('aria-label', 'Remove header');
    rm.appendChild(icon('close', { size: 16 }));
    row.appendChild(key);
    row.appendChild(val);
    row.appendChild(rm);
    headersList.appendChild(row);
    headerRows.push({ row, key, value: val });
  }

  function readHeaders() {
    const out = {};
    for (const row of headerRows) {
      const name = row.key.value.trim();
      if (name) out[name] = row.value.value;
    }
    return out;
  }

  // --- the model picker -----------------------------------------------------
  function showModelPicker(asSelect) {
    modelSelect.hidden = !asSelect;
    modelInput.hidden = !!asSelect;
    modelLabel.setAttribute('for', asSelect ? modelSelect.id : modelInput.id);
  }

  function fillModelSelect(ids, current) {
    modelSelect.textContent = '';
    for (const id of ids) {
      const opt = el('option', null, id);
      opt.value = id;
      modelSelect.appendChild(opt);
    }
    const custom = el('option', null, 'Custom model…');
    custom.value = CUSTOM_MODEL;
    modelSelect.appendChild(custom);
    modelSelect.value = current && ids.includes(current) ? current : ids[0];
  }

  function modelIds(result) {
    const list = Array.isArray(result) ? result : result?.models;
    if (!Array.isArray(list)) return [];
    return list.map((m) => (typeof m === 'string' ? m : m?.id || '')).filter(Boolean);
  }

  function resultMessage(result) {
    if (typeof result === 'string') return { ok: true, text: result };
    if (!result || typeof result !== 'object') return { ok: false, text: 'No response from the provider.' };
    const ok = result.ok === undefined ? !result.error : !!result.ok;
    return { ok, text: result.message ?? result.text ?? result.error ?? (ok ? 'OK.' : 'Failed.') };
  }

  function showResult(text, ok) {
    result.textContent = text || '';
    result.classList.toggle('is-ok', ok === true);
    result.classList.toggle('is-err', ok === false);
  }

  // --- collect the form -----------------------------------------------------
  function collect() {
    if (!draft) return null;
    draft = {
      ...draft,
      label: labelInput.value.trim(),
      kind: kindSelect.value,
      endpoint: endpointInput.value.trim(),
      modelsUrl: modelsUrlInput.value.trim(),
      apiKey: keyInput.value,
      model: modelSelect.hidden ? modelInput.value.trim() : modelSelect.value,
      auth: authSelect.value,
      vision: visionInput.checked,
      requestTemplate: templateInput.value,
      responseTextPath: pathInput.value.trim(),
      extraHeaders: readHeaders(),
    };
    return draft;
  }

  // --- rendering ------------------------------------------------------------
  function renderList() {
    listItems.textContent = '';
    const rows = presets.map((p) => ({ preset: p, ghost: false }));
    // A draft the store does not know about yet still gets a row, so it does
    // not vanish while it is being filled in.
    if (draft && !presets.some((p) => p.id === draft.id)) rows.push({ preset: draft, ghost: true });
    for (const row of rows) {
      const p = row.preset;
      const li = el('li', 'set-item');
      const btn = el('button', 'set-item-btn');
      btn.type = 'button';
      if (p.id === selectedId) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-current', 'true');
      }
      const top = el('div', 'set-item-top');
      top.appendChild(el('span', 'set-item-label', p.label || 'Untitled provider'));
      if (p.id === activeId) top.appendChild(el('span', 'set-badge', 'Active'));
      else if (row.ghost) top.appendChild(el('span', 'set-badge is-draft', 'Unsaved'));
      btn.appendChild(top);
      const meta = el('div', 'set-item-meta');
      const parts = [
        ['set-item-kind', p.kind],
        ['set-item-model', p.model || 'no model'],
        ['set-item-key', maskKey(p.apiKey) || 'no key'],
      ];
      for (const [cls, text] of parts) meta.appendChild(el('span', cls, text));
      btn.appendChild(meta);
      btn.addEventListener('click', () => select(p.id));
      li.appendChild(btn);
      listItems.appendChild(li);
    }
  }

  function renderForm() {
    if (!draft) {
      form.hidden = true;
      actions.hidden = true;
      result.textContent = '';
      return;
    }
    form.hidden = false;
    actions.hidden = false;
    const values = [
      [labelInput, 'label'], [endpointInput, 'endpoint'], [modelsUrlInput, 'modelsUrl'],
      [keyInput, 'apiKey'], [modelInput, 'model'], [templateInput, 'requestTemplate'],
      [pathInput, 'responseTextPath'],
    ];
    for (const [input, key] of values) input.value = draft[key] ?? '';
    kindSelect.value = draft.kind;
    const info = kindInfo(draft.kind);
    kindHelp.textContent = info ? info.help || '' : '';
    keyInput.type = 'password';
    showKeyBtn.textContent = 'Show';
    showKeyBtn.setAttribute('aria-pressed', 'false');
    showModelPicker(false);
    authSelect.value = draft.auth ?? 'bearer';
    visionInput.checked = !!draft.vision;
    rawBox.hidden = draft.kind !== 'raw';
    headersList.textContent = '';
    headerRows = [];
    for (const [name, value] of Object.entries(draft.extraHeaders ?? {})) addHeaderRow(name, value);
    confirmDelete = false;
    deleteBtn.textContent = 'Delete';
    deleteBtn.classList.remove('is-armed');
    showResult('', null);
  }

  // --- actions --------------------------------------------------------------
  function select(id) {
    const found = presets.find((p) => p.id === id);
    if (found) {
      draft = copyPreset(found);
      unsaved = false;
      selectedId = id;
    } else if (draft && draft.id === id) {
      selectedId = id; // the pending (unsaved) draft stays selected
    } else {
      return;
    }
    renderList();
    renderForm();
  }

  function addProvider() {
    draft = blankPreset();
    unsaved = true;
    selectedId = draft.id;
    renderList();
    renderForm();
    labelInput.focus();
  }

  function onKindChange() {
    if (!draft) return;
    const info = kindInfo(kindSelect.value);
    draft.kind = kindSelect.value;
    kindHelp.textContent = info ? info.help || '' : '';
    // Switching kind re-fills the endpoint and the auth style: the old ones
    // belonged to the previous provider.
    endpointInput.value = info ? info.defaultEndpoint || '' : '';
    modelsUrlInput.value = info ? info.defaultModelsUrl || '' : '';
    authSelect.value = info ? info.authStyle || 'bearer' : 'bearer';
    visionInput.checked = !!info?.supportsVision;
    rawBox.hidden = draft.kind !== 'raw';
  }

  function save() {
    const next = collect();
    if (!next) return;
    if (!next.label) {
      showResult('Give the provider a name first.', false);
      return;
    }
    onSave?.(next, { isNew: unsaved });
    unsaved = false;
    showResult('Saved.', true);
    renderList();
  }

  function remove() {
    if (!draft) return;
    if (!confirmDelete) {
      // Two-step confirm: a finger-friendly one, not window.confirm.
      confirmDelete = true;
      deleteBtn.textContent = 'Really delete?';
      deleteBtn.classList.add('is-armed');
      return;
    }
    confirmDelete = false;
    deleteBtn.textContent = 'Delete';
    deleteBtn.classList.remove('is-armed');
    const removed = draft;
    onDelete?.(removed);
    draft = null;
    selectedId = null;
    const next = presets.find((p) => p.id !== removed.id);
    if (next) select(next.id);
    else renderForm();
  }

  async function test() {
    const next = collect();
    if (!next) return;
    testBtn.disabled = true;
    showResult('Testing…', null);
    try {
      const msg = resultMessage(await onTest?.(next));
      showResult(msg.text, msg.ok);
    } catch (err) {
      showResult(String(err?.message || 'The test failed.'), false);
    } finally {
      testBtn.disabled = false;
    }
  }

  async function fetchModels() {
    const next = collect();
    if (!next) return;
    fetchBtn.disabled = true;
    modelStatus.textContent = 'Fetching models…';
    try {
      const ids = modelIds(await onFetchModels?.(next));
      if (!ids.length) {
        modelStatus.textContent = 'No models came back.';
        return;
      }
      fillModelSelect(ids, next.model);
      showModelPicker(true);
      modelStatus.textContent = `${ids.length} model${ids.length === 1 ? '' : 's'}.`;
    } catch (err) {
      modelStatus.textContent = String(err?.message || 'Could not fetch the model list.');
    } finally {
      fetchBtn.disabled = false;
    }
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    anchor = null;
    onClose?.();
  }

  buildKindOptions();

  return {
    element: root,

    update(state = {}) {
      let reseed = false;
      if (Array.isArray(state.presets)) presets = state.presets.filter(Boolean).map((p) => copyPreset(p));
      if (state.activeId !== undefined) activeId = state.activeId;
      if (Array.isArray(state.kinds) && state.kinds.length) {
        kinds = state.kinds;
        buildKindOptions();
      }
      // The selected preset may have been deleted in the app.
      if (draft && !unsaved && !presets.some((p) => p.id === draft.id)) {
        draft = null;
        selectedId = null;
        reseed = true;
      }
      // Nothing selected yet: start on the first provider.
      if (!draft && presets.length) {
        draft = copyPreset(presets[0]);
        selectedId = draft.id;
        reseed = true;
      }
      if (!draft && selectedId) {
        selectedId = null;
        reseed = true;
      }
      renderList();
      if (reseed) renderForm();
    },

    open(anchorEl) {
      anchor = anchorEl ?? anchor;
      root.hidden = false;
      renderList();
      if (!draft && presets.length) {
        draft = copyPreset(presets[0]);
        selectedId = draft.id;
        renderForm();
      }
      requestAnimationFrame(() => card.focus());
      return root;
    },

    close,
    isVisible: () => !root.hidden,
    get anchor() {
      return anchor;
    },
  };
}
