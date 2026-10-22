// inkpad-worker-test.mjs — tests for worker/inkpad-proxy.js.
//
// WHY: the proxy holds the API key, so the two things that must never go
// wrong are (1) the key reaching the wrong place and (2) the key reaching
// the user. Everything here pins down where the request goes, which header
// carries the key, and what the app is told when something breaks.
//
// The worker calls the global fetch, so the stub replaces globalThis.fetch
// for the duration of one call and puts the original back afterwards. No
// request ever leaves the machine.
//
//   node tests/inkpad-worker-test.mjs

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER_PATH = join(ROOT, 'worker', 'inkpad-proxy.js');
const worker = (await import(pathToFileURL(WORKER_PATH).href)).default;

let checks = 0;
let failures = 0;

function ok(cond, label) {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

// --- fixtures ---------------------------------------------------------------

const KEY = 'sekret';
const BODY = { model: 'x', messages: [] };

function env(providers, extra = {}) {
  return {
    PROVIDERS: JSON.stringify(providers),
    DEFAULT_PROVIDER: 'nvidia-nim',
    ...extra,
  };
}

const NVIDIA = {
  'nvidia-nim': {
    base: 'https://api.example.test/v1',
    key: KEY,
    auth: 'bearer',
    models: 'https://api.example.test/v1/models',
  },
};

const ANTHROPIC = {
  anthropic: { base: 'https://api.anthropic.test', key: KEY, auth: 'x-api-key' },
};

const GEMINI = {
  gemini: { base: 'https://generativelanguage.example.test/v1beta', key: KEY, auth: 'x-goog-api-key' },
};

function post(path, headers = {}, body = BODY) {
  return new Request(`https://w.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function get(path, headers = {}) {
  return new Request(`https://w.test${path}`, { method: 'GET', headers });
}

// --- the stub ---------------------------------------------------------------

function makeFetch(responder) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(String(url), options);
  };
  fn.calls = calls;
  return fn;
}

// Drive the worker with a stubbed global fetch.
async function call(request, bindings, responder) {
  const stub = makeFetch(responder);
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const res = await worker.fetch(request, bindings, {});
    return { res, calls: stub.calls };
  } finally {
    globalThis.fetch = original;
  }
}

// A provider that says yes.
function okResponder(payload = { choices: [{ message: { content: 'hi' } }] }) {
  return async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// --- part 1: the provider path form -----------------------------------------

console.log('part 1 — /<provider>/<path>');

{
  const { res, calls } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA),
    okResponder(),
  );
  eq(res.status, 200, 'a proxied call answers 200');
  eq(calls.length, 1, 'the provider is called exactly once');
  eq(calls[0].url, 'https://api.example.test/v1/chat/completions', 'the base URL gets the path appended');
  eq(calls[0].options.method, 'POST', 'the method is forwarded');
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'the key is added as a bearer token');
  eq(calls[0].options.body, JSON.stringify(BODY), 'the body the app built is forwarded as it is');
  eq(calls[0].options.headers.get('content-type'), 'application/json', 'the content type is forwarded');
  const answer = await res.json();
  eq(answer.choices[0].message.content, 'hi', 'the provider answer comes back');
}

{
  const { calls } = await call(post('/nvidia-nim/chat/completions'), env(NVIDIA), okResponder());
  eq(calls[0].url, 'https://api.example.test/v1/chat/completions', 'the base URL keeps its own path');
}

{
  const { calls } = await call(post('/anthropic/v1/messages'), env(ANTHROPIC), okResponder());
  eq(calls[0].url, 'https://api.anthropic.test/v1/messages', 'a second provider has its own base URL');
}

{
  const { calls } = await call(post('/gemini/models/gemini-2.0-flash:generateContent'), env(GEMINI), okResponder());
  eq(
    calls[0].url,
    'https://generativelanguage.example.test/v1beta/models/gemini-2.0-flash:generateContent',
    'a model name in the path survives the rewrite',
  );
}

// --- part 2: the auth styles ------------------------------------------------

console.log('part 2 — the auth styles');

{
  const { calls } = await call(post('/anthropic/v1/messages'), env(ANTHROPIC), okResponder());
  eq(calls[0].options.headers.get('x-api-key'), KEY, 'the x-api-key style puts the key in x-api-key');
  eq(calls[0].options.headers.get('authorization'), null, 'the x-api-key style sends no authorization header');
}

{
  const { calls } = await call(post('/gemini/models/x:generateContent'), env(GEMINI), okResponder());
  eq(calls[0].options.headers.get('x-goog-api-key'), KEY, 'the x-goog-api-key style puts the key in x-goog-api-key');
  eq(calls[0].options.headers.get('authorization'), null, 'the x-goog-api-key style sends no authorization header');
}

{
  const { calls } = await call(
    post('/local/chat/completions'),
    env({ local: { base: 'https://local.example.test/v1', auth: 'none' } }),
    okResponder(),
  );
  eq(calls[0].options.headers.get('authorization'), null, 'the none style sends no key');
}

{
  const { calls } = await call(
    post('/queryish/chat/completions'),
    env({ queryish: { base: 'https://query.example.test/v1', key: KEY, auth: 'query' } }),
    okResponder(),
  );
  eq(calls[0].url, 'https://query.example.test/v1/chat/completions?key=sekret', 'the query style puts the key in the URL');
  eq(calls[0].options.headers.get('authorization'), null, 'the query style sends no authorization header');
}

{
  const { calls } = await call(
    post('/indirect/chat/completions'),
    env({ indirect: { base: 'https://indirect.example.test/v1', keyEnv: 'INDIRECT_KEY' } }, { INDIRECT_KEY: KEY }),
    okResponder(),
  );
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'keyEnv reads the key from another binding');
}

// --- part 3: the client cannot override the server key ----------------------

console.log('part 3 — the client key never wins');

{
  const { calls } = await call(
    post('/nvidia-nim/chat/completions', { authorization: 'Bearer client-key' }),
    env(NVIDIA),
    okResponder(),
  );
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'a client authorization header is replaced');
  const authCount = [...calls[0].options.headers.entries()].filter(([name]) => name === 'authorization').length;
  eq(authCount, 1, 'only one authorization header is sent');
  ok(!JSON.stringify(calls[0].options.headers).includes('client-key'), 'the client key is not forwarded');
}

{
  const { calls } = await call(
    post('/anthropic/v1/messages', { 'x-api-key': 'client-key' }),
    env(ANTHROPIC),
    okResponder(),
  );
  eq(calls[0].options.headers.get('x-api-key'), KEY, 'a client x-api-key header is replaced');
  ok(!JSON.stringify(calls[0].options.headers).includes('client-key'), 'the client key is not forwarded');
}

{
  const { calls } = await call(
    post('/nvidia-nim/chat/completions', { 'x-goog-api-key': 'client-key' }),
    env(NVIDIA),
    okResponder(),
  );
  eq(calls[0].options.headers.get('x-goog-api-key'), null, 'a client x-goog-api-key header is dropped');
  ok(!JSON.stringify(calls[0].options.headers).includes('client-key'), 'the client key is not forwarded');
}

// --- part 4: health, preflight, methods -------------------------------------

console.log('part 4 — health, preflight, methods');

{
  const { res, calls } = await call(get('/health'), env(NVIDIA), okResponder());
  eq(res.status, 200, 'the health check answers 200');
  eq(await res.json(), { ok: true }, 'the health check says ok');
  eq(calls.length, 0, 'the health check calls no provider');
}

{
  const { res, calls } = await call(
    new Request('https://w.test/nvidia-nim/chat/completions', { method: 'OPTIONS' }),
    env(NVIDIA),
    okResponder(),
  );
  eq(res.status, 204, 'a preflight answers 204');
  eq(res.headers.get('access-control-allow-origin'), '*', 'the preflight allows every origin');
  ok(/GET/.test(res.headers.get('access-control-allow-methods')), 'the preflight allows GET');
  ok(/POST/.test(res.headers.get('access-control-allow-methods')), 'the preflight allows POST');
  ok(/OPTIONS/.test(res.headers.get('access-control-allow-methods')), 'the preflight allows OPTIONS');
  ok(/content-type/i.test(res.headers.get('access-control-allow-headers')), 'the preflight allows content-type');
  ok(/authorization/i.test(res.headers.get('access-control-allow-headers')), 'the preflight allows authorization');
  ok(/x-inkpad-provider/i.test(res.headers.get('access-control-allow-headers')), 'the preflight allows x-inkpad-provider');
  ok(/x-inkpad-target/i.test(res.headers.get('access-control-allow-headers')), 'the preflight allows x-inkpad-target');
  eq(calls.length, 0, 'a preflight calls no provider');
}

{
  const { res } = await call(
    new Request('https://w.test/nvidia-nim/chat/completions', { method: 'DELETE' }),
    env(NVIDIA),
    okResponder(),
  );
  eq(res.status, 405, 'a DELETE is not allowed');
  ok(String(res.headers.get('allow') || '').includes('POST'), 'the 405 says what is allowed');
}

{
  const { res } = await call(post('/nvidia-nim/chat/completions'), env(NVIDIA), okResponder());
  eq(res.headers.get('access-control-allow-origin'), '*', 'a normal answer carries the CORS header');
}

// --- part 5: errors ----------------------------------------------------------

console.log('part 5 — errors');

{
  const long = 'x'.repeat(900);
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA),
    async () => new Response(long, { status: 500 }),
  );
  eq(res.status, 500, 'a provider error keeps its status');
  eq(res.headers.get('x-inkpad-error'), '1', 'a provider error is marked with x-inkpad-error');
  const text = await res.text();
  eq(text.length, 500, 'the error body is shortened to 500 characters');
  ok(text.startsWith('xxx'), 'the error body is the start of the provider body');
}

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA),
    async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  );
  eq(res.status, 401, 'a 401 from the provider stays a 401');
  eq(res.headers.get('x-inkpad-error'), '1', 'a 401 is marked as a provider error');
  ok((await res.text()).includes('bad key'), 'the provider message comes back');
}

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA),
    async () => { throw new TypeError('Failed to fetch'); },
  );
  eq(res.status, 502, 'an unreachable provider is a 502');
  eq(await res.json(), { error: 'upstream unreachable' }, 'the 502 says the upstream is unreachable');
  eq(res.headers.get('x-inkpad-error'), null, 'a proxy error is not marked as a provider error');
}

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA),
    async () => new Response(`the key is ${KEY} and it is wrong`, { status: 403 }),
  );
  const text = await res.text();
  ok(!text.includes(KEY), 'the key never appears in an error body');
  ok(text.includes('[redacted]'), 'an echoed key is redacted');
}

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA),
    async () => new Response(JSON.stringify({ note: KEY }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  ok(!(await res.text()).includes(KEY), 'the key never appears in a successful body');
}

// --- part 6: routing ---------------------------------------------------------

console.log('part 6 — routing');

{
  const { res } = await call(post('/unknown-provider/chat/completions'), env(NVIDIA), okResponder());
  eq(res.status, 404, 'an unknown provider is a 404');
  const body = await res.json();
  eq(body.error, 'unknown provider', 'the 404 says the provider is unknown');
  eq(body.provider, 'unknown-provider', 'the 404 names the provider that was asked for');
  eq(body.providers, ['nvidia-nim'], 'the 404 lists the providers that exist');
}

{
  const { res } = await call(
    post('/chat/completions', { 'x-inkpad-provider': 'bogus' }),
    env(NVIDIA),
    okResponder(),
  );
  eq(res.status, 404, 'a provider name that does not exist is a 404, not a fall back');
}

{
  const { res } = await call(post('/chat/completions'), env(NVIDIA), okResponder());
  eq(res.status, 404, 'an unknown path segment is a 404 even with a default provider');
}

{
  const { res } = await call(post('/chat/completions'), { PROVIDERS: '', DEFAULT_PROVIDER: '' }, okResponder());
  eq(res.status, 404, 'no providers at all is a 404');
}

{
  const { calls } = await call(
    post('/v1/chat/completions', { 'x-inkpad-provider': 'nvidia-nim' }),
    env({ 'nvidia-nim': { base: 'https://api.example.test', key: KEY, auth: 'bearer' } }),
    okResponder(),
  );
  eq(calls[0].url, 'https://api.example.test/v1/chat/completions', 'the x-inkpad-provider header picks the provider');
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'the header provider gets the key');
}

{
  const { calls } = await call(
    post('/v1/chat/completions', { 'x-inkpad-target': 'https://api.example.test/v1/chat/completions' }),
    env({ 'nvidia-nim': { base: 'https://api.example.test', key: KEY, auth: 'bearer' } }),
    okResponder(),
  );
  eq(calls[0].url, 'https://api.example.test/v1/chat/completions', 'DEFAULT_PROVIDER serves a request that names none');
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'the default provider supplies the key');
}

{
  const { calls } = await call(
    post('/v1/chat/completions', {
      'x-inkpad-provider': 'nvidia-nim',
      'x-inkpad-target': 'https://custom.example.test/somewhere/else',
    }),
    env(NVIDIA),
    okResponder(),
  );
  eq(calls[0].url, 'https://custom.example.test/somewhere/else', 'the flat form calls the target URL verbatim');
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'the flat form still gets the key');
}

{
  const { res } = await call(
    post('/v1/chat/completions', { 'x-inkpad-target': 'not a url' }),
    env(NVIDIA),
    okResponder(),
  );
  eq(res.status, 400, 'a broken target URL is a 400');
}

{
  const { calls } = await call(get('/nvidia-nim/__models'), env(NVIDIA), okResponder());
  eq(calls[0].url, 'https://api.example.test/v1/models', 'the model list comes from the models URL');
  eq(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`, 'the model list carries the key');
}

// --- part 7: the shared secret -----------------------------------------------

console.log('part 7 — the shared secret');

{
  const { res, calls } = await call(
    post('/nvidia-nim/chat/completions', { 'x-inkpad-secret': 'wrong' }),
    env(NVIDIA, { PROXY_SECRET: 'right' }),
    okResponder(),
  );
  eq(res.status, 403, 'a wrong secret is a 403');
  eq(calls.length, 0, 'a wrong secret calls no provider');
  ok(!(await res.text()).includes(KEY), 'the 403 body has no key in it');
}

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env(NVIDIA, { PROXY_SECRET: 'right' }),
    okResponder(),
  );
  eq(res.status, 403, 'a missing secret is a 403');
}

{
  const { res, calls } = await call(
    post('/nvidia-nim/chat/completions', { 'x-inkpad-secret': 'right' }),
    env(NVIDIA, { PROXY_SECRET: 'right' }),
    okResponder(),
  );
  eq(res.status, 200, 'the right secret gets through');
  eq(calls.length, 1, 'the right secret reaches the provider');
}

{
  const { res } = await call(
    new Request('https://w.test/nvidia-nim/chat/completions', { method: 'OPTIONS' }),
    env(NVIDIA, { PROXY_SECRET: 'right' }),
    okResponder(),
  );
  eq(res.status, 204, 'a preflight is answered without the secret');
}

{
  const { res } = await call(get('/health'), env(NVIDIA), okResponder());
  eq(res.status, 200, 'without PROXY_SECRET the worker is open');
}

// --- part 8: a broken config -------------------------------------------------

console.log('part 8 — a broken config');

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    { PROVIDERS: '{not json', DEFAULT_PROVIDER: 'nvidia-nim' },
    okResponder(),
  );
  eq(res.status, 500, 'an unparseable PROVIDERS binding is a 500');
}

{
  const { res } = await call(
    post('/nvidia-nim/chat/completions'),
    env({ 'nvidia-nim': { key: KEY, auth: 'bearer' } }),
    okResponder(),
  );
  eq(res.status, 400, 'a provider with no base URL is a 400');
}

console.log(`\n${failures === 0 ? 'ALL' : 'FAILED'} ${checks} CHECKS${failures === 0 ? ' PASSED' : ''}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
