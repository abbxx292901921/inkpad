// inkpad-proxy.js — the Inkpad AI proxy: a Cloudflare Workers MODULE worker
// (`export default { fetch }`).
//
// WHY: OpenAI, Anthropic and NVIDIA NIM send no `Access-Control-Allow-Origin`
// header, so a browser cannot call them with a key — the request dies before
// it leaves the page. A worker on the far side of the CORS line can. The app
// keeps building the request exactly as it always did (src/ai/providers.js);
// the worker adds the key from an environment binding and relays the answer.
//
// THE KEY LIVES HERE, NOT IN THE APP: the app's key field can stay empty. The
// key comes from the PROVIDERS binding (or from the secret binding a
// provider's `keyEnv` names) and is attached in that provider's `auth` style:
// bearer, x-api-key, x-goog-api-key, query or none, the same five styles
// src/ai/presets.js knows. A key the CLIENT sent is dropped, so a client can
// neither read the server's key nor override it.
//
// TWO URL SHAPES: `/<provider>/<path...>` -> `<base>/<path...>` reaches only a
// CONFIGURED provider (the safe form); `x-inkpad-target: <url>` -> `<url>` is a
// custom URL: an open relay to any address unless PROXY_SECRET is set.
//
// SECRETS: nothing is baked in — the bindings are PROVIDERS, DEFAULT_PROVIDER
// and PROXY_SECRET. The key never appears in a response body, a log line or an
// error message, and NOTHING IS LOGGED: the request body is a conversation with
// a model, and that is the user's own content.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-inkpad-provider, x-inkpad-target, x-inkpad-secret, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// The path segment that asks for the provider's model list: GET /<p>/__models
const MODELS_PATH = '__models';

// The headers the client must never set: the key ones are replaced by the
// server's key, the rest would leak cookies or confuse the upstream.
const DROPPED_HEADERS = new Set([
  'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'host',
  'content-length', 'connection', 'accept-encoding',
]);

function corsHeaders(extra) {
  return { ...CORS_HEADERS, ...(extra || {}) };
}

function jsonResponse(payload, status = 200, extra) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({ 'content-type': 'application/json', ...(extra || {}) }),
  });
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

// The key never appears in anything that leaves the worker.
function clean(text, key, limit = 0) {
  let out = typeof text === 'string' ? text : '';
  if (key) out = out.split(key).join('[redacted]');
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

// Length-independent: the answer must not leak the secret a character at a time.
function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function safeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return parsed;
}

// PROVIDERS is a JSON string:
//   {"nvidia-nim": {"base": "https://integrate.api.nvidia.com/v1",
//                   "key": "nvapi-...", "auth": "bearer",
//                   "models": "https://integrate.api.nvidia.com/v1/models"}}
// `keyEnv` names ANOTHER binding instead of the key, so the JSON can stay a
// plain variable while the key stays a secret.
function readProviders(env) {
  const raw = str(env?.PROVIDERS).trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // A null prototype: a provider called "constructor" is a typo, not a hit.
  const out = Object.create(null);
  for (const [name, entry] of Object.entries(parsed)) {
    if (!name || !entry || typeof entry !== 'object') continue;
    out[name] = {
      base: str(entry.base).trim(),
      models: str(entry.models).trim(),
      auth: (str(entry.auth) || 'bearer').trim().toLowerCase(),
      key: str(entry.key).trim(),
      keyEnv: str(entry.keyEnv).trim(),
    };
  }
  return out;
}

// The key: inline in the JSON, or in the binding `keyEnv` names.
function keyOf(provider, env) {
  if (provider.key) return provider.key;
  if (provider.keyEnv) return str(env?.[provider.keyEnv]).trim();
  return '';
}

// Which provider is this request for, and what is left of the path?
//   1. the x-inkpad-provider header, when it names one
//   2. the first path segment, when it names one
//   3. DEFAULT_PROVIDER, for a request that names none
// A NAME THAT DOES NOT EXIST IS AN ERROR, never a fall back to another
// provider: a typo must not quietly send one key to another provider.
function routeOf(request, providers, env) {
  const url = new URL(request.url);
  const clean = url.pathname.replace(/^\/+/, '');
  const slash = clean.indexOf('/');
  const head = slash === -1 ? clean : clean.slice(0, slash);
  const tail = clean.slice(head.length).replace(/^\/+/, '');
  const rest = tail ? `/${tail}` : '/';

  const header = (request.headers.get('x-inkpad-provider') || '').trim();
  const headProvider = head ? providers[head] : null;
  const headerProvider = header ? providers[header] : null;

  if (header) {
    if (!headerProvider) return { provider: null, unknown: header };
    // The path's own provider segment is dropped, whichever provider won.
    return { provider: headerProvider, rest: headProvider ? rest : url.pathname };
  }
  if (headProvider) {
    return { provider: headProvider, rest };
  }
  const fallback = str(env?.DEFAULT_PROVIDER).trim();
  const flat = (request.headers.get('x-inkpad-target') || '').trim() !== '';
  if (fallback && providers[fallback] && (flat || !head)) {
    return { provider: providers[fallback], rest: url.pathname };
  }
  return { provider: null, unknown: head };
}

// The URL to call: the flat form's own URL, or the base plus the path.
function targetOf(request, route) {
  const custom = (request.headers.get('x-inkpad-target') || '').trim();
  if (custom) return safeUrl(custom);
  if (!route.provider.base) return null;
  const parsed = safeUrl(route.provider.base);
  if (!parsed) return null;
  const rest = route.rest.startsWith('/') ? route.rest : `/${route.rest}`;
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${rest === '/' ? '' : rest}`;
  return parsed;
}

// Everything the client sent, minus the headers the worker owns. A header
// the app set for the provider still goes through: only the KEYS are ours.
function forwardHeaders(request) {
  const out = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower) || lower.startsWith('x-inkpad-') || lower.startsWith('cf-')) return;
    out.set(name, value);
  });
  return out;
}

// The key, in the style the provider expects.
function applyAuth(headers, url, provider, key) {
  if (!key) return;
  if (provider.auth === 'x-api-key' || provider.auth === 'x-goog-api-key') {
    headers.set(provider.auth, key);
    return;
  }
  if (provider.auth === 'query') {
    url.searchParams.set('key', key);
    return;
  }
  if (provider.auth === 'none') return;
  headers.set('authorization', `Bearer ${key}`);
}

// Call the provider and map its answer onto ours.
async function relay(request, target, provider, key) {
  const headers = forwardHeaders(request);
  applyAuth(headers, target, provider, key);
  const body = request.method === 'GET' ? undefined : await request.text().catch(() => '');

  let upstream;
  try {
    upstream = await fetch(target.toString(), { method: request.method, headers, body });
  } catch {
    // No answer at all: the provider is unreachable, or the network is down.
    return jsonResponse({ error: 'upstream unreachable' }, 502);
  }
  const status = typeof upstream?.status === 'number' ? upstream.status : 502;
  const text = await upstream.text().catch(() => '');
  const contentType = upstream?.headers?.get?.('content-type') || 'text/plain; charset=utf-8';

  if (status >= 200 && status < 300) {
    return new Response(clean(text, key), { status, headers: corsHeaders({ 'content-type': contentType }) });
  }
  // The provider said no: its status and its (shortened) body go back.
  return new Response(clean(text, key, 500), {
    status,
    headers: corsHeaders({ 'content-type': contentType, 'x-inkpad-error': '1' }),
  });
}

export default {
  async fetch(request, env = {}) {
    // The preflight comes first: a browser sends no custom headers (not even
    // the secret) on an OPTIONS request.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405, { Allow: 'GET, POST, OPTIONS' });
    }
    const expected = str(env?.PROXY_SECRET).trim();
    if (expected && !sameSecret((request.headers.get('x-inkpad-secret') || '').trim(), expected)) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/health') {
      return jsonResponse({ ok: true });
    }
    const providers = readProviders(env);
    if (!providers) {
      return jsonResponse({ error: 'provider config is invalid' }, 500);
    }
    const route = routeOf(request, providers, env);
    if (!route.provider) {
      // The name asked for, and the names that exist: a typo should be obvious.
      const names = Object.keys(providers);
      return jsonResponse({ error: 'unknown provider', provider: route.unknown, providers: names }, 404);
    }
    const key = keyOf(route.provider, env);
    const base = route.provider.base.replace(/\/+$/, '');
    const modelsUrl = route.provider.models || (base ? `${base}/models` : '');
    const wantsModels = request.method === 'GET' && route.rest === `/${MODELS_PATH}`;
    const target = wantsModels ? safeUrl(modelsUrl) : targetOf(request, route);
    if (!target) {
      return jsonResponse({ error: 'bad target' }, 400);
    }
    return relay(request, target, route.provider, key);
  },
};
