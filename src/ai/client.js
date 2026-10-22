// client.js — the ONE call path to an AI provider.
//
// WHY: a BYOK app has exactly one way to talk to a model, and it has to be
// obvious where that way is. Everything (the settings screen, the "explain
// this page" button, whatever comes next) goes through callProvider() below.
// There is NO auto-rotation, NO retry loop and NO fallback to a second
// provider: the user picked a provider, so that provider is the one that is
// used. The app never second-guesses the user, and a failed key never
// silently turns into a bill on someone else's account.
//
// The errors are typed so the UI can say something useful. The codes are:
//   invalid-key     401/403, or a 400 that names the key (Gemini does that)
//   out-of-credits  402
//   rate-limited    429
//   server          5xx, and every other 4xx
//   network         no fetch at all
//   cors            the request was blocked before it left the page
//   parse           the provider answered with something unreadable
//   aborted         the user cancelled
//
// CORS IS THE BIG ONE: most hosted provider APIs do not send
// `Access-Control-Allow-Origin`, so a browser cannot call them with a key.
// Inkpad does not try to work around that (there is no honest workaround
// that keeps the key out of a proxy's logs). It says so plainly and points
// at a proxy.

import { buildRequest, parseResponse, describeKind } from './providers.js';

export class AiError extends Error {
  constructor(code, message, { status, cause, provider } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status ?? null;
    this.cause = cause ?? null;
    this.provider = provider ?? null;
  }
}

// The key never goes in a URL unless the preset's auth style is literally
// 'query', so a URL can be shown in a toast without leaking anything.
function labelOf(preset) {
  if (preset?.label) return preset.label;
  try {
    return describeKind(preset?.kind).label;
  } catch {
    return 'The provider';
  }
}

function redact(text, preset) {
  const key = preset?.apiKey;
  if (!key || typeof text !== 'string') return text;
  return text.split(key).join('[redacted]');
}

function looksLikeAuthProblem(body) {
  if (!body) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (!text) return false;
  return /api[ _-]?key|invalid[ _-]?key|unauthori[sz]ed|permission[ _-]?denied|authentication/i.test(text);
}

export function classifyStatus(status, body) {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 402) return 'out-of-credits';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  if (status >= 400) {
    // Gemini answers a bad key with 400 and an API_KEY_INVALID body, so the
    // body gets a look before the status alone is believed.
    if (looksLikeAuthProblem(body)) return 'invalid-key';
    return 'server';
  }
  return 'server';
}

const STATUS_TEXT = {
  'invalid-key': 'That API key was rejected.',
  'out-of-credits': 'You are out of credit with that provider.',
  'rate-limited': 'That provider is rate-limiting you. Try again in a moment.',
  server: 'That provider had a problem. Try again.',
  network: 'Could not reach that provider.',
  parse: 'That provider sent an answer Inkpad could not read.',
  aborted: 'The request was cancelled.',
};

export function describeError(err) {
  if (!err) return 'Something went wrong.';
  const code = err.code;
  if (code === 'cors') {
    const label = err.provider || 'That provider';
    return `${label} blocks browser calls, so it needs a proxy.`;
  }
  if (code && STATUS_TEXT[code]) return STATUS_TEXT[code];
  if (typeof err.message === 'string' && err.message) return err.message;
  return 'Something went wrong talking to that provider.';
}

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') return null;
  // Bound: an unbound `fetch` throws "Illegal invocation" in some browsers.
  return globalThis.fetch.bind(globalThis);
}

function isAbort(err, signal) {
  if (signal?.aborted) return true;
  return err?.name === 'AbortError';
}

async function readText(res) {
  try {
    if (typeof res?.text === 'function') return await res.text();
  } catch {
    return '';
  }
  return '';
}

async function readJson(res) {
  if (typeof res?.text === 'function') {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new AiError('parse', 'That provider sent something that is not JSON.', { cause: err });
    }
  }
  if (typeof res?.json === 'function') {
    try {
      return await res.json();
    } catch (err) {
      throw new AiError('parse', 'That provider sent something that is not JSON.', { cause: err });
    }
  }
  return null;
}

function snippet(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function failureMessage(code, label, status, body) {
  const detail = snippet(body);
  switch (code) {
    case 'invalid-key':
      return `${label} rejected the API key.${detail ? ` ${detail}` : ''}`;
    case 'out-of-credits':
      return `${label} says there is no credit left on the account.${detail ? ` ${detail}` : ''}`;
    case 'rate-limited':
      return `${label} is rate-limiting this key.${detail ? ` ${detail}` : ''}`;
    default:
      return `${label} answered with an error (HTTP ${status}).${detail ? ` ${detail}` : ''}`;
  }
}

function corsMessage(label) {
  return `${label} blocks browser calls (CORS), so the request never reached it. Inkpad needs a small proxy in front of ${label} to talk to it.`;
}

export async function callProvider(preset, payload = {}, { fetchImpl = defaultFetch(), signal } = {}) {
  const label = labelOf(preset);
  if (typeof fetchImpl !== 'function') {
    throw new AiError('network', 'This browser has no fetch, so Inkpad cannot reach a provider.', { provider: label });
  }

  const request = buildRequest(preset, payload);
  const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  const useSignal = signal ?? payload.signal ?? undefined;

  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: useSignal,
    });
  } catch (err) {
    if (isAbort(err, useSignal)) {
      throw new AiError('aborted', 'The request was cancelled.', { cause: err, provider: label });
    }
    // A browser cannot tell a CORS block from a dead network: both arrive as
    // a rejected fetch. The advice is the same for both — a proxy — so the
    // message says that instead of guessing.
    throw new AiError('cors', corsMessage(label), { cause: err, provider: label });
  }

  const status = typeof response?.status === 'number' ? response.status : 0;
  const ok = response?.ok === undefined ? status === 0 || (status >= 200 && status < 300) : response.ok;
  if (!ok) {
    const raw = await readText(response);
    const code = classifyStatus(status, raw);
    throw new AiError(code, redact(failureMessage(code, label, status, raw), preset), {
      status,
      provider: label,
    });
  }

  const json = await readJson(response);
  const parsed = parseResponse(preset, json);
  return {
    text: parsed.text,
    model: parsed.model,
    usage: parsed.usage,
    raw: json,
  };
}
