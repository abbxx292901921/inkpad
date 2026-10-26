// providers.js — request builders and response parsers for the AI kinds.
//
// WHY: Inkpad talks to whatever provider the user configures, so the wire
// format cannot be baked into the app. Three things differ per provider: the
// URL, how the key is attached, and where the answer sits in the response.
// All three live here, in ONE file, so the call path (src/ai/client.js) never
// needs to know which provider it is talking to.
//
// THE FIVE KINDS: openai (OpenAI Chat Completions and every server that
// clones it), gemini-generate, gemini-interactions (a Gemini-family variant
// with a different response shape — THE UPSTREAM CONTRACT IS UNVERIFIED),
// anthropic, and raw (the user's own endpoint, body template and path to the
// answer).
//
// SECRETS: the key always travels in a HEADER. The only exception is a
// preset whose `auth` is literally 'query' — the user's explicit choice for
// an endpoint that only accepts ?key=….
//
// NO DOM: this module must import cleanly in Node (the test suite does
// that), so it touches neither document, window nor fetch at module scope.
//
// ONE WART: parseResponse() throws an AiError and AiError lives in
// client.js, which imports this file. The cycle is safe because neither
// module USES the other's binding at module-evaluation time — only inside
// function bodies, which run long after both modules are evaluated.

import { AiError } from './client.js';

export const PROVIDER_KINDS = ['openai', 'gemini-generate', 'gemini-interactions', 'anthropic', 'raw'];

const KIND_TABLE = {
  openai: {
    label: 'OpenAI-compatible',
    help: 'Any server that speaks the OpenAI Chat Completions API: OpenAI, Groq, OpenRouter, NVIDIA NIM, Mistral, Cerebras, Together, OVH, Z.ai, Workers AI, LM Studio, Ollama.',
    defaultEndpoint: 'https://api.openai.com/v1', defaultModelsUrl: 'https://api.openai.com/v1/models',
    authStyle: 'bearer', supportsVision: true,
  },
  'gemini-generate': {
    label: 'Google Gemini',
    help: 'The Gemini generateContent API. It allows browser calls, so it usually works with no proxy.',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    authStyle: 'x-goog-api-key', supportsVision: true,
  },
  'gemini-interactions': {
    label: 'Google Gemini (interactions)',
    help: 'A Gemini-family variant with its own response shape. The upstream contract is unverified, so the path to the answer can be overridden per preset.',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    authStyle: 'x-goog-api-key', supportsVision: true,
  },
  anthropic: {
    label: 'Anthropic',
    help: 'The Anthropic Messages API. It blocks browser calls, so it needs a proxy in front of it.',
    defaultEndpoint: 'https://api.anthropic.com', defaultModelsUrl: 'https://api.anthropic.com/v1/models',
    authStyle: 'x-api-key', supportsVision: true,
  },
  raw: {
    label: 'Custom request',
    help: 'Your own endpoint, your own body template and your own path to the answer.',
    defaultEndpoint: '', defaultModelsUrl: '',
    authStyle: 'bearer', supportsVision: false,
  },
};

export function describeKind(kind) {
  const info = KIND_TABLE[kind];
  if (!info) throw new Error(`[inkpad] unknown provider kind: ${kind}`);
  return { kind, ...info };
}

// Which kinds can answer with a STREAM of text instead of one finished
// reply. The wire shapes differ per family, but all three speak SSE
// (server-sent events), so the client has one reader and three delta
// extractors. 'raw' is the user's own endpoint with an unknown shape, and
// the 'gemini-interactions' contract is unverified: both fall back to the
// one-shot call.
export function supportsStreaming(kind) {
  return kind === 'openai' || kind === 'gemini-generate' || kind === 'anthropic';
}

// --- helpers ---------------------------------------------------------------

function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

// The text of a node: a string, or a list of parts. `fallback` is '' for a
// REQUEST (no text is not an error) and null for a RESPONSE (null is what
// tells the caller the shape was wrong).
function textOf(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => textOf(item, null)).filter(Boolean);
    return parts.length ? parts.join('\n') : fallback;
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return textOf(value.content, fallback);
  }
  return fallback;
}

// Walk a dotted path such as 'candidates.0.content.parts.0.text' over
// parsed JSON. Numeric segments index arrays.
function walkPath(root, path) {
  let cur = root;
  for (const segment of String(path ?? '').split('.').filter((s) => s !== '')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cur = cur[index];
    } else if (typeof cur === 'object') {
      cur = cur[segment];
    } else {
      return undefined;
    }
  }
  return cur;
}

// The first of these paths that holds text wins.
function firstPath(json, paths) {
  for (const path of paths) {
    const text = textOf(walkPath(json, path), null);
    if (text !== null) return text;
  }
  return null;
}

function lastUserIndex(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user') return i;
  }
  return -1;
}

function lastUserText(messages) {
  const index = lastUserIndex(messages || []);
  return index < 0 ? '' : textOf(messages[index].content);
}

// { dataUrl, mimeType } -> { mimeType, data }. The data URL carries the mime
// type, but the caller may know better.
function imagePart(image) {
  if (!image?.dataUrl) return null;
  const raw = String(image.dataUrl);
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(raw);
  return {
    mimeType: image.mimeType || (match ? match[1] : '') || 'image/png',
    data: match ? match[3] : raw,
  };
}

// The system text, and the conversation without the system messages.
function splitMessages(payload) {
  let system = payload.system || '';
  const messages = [];
  for (const message of payload.messages || []) {
    if (message.role !== 'system') {
      messages.push(message);
      continue;
    }
    const extra = textOf(message.content);
    system = system ? `${system}\n\n${extra}` : extra;
  }
  return { system, messages };
}

// The role a message plays in a provider's own vocabulary.
function toRole(family, role) {
  if (role === 'assistant' || role === 'model') return family === 'gemini' ? 'model' : 'assistant';
  return 'user';
}

// An image belongs on the LAST user message: that is where the user is
// talking about the thing they drew. `field` is the part list the provider
// calls its content.
function attachImage(list, part, field = 'content') {
  const index = lastUserIndex(list);
  if (index < 0) {
    list.push({ role: 'user', [field]: [part] });
    return;
  }
  const current = list[index][field];
  list[index][field] = typeof current === 'string'
    ? [{ type: 'text', text: current }, part]
    : [...(Array.isArray(current) ? current : []), part];
}

// --- auth ------------------------------------------------------------------

const AUTH_STYLES = ['bearer', 'x-api-key', 'x-goog-api-key', 'query', 'none'];
const AUTH_HEADERS = { bearer: 'Authorization', 'x-api-key': 'x-api-key', 'x-goog-api-key': 'x-goog-api-key' };

function authStyleOf(preset) {
  const style = typeof preset?.auth === 'string' ? preset.auth.trim().toLowerCase() : '';
  if (AUTH_STYLES.includes(style)) return style;
  // A preset with no auth (or a hand-typed typo) falls back to the kind's
  // own default, so the key never ends up somewhere unknown.
  return describeKind(preset?.kind).authStyle;
}

// The key goes in a header, ALWAYS, except for the explicit 'query' style.
function authHeaders(preset) {
  const key = preset?.apiKey;
  const name = key ? AUTH_HEADERS[authStyleOf(preset)] : null;
  if (!name) return {};
  return name === 'Authorization' ? { Authorization: `Bearer ${key}` } : { [name]: key };
}

function applyQueryAuth(url, preset) {
  const key = preset?.apiKey;
  if (!key || authStyleOf(preset) !== 'query') return url;
  const sep = String(url).includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(key)}`;
}

function makeHeaders(preset, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders(preset), ...extra };
  const userHeaders = preset?.extraHeaders;
  if (userHeaders && typeof userHeaders === 'object') Object.assign(headers, userHeaders);
  return headers;
}

function finish(preset, url, body, extraHeaders = {}) {
  return {
    url: applyQueryAuth(url, preset),
    method: 'POST',
    headers: makeHeaders(preset, extraHeaders),
    body,
  };
}

// --- request builders ------------------------------------------------------

// The Gemini REST API names the model in the PATH, not in the body. The
// preset's endpoint is the base, and it comes in three shapes:
//   .../v1beta                  -> .../v1beta/models/{model}
//   .../v1beta/models           -> .../v1beta/models/{model}
//   .../v1beta/models/gemini-x  -> used as it is (the model is already there)
function geminiBase(endpoint, model) {
  const base = trimSlash(endpoint).replace(/:[a-zA-Z]+$/, '');
  if (!model) return base;
  if (/\/models\/[^/]+$/.test(base)) return base;
  if (/\/models$/.test(base)) return `${base}/${encodeURIComponent(model)}`;
  return `${base}/models/${encodeURIComponent(model)}`;
}

function buildOpenai(preset, payload) {
  const model = payload.model || preset.model || '';
  const { system, messages } = splitMessages(payload);
  const list = [];
  if (system) list.push({ role: 'system', content: system });
  for (const message of messages) {
    list.push({ role: toRole('openai', message.role), content: message.content });
  }
  if (payload.image) {
    attachImage(list, { type: 'image_url', image_url: { url: payload.image.dataUrl } });
  }
  const base = trimSlash(preset.endpoint).replace(/\/chat\/completions$/i, '');
  return finish(preset, `${base}/chat/completions`, { model, messages: list, stream: Boolean(payload.stream) });
}

function buildGemini(preset, payload, { interactions = false } = {}) {
  const model = payload.model || preset.model || '';
  const { system, messages } = splitMessages(payload);
  const contents = messages.map((message) => ({
    role: toRole('gemini', message.role),
    parts: typeof message.content === 'string'
      ? (message.content ? [{ text: message.content }] : [])
      : (Array.isArray(message.content) ? message.content : []),
  }));
  const image = imagePart(payload.image);
  if (image) attachImage(contents, { inlineData: { mimeType: image.mimeType, data: image.data } }, 'parts');
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (payload.generationConfig) body.generationConfig = payload.generationConfig;
  // The interactions endpoint takes the model in the body, not in the path.
  if (interactions) body.model = model;
  const url = interactions
    ? `${trimSlash(preset.endpoint).replace(/:[a-zA-Z]+$/, '')}/interactions`
    : (payload.stream
      ? `${geminiBase(preset.endpoint, model)}:streamGenerateContent?alt=sse`
      : `${geminiBase(preset.endpoint, model)}:generateContent`);
  return finish(preset, url, body);
}

function buildAnthropic(preset, payload) {
  const model = payload.model || preset.model || '';
  const { system, messages } = splitMessages(payload);
  const list = messages.map((message) => ({
    role: toRole('anthropic', message.role),
    content: [{ type: 'text', text: textOf(message.content) }],
  }));
  const image = imagePart(payload.image);
  if (image) {
    const source = { type: 'base64', media_type: image.mimeType, data: image.data };
    attachImage(list, { type: 'image', source });
  }
  const body = { model, max_tokens: payload.maxTokens ?? 2048, messages: list };
  if (payload.stream) body.stream = true;
  if (system) body.system = system;
  const base = trimSlash(preset.endpoint).replace(/\/v1\/messages$/i, '');
  return finish(preset, `${base}/v1/messages`, body, { 'anthropic-version': '2023-06-01' });
}

function buildRaw(preset, payload) {
  const model = payload.model || preset.model || '';
  const values = {
    model,
    system: payload.system || '',
    prompt: lastUserText(payload.messages),
    image: payload.image?.dataUrl || '',
  };
  const template = typeof preset.requestTemplate === 'string' ? preset.requestTemplate : '';
  // The body of a raw request is ALWAYS a string: it is the user's template.
  const body = template
    ? substituteTemplate(template, values)
    : JSON.stringify({ model, messages: payload.messages || [] });
  return finish(preset, preset.endpoint || '', body);
}

const BUILDERS = {
  openai: buildOpenai,
  'gemini-generate': (preset, payload) => buildGemini(preset, payload),
  'gemini-interactions': (preset, payload) => buildGemini(preset, payload, { interactions: true }),
  anthropic: buildAnthropic,
  raw: buildRaw,
};

export function buildRequest(preset, payload = {}) {
  const kind = preset?.kind ?? 'openai';
  const builder = BUILDERS[kind];
  if (!builder) throw new Error(`[inkpad] unknown provider kind: ${kind}`);
  return builder(preset, payload);
}

// --- template substitution -------------------------------------------------

function jsonString(value) {
  if (value === undefined || value === null) return 'null';
  return JSON.stringify(value);
}

// {{model}}, {{system}}, {{prompt}} and {{image}} are replaced with
// JSON-stringified values, so the result is always valid JSON however the
// user wrote their template.
export function substituteTemplate(template, values = {}) {
  const source = typeof template === 'string' ? template : '';
  const v = values || {};
  return source
    .split('{{model}}').join(jsonString(v.model))
    .split('{{system}}').join(jsonString(v.system))
    .split('{{prompt}}').join(jsonString(v.prompt))
    .split('{{image}}').join(jsonString(v.image));
}

// --- response parsing ------------------------------------------------------

function readUsage(kind, json) {
  const usage = json?.usage;
  const meta = json?.usageMetadata;
  if (kind === 'openai' && usage) {
    return { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, totalTokens: usage.total_tokens ?? null };
  }
  if (kind === 'gemini-generate' && meta) {
    return { inputTokens: meta.promptTokenCount ?? null, outputTokens: meta.candidatesTokenCount ?? null, totalTokens: meta.totalTokenCount ?? null };
  }
  if (kind === 'anthropic' && usage) {
    const input = usage.input_tokens ?? null;
    const output = usage.output_tokens ?? null;
    const total = (input ?? 0) + (output ?? 0);
    return { inputTokens: input, outputTokens: output, totalTokens: total || null };
  }
  // 'raw' and 'gemini-interactions' pass the provider's own usage through
  // untouched — there is no known shape to normalise it to.
  return usage && typeof usage === 'object' ? usage : null;
}

// Where the answer sits, per kind. The interactions list is the UNVERIFIED
// upstream shape: the first path that holds text wins, and a preset's
// `responseTextPath` overrides the whole list.
const ANSWER_PATHS = {
  'gemini-interactions': ['output.0.content.0.text', 'output.0.text', 'output.0.parts.0.text', 'text'],
  raw: ['text', 'output_text', 'response', 'answer', 'content'],
};

function defaultText(kind, json) {
  if (kind === 'openai') {
    const choice = json?.choices?.[0];
    return textOf(choice?.message?.content ?? choice?.text ?? choice?.delta?.content, null);
  }
  if (kind === 'gemini-generate') {
    const parts = json?.candidates?.[0]?.content?.parts;
    const text = parts ? textOf(parts, null) : null;
    return text !== null ? text : textOf(json?.candidates?.[0]?.content?.text, null);
  }
  if (kind === 'anthropic') {
    const text = textOf(json?.content, null);
    return text !== null ? text : textOf(json?.completion, null);
  }
  return firstPath(json, ANSWER_PATHS[kind] || []);
}

function parseError(preset, detail) {
  const label = preset?.label || preset?.kind || 'the provider';
  return new AiError('parse', `Could not read the answer from ${label}'s response (${detail}).`, {
    provider: preset?.label || preset?.kind || null,
  });
}

export function parseResponse(preset, json) {
  const kind = preset?.kind ?? 'openai';
  const override = typeof preset?.responseTextPath === 'string' ? preset.responseTextPath.trim() : '';
  let text = null;
  if (override) {
    text = textOf(walkPath(json, override), null);
    if (text === null) throw parseError(preset, `nothing at "${override}"`);
  } else {
    text = defaultText(kind, json);
    if (text === null) throw parseError(preset, 'no text in the response');
  }
  return {
    text,
    model: typeof json?.model === 'string' ? json.model : (preset?.model || ''),
    usage: readUsage(kind, json),
  };
}
