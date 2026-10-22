// models.js — best-effort model list for a provider.
//
// WHY: typing a model id by hand is the biggest papercut in a BYOK app, so
// every preset offers a "fetch the model list" button. But a model list is a
// convenience, never a requirement: if the call fails — no CORS header on
// the models endpoint, an offline device, a provider with no list endpoint
// at all — this module returns [] and the caller falls back to a free-text
// field where the user types the id. IT NEVER THROWS.
//
// The auth styles are defined by describeKind() in providers.js. The switch
// below repeats that mapping on purpose: providers.js's public exports are
// fixed, and importing the whole call path just to learn a header name
// would be silly.

import { describeKind } from './providers.js';

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') return null;
  return globalThis.fetch.bind(globalThis);
}

const AUTH_STYLES = ['bearer', 'x-api-key', 'x-goog-api-key', 'query', 'none'];

function authStyleOf(preset) {
  const style = typeof preset?.auth === 'string' ? preset.auth.trim().toLowerCase() : '';
  if (AUTH_STYLES.includes(style)) return style;
  try {
    return describeKind(preset?.kind).authStyle;
  } catch {
    return 'bearer';
  }
}

function authHeaders(preset) {
  const key = preset?.apiKey;
  if (!key) return {};
  switch (authStyleOf(preset)) {
    case 'bearer':
      return { Authorization: `Bearer ${key}` };
    case 'x-api-key':
      return { 'x-api-key': key };
    case 'x-goog-api-key':
      return { 'x-goog-api-key': key };
    case 'query':
      return {};
    case 'none':
      return {};
    default:
      return {};
  }
}

function modelsUrlOf(preset) {
  if (preset?.modelsUrl) return preset.modelsUrl;
  try {
    return describeKind(preset?.kind).defaultModelsUrl;
  } catch {
    return '';
  }
}

function withQueryAuth(url, preset) {
  const key = preset?.apiKey;
  if (!key || authStyleOf(preset) !== 'query') return url;
  const sep = String(url).includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(key)}`;
}

// Gemini names its models 'models/gemini-2.0-flash'; the id you pass back
// to the API is without the prefix.
function cleanId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function collect(list, pick) {
  const ids = [];
  if (!Array.isArray(list)) return ids;
  for (const item of list) {
    const id = cleanId(pick(item));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function extractModelIds(json) {
  if (!json) return [];
  if (Array.isArray(json)) return collect(json, (item) => item?.id ?? item?.name);
  if (Array.isArray(json.data)) return collect(json.data, (item) => item?.id ?? item?.name);
  if (Array.isArray(json.models)) return collect(json.models, (item) => item?.name ?? item?.id);
  if (Array.isArray(json.result?.data)) return collect(json.result.data, (item) => item?.id ?? item?.name);
  return [];
}

export async function fetchModels(preset, { fetchImpl = defaultFetch(), signal } = {}) {
  try {
    if (!preset) return [];
    if (typeof fetchImpl !== 'function') return [];
    const url = modelsUrlOf(preset);
    if (!url) return [];
    const headers = { ...authHeaders(preset) };
    const userHeaders = preset.extraHeaders;
    if (userHeaders && typeof userHeaders === 'object') Object.assign(headers, userHeaders);

    const response = await fetchImpl(withQueryAuth(url, preset), { method: 'GET', headers, signal });
    const status = typeof response?.status === 'number' ? response.status : 0;
    const ok = response?.ok === undefined ? status === 0 || (status >= 200 && status < 300) : response.ok;
    if (!ok) return [];

    let json = null;
    if (typeof response?.text === 'function') {
      const text = await response.text();
      if (!text) return [];
      json = JSON.parse(text);
    } else if (typeof response?.json === 'function') {
      json = await response.json();
    }
    return extractModelIds(json);
  } catch {
    // A model list is a nicety. Any failure at all means "type the model
    // name yourself" — never an error toast.
    return [];
  }
}
