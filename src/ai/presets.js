// ai/presets.js — the AI provider preset store.
//
// WHY: Inkpad talks to whichever model the user points it at, and every
// provider wants the key in a different place (an Authorization header, an
// x-api-key header, an x-goog-api-key header, a query string) and speaks a
// slightly different dialect. Rather than hard-code one vendor, a PRESET is
// pure configuration: kind + endpoint + key + model + auth style. The
// request layer (ai/providers.js) reads a preset and knows what to send.
//
// STORAGE (localStorage only, two keys):
//   `inkpad.presets.v1`      a JSON ARRAY of preset objects — the source of
//                            truth, always a plain array of plain objects.
//   `inkpad.presets.active`  the id of the preset the app should use. A
//                            separate key, so rewriting the list never has
//                            to preserve a field hanging off it.
//
// SECRETS: the API key lives in the preset and ONLY in the preset. Nothing
// here logs a preset, and the UI masks the key before showing it.
//
// NO RUNTIME STATE: a preset describes a provider, not a session — no
// caches, no in-flight requests, no "last used" counters here.
//
// GRACEFUL DEGRADATION: localStorage can be missing (Node), blocked (private
// mode) or hold garbage. Every read is guarded, and a corrupt value falls
// back to the starter presets instead of throwing.

export const PRESETS_KEY = 'inkpad.presets.v1';
export const ACTIVE_PRESET_KEY = 'inkpad.presets.active';

// The request dialects the client knows how to speak.
export const PROVIDER_KINDS = [
  'openai',
  'gemini-generate',
  'gemini-interactions',
  'anthropic',
  'raw',
];

// --- environment ------------------------------------------------------------

function safeStorage() {
  try {
    if (typeof globalThis === 'undefined') return null;
    const s = globalThis.localStorage;
    return s || null;
  } catch {
    // Storage can throw when cookies are blocked.
    return null;
  }
}

function readRaw(key) {
  const s = safeStorage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  const s = safeStorage();
  if (!s) return false;
  try {
    s.setItem(key, value);
    return true;
  } catch {
    // Quota or a blocked store: the preset just will not survive a reload.
    return false;
  }
}

function removeRaw(key) {
  const s = safeStorage();
  if (!s) return false;
  try {
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// --- ids --------------------------------------------------------------------

let idCounter = 0;

function makeId(prefix = 'preset') {
  idCounter += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return `${prefix}-${crypto.randomUUID()}`;
    } catch {
      // Fall through to the counter id.
    }
  }
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

// --- normalisation ----------------------------------------------------------

function str(value) {
  return typeof value === 'string' ? value : '';
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k) out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

// A preset with every field present and the right type. Anything missing or
// malformed is replaced rather than rejected, so one bad entry cannot take
// the whole list down.
function normalizePreset(raw, fallbackId) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: str(p.id) || fallbackId,
    label: str(p.label) || 'Untitled provider',
    kind: PROVIDER_KINDS.includes(p.kind) ? p.kind : 'openai',
    endpoint: str(p.endpoint),
    modelsUrl: str(p.modelsUrl),
    apiKey: str(p.apiKey),
    model: str(p.model),
    auth: str(p.auth) || 'bearer',
    extraHeaders: plainObject(p.extraHeaders),
    vision: !!p.vision,
    requestTemplate: str(p.requestTemplate),
    responseTextPath: str(p.responseTextPath),
  };
}

// --- the starter set --------------------------------------------------------

// One starter preset. The key always starts EMPTY — the user fills it in.
function starter(id, label, kind, endpoint, modelsUrl, model, auth, vision) {
  return {
    id, label, kind, endpoint, modelsUrl, model, auth, vision,
    apiKey: '',
    extraHeaders: {},
    requestTemplate: '',
    responseTextPath: '',
  };
}

// Free or cheap providers with their REAL endpoints and auth styles, so the
// user only has to paste a key.
export function defaultPresets() {
  return [
    starter('groq', 'Groq', 'openai', 'https://api.groq.com/openai/v1',
      'https://api.groq.com/openai/v1/models', 'llama-3.3-70b-versatile', 'bearer', false),
    starter('openrouter', 'OpenRouter', 'openai', 'https://openrouter.ai/api/v1',
      'https://openrouter.ai/api/v1/models', 'google/gemini-2.0-flash-exp:free', 'bearer', false),
    starter('google-ai-studio', 'Google AI Studio', 'gemini-generate',
      'https://generativelanguage.googleapis.com/v1beta/models',
      'https://generativelanguage.googleapis.com/v1beta/models', 'gemini-2.0-flash', 'x-goog-api-key', true),
    starter('anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com',
      'https://api.anthropic.com/v1/models', 'claude-sonnet-4-20250514', 'x-api-key', true),
    starter('ollama', 'Ollama (local)', 'openai', 'http://localhost:11434/v1',
      'http://localhost:11434/v1/models', 'llama3.2', 'none', false),
    starter('lm-studio', 'LM Studio (local)', 'openai', 'http://localhost:1234/v1',
      'http://localhost:1234/v1/models', 'local-model', 'none', false),
    starter('custom-raw', 'Custom (raw)', 'raw', '', '', '', 'bearer', false),
  ];
}

// --- read / write -----------------------------------------------------------

// The stored presets, or the starter set when nothing usable is stored. A
// corrupt value (bad JSON, not an array) falls back to the starters rather
// than throwing — a bad key must never brick the app.
export function loadPresets() {
  const raw = readRaw(PRESETS_KEY);
  if (raw === null || raw === undefined) return defaultPresets();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultPresets();
  }
  if (!Array.isArray(parsed)) return defaultPresets();
  return dedupe(parsed);
}

// Write the whole list back as a plain JSON array. Returns the normalised
// list that was written.
export function savePresets(list) {
  const out = dedupe(Array.isArray(list) ? list : []);
  writeRaw(PRESETS_KEY, JSON.stringify(out));
  return out;
}

// Normalise a list and give every entry a unique id.
function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const preset = normalizePreset(item, makeId());
    if (seen.has(preset.id)) preset.id = makeId();
    seen.add(preset.id);
    out.push(preset);
  }
  return out;
}
// One preset by id, or null.
export function getPreset(id) {
  if (!id) return null;
  return loadPresets().find((p) => p.id === id) ?? null;
}

// Add a preset. An id is filled in when the caller does not supply a free
// one. Returns the saved preset.
export function addPreset(preset = {}) {
  const list = loadPresets();
  let id = str(preset.id);
  if (!id || list.some((p) => p.id === id)) id = makeId();
  const saved = normalizePreset({ ...preset, id }, id);
  list.push(saved);
  savePresets(list);
  return saved;
}

// Merge a patch into a preset. Returns the updated preset, or null when
// there is no such preset.
export function updatePreset(id, patch = {}) {
  const list = loadPresets();
  const index = list.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const merged = normalizePreset({ ...list[index], ...patch, id: list[index].id }, list[index].id);
  list[index] = merged;
  savePresets(list);
  return merged;
}

// Remove a preset. Returns false when there was nothing to remove. The
// active id is cleared when it pointed at the deleted preset.
export function deletePreset(id) {
  const list = loadPresets();
  const index = list.findIndex((p) => p.id === id);
  if (index < 0) return false;
  list.splice(index, 1);
  savePresets(list);
  if (getActivePresetId() === id) setActivePreset(null);
  return true;
}

// --- the active preset ------------------------------------------------------

// Remember which preset the app should use. Pass null to clear it.
export function setActivePreset(id) {
  const value = typeof id === 'string' && id ? id : null;
  if (value === null) {
    removeRaw(ACTIVE_PRESET_KEY);
    return null;
  }
  writeRaw(ACTIVE_PRESET_KEY, value);
  return value;
}

// The active preset id, or null when none has been chosen.
export function getActivePresetId() {
  const raw = readRaw(ACTIVE_PRESET_KEY);
  if (typeof raw !== 'string') return null;
  return raw.trim() || null;
}

// --- masking ----------------------------------------------------------------

// A key shown in a list: a short head, an ellipsis and at most the last four
// characters. An empty key stays empty so the UI can say "no key".
export function maskKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return '';
  // A short key shows only its last character, so a 6-character key never
  // leaks in full.
  if (k.length <= 8) return `…${k.slice(-1)}`;
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}
