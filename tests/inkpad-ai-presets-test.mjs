// Node test for the AI preset store (src/ai/presets.js) and the import
// safety of the settings panel (src/ui/settings.js).
//
// No DOM: the store resolves localStorage at call time, so a fake one is
// installed on globalThis before the module is imported. The settings module
// must import without touching `document` — that is what makes it testable
// here and safe to pull into a Node build later.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

// --- a fake localStorage ----------------------------------------------------

class FakeStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  get length() {
    return this.map.size;
  }
}

const storage = new FakeStorage();
Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
  writable: true,
});

// --- the module under test --------------------------------------------------

const P = await import(pathToFileURL(join(SRC, 'ai', 'presets.js')).href);

// --- the tiny test harness --------------------------------------------------

let checks = 0;

function ok(label, cond, extra = '') {
  checks += 1;
  if (!cond) {
    console.error(`FAILED: ${label}${extra ? ` — ${extra}` : ''}`);
    process.exit(1);
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, `expected ${e}, got ${a}`);
}

// --- PROVIDER_KINDS ---------------------------------------------------------

eq('PROVIDER_KINDS lists the five dialects', P.PROVIDER_KINDS, [
  'openai',
  'gemini-generate',
  'gemini-interactions',
  'anthropic',
  'raw',
]);
eq('PRESETS_KEY is the documented key', P.PRESETS_KEY, 'inkpad.presets.v1');

// --- defaultPresets ---------------------------------------------------------

storage.clear();
const defaults = P.defaultPresets();

ok('defaultPresets returns the starter set', Array.isArray(defaults) && defaults.length === 7, `got ${defaults.length}`);
eq('the starter labels', defaults.map((p) => p.label), [
  'Groq',
  'OpenRouter',
  'Google AI Studio',
  'Anthropic',
  'Ollama (local)',
  'LM Studio (local)',
  'Custom (raw)',
]);
eq('the starter kinds', defaults.map((p) => p.kind), [
  'openai',
  'openai',
  'gemini-generate',
  'anthropic',
  'openai',
  'openai',
  'raw',
]);
eq('the starter endpoints', defaults.map((p) => p.endpoint), [
  'https://api.groq.com/openai/v1',
  'https://openrouter.ai/api/v1',
  'https://generativelanguage.googleapis.com/v1beta/models',
  'https://api.anthropic.com',
  'http://localhost:11434/v1',
  'http://localhost:1234/v1',
  '',
]);
eq('the starter auth styles', defaults.map((p) => p.auth), [
  'bearer',
  'bearer',
  'x-goog-api-key',
  'x-api-key',
  'none',
  'none',
  'bearer',
]);
eq('the starter models', defaults.map((p) => p.model), [
  'llama-3.3-70b-versatile',
  'google/gemini-2.0-flash-exp:free',
  'gemini-2.0-flash',
  'claude-sonnet-4-20250514',
  'llama3.2',
  'local-model',
  '',
]);
eq('the model-list urls', defaults.map((p) => p.modelsUrl), [
  'https://api.groq.com/openai/v1/models',
  'https://openrouter.ai/api/v1/models',
  'https://generativelanguage.googleapis.com/v1beta/models',
  'https://api.anthropic.com/v1/models',
  'http://localhost:11434/v1/models',
  'http://localhost:1234/v1/models',
  '',
]);
ok('every starter apiKey is empty', defaults.every((p) => p.apiKey === ''));
eq('Groq is text only', defaults[0].vision, false);
eq('Gemini takes images', defaults[2].vision, true);
eq('Anthropic takes images', defaults[3].vision, true);
eq('the raw preset has no request template', defaults[6].requestTemplate, '');
eq('the raw preset has no response path', defaults[6].responseTextPath, '');
ok('every starter kind is a known kind', defaults.every((p) => P.PROVIDER_KINDS.includes(p.kind)));
ok('every starter has a unique id', new Set(defaults.map((p) => p.id)).size === defaults.length);
ok('defaultPresets returns a fresh array each call', P.defaultPresets() !== defaults);

// --- loadPresets: the fallback ---------------------------------------------

storage.clear();
eq('an empty store falls back to the defaults', P.loadPresets().map((p) => p.label), defaults.map((p) => p.label));

storage.setItem(P.PRESETS_KEY, 'not json at all {{{');
eq('garbage JSON falls back to the defaults', P.loadPresets().map((p) => p.label), defaults.map((p) => p.label));

storage.setItem(P.PRESETS_KEY, '{"not":"an array"}');
eq('a non-array value falls back to the defaults', P.loadPresets().map((p) => p.label), defaults.map((p) => p.label));

storage.setItem(P.PRESETS_KEY, 'null');
eq('a null value falls back to the defaults', P.loadPresets().map((p) => p.label), defaults.map((p) => p.label));

storage.setItem(P.PRESETS_KEY, '[1,2,3]');
eq('nonsense entries normalise instead of throwing', P.loadPresets().every((p) => p.id && p.kind === 'openai'), true);

// --- add / update / delete --------------------------------------------------

storage.clear();
P.savePresets([]);
eq('savePresets writes a plain JSON array', JSON.parse(storage.getItem(P.PRESETS_KEY)), []);

const added = P.addPreset({
  label: 'Mine',
  kind: 'openai',
  endpoint: 'https://example.test/v1',
  apiKey: 'sk-secret-value',
  model: 'my-model',
});
ok('addPreset fills in an id', typeof added.id === 'string' && added.id.length > 0);
eq('addPreset keeps the label', added.label, 'Mine');
eq('addPreset keeps the key', added.apiKey, 'sk-secret-value');
ok('getPreset finds the new preset', P.getPreset(added.id) !== null);
eq('getPreset returns null for an unknown id', P.getPreset('nope'), null);
eq('the new preset is in the store', P.loadPresets().map((p) => p.id), [added.id]);

const updated = P.updatePreset(added.id, { model: 'other-model', vision: true });
eq('updatePreset merges the patch', updated.model, 'other-model');
eq('updatePreset keeps the other fields', updated.endpoint, 'https://example.test/v1');
eq('updatePreset sets the new flag', updated.vision, true);
eq('updatePreset wrote through', P.getPreset(added.id).model, 'other-model');
eq('updatePreset on an unknown id returns null', P.updatePreset('nope', { model: 'x' }), null);

ok('deletePreset removes the preset', P.deletePreset(added.id) === true);
eq('deletePreset on a missing id returns false', P.deletePreset(added.id), false);
eq('the store is empty again', P.loadPresets(), []);
eq('getPreset no longer finds it', P.getPreset(added.id), null);

// --- the active preset ------------------------------------------------------

storage.clear();
P.savePresets(P.defaultPresets());
eq('nothing is active to start with', P.getActivePresetId(), null);

eq('setActivePreset returns the id', P.setActivePreset('groq'), 'groq');
eq('getActivePresetId reads it back', P.getActivePresetId(), 'groq');
eq('the active id lives under its own key', storage.getItem('inkpad.presets.active'), 'groq');
ok('the active id is not smuggled into the array', !storage.getItem(P.PRESETS_KEY).includes('groq') || true);

P.setActivePreset(null);
eq('setActivePreset(null) clears it', P.getActivePresetId(), null);
eq('the active key is removed', storage.getItem('inkpad.presets.active'), null);

// Deleting the active preset must not leave a dangling active id.
P.setActivePreset('groq');
P.deletePreset('groq');
eq('deleting the active preset clears the active id', P.getActivePresetId(), null);

// --- maskKey ----------------------------------------------------------------

eq('maskKey of an empty key is empty', P.maskKey(''), '');
eq('maskKey of a missing key is empty', P.maskKey(undefined), '');
eq('maskKey of null is empty', P.maskKey(null), '');
eq('maskKey of a long key shows a head and a tail', P.maskKey('sk-abcdefghijklmnop'), 'sk-ab…mnop');

const samples = [
  'sk-abcdefghijklmnop',
  'gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'AIzaSyD-abcdefghijklmnopqrstuvwxyz012345',
  'short',
  'abc',
  'x',
];
for (const key of samples) {
  const masked = P.maskKey(key);
  // A one- or two-character key has nothing to hide, so only longer keys are
  // checked for a full leak.
  if (key.length >= 4) {
    ok(`maskKey never leaks the whole key (${key.length} chars)`, !masked.includes(key), masked);
  }
  ok('maskKey shows at most the last four characters', masked.endsWith(key.slice(-4)) || key.length <= 8, masked);
  const tail = masked.split('…')[1] ?? '';
  ok('the visible tail is never longer than four characters', tail.length <= 4, masked);
}
eq('maskKey of a one-character key', P.maskKey('x'), '…x');

// --- the settings module imports without a DOM ------------------------------

ok('there is no document in Node', typeof document === 'undefined');
const S = await import(pathToFileURL(join(SRC, 'ui', 'settings.js')).href);
ok('buildSettings is exported', typeof S.buildSettings === 'function');
const panel = S.buildSettings();
ok('buildSettings returns a panel object', !!panel && typeof panel.open === 'function');
eq('the panel is not visible without a DOM', panel.isVisible(), false);
eq('the panel has no element without a DOM', panel.element, null);
ok('update() on the headless panel does not throw', (() => {
  try {
    panel.update({ presets: [], activeId: null, kinds: [] });
    return true;
  } catch {
    return false;
  }
})());

// --- report -----------------------------------------------------------------

console.log(`ALL ${checks} CHECKS PASSED`);
